import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PageText } from "../diligence/page-text.js";

const run = promisify(execFile);

export async function pdfPages(path: string): Promise<PageText[]> {
  const [raw, layout] = await Promise.all([
    run("pdftotext", [path, "-"], { maxBuffer: 20_000_000 }),
    run("pdftotext", ["-layout", path, "-"], { maxBuffer: 20_000_000 }),
  ]);
  const split = (s: string): string[] =>
    s.split("\f").filter((p, i, a) => !(i === a.length - 1 && p.trim() === ""));
  const r = split(raw.stdout);
  const l = split(layout.stdout);
  return r.map((text, i) => ({ raw: text, layout: l[i] ?? text }));
}

export async function hasPdftotext(): Promise<boolean> {
  try {
    await run("pdftotext", ["-v"]);
    return true;
  } catch (e) {
    return (e as { stderr?: string }).stderr?.includes("pdftotext") === true;
  }
}
