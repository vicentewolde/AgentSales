import { loadEnv } from "@agentsales/config";
import type { HealthReport } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import type { RunCommand } from "./checks.js";
import { createColors } from "./colors.js";
import { type DoctorDeps, renderDoctor, runDoctor } from "./doctor.js";

const env = loadEnv({
  DATABASE_URL: "postgresql://o:fake-pass@ep-test.neon.tech/db?sslmode=require",
  R2_ACCOUNT_ID: "a",
  R2_ACCESS_KEY_ID: "b",
  R2_SECRET_ACCESS_KEY: "c",
  R2_BUCKET: "agentsales-media",
  APP_ENCRYPTION_KEY: "k".repeat(32),
});

const healthy: HealthReport = {
  status: "ok",
  publishMode: "dry-run",
  version: "0.0.1",
  checks: {
    db: { ok: true, latencyMs: 60 },
    storage: { ok: true, latencyMs: 200 },
    queue: { ok: true, latencyMs: 65 },
  },
};

const allTools: RunCommand = async (command) =>
  command === "claude" ? "2.1.243 (Claude Code)\n" : "ffmpeg version 9.0.1 Copyright\nmás\n";

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    nodeVersion: "v26.9.0",
    env: { ok: true, env },
    fetchHealth: async () => healthy,
    run: allTools,
    chromiumDir: "/cache/ms-playwright/chromium-1217",
    ...overrides,
  };
}

const levels = (items: { name: string; level: string }[]) =>
  Object.fromEntries(items.map((item) => [item.name, item.level]));

describe("runDoctor", () => {
  it("con todo sano sale con 0 y marca cada ítem en ok", async () => {
    const report = await runDoctor(deps());

    expect(report.exitCode).toBe(0);
    expect(levels(report.items)).toEqual({
      Node: "ok",
      ".env": "ok",
      PUBLISH_MODE: "ok",
      API: "ok",
      "Base de datos": "ok",
      Almacenamiento: "ok",
      Cola: "ok",
      ffmpeg: "ok",
      "Chromium (Playwright)": "ok",
      "Claude Code": "ok",
    });
    expect(report.items.find((item) => item.name === "ffmpeg")?.detail).toBe(
      "ffmpeg version 9.0.1 Copyright",
    );
    expect(report.items.find((item) => item.name === "Cola")?.detail).toContain(
      "no indica si el worker está corriendo",
    );
  });

  it("con la API caída marca API, base, almacenamiento y cola como error y sugiere pnpm dev", async () => {
    const report = await runDoctor(
      deps({
        fetchHealth: async () => {
          throw new Error("fetch failed");
        },
      }),
    );

    expect(report.exitCode).toBe(1);
    const api = report.items.find((item) => item.name === "API");
    expect(api).toMatchObject({ level: "error", hint: "Levántala con pnpm dev" });
    expect(levels(report.items)).toMatchObject({
      "Base de datos": "error",
      Almacenamiento: "error",
      Cola: "error",
    });
  });

  it("muestra el error de un servicio caído que informa /health", async () => {
    const report = await runDoctor(
      deps({
        fetchHealth: async () => ({
          ...healthy,
          status: "degraded",
          checks: {
            ...healthy.checks,
            queue: { ok: false, latencyMs: 60, error: "No existe el esquema pgboss" },
          },
        }),
      }),
    );

    expect(report.exitCode).toBe(1);
    expect(report.items.find((item) => item.name === "Cola")).toMatchObject({
      level: "error",
      detail: "No existe el esquema pgboss",
      hint: "Arranca el worker una vez (pnpm dev)",
    });
  });

  it("sin ffmpeg sale con 1", async () => {
    const report = await runDoctor(
      deps({
        run: async (command) => {
          if (command === "ffmpeg") throw new Error("ENOENT");
          return "2.1.243";
        },
      }),
    );

    expect(report.exitCode).toBe(1);
    expect(levels(report.items).ffmpeg).toBe("error");
  });

  it("sin Claude ni Chromium solo advierte y sale con 0", async () => {
    const report = await runDoctor(
      deps({
        chromiumDir: null,
        run: async (command) => {
          if (command === "claude") throw new Error("ENOENT");
          return "ffmpeg version 9.0.1";
        },
      }),
    );

    expect(report.exitCode).toBe(0);
    expect(levels(report.items)).toMatchObject({
      "Chromium (Playwright)": "warn",
      "Claude Code": "warn",
    });
  });

  it("con un .env inválido lista las variables sin mostrar valores", async () => {
    const report = await runDoctor(
      deps({
        env: {
          ok: false,
          fileFound: true,
          issues: [
            { variable: "DATABASE_URL", message: "el host contiene -pooler" },
            { variable: "APP_ENCRYPTION_KEY", message: "debe tener al menos 32 caracteres" },
          ],
        },
      }),
    );

    const item = report.items.find((i) => i.name === ".env");
    expect(report.exitCode).toBe(1);
    expect(item?.detail).toBe(
      "DATABASE_URL (el host contiene -pooler); APP_ENCRYPTION_KEY (debe tener al menos 32 caracteres)",
    );
    expect(report.items.find((i) => i.name === "PUBLISH_MODE")?.detail).toBe(
      "dry-run: no se publica nada (según la API)",
    );
  });

  it("sin archivo .env sugiere copiar .env.example", async () => {
    const report = await runDoctor(
      deps({
        env: {
          ok: false,
          fileFound: false,
          issues: [{ variable: "DATABASE_URL", message: "falta" }],
        },
      }),
    );

    expect(report.items.find((i) => i.name === ".env")?.hint).toContain("cp .env.example .env");
  });

  it("con otra versión de Node marca error", async () => {
    const report = await runDoctor(deps({ nodeVersion: "v22.12.0" }));

    expect(report.exitCode).toBe(1);
    expect(report.items[0]).toMatchObject({ name: "Node", level: "error" });
  });

  it("PUBLISH_MODE=live en la API es una advertencia destacada", async () => {
    const report = await runDoctor(
      deps({
        env: { ok: true, env: { ...env, PUBLISH_MODE: "live" } },
        fetchHealth: async () => ({ ...healthy, publishMode: "live" }),
      }),
    );

    expect(report.exitCode).toBe(0);
    expect(report.items.find((i) => i.name === "PUBLISH_MODE")).toMatchObject({
      level: "warn",
      emphasis: "danger",
      detail: "LIVE: las publicaciones son reales (según la API)",
    });
  });

  it("si la API corre en otro modo que el .env, es un error", async () => {
    const report = await runDoctor(
      deps({ fetchHealth: async () => ({ ...healthy, publishMode: "live" }) }),
    );

    expect(report.exitCode).toBe(1);
    expect(report.items.find((i) => i.name === "PUBLISH_MODE")).toMatchObject({
      level: "error",
      detail: "la API corre en live pero .env dice dry-run",
      hint: "Reinicia pnpm dev para que la API tome el .env actual",
    });
  });

  it("con la API caída usa el modo del .env y lo aclara", async () => {
    const report = await runDoctor(
      deps({
        fetchHealth: async () => {
          throw new Error("x");
        },
      }),
    );

    expect(report.items.find((i) => i.name === "PUBLISH_MODE")?.detail).toBe(
      "dry-run: no se publica nada (según .env; la API no responde)",
    );
  });

  it.each([
    ["db", "Base de datos", "Neon puede estar despertando"],
    ["storage", "Almacenamiento", "pnpm storage:check"],
  ] as const)("un %s caído trae su sugerencia", async (key, name, hint) => {
    const report = await runDoctor(
      deps({
        fetchHealth: async () => ({
          ...healthy,
          status: "degraded",
          checks: { ...healthy.checks, [key]: { ok: false, latencyMs: 10, error: "falló" } },
        }),
      }),
    );

    expect(report.items.find((i) => i.name === name)).toMatchObject({
      level: "error",
      detail: "falló",
      hint: expect.stringContaining(hint),
    });
  });

  it("con Node 27 también marca error", async () => {
    expect((await runDoctor(deps({ nodeVersion: "v27.0.0" }))).items[0]?.level).toBe("error");
  });

  it("describe por qué falló un comando", async () => {
    const report = await runDoctor(
      deps({
        run: async (command) => {
          const error = Object.assign(new Error("spawn"), {
            code: command === "claude" ? "ENOENT" : undefined,
            killed: command !== "claude",
          });
          throw error;
        },
      }),
    );

    expect(report.items.find((i) => i.name === "ffmpeg")?.detail).toBe(
      "ffmpeg: no respondió a tiempo",
    );
    expect(report.items.find((i) => i.name === "Claude Code")?.detail).toContain("no encontrado");
  });
});

describe("renderDoctor", () => {
  it("usa ✓, ⚠ y ✗ con sus colores y muestra las sugerencias", async () => {
    const c = createColors(true);
    const report = await runDoctor(deps({ chromiumDir: null }));

    const text = renderDoctor(report, c);

    expect(text).toContain(c.green("✓"));
    expect(text).toContain(c.yellow("⚠"));
    expect(text).toContain(c.dim("→ En F5: pnpm exec playwright install chromium"));
    expect(text).toContain(c.green("Todo en orden (1 advertencia(s))"));
  });

  it("destaca PUBLISH_MODE=live en rojo", async () => {
    const c = createColors(true);
    const report = await runDoctor(
      deps({
        env: { ok: true, env: { ...env, PUBLISH_MODE: "live" } },
        fetchHealth: async () => ({ ...healthy, publishMode: "live" }),
      }),
    );

    expect(renderDoctor(report, c)).toContain(
      c.bold(c.bgRed(c.white(" LIVE: las publicaciones son reales (según la API) "))),
    );
  });
});
