import { ApiError } from "../api/client.js";

/**
 * Los errores de la API en simple (F9.5-T20): cada código frecuente que un corredor puede ver, con
 * una frase que dice qué pasó y qué hacer, sin el código técnico. El código no se pierde: va chico
 * al final («código: X») para reportarlo. Los códigos que no están aquí (y los que traen un dato
 * propio, como el tope de IA o la hora fuera de rango) muestran un mensaje general y, debajo, el
 * mensaje de la API sin su código.
 */
export const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  // Cuentas y accesos.
  ACCOUNT_NOT_CONNECTED: "Conecta tu cuenta en Cuentas para poder publicar.",
  ACCOUNT_REFRESH_UNSUPPORTED:
    "Esta red no se renueva desde aquí: reconecta la cuenta en Cuentas cuando venza.",
  IG_AUTH_INVALID: "Instagram no aceptó la conexión: vuelve a conectar la cuenta en Cuentas.",
  IG_PERMISSION_DENIED:
    "Faltan permisos en Instagram: conecta la cuenta de nuevo y acepta todo lo que pide.",
  ML_AUTH_INVALID: "Mercado Libre no aceptó la conexión: vuelve a conectar la cuenta en Cuentas.",
  ML_PERMISSION_DENIED:
    "Mercado Libre no dio los permisos: conecta la cuenta titular (no la de un colaborador).",
  MARKETPLACE_AUTOMATION_NOT_ALLOWED: "Eso no se puede automatizar en Facebook Marketplace.",
  OAUTH_STATE_USED: "Ese intento de conexión ya se usó: empieza la conexión de nuevo.",
  // Usuarios y corredores.
  USER_EMAIL_TAKEN: "Ese correo ya tiene un usuario en AgentSales.",
  USER_SELF_DISABLE: "No puedes desactivar tu propio usuario.",
  INVITATION_CONFLICT: "Se estaba generando otro enlace al mismo tiempo: vuelve a intentarlo.",
  USER_NOT_ADMIN: "Esa acción es solo para el administrador.",
  BROKER_IS_BRAND: "Las marcas no cargan propiedades ni usan la publicación automática de avisos.",
  BROKER_HAS_ACTIVE_PUBLICATIONS:
    "Este corredor tiene publicaciones en curso o programadas: cancélalas primero.",
  PASSWORD_TOO_SHORT: "La contraseña es muy corta: usa al menos 12 caracteres.",
  PASSWORD_TOO_LONG: "La contraseña es muy larga.",
  FORBIDDEN: "No tienes permiso para hacer eso.",
  // Propiedades y textos.
  LISTING_NOT_READY:
    "La propiedad todavía no está lista: termina de prepararla y vuelve a intentar.",
  LISTING_ACTION_NOT_CONFIRMED: "Falta que confirmes la acción sobre la propiedad.",
  LISTING_HAS_LIVE_PUBLICATIONS:
    "La propiedad tiene avisos publicados en vivo: ciérralos antes de archivarla.",
  CONTENT_EDITED: "El texto cambió mientras lo mirabas: recarga la página y vuelve a intentar.",
  CONTENT_NOT_CURRENT: "Ese texto ya no es el vigente: recarga la página.",
  CONTENT_RUN_ACTIVE: "Ya se está preparando el contenido: espera a que termine.",
  CONTENT_LOCKED:
    "El texto aprobado no se puede cambiar mientras tiene publicaciones activas o pendientes.",
  CONTENT_HAS_ERRORS: "El texto tiene errores en la revisión: corrígelos antes de aprobarlo.",
  CONTENT_NOT_READY:
    "Faltan los medios procesados: prepara el contenido o sube las imágenes y espera a que terminen.",
  CONTENT_NOT_APPROVED: "Primero aprueba el texto.",
  CONTENT_NOT_FOR_LISTING: "Ese texto no es de una propiedad.",
  // Publicar y programar.
  PUBLICATION_PENDING: "Hay una publicación pendiente: cancélala o espera a que salga.",
  PUBLICATION_IN_PROGRESS: "Esa publicación ya está en curso.",
  PUBLICATION_CONFLICT:
    "La publicación cambió mientras la tocabas: recarga la página y vuelve a intentar.",
  PUBLICATION_STALE:
    "La publicación cambió mientras se actualizaba: recarga la página y vuelve a intentar.",
  PUBLICATION_LISTING_CHANGED:
    "La propiedad cambió después de aprobar el texto: aprueba el texto de nuevo.",
  NOTHING_TO_PUBLISH: "No hay nada nuevo para publicar.",
  PUBLISH_MODE_LOCKED: "Ya empezó en vivo: reintenta en vivo o descártala.",
  PUBLISH_MODE_MISMATCH:
    "Esta publicación se hizo en simulación y el sistema ahora está en vivo (o al revés): no se cambió nada.",
  OUTCOME_UNKNOWN_PENDING:
    "Hay una publicación que no se sabe si salió: mira la red y marca si salió o no.",
  PORTAL_NOT_READY: "Falta información del aviso para publicar en Portal Inmobiliario.",
  MARKETPLACE_NOT_READY: "Falta información del aviso para publicar en Marketplace.",
  PORTAL_CATEGORY_NOT_FOUND:
    "Portal no tiene ese tipo de propiedad u operación: revísalo en la planilla.",
  PORTAL_LOCATION_NOT_FOUND: "Portal no encuentra la región o la comuna: revísalas en la planilla.",
  PORTAL_NOTHING_TO_UPDATE: "No hay cambios que mandar al aviso.",
  RELIST_NOT_ALLOWED: "Ese aviso no se puede republicar.",
  CLOSE_NOT_CONFIRMED: "La página estaba desactualizada: recárgala y vuelve a cerrar.",
  CLOSE_REASON_REQUIRED: "Indica por qué se cierra: vendida, arrendada o retirada.",
  UPDATE_NOT_CONFIRMED: "Falta confirmar la actualización.",
  RELIST_NOT_CONFIRMED: "Falta confirmar la republicación.",
  DISCONNECT_NOT_CONFIRMED: "Falta confirmar la desconexión.",
  REMOVAL_NOT_CONFIRMED: "Falta confirmar que quieres retirarla.",
  ML_NO_QUOTA:
    "El paquete de Mercado Libre no tiene cupo: contrata o renueva uno y vuelve a intentar.",
  MARKETPLACE_DAILY_LIMIT: "Ya se llenaron los formularios de hoy: sigue mañana.",
  MARKETPLACE_FORM_OPEN:
    "Hay un formulario de Marketplace esperando: di si se publicó o no antes de seguir.",
  MANUAL_CONFIRM_PENDING:
    "Hay una publicación esperando tu confirmación: di si se publicó o no antes de seguir.",
  MARKETPLACE_URL_REQUIRED: "Pega el enlace de la publicación para confirmarla.",
  PUBLISHED_URL_REQUIRED: "Pega el enlace de la publicación para confirmarla.",
  PUBLICATION_ALREADY_CONFIRMED: "Esa publicación ya estaba confirmada con otro enlace.",
  // Posts de marca.
  POST_NOT_READY: "Ese post todavía es una idea o está archivado: acéptalo primero.",
  POST_NOT_IDEA: "Esa idea ya no está pendiente.",
  POST_NO_PLATFORMS:
    "La marca no tiene redes: conecta una cuenta o define la cadencia en su perfil.",
  POST_ARCHIVED: "El post está archivado: ya no se puede cambiar.",
  POST_PLATFORM_EXCLUDED: "Esa red no está entre las del post: agrégala con «Editar el post».",
  PLAN_RUN_CONFLICT: "Ya hay un plan en preparación: espera a que termine.",
  // Conseguir imágenes para un post (F9.5-T25).
  POST_IMAGE_NOT_NEEDED: "Este post es de solo texto: no necesita imágenes.",
  POST_IMAGE_RUN_ACTIVE: "Ya se está consiguiendo una imagen para este post: espera a que termine.",
  POST_IMAGE_NEEDS_TEXT:
    "Para el video de las tarjetas, el post necesita su texto redactado: pide los textos primero.",
  POST_IMAGE_TOO_MANY: "El post ya tiene 20 fotos o videos: quita alguno antes de conseguir más.",
  POST_IMAGE_SOURCE_NOT_CONFIGURED:
    "Esa fuente de imágenes no está configurada en el servidor: usa las tarjetas de la marca.",
  IMAGE_AI_BUDGET_EXCEEDED: "Llegaste al tope de imágenes con IA de este mes.",
  IMAGE_AI_BLOCKED:
    "La IA no hizo la imagen por sus reglas de contenido: cambia la indicación y vuelve a intentar.",
  STOCK_RATE_LIMITED:
    "La biblioteca de fotos recibió demasiadas búsquedas: espera un minuto y vuelve a intentar.",
  STOCK_PHOTO_NOT_FOUND: "Esa foto ya no está en la biblioteca: elige otra.",
  // El sistema. Los de infraestructura y los que traen un dato propio (cuántos archivos faltan, qué
  // otra publicación usa el aviso) no están: se muestran con el mensaje de la API.
  LLM_NOT_CONFIGURED: "La redacción con IA no está configurada.",
  LLM_ACCOUNT_LIMIT: "La cuenta de IA llegó a su límite: vuelve a intentar más tarde.",
  RATE_LIMITED: "Demasiados intentos seguidos: espera un momento.",
  REQUEST_TOO_LARGE: "Lo que enviaste es demasiado grande.",
};

/** El mensaje general de los códigos que no están en el mapa. */
export const GENERIC_ERROR = "No se pudo completar la acción.";

/** Cómo se ve un error: el título, el detalle de la API (si aporta) y el código para reportarlo. */
export type ErrorText = {
  title: string;
  detail: string | null;
  code: string | null;
};

/** Un error con su código, venga de la API (`ApiError`) o guardado (`last_error`, una corrida). */
export type CodedError = { code?: string | null | undefined; message: string };

/** El mensaje sin su código al principio (`CODE: mensaje` → `mensaje`). */
export function messageWithoutCode(error: CodedError): string {
  const { code, message } = error;
  if (code != null && message.startsWith(`${code}: `)) return message.slice(code.length + 2);
  return message;
}

/**
 * El texto de un error con código (F9.5-T20), sin depender de `ApiError`: el del mapa si el
 * código está; si no, un mensaje que no trae el código por delante (uno que armó el panel, o el
 * `last_error` de una publicación) se muestra tal cual, y uno de la API (`CODE: mensaje`) con el
 * mensaje general y su texto debajo. El código va aparte, para mostrarlo chico al final.
 */
export function errorTextOf(error: CodedError): ErrorText {
  const code = error.code ?? null;
  if (code === null) return { title: error.message, detail: null, code: null };
  const mapped = ERROR_MESSAGES[code];
  if (mapped !== undefined) return { title: mapped, detail: null, code };
  if (!error.message.startsWith(`${code}: `)) return { title: error.message, detail: null, code };
  return { title: GENERIC_ERROR, detail: messageWithoutCode(error), code };
}

/** `errorTextOf` en una sola línea de texto: «frase (código: X)», para una lista de notas. */
export function errorLineText(error: CodedError): string {
  const { title, detail, code } = errorTextOf(error);
  const text = detail === null || detail === "" ? title : `${title} ${detail}`;
  return code === null ? text : `${text} (código: ${code})`;
}

/** `errorTextOf` de un error del panel: el código solo si es un `ApiError`. */
export function errorText(error: Error): ErrorText {
  return errorTextOf({
    code: error instanceof ApiError ? error.code : undefined,
    message: error.message,
  });
}
