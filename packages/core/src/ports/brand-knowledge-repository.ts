import type {
  BrandKnowledge,
  BrandKnowledgeData,
  KnowledgeExample,
  KnowledgeProposal,
  KnowledgeProposalKind,
  KnowledgeProposalStatus,
  KnowledgeRun,
  KnowledgeUpdate,
  KnowledgeUpdateInput,
  KnowledgeUpdateSource,
} from "../brand-knowledge.js";
import type { ContentRunError } from "../content.js";
import type { LlmCallUsage } from "../llm-usage.js";

/**
 * El conocimiento de cada marca (spec F9.7 B1, ADR-0043): la postura y el tono
 * (`brand_knowledge`), sus ejemplos (`brand_knowledge_examples`) y sus novedades
 * (`brand_knowledge_updates`). Errores (`AppError`):
 * - escribir de un corredor que no existe → `KNOWLEDGE_REFERENCE_INVALID`;
 * - una fila que no calza → `KNOWLEDGE_ROW_INVALID`;
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 */
export interface BrandKnowledgeRepository {
  /** La postura y el tono; `null` si nunca se guardaron. */
  get(brokerId: string): Promise<BrandKnowledge | null>;
  /** Los ejemplos, en el orden en que se guardaron. */
  listExamples(brokerId: string): Promise<KnowledgeExample[]>;
  /**
   * Reemplaza la postura, el tono y los ejemplos (todos juntos, en una transacción) y devuelve lo
   * guardado.
   */
  save(
    brokerId: string,
    data: BrandKnowledgeData,
  ): Promise<{ knowledge: BrandKnowledge; examples: KnowledgeExample[] }>;
  /**
   * Las novedades, las más nuevas primero (por fecha y después por creación). Sin
   * `includeArchived`, solo las activas; con `since` (`AAAA-MM-DD`), desde esa fecha.
   */
  listUpdates(
    brokerId: string,
    options?: { includeArchived?: boolean; since?: string; limit?: number },
  ): Promise<KnowledgeUpdate[]>;
  getUpdate(id: string): Promise<KnowledgeUpdate | null>;
  addUpdate(
    brokerId: string,
    update: KnowledgeUpdateInput & { source: KnowledgeUpdateSource },
  ): Promise<KnowledgeUpdate>;
  /** Cambia el proyecto, la fecha o el texto de una novedad activa; `null` si no existe. */
  editUpdate(id: string, update: KnowledgeUpdateInput): Promise<KnowledgeUpdate | null>;
  /** Archiva (borrar es archivar): deja de ser fuente. Idempotente; `null` si no existe. */
  archiveUpdate(id: string): Promise<KnowledgeUpdate | null>;
}

/** Una propuesta nueva de una corrida. */
export type NewKnowledgeProposal = {
  kind: KnowledgeProposalKind;
  text: string;
  project: string | null;
  date: string | null;
};

/**
 * Las corridas de «Actualizar desde un texto» y sus propuestas (spec F9.7 B2, ADR-0043 punto 2).
 * Los cambios de estado son condicionales, como los de un plan, y devuelven si cambiaron. Errores:
 * - `createRun` de una marca con otra corrida en `queued` o `running` → `KNOWLEDGE_RUN_CONFLICT`
 *   (una activa por marca);
 * - `createRun` de un corredor que no existe → `KNOWLEDGE_REFERENCE_INVALID`;
 * - `addLlmUsage` de una corrida que no existe → `KNOWLEDGE_RUN_NOT_FOUND`.
 */
export interface KnowledgeProposalRepository {
  createRun(run: {
    brokerId: string;
    sourceText: string;
    createdBy: string | null;
  }): Promise<KnowledgeRun>;
  getRun(id: string): Promise<KnowledgeRun | null>;
  /** Las de una marca, las más nuevas primero (como mucho `limit`, por defecto 10). */
  listRuns(brokerId: string, limit?: number): Promise<KnowledgeRun[]>;
  /** `queued` o `running` → `running`. */
  markRunning(id: string): Promise<boolean>;
  /**
   * `running` → `succeeded` con sus advertencias y, en la misma transacción, sus propuestas
   * (`pending`): todo o nada. Si ya no estaba en `running`, no guarda nada.
   */
  markSucceeded(
    id: string,
    result: { warnings: string[]; proposals: readonly NewKnowledgeProposal[] },
  ): Promise<boolean>;
  markFailed(id: string, error: ContentRunError): Promise<boolean>;
  /** Suma una llamada al modelo (entra a `sumLlmCost`), en cualquier estado. */
  addLlmUsage(id: string, call: LlmCallUsage): Promise<KnowledgeRun>;
  /** Las propuestas de una marca, las más nuevas primero; con `status`, solo las de ese estado. */
  listProposals(
    brokerId: string,
    options?: { status?: KnowledgeProposalStatus; limit?: number },
  ): Promise<KnowledgeProposal[]>;
  getProposal(id: string): Promise<KnowledgeProposal | null>;
  /** `pending` → `accepted` o `discarded`; `false` si ya no estaba `pending`. */
  resolveProposal(id: string, status: "accepted" | "discarded"): Promise<boolean>;
}
