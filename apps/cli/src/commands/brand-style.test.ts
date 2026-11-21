import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";
import { runStyleEdit, runStyleFooter, runStylePreview, runStyleShow } from "./brand-style.js";

// F9.7 B4: `agentsales brand style edit|show|preview`, con el estilo de AgentPey del repositorio.

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("brand style", () => {
  it("carga el estilo de AgentPey, lo muestra y guarda una muestra", async () => {
    const h = harness();
    await h.brokers.create({ ...brokerData("agentpey"), brandName: "AgentPey" });
    const cwd = await mkdtemp(join(tmpdir(), "agentsales-cli-style-"));
    dirs.push(cwd);
    const deps = { ...h.io, client: h.client, cwd };
    const file = join(import.meta.dirname, "../../../../docs/marca/agentpey/estilo.json");
    await expect(runStyleEdit(deps, { broker: "agentpey", file })).resolves.toBe(0);
    await expect(runStyleShow(deps, { broker: "agentpey" })).resolves.toBe(0);
    expect(h.text()).toContain("A · Medianoche · B · Verde menta · C · Amarillo · D · Blanco");
    await expect(
      runStylePreview(deps, { broker: "agentpey", theme: "3", out: "muestra.png" }),
    ).resolves.toBe(0);
    const png = await readFile(join(cwd, "muestra.png"));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    await expect(runStylePreview(deps, { broker: "agentpey", theme: "9" })).resolves.toBe(1);
  });

  it("fija el pie de las láminas sin tocar lo demás; «ninguno» quita un dato", async () => {
    const h = harness();
    await h.brokers.create({ ...brokerData("agentpey"), brandName: "AgentPey", website: null });
    const cwd = await mkdtemp(join(tmpdir(), "agentsales-cli-style-"));
    dirs.push(cwd);
    const deps = { ...h.io, client: h.client, cwd };
    await expect(runStyleFooter(deps, { broker: "agentpey", x: "agentpeyai" })).resolves.toBe(1);
    const file = join(import.meta.dirname, "../../../../docs/marca/agentpey/estilo.json");
    await expect(runStyleEdit(deps, { broker: "agentpey", file })).resolves.toBe(0);
    expect(h.text()).toContain("Pie: agentpey.com · Instagram agentpey · X agentpeyai");
    await expect(
      runStyleFooter(deps, { broker: "agentpey", website: "ninguno", x: "@agentpeyx" }),
    ).resolves.toBe(0);
    expect(h.text()).toContain("las próximas láminas llevan Instagram agentpey · X agentpeyx");
    await expect(runStyleFooter(deps, { broker: "agentpey" })).resolves.toBe(1);
    await expect(runStyleFooter(deps, { broker: "agentpey", x: "no vale" })).resolves.toBe(1);
  });
});
