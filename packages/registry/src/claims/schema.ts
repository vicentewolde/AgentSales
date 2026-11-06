import { z } from "zod";

/**
 * Where a statement comes from. Only the first two may ever be stated as fact to an agent.
 *  - visually_verified: a model proposed it AND SAM 3.1 found the object in the claimed time window.
 *  - broker_stated:     the broker said it in a voice note; the transcript quote is the evidence, nothing proves it is true.
 *  - broker_declared:   the broker entered it (price, m2, rooms...); it is on record, not proven by video.
 *  - unverified:        proposed but no evidence found; held back for the broker.
 *  - subjective:        taste words ("bright", "quiet"); never asserted.
 */
export const Provenance = z.enum([
  "visually_verified",
  "broker_stated",
  "broker_declared",
  "unverified",
  "subjective",
]);
export type Provenance = z.infer<typeof Provenance>;

export const ASSERTABLE: ReadonlySet<Provenance> = new Set([
  "visually_verified",
  "broker_stated",
  "broker_declared",
]);

export const Category = z.enum([
  "room",
  "feature",
  "appliance",
  "finish",
  "condition",
  "view",
  "layout",
  "other",
]);

/** What the language model returns for the video: proposals, not facts. */
export const ClaimProposalSchema = z.object({
  id: z.string(),
  category: Category,
  statement: z.string(),
  /** Short noun phrase SAM can look for ("kitchen island"); null when nothing visible proves it. */
  concept: z.string().nullable(),
  t_start: z.number(),
  t_end: z.number(),
  subjective: z.boolean(),
});
export type ClaimProposal = z.infer<typeof ClaimProposalSchema>;

export const ProposalListSchema = z.object({ claims: z.array(ClaimProposalSchema) });

export const EvidenceSchema = z.object({
  kind: z.enum(["visual", "declared", "voice"]),
  frame: z.number().int().nullable(),
  t_sec: z.number().nullable(),
  box: z
    .object({
      x1: z.number(),
      y1: z.number(),
      x2: z.number(),
      y2: z.number(),
      w: z.number(),
      h: z.number(),
    })
    .nullable(),
  confidence: z.number().nullable(),
  concept: z.string().nullable(),
  frames_detected: z.number().int(),
  /** Path of the annotated frame, relative to the listing folder. */
  image: z.string().nullable(),
  /** Voice evidence: the exact words the broker said (Spanish), found verbatim in the transcript. */
  quote: z.string().nullable().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ClaimSchema = z.object({
  id: z.string(),
  category: Category,
  statement: z.string(),
  provenance: Provenance,
  evidence: EvidenceSchema.nullable(),
  /** Why it is held back, when it is. */
  note: z.string().nullable(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const PolicySchema = z.object({
  /** false = the exact address is never given to any agent (Chile: show_exact_address). */
  showExactAddress: z.boolean(),
  priceVisibility: z.enum(["exact", "range", "hidden"]),
  /** Half-width of the range shown when priceVisibility is "range" (0.1 = +-10%). */
  priceRangePct: z.number().min(0).max(0.5),
  visitSlots: z.array(z.string()),
  /** Unidentified agents may read verified facts but cannot request visits. */
  allowAnonymousAgents: z.boolean(),
  maxQuestionsPerHour: z.number().int().positive(),
  /** true = the walkthrough video and its evidence frames may be shown on the public showroom page (default: no). */
  publicMedia: z.boolean().optional(),
});
export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = {
  showExactAddress: false,
  priceVisibility: "range",
  priceRangePct: 0.1,
  visitSlots: [],
  allowAnonymousAgents: true,
  maxQuestionsPerHour: 60,
};

export const DeclaredSchema = z.object({
  title: z.string(),
  operation: z.enum(["sale", "rent"]),
  commune: z.string(),
  address: z.string().nullable(),
  price: z.object({ amount: z.number(), currency: z.enum(["UF", "CLP"]) }),
  area_m2: z.number().nullable(),
  bedrooms: z.number().int().nullable(),
  bathrooms: z.number().int().nullable(),
  pets_allowed: z.boolean().nullable(),
});
export type Declared = z.infer<typeof DeclaredSchema>;

export const ListingSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  declared: DeclaredSchema,
  policy: PolicySchema,
  claims: z.array(ClaimSchema),
});
export type Listing = z.infer<typeof ListingSchema>;
