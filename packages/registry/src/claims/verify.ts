import { boxAreaRatio, type SamFrame } from "./sam.js";
import type { Claim, ClaimProposal, Declared, Evidence } from "./schema.js";

export interface VerifyOptions {
  /** Seconds of slack around the window the model claimed (models are loose with timestamps). */
  windowSlackSec: number;
  /** SAM confidence needed to count a detection. Ignored when SAM sends none. */
  minConfidence: number;
  /** How many sampled frames must show the object. */
  minFrames: number;
  /** Smallest box, as a share of the frame, that counts (avoids specks). */
  minAreaRatio: number;
}

export const DEFAULT_VERIFY: VerifyOptions = {
  windowSlackSec: 1.5,
  minConfidence: 0.5,
  minFrames: 2,
  minAreaRatio: 0.01,
};

export interface Detection {
  frame: number;
  t_sec: number;
  confidence: number | null;
  box: SamFrame["objects"][number]["box"];
}

/** Flattens SAM frames into detections, mapping frame index to seconds with the clip's fps. */
export function toDetections(frames: SamFrame[], fps: number): Detection[] {
  const out: Detection[] = [];
  for (const f of frames) {
    for (const o of f.objects)
      out.push({ frame: f.frame, t_sec: f.frame / fps, confidence: o.confidence, box: o.box });
  }
  return out;
}

/**
 * The rule of the project: no evidence, no claim. Pure and deterministic, so it can be tested
 * without any model. A claim becomes `visually_verified` only if SAM found its concept in enough
 * frames inside the window the model pointed to.
 */
export function verifyProposal(
  p: ClaimProposal,
  detections: Detection[] | null,
  opts: VerifyOptions = DEFAULT_VERIFY,
): Claim {
  const base = { id: p.id, category: p.category, statement: p.statement };
  if (p.subjective) {
    return {
      ...base,
      provenance: "subjective",
      evidence: null,
      note: "Taste word: never stated as fact.",
    };
  }
  if (!p.concept || detections === null) {
    return {
      ...base,
      provenance: "unverified",
      evidence: null,
      note: "Nothing visible to check; the broker must declare it.",
    };
  }
  const lo = p.t_start - opts.windowSlackSec;
  const hi = p.t_end + opts.windowSlackSec;
  const hits = detections.filter(
    (d) =>
      d.t_sec >= lo &&
      d.t_sec <= hi &&
      (d.confidence === null || d.confidence >= opts.minConfidence) &&
      boxAreaRatio(d.box) >= opts.minAreaRatio,
  );
  const frames = new Set(hits.map((h) => h.frame)).size;
  if (frames < opts.minFrames) {
    return {
      ...base,
      provenance: "unverified",
      evidence: null,
      note: `SAM found "${p.concept}" in ${frames} frame(s) inside ${lo.toFixed(1)}-${hi.toFixed(1)}s; ${opts.minFrames} needed.`,
    };
  }
  const best = hits.reduce((a, b) => ((b.confidence ?? 1) > (a.confidence ?? 1) ? b : a));
  const evidence: Evidence = {
    kind: "visual",
    frame: best.frame,
    t_sec: best.t_sec,
    box: best.box,
    confidence: best.confidence,
    concept: p.concept,
    frames_detected: frames,
    image: null,
    quote: null,
  };
  return { ...base, provenance: "visually_verified", evidence, note: null };
}

/** The broker's own entries become claims too, clearly labelled as declared and not as proven. */
export function declaredClaims(d: Declared, brokerId: string, at: string): Claim[] {
  const mk = (id: string, category: Claim["category"], statement: string): Claim => ({
    id,
    category,
    statement,
    provenance: "broker_declared",
    evidence: {
      kind: "declared",
      frame: null,
      t_sec: null,
      box: null,
      confidence: null,
      concept: `declared by ${brokerId} at ${at}`,
      frames_detected: 0,
      image: null,
    },
    note: null,
  });
  const claims: Claim[] = [
    mk("d-operation", "other", d.operation === "sale" ? "For sale" : "For rent"),
    mk("d-commune", "other", `Located in ${d.commune}`),
    mk("d-price", "other", `Price ${d.price.currency} ${d.price.amount}`),
  ];
  if (d.area_m2 !== null) claims.push(mk("d-area", "layout", `${d.area_m2} m2`));
  if (d.bedrooms !== null)
    claims.push(
      mk("d-bedrooms", "layout", `${d.bedrooms} ${d.bedrooms === 1 ? "bedroom" : "bedrooms"}`),
    );
  if (d.bathrooms !== null)
    claims.push(
      mk("d-bathrooms", "layout", `${d.bathrooms} ${d.bathrooms === 1 ? "bathroom" : "bathrooms"}`),
    );
  if (d.pets_allowed !== null)
    claims.push(mk("d-pets", "other", d.pets_allowed ? "Pets allowed" : "Pets not allowed"));
  if (d.address) claims.push(mk("d-address", "other", `Address: ${d.address}`));
  return claims;
}
