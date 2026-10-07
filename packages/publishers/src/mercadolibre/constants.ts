// Constantes de Mercado Libre (spec F4 §4.2 y §4.8, nota `docs/integraciones/mercadolibre.md`): un
// solo archivo, para revisarlas juntas cuando Mercado Libre cambie algo.

/** Host de la API (nota §4): todas las llamadas, también el canje y el refresco. */
export const MERCADOLIBRE_API_ORIGIN = "https://api.mercadolibre.com";
/**
 * Pantalla de autorización de Chile (nota §3.1: la doc usa `.com.ar` y pide el dominio del país; el
 * host exacto se confirma en la demo).
 */
export const MERCADOLIBRE_AUTHORIZE_URL = "https://auth.mercadolibre.cl/authorization";
/** Canje del código y refresco (nota §3.1 y §3.2): parámetros en el cuerpo, nunca en la URL. */
export const MERCADOLIBRE_TOKEN_PATH = "/oauth/token";

/** Tope de cada llamada en el worker; la API pasa 10 s (spec F4 §4.3 y §4.9). */
export const MERCADOLIBRE_REQUEST_TIMEOUT_MS = 30_000;
