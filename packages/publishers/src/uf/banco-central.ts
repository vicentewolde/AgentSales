import { type AbortSignalLike, AppError, type UfValue, type UfValueSource } from "@agentsales/core";

/** La API BDE del Banco Central (nota `docs/integraciones/uf.md` §3.2). */
export const BANCO_CENTRAL_API_URL = "https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx";
/** La serie de la UF diaria. */
export const UF_SERIES = "F073.UFF.PRE.Z.D";
/** Tope de cada consulta. */
const DEFAULT_TIMEOUT_MS = 10_000;

export type BancoCentralUfOptions = {
  /** `BCCH_API_TOKEN`: va en la consulta, así que la URL nunca se loguea ni va a un error. */
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const unavailable = (detail: string) =>
  new AppError(
    "UF_VALUE_UNAVAILABLE",
    `El Banco Central no respondió el valor de la UF (${detail})`,
    {
      retriable: true,
    },
  );

const authInvalid = () =>
  new AppError(
    "UF_SOURCE_AUTH_INVALID",
    "El Banco Central rechazó BCCH_API_TOKEN: revisa que esté bien copiado o renuévalo (dura 1 año)",
  );

const unexpected = () =>
  new AppError("UF_UNEXPECTED_RESPONSE", "El Banco Central respondió algo que no se entiende");

/** `DD-MM-AAAA` (como la entrega la API) a `AAAA-MM-DD`; `null` si no calza. */
function isoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  return match === null ? null : `${match[3]}-${match[2]}-${match[1]}`;
}

/** Los días entre dos fechas `AAAA-MM-DD`, incluidos. */
function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  const [y, m, d] = from.split("-").map(Number) as [number, number, number];
  for (let day = new Date(Date.UTC(y, m - 1, d)); ; day = new Date(day.getTime() + 86_400_000)) {
    const iso = day.toISOString().slice(0, 10);
    if (iso > to || days.length > 366) break;
    days.push(iso);
  }
  return days;
}

/**
 * El valor oficial de la UF desde la API BDE del Banco Central (spec F5 §4.6, puerto
 * `UfValueSource`). `GetSeries` de la serie `F073.UFF.PRE.Z.D` entre dos fechas, JSON.
 * - **Guarda en memoria** lo que ya leyó, por fecha: el Banco Central publica cada valor por
 *   adelantado y no lo revisa. No guarda los días sin dato (`NaN`/`ND`) ni los errores.
 * - El valor queda como texto decimal con punto (`41130.94`): nunca un `number`.
 * - Errores (sin la URL, que lleva el token): red, 5xx, 408, 429 o tope → `UF_VALUE_UNAVAILABLE`
 *   (reintentable); 401 o 403, o un `Codigo` que habla del token o el usuario →
 *   `UF_SOURCE_AUTH_INVALID`; otra forma → `UF_UNEXPECTED_RESPONSE`. Otro `Codigo` (sin
 *   resultados) devuelve la lista vacía: core dice `UF_VALUE_MISSING`. La forma exacta de los
 *   errores es NO VERIFICADO hasta `pnpm uf:smoke` (nota §3.4).
 */
export function createBancoCentralUf(options: BancoCentralUfOptions): UfValueSource {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cache = new Map<string, string>();

  return {
    async valuesBetween(from, to, { signal }: { signal?: AbortSignalLike } = {}) {
      const wanted = daysBetween(from, to);
      if (wanted.every((day) => cache.has(day))) {
        return wanted.map((day) => ({ date: day, value: cache.get(day) as string }));
      }
      const url = new URL(BANCO_CENTRAL_API_URL);
      url.searchParams.set("token", options.token);
      url.searchParams.set("function", "GetSeries");
      url.searchParams.set("timeseries", UF_SERIES);
      url.searchParams.set("firstdate", from);
      url.searchParams.set("lastdate", to);
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined =
        signal === undefined ? timeout : AbortSignal.any([timeout, signal as AbortSignal]);
      let response: Response;
      try {
        response = await doFetch(url, { signal: combined, redirect: "error" });
      } catch {
        throw unavailable(timeout.aborted ? "tardó demasiado" : "sin conexión");
      }
      if (response.status === 401 || response.status === 403) throw authInvalid();
      if (response.status >= 500 || response.status === 408 || response.status === 429) {
        throw unavailable(`HTTP ${response.status}`);
      }
      if (!response.ok) throw unexpected();
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw unexpected();
      }
      const values = parseSeries(body);
      for (const value of values) cache.set(value.date, value.value);
      return values.filter((value) => value.date >= from && value.date <= to);
    },
  };
}

/** Las observaciones con valor de una respuesta de `GetSeries`. */
function parseSeries(body: unknown): UfValue[] {
  if (typeof body !== "object" || body === null) throw unexpected();
  const { Codigo, Descripcion, Series } = body as Record<string, unknown>;
  if (Codigo !== 0 && Codigo !== "0") {
    if (
      typeof Descripcion === "string" &&
      /token|usuario|user|clave|password|credencial|auth/i.test(Descripcion)
    ) {
      throw authInvalid();
    }
    return [];
  }
  const observations = (Series as { Obs?: unknown } | undefined)?.Obs;
  if (!Array.isArray(observations)) throw unexpected();
  const values: UfValue[] = [];
  for (const item of observations) {
    if (typeof item !== "object" || item === null) continue;
    const { indexDateString, value, statusCode } = item as Record<string, unknown>;
    const date = isoDate(indexDateString);
    if (date === null || typeof value !== "string") continue;
    if (statusCode !== undefined && statusCode !== "OK") continue;
    if (!/^\d+(\.\d+)?$/.test(value)) continue;
    values.push({ date, value });
  }
  return values;
}
