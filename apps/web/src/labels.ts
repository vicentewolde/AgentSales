import type { ListingStatus, Operation } from "@agentsales/core";

export const LISTING_STATUS_TEXT: Readonly<Record<ListingStatus, string>> = {
  draft: "Borrador",
  ready: "Lista",
  active: "Publicada",
  paused: "Pausada",
  closed: "Cerrada",
  archived: "Archivada",
};

/** Colores de la etiqueta de estado (Tailwind). */
export const LISTING_STATUS_TONE: Readonly<Record<ListingStatus, string>> = {
  draft: "bg-slate-100 text-slate-700",
  ready: "bg-emerald-100 text-emerald-800",
  active: "bg-sky-100 text-sky-800",
  paused: "bg-amber-100 text-amber-800",
  closed: "bg-slate-200 text-slate-600",
  archived: "bg-slate-200 text-slate-600",
};

export const OPERATION_TEXT: Readonly<Record<Operation, string>> = {
  sale: "Venta",
  rent: "Arriendo",
};

/** Botón de cada cambio manual de estado (`LISTING_MANUAL_TARGETS`). */
export const STATUS_ACTION_TEXT = {
  ready: "Marcar como lista",
  paused: "Pausar",
  archived: "Archivar",
} as const;
