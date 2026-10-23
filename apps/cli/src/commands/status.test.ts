import type { HealthReport } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { ApiCallError } from "../api-client.js";
import { createColors } from "../colors.js";
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

    expect(text).toContain(
      c.bgRed(c.white(" PUBLISH_MODE: LIVE — el servidor permite publicar de verdad ")),
    );
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
    expect(result.text).toContain("La API no responde: fetch failed");
    expect(result.text).toContain("pnpm dev");
  });
});

// F8-T08 (spec F8 §4.5): con un servidor remoto, status dice cuál es y su ambiente.
describe("runStatus · un servidor remoto", () => {
  const target = {
    url: "https://agentsales.agentpey.com",
    source: "session" as const,
    remote: true,
    sessionUrl: "https://agentsales.agentpey.com",
  };

  it("muestra el servidor y el ambiente", async () => {
    const result = await runStatus(
      async () => report({ environment: "production" }),
      plain,
      target,
    );
    expect(result.text).toContain(
      "Servidor: https://agentsales.agentpey.com (guardada con la sesión)",
    );
    expect(result.text).toContain("(API 0.0.1 · production)");
  });

  it("sin respuesta, no sugiere pnpm dev", async () => {
    const result = await runStatus(
      async () => {
        const error = new ApiCallError("sin respuesta en 30 s", "TIMEOUT");
        error.remote = true;
        throw error;
      },
      plain,
      target,
    );
    expect(result.exitCode).toBe(1);
    expect(result.text).toContain("Servidor: https://agentsales.agentpey.com");
    expect(result.text).not.toContain("pnpm dev");
  });

  it("con la API local no agrega la línea del servidor", async () => {
    const result = await runStatus(async () => report(), plain, {
      ...target,
      url: "http://127.0.0.1:8787",
      source: "local",
      remote: false,
    });
    expect(result.text).not.toContain("Servidor:");
  });
});

describe("runStatus · el worker (F8-T12)", () => {
  it("dice si está encendido según su latido", async () => {
    const on = await runStatus(
      async () =>
        report({
          worker: {
            running: true,
            startedAt: "2026-10-18T13:00:00.000Z",
            lastBeatAt: "2026-10-18T14:00:00.000Z",
          },
        }),
      plain,
    );
    expect(on.text).toContain("✓ worker   encendido desde 2026-10-18 10:00");

    const off = await runStatus(
      async () =>
        report({
          worker: { running: false, startedAt: null, lastBeatAt: null },
        }),
      plain,
    );
    expect(off.text).toContain("⚠ worker   nunca ha corrido");
  });
});

// F9.5-T22 (ADR-0036): el servidor permite, las marcas encendidas publican de verdad.
describe("runStatus · marcas en vivo", () => {
  it("con el servidor en vivo, dice en rojo cuáles marcas publican de verdad", async () => {
    const result = await runStatus(
      async () => report({ publishMode: "live", liveBrokers: ["agentpey", "vinny"] }),
      c,
    );
    expect(result.text).toContain(
      c.bgRed(c.white(" EN VIVO publican de verdad: agentpey, vinny ")),
    );
  });

  it("con el servidor en vivo y ninguna marca encendida, dice que todo sale en simulación", async () => {
    const result = await runStatus(
      async () => report({ publishMode: "live", liveBrokers: [] }),
      plain,
    );
    expect(result.text).toContain("Ninguna marca está en vivo: todo sale en simulación");
  });

  it("con el servidor en simulación, una marca encendida sigue en simulación", async () => {
    const result = await runStatus(
      async () => report({ publishMode: "dry-run", liveBrokers: ["vinny"] }),
      plain,
    );
    expect(result.text).toContain(
      "siguen en simulación mientras el servidor esté en dry-run): vinny",
    );
    expect(result.text).not.toContain("EN VIVO publican");
  });

  it("sin la lista (sin sesión de administrador) no dice nada; si la base no respondió, lo avisa", async () => {
    expect(
      (await runStatus(async () => report({ publishMode: "live" }), plain)).text,
    ).not.toContain("marcas");
    const down = await runStatus(
      async () => report({ publishMode: "live", liveBrokers: null }),
      plain,
    );
    expect(down.text).toContain("No se pudo saber qué marcas están en vivo");
  });

  it("auto_publish solo está EN VIVO en la marca encendida", async () => {
    const result = await runStatus(
      async () =>
        report({
          publishMode: "live",
          liveBrokers: ["vinny"],
          autoPublishBrokers: ["vinny", "cliente"],
        }),
      plain,
    );
    expect(result.text).toContain("auto_publish EN VIVO: publica sin tu revisión (vinny)");
    expect(result.text).not.toContain("(vinny, cliente)");
  });
});
