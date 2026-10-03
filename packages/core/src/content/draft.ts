import { z } from "zod";

/**
 * Topes de largo de cada campo del borrador (en caracteres; los hashtags y advertencias, en
 * elementos). Solo los aplica el esquema estricto: la CLI de Claude no respeta largos en el JSON
 * Schema (spec F2 §4.5). El prompt los pide un poco más cortos.
 */
export const CONTENT_DRAFT_LIMITS = {
  hook: 150,
  body: 1000,
  hashtag: 40,
  hashtags: 10,
  presentation: 700,
  location: 600,
  conditions: 500,
  intro: 400,
  warning: 300,
  warnings: 10,
} as const;

/**
 * La forma del borrador. Con `limits`, cada texto se recorta de espacios y exige su largo (y no
 * vacío donde corresponde); sin ellos, es la forma que se traduce a JSON Schema.
 */
function draftShape(limits: boolean) {
  const text = (max: number) => (limits ? z.string().trim().min(1).max(max) : z.string());
  const optional = (max: number) => (limits ? z.string().trim().max(max) : z.string()).nullable();
  const list = (item: z.ZodString, max: number) =>
    limits ? z.array(item).max(max) : z.array(item);
  return z.strictObject({
    instagram: z.strictObject({
      hook: text(CONTENT_DRAFT_LIMITS.hook),
      body: text(CONTENT_DRAFT_LIMITS.body),
      hashtags: list(
        limits ? z.string().trim().max(CONTENT_DRAFT_LIMITS.hashtag) : z.string(),
        CONTENT_DRAFT_LIMITS.hashtags,
      ),
    }),
    portal_inmobiliario: z.strictObject({
      presentation: text(CONTENT_DRAFT_LIMITS.presentation),
      location: optional(CONTENT_DRAFT_LIMITS.location),
      conditions: optional(CONTENT_DRAFT_LIMITS.conditions),
    }),
    fb_marketplace: z.strictObject({
      intro: text(CONTENT_DRAFT_LIMITS.intro),
    }),
    warnings: list(
      limits ? z.string().trim().max(CONTENT_DRAFT_LIMITS.warning) : z.string(),
      CONTENT_DRAFT_LIMITS.warnings,
    ),
  });
}

/**
 * Lo que devuelve la IA (spec F2 §4.6, ADR-0013): solo frases. Los títulos, el precio, los datos
 * y el contacto los pone el código. Esquema **estricto**, con topes y sin claves de más: con él
 * se valida la respuesta, y lo validado se guarda en `contents.raw_output`.
 */
export const contentDraftSchema = draftShape(true);
export type ContentDraft = z.infer<typeof contentDraftSchema>;

/**
 * JSON Schema (draft-07) que va al proveedor: la misma forma **sin largos ni topes**, que la CLI
 * de Claude no aplica. Lo que importa lo valida `contentDraftSchema` después.
 */
export const CONTENT_DRAFT_JSON_SCHEMA: Record<string, unknown> = z.toJSONSchema(
  draftShape(false),
  { target: "draft-07" },
);

/**
 * Borrador de ejemplo, válido para cualquier aviso: frases sin números, sin amenities y sin
 * superlativos (pasa la revisión editorial, F2-T06). Lo devuelven el proveedor `fake` del worker
 * (`LLM_PROVIDER=fake`, F2-T11) y `eval:content --provider fake` (F2-T16).
 */
export const SAMPLE_CONTENT_DRAFT: ContentDraft = {
  instagram: {
    hook: "Una propiedad para conocer con calma, con toda la información a la vista.",
    body: "En la ficha están las superficies, los espacios y la disponibilidad.\nSi te interesa, coordinemos una visita.",
    hashtags: ["#propiedadesenchile", "#buscocasa"],
  },
  portal_inmobiliario: {
    presentation:
      "Presentamos esta propiedad, con el detalle de sus espacios y condiciones en esta publicación.",
    location: null,
    conditions: null,
  },
  fb_marketplace: {
    intro: "Te comparto esta propiedad con sus datos principales.",
  },
  warnings: [],
};
