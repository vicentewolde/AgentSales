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
  // Programada: una píldora clara con borde, como una cita en la agenda (F9.5-T26).
  scheduled: "neutral",
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

/**
 * Lo que dice el banner del modo de publicación, en palabras del corredor (F9.5-T02). Desde
 * F9.5-T22 (ADR-0036) el modo es el de la marca elegida; con «Todos», el del servidor y cuántas
 * marcas están en vivo.
 */
export const PUBLISH_MODE_BANNER_TEXT = {
  /** Una marca elegida (o la del corredor) que publica en simulación. */
  brandSimulation: "Simulación: nada se publica en las redes",
  /** Una marca elegida que publica de verdad. */
  brandLive: (brand: string) => `En vivo: lo que publiques en ${brand} sale de verdad`,
  /** «Todos» con el servidor en simulación. */
  "dry-run": "Modo simulación: nada se publica en las redes",
  /** «Todos» con el servidor en vivo y las marcas que publican de verdad. */
  serverLive: (live: readonly string[] | null) =>
    live === null
      ? "El servidor está en vivo: publican de verdad las marcas encendidas"
      : live.length === 0
        ? "El servidor está en vivo, pero ninguna marca está encendida: todo se simula"
        : `El servidor está en vivo: ${live.length === 1 ? "1 marca publica" : `${live.length} marcas publican`} de verdad (${live.join(", ")})`,
  pending: "Consultando el modo…",
  unknown: "No se sabe si está en simulación o en vivo: el sistema no responde",
} as const;
