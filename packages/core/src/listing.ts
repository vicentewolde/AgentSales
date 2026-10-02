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
};

/**
 * Cambios de estado que el operador hace a mano (panel o CLI; spec F1 §4.4). Solo hacia `ready`,
 * `paused` o `archived`; `ready` además exige al menos una foto (`changeListingStatus`).
 * `active` y `closed` dependen de las publicaciones (F3+): en F1 no se cambian a mano.
 */
export const LISTING_MANUAL_TRANSITIONS: Readonly<Record<ListingStatus, readonly ListingStatus[]>> =
  {
    draft: ["ready", "archived"],
    ready: ["paused", "archived"],
    paused: ["ready", "archived"],
    archived: ["ready"],
    active: [],
    closed: [],
  };

export const canChangeListingStatus = (from: ListingStatus, to: ListingStatus) =>
  LISTING_MANUAL_TRANSITIONS[from].includes(to);
