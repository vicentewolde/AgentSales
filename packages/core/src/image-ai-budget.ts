import { type AccessScope, scopedBrokerId } from "./access.js";
import type { Broker } from "./broker.js";
import { chileMonthOf, chileMonthRange } from "./chile-time.js";
import { AppError, isAppError } from "./errors.js";
import { formatUsd, roundUsd } from "./llm-usage.js";
import type { BrokerRepository } from "./ports/broker-repository.js";
import type { PostImageRunRepository } from "./ports/post-image-run-repository.js";

// El gasto de las imágenes con IA (F9.5-T25, ADR-0038 §3): aparte del de texto, con su propio tope
// por marca y por mes (de Chile). El precio por imagen y el tope vienen de la configuración
// (`IMAGE_AI_PRICE_USD`, `IMAGE_AI_MONTHLY_CAP_USD`).

/** El precio y el tope de las imágenes con IA (configuración del servidor). */
export type ImageAiPricing = { priceUsd: number; monthlyCapUsd: number };

/** El mensaje al llegar al tope (spec F9.5-T25). */
export const IMAGE_AI_BUDGET_MESSAGE = "Llegaste al tope de imágenes con IA de este mes";

/**
 * Si otra imagen pasaría el tope: lo gastado más su precio. El tope no se pasa (ADR-0038:
 * «un tope que no se pasa»), así que con un tope de 0 la IA queda apagada.
 */
export const wouldPassImageAiCap = (spentUsd: number, pricing: ImageAiPricing): boolean =>
  roundUsd(spentUsd + pricing.priceUsd) > roundUsd(pricing.monthlyCapUsd);

/** Lo gastado este mes (de Chile) en imágenes con IA por un corredor. */
export async function imageAiSpentThisMonth(
  runs: Pick<PostImageRunRepository, "sumImageCost">,
  brokerId: string,
  now: Date,
): Promise<number> {
  const { from, to } = chileMonthRange(chileMonthOf(now));
  const [row] = await runs.sumImageCost({ from, to, brokerId });
  return roundUsd(row?.costUsd ?? 0);
}

/**
 * El tope del mes (ADR-0038 §3): si otra imagen lo pasaría, `IMAGE_AI_BUDGET_EXCEEDED` (409), con
 * el mensaje simple. Se revisa al pedir la imagen y otra vez en el worker antes de llamar a la IA.
 */
export async function assertImageAiBudget(
  deps: { runs: Pick<PostImageRunRepository, "sumImageCost"> },
  broker: Pick<Broker, "id" | "slug">,
  pricing: ImageAiPricing,
  now: Date,
): Promise<void> {
  const spent = await imageAiSpentThisMonth(deps.runs, broker.id, now);
  if (wouldPassImageAiCap(spent, pricing)) throw imageAiBudgetExceeded(broker.id, spent, pricing);
}

/** `IMAGE_AI_BUDGET_EXCEEDED` (409) con el mensaje simple y lo gastado. */
export const imageAiBudgetExceeded = (
  brokerId: string,
  spentUsd: number | null,
  pricing: ImageAiPricing,
) =>
  new AppError(
    "IMAGE_AI_BUDGET_EXCEEDED",
    `${IMAGE_AI_BUDGET_MESSAGE}${spentUsd === null ? "" : ` (${formatUsd(spentUsd)} de ${formatUsd(pricing.monthlyCapUsd)})`}: vuelve a intentarlo el próximo mes o usa una tarjeta o la biblioteca`,
    { details: { spentUsd, capUsd: pricing.monthlyCapUsd, brokerId } },
  );

/**
 * La marca de un error de la IA que el proveedor dio **sin cobrar** (rechazó el pedido antes de
 * generar: un 429, la clave o un bloqueo de la indicación). Va en `details` del `AppError`.
 */
export const IMAGE_AI_NOT_CHARGED = { charged: false } as const;

/** Si el proveedor dijo que no cobró: la reserva se devuelve. Lo demás se da por cobrado. */
export const imageAiNotCharged = (error: unknown): boolean =>
  isAppError(error) && error.details?.charged === false;

/** El gasto de un corredor en imágenes con IA en un mes. */
export type BrokerMonthlyImageSpend = {
  brokerId: string;
  slug: string;
  spentUsd: number;
  images: number;
  capUsd: number;
  /** Si otra imagen ya no cabe en el tope. */
  capReached: boolean;
};

/**
 * El gasto en imágenes con IA del mes (`"2026-10"`, de Chile) de cada corredor del alcance, también
 * los que no gastaron (`GET /usage`, aparte del de texto). Es una estimación con el precio
 * configurado: manda la consola de Google.
 */
export async function monthlyImageSpend(
  deps: {
    runs: Pick<PostImageRunRepository, "sumImageCost">;
    brokers: Pick<BrokerRepository, "list">;
  },
  input: { month: string; scope: AccessScope; pricing: ImageAiPricing },
): Promise<BrokerMonthlyImageSpend[]> {
  const { from, to } = chileMonthRange(input.month);
  const brokerId = scopedBrokerId(input.scope);
  const rows = await deps.runs.sumImageCost({
    from,
    to,
    ...(brokerId === undefined ? {} : { brokerId }),
  });
  const byBroker = new Map(rows.map((row) => [row.brokerId, row]));
  return (await deps.brokers.list(input.scope)).map((broker) => {
    const spentUsd = roundUsd(byBroker.get(broker.id)?.costUsd ?? 0);
    return {
      brokerId: broker.id,
      slug: broker.slug,
      spentUsd,
      images: byBroker.get(broker.id)?.images ?? 0,
      capUsd: input.pricing.monthlyCapUsd,
      capReached: wouldPassImageAiCap(spentUsd, input.pricing),
    };
  });
}
