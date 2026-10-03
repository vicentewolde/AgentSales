import type { AbortSignalLike } from "../abort.js";
import type { LlmProvider } from "../enums.js";

/** Una petición de salida estructurada (spec F2 §4.5, ADR-0003 y ADR-0013). */
export type LLMRequest = {
  /** Prompt de sistema: las reglas editoriales, sin datos del aviso. */
  system: string;
  /** Prompt del usuario: los datos del aviso. Puede traer datos de clientes: nunca se loguea. */
  prompt: string;
  /**
   * JSON Schema (draft-07) de la salida, **sin largos ni topes**: algunos proveedores no los
   * aplican (la CLI de Claude). Core lo genera con `z.toJSONSchema` y valida `data` con su
   * esquema estricto: el proveedor no valida el contenido, solo su propio sobre.
   */
  jsonSchema: Record<string, unknown>;
  /** Corta la llamada (por ejemplo, al apagar el worker): el proveedor mata su subproceso. */
  signal?: AbortSignalLike;
};

/** Respuesta: el dato tal cual lo devolvió el modelo (sin validar) y el modelo que respondió. */
export type LLMResponse = { data: unknown; model: string };

/**
 * Proveedor de IA (ADR-0003). Es solo transporte: el prompt, el esquema, la validación y el
 * reintento viven en core (ADR-0013). Errores (`AppError`):
 * - `LLM_UNAVAILABLE` (reintentable): no respondió, se cayó o está sobrecargado;
 * - `LLM_TIMEOUT` (reintentable): pasó el tope de tiempo;
 * - `LLM_ABORTED` (reintentable): se cortó con `signal` (el job se reintenta después);
 * - `LLM_AUTH_REQUIRED`: sin sesión o credenciales;
 * - `LLM_RATE_LIMITED`: límite de uso o saldo del plan; no se reintenta dentro del job;
 * - `LLM_OUTPUT_INVALID`: el modelo no entregó la salida estructurada (agotó sus reintentos, se
 *   cortó por largo o se negó);
 * - `LLM_NOT_CONFIGURED`: el proveedor no está disponible (el stub, o la CLI no está instalada).
 */
export interface LLMProvider {
  readonly name: LlmProvider;
  generateStructured(request: LLMRequest): Promise<LLMResponse>;
}
