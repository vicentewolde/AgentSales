import type { HealthReport } from "@agentsales/api";
import { describe, expect, it } from "vitest";
import { createColors } from "./colors.js";
import { renderPublishMode, runStatus } from "./status.js";

const c = createColors(true);
const plain = createColors(false);

const report = (overrides: Partial<HealthReport> = {}): HealthReport => ({
  status: "ok",
  publishMode: "dry-run",
  version: "0.0.1",
  checks: {
    db: { ok: true, latencyMs: 60 },
    storage: { ok: true, latencyMs: 200 },
    queue: { ok: true, latencyMs: 65 },
  },
  ...overrides,
});

describe("renderPublishMode", () => {
  it("live se muestra en rojo", () => {
    const text = renderPublishMode("live", c);

    expect(text).toContain(c.bgRed(c.white(" PUBLISH_MODE: LIVE — las publicaciones son reales ")));
  });

  it("dry-run se muestra en verde", () => {
    expect(renderPublishMode("dry-run", c)).toContain(
      c.green("PUBLISH_MODE: dry-run (no se publica nada)"),
    );
  });
});

describe("runStatus", () => {
  it("con todo ok sale con 0 y lista los checks con su latencia", async () => {
    const result = await runStatus(async () => report(), plain);

    expect(result.exitCode).toBe(0);
    expect(result.text).toContain("Estado: ok");
    expect(result.text).toContain("✓ db       60 ms");
  });

  it("con live destaca PUBLISH_MODE en rojo", async () => {
    const result = await runStatus(async () => report({ publishMode: "live" }), c);

    expect(result.text.split("\n")[0]).toBe(renderPublishMode("live", c));
    expect(result.text).toContain("\u001b[41m");
  });

  it("degraded sale con 1 y muestra el error del check", async () => {
    const result = await runStatus(
      async () =>
        report({
          status: "degraded",
          checks: {
            db: { ok: true, latencyMs: 60 },
            storage: { ok: false, latencyMs: 12, error: "R2 no respondió" },
            queue: { ok: true, latencyMs: 65 },
          },
        }),
      plain,
    );

    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("Estado: degraded");
    expect(result.text).toContain("✗ storage  R2 no respondió");
  });

  it("si la API no responde sale con 1 y sugiere pnpm dev", async () => {
    const result = await runStatus(async () => {
      throw new Error("fetch failed");
    }, plain);

    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("La API no responde (fetch failed)");
    expect(result.text).toContain("pnpm dev");
  });
});
