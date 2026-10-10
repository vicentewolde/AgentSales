import { loadEnv } from "@agentsales/config";
import type { HealthReport } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { createColors } from "../../colors.js";
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

const allTools: RunCommand = async (command, args) => {
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
      ffmpeg: "ok",
      ffprobe: "ok",
      "Chromium (Playwright)": "ok",
      "Claude Code": "ok",
    });
    expect(report.items.find((item) => item.name === "Mercado Libre")?.detail).toBe(
      "ML_APP_ID y ML_CLIENT_SECRET definidas; dirección de retorno https://agentsales.test/oauth/mercadolibre/callback",
    );
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
      c.bold(c.bgRed(c.white(" LIVE: las publicaciones son reales (según la API) "))),
    );
  });
});
