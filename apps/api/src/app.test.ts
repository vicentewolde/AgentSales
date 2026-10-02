import { Writable } from "node:stream";
import { createLogger } from "@agentsales/config";
import type { HealthReport } from "@agentsales/core";
import { AppError } from "@agentsales/core";
import {
  createInMemoryBrokerRepository,
  createInMemoryListingRepository,
  createInMemoryMediaRepository,
} from "@agentsales/core/testing";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { type AppDeps, createApp } from "./app.js";
import type { ErrorBody } from "./errors.js";

const silentLogger = createLogger(
  { level: "silent" },
  new Writable({ write: (_chunk, _encoding, callback) => callback() }),
);

// `app.request("/x")` usa http://localhost/x: el Host es "localhost".
const access = { allowedHosts: ["localhost"], allowedOrigins: ["http://localhost:5173"] };

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
    access,
    listings: createInMemoryListingRepository(),
    brokers: createInMemoryBrokerRepository(),
    media: createInMemoryMediaRepository(),
    storage: { signedReadUrl: async (path) => `https://r2.test/${path}?firma` },
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

  it("tolera checks que lanzan algo que no es Error, o que lanzan sin ser async", async () => {
    const { body } = await health(
      appWith({
        db: () => Promise.reject("texto suelto"),
        storage: () => {
          throw new Error("lanzado de inmediato");
        },
      }),
    );

    expect(body.checks.db).toMatchObject({ ok: false, error: "texto suelto" });
    expect(body.checks.storage).toMatchObject({ ok: false, error: "lanzado de inmediato" });
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
    return { response, status: response.status, body: (await response.json()) as ErrorBody };
  }

  it("un AppError 4xx responde su código y mensaje, sin details ni cause", async () => {
    const { status, body } = await errorOf(
      new AppError("INVALID_TRANSITION", "Transición inválida de draft a published", {
        details: { interno: "no-debe-salir" },
        cause: new Error("causa interna"),
      }),
    );

    expect(status).toBe(409);
    expect(body).toEqual({
      error: { code: "INVALID_TRANSITION", message: "Transición inválida de draft a published" },
    });
  });

  it.each([
    ["PUBLISH_RATE_LIMITED", 429],
    ["STORAGE_UNAVAILABLE", 503],
    ["LISTING_NOT_FOUND", 404],
  ])("un AppError %s responde %i con su mensaje", async (code, expected) => {
    const { status, body } = await errorOf(new AppError(code, `mensaje de ${code}`));

    expect(status).toBe(expected);
    expect(body).toEqual({ error: { code, message: `mensaje de ${code}` } });
  });

  it("un AppError 500 mantiene el código pero no el mensaje interno", async () => {
    const { status, body } = await errorOf(
      new AppError("STORAGE_ERROR", "R2 rechazó brokers/x/secreto.jpg (403)"),
    );

    expect(status).toBe(500);
    expect(body).toEqual({
      error: { code: "STORAGE_ERROR", message: "Error interno del servidor" },
    });
  });

  it("reconoce un AppError de otra copia del módulo (sin instanceof)", async () => {
    const lookalike = Object.assign(new Error("Transición inválida"), {
      name: "AppError",
      code: "INVALID_TRANSITION",
      retriable: false,
    });

    const { status, body } = await errorOf(lookalike);

    expect(status).toBe(409);
    expect(body.error.code).toBe("INVALID_TRANSITION");
  });

  it("un error inesperado responde 500 genérico sin filtrar su mensaje", async () => {
    const { status, body } = await errorOf(new Error("SELECT * FROM brokers falló: detalle"));

    expect(status).toBe(500);
    expect(body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Error interno del servidor" },
    });
  });

  it("una HTTPException 4xx conserva su status y sus headers", async () => {
    const res = new Response(null, { headers: { "Retry-After": "30" } });
    const { response, status, body } = await errorOf(
      new HTTPException(429, { message: "Demasiadas peticiones", res }),
    );

    expect(status).toBe(429);
    expect(body).toEqual({ error: { code: "HTTP_429", message: "Demasiadas peticiones" } });
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("una HTTPException 5xx responde 500 genérico", async () => {
    const { status, body } = await errorOf(new HTTPException(502, { message: "upstream roto" }));

    expect(status).toBe(500);
    expect(body.error).toEqual({ code: "INTERNAL_ERROR", message: "Error interno del servidor" });
  });

  it("un cuerpo JSON mal formado responde 400 INVALID_JSON", async () => {
    const app = appWith();
    app.post("/eco", async (c) => c.json(await c.req.json()));

    const response = await app.request("/eco", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{no es json",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "INVALID_JSON", message: "El cuerpo de la petición no es JSON válido" },
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

describe("acceso local", () => {
  it("rechaza un Host que no es local (DNS rebinding)", async () => {
    const response = await appWith().request("http://evil.example:8787/health");

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "HOST_NOT_ALLOWED", message: "Host no permitido: evil.example:8787" },
    });
  });

  it("rechaza un formulario enviado desde otro origen (CSRF)", async () => {
    const app = appWith();
    app.post("/form", (c) => c.text("ok"));

    const response = await app.request("/form", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://evil.example",
      },
      body: "a=1",
    });

    expect(response.status).toBe(403);
  });

  it("acepta un formulario desde el panel", async () => {
    const app = appWith();
    app.post("/form", (c) => c.text("ok"));

    const response = await app.request("/form", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "http://localhost:5173",
      },
      body: "a=1",
    });

    expect(response.status).toBe(200);
  });
});
