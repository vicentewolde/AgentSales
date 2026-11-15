import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";
import { runCardsText, runPostPdf } from "./post-cards.js";

// F9.7 B5 y B7: `agentsales post cards-text` y `post pdf`, contra la API en proceso.

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("post cards-text y pdf", () => {
  it("edita las láminas desde un JSON, las muestra con su revisión, y el PDF sin imágenes avisa", async () => {
    const h = harness();
    const brand = await h.brokers.create(brokerData("agentpey"), { kind: "brand" });
    const post = await h.posts.create({ brokerId: brand.id, topic: "Tema", kind: "carousel" });
    const cwd = await mkdtemp(join(tmpdir(), "agentsales-cli-cards-"));
    dirs.push(cwd);
    const deps = { ...h.io, client: h.client, cwd };
    await writeFile(
      join(cwd, "laminas.json"),
      JSON.stringify([{ headline: "Portada", subtitle: "Sub" }, { headline: "Con 7.777 casos" }]),
    );
    await expect(
      runCardsText(deps, post.id, { language: "es", file: "laminas.json" }),
    ).resolves.toBe(0);
    expect(h.text()).toContain("Portada: Portada — Sub");
    expect(h.text()).toContain("Punto 1: Con 7.777 casos");
    expect(h.text()).toContain("7.777");
    await expect(runCardsText(deps, post.id, { file: "laminas.json" })).resolves.toBe(1);
    await expect(runPostPdf(deps, post.id, {})).resolves.toBe(1);
    expect(h.errors()).toContain("POST_PDF_NO_IMAGES");
  });
});
