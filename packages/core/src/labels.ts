import type { ContentReelOutcome, ContentRun } from "./content.js";
import type {
  ContentRunStage,
  ContentRunStatus,
  ContentStatus,
  ImportRunStatus,
  ListingStatus,
  Operation,
  Platform,
  PlatformAccountStatus,
  PublicationFormat,
  PublicationStatus,
} from "./enums.js";
import type { ImportBrokerOutcome, ImportRowOutcome } from "./import-run.js";
import type { PublicationActor, PublishAttemptResult, RemoteState } from "./publication.js";

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
};

export const CONTENT_RUN_STATUS_TEXT: Readonly<Record<ContentRunStatus, string>> = {
  queued: "en cola",
  running: "preparando",
  succeeded: "lista",
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
};

export const PUBLICATION_FORMAT_TEXT: Readonly<Record<PublicationFormat, string>> = {
  post: "carrusel",
  reel: "reel",
};

/** El modo de un intento de publicación (`publications.dry_run`, D11 del spec F3). */
export const publicationModeText = (dryRun: boolean): string => (dryRun ? "simulación" : "en vivo");

/** El resultado de un intento (`publish_attempt` de la bitácora). */
export const PUBLISH_ATTEMPT_RESULT_TEXT: Readonly<Record<PublishAttemptResult, string>> = {
  published: "publicada",
  retry: "se reintenta",
  failed: "falló",
};

/** Quién hizo un cambio en la bitácora de una publicación. */
export const PUBLICATION_ACTOR_TEXT: Readonly<Record<PublicationActor, string>> = {
  system: "sistema",
  operator: "panel",
  cli: "CLI",
};

/**
 * El comando para conectar Instagram con el token del panel de Meta (D4 del spec F3): lo muestran
 * la CLI y el panel. El slug sale de `slugify` (minúsculas, números y guiones); si alguno trajera
 * otra cosa, va entre comillas simples para la terminal.
 */
export function tokenStdinCommand(slug: string): string {
  const quoted = /^[a-z0-9-]+$/.test(slug) ? slug : `'${slug.replaceAll("'", `'\\''`)}'`;
  return `pbpaste | pnpm -s cli accounts connect instagram --broker ${quoted} --token-stdin`;
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

/** Por qué un aviso no puede publicarse (`LISTING_NOT_READY` al publicar y el panel). */
export const LISTING_NOT_PUBLISHABLE_TEXT =
  "La propiedad tiene que estar lista o publicada para publicar";

/** Por qué un aviso no puede preparar contenido (`LISTING_NOT_READY` y el panel). */
export const LISTING_NOT_PREPARABLE_TEXT =
  "La propiedad tiene que estar lista, pausada o publicada para preparar su contenido";

/**
 * El estado del aviso en la plataforma (`remote_state`, Mercado Libre: `status` y `sub_status`,
 * spec F4 §4.9), como lo ve el operador. Lo que la plataforma informa sin que AgentSales lo haya
 * pedido (en revisión, procesando fotos, vencido) se nombra aparte; un estado desconocido se muestra
 * tal cual, sin adivinar.
 */
export function remoteStatusText(remote: Pick<RemoteState, "status" | "subStatus">): string {
  const sub = new Set(remote.subStatus);
  if (sub.has("picture_download_pending")) {
    return remote.status === "under_review" ? "fotos rechazadas: revísalas" : "procesando fotos";
  }
  switch (remote.status) {
    case "active":
      return "activo";
    case "paused":
      return "pausado";
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
