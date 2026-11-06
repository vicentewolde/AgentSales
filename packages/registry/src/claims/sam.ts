/**
 * Minimal parser for the SAM 3.1 text grammar documented at
 * https://dev.meta.ai/docs/sam/reading-segmentation:
 *   <Nf>ID<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..[;c=..]|><|mask;x=0;y=0;data=H,W,<enc>payload|>,ID...
 * Records are delimited by `|>` (the mask header itself contains commas). Frame indexes are
 * zero-based and may skip frames. Mask payloads are kept raw; boxes carry what Aval verifies with.
 */
export interface SamBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Source frame size in pixels. */
  w: number;
  h: number;
}

export interface SamObject {
  id: number;
  box: SamBox;
  confidence: number | null;
  /** The raw `<|mask;...|>` token, so overlays can decode it later with @meta-sam/parser. */
  maskToken: string | null;
}

export interface SamFrame {
  frame: number;
  objects: SamObject[];
}

const FRAME_RE = /^<(\d+)f>/;
const RECORD_RE = /(\d+)<\|box;([\s\S]*?)\|>(<\|mask;[\s\S]*?\|>)?/g;

function fields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of body.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

export function parseSamLine(line: string): SamFrame | null {
  const m = FRAME_RE.exec(line.trim());
  if (!m) return null;
  const frame = Number(m[1]);
  const rest = line.trim().slice(m[0].length);
  const objects: SamObject[] = [];
  for (const rec of rest.matchAll(RECORD_RE)) {
    const f = fields(rec[2] ?? "");
    const num = (k: string): number => Number(f[k]);
    const box: SamBox = {
      x1: num("x1"),
      y1: num("y1"),
      x2: num("x2"),
      y2: num("y2"),
      w: num("w"),
      h: num("h"),
    };
    if (Object.values(box).some((v) => !Number.isFinite(v))) continue;
    const c = f.c !== undefined ? Number(f.c) : NaN;
    objects.push({
      id: Number(rec[1]),
      box,
      confidence: Number.isFinite(c) ? c : null,
      maskToken: rec[3] ?? null,
    });
  }
  return { frame, objects };
}

export function parseSamOutput(text: string): SamFrame[] {
  const frames: SamFrame[] = [];
  for (const line of text.split("\n")) {
    const parsed = parseSamLine(line);
    if (parsed) frames.push(parsed);
  }
  return frames;
}

export function boxAreaRatio(b: SamBox): number {
  return Math.max(0, (b.x2 - b.x1) * (b.y2 - b.y1)) / Math.max(1, b.w * b.h);
}
