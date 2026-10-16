import { z } from "zod";
import {
  CLOSE_REASONS,
  CURRENCIES,
  LISTING_CATEGORIES,
  LISTING_SOURCES,
  LISTING_STATUSES,
  type ListingStatus,
  OPERATIONS,
  type Operation,
} from "./enums.js";

/**
 * Aviso (`listings`): la entidad que devuelven `ListingRepository.list` y `get`, y que la API
 * entrega al panel y a la CLI (ADR-0011). `internalNotes` va al operador, nunca a la IA ni a las
 * plataformas. `attributes` son los campos configurables ya normalizados (ADR-0006).
 */
export const listingSchema = z.object({
  id: z.string(),
  brokerId: z.string(),
  externalRef: z.string(),
  category: z.enum(LISTING_CATEGORIES),
  status: z.enum(LISTING_STATUSES),
  closeReason: z.enum(CLOSE_REASONS).nullable(),
  operation: z.enum(OPERATIONS).nullable(),
  propertyType: z.string().nullable(),
  region: z.string().nullable(),
  comuna: z.string().nullable(),
  address: z.string().nullable(),
  unitNumber: z.string().nullable(),
  showExactAddress: z.boolean(),
  priceAmount: z.number(),
  priceCurrency: z.enum(CURRENCIES),
  highlights: z.string().nullable(),
  internalNotes: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()),
  source: z.enum(LISTING_SOURCES),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Listing = z.infer<typeof listingSchema>;

/** Filtros de `ListingRepository.list` (y de `GET /listings`). */
export type ListingFilters = {
  status?: ListingStatus;
  operation?: Operation;
  comuna?: string;
  /** `id_propiedad` exacto: es único por corredor, así que puede devolver más de un aviso. */
  externalRef?: string;
};

/**
 * Lo que el operador hace con una propiedad (panel o CLI; ADR-0019, spec F6 §4.8): dejarla lista,
 * pausarla, reanudarla, cerrarla (vendida, arrendada o retirada), reabrirla y archivarla. Cada
 * acción orquesta sus publicaciones (`changeListingStatus`).
 */
export const LISTING_ACTIONS = ["ready", "pause", "resume", "close", "reopen", "archive"] as const;
export type ListingAction = (typeof LISTING_ACTIONS)[number];

/** Desde qué estados se puede hacer cada acción (spec F6 §4.8). */
export const LISTING_ACTION_FROM: Readonly<Record<ListingAction, readonly ListingStatus[]>> = {
  ready: ["draft"],
  pause: ["ready", "active"],
  resume: ["paused"],
  close: ["ready", "active", "paused"],
  reopen: ["closed", "archived"],
  archive: ["draft", "ready", "paused", "closed"],
};

/**
 * Los cambios de estado a mano que admiten las acciones (desde F6, ADR-0019): reanudar y reabrir
 * dejan la propiedad en `active` si le queda algo publicado en vivo, y si no en `ready`. El sistema
 * sigue moviendo `ready ↔ active` al publicar y al retirar.
 */
export const LISTING_MANUAL_TRANSITIONS: Readonly<Record<ListingStatus, readonly ListingStatus[]>> =
  {
    draft: ["ready", "archived"],
    ready: ["paused", "closed", "archived"],
    active: ["paused", "closed"],
    paused: ["ready", "active", "closed", "archived"],
    closed: ["ready", "active", "archived"],
    archived: ["ready", "active"],
  };

/**
 * Los destinos que acepta la ruta vieja `PATCH /listings/:id/status` (spec F1 §4.4), que el panel
 * usa hasta F6-T10: cada uno se traduce a su acción (`listingActionFor`). Se quita con la ruta.
 */
export const LISTING_MANUAL_TARGETS = [
  "ready",
  "paused",
  "archived",
] as const satisfies readonly ListingStatus[];

/**
 * La acción que corresponde a un destino de la ruta vieja (spec F6 §4.8, hasta T10): `ready` desde
 * `draft` es dejarla lista, desde `paused` es reanudar y desde `closed` o `archived` es reabrir;
 * `paused` es pausar y `archived` es archivar. `null` si no hay una.
 */
export function listingActionFor(
  from: ListingStatus,
  to: (typeof LISTING_MANUAL_TARGETS)[number],
): ListingAction | null {
  if (to === "paused") return "pause";
  if (to === "archived") return "archive";
  if (from === "draft") return "ready";
  if (from === "paused") return "resume";
  if (from === "closed" || from === "archived") return "reopen";
  return null;
}

export const canChangeListingStatus = (from: ListingStatus, to: ListingStatus) =>
  LISTING_MANUAL_TRANSITIONS[from].includes(to);

/** Si la acción se puede hacer desde el estado de la propiedad. */
export const canDoListingAction = (action: ListingAction, from: ListingStatus) =>
  LISTING_ACTION_FROM[action].includes(from);

/**
 * Estados en que un aviso puede preparar contenido (spec F2 §4.4). Lo revisan `requestContentRun`
 * y el panel (para desactivar el botón), con el mismo texto.
 */
export const PREPARABLE_LISTING_STATUSES: readonly ListingStatus[] = ["ready", "paused", "active"];

export const canPrepareContent = (status: ListingStatus): boolean =>
  PREPARABLE_LISTING_STATUSES.includes(status);

/**
 * Estados en que un aviso puede publicarse (spec F3 §4.3): listo o ya publicado. Lo revisan
 * `requirePublishableListing` y el panel (para desactivar Publicar), con el mismo texto.
 */
export const PUBLISHABLE_LISTING_STATUSES: readonly ListingStatus[] = ["ready", "active"];

export const canPublishListing = (status: ListingStatus): boolean =>
  PUBLISHABLE_LISTING_STATUSES.includes(status);
