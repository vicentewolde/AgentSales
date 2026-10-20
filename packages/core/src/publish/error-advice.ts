// La causa legible de una publicación fallida (spec F6 §4.5): para cada código que puede quedar en
// `last_error`, qué hacer en una frase. El mensaje del error dice qué pasó; esto dice qué hacer.
// Lo usan el panel y la CLI bajo el error.

const RECONNECT = "Reconecta la cuenta en Cuentas y reintenta.";
const RETRY_LATER = "Es pasajero: reintenta en unos minutos.";
const FIX_SHEET = "Corrige la planilla, vuelve a cargarla y aprueba el texto de nuevo.";
const ASK_HELP = "Es un error del sistema: reintenta, y si se repite, revisa el log del worker.";

/** Consejos por código. Un código que no está aquí cae en las reglas por sufijo o en el genérico. */
const ADVICE: Readonly<Record<string, string>> = {
  // Cuenta y acceso.
  ACCOUNT_NOT_CONNECTED: RECONNECT,
  IG_AUTH_INVALID: RECONNECT,
  ML_AUTH_INVALID: RECONNECT,
  IG_PERMISSION_DENIED: "Reconecta la cuenta y acepta todos los permisos que pide Instagram.",
  ML_PERMISSION_DENIED:
    "Conecta Mercado Libre con la cuenta titular (no con la de un colaborador) y reintenta.",
  CREDENTIALS_UNREADABLE: RECONNECT,
  CREDENTIALS_INVALID: RECONNECT,
  MERCADOLIBRE_NOT_CONFIGURED: "Falta ML_APP_ID o ML_CLIENT_SECRET en .env: agrégalos y reinicia.",
  ML_APP_CREDENTIALS_INVALID:
    "Mercado Libre no reconoce el par de la app: revisa ML_APP_ID y ML_CLIENT_SECRET en .env.",
  IG_ACCOUNT_RESTRICTED:
    "Revisa la cuenta en la app de Instagram y resuelve lo que pida; luego reintenta.",
  // Límites.
  IG_RATE_LIMITED:
    "Espera lo que dice el mensaje y reintenta (el sistema lo reprograma solo hasta 3 veces).",
  IG_PUBLISH_LIMIT:
    "La cuenta llegó a su máximo diario (el sistema ya esperó 3 veces): reintenta mañana o prográmala.",
  ML_RATE_LIMITED: RETRY_LATER,
  ML_NO_QUOTA: "El paquete de Mercado Libre no tiene cupo: contrata o renueva uno y reintenta.",
  MARKETPLACE_DAILY_LIMIT:
    "Ya se llenaron los formularios de hoy en esta cuenta: reintenta mañana.",
  // Lo aprobado y el aviso.
  CONTENT_NOT_APPROVED: "Aprueba el texto de nuevo o descarta la publicación.",
  CONTENT_HAS_ERRORS: "Quita la aprobación, corrige el texto y apruébalo de nuevo.",
  PUBLICATION_LISTING_CHANGED:
    "La propiedad cambió: descarta la publicación y aprueba el texto de nuevo.",
  PUBLICATION_CONTENT_MISMATCH: "Descarta la publicación y aprueba el texto de nuevo.",
  PUBLICATION_MEDIA_MISSING: "Prepara el contenido de nuevo (faltan fotos) y aprueba otra vez.",
  LISTING_NOT_READY:
    "La propiedad no está lista para publicar: déjala en Lista o Activa y reintenta.",
  LISTING_NOT_FOUND: "La propiedad ya no existe: descarta la publicación.",
  PORTAL_NOT_READY: FIX_SHEET,
  PORTAL_FIELD_MISSING: FIX_SHEET,
  PORTAL_WHATSAPP_MISSING:
    "Completa el WhatsApp en la hoja Corredor de la planilla y vuelve a cargarla.",
  PORTAL_WHATSAPP_INVALID:
    "Corrige el WhatsApp en la hoja Corredor de la planilla y vuelve a cargarla.",
  PORTAL_CATEGORY_NOT_FOUND: "Revisa el tipo y la operación de la propiedad en la planilla.",
  PORTAL_LOCATION_NOT_FOUND: "Revisa la región y la comuna de la propiedad en la planilla.",
  ML_ITEM_REJECTED: "Mercado Libre rechazó el aviso: corrige lo que dice el mensaje y reintenta.",
  IG_MEDIA_REJECTED:
    "Instagram rechazó un medio: revisa lo que dice el mensaje, prepara de nuevo y reintenta.",
  MARKETPLACE_NOT_READY: FIX_SHEET,
  MARKETPLACE_FIELD_MISSING: FIX_SHEET,
  MARKETPLACE_PHOTOS_MISSING: "Prepara el contenido de nuevo (faltan las fotos) y reintenta.",
  MARKETPLACE_CURRENCY_UNSUPPORTED: "Revisa la moneda del precio en la planilla (UF o CLP).",
  PORTAL_PETS_UNDECIDED: "Indica en la planilla si se aceptan mascotas y vuelve a cargarla.",
  PORTAL_TITLE_MISSING: "Prepara el texto de Portal de nuevo y apruébalo.",
  PORTAL_TITLE_TOO_LONG: "Acorta el título de Portal (máx. 60 caracteres) y apruébalo de nuevo.",
  PORTAL_DESCRIPTION_TOO_LONG: "Acorta la descripción de Portal y apruébala de nuevo.",
  PORTAL_PRICE_INVALID: FIX_SHEET,
  PORTAL_CURRENCY_NOT_ALLOWED: FIX_SHEET,
  PORTAL_TYPE_UNSUPPORTED: "Portal no tiene ese tipo de propiedad: revisa el tipo en la planilla.",
  PORTAL_UNIT_NOT_ALLOWED: FIX_SHEET,
  PORTAL_ATTRIBUTE_UNSUPPORTED: FIX_SHEET,
  PORTAL_PICTURES_MISSING: "Prepara el contenido de nuevo (faltan las fotos) y reintenta.",
  PORTAL_PICTURE_NOT_JPEG: "Prepara el contenido de nuevo: una foto no quedó en JPEG.",
  PORTAL_TOO_MANY_PICTURES: "Deja menos fotos en la carpeta de la propiedad y prepara de nuevo.",
  ML_PICTURE_INVALID:
    "Mercado Libre no aceptó una foto: prepara el contenido de nuevo y reintenta.",
  IG_MEDIA_NOT_READY: RETRY_LATER,
  // F9-T19: también para los posts de marca.
  IG_REQUEST_REJECTED:
    "Instagram rechazó la publicación: revisa lo que dice el mensaje (el texto o los medios), corrígelo y reintenta.",
  IG_MEDIA_FETCH_FAILED:
    "Instagram no pudo bajar un medio: reintenta (se mandan enlaces nuevos); si se repite, prepara de nuevo.",
  MARKETPLACE_OPERATION_UNSUPPORTED: "Marketplace solo publica arriendos: descarta la publicación.",
  MARKETPLACE_TYPE_UNSUPPORTED:
    "El formulario de Marketplace no tiene ese tipo de propiedad: descarta la publicación.",
  PUBLISH_INPUT_INVALID: "Corrige lo que dice el mensaje (el texto o los medios) y reintenta.",
  // El modo.
  PUBLISH_MODE_MISMATCH:
    "La publicación y AgentSales (la API o el worker) están en modos distintos, simulación o en vivo: repítelo con AgentSales en el modo de la publicación.",
  PUBLISH_MODE_LOCKED: "Ya empezó en vivo: reintenta en vivo o descártala.",
  // Marketplace.
  MARKETPLACE_SESSION_EXPIRED: "Inicia sesión de nuevo en Facebook desde Cuentas y reintenta.",
  MARKETPLACE_VERIFICATION_REQUIRED:
    "Facebook pidió una verificación: resuélvela iniciando sesión desde Cuentas y reintenta.",
  MARKETPLACE_FORM_CHANGED:
    "El formulario de Facebook cambió: usa el plan B (copiar y pegar) y avisa para ajustar el sistema.",
  MARKETPLACE_UNAVAILABLE:
    "Marketplace no está disponible en la cuenta: revisa su estado en Facebook.",
  MARKETPLACE_FORM_OPEN:
    "Termina o marca la publicación de Marketplace que está esperando y reintenta.",
  MARKETPLACE_PROFILE_BUSY: "Cierra la ventana de Facebook que quedó abierta y reintenta.",
  MARKETPLACE_NOT_PUBLISHED: "Reintenta para abrir el formulario de nuevo, o descártala.",
  MARKETPLACE_BROWSER_NOT_INSTALLED: "Falta el Chromium de Playwright: corre `pnpm -s cli doctor`.",
  UF_SOURCE_NOT_CONFIGURED: "Falta BCCH_API_TOKEN en .env para convertir la UF a pesos.",
  UF_SOURCE_AUTH_INVALID: "El Banco Central no acepta BCCH_API_TOKEN: renuévalo en .env.",
  UF_VALUE_MISSING: "El Banco Central todavía no publica la UF de hoy: reintenta más tarde.",
  UF_VALUE_SUSPICIOUS: "El valor de la UF de hoy se ve raro: reintenta más tarde.",
  // Resultados inciertos.
  IG_PUBLISH_OUTCOME_UNKNOWN:
    "No se sabe si salió: revisa el perfil de Instagram antes de reintentar (podría duplicarse).",
  ML_PUBLISH_OUTCOME_UNKNOWN:
    "No se sabe si se creó el aviso: revisa tus publicaciones en Mercado Libre antes de reintentar.",
  // F9 (ADR-0029 punto 8): el estado `outcome_unknown`; no se reintenta, se resuelve.
  OUTCOME_UNKNOWN:
    "Revisa la cuenta en la red: si salió, márcala como publicada (con el enlace); si no, márcala como no publicada y reintenta.",
  OUTCOME_RESOLVED_NOT_PUBLISHED: "Reintenta para publicarla de nuevo, o descártala.",
  // Una cuenta a mano de otra red (F9-T06, ADR-0029 punto 9).
  MANUAL_NOT_PUBLISHED: "Reintenta para dejar el texto listo de nuevo, o descártala.",
  // El token de X o TikTok al publicar (F9-T06, ADR-0029 punto 11).
  TOKEN_REFRESH_REJECTED: RECONNECT,
  TOKEN_REFRESH_NOT_CONFIGURED:
    "Falta configurar la app de la red en .env para renovar el acceso: agrégala y reinicia.",
  // Conectar una red (F9-T19): falta el par de la app en el .env de la API, o el OAuth volvió mal.
  INSTAGRAM_NOT_CONFIGURED:
    "Falta INSTAGRAM_APP_ID o INSTAGRAM_APP_SECRET en .env: agrégalos y reinicia la API (docs/07-checklist-cuentas.md).",
  LINKEDIN_NOT_CONFIGURED:
    "Falta LINKEDIN_CLIENT_ID o LINKEDIN_CLIENT_SECRET en .env: agrégalos y reinicia la API (docs/integraciones/linkedin.md).",
  X_NOT_CONFIGURED:
    "Falta X_CLIENT_ID o X_CLIENT_SECRET en .env: agrégalos y reinicia la API (docs/integraciones/x.md).",
  TIKTOK_NOT_CONFIGURED:
    "Falta TIKTOK_CLIENT_KEY o TIKTOK_CLIENT_SECRET en .env: agrégalos y reinicia la API (docs/integraciones/tiktok.md).",
  OAUTH_DENIED: "Rechazaste los permisos en la red: vuelve a conectar y acéptalos.",
  OAUTH_STATE_INVALID:
    "El enlace de conexión venció o se abrió en otro navegador: vuelve a conectar desde el principio.",
  OAUTH_CODE_MISSING: "La red no devolvió el código de conexión: vuelve a conectar.",
  // Discord (F9-T14): el webhook es la cuenta; si se borró o cambió, se crea otro y se reconecta.
  DISCORD_WEBHOOK_NOT_FOUND:
    "El webhook ya no existe: crea otro en el canal de Discord y vuelve a conectar con accounts connect discord.",
  DISCORD_WEBHOOK_URL_INVALID:
    "Copia solo la URL del webhook (Copiar URL del webhook) y vuelve a conectar con accounts connect discord.",
  DISCORD_WEBHOOK_INVALID:
    "Discord no acepta el webhook: crea otro en el canal y vuelve a conectar con accounts connect discord.",
  DISCORD_FORBIDDEN:
    "Revisa en Discord que el canal y el webhook sigan activos; si se repite, espera una hora antes de reintentar.",
  DISCORD_RATE_LIMITED:
    "Discord limitó los envíos: el sistema reintenta solo; si no, reintenta en unos minutos.",
  DISCORD_REQUEST_REJECTED: "Corrige lo que dice el mensaje (el texto o los medios) y reintenta.",
  DISCORD_FILE_TOO_LARGE:
    "Un archivo pesa más de lo que acepta Discord: quita el medio o súbelo a mano al canal.",
  DISCORD_MEDIA_UNAVAILABLE: RETRY_LATER,
  DISCORD_UNREACHABLE: RETRY_LATER,
  // X (F9-T16): el saldo, el tope y la marca del enlace son decisiones del operador.
  X_PAYMENT_REQUIRED:
    "Recarga créditos en la consola de X (console.x.com, Billing) o revisa su tope de gasto, y reintenta.",
  X_SPEND_LIMIT_REACHED:
    "Sube el tope de la cuenta con accounts spend-limit <id> <dólares> o espera al mes siguiente, y reintenta.",
  X_LINK_NOT_ALLOWED:
    "Marca el post para permitir el enlace en X (cuesta US$0,20) o quita el enlace del texto, apruébalo y reintenta.",
  X_RATE_LIMITED:
    "X limitó los envíos: el sistema lo reprograma solo hasta 3 veces; si no, reintenta más tarde.",
  X_AUTH_INVALID: RECONNECT,
  X_FORBIDDEN:
    "X no dejó publicar (permisos de la app, el video o la cuenta): revisa lo que dice el mensaje y reintenta.",
  X_REQUEST_REJECTED: "Corrige lo que dice el mensaje (el texto o los medios) y reintenta.",
  X_MEDIA_REJECTED: "X no aceptó un medio: revisa el video o las imágenes del post y reintenta.",
  X_MEDIA_UNAVAILABLE: RETRY_LATER,
  X_UNREACHABLE: RETRY_LATER,
  X_DUPLICATE_CONTENT:
    "X dice que el texto se repite: revisa la cuenta en X; si salió, márcala como publicada con el enlace (publications resolve); si no, cambia un poco el texto y reintenta.",
  X_APP_CREDENTIALS_INVALID:
    "X no reconoce la app: revisa X_CLIENT_ID y X_CLIENT_SECRET en .env y reinicia la API.",
  X_PERMISSION_MISSING:
    "Vuelve a conectar con accounts connect x y acepta todos los permisos (también seguir conectado).",
  X_SPEND_LIMIT_INVALID: "Escribe el tope en dólares, entre 0 y 1.000 (por ejemplo 10 o 2,5).",
  // LinkedIn (F9-T15, `linkedin.md` §7): el token dura 60 días y no se renueva solo.
  LINKEDIN_AUTH_INVALID:
    "El acceso de LinkedIn venció o se revocó: reconecta con accounts connect linkedin y reintenta.",
  LINKEDIN_PERMISSION_DENIED:
    "Reconecta LinkedIn y acepta el permiso para publicar (la app necesita Share on LinkedIn).",
  LINKEDIN_FORBIDDEN:
    "LinkedIn no dejó publicar con esta cuenta: reconéctala; si se repite, publícala a mano.",
  LINKEDIN_RATE_LIMITED:
    "LinkedIn limitó las llamadas del día (se reinician a medianoche UTC): el sistema la reprograma; si no, reintenta mañana.",
  LINKEDIN_REQUEST_REJECTED: "Corrige lo que dice el mensaje (el texto o los medios) y reintenta.",
  LINKEDIN_TEXT_TOO_LONG:
    "Acorta el texto de LinkedIn (máx. 3.000 caracteres) y apruébalo de nuevo.",
  LINKEDIN_MEDIA_REJECTED:
    "LinkedIn rechazó un medio: revisa lo que dice el mensaje, prepara de nuevo y reintenta.",
  LINKEDIN_MEDIA_NOT_READY: RETRY_LATER,
  LINKEDIN_MEDIA_UNAVAILABLE: RETRY_LATER,
  LINKEDIN_VERSION_DEPRECATED:
    "LinkedIn cerró la versión de su API que usa AgentSales: hay que subir LINKEDIN_API_VERSION en el código.",
  LINKEDIN_UNREACHABLE: RETRY_LATER,
  LINKEDIN_CONFLICT: RETRY_LATER,
  LINKEDIN_NOT_FOUND:
    "LinkedIn no encontró el post o el medio: revisa el perfil en LinkedIn; si ya no está, márcala como retirada.",
  LINKEDIN_APP_CREDENTIALS_INVALID:
    "LinkedIn no reconoce la app: revisa LINKEDIN_CLIENT_ID y LINKEDIN_CLIENT_SECRET en .env y reinicia la API.",
  LINKEDIN_DELETE_UNSUPPORTED:
    "Bórrala a mano en LinkedIn y márcala como retirada con publications retire <id> (sin --delete).",
  // TikTok (F9-T26): el video va como borrador a la bandeja; el operador lo publica en la app.
  TIKTOK_AUTH_INVALID: RECONNECT,
  TIKTOK_PERMISSION_DENIED:
    "Reconecta TikTok con accounts connect tiktok y deja marcado el permiso de subir videos.",
  TIKTOK_PENDING_LIMIT:
    "Hay 5 videos esperando en la bandeja de TikTok: publícalos o descártalos en la app. El sistema vuelve a intentar solo hasta 3 veces; después reintenta tú.",
  TIKTOK_POST_LIMIT: "La cuenta llegó a su máximo de publicaciones del día: reintenta mañana.",
  TIKTOK_ACCOUNT_RESTRICTED:
    "TikTok no deja publicar a esta cuenta: revisa sus avisos en la app de TikTok.",
  TIKTOK_APP_RESTRICTED:
    "La app de TikTok todavía no tiene la auditoría para esto: revisa docs/integraciones/tiktok.md (prueba S6).",
  TIKTOK_UPLOAD_FAILED:
    "TikTok no aceptó el video: revisa lo que dice el mensaje, prepara el post de nuevo y reintenta.",
  TIKTOK_STILL_PROCESSING:
    "TikTok sigue procesando el video: el sistema vuelve a mirar solo hasta 3 veces (sin subirlo de nuevo); después reintenta tú.",
  TIKTOK_UPLOAD_REJECTED:
    "TikTok rechazó una parte del video: reintenta (se sube desde el principio); si se repite, prepara el post de nuevo.",
  TIKTOK_UNAVAILABLE: RETRY_LATER,
  TIKTOK_UNREACHABLE: RETRY_LATER,
  TIKTOK_RATE_LIMITED:
    "TikTok limitó las llamadas: el sistema reintenta solo; si no, reintenta en unos minutos.",
  TIKTOK_UNEXPECTED_RESPONSE:
    "TikTok respondió algo inesperado: reintenta, y si se repite, revisa el log del worker.",
  TIKTOK_APP_CREDENTIALS_INVALID:
    "TikTok no reconoce la app: revisa TIKTOK_CLIENT_KEY y TIKTOK_CLIENT_SECRET en .env y reinicia.",
  TIKTOK_REQUEST_REJECTED: "Corrige lo que dice el mensaje (el video) y reintenta.",
  TIKTOK_MEDIA_UNAVAILABLE: RETRY_LATER,
  // Retirar un post (F9-T19).
  RETIRE_DELETE_UNSUPPORTED:
    "Bórrala a mano en la red y márcala como retirada con publications retire <id> (sin --delete).",
  // La vuelta del OAuth con un corredor que no existe o no es del usuario (F9-T19).
  BROKER_NOT_FOUND:
    "El corredor del enlace no existe o no es tuyo: vuelve a conectar desde Cuentas, en el corredor correcto.",
  // Del sistema.
  PUBLISHER_NOT_CONFIGURED: ASK_HELP,
  INTERNAL_ERROR: ASK_HELP,
};

/** El consejo genérico, para un código sin consejo propio. */
export const GENERIC_ERROR_ADVICE =
  "Reintenta; si se repite, descarta la publicación y revisa el motivo.";

/**
 * Qué hacer ante un error de publicación (spec F6 §4.5): el consejo del código; si no tiene, uno
 * por su sufijo (`_UNAVAILABLE`, `_TIMEOUT`, `_ABORTED`: pasajeros); si no, el genérico.
 */
export function publicationErrorAdvice(code: string): string {
  const own = ADVICE[code];
  if (own !== undefined) return own;
  if (/_(UNAVAILABLE|TIMEOUT|ABORTED|UNEXPECTED_RESPONSE)$/.test(code)) return RETRY_LATER;
  return GENERIC_ERROR_ADVICE;
}
