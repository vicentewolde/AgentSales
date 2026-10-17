import {
  type Broker,
  type BrokerBrandInput,
  isValidSlug,
  normalizeBrokerBrand,
  normalizeLlmMonthlyCap,
} from "../broker.js";
import { AppError, isAppError } from "../errors.js";
import type { BrokerRepository } from "../ports/broker-repository.js";

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
 * Crea un corredor (spec F7 §4.6, solo el administrador: la ruta lo exige). Las reglas de la hoja
 * Corredor: `slug` en minúsculas, números y guiones, nombre, marca y color primario obligatorios
 * (el secundario, si falta, es el primario). `BROKER_INVALID` (400) o `BROKER_SLUG_TAKEN` (409).
 */
export async function createBroker(
  deps: { brokers: Pick<BrokerRepository, "findBySlug" | "create" | "setSettings"> },
  input: CreateBrokerInput,
): Promise<Broker> {
  const slug = input.slug.trim();
  if (!isValidSlug(slug)) {
    throw new AppError(
      "BROKER_INVALID",
      `«${slug}» no sirve como identificador del corredor (minúsculas, números y guiones)`,
      { details: { issues: [{ field: "slug", message: "minúsculas, números y guiones" }] } },
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
