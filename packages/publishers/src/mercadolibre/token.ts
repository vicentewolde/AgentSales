import {
  type AbortSignalLike,
  type AccessTokenProvider,
  AppError,
  isAppError,
  isMercadoLibreTokenRejected,
  MERCADOLIBRE_REJECTED_AFTER_REFRESH,
} from "@agentsales/core";

/** Con qué se llama a Mercado Libre: el proveedor de token (core) y la señal. */
export type MercadoLibreTokenContext = {
  accessToken: AccessTokenProvider;
  signal?: AbortSignalLike;
};

/**
 * Un 401 que se repite con el token nuevo: se marca para que nadie más arriba vuelva a refrescar
 * (`isMercadoLibreTokenRejected` ya no lo reconoce) y quien lo recibe decida (spec F4 §4.3,
 * seguimiento de F4-T03 en ADR-0015): el intento y las operaciones dejan la cuenta `expired`;
 * `ml:smoke`, no.
 */
const rejectedAfterRefresh = (error: unknown) =>
  isAppError(error)
    ? new AppError(error.code, error.message, {
        retriable: false,
        details: { ...error.details, reason: MERCADOLIBRE_REJECTED_AFTER_REFRESH },
        cause: error,
      })
    : error;

/**
 * Una llamada con el token del proveedor; después de un 401 (`isMercadoLibreTokenRejected`), una
 * vez más con uno nuevo, pidiéndolo con el rechazado (`rejectedToken`: solo se refresca si el
 * guardado sigue siendo ese). Un segundo 401 sube marcado (`rejected_after_refresh`). La usan el
 * catálogo (F4-T09) y `ml:smoke` (F4-T10).
 */
export async function withMercadoLibreToken<T>(
  ctx: MercadoLibreTokenContext,
  call: (token: string, signal: AbortSignalLike | undefined) => Promise<T>,
): Promise<T> {
  const signal = ctx.signal;
  const withSignal = signal === undefined ? {} : { signal };
  const token = await ctx.accessToken(withSignal);
  try {
    return await call(token, signal);
  } catch (error) {
    if (!isMercadoLibreTokenRejected(error)) throw error;
  }
  const fresh = await ctx.accessToken({ ...withSignal, rejectedToken: token });
  try {
    return await call(fresh, signal);
  } catch (error) {
    throw isMercadoLibreTokenRejected(error) ? rejectedAfterRefresh(error) : error;
  }
}

/** ¿Es el 401 que se repitió después de refrescar (`withMercadoLibreToken`)? */
export const isRejectedAfterRefresh = (error: unknown): boolean =>
  isAppError(error) &&
  error.code === "ML_AUTH_INVALID" &&
  error.details?.reason === MERCADOLIBRE_REJECTED_AFTER_REFRESH;
