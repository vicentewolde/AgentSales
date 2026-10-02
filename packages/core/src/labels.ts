import type { ImportRunStatus, ListingStatus, Operation } from "./enums.js";

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
