import type { AbortSignalLike } from "../abort.js";
import { AppError } from "../errors.js";
import type { PublishListing } from "../ports/publisher.js";
import type { UfValue, UfValueSource } from "../ports/uf-value-source.js";
import { dateIn, MARKETPLACE_TIME_ZONE } from "./limits.js";

/** Cuánto puede moverse la UF de un día al siguiente sin parecer un error de la fuente (spec F5 §4.6). */
export const UF_MAX_DAILY_CHANGE = 0.01;

/** El precio que va al formulario de Marketplace y, si se convirtió, la UF usada. */
export type MarketplacePrice = { priceClp: number; uf: UfValue | null };

/** Un decimal en texto (`41130.94`) como entero escalado: `{ units: 4113094n, scale: 100n }`. */
function scaled(value: string): { units: bigint; scale: bigint } {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) {
    throw new AppError("UF_VALUE_INVALID", "El valor de la UF no tiene la forma esperada");
  }
  const decimals = match[2] ?? "";
  return { units: BigInt(`${match[1]}${decimals}`), scale: 10n ** BigInt(decimals.length) };
}

/**
 * Un monto en UF a pesos con el valor de la UF de un día (spec F5, D9): aritmética entera
 * (`BigInt`), sin flotantes, redondeado al peso (la mitad hacia arriba). El monto en UF trae a lo
 * más 2 decimales (el formato chileno de la planilla).
 */
export function ufToClp(amountUf: number, ufValue: string): number {
  if (!Number.isFinite(amountUf) || amountUf < 0) {
    throw new AppError("PRICE_INVALID", "El precio en UF no es válido");
  }
  const amountCents = BigInt(Math.round(amountUf * 100));
  const uf = scaled(ufValue);
  const divisor = 100n * uf.scale;
  const product = amountCents * uf.units;
  return Number((product * 2n + divisor) / (2n * divisor));
}

/** El día anterior a `AAAA-MM-DD`, en el calendario (sin horas ni zonas). */
function previousDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

/**
 * El precio del formulario de Marketplace (spec F5 §4.6 y D9), lo calcula core antes de llamar al
 * publisher (en los dos modos: es una lectura del Banco Central, no de Facebook):
 * - en `CLP`, el monto tal cual (redondeado al peso);
 * - en `UF`, convertido con el valor oficial **del día de Santiago de `now`**. Pide ayer y hoy: sin
 *   alguno de los dos, `UF_VALUE_MISSING` (no reintentable: el operador reintenta más tarde); si el
 *   de hoy se aleja más de 1 % del de ayer, `UF_VALUE_SUSPICIOUS` (no reintentable). Sin fuente (falta el token),
 *   `UF_SOURCE_NOT_CONFIGURED`. Nunca usa un valor viejo ni uno escrito a mano;
 * - otra moneda, `MARKETPLACE_CURRENCY_UNSUPPORTED`.
 */
export async function marketplacePrice(
  listing: Pick<PublishListing, "priceAmount" | "priceCurrency">,
  { uf, now, signal }: { uf: UfValueSource | null; now: Date; signal?: AbortSignalLike },
): Promise<MarketplacePrice> {
  if (listing.priceCurrency === "CLP") {
    return { priceClp: Math.round(listing.priceAmount), uf: null };
  }
  if (listing.priceCurrency !== "UF") {
    throw new AppError(
      "MARKETPLACE_CURRENCY_UNSUPPORTED",
      "Marketplace solo publica precios en pesos o en UF (que se convierte a pesos)",
      { details: { currency: listing.priceCurrency } },
    );
  }
  if (uf === null) throw ufSourceNotConfigured();
  const today = dateIn(MARKETPLACE_TIME_ZONE, now);
  const yesterday = previousDay(today);
  const values = await uf.valuesBetween(yesterday, today, signal === undefined ? {} : { signal });
  const todays = values.find((item) => item.date === today);
  if (todays === undefined) {
    throw new AppError(
      "UF_VALUE_MISSING",
      "El Banco Central todavía no tiene el valor de la UF de hoy: reintenta más tarde",
      { details: { date: today } },
    );
  }
  // El de ayer es el control de rango: sin él no hay con qué comparar (la UF se publica por
  // adelantado, así que siempre debería estar).
  const yesterdays = values.find((item) => item.date === yesterday);
  if (yesterdays === undefined) {
    throw new AppError(
      "UF_VALUE_MISSING",
      "El Banco Central no trajo el valor de la UF de ayer para comparar: reintenta más tarde",
      { details: { date: yesterday } },
    );
  }
  const change = Math.abs(Number(todays.value) / Number(yesterdays.value) - 1);
  if (!Number.isFinite(change) || change > UF_MAX_DAILY_CHANGE) {
    throw new AppError(
      "UF_VALUE_SUSPICIOUS",
      "El valor de la UF de hoy no calza con el de ayer: no se publica con un precio dudoso",
      { details: { date: today } },
    );
  }
  return {
    priceClp: ufToClp(listing.priceAmount, todays.value),
    uf: { date: todays.date, value: todays.value },
  };
}

/** Sin el token del Banco Central no se puede convertir la UF (spec F5 §4.6). */
export const ufSourceNotConfigured = () =>
  new AppError(
    "UF_SOURCE_NOT_CONFIGURED",
    "Falta BCCH_API_TOKEN en .env: sin el valor de la UF no se puede publicar en Marketplace un precio en UF",
  );
