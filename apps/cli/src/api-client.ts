import type { AppType } from "@agentsales/api";
import { errorBodySchema, type ReadinessIssueView } from "@agentsales/api/contracts";
import { type HealthReport, healthReportSchema } from "@agentsales/core";
import { hc } from "hono/client";
import type { z } from "zod";
import { noticeOnce } from "./notices.js";
import { isLocalServer } from "./server.js";

/** Mayor que el peor caso de `/health` (25 s con Neon despertando). */
export const API_TIMEOUT_MS = 30_000;

/**
 * La API de un servidor (su origen, validado con `parseServerUrl`) va bajo el prefijo `/api` (spec
 * F8 §4.3 y §4.5).
 */
export const apiUrl = (server: string) => `${server}/api`;

/**
 * Fallo al hablar con la API. `code` es el de su `ErrorBody` o el de la red (`ECONNREFUSED`,
 * `TIMEOUT`…); `status` falta si la API no llegó a responder.
 */
export class ApiCallError extends Error {
  readonly code: string | undefined;
  readonly status: number | undefined;
  /** El mensaje de la API, sin el código delante (`message` es `CODE: mensaje`). */
  readonly apiMessage: string | undefined;
  /**
   * Solo en `PORTAL_NOT_READY` y `MARKETPLACE_NOT_READY`: lo que le falta al aviso, uno por motivo
   * (spec F4 §4.11 y F5 §4.10).
   */
  readonly issues: readonly ReadinessIssueView[] | undefined;
  /**
   * Solo en `MANUAL_CONFIRM_PENDING` y `MARKETPLACE_FORM_OPEN`: la publicación de Marketplace que
   * espera el clic final (spec F5 §4.10), para sugerir "lo publiqué" o "no lo publiqué".
   */
  readonly publicationId: string | undefined;
  /**
   * Que vino de un servidor que no es el del Mac (spec F8 §4.5): la sugerencia no habla de
   * `pnpm dev` ni de `API_PORT`.
   */
  remote = false;

  constructor(
    message: string,
    code?: string,
    status?: number,
    apiMessage?: string,
    issues?: readonly ReadinessIssueView[],
    publicationId?: string,
  ) {
    super(message);
    this.name = "ApiCallError";
    this.code = code;
    this.status = status;
    this.apiMessage = apiMessage;
    this.issues = issues;
    this.publicationId = publicationId;
  }
}

/** Mensaje legible de un fallo de red o de timeout de `fetch`. */
function describeFetchError(error: unknown, timeoutMs: number): ApiCallError {
  if (error instanceof Error && error.name === "TimeoutError") {
    const after = timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`;
    return new ApiCallError(`sin respuesta en ${after}`, "TIMEOUT");
  }
  const cause = error instanceof Error ? error.cause : undefined;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : undefined;
  if (code === "ECONNREFUSED") {
    return new ApiCallError("nadie escucha en ese puerto (ECONNREFUSED)", code);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ApiCallError(code ? `${message} (${code})` : message, code);
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ApiClientOptions = {
  timeoutMs?: number;
  /** El token de `agentsales login` (spec F7 §4.10): va como `Authorization: Bearer`. */
  token?: string | undefined;
  /**
   * La versión de esta CLI (spec F9.5 §4.2): si la del servidor (`X-AgentSales-Version`) es otra,
   * avisa una vez por comando en stderr, sin fallar. Sin ella, no compara (los tests).
   */
  version?: string | undefined;
  /** Solo para tests: la app en proceso (`app.request`), sin red. */
  fetch?: Fetch;
};

/**
 * La cabecera con la versión del servidor. Es la misma de `apps/api/src/app.ts` (`VERSION_HEADER`):
 * la CLI no importa valores de la API, y sus pruebas contra la API en proceso confirman que calzan.
 */
export const VERSION_HEADER = "X-AgentSales-Version";

/** Una versión como la escribe `package.json` (`0.1.0`, `1.2.0-beta.1`); otra cosa no se muestra. */
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,40}$/;

/**
 * Avisa una vez por comando si el servidor es de otra versión (spec F9.5 §4.2). Un servidor sin la
 * cabecera (uno anterior a F9.5, u otro servicio) no se compara: si es otro servicio, ya lo dice
 * `UNEXPECTED_RESPONSE`.
 */
function checkServerVersion(cliVersion: string | undefined, response: Response): void {
  if (cliVersion === undefined) return;
  const server = response.headers.get(VERSION_HEADER)?.trim();
  if (server === undefined || server === "" || server === cliVersion) return;
  const shown = VERSION_PATTERN.test(server) ? server : "de otra versión";
  noticeOnce(
    "version",
    `La CLI es ${cliVersion} y el servidor ${shown}: actualiza la que esté atrás`,
  );
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Un pedido que cambia algo y va sin cuerpo (aprobar, publicar una, descartar) lleva
 * `Content-Type: application/json`: sin él, el CSRF de la API lo trataba como un formulario (spec
 * F3-T15). Desde F7-T16 el CSRF no aplica con `Bearer`; se mantiene para un pedido sin sesión (es
 * inofensivo). Uno con cuerpo ya lo trae (`json`) o lleva el suyo (un formulario).
 */
function withJsonType(init: RequestInit | undefined): RequestInit | undefined {
  if (init === undefined || init.body != null) return init;
  if (!UNSAFE_METHODS.has(init.method?.toUpperCase() ?? "GET")) return init;
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return { ...init, headers };
}

/**
 * Cliente RPC tipado (`hc<AppType>`) con toda la API. Cada petición tiene timeout, y un fallo de
 * red o de timeout llega como `ApiCallError`. La respuesta se lee con `unwrap`. Con la sesión de
 * `agentsales login`, la API sabe que es la CLI (la bitácora registra `actor: cli`, spec F7 §4.3).
 */
export function createApiClient(server: string, options: ApiClientOptions = {}) {
  const timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS;
  const send = options.fetch ?? fetch;
  const remote = !isLocalServer(server);
  return hc<AppType>(apiUrl(server), {
    headers: options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      let response: Response;
      try {
        // Sin seguir redirecciones: el token nunca sigue a otro servidor.
        response = await send(input, { ...withJsonType(init), signal, redirect: "error" });
      } catch (error) {
        // Uno que ya explica la CLI (una dirección inválida, `invalidServerClient`) pasa tal cual.
        if (error instanceof ApiCallError) throw error;
        const failure = describeFetchError(error, timeoutMs);
        failure.remote = remote;
        throw failure;
      }
      checkServerVersion(options.version, response);
      return response;
    },
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;

/**
 * Un cliente que no llama a nadie: la dirección del servidor no es válida (spec F8 §4.5). Cada
 * comando muestra el motivo con `API_URL_INVALID`, como cualquier fallo de la API.
 */
export function invalidServerClient(message: string): ApiClient {
  return createApiClient("http://127.0.0.1", {
    fetch: async () => {
      throw new ApiCallError(message, "API_URL_INVALID");
    },
  });
}

type ApiResponse = { ok: boolean; status: number; url?: string; json(): Promise<unknown> };

/** Si la respuesta vino de un servidor remoto (por su `url`; sin ella, local). */
function fromRemote(res: ApiResponse): boolean {
  try {
    return res.url !== undefined && res.url !== "" && !isLocalServer(res.url);
  } catch {
    return false;
  }
}

type Path = readonly PropertyKey[];

/** El valor en `path` dentro de un JSON leído (objetos y arreglos), o `found: false`. */
function valueAt(root: unknown, path: Path): { found: boolean; value: unknown } {
  let current = root;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, key)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return { found: true, value: current };
}

/** Cambia el valor en `path` (que ya existe); `false` si no está. */
function replaceAt(root: unknown, path: Path, value: unknown): boolean {
  const key = path.at(-1);
  if (key === undefined) return false;
  const parent = valueAt(root, path.slice(0, -1));
  if (!parent.found || typeof parent.value !== "object" || parent.value === null) return false;
  if (!Object.hasOwn(parent.value, key)) return false;
  (parent.value as Record<PropertyKey, unknown>)[key] = value;
  return true;
}

/** Cuántos valores nuevos se nombran en el aviso: el resto se muestra igual, sin nombrarse. */
const NEW_VALUES_SHOWN = 5;

/**
 * Un valor nuevo que el aviso puede nombrar tal cual (`discord_video`, `AI_TELL`); otro texto del
 * servidor (largo, con espacios o caracteres de control) se nombra «…».
 */
const SAFE_VALUE_PATTERN = /^[\w.:-]{1,40}$/;

/**
 * Un valor de enum que esta CLI no conoce (spec F9.5 §4.2, B5): un servidor más nuevo agregó un
 * estado, una variante o un código. Si **todos** los errores de validación son `invalid_value`
 * (zod 4: un `z.enum` o un `z.literal`) sobre un texto que sí llegó, el cuerpo se acepta con ese
 * texto tal como vino; cualquier otro error (un campo que falta, un tipo distinto, una unión sin
 * opción) devuelve `null` y sigue siendo `UNEXPECTED_RESPONSE`.
 *
 * El cuerpo no se devuelve crudo: se valida otra vez con un valor conocido en cada lugar (así las
 * fechas se convierten y los valores por defecto se ponen, como siempre) y después se repone el
 * valor que llegó. Las etiquetas de la CLI caen al valor (`TEXT[v] ?? v`).
 */
function withNewEnumValues<S extends z.ZodType>(
  schema: S,
  body: unknown,
  issues: readonly z.core.$ZodIssue[],
): { data: z.output<S>; values: string[] } | null {
  if (issues.length === 0) return null;
  const found: { path: Path; value: string; known: unknown }[] = [];
  for (const issue of issues) {
    // Solo un enum de textos: un `z.literal(5)` o un enum numérico que no calza es otra forma.
    if (issue.code !== "invalid_value" || issue.values.length === 0) return null;
    if (!issue.values.every((value) => typeof value === "string")) return null;
    const original = valueAt(body, issue.path);
    // Un campo que falta o que no es texto no es un valor nuevo: es otra forma.
    if (!original.found || typeof original.value !== "string") return null;
    found.push({ path: issue.path, value: original.value, known: issue.values[0] });
  }
  const patched: unknown = structuredClone(body);
  for (const item of found) {
    if (!replaceAt(patched, item.path, item.known)) return null;
  }
  const reparsed = schema.safeParse(patched);
  if (!reparsed.success) return null;
  const data: unknown = reparsed.data;
  for (const item of found) {
    if (!replaceAt(data, item.path, item.value)) return null;
  }
  return {
    data: reparsed.data,
    values: [
      ...new Set(found.map((item) => (SAFE_VALUE_PATTERN.test(item.value) ? item.value : "…"))),
    ].slice(0, NEW_VALUES_SHOWN),
  };
}

/**
 * Lee la respuesta: un error de la API (`ErrorBody`) se lanza como `CODE: mensaje`, y una
 * respuesta exitosa se valida con su esquema de `@agentsales/api/contracts`, porque viene de la
 * red (quizás de otro servicio en el mismo puerto). Un valor de enum que esta CLI no conoce se
 * acepta y se avisa una vez (`withNewEnumValues`, spec F9.5 §4.2).
 */
export async function unwrap<S extends z.ZodType>(
  response: ApiResponse | Promise<ApiResponse>,
  schema: S,
): Promise<z.output<S>> {
  const res = await response;
  const body: unknown = await res.json().catch((error: unknown) => {
    // El timeout sigue corriendo mientras llega el cuerpo: un corte ahí no es "otra forma".
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new ApiCallError(
        "la API dejó de responder a mitad de la respuesta",
        "TIMEOUT",
        res.status,
      );
    }
    return undefined;
  });
  if (!res.ok) {
    const parsed = errorBodySchema.safeParse(body);
    const failure = parsed.success
      ? new ApiCallError(
          `${parsed.data.error.code}: ${parsed.data.error.message}`,
          parsed.data.error.code,
          res.status,
          parsed.data.error.message,
          parsed.data.error.issues,
          parsed.data.error.publicationId,
        )
      : new ApiCallError(`la API respondió ${res.status}`, undefined, res.status);
    failure.remote = fromRemote(res);
    throw failure;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const tolerated = withNewEnumValues(schema, body, parsed.error.issues);
    if (tolerated !== null) {
      noticeOnce(
        "new-values",
        `El servidor envió valores que esta CLI no conoce (${tolerated.values.join(", ")}): se muestran tal como llegan; actualiza la CLI`,
      );
      return tolerated.data;
    }
    const failure = new ApiCallError(
      fromRemote(res)
        ? "respuesta inesperada: ¿esa dirección es la de AgentSales, o es de otra versión?"
        : "respuesta inesperada de la API: ¿hay otro servicio en ese puerto, o es de otra versión?",
      "UNEXPECTED_RESPONSE",
      res.status,
    );
    failure.remote = fromRemote(res);
    throw failure;
  }
  return parsed.data;
}

export type HealthFetcher = () => Promise<HealthReport>;

/** `/health` validado, para `doctor` y `status`. */
export function createHealthFetcher(client: ApiClient): HealthFetcher {
  return () => unwrap(client.health.$get(), healthReportSchema);
}

/**
 * Sugerencia según el motivo por el que la API no respondió. Con un servidor remoto (spec F8 §4.5),
 * no se sugiere `pnpm dev` ni `API_PORT`, que son del Mac.
 */
export function apiHint(
  error: unknown,
  remote = error instanceof ApiCallError && error.remote,
): string {
  if (error instanceof ApiCallError && error.code === "API_URL_INVALID") {
    return "Corrige AGENTSALES_API_URL, o entra de nuevo con agentsales login --api https://<dominio>";
  }
  if (remote) {
    return error instanceof ApiCallError && error.code === "UNEXPECTED_RESPONSE"
      ? "Esa dirección no es la de AgentSales: revísala con agentsales whoami"
      : "Revisa que el servidor esté encendido y la dirección (agentsales whoami)";
  }
  if (error instanceof ApiCallError && error.code === "HOST_NOT_ALLOWED") {
    return "La API rechazó el Host: revisa que API_PORT coincida con el de la API";
  }
  if (error instanceof ApiCallError && error.code === "UNEXPECTED_RESPONSE") {
    return "Otro proceso usa el puerto: ciérralo o cambia API_PORT, y levanta pnpm dev";
  }
  return "Levántala con pnpm dev";
}
