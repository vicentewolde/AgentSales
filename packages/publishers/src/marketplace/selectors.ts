/**
 * Todo lo que AgentSales sabe de las páginas de Facebook, en un solo lugar (ADR-0004, spec F5 §4.4):
 * direcciones, rutas y textos. Cuando Facebook cambie algo, se toca solo este archivo.
 *
 * El formulario y sus controles salen del árbol real de `pnpm fb:smoke --menus` (2026-10-13; nota
 * `docs/integraciones/fb-marketplace.md` §13). Las pantallas de detención (inicio de sesión,
 * verificación, no disponible) siguen siendo las que se observaron sin sesión o las que la nota
 * marca NO VERIFICADO: ninguna se ha visto con sesión.
 */

/** El origen de Facebook: el único al que va el navegador de Marketplace. */
export const FACEBOOK_ORIGIN = "https://www.facebook.com";

/** La página de inicio: la ventana de conectar la cuenta (spec F5 §4.2). */
export const FACEBOOK_HOME_URL = `${FACEBOOK_ORIGIN}/`;

/**
 * El formulario "Nueva vivienda", solo de arriendo (OBSERVADO con sesión el 2026-10-13; nota §13).
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
 * El formulario de crear un aviso, reconocido por su control de fotos dentro de un `form` o del
 * contenedor principal (en el real, `[role="main"]`: el formulario es un `div role="form"`). Es
 * también donde se busca y lo que se captura como evidencia (`formLocator`); el panel del formulario
 * trae el nombre del operador.
 */
export const FORM_ELEMENT = 'form:has(input[type="file"])';
/**
 * Un campo del formulario que no es el de fotos. El formulario real es el contenedor más chico que
 * trae el control de fotos **y** estos campos: el primer `form` con fotos puede ser solo el recuadro
 * de subir fotos (el 2026-10-13 el primer `fb:smoke` guardó un árbol vacío por eso).
 */
export const FORM_FIELD =
  'input:not([type="file"]):not([type="hidden"]), textarea, [role="combobox"]';
export const FORM_CONTAINER = '[role="main"]:has(input[type="file"])';
export const FORM_ROOT = `${FORM_ELEMENT}, ${FORM_CONTAINER}`;

/**
 * Una lista desplegada (las opciones de un menú del formulario, como el tipo de propiedad).
 * Facebook suele dibujarlas fuera del formulario, en una capa aparte; por eso `fb:smoke --menus` las
 * busca en toda la página, pero solo las guarda con un control del formulario desplegado y nunca
 * dentro de `OPEN_LIST_EXCLUDED` (la barra de arriba y los paneles laterales: ahí están los menús de
 * la cuenta, con el nombre del operador). Ver `captureOpenLists`.
 */
export const OPEN_LIST = '[role="listbox"], [role="menu"]';
export const OPEN_LIST_EXCLUDED =
  'header, nav, aside, [role="banner"], [role="navigation"], [role="complementary"]';

/**
 * Los controles del formulario "Nueva vivienda" (`/marketplace/create/rental`, spec F5 §4.4 paso 4;
 * F5-T09), por rol y nombre accesible, tal como los dejó el árbol de `pnpm fb:smoke --menus` el
 * 2026-10-13 (cuenta del operador, Chile, español). Un control obligatorio que no aparece en su
 * tope da `MARKETPLACE_FORM_CHANGED` (con captura del formulario).
 * - `select`: un desplegable (`combobox`) cuyas opciones son `option`, en una lista que Facebook
 *   dibuja aparte ("Seleccionar una opción").
 * - `text`: un `textbox` por su nombre.
 * - `place`: un `combobox` donde se escribe la dirección y se elige una sugerencia del mapa (la
 *   primera, o con las reglas de la comuna si el aviso no tiene dirección; spec F5 D16). Su nombre
 *   cambia («Address» o «Dirección»).
 * `optional`: si el formulario no lo trae, se sigue sin él.
 *
 * Lo que **no** hay: menú de operación (el formulario es solo de arriendo) ni campo de título.
 * Las sugerencias de la dirección viven en una lista aparte («N búsquedas sugeridas»; OBSERVADO en
 * vivo el 2026-10-14).
 */
export type FormControl =
  | { kind: "select"; name: string | RegExp; optional?: boolean }
  | { kind: "text"; name: string | RegExp; optional?: boolean }
  | { kind: "place"; name: string | RegExp; optional?: boolean };

export const FORM_CONTROLS = {
  propertyType: { kind: "select", name: /^tipo de propiedad/i },
  bedrooms: { kind: "text", name: /^n[uú]mero de habitaciones/i },
  bathrooms: { kind: "text", name: /^n[uú]mero de ba[nñ]os/i },
  price: { kind: "text", name: /^precio/i },
  location: { kind: "place", name: /^(address|direcci[oó]n|ubicaci[oó]n)/i },
  description: { kind: "text", name: /^descripci[oó]n/i },
  // Solo pies: si el formulario pidiera metros, el campo no se encuentra y se omite (es opcional),
  // en vez de escribir pies donde van metros.
  area: { kind: "text", name: /^pies cuadrados/i, optional: true },
} as const satisfies Record<string, FormControl>;

/**
 * Nombres de botones que el sistema **nunca** toca (D3): el operador hace Siguiente y Publicar. El
 * llenado revisa el nombre de cada control antes de hacerle clic.
 */
export const NEVER_CLICK = /siguiente|publicar|next|publish|enviar|submit/i;

/** El control de fotos: `setInputFiles` no exige que se vea (nota §1). */
export const PHOTO_INPUT = 'input[type="file"]';

/**
 * El formulario real trae dos controles de archivo (el árbol no muestra su `accept`). Se prefiere el
 * que acepta imágenes y no videos, después el que acepta imágenes, y si ninguno lo declara, el
 * primero. Confirmado en vivo el 2026-10-14: las fotos así adjuntadas llegan a Facebook (adjuntas
 * en memoria, ver `MarketplacePhoto`).
 */
export const PHOTO_INPUTS_BY_PREFERENCE = [
  'input[type="file"][accept*="image" i]:not([accept*="video" i])',
  'input[type="file"][accept*="image" i]',
  PHOTO_INPUT,
] as const;

/** Cuánto espera a ver el contador de fotos antes de rendirse (si no existe, no hay cómo confirmar). */
export const PHOTO_COUNTER_WAIT_MS = 15_000;

/**
 * El contador de fotos del formulario real: «Se han adjuntado 3 fotos» (rol `status`). El llenado
 * espera a que diga las fotos que subió.
 */
export const PHOTO_COUNT_TEXT = /adjuntad[oa]s?\s+(\d+)\s+fotos?/i;

/** Cuánto espera cada control y las fotos. */
export const CONTROL_WAIT_MS = 10_000;
export const PHOTOS_WAIT_MS = 120_000;

/** La pausa fija entre controles (D6): ritmo, no imitación de una persona. */
export const FILL_PAUSE_MS = 1_000;

/** Cuánto espera la lista blanca a que aparezca el formulario. */
export const FORM_WAIT_MS = 20_000;
