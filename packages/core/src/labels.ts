import { formatChileTime } from "./chile-time.js";
import type { ContentReelOutcome, ContentRun } from "./content.js";
import type { EditorialWeekday } from "./editorial-profile.js";
import type {
  BrokerKind,
  CloseReason,
  ContentRunStage,
  ContentRunStatus,
  ContentStatus,
  ImportRunStatus,
  Language,
  ListingStatus,
  Operation,
  PlanRunStatus,
  Platform,
  PlatformAccountStatus,
  PostKind,
  PostStatus,
  PublicationFormat,
  PublicationStatus,
} from "./enums.js";
import type { ImportBrokerOutcome, ImportRowOutcome } from "./import-run.js";
import { formatUsd } from "./llm-usage.js";
import type { OnboardingOwner, OnboardingStepKey } from "./onboarding.js";
import type {
  PublicationActor,
  PublicationEventType,
  PublishAttemptResult,
  RemoteState,
  ScheduleReason,
} from "./publication.js";
import type { AgendaKind } from "./tracking/agenda.js";

// Textos para el operador, compartidos por la CLI y el panel (y las plantillas de F2): un solo
// vocabulario. Las clases de color y los textos de botones son de cada interfaz.

export const LISTING_STATUS_TEXT: Readonly<Record<ListingStatus, string>> = {
  draft: "Borrador",
  ready: "Lista",
  active: "Publicada",
  paused: "Pausada",
  closed: "Cerrada",
  archived: "Archivada",
};

export const OPERATION_TEXT: Readonly<Record<Operation, string>> = {
  sale: "Venta",
  rent: "Arriendo",
};

export const IMPORT_RUN_STATUS_TEXT: Readonly<Record<ImportRunStatus, string>> = {
  awaiting_upload: "esperando la subida",
  queued: "en cola",
  running: "procesando",
  succeeded: "terminada",
  failed: "falló",
};

/** Qué pasó con el corredor en una carga (`report.broker.outcome`). */
export const IMPORT_BROKER_OUTCOME_TEXT: Readonly<Record<ImportBrokerOutcome, string>> = {
  created: "creado",
  updated: "actualizado",
  unchanged: "sin cambios",
  existing: "ya existía",
  invalid: "con errores",
};

/** Qué pasó con cada fila de la hoja Propiedades (`report.rows[].outcome`). */
export const IMPORT_ROW_OUTCOME_TEXT: Readonly<Record<ImportRowOutcome, string>> = {
  created: "creada",
  updated: "actualizada",
  skipped: "sin cambios",
  failed: "con error",
  ignored: "ignorada",
};

/** Los canales, como los ve el operador. */
export const PLATFORM_TEXT: Readonly<Record<Platform, string>> = {
  instagram: "Instagram",
  portal_inmobiliario: "Portal Inmobiliario",
  fb_marketplace: "Facebook Marketplace",
  // F9 (ADR-0029): las redes del contenido de marca.
  x: "X",
  linkedin: "LinkedIn",
  discord: "Discord",
  tiktok: "TikTok",
};

/** Los idiomas de un perfil editorial y de un texto (F9). */
export const LANGUAGE_TEXT: Readonly<Record<Language, string>> = {
  es: "español",
  en: "inglés",
};

/** Los días de la cadencia del perfil editorial (F9-T09), abreviados como en Chile. */
export const EDITORIAL_WEEKDAY_TEXT: Readonly<Record<EditorialWeekday, string>> = {
  mon: "lun",
  tue: "mar",
  wed: "mié",
  thu: "jue",
  fri: "vie",
  sat: "sáb",
  sun: "dom",
};

/** Qué es un corredor (`brokers.kind`, F9): lo que muestran la CLI y el panel. */
export const BROKER_KIND_TEXT: Readonly<Record<BrokerKind, string>> = {
  broker: "corredor",
  brand: "marca",
};

export const CONTENT_RUN_STATUS_TEXT: Readonly<Record<ContentRunStatus, string>> = {
  queued: "en cola",
  running: "preparando",
  succeeded: "lista",
  failed: "falló",
};

/** El estado de un plan de ideas en palabras (la CLI y el panel, F9-T21). */
export const PLAN_RUN_STATUS_TEXT: Readonly<Record<PlanRunStatus, string>> = {
  queued: "en cola",
  running: "la IA está proponiendo ideas",
  succeeded: "listo",
  failed: "falló",
};

/** La etapa en curso de una preparación de contenido (spec F2 §4.4). */
export const CONTENT_RUN_STAGE_TEXT: Readonly<Record<ContentRunStage, string>> = {
  media: "procesando fotos y videos",
  renders: "armando la portada y la ficha",
  reel: "armando el reel",
  texts: "redactando los textos",
};

export const CONTENT_STATUS_TEXT: Readonly<Record<ContentStatus, string>> = {
  draft: "borrador",
  edited: "editado a mano",
  approved: "aprobado",
};

/** El estado de un post (spec F9 §4.2), como lo ven la CLI y el panel. */
export const POST_STATUS_TEXT: Readonly<Record<PostStatus, string>> = {
  idea: "idea",
  draft: "borrador",
  ready: "listo",
  archived: "archivado",
};

/** Qué lleva un post (`posts.kind`, F9), como lo ven la CLI y el panel. */
export const POST_KIND_TEXT: Readonly<Record<PostKind, string>> = {
  text: "solo texto",
  image: "imagen",
  carousel: "carrusel",
  video: "video",
};

export const PUBLICATION_STATUS_TEXT: Readonly<Record<PublicationStatus, string>> = {
  approved: "aprobada",
  scheduled: "programada",
  publishing: "publicando",
  awaiting_manual_confirm: "espera tu clic final",
  published: "publicada",
  failed: "falló",
  paused: "pausada",
  unpublished: "retirada",
  cancelled: "descartada",
  outcome_unknown: "no se sabe si salió",
};

/**
 * El nombre de cada formato en Instagram cuando no se sabe cuántos medios lleva: `post` es el
 * carrusel de un aviso. Con el número de medios, `publicationFormatText`.
 */
export const PUBLICATION_FORMAT_TEXT: Readonly<Record<PublicationFormat, string>> = {
  post: "carrusel",
  reel: "reel",
};

/**
 * El formato de una publicación según su canal (spec F4 §4.8 y F9.5 §4.2): en Portal y Marketplace
 * hay uno solo, el aviso (`post`); en Instagram, imagen, carrusel o reel (un `post` con un solo
 * medio sale como imagen suelta); en las redes de F9 (X, LinkedIn, Discord y TikTok), el post.
 * `mediaCount` es el número de medios fijos de la publicación (`mediaIds`); `null` si no se sabe
 * (un formato saltado o un servidor anterior), y entonces el `post` de Instagram es el carrusel.
 * Lo usan la CLI y el panel.
 */
export function publicationFormatText(
  platform: Platform,
  format: PublicationFormat,
  mediaCount: number | null,
): string {
  if (platform === "portal_inmobiliario" || platform === "fb_marketplace") return "aviso";
  if (platform !== "instagram") return "post";
  if (format === "post" && mediaCount === 1) return "imagen";
  return PUBLICATION_FORMAT_TEXT[format];
}

/**
 * El formato con su artículo (F9.5-T02): «la imagen», «de la imagen», «retirada»; «el carrusel»,
 * «del reel», «el aviso», «el post». `o` es la terminación que concuerda («retirad${o}», «otr${o}»).
 * Lo usan las frases del panel y de la CLI que nombran la publicación por su formato.
 */
export type PublicationFormatPhrase = {
  name: string;
  el: "el" | "la";
  del: "del" | "de la";
  o: "o" | "a";
};

export function publicationFormatPhrase(
  platform: Platform,
  format: PublicationFormat,
  mediaCount: number | null,
): PublicationFormatPhrase {
  const name = publicationFormatText(platform, format, mediaCount);
  return name === "imagen"
    ? { name, el: "la", del: "de la", o: "a" }
    : { name, el: "el", del: "del", o: "o" };
}

/**
 * El modo de un intento de publicación (`publications.dry_run`, D11 del spec F3). Qué modo mostrar
 * en el panel según el estado: `shownPublicationMode` (D4 del spec F9.5).
 */
export const publicationModeText = (dryRun: boolean): string => (dryRun ? "simulación" : "en vivo");

/** El resultado de un intento (`publish_attempt` de la bitácora). */
export const PUBLISH_ATTEMPT_RESULT_TEXT: Readonly<Record<PublishAttemptResult, string>> = {
  published: "publicada",
  retry: "se reintenta",
  failed: "falló",
  awaiting_manual_confirm: "formulario listo, espera tu clic final",
  rescheduled: "reprogramada hasta que se libere el límite",
  outcome_unknown: "no se sabe si salió: di si salió o no",
};

/** Quién hizo un cambio en la bitácora de una publicación. */
export const PUBLICATION_ACTOR_TEXT: Readonly<Record<PublicationActor, string>> = {
  system: "sistema",
  operator: "panel",
  cli: "CLI",
};

/**
 * Quién hizo un cambio (spec F7 §4.3): la persona y el canal ("Vinny (panel)"); sin persona (lo del
 * sistema y lo anterior a F7), solo el canal.
 */
export function publicationActorText(actor: PublicationActor, userName: string | null): string {
  return userName === null
    ? PUBLICATION_ACTOR_TEXT[actor]
    : `${userName} (${PUBLICATION_ACTOR_TEXT[actor]})`;
}

/**
 * El slug de un corredor para la terminal: sale de `slugify` (minúsculas, números y guiones); si
 * alguno trajera otra cosa, va entre comillas simples.
 */
const shellSlug = (slug: string) =>
  /^[a-z0-9-]+$/.test(slug) ? slug : `'${slug.replaceAll("'", `'\\''`)}'`;

/**
 * El comando para conectar Instagram con el token del panel de Meta (D4 del spec F3): lo muestran
 * la CLI y el panel.
 */
export function tokenStdinCommand(slug: string): string {
  return `pbpaste | pnpm -s cli accounts connect instagram --broker ${shellSlug(slug)} --token-stdin`;
}

/**
 * Los dos comandos para conectar Mercado Libre sin túnel (spec F4 §4.2 y §4.12): `authorize` imprime
 * y abre el enlace de autorización; `paste` lee la dirección de vuelta copiada de la barra. Los
 * muestran la CLI y el panel (desde F4-T21).
 */
export function mercadoLibreConnectCommands(slug: string): { authorize: string; paste: string } {
  const authorize = `pnpm -s cli accounts connect mercadolibre --broker ${shellSlug(slug)}`;
  return { authorize, paste: `pbpaste | ${authorize} --url-stdin` };
}

/**
 * El comando para conectar (o reconectar) Marketplace (spec F5 §4.2 y §4.12): abre una ventana de
 * Chromium donde el operador inicia sesión a mano. Lo muestran la CLI y el panel.
 */
export function marketplaceConnectCommand(slug: string): string {
  return `pnpm -s cli accounts connect marketplace --broker ${shellSlug(slug)}`;
}

/**
 * Los dos comandos que cierran una publicación de Marketplace que espera el clic final (spec F5
 * §4.3 y §4.12): `confirm` pega el enlace del aviso publicado desde el portapapeles (nunca como
 * argumento) y `notPublished` dice que no se publicó. Los muestran la CLI y el panel.
 */
export function manualConfirmCommands(publicationId: string): {
  confirm: string;
  notPublished: string;
} {
  return {
    confirm: `pbpaste | pnpm -s cli publications confirm ${publicationId} --url-stdin`,
    notPublished: `pnpm -s cli publications not-published ${publicationId}`,
  };
}

/**
 * En qué está el formulario de una publicación de Marketplace que espera el clic final (spec F5
 * §4.12): simulado, con la ventana abierta o con la ventana ya cerrada sin ver el aviso. Sin datos
 * del formulario (`null`), solo pregunta. Lo muestran la CLI y el panel.
 */
export function manualWaitingText(
  manual: { simulated: boolean; windowClosedAt: Date | null; byHand?: boolean } | null,
): string {
  if (manual === null) return "formulario listo: di si lo publicaste";
  // A mano (F7, ADR-0023): no hay formulario ni ventana; el corredor lo publica él mismo.
  if (manual.byHand === true) {
    return manual.simulated
      ? "simulación: publícalo tú con el texto y las fotos listos"
      : "publícalo tú con el texto y las fotos listos, y di si lo publicaste";
  }
  if (manual.simulated) return "simulación: formulario listo sin abrir Facebook";
  if (manual.windowClosedAt !== null) return "la ventana se cerró: ¿lo publicaste?";
  return "formulario listo: revisa la ventana de Chromium y publica";
}

/**
 * Qué pasa al desconectar una cuenta (la pregunta de la CLI y del panel; spec F3 §4.6 y F5 §4.2):
 * en Marketplace se borra el perfil de Chromium con la sesión de Facebook (salvo en producción,
 * donde no hay perfil en el disco).
 */
export function accountDisconnectText(
  platform: Platform,
  marketplaceMode: "profile" | "manual" | null = null,
  /** Si el ambiente permite el formulario automático (en producción no hay perfil que borrar, F8-T20). */
  automation = true,
): string {
  if (platform === "fb_marketplace" && marketplaceMode === "manual") {
    return "Se desactiva Marketplace a mano: sus publicaciones pendientes no saldrán hasta activarlo de nuevo.";
  }
  if (platform === "fb_marketplace" && !automation) {
    return "Se desconecta la cuenta de Facebook (en el servidor no hay un perfil del navegador que borrar): sus publicaciones pendientes no saldrán hasta activar Marketplace a mano.";
  }
  return platform === "fb_marketplace"
    ? "Se borra el perfil de Chromium con la sesión de Facebook: para volver, inicias sesión de nuevo."
    : "Sus publicaciones pendientes no saldrán hasta reconectarla.";
}

/** El estado de una cuenta conectada. */
export const PLATFORM_ACCOUNT_STATUS_TEXT: Readonly<Record<PlatformAccountStatus, string>> = {
  connected: "conectada",
  expired: "vencida",
  revoked: "desconectada",
  error: "con error",
};

/** Qué pasó con el reel en una corrida (`report.reel`). */
export const CONTENT_REEL_OUTCOME_TEXT: Readonly<Record<ContentReelOutcome, string>> = {
  created: "armado",
  existing: "ya estaba (sin cambios)",
  none: "sin video",
  skipped: "no se armó (video muy corto o ilegible)",
};

/** El avance de una preparación: la etapa mientras corre y, si no, su estado. */
export function contentRunProgressText(run: Pick<ContentRun, "status" | "stage">): string {
  return run.status === "running" && run.stage !== null
    ? CONTENT_RUN_STAGE_TEXT[run.stage]
    : CONTENT_RUN_STATUS_TEXT[run.status];
}

/** Lo que muestran la CLI y el panel cuando una corrida sigue en cola a los 20 s (`RUN_WAIT`). */
export const RUN_QUEUED_WARNING_TEXT = "Sigue en cola: ¿está corriendo el worker? (pnpm dev)";
/**
 * El de una publicación (deuda de F3, F6-T11): el worker publica de a una, así que puede estar
 * esperando su turno aunque el worker corra.
 */
export const PUBLICATION_QUEUED_WARNING_TEXT =
  "Sigue en cola o esperando su turno: ¿está corriendo el worker? (pnpm dev)";

/** Por qué un aviso no puede publicarse (`LISTING_NOT_READY` al publicar y el panel). */
export const LISTING_NOT_PUBLISHABLE_TEXT =
  "La propiedad tiene que estar lista o publicada para publicar";

/** Por qué un aviso no puede preparar contenido (`LISTING_NOT_READY` y el panel). */
export const LISTING_NOT_PREPARABLE_TEXT =
  "La propiedad tiene que estar lista, pausada o publicada para preparar su contenido";

/**
 * El estado del aviso en la plataforma (`remote_state`, Mercado Libre: `status` y `sub_status`,
 * y el motivo de una pausa, spec F4 §4.9 y §4.12), como lo ve el operador. Lo que la plataforma
 * informa sin que AgentSales lo haya pedido (en revisión, procesando fotos, vencido, pausado por
 * moderación) se nombra aparte; un estado desconocido se muestra tal cual, sin adivinar.
 */
export function remoteStatusText(
  remote: Pick<RemoteState, "status" | "subStatus" | "reason">,
): string {
  const sub = new Set(remote.subStatus);
  // La doc de Mercado Libre usa las dos grafías (nota §5).
  if (sub.has("picture_download_pending") || sub.has("picture_downloading_pending")) {
    return remote.status === "under_review" ? "fotos rechazadas: revísalas" : "procesando fotos";
  }
  switch (remote.status) {
    case "active":
      return "activo";
    case "paused":
      // Con motivo, la pausó Mercado Libre (moderación); el motivo lo muestra cada interfaz.
      return remote.reason === undefined ? "pausado" : "pausado por Mercado Libre";
    case "closed":
      if (sub.has("expired")) return "vencido";
      if (sub.has("deleted")) return "eliminado";
      return "cerrado";
    case "under_review":
      return "en revisión";
    case "not_yet_active":
      return "por activarse";
    default:
      return `otro estado (${remote.status})`;
  }
}

/** El motivo de cierre de una propiedad (F6, ADR-0019), para la CLI y el panel. */
export const CLOSE_REASON_TEXT: Readonly<Record<CloseReason, string>> = {
  sold: "vendida",
  rented: "arrendada",
  withdrawn: "retirada",
};

/** El título de cada clase de la agenda (spec F6 §4.9), para la CLI y el panel. */
export const AGENDA_KIND_TEXT: Readonly<Record<AgendaKind, string>> = {
  overdue: "Atrasadas",
  your_turn: "Te toca (Marketplace)",
  outcome_unknown: "No se sabe si salieron",
  stuck: "Atascadas",
  failed: "Fallaron",
  manual_task: "Tareas a mano",
  needs_review: "Esperan tu revisión",
  approved_waiting: "Aprobadas sin publicar",
  token_expiring: "Cuentas por reconectar",
  expiring: "Portal por vencer",
  upcoming: "Próximas (7 días)",
  backup: "Respaldo de la base",
};

/** Por qué quedó programada (el `reason` del `status_changed` a `scheduled`, spec F6 §4.2). */
export const SCHEDULE_REASON_TEXT: Readonly<Record<ScheduleReason, string>> = {
  operator: "programada por ti",
  batch: "programada en lote",
  auto_publish: "recordatorio de la publicación automática",
  rate_limit: "espera a que se libere el límite de la plataforma",
};

const chileTimeOf = (iso: unknown): string | null =>
  typeof iso === "string" && !Number.isNaN(Date.parse(iso)) ? formatChileTime(new Date(iso)) : null;

/**
 * Lo que un evento de F6 suma a la bitácora (spec F6 §4.12), igual en la CLI y el panel: en un
 * `status_changed`, la hora programada y su motivo, la hora que tenía al desprogramar, si lo hizo la
 * propiedad y si el disparo no pudo empezarla; un `schedule_changed` (la hora anterior y la nueva)
 * y un `manual_edit` (qué se mandó a Portal); desde F8, un `data_deleted` (Meta pidió borrar los datos).
 * `null` si no hay nada que agregar.
 */
export function publicationEventDetail(event: {
  type: PublicationEventType;
  payload: Record<string, unknown>;
}): string | null {
  const { payload } = event;
  if (event.type === "schedule_changed") {
    const from = chileTimeOf(payload.from);
    const to = chileTimeOf(payload.to);
    return from === null || to === null ? "reprogramada" : `reprogramada: ${from} → ${to}`;
  }
  if (event.type === "data_deleted") {
    return "Meta pidió borrar los datos de la cuenta de Instagram: se borraron el enlace y el id";
  }
  if (event.type === "manual_edit") {
    const fields = Array.isArray(payload.fields) ? payload.fields.join(", ") : "";
    return `actualizada en Portal${fields === "" ? "" : `: ${fields}`}`;
  }
  // Un sync aplicó la pausa justo antes que la propiedad (F8-T12): la marca queda en la lectura.
  if (event.type === "sync") {
    return payload.byListing === true ? "la pausa la pidió la propiedad" : null;
  }
  if (event.type !== "status_changed") return null;
  const parts: string[] = [];
  const at = chileTimeOf(payload.scheduledAt);
  if (at !== null) {
    const reason =
      typeof payload.reason === "string" && payload.reason in SCHEDULE_REASON_TEXT
        ? ` (${SCHEDULE_REASON_TEXT[payload.reason as ScheduleReason]})`
        : "";
    parts.push(`para el ${at}${reason}`);
  }
  const unscheduled = chileTimeOf(payload.unscheduled);
  if (unscheduled !== null) parts.push(`desprogramada (era el ${unscheduled})`);
  if (payload.due === true) {
    parts.push(
      `a la hora no se pudo empezar${typeof payload.code === "string" ? ` (${payload.code})` : ""}`,
    );
  }
  if (payload.byListing === true) parts.push("lo hizo la propiedad");
  return parts.length === 0 ? null : parts.join(" · ");
}

// ── Corredores y usuarios (F7) ────────────────────────────────────────────

/** El nombre de cada paso de la lista de alta (CLI y panel). */
export const ONBOARDING_STEP_TEXT: Readonly<Record<OnboardingStepKey, string>> = {
  brand: "Marca y colores",
  logo: "Logo",
  whatsapp: "WhatsApp",
  editorial: "Perfil editorial",
  user: "Usuario con contraseña",
  instagram: "Instagram",
  mercadolibre: "Mercado Libre",
  marketplace: "Marketplace",
  networks: "Una red para los posts",
};

/**
 * El nombre de un paso de la lista de alta; un paso sin texto sale con su clave. No protege de una
 * CLI o un panel más viejo que la API: el contrato valida la clave con un enum cerrado y rechaza un
 * paso nuevo antes de llegar aquí (la CLI y el panel van con la misma versión que la API).
 */
export function onboardingStepText(key: string): string {
  return (ONBOARDING_STEP_TEXT as Readonly<Partial<Record<string, string>>>)[key] ?? key;
}

/** Quién hace un paso que falta, en un corredor. En una marca, `onboardingOwnerText`. */
export const ONBOARDING_OWNER_TEXT: Readonly<Record<OnboardingOwner, string>> = {
  broker: "lo hace el corredor",
  admin: "lo hace el administrador",
};

/** Quién hace un paso que falta, según qué es: en una marca, "lo hace la marca". */
export function onboardingOwnerText(owner: OnboardingOwner, kind: BrokerKind): string {
  return owner === "broker" && kind === "brand" ? "lo hace la marca" : ONBOARDING_OWNER_TEXT[owner];
}

/** El estado de un usuario, en pocas palabras (CLI y panel). */
export function userStateText(user: {
  disabled: boolean;
  locked: boolean;
  hasPassword: boolean;
}): string {
  if (user.disabled) return "desactivado";
  if (user.locked) return "bloqueado por intentos fallidos";
  if (!user.hasPassword) return "todavía sin contraseña";
  return "activo";
}

/** El gasto de IA del mes de un corredor con su tope: `US$ 0,70 de US$ 0,50` o `(sin tope)`. */
export function llmSpendText(row: { spentUsd: number; capUsd: number | null }): string {
  return `${formatUsd(row.spentUsd)}${row.capUsd === null ? " (sin tope)" : ` de ${formatUsd(row.capUsd)}`}`;
}
