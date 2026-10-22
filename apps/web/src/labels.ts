import type {
  ImportRunStatus,
  ListingStatus,
  PlatformAccountStatus,
  PublicationStatus,
} from "@agentsales/core";
import type { BadgeTone } from "./components/ui/styles.js";

// Los textos de estados y operaciones viven en core (los comparte la CLI). Aquí, solo lo propio
// de la interfaz: el tono de cada insignia (F9.5-T01: los colores salen del sistema visual).

/** El tono de la insignia de estado de una propiedad. */
export const LISTING_STATUS_TONE: Readonly<Record<ListingStatus, BadgeTone>> = {
  draft: "neutral",
  ready: "success",
  active: "brand",
  paused: "warning",
  closed: "muted",
  archived: "muted",
};

/** El tono de la insignia de estado de una cuenta conectada. */
export const ACCOUNT_STATUS_TONE: Readonly<Record<PlatformAccountStatus, BadgeTone>> = {
  connected: "success",
  expired: "danger",
  revoked: "muted",
  error: "danger",
};

/** El tono de la insignia de estado de una publicación. */
export const PUBLICATION_STATUS_TONE: Readonly<Record<PublicationStatus, BadgeTone>> = {
  approved: "brand",
  scheduled: "info",
  publishing: "warning",
  awaiting_manual_confirm: "warning",
  published: "success",
  failed: "danger",
  paused: "muted",
  unpublished: "muted",
  cancelled: "muted",
  // F9 (ADR-0029): espera que el operador diga si salió.
  outcome_unknown: "warning",
};

/** El tono de la insignia de estado de una carga. */
export const IMPORT_RUN_STATUS_TONE: Readonly<Record<ImportRunStatus, BadgeTone>> = {
  awaiting_upload: "neutral",
  queued: "warning",
  running: "info",
  succeeded: "success",
  failed: "danger",
};
