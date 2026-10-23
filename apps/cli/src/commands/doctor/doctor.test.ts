import { loadEnv } from "@agentsales/config";
import type { HealthReport } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { ApiCallError } from "../../api-client.js";
import { createColors } from "../../colors.js";
import { ServerUrlError } from "../../server.js";
import type { RunCommand } from "./checks.js";
import { type DoctorDeps, renderDoctor, runDoctor } from "./index.js";

const env = loadEnv({
  DATABASE_URL: "postgresql://o:fake-pass@ep-test.neon.tech/db?sslmode=require",
  R2_ACCOUNT_ID: "a",
  R2_ACCESS_KEY_ID: "b",
  R2_SECRET_ACCESS_KEY: "c",
  R2_BUCKET: "agentsales-media",
  APP_ENCRYPTION_KEY: "k".repeat(32),
  INSTAGRAM_APP_ID: "fake-ig-app",
  INSTAGRAM_APP_SECRET: "fake-ig-secret",
  ML_APP_ID: "fake-ml-app",
  ML_CLIENT_SECRET: "fake-ml-secret",
  BCCH_API_TOKEN: "fake-bde-token",
});

const healthyChecks = {
  db: { ok: true, latencyMs: 60 },
  storage: { ok: true, latencyMs: 200 },
  queue: { ok: true, latencyMs: 65 },
};

const healthy: HealthReport = {
  status: "ok",
  publishMode: "dry-run",
  version: "0.0.1",
  checks: healthyChecks,
  database: { serverVersion: "18.6" },
  backup: {
    lastSuccessAt: "2026-10-15T16:00:00.000Z",
    lastFile: "agentsales-20261015-1300.dump",
    lastFailureAt: null,
    lastFailureCode: null,
    stale: false,
  },
  worker: {
    running: true,
    startedAt: "2026-10-15T18:00:00.000Z",
    lastBeatAt: "2026-10-15T18:59:30.000Z",
  },
};
const NOW = new Date("2026-10-15T19:00:00.000Z");

const allTools: RunCommand = async (command, args) => {
  if (command.endsWith("pg_dump")) return "pg_dump (PostgreSQL) 18.6 (Homebrew)\n";
  if (command !== "claude") return "ffmpeg version 9.0.1 Copyright\nmás\n";
  return args[0] === "auth"
    ? '{ "loggedIn": true, "authMethod": "claude.ai" }'
    : "2.1.243 (Claude Code)\n";
};

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    nodeVersion: "v26.9.0",
    env: { ok: true, env },
    fetchHealth: async () => healthy,
    run: allTools,
    chromium: { path: "/cache/ms-playwright/chromium-1243/chrome", installed: true },
    processEnv: { PATH: "/usr/bin", HOME: "/home/operador" },
    findPgDump: () => "/opt/homebrew/opt/libpq/bin/pg_dump",
    now: () => NOW,
    ...overrides,
  };
}

const levels = (items: { name: string; level: string }[]) =>
  Object.fromEntries(items.map((item) => [item.name, item.level]));

describe("runDoctor", () => {
  it("avisa (sin cortar) si falta el par de Instagram, sin mostrar valores", async () => {
    const { INSTAGRAM_APP_SECRET: _secret, ...withoutSecret } = env;
    const report = await runDoctor(deps({ env: { ok: true, env: withoutSecret } }));
    const item = report.items.find((entry) => entry.name === "Instagram");

    expect(report.exitCode).toBe(0);
    expect(item).toMatchObject({ level: "warn" });
    expect(item?.detail).toContain("INSTAGRAM_APP_SECRET");
    expect(item?.detail).not.toContain("INSTAGRAM_APP_ID");
    expect(JSON.stringify(report.items)).not.toContain("fake-ig");
  });

  it("avisa (sin cortar) si faltan ANTHROPIC_API_KEY y corredores la necesitan (F7-T12)", async () => {
    const missing = await runDoctor(
      deps({ fetchHealth: async () => ({ ...healthy, llmKeyMissingBrokers: ["ajeno", "otro"] }) }),
    );
    const item = missing.items.find((entry) => entry.name === "anthropic_api");
    expect(missing.exitCode).toBe(0);
    expect(item).toMatchObject({
      level: "warn",
      hint: expect.stringContaining("ANTHROPIC_API_KEY"),
    });
    expect(item?.detail).toContain("ajeno, otro");

    for (const list of [[], null, undefined]) {
      const report = await runDoctor(
        deps({ fetchHealth: async () => ({ ...healthy, llmKeyMissingBrokers: list }) }),
      );
      expect(report.items.some((entry) => entry.name === "anthropic_api")).toBe(false);
    }
  });

  it("avisa si ANTHROPIC_MODEL no tiene precio en la tabla (con la clave), sin mostrar la clave", async () => {
    const withKey = {
      ...env,
      ANTHROPIC_API_KEY: "sk-ant-secreta",
      ANTHROPIC_MODEL: "claude-raro-1",
    };
    const report = await runDoctor(deps({ env: { ok: true, env: withKey } }));
    const item = report.items.find((entry) => entry.name === "anthropic_model");
    expect(item).toMatchObject({ level: "warn" });
    expect(item?.detail).toContain("claude-raro-1");
    expect(JSON.stringify(report)).not.toContain("sk-ant-secreta");

    for (const variant of [
      { ...withKey, ANTHROPIC_MODEL: "claude-sonnet-5-5" },
      { ...env, ANTHROPIC_MODEL: "claude-raro-1" },
    ]) {
      const ok = await runDoctor(deps({ env: { ok: true, env: variant } }));
      expect(ok.items.some((entry) => entry.name === "anthropic_model")).toBe(false);
    }
  });

  it("avisa si IMAGE_AI_MODEL cambió y el precio sigue siendo el de por defecto (F9.5-T25)", async () => {
    const withKey = {
      ...env,
      GEMINI_API_KEY: "clave-gemini-secreta",
      IMAGE_AI_MODEL: "otro-modelo",
    };
    const report = await runDoctor(deps({ env: { ok: true, env: withKey } }));
    const item = report.items.find((entry) => entry.name === "image_ai_price");
    expect(item).toMatchObject({ level: "warn" });
    expect(item?.detail).toContain("otro-modelo");
    expect(JSON.stringify(report)).not.toContain("clave-gemini-secreta");
    for (const variant of [
      { ...withKey, IMAGE_AI_PRICE_USD: 0.05 },
      { ...withKey, IMAGE_AI_MODEL: "gemini-nano-banana-2.1" },
      { ...env, IMAGE_AI_MODEL: "otro-modelo" },
    ]) {
      const ok = await runDoctor(deps({ env: { ok: true, env: variant } }));
      expect(ok.items.some((entry) => entry.name === "image_ai_price")).toBe(false);
    }
  });

  it("avisa (sin cortar) si falta el token del Banco Central, y nunca lo muestra", async () => {
    const { BCCH_API_TOKEN: _token, ...withoutToken } = env;
    const without = await runDoctor(deps({ env: { ok: true, env: withoutToken } }));
    expect(without.items.find((entry) => entry.name === "Valor de la UF")).toMatchObject({
      level: "warn",
    });
    const withToken = await runDoctor(
      deps({ env: { ok: true, env: { ...env, BCCH_API_TOKEN: "token-bde-secreto" } } }),
    );
    const item = withToken.items.find((entry) => entry.name === "Valor de la UF");
    expect(item).toMatchObject({ level: "ok" });
    expect(JSON.stringify(withToken)).not.toContain("token-bde-secreto");
  });

  it("avisa (sin cortar) si falta el par de Mercado Libre, con la dirección de retorno y sin valores", async () => {
    const { ML_APP_ID: _id, ML_CLIENT_SECRET: _secret, ...withoutPair } = env;
    const report = await runDoctor(deps({ env: { ok: true, env: withoutPair } }));
    const item = report.items.find((entry) => entry.name === "Mercado Libre");

    expect(report.exitCode).toBe(0);
    expect(item).toMatchObject({ level: "warn" });
    expect(item?.detail).toContain("falta ML_APP_ID y ML_CLIENT_SECRET");
    expect(item?.detail).toContain("ni refrescar el token de una ya conectada");
    expect(item?.detail).toContain("https://agentsales.test/oauth/mercadolibre/callback");
    expect(item?.hint).toContain("docs/07-checklist-cuentas.md");
  });

  it("nombra solo la variable de Mercado Libre que falta y nunca muestra el par", async () => {
    const { ML_CLIENT_SECRET: _secret, ...withoutSecret } = env;
    const report = await runDoctor(deps({ env: { ok: true, env: withoutSecret } }));
    const item = report.items.find((entry) => entry.name === "Mercado Libre");

    expect(item).toMatchObject({ level: "warn" });
    expect(item?.detail).toContain("falta ML_CLIENT_SECRET:");
    expect(item?.detail).not.toContain("ML_APP_ID");
    expect(JSON.stringify(report.items)).not.toContain("fake-ml");
    expect(JSON.stringify((await runDoctor(deps())).items)).not.toContain("fake-ml");

    const { ML_APP_ID: _id, ...withoutId } = env;
    const onlyId = (await runDoctor(deps({ env: { ok: true, env: withoutId } }))).items.find(
      (entry) => entry.name === "Mercado Libre",
    );
    expect(onlyId?.detail).toContain("falta ML_APP_ID:");
    expect(onlyId?.detail).not.toContain("ML_CLIENT_SECRET");
  });

  it("no revisa Instagram si el .env es inválido (ya lo dice .env)", async () => {
    const report = await runDoctor(
      deps({
        env: {
          ok: false,
          fileFound: true,
          issues: [{ variable: "META_APP_ID", message: "se renombró a INSTAGRAM_APP_ID" }],
        },
      }),
    );

    expect(report.items.some((item) => item.name === "Instagram")).toBe(false);
    expect(report.items.some((item) => item.name === "Mercado Libre")).toBe(false);
    expect(report.items.find((item) => item.name === ".env")?.detail).toBe(
      "META_APP_ID (se renombró a INSTAGRAM_APP_ID)",
    );
  });

  it("con todo sano sale con 0 y marca cada ítem en ok", async () => {
    const report = await runDoctor(deps());

    expect(report.exitCode).toBe(0);
    expect(levels(report.items)).toEqual({
      Node: "ok",
      ".env": "ok",
      PUBLISH_MODE: "ok",
      Instagram: "ok",
      "Mercado Libre": "ok",
      "Valor de la UF": "ok",
      API: "ok",
      "Base de datos": "ok",
      Almacenamiento: "ok",
      Cola: "ok",
      Worker: "ok",
      ffmpeg: "ok",
      ffprobe: "ok",
      "Chromium (Playwright)": "ok",
      pg_dump: "ok",
      Respaldo: "ok",
      "Claude Code": "ok",
    });
    expect(report.items.find((item) => item.name === "pg_dump")?.detail).toBe(
      "18.6 (la base es 18.6)",
    );
    expect(report.items.find((item) => item.name === "Respaldo")?.detail).toBe(
      "el último es de hace 3 h (agentsales-20261015-1300.dump)",
    );
    expect(report.items.find((item) => item.name === "Mercado Libre")?.detail).toBe(
      "ML_APP_ID y ML_CLIENT_SECRET definidas; dirección de retorno https://agentsales.test/oauth/mercadolibre/callback",
    );
    expect(report.items.find((item) => item.name === "ffmpeg")?.detail).toBe(
      "ffmpeg version 9.0.1 Copyright",
    );
    expect(report.items.find((item) => item.name === "Cola")?.detail).toBe("inicializada, 65 ms");
    // El worker sale de su latido (F8-T12), con la hora de Chile.
    expect(report.items.find((item) => item.name === "Worker")?.detail).toBe(
      "encendido desde 2026-10-15 15:00",
    );
  });

  it("el worker apagado es una advertencia con qué hacer; sin base, no se sabe (F8-T12)", async () => {
    const off = await runDoctor(
      deps({
        fetchHealth: async () => ({
          ...healthy,
          worker: {
            running: false,
            startedAt: "2026-10-15T10:00:00.000Z",
            lastBeatAt: "2026-10-15T12:00:00.000Z",
          },
        }),
      }),
    );
    const item = off.items.find((entry) => entry.name === "Worker");
    expect(item).toMatchObject({ level: "warn", detail: "apagado desde 2026-10-15 09:00" });
    expect(item?.hint).toContain("pnpm dev");
    expect(off.exitCode).toBe(0);

    const unknown = await runDoctor(
      deps({ fetchHealth: async () => ({ ...healthy, worker: null }) }),
    );
    expect(unknown.items.find((entry) => entry.name === "Worker")).toMatchObject({
      level: "warn",
      detail: "no se pudo saber (la base no respondió)",
    });
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
            ...healthyChecks,
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

  it("revisa ffmpeg y ffprobe: una versión anterior a 8.1 es error, con cómo actualizar", async () => {
    const report = await runDoctor(
      deps({
        run: async (command, args) => {
          if (command === "ffmpeg") return "ffmpeg version 8.0.1 Copyright\n";
          if (command === "ffprobe") return "ffprobe version n9.0.1-11-ge47273f4d9 Copyright\n";
          return allTools(command, args);
        },
      }),
    );

    expect(report.exitCode).toBe(1);
    expect(report.items.find((item) => item.name === "ffmpeg")).toEqual({
      name: "ffmpeg",
      level: "error",
      detail: "ffmpeg version 8.0.1 Copyright (se necesita 8.1 o más nueva)",
      hint: "brew upgrade ffmpeg",
    });
    expect(levels(report.items).ffprobe).toBe("ok");
  });

  it("sin ffprobe sale con 1 y sugiere FFPROBE_PATH", async () => {
    const report = await runDoctor(
      deps({
        run: async (command, args) => {
          if (command === "ffprobe") throw Object.assign(new Error("spawn"), { code: "ENOENT" });
          return allTools(command, args);
        },
      }),
    );

    expect(report.exitCode).toBe(1);
    expect(report.items.find((item) => item.name === "ffprobe")).toMatchObject({
      level: "error",
      detail: "ffprobe: no encontrado",
      hint: "brew install ffmpeg (trae ffprobe), o ajusta FFPROBE_PATH en .env",
    });
  });

  it("respaldo (F6-T14): sin pg_dump solo advierte; con una versión menor que la base es error", async () => {
    const missing = await runDoctor(
      deps({
        findPgDump: () => {
          throw new Error("no está");
        },
      }),
    );
    expect(missing.exitCode).toBe(0);
    expect(missing.items.find((item) => item.name === "pg_dump")).toMatchObject({
      level: "warn",
      hint: expect.stringContaining("brew install libpq"),
    });

    const older = await runDoctor(
      deps({
        run: async (command, args) =>
          command.endsWith("pg_dump") ? "pg_dump (PostgreSQL) 17.4\n" : allTools(command, args),
      }),
    );
    expect(older.exitCode).toBe(1);
    expect(older.items.find((item) => item.name === "pg_dump")).toMatchObject({
      level: "error",
      detail: "17.4, pero la base es 18.6: pg_dump no puede respaldar una base más nueva",
    });
  });

  it("respaldo (F6-T14): usa PG_BIN_DIR, y sin la API no compara la versión", async () => {
    const asked: (string | undefined)[] = [];
    const report = await runDoctor(
      deps({
        env: { ok: true, env: { ...env, PG_BIN_DIR: "/opt/pg/bin" } },
        fetchHealth: async () => {
          throw new Error("ECONNREFUSED");
        },
        findPgDump: (binDir) => {
          asked.push(binDir);
          return "/opt/pg/bin/pg_dump";
        },
      }),
    );
    expect(asked).toEqual(["/opt/pg/bin"]);
    expect(report.items.find((item) => item.name === "pg_dump")).toMatchObject({
      level: "ok",
      detail: "18.6 (sin la versión de la base: se compara con la API corriendo)",
    });
    expect(report.items.find((item) => item.name === "Respaldo")).toBeUndefined();
  });

  it("respaldo (F6-T14): avisa sin respaldos, con uno atrasado o con una falla", async () => {
    const detailOf = async (backup: HealthReport["backup"]) =>
      (await runDoctor(deps({ fetchHealth: async () => ({ ...healthy, backup }) }))).items.find(
        (item) => item.name === "Respaldo",
      );

    expect(await detailOf(null)).toMatchObject({
      level: "warn",
      detail: "todavía no hay respaldos de la base",
    });
    expect(
      await detailOf({
        lastSuccessAt: "2026-10-12T19:00:00.000Z",
        lastFile: "agentsales-20261012-1600.dump",
        lastFailureAt: "2026-10-15T16:00:00.000Z",
        lastFailureCode: "BACKUP_TOOL_NOT_INSTALLED",
        stale: true,
      }),
    ).toMatchObject({
      level: "warn",
      detail:
        "el último bueno es de hace 72 h; el último intento falló (BACKUP_TOOL_NOT_INSTALLED)",
    });
    // Un reporte de antes de F6 (sin `backup`) no muestra el ítem.
    const { backup: _backup, ...old } = healthy;
    const report = await runDoctor(deps({ fetchHealth: async () => old }));
    expect(report.items.find((item) => item.name === "Respaldo")).toBeUndefined();
  });

  it("avisa si un administrador no tiene el doble factor (F8-T15)", async () => {
    const itemOf = async (adminsWithoutTotp: string[] | undefined) =>
      (
        await runDoctor(
          deps({
            fetchHealth: async () => ({
              ...healthy,
              ...(adminsWithoutTotp === undefined ? {} : { adminsWithoutTotp }),
            }),
          }),
        )
      ).items.find((item) => item.name === "Doble factor");

    expect(await itemOf(["admin@ejemplo.cl"])).toMatchObject({
      level: "warn",
      detail: "admin@ejemplo.cl sin doble factor (recomendado para el administrador)",
    });
    expect(await itemOf([])).toBeUndefined();
    expect(await itemOf(undefined)).toBeUndefined();
  });

  it("sin Claude solo advierte y sale con 0", async () => {
    const report = await runDoctor(
      deps({
        run: async (command) => {
          if (command === "claude") throw new Error("ENOENT");
          return "ffmpeg version 9.0.1";
        },
      }),
    );

    expect(report.exitCode).toBe(0);
    expect(levels(report.items)).toMatchObject({ "Claude Code": "warn" });
  });

  it("sin el Chromium que pide Playwright sale con 1 y dice cómo instalarlo (F2-T09)", async () => {
    for (const chromium of [{ path: "/cache/chromium-1243/chrome", installed: false }, null]) {
      const report = await runDoctor(deps({ chromium }));

      expect(report.exitCode).toBe(1);
      expect(report.items.find((item) => item.name === "Chromium (Playwright)")).toMatchObject({
        level: "error",
        hint: "pnpm --filter @agentsales/media exec playwright install chromium",
      });
    }
  });

  it("la CLI de Claude sin sesión solo advierte, con la instrucción para iniciarla (F2-T04)", async () => {
    // Sin sesión, `claude auth status` sale con código 1 y el JSON va en stdout del error.
    const loggedOut: RunCommand = async (command, args) => {
      if (command === "claude" && args[0] === "auth") {
        throw Object.assign(new Error("Command failed"), {
          code: 1,
          stdout: '{ "loggedIn": false, "authMethod": "none" }',
        });
      }
      return allTools(command, args);
    };
    const report = await runDoctor(deps({ run: loggedOut }));
    const claude = report.items.find((item) => item.name === "Claude Code");
    expect(report.exitCode).toBe(0);
    expect(claude).toMatchObject({
      level: "warn",
      detail: "2.1.243 (Claude Code) · sin sesión: no se puede generar contenido",
    });
    expect(claude?.hint).toContain("/login");
  });

  it("una API key no cuenta como sesión: el sistema no se la pasa a la CLI", async () => {
    const apiKeyOnly: RunCommand = async (command, args) =>
      command === "claude" && args[0] === "auth"
        ? '{ "loggedIn": true, "authMethod": "api_key" }'
        : allTools(command, args);
    const report = await runDoctor(deps({ run: apiKeyOnly }));
    expect(report.items.find((item) => item.name === "Claude Code")).toMatchObject({
      level: "warn",
      detail: expect.stringContaining("solo con una API key"),
    });
  });

  it("la CLI de Claude se ejecuta con el entorno mínimo, sin el .env ni claves", async () => {
    const envs: Record<string, string>[] = [];
    const recording: RunCommand = async (command, args, options) => {
      if (command === "claude") envs.push(options?.env ?? {});
      return allTools(command, args);
    };
    await runDoctor(
      deps({
        run: recording,
        processEnv: {
          PATH: "/usr/bin",
          HOME: "/home/operador",
          DATABASE_URL: "postgresql://falso",
          ANTHROPIC_API_KEY: "sk-ant-falsa",
          R2_SECRET_ACCESS_KEY: "secreto-falso",
        },
      }),
    );
    expect(envs).toHaveLength(2);
    for (const env of envs) expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/operador" });
  });

  it("si no se puede leer la sesión, lo dice; y usa CLAUDE_CLI_PATH", async () => {
    const calls: string[] = [];
    const odd: RunCommand = async (command, args) => {
      calls.push(command);
      return args[0] === "auth" ? "no es json" : "2.1.243 (Claude Code)";
    };
    const report = await runDoctor(
      deps({
        run: odd,
        env: { ok: true, env: { ...env, CLAUDE_CLI_PATH: "/opt/claude/bin/claude" } },
      }),
    );
    expect(report.items.find((item) => item.name === "Claude Code")?.detail).toBe(
      "2.1.243 (Claude Code) · no se pudo revisar la sesión",
    );
    expect(calls).toContain("/opt/claude/bin/claude");
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
      detail:
        "LIVE: el servidor permite publicar de verdad; salen de verdad solo las marcas en vivo (según la API)",
    });
  });

  it("las marcas en vivo (F9.5-T22): en rojo si publican de verdad, informativo en simulación, y nada sin la lista", async () => {
    const run = async (extra: Partial<HealthReport>) =>
      (
        await runDoctor(
          deps({
            env: {
              ok: true,
              env: { ...env, PUBLISH_MODE: extra.publishMode ?? "dry-run" },
            },
            fetchHealth: async () => ({ ...healthy, ...extra }),
          }),
        )
      ).items.find((i) => i.name === "Marcas en vivo");
    expect(await run({ publishMode: "live", liveBrokers: ["vinny"] })).toMatchObject({
      level: "warn",
      emphasis: "danger",
      detail: "publican de verdad: vinny",
    });
    expect(await run({ publishMode: "live", liveBrokers: [] })).toMatchObject({
      level: "ok",
      detail: "ninguna: todo sale en simulación",
    });
    expect(await run({ publishMode: "dry-run", liveBrokers: ["vinny"] })).toMatchObject({
      level: "ok",
      detail: expect.stringContaining("en simulación mientras el servidor esté en dry-run"),
    });
    expect(await run({ publishMode: "live" })).toBeUndefined();
    expect(await run({ publishMode: "live", liveBrokers: null })).toMatchObject({ level: "warn" });
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
          checks: { ...healthyChecks, [key]: { ok: false, latencyMs: 10, error: "falló" } },
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
    const report = await runDoctor(
      deps({
        run: async (command, args) => {
          if (command === "claude") throw new Error("ENOENT");
          return allTools(command, args);
        },
      }),
    );

    const text = renderDoctor(report, c);

    expect(text).toContain(c.green("✓"));
    expect(text).toContain(c.yellow("⚠"));
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
      c.bold(
        c.bgRed(
          c.white(
            " LIVE: el servidor permite publicar de verdad; salen de verdad solo las marcas en vivo (según la API) ",
          ),
        ),
      ),
    );
  });
});

// F8-T08 (spec F8 §4.5): con un servidor remoto, doctor revisa el servidor y del Mac solo Node.
describe("runDoctor · un servidor remoto", () => {
  const remote = "https://agentsales.agentpey.com";
  const server = {
    ok: true as const,
    target: { url: remote, source: "session" as const, remote: true, sessionUrl: remote },
  };

  it("no revisa ffmpeg, Chromium, pg_dump, Claude ni el .env del Mac", async () => {
    const ran: string[] = [];
    const report = await runDoctor(
      deps({
        server,
        env: { ok: false, fileFound: false, issues: [] },
        chromium: null,
        run: async (command) => {
          ran.push(command);
          throw new Error("no debía correr nada en el Mac");
        },
        findPgDump: () => {
          throw new Error("no debía buscar pg_dump");
        },
        fetchHealth: async () => ({ ...healthy, environment: "production" }),
      }),
    );
    expect(ran).toEqual([]);
    expect(report.exitCode).toBe(0);
    const names = report.items.map((item) => item.name);
    expect(names).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^(ffmpeg|ffprobe|pg_dump|\.env|Claude Code)$/),
      ]),
    );
    expect(names).not.toContain("Chromium (Playwright)");
    expect(levels(report.items)).toMatchObject({
      Servidor: "ok",
      Ambiente: "ok",
      API: "ok",
      "Base de datos": "ok",
      Herramientas: "ok",
    });
    expect(report.items.find((item) => item.name === "Servidor")?.detail).toContain(remote);
  });

  it("avisa si el servidor dice desarrollo, y los consejos son del servidor, no de pnpm dev", async () => {
    const report = await runDoctor(
      deps({
        server,
        fetchHealth: async () => ({
          ...healthy,
          environment: "development",
          checks: { ...healthyChecks, storage: { ok: false, latencyMs: 0, error: "sin acceso" } },
        }),
      }),
    );
    expect(levels(report.items)).toMatchObject({ Ambiente: "warn", Almacenamiento: "error" });
    const text = renderDoctor(report, createColors(false));
    expect(text).toContain("secretos del servidor");
    expect(text).not.toContain("pnpm dev");
    expect(text).not.toContain(".env");
  });

  const offWorker = {
    running: false,
    startedAt: "2026-10-15T12:00:00.000Z",
    lastBeatAt: "2026-10-15T12:20:00.000Z",
  };

  it("dice la próxima revisión del horario del worker y, apagado, cómo encenderlo ya (F9.5-T24)", async () => {
    const report = await runDoctor(
      deps({
        server,
        fetchHealth: async () => ({
          ...healthy,
          environment: "production",
          worker: offWorker,
          workerSchedule: true,
        }),
      }),
    );
    // NOW es 2026-10-15 16:00 en Chile.
    expect(report.items.find((item) => item.name === "Horario del worker")).toMatchObject({
      level: "ok",
      detail:
        "próxima revisión 2026-10-15 16:50 (cada hora a los :50, de 06:50 a 22:50, hora de Chile)",
    });
    const worker = report.items.find((item) => item.name === "Worker");
    expect(worker).toMatchObject({ level: "warn", detail: "apagado desde 2026-10-15 09:20" });
    expect(worker?.hint).toContain("«Encender el worker»");
    expect(worker?.hint).not.toContain("pnpm dev");
    // En el Mac no hay horario.
    const local = await runDoctor(deps());
    expect(local.items.some((item) => item.name === "Horario del worker")).toBe(false);
  });

  it("sin horario no promete la revisión: el worker debe estar encendido (F9.5-T24)", async () => {
    const report = await runDoctor(
      deps({
        server,
        fetchHealth: async () => ({
          ...healthy,
          environment: "production",
          worker: offWorker,
          workerSchedule: false,
        }),
      }),
    );
    expect(report.items.find((item) => item.name === "Horario del worker")?.detail).toBe(
      "sin horario: el worker no se apaga solo y debe estar encendido",
    );
    const worker = report.items.find((item) => item.name === "Worker");
    expect(worker?.hint).toContain("Sin horario no se enciende solo");
    expect(worker?.hint).not.toContain("próxima revisión");
    // Un servidor anterior no lo informa: no se dice nada del horario.
    const old = await runDoctor(
      deps({ server, fetchHealth: async () => ({ ...healthy, worker: offWorker }) }),
    );
    expect(old.items.some((item) => item.name === "Horario del worker")).toBe(false);
  });

  it("un respaldo atrasado del servidor aconseja mirar el worker, no pnpm db:backup (F8-T13)", async () => {
    const report = await runDoctor(
      deps({
        server,
        fetchHealth: async () => ({
          ...healthy,
          environment: "production",
          backup: {
            lastSuccessAt: null,
            lastFile: null,
            lastFailureAt: "2026-10-15T16:00:00.000Z",
            lastFailureCode: "STORAGE_ERROR",
            stale: true,
          },
        }),
      }),
    );
    const backup = report.items.find((item) => item.name === "Respaldo");
    expect(backup?.level).toBe("warn");
    expect(backup?.hint).toContain("worker del servidor");
    expect(backup?.hint).not.toContain("pnpm db:backup");
  });

  it("sin respuesta del servidor, no sugiere levantar pnpm dev", async () => {
    const report = await runDoctor(
      deps({
        server,
        fetchHealth: async () => {
          const error = new ApiCallError("fetch failed (ENOTFOUND)", "ENOTFOUND");
          error.remote = true;
          throw error;
        },
      }),
    );
    expect(report.exitCode).toBe(1);
    const api = report.items.find((item) => item.name === "API");
    expect(api?.hint).toContain("servidor esté encendido");
    expect(api?.hint).not.toContain("pnpm dev");
  });

  it("en el Mac, una API que corre como producción es un error", async () => {
    const report = await runDoctor(
      deps({ fetchHealth: async () => ({ ...healthy, environment: "production" }) }),
    );
    expect(levels(report.items)).toMatchObject({ Ambiente: "error" });
    expect(report.exitCode).toBe(1);
    // De desarrollo, como se espera: sin ítem.
    const ok = await runDoctor(
      deps({ fetchHealth: async () => ({ ...healthy, environment: "development" }) }),
    );
    expect(ok.items.map((item) => item.name)).not.toContain("Ambiente");
  });

  it("una AGENTSALES_API_URL inválida es un error del servidor", async () => {
    const report = await runDoctor(
      deps({
        server: {
          ok: false,
          error: new ServerUrlError("AGENTSALES_API_URL: http:// solo se acepta con localhost"),
        },
      }),
    );
    expect(levels(report.items)).toMatchObject({ Servidor: "error" });
    expect(report.exitCode).toBe(1);
  });
});
