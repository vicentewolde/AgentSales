import {
  type Broker,
  type BrokerBrandInput,
  brokerFieldIssue,
  isValidSlug,
  normalizeBrokerBrand,
  normalizeLlmMonthlyCap,
} from "../broker.js";
import { AppError, isAppError } from "../errors.js";
import { assertCan } from "../permissions.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { User } from "../user.js";

export type CreateBrokerInput = BrokerBrandInput & {
  slug: string;
  /** Corredor propio del operador (su plan de Claude, Marketplace automático). Por defecto, no. */
  operatorOwned?: boolean;
  /** Tope de IA del mes en dólares; `null` o ausente = sin tope. */
  llmMonthlyCapUsd?: number | null;
};

const slugTaken = (slug: string) =>
  new AppError("BROKER_SLUG_TAKEN", `Ya existe el corredor ${slug}`, { details: { slug } });

/**
 * Crea un corredor (spec F7 §4.6, solo el administrador: `brokers.create`, si no `FORBIDDEN`). Las reglas de la hoja
 * Corredor: `slug` en minúsculas, números y guiones, nombre, marca y color primario obligatorios
 * (el secundario, si falta, es el primario). `BROKER_INVALID` (400) o `BROKER_SLUG_TAKEN` (409).
 * Crear y fijar si es propio o su tope son dos escrituras: si la segunda falla, el corredor queda
 * creado sin ellas (repetir el alta da `BROKER_SLUG_TAKEN`; se completan con `PATCH`).
 */
export async function createBroker(
  deps: { brokers: Pick<BrokerRepository, "findBySlug" | "create" | "setSettings"> },
  actor: Pick<User, "role" | "brokerId">,
  input: CreateBrokerInput,
): Promise<Broker> {
  assertCan(actor, "brokers.create");
  const slug = input.slug.trim();
  if (!isValidSlug(slug)) {
    throw new AppError(
      "BROKER_INVALID",
      `«${slug}» no sirve como identificador del corredor (minúsculas, números y guiones)`,
      { details: { issues: [brokerFieldIssue("slug", "solo minúsculas, números y guiones")] } },
    );
  }
  const brand = normalizeBrokerBrand({
    name: input.name ?? null,
    brandName: input.brandName ?? null,
    primaryColor: input.primaryColor ?? null,
    ...(input.secondaryColor ? { secondaryColor: input.secondaryColor } : {}),
    whatsapp: input.whatsapp ?? null,
    email: input.email ?? null,
    instagramHandle: input.instagramHandle ?? null,
    website: input.website ?? null,
    tone: input.tone ?? null,
    fixedHashtags: input.fixedHashtags ?? [],
  });
  // Validar el tope antes de crear: no queda un corredor a medias por un tope mal escrito.
  const cap =
    input.llmMonthlyCapUsd === undefined
      ? undefined
      : normalizeLlmMonthlyCap(input.llmMonthlyCapUsd);
  if ((await deps.brokers.findBySlug(slug)) !== null) throw slugTaken(slug);
  let broker: Broker;
  try {
    broker = await deps.brokers.create({
      slug,
      name: brand.name ?? "",
      brandName: brand.brandName ?? "",
      primaryColor: brand.primaryColor ?? "",
      secondaryColor: brand.secondaryColor ?? brand.primaryColor ?? "",
      whatsapp: brand.whatsapp ?? null,
      email: brand.email ?? null,
      instagramHandle: brand.instagramHandle ?? null,
      website: brand.website ?? null,
      tone: brand.tone ?? null,
      fixedHashtags: brand.fixedHashtags ?? [],
    });
  } catch (error) {
    // Dos altas del mismo `slug` a la vez: la segunda pierde (el repositorio lo informa así).
    if (isAppError(error) && error.code === "BROKER_CONFLICT") throw slugTaken(slug);
    throw error;
  }
  if (input.operatorOwned === true || cap !== undefined) {
    broker = await deps.brokers.setSettings(broker.id, {
      ...(input.operatorOwned === true ? { operatorOwned: true } : {}),
      ...(cap === undefined ? {} : { llmMonthlyCapUsd: cap }),
    });
  }
  return broker;
}
