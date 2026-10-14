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
 * por el formulario real del árbol de `fb:smoke`). Es también lo que se captura como evidencia:
 * primero el `form` (lo más acotado) y, solo si no hay, el contenedor principal, que en Facebook
 * puede traer más (el nombre o la foto del operador).
 */
export const FORM_ELEMENT = 'form:has(input[type="file"])';
/**
 * Un campo del formulario que no es el de fotos. El formulario real es el contenedor más chico que
 * trae el control de fotos **y** estos campos: en Facebook el primer `form` con fotos puede ser solo
 * el recuadro de subir fotos (el 2026-10-13 `fb:smoke` guardó un árbol vacío por eso).
 */
export const FORM_FIELD =
  'input:not([type="file"]):not([type="hidden"]), textarea, [role="combobox"]';
export const FORM_CONTAINER = '[role="main"]:has(input[type="file"])';
export const FORM_ROOT = `${FORM_ELEMENT}, ${FORM_CONTAINER}`;

/**
 * Una lista desplegada (las opciones de un menú del formulario, como operación o tipo de propiedad).
 * Facebook suele dibujarlas fuera del formulario, en una capa aparte; por eso `fb:smoke --menus` las
 * busca en toda la página, pero solo las guarda con un control del formulario desplegado y nunca
 * dentro de `OPEN_LIST_EXCLUDED` (la barra de arriba y los paneles laterales: ahí están los menús de
 * la cuenta, con el nombre del operador). Ver `captureOpenLists`.
 */
export const OPEN_LIST = '[role="listbox"], [role="menu"]';
export const OPEN_LIST_EXCLUDED =
  'header, nav, aside, [role="banner"], [role="navigation"], [role="complementary"]';

/**
 * Los controles del formulario de propiedades (spec F5 §4.4, paso 4; F5-T09), por rol y nombre
 * visible, en español. **POR CONFIRMAR** con los árboles de `pnpm fb:smoke --menus`: hasta entonces
 * son los nombres probables y el PR del lote E no se mezcla. Un control que no aparece en su tope da
 * `MARKETPLACE_FORM_CHANGED` (con captura del formulario).
 * - `select`: un desplegable (`combobox`) cuyas opciones son `option` (pueden dibujarse fuera del
 *   formulario).
 * - `text`: un campo con su etiqueta (`getByLabel`).
 * - `place`: un campo con sugerencias (`combobox` o campo con etiqueta) donde se elige la opción que
 *   nombra la comuna.
 * `optional`: si el formulario no lo trae, se sigue sin él (por ejemplo, los m² en un tipo que no
 * los pide).
 */
export type FormControl =
  | { kind: "select"; name: string | RegExp; optional?: boolean }
  | { kind: "text"; label: string | RegExp; optional?: boolean }
  | { kind: "place"; label: string | RegExp; optional?: boolean };

export const FORM_CONTROLS = {
  operation: { kind: "select", name: /^venta o alquiler/i },
  propertyType: { kind: "select", name: /^tipo de (propiedad|alquiler)/i },
  bedrooms: { kind: "text", label: /^n[uú]mero de (habitaciones|dormitorios)/i },
  bathrooms: { kind: "text", label: /^n[uú]mero de ba[nñ]os/i },
  price: { kind: "text", label: /^precio/i },
  location: { kind: "place", label: /^(direcci[oó]n|ubicaci[oó]n)/i },
  area: { kind: "text", label: /metros cuadrados/i, optional: true },
  title: { kind: "text", label: /^t[ií]tulo/i, optional: true },
  description: { kind: "text", label: /^descripci[oó]n/i },
} as const satisfies Record<string, FormControl>;

/**
 * Nombres de botones que el sistema **nunca** toca (D3): el operador hace Siguiente y Publicar. El
 * llenado revisa el nombre de cada control antes de hacerle clic.
 */
export const NEVER_CLICK = /siguiente|publicar|next|publish|enviar|submit/i;

/** El control de fotos: `setInputFiles` no exige que se vea (nota §1). */
export const PHOTO_INPUT = 'input[type="file"]';

/**
 * Las miniaturas de las fotos ya cargadas (**POR CONFIRMAR** con `fb:smoke --listing`): el llenado
 * espera a ver una por foto.
 */
export const PHOTO_THUMBNAIL = 'img[src^="blob:"], img[src^="data:"]';

/** Cuánto espera cada control y las miniaturas de las fotos. */
export const CONTROL_WAIT_MS = 10_000;
export const PHOTOS_WAIT_MS = 120_000;

/** La pausa fija entre controles (D6): ritmo, no imitación de una persona. */
export const FILL_PAUSE_MS = 1_000;

/** Cuánto espera la lista blanca a que aparezca el formulario. */
export const FORM_WAIT_MS = 20_000;
