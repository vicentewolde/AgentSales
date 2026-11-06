import { z } from "zod";

/** The four certificates a Chilean sale normally starts with. Each has a closed list of keys. */
export const DOC_TYPES = [
  "certificado_dominio",
  "certificado_gravamenes",
  "certificado_contribuciones",
  "certificado_gastos_comunes",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const KEYS: Record<DocType, readonly string[]> = {
  certificado_dominio: [
    "propietario",
    "rut_propietario",
    "inmueble",
    "rol_avaluo",
    "inscripcion",
    "fecha_emision",
  ],
  certificado_gravamenes: ["gravamen", "sin_gravamenes", "rol_avaluo", "fecha_emision"],
  certificado_contribuciones: ["rol_avaluo", "deuda", "fecha_emision"],
  certificado_gastos_comunes: ["unidad", "deuda", "fecha_emision"],
};

export const TITLE_PATTERN: Record<DocType, RegExp> = {
  certificado_dominio: /certificado de dominio/i,
  certificado_gravamenes: /hipotecas y gravamenes/i,
  certificado_contribuciones: /deuda de contribuciones/i,
  certificado_gastos_comunes: /certificado de gastos comunes/i,
};

export const ExtractionSchema = z.object({
  doc_type: z.enum(DOC_TYPES),
  fields: z.array(
    z.object({
      key: z.string(),
      /** Exactly as written in the document. */
      value: z.string(),
      /** The line or phrase the value was read from, copied verbatim. */
      quote: z.string(),
      page: z.number().int().min(1),
    }),
  ),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export interface SellerIdentity {
  legal_name: string;
  rut: string;
}

export const REQUIRED_DOCS: readonly DocType[] = DOC_TYPES;
