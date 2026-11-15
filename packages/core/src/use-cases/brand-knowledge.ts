import { inScope } from "../access.js";
import {
  BRAND_KNOWLEDGE_LIMITS,
  type BrandKnowledgeInput,
  type KnowledgeExample,
  type KnowledgeUpdate,
  type KnowledgeUpdateInput,
  knowledgeForPrompt,
  knowledgeSince,
  normalizeBrandKnowledge,
  normalizeKnowledgeUpdate,
} from "../brand-knowledge.js";
import { emptyEditorialProfileData } from "../editorial-profile.js";
import { AppError } from "../errors.js";
import { assertCan, type Permission, scopeOf } from "../permissions.js";
import type { BrandKnowledgeRepository } from "../ports/brand-knowledge-repository.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { EditorialProfileRepository } from "../ports/editorial-profile-repository.js";
import type { User } from "../user.js";

// El conocimiento de la marca (spec F9.7 B1 y B3, ADR-0043). Sin permiso nuevo, como el perfil
// editorial: leer es `broker.view` y editar es `brand.edit`. El corredor es siempre el de la ruta.

type Actor = Pick<User, "role" | "brokerId">;

/** Lo de otro corredor no existe (`BROKER_NOT_FOUND`); lo suyo sin el permiso es `FORBIDDEN`. */
export async function assertBrandAccess(
  brokers: Pick<BrokerRepository, "findById">,
  actor: Actor,
  brokerId: string,
  permission: Permission,
): Promise<void> {
  const notFound = () =>
    new AppError("BROKER_NOT_FOUND", `No existe el corredor ${brokerId}`, {
      details: { id: brokerId },
    });
  if (!inScope(scopeOf(actor), brokerId)) throw notFound();
  assertCan(actor, permission, brokerId);
  if ((await brokers.findById(brokerId)) === null) throw notFound();
}

/** El conocimiento de una marca como lo entregan la API y la CLI. */
export type BrandKnowledgeView = {
  brokerId: string;
  stance: string | null;
  tone: string | null;
  examples: KnowledgeExample[];
  /** Las novedades activas, las más nuevas primero. */
  updates: KnowledgeUpdate[];
  /** Cuántas novedades activas ve la IA hoy (las de los últimos 90 días, hasta 20). */
  updatesForAi: number;
  updatedAt: Date | null;
};

type KnowledgeDeps = {
  brokers: Pick<BrokerRepository, "findById">;
  brandKnowledge: BrandKnowledgeRepository;
  now?: () => Date;
};

async function viewOf(
  deps: Pick<KnowledgeDeps, "brandKnowledge" | "now">,
  brokerId: string,
): Promise<BrandKnowledgeView> {
  const [knowledge, examples, updates] = await Promise.all([
    deps.brandKnowledge.get(brokerId),
    deps.brandKnowledge.listExamples(brokerId),
    deps.brandKnowledge.listUpdates(brokerId, { limit: BRAND_KNOWLEDGE_LIMITS.updates }),
  ]);
  const now = (deps.now ?? (() => new Date()))();
  return {
    brokerId,
    stance: knowledge?.stance ?? null,
    tone: knowledge?.tone ?? null,
    examples,
    updates,
    updatesForAi:
      knowledgeForPrompt({ knowledge: null, examples: [], updates, now })?.updates.length ?? 0,
    updatedAt: knowledge?.updatedAt ?? null,
  };
}

/** El conocimiento de la marca (`broker.view`). Sin nada guardado, vacío (no un 404). */
export async function getBrandKnowledge(
  deps: KnowledgeDeps,
  actor: Actor,
  brokerId: string,
): Promise<BrandKnowledgeView> {
  await assertBrandAccess(deps.brokers, actor, brokerId, "broker.view");
  return viewOf(deps, brokerId);
}

/**
 * Reemplaza la postura, el tono y los ejemplos (`brand.edit`), validados con
 * `normalizeBrandKnowledge` (`KNOWLEDGE_INVALID`, 400, sin cambiar nada). Las novedades no se tocan.
 */
export async function saveBrandKnowledge(
  deps: KnowledgeDeps,
  actor: Actor,
  brokerId: string,
  input: BrandKnowledgeInput,
): Promise<BrandKnowledgeView> {
  await assertBrandAccess(deps.brokers, actor, brokerId, "brand.edit");
  await deps.brandKnowledge.save(brokerId, normalizeBrandKnowledge(input));
  return viewOf(deps, brokerId);
}

/** Las novedades de la marca (`broker.view`); con `includeArchived`, también las archivadas. */
export async function listKnowledgeUpdates(
  deps: KnowledgeDeps,
  actor: Actor,
  brokerId: string,
  options: { includeArchived?: boolean } = {},
): Promise<KnowledgeUpdate[]> {
  await assertBrandAccess(deps.brokers, actor, brokerId, "broker.view");
  return deps.brandKnowledge.listUpdates(brokerId, {
    includeArchived: options.includeArchived === true,
    limit: BRAND_KNOWLEDGE_LIMITS.updates * 2,
  });
}

const tooManyUpdates = () =>
  new AppError(
    "KNOWLEDGE_TOO_MANY_UPDATES",
    `La marca tiene ${BRAND_KNOWLEDGE_LIMITS.updates} novedades activas: archiva las viejas antes de agregar otra`,
  );

/** `KNOWLEDGE_TOO_MANY_UPDATES` (409) si la marca ya tiene el tope de novedades activas. */
export async function assertRoomForUpdate(
  knowledge: Pick<BrandKnowledgeRepository, "listUpdates">,
  brokerId: string,
): Promise<void> {
  const active = await knowledge.listUpdates(brokerId, {
    limit: BRAND_KNOWLEDGE_LIMITS.updates + 1,
  });
  if (active.length >= BRAND_KNOWLEDGE_LIMITS.updates) throw tooManyUpdates();
}

/** Agrega una novedad escrita por el operador (`brand.edit`; fuente de hechos, D1). */
export async function addKnowledgeUpdate(
  deps: KnowledgeDeps,
  actor: Actor,
  brokerId: string,
  input: KnowledgeUpdateInput,
): Promise<KnowledgeUpdate> {
  await assertBrandAccess(deps.brokers, actor, brokerId, "brand.edit");
  const update = normalizeKnowledgeUpdate(input);
  await assertRoomForUpdate(deps.brandKnowledge, brokerId);
  return deps.brandKnowledge.addUpdate(brokerId, { ...update, source: "operator" });
}

/** La novedad de esa marca, o `KNOWLEDGE_UPDATE_NOT_FOUND` (404) si no existe o es de otra. */
async function ownUpdate(
  deps: KnowledgeDeps,
  brokerId: string,
  updateId: string,
): Promise<KnowledgeUpdate> {
  const update = await deps.brandKnowledge.getUpdate(updateId);
  if (update === null || update.brokerId !== brokerId) {
    throw new AppError("KNOWLEDGE_UPDATE_NOT_FOUND", `No existe la novedad ${updateId}`);
  }
  return update;
}

/** Cambia una novedad activa (`brand.edit`). Una archivada no se edita (`KNOWLEDGE_UPDATE_ARCHIVED`). */
export async function editKnowledgeUpdate(
  deps: KnowledgeDeps,
  actor: Actor,
  brokerId: string,
  updateId: string,
  input: KnowledgeUpdateInput,
): Promise<KnowledgeUpdate> {
  await assertBrandAccess(deps.brokers, actor, brokerId, "brand.edit");
  const current = await ownUpdate(deps, brokerId, updateId);
  if (current.archivedAt !== null) {
    throw new AppError(
      "KNOWLEDGE_UPDATE_ARCHIVED",
      "Esa novedad está archivada: agrega una nueva en su lugar",
    );
  }
  const saved = await deps.brandKnowledge.editUpdate(updateId, normalizeKnowledgeUpdate(input));
  if (saved === null) {
    throw new AppError("KNOWLEDGE_UPDATE_NOT_FOUND", `No existe la novedad ${updateId}`);
  }
  return saved;
}

/** Archiva una novedad (`brand.edit`): deja de ser fuente de hechos. Idempotente. */
export async function archiveKnowledgeUpdate(
  deps: KnowledgeDeps,
  actor: Actor,
  brokerId: string,
  updateId: string,
): Promise<KnowledgeUpdate> {
  await assertBrandAccess(deps.brokers, actor, brokerId, "brand.edit");
  await ownUpdate(deps, brokerId, updateId);
  const archived = await deps.brandKnowledge.archiveUpdate(updateId);
  if (archived === null) {
    throw new AppError("KNOWLEDGE_UPDATE_NOT_FOUND", `No existe la novedad ${updateId}`);
  }
  return archived;
}

/**
 * El repositorio del perfil editorial con el conocimiento de la marca (ADR-0043 punto 3): `get`
 * agrega `knowledge` (lo que ve la IA, con el tope de B3), así redactar, revisar, aprobar y el plan
 * lo ven igual. Una marca con conocimiento y sin perfil recibe el perfil vacío con su conocimiento.
 * `upsert` no cambia.
 */
export function editorialProfilesWithKnowledge(
  profiles: EditorialProfileRepository,
  knowledge: Pick<BrandKnowledgeRepository, "get" | "listExamples" | "listUpdates">,
  clock: () => Date = () => new Date(),
): EditorialProfileRepository {
  return {
    upsert: (brokerId, profile) => profiles.upsert(brokerId, profile),
    async get(brokerId) {
      const now = clock();
      const [profile, saved, examples, updates] = await Promise.all([
        profiles.get(brokerId),
        knowledge.get(brokerId),
        knowledge.listExamples(brokerId),
        knowledge.listUpdates(brokerId, {
          since: knowledgeSince(now, BRAND_KNOWLEDGE_LIMITS.promptUpdateDays),
          limit: BRAND_KNOWLEDGE_LIMITS.promptUpdates,
        }),
      ]);
      const context = knowledgeForPrompt({ knowledge: saved, examples, updates, now });
      if (profile !== null) return { ...profile, knowledge: context };
      if (context === null) return null;
      const at = saved?.updatedAt ?? now;
      return {
        brokerId,
        ...emptyEditorialProfileData(),
        knowledge: context,
        createdAt: at,
        updatedAt: at,
      };
    },
  };
}
