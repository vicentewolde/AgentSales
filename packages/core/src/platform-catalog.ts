import { z } from "zod";
import { PLATFORMS } from "./enums.js";

/**
 * Una entrada del catálogo de una plataforma (`platform_catalog`, ADR-0015, spec F4 §4.4): datos
 * públicos que solo se leen con token y cambian con el tiempo (en Mercado Libre, una categoría con
 * sus hijas y `settings`, los atributos de una hoja o una ubicación de Chile). Se guarda la forma
 * normalizada del cliente, no la respuesta cruda (`data`); una que ya no calce con su esquema se
 * vuelve a bajar. Vencen a los 7 días (`fetchedAt`). Sin secretos ni datos del corredor.
 * Claves: `category:<id>`, `attributes:<hoja>`, `location:<id>`.
 */
export const platformCatalogEntrySchema = z.object({
  platform: z.enum(PLATFORMS),
  // Solo la forma `tipo:id`: el id lo pone la plataforma y puede cambiar de forma.
  key: z.string().regex(/^[a-z_]+:\S+$/),
  data: z.json(),
  fetchedAt: z.date(),
});
export type PlatformCatalogEntry = z.infer<typeof platformCatalogEntrySchema>;
