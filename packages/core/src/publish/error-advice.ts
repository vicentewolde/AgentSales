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
  IG_PUBLISH_LIMIT: "La cuenta llegó a su máximo diario: reintenta mañana o prográmala.",
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
  MARKETPLACE_OPERATION_UNSUPPORTED: "Marketplace solo publica arriendos: descarta la publicación.",
  MARKETPLACE_TYPE_UNSUPPORTED:
    "El formulario de Marketplace no tiene ese tipo de propiedad: descarta la publicación.",
  PUBLISH_INPUT_INVALID: "Corrige lo que dice el mensaje (el texto o los medios) y reintenta.",
  // El modo.
  PUBLISH_MODE_MISMATCH:
    "La publicación y el worker no están en el mismo modo: reintenta en el modo correcto.",
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
