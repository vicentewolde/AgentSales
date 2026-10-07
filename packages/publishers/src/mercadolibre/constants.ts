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

/** Tope de cada llamada en el worker (por defecto del cliente). */
export const MERCADOLIBRE_REQUEST_TIMEOUT_MS = 30_000;
/** Tope de cada llamada cuando la hace la API, que responde mientras el operador espera (§4.9). */
export const MERCADOLIBRE_API_TIMEOUT_MS = 10_000;
/**
 * Tope del refresco, aunque el cliente tenga uno mayor: corre dentro del candado de la cuenta, y
 * quien espera ese candado se rinde a los 10 s (ADR-0015, spec F4 §4.3).
 */
export const MERCADOLIBRE_REFRESH_TIMEOUT_MS = 10_000;

/** `expires_in` aceptable del `access_token` (la doc dice horas): más de un año es un error. */
export const MERCADOLIBRE_MAX_EXPIRES_IN_S = 365 * 24 * 60 * 60;
/**
 * Vencimiento que se supone si un refresco no trae un `expires_in` válido: el par ya rotó y no se
 * descarta por eso, pero el `access_token` se renueva pronto (spec F4 §4.3).
 */
export const MERCADOLIBRE_FALLBACK_EXPIRES_IN_S = 60 * 60;

/** Inmuebles en Mercado Libre Chile: la raíz desde la que el catálogo baja por nombres (nota §4.6). */
export const MERCADOLIBRE_REAL_ESTATE_CATEGORY_ID = "MLC1459";
/** Chile en `classified_locations` (nota §4.7): trae los estados (regiones). */
export const MERCADOLIBRE_COUNTRY_ID = "CL";
