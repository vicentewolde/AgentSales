import type { ContentRunError } from "../content.js";
import type { LlmCallUsage } from "../llm-usage.js";
import type { PlanRun } from "../plan-run.js";
import type { NewPost } from "./post-repository.js";

/** Un plan nuevo (ADR-0030): nace en `queued`, sin reporte ni gasto. */
export type NewPlanRun = {
  brokerId: string;
  periodStart: Date;
  periodEnd: Date;
  /** Lo pedido (redes, cuántas ideas…), sin secretos. */
  request: Record<string, unknown>;
};

/**
 * Los planes de ideas (`plan_runs`, ADR-0030); la lógica es de `requestPlanRun` y `runPlan`
 * (F9-T20). Los cambios de estado son condicionales, como los de `ContentRunRepository`, y
 * devuelven si cambiaron. Errores (`AppError`):
 * - `create` de un corredor que no existe → `PLAN_RUN_REFERENCE_INVALID`;
 * - `create` de un corredor que ya tiene un plan en `queued` o `running` → `PLAN_RUN_CONFLICT` (un
 *   plan activo por marca, índice único parcial de la base; F9-T20);
 * - `markSucceeded` con una idea cuyo corredor, plan o usuario no existen →
 *   `POST_REFERENCE_INVALID` (y no guarda nada);
 * - `addLlmUsage` de un plan que no existe → `PLAN_RUN_NOT_FOUND`;
 * - una fila que no calza con la entidad → `PLAN_RUN_ROW_INVALID`;
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 */
export interface PlanRunRepository {
  create(run: NewPlanRun): Promise<PlanRun>;
  get(id: string): Promise<PlanRun | null>;
  /** Los de un corredor, los más recientes primero, como mucho `limit` (por defecto 20). */
  /** Por defecto `PLAN_RUNS_LIST_LIMIT.default` (20). */
  listByBroker(brokerId: string, limit?: number): Promise<PlanRun[]>;
  /** `queued` o `running` → `running`; fija `started_at` solo la primera vez. */
  markRunning(id: string): Promise<boolean>;
  /**
   * `running` → `succeeded` con el reporte, la versión del prompt y `finished_at` y, en la misma
   * transacción, los posts de sus ideas (`ideas`, F9-T20): todo o nada. Si el plan ya no estaba en
   * `running`, no guarda nada y devuelve `false` (un intento repetido no duplica las ideas).
   */
  markSucceeded(
    id: string,
    result: { report: unknown; promptVersion: string; ideas?: readonly NewPost[] },
  ): Promise<boolean>;
  /** `queued` o `running` → `failed` con el error y `finished_at`: el primer terminal gana. */
  markFailed(id: string, error: ContentRunError): Promise<boolean>;
  /** Los planes en `queued`, los más antiguos primero (el worker los reencola al arrancar). */
  listQueued(): Promise<PlanRun[]>;
  /**
   * Cierra como `failed` con `error` los planes en `running` con `started_at` anterior a
   * `startedBefore` (su intento ya no está vivo). Devuelve sus ids.
   */
  failAbandoned(startedBefore: Date, error: ContentRunError): Promise<string[]>;
  /**
   * Suma una llamada al modelo a `llm_usage`, de forma atómica y en cualquier estado: un plan que
   * falla después de gastar también queda anotado (entra a `sumLlmCost`, spec F9 §4.12).
   */
  addLlmUsage(id: string, call: LlmCallUsage): Promise<PlanRun>;
}
