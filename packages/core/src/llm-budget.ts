import { type AccessScope, scopedBrokerId } from "./access.js";
import type { Broker } from "./broker.js";
import { chileMonthOf, chileMonthRange } from "./chile-time.js";
import { AppError } from "./errors.js";
import { formatUsd, roundUsd } from "./llm-usage.js";
import type { BrokerRepository } from "./ports/broker-repository.js";
import type { ContentRunRepository } from "./ports/content-repository.js";
import type { LLMProvider } from "./ports/llm-provider.js";

// La IA por corredor y su gasto (spec F7 §4.7, seguimiento de ADR-0003).

/**
 * El proveedor de un corredor: uno **propio** del operador (`operatorOwned`) usa el del operador
 * (`LLM_PROVIDER`, su plan); los demás, siempre la API de Anthropic con la clave del operador (los
 * términos del plan no permiten usarlo para terceros). Con `fake` (desarrollo y pruebas), todos.
 * Sin la clave, `LLM_NOT_CONFIGURED` con lo que hay que hacer.
 */
export function llmProviderFor(
  broker: Pick<Broker, "operatorOwned" | "slug">,
  providers: { own: LLMProvider; api: LLMProvider | null },
): LLMProvider {
  if (providers.own.name === "fake" || broker.operatorOwned) return providers.own;
  if (providers.api === null) {
    throw new AppError(
      "LLM_NOT_CONFIGURED",
      `El corredor ${broker.slug} usa la API de Anthropic y falta ANTHROPIC_API_KEY en el .env`,
    );
  }
  return providers.api;
}

/**
 * Los corredores (slug) que usan la API cuando falta la clave (`/health`, spec F7 §4.7): la misma
 * regla de `llmProviderFor`, sin los proveedores armados.
 */
export function brokersNeedingApiKey(
  brokers: readonly Pick<Broker, "operatorOwned" | "slug">[],
  config: { provider: LLMProvider["name"]; hasApiKey: boolean },
): string[] {
  if (config.provider === "fake" || config.hasApiKey) return [];
  return brokers.filter((broker) => !broker.operatorOwned).map((broker) => broker.slug);
}

/**
 * Si lo gastado llegó al tope (D4): la única regla, para frenar la IA (`assertLlmBudget`) y para
 * mostrarlo (`monthlySpend.capReached`). Sin tope, nunca.
 */
export const isOverLlmCap = (spentUsd: number, capUsd: number | null): boolean =>
  capUsd !== null && roundUsd(spentUsd) >= capUsd;

/** Lo gastado este mes (de Chile) por un corredor. */
async function spentThisMonth(
  contentRuns: Pick<ContentRunRepository, "sumLlmCost">,
  brokerId: string,
  now: Date,
): Promise<number> {
  const { from, to } = chileMonthRange(chileMonthOf(now));
  const [row] = await contentRuns.sumLlmCost({ from, to, brokerId });
  return roundUsd(row?.costUsd ?? 0);
}

/**
 * El tope de IA del mes (D4): si el corredor tiene tope y ya lo alcanzó, `LLM_BUDGET_EXCEEDED`
 * (409). Se revisa al pedir la corrida y otra vez antes de cada llamada (otra corrida pudo gastar
 * entre medio). Una sola llamada puede pasarse un poco: su costo se sabe después.
 */
export async function assertLlmBudget(
  deps: { contentRuns: Pick<ContentRunRepository, "sumLlmCost"> },
  broker: Pick<Broker, "id" | "slug" | "llmMonthlyCapUsd">,
  now: Date,
): Promise<void> {
  if (broker.llmMonthlyCapUsd === null) return;
  const spent = await spentThisMonth(deps.contentRuns, broker.id, now);
  if (isOverLlmCap(spent, broker.llmMonthlyCapUsd)) {
    throw new AppError(
      "LLM_BUDGET_EXCEEDED",
      `${broker.slug} llegó a su tope de IA de este mes (${formatUsd(broker.llmMonthlyCapUsd)}): sube el tope o espera al mes siguiente`,
      { details: { spentUsd: spent, capUsd: broker.llmMonthlyCapUsd } },
    );
  }
}

/** El gasto de un corredor en un mes. */
export type BrokerMonthlySpend = {
  brokerId: string;
  slug: string;
  spentUsd: number;
  capUsd: number | null;
  /** Si llegó al tope (`isOverLlmCap`): preparar los textos se frena. */
  capReached: boolean;
  runs: number;
};

/**
 * El gasto de IA del mes (`"2026-10"`, de Chile) de cada corredor del alcance, también los que no
 * gastaron nada (`GET /usage`, spec F7 §4.7). Es una estimación: manda la consola de Anthropic.
 */
export async function monthlySpend(
  deps: {
    contentRuns: Pick<ContentRunRepository, "sumLlmCost">;
    brokers: Pick<BrokerRepository, "list">;
  },
  input: { month: string; scope: AccessScope },
): Promise<BrokerMonthlySpend[]> {
  const { from, to } = chileMonthRange(input.month);
  const brokerId = scopedBrokerId(input.scope);
  const rows = await deps.contentRuns.sumLlmCost({
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
      capUsd: broker.llmMonthlyCapUsd,
      capReached: isOverLlmCap(spentUsd, broker.llmMonthlyCapUsd),
      runs: byBroker.get(broker.id)?.runs ?? 0,
    };
  });
}
