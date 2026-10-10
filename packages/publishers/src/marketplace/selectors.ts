/**
 * Todo lo que AgentSales sabe de las páginas de Facebook, en un solo lugar (ADR-0004, spec F5 §4.4):
 * direcciones, rutas y textos. Cuando Facebook cambie algo, se toca solo este archivo.
 *
 * **Provisional hasta `pnpm fb:smoke`** (nota `docs/integraciones/fb-marketplace.md` §7 y §12): sin
 * sesión no se ve el formulario, así que las rutas de detención son las que se observaron sin sesión
 * o las que la nota marca NO VERIFICADO, y el formulario se reconoce por su control de fotos. T09
 * completa los controles del formulario con el árbol de accesibilidad real.
 */

/** El origen de Facebook: el único al que va el navegador de Marketplace. */
export const FACEBOOK_ORIGIN = "https://www.facebook.com";

/** La página de inicio: la ventana de conectar la cuenta (spec F5 §4.2). */
export const FACEBOOK_HOME_URL = `${FACEBOOK_ORIGIN}/`;

/**
 * El formulario de "Propiedad en venta o alquiler" (nota §4.1: INFERENCIA; se confirma con
 * `fb:smoke`).
 */
export const MARKETPLACE_FORM_URL = `${FACEBOOK_ORIGIN}/marketplace/create/rental`;

/** Las rutas del flujo de crear un aviso: mientras la pestaña siga aquí, el formulario sigue abierto. */
export const MARKETPLACE_CREATE_PATH = /^\/marketplace\/create(?:\/|$)/;

/** La ruta de un aviso publicado (`/marketplace/item/<id>`; nota §4.2, observado sin sesión). */
export const MARKETPLACE_ITEM_PATH = /^\/marketplace\/item\/(\d{1,30})\/?$/;

/** La cookie con el id de la cuenta (NO VERIFICADO hasta `fb:smoke`): lo único que se lee de las cookies. */
export const SESSION_COOKIE = "c_user";

/** Rutas que piden iniciar sesión (nota §7: observado e INFERENCIA). */
export const LOGIN_PATHS: readonly RegExp[] = [/^\/login(?:\/|\.php|$)/, /^\/r\.php/];

/** Rutas de verificación o checkpoint (nota §7: NO VERIFICADO; pistas de foros). */
export const VERIFICATION_PATHS: readonly RegExp[] = [
  /^\/checkpoint(?:\/|$)/,
  /two_step_verification/,
  /^\/two_factor(?:\/|$)/,
  /^\/recover(?:\/|$)/,
  /^\/confirmemail/,
  /^\/captcha/,
];

/**
 * Textos de una verificación o un captcha, en español y en inglés (el idioma del perfil puede ser
 * otro; nota §7 y §9). Se comparan sin mayúsculas ni tildes.
 */
export const VERIFICATION_TEXTS: readonly string[] = [
  "confirma tu identidad",
  "confirma que eres tu",
  "actividad inusual",
  "actividad sospechosa",
  "no soy un robot",
  "demuestra que no eres un robot",
  "verificacion de seguridad",
  "tu cuenta esta bloqueada",
  "confirm your identity",
  "unusual activity",
  "suspicious activity",
  "i'm not a robot",
  "security check",
  "your account has been locked",
];

/** Textos de Marketplace no disponible o limitado (nota §2 y §7: existen esos estados; el texto, NO VERIFICADO). */
export const UNAVAILABLE_TEXTS: readonly string[] = [
  "marketplace no esta disponible",
  "no tienes acceso a marketplace",
  "tu acceso a marketplace esta limitado",
  "no puedes usar marketplace",
  "marketplace isn't available",
  "marketplace is not available",
  "you can't use marketplace",
  "your access to marketplace is limited",
];

/** Un campo de contraseña: la página pide iniciar sesión aunque la ruta no lo diga. */
export const PASSWORD_INPUT = 'input[type="password"]';

/** Un captcha incrustado (nota §7: NO VERIFICADO). */
export const CAPTCHA_FRAME = 'iframe[src*="captcha" i], iframe[title*="captcha" i]';

/**
 * El formulario de crear un aviso, reconocido por su control de fotos (provisional: T09 lo cambia
 * por el formulario real del árbol de `fb:smoke`). Es también lo que se captura como evidencia.
 */
export const FORM_ROOT = 'form:has(input[type="file"]), [role="main"]:has(input[type="file"])';

/** Cuánto espera la lista blanca a que aparezca el formulario. */
export const FORM_WAIT_MS = 20_000;
