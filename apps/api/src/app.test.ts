import { Writable } from "node:stream";
import { createLogger } from "@agentsales/config";
import { AppError } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { type AppDeps, createApp } from "./app.js";
import type { ErrorBody } from "./errors.js";
import type { HealthReport } from "./health.js";

const silentLogger = createLogger(
  { level: "silent" },
  new Writable({ write: (_chunk, _encoding, callback) => callback() }),
);

const ok = async () => {};
const fail = (message: string) => async () => {
  throw new Error(message);
};

function appWith(checks: Partial<AppDeps["checks"]> = {}, extra: Partial<AppDeps> = {}) {
  return createApp({
    checks: { db: ok, storage: ok, queue: ok, ...checks },
    publishMode: "dry-run",
    version: "0.0.1",
    logger: silentLogger,
    ...extra,
  });
}

async function health(app: ReturnType<typeof createApp>) {
  const response = await app.request("/health");
  return { status: response.status, body: (await response.json()) as HealthReport };
}

describe("GET /health", () => {
  it("con todo sano responde ok, el modo de publicación, la versión y latencias", async () => {
    const { status, body } = await health(appWith());

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok", publishMode: "dry-run", version: "0.0.1" });
    for (const check of Object.values(body.checks)) {
      expect(check.ok).toBe(true);
      expect(check.latencyMs).toBeGreaterThanOrEqual(0);
      expect(check.error).toBeUndefined();
    }
  });

  it("si un check falla responde 200 con degraded y el error de ese check", async () => {
    const { status, body } = await health(appWith({ storage: fail("bucket inaccesible") }));

    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.checks.storage).toMatchObject({ ok: false, error: "bucket inaccesible" });
    expect(body.checks.db.ok).toBe(true);
  });

  it("un check colgado termina por timeout sin colgar /health", async () => {
    const hang = () => new Promise<void>(() => {});
    const { body } = await health(appWith({ queue: hang }, { checkTimeoutMs: 20 }));

    expect(body.status).toBe("degraded");
    expect(body.checks.queue).toMatchObject({ ok: false, error: "sin respuesta en 20 ms" });
  });

  it("redacta credenciales que aparezcan en el mensaje de error", async () => {
    const { body } = await health(
      appWith({ db: fail("no conecta a postgresql://owner:fake-pass@ep-test.neon.tech/db") }),
    );

    expect(body.checks.db.error).toBe("no conecta a postgresql://[REDACTED]@ep-test.neon.tech/db");
  });

  it("informa PUBLISH_MODE=live tal cual", async () => {
    const { body } = await health(appWith({}, { publishMode: "live" }));

    expect(body.publishMode).toBe("live");
  });
});

describe("manejo de errores", () => {
  async function errorOf(error: unknown) {
    const app = appWith();
    app.get("/boom", () => {
      throw error;
    });
    const response = await app.request("/boom");
    return { status: response.status, body: (await response.json()) as ErrorBody };
  }

  it("un AppError responde su código y mensaje, sin details ni cause", async () => {
    const { status, body } = await errorOf(
      new AppError("INVALID_TRANSITION", "Transición inválida de draft a published", {
        details: { secretish: "no-debe-salir" },
        cause: new Error("causa interna"),
      }),
    );

    expect(status).toBe(409);
    expect(body).toEqual({
      error: { code: "INVALID_TRANSITION", message: "Transición inválida de draft a published" },
    });
  });

  it("un error inesperado responde 500 genérico sin filtrar su mensaje", async () => {
    const { status, body } = await errorOf(new Error("SELECT * FROM brokers falló: detalle"));

    expect(status).toBe(500);
    expect(body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Error interno del servidor" },
    });
  });

  it("una ruta inexistente responde 404 en JSON", async () => {
    const response = await appWith().request("/no-existe");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "ROUTE_NOT_FOUND", message: "No existe GET /no-existe" },
    });
  });
});
