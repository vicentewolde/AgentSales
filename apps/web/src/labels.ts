import type { ListingStatus, PlatformAccountStatus, PublicationStatus } from "@agentsales/core";

// Los textos de estados y operaciones viven en core (los comparte la CLI). Aquí, solo lo propio
// de la interfaz: colores y botones.

/** Colores de la etiqueta de estado (Tailwind). */
export const LISTING_STATUS_TONE: Readonly<Record<ListingStatus, string>> = {
  draft: "bg-slate-100 text-slate-700",
  ready: "bg-emerald-100 text-emerald-800",
  active: "bg-sky-100 text-sky-800",
  paused: "bg-amber-100 text-amber-800",
  closed: "bg-slate-200 text-slate-600",
  archived: "bg-slate-200 text-slate-600",
};

/** Colores de la etiqueta de estado de una cuenta conectada. */
export const ACCOUNT_STATUS_TONE: Readonly<Record<PlatformAccountStatus, string>> = {
  connected: "bg-emerald-100 text-emerald-800",
  expired: "bg-red-100 text-red-800",
  revoked: "bg-slate-200 text-slate-600",
  error: "bg-red-100 text-red-800",
};

/** Colores de la etiqueta de estado de una publicación. */
export const PUBLICATION_STATUS_TONE: Readonly<Record<PublicationStatus, string>> = {
  approved: "bg-sky-100 text-sky-800",
  scheduled: "bg-sky-100 text-sky-800",
  publishing: "bg-amber-100 text-amber-800",
  awaiting_manual_confirm: "bg-amber-100 text-amber-800",
  published: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
  paused: "bg-slate-200 text-slate-600",
  unpublished: "bg-slate-200 text-slate-600",
  cancelled: "bg-slate-200 text-slate-600",
};
