import { z } from "zod";
import { LANGUAGES } from "./enums.js";

/**
 * Una línea de contenido del perfil editorial (spec F9 §4.3): "Lo que aprendo construyendo",
 * "Producto"… `weight` reparte las ideas del plan entre las líneas.
 */
export const editorialPillarSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  weight: z.number().nonnegative(),
});
export type EditorialPillar = z.infer<typeof editorialPillarSchema>;

/**
 * El perfil editorial de una marca (`editorial_profiles`, spec F9 §4.3): uno por corredor; lo
 * llena el operador. Es la forma de la fila, con los idiomas validados contra `LANGUAGES` (en la
 * base son texto). Las reglas del perfil (líneas con peso, la cadencia por red y sus horas) llegan
 * con sus casos de uso en F9-T09; hasta entonces `cadence` se guarda tal cual.
 */
export const editorialProfileSchema = z.object({
  brokerId: z.string(),
  /** Los idiomas en que publica la marca, sin repetir; el primero es el principal. */
  languages: z
    .array(z.enum(LANGUAGES))
    .min(1)
    .refine((languages) => new Set(languages).size === languages.length, {
      message: "Un idioma aparece dos veces",
    }),
  /** A quién le habla, en una o dos frases. */
  audience: z.string().nullable(),
  pillars: z.array(editorialPillarSchema),
  /** Los hechos que la IA puede afirmar (ADR-0030): lo que no está aquí no se afirma. */
  facts: z.array(z.string()),
  /** Temas, palabras o promesas que no se usan. */
  avoid: z.array(z.string()),
  /** Posts por semana en cada red, días y horas preferidos y horas entre idiomas (F9-T09). */
  cadence: z.record(z.string(), z.unknown()),
  /** Se suman a `brokers.fixed_hashtags`. */
  defaultHashtags: z.array(z.string()),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type EditorialProfile = z.infer<typeof editorialProfileSchema>;

/** Lo que se guarda de un perfil (todo menos el corredor y las fechas). */
export type EditorialProfileData = Omit<EditorialProfile, "brokerId" | "createdAt" | "updatedAt">;
