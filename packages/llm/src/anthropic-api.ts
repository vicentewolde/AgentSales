import { AppError, type LLMProvider, type LlmTokenUsage } from "@agentsales/core";
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "@anthropic-ai/sdk";

// Proveedor `anthropic-api` (spec F7 §4.7, seguimiento de ADR-0003): la API de Anthropic con el
// SDK oficial y salida estructurada (`output_config.format`, JSON Schema sin topes como la CLI).
// Para los corredores que no son del operador: la clave es del operador y se cobra por uso. Nunca
// se loguean el prompt, la respuesta ni la clave. Nota: docs/integraciones/anthropic-api.md §11.

export type AnthropicApiOptions = {
  /** `ANTHROPIC_API_KEY`: la pasa el punto de entrada (el paquete no lee el entorno). */
  apiKey: string;
  /** `ANTHROPIC_MODEL` (por defecto `claude-sonnet-5-5`, D15). */
  model: string;
  /** Tope de cada llamada (`LLM_TIMEOUT_SECONDS`), con los reintentos del SDK incluidos. */
  timeoutMs: number;
  /** Solo para tests: responde en lugar de la red (nunca se llama a la API de verdad en tests). */
  fetch?: typeof fetch;
  /** Reintentos del SDK ante 429 con `retry-after`, 5xx, 529 y la conexión (por defecto 2). */
  maxRetries?: number;
};

/** Holgura de salida: el borrador de los tres canales ocupa unos 2.000 a 4.000 tokens. */
const MAX_OUTPUT_TOKENS = 16_000;

const SPEND_LIMIT_400 = /reached your specified (workspace )?API usage limits/i;

/** El código de un error de la API (`error.details.error_code`), si viene. */
function errorCodeOf(error: APIError): string | undefined {
  const body = error.error as { error?: { details?: { error_code?: unknown } } } | undefined;
  const code = body?.error?.details?.error_code;
  return typeof code === "string" ? code : undefined;
}

const accountLimit = (cause: unknown) =>
  new AppError(
    "LLM_ACCOUNT_LIMIT",
    "La cuenta de Anthropic llegó a su tope de gasto o no tiene saldo: revisa la consola de Anthropic",
    { cause },
  );

/**
 * Un error del SDK como `AppError` del puerto (ADR-0003). El SDK ya reintentó lo pasajero
 * (`maxRetries`): lo que llega aquí es definitivo para este intento.
 */
export function anthropicError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof APIUserAbortError) {
    return new AppError("LLM_ABORTED", "Se cortó la llamada a la IA", { retriable: true });
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new AppError("LLM_TIMEOUT", "La IA no respondió a tiempo", { retriable: true });
  }
  if (error instanceof APIConnectionError) {
    return new AppError("LLM_UNAVAILABLE", "No hubo conexión con la API de Anthropic", {
      retriable: true,
      cause: error,
    });
  }
  if (error instanceof APIError) {
    const status = error.status ?? 0;
    const details = { httpStatus: status, requestId: error.requestID ?? null };
    if (status === 401 || status === 403) {
      return new AppError(
        "LLM_AUTH_REQUIRED",
        "La API de Anthropic rechazó la clave (venció o la revocaron): revisa ANTHROPIC_API_KEY",
        { details },
      );
    }
    if (status === 402) return accountLimit(error);
    if (status === 429) {
      if (errorCodeOf(error) === "enforced_spend_limit_reached") return accountLimit(error);
      return new AppError(
        "LLM_RATE_LIMITED",
        "La API de Anthropic pidió esperar (límite de uso): vuelve a intentar en un momento",
        { details: { ...details, retryAfter: error.headers?.get("retry-after") ?? null } },
      );
    }
    if (status === 400 && SPEND_LIMIT_400.test(error.message)) return accountLimit(error);
    if (status >= 500) {
      return new AppError("LLM_UNAVAILABLE", "La API de Anthropic no está disponible", {
        retriable: true,
        details,
      });
    }
    return new AppError("LLM_REQUEST_REJECTED", "La API de Anthropic rechazó la petición", {
      details,
    });
  }
  return new AppError("LLM_UNAVAILABLE", "Falló la llamada a la API de Anthropic", {
    retriable: true,
    cause: error,
  });
}

const invalidOutput = (reason: string) =>
  new AppError("LLM_OUTPUT_INVALID", "La IA no entregó los textos en el formato pedido", {
    details: { reason },
  });

/** `anthropic-api` real: salida estructurada, sus errores y el uso de tokens de cada llamada. */
export function createAnthropicApiProvider(options: AnthropicApiOptions): LLMProvider {
  const client = new Anthropic({
    apiKey: options.apiKey,
    timeout: options.timeoutMs,
    maxRetries: options.maxRetries ?? 2,
    // Sin trazas de OpenTelemetry (la app no registra un proveedor; así no cambia si alguno lo hace).
    openTelemetry: false,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return {
    name: "anthropic-api",
    async generateStructured({ system, prompt, jsonSchema, signal }) {
      let response: Anthropic.Message & { _request_id?: string | null };
      try {
        response = await client.messages.create(
          {
            model: options.model,
            max_tokens: MAX_OUTPUT_TOKENS,
            system,
            messages: [{ role: "user", content: prompt }],
            // Un texto corto: esfuerzo bajo (docs/integraciones/anthropic-api.md §11.2).
            output_config: { format: { type: "json_schema", schema: jsonSchema }, effort: "low" },
          },
          signal === undefined ? {} : { signal: signal as AbortSignal },
        );
      } catch (error) {
        throw anthropicError(error);
      }
      const usage: LlmTokenUsage = {
        inputTokens: response.usage.input_tokens,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
        outputTokens: response.usage.output_tokens,
        requestId: response._request_id ?? null,
      };
      // Se cobra igual: el uso viaja también con el error, para anotarlo (spec F7 §4.7).
      const fail = (reason: string) => {
        const error = invalidOutput(reason);
        Object.assign(error.details ?? {}, { usage, model: response.model });
        return error;
      };
      if (response.stop_reason === "refusal") throw fail("refusal");
      if (response.stop_reason === "max_tokens") throw fail("max_tokens");
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw fail("json");
      }
      return { data, model: response.model, usage };
    },
  };
}
