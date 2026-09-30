import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, REDACTED, redact, redactText } from "./logger.js";

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  const logger = createLogger({ level: "info" }, destination);
  return { logger, lines };
}

describe("redact", () => {
  it("oculta claves sensibles a cualquier profundidad y deja el resto intacto", () => {
    const result = redact({
      token: "t-123",
      apiKey: "k-123",
      R2_SECRET_ACCESS_KEY: "s-123",
      headers: { authorization: "Bearer abc", accept: "application/json" },
      db: { password: "p-123", host: "ep-test" },
      items: [{ refresh_token: "r-123", id: 1 }],
      listingId: "L-1",
    });

    expect(result).toEqual({
      token: REDACTED,
      apiKey: REDACTED,
      R2_SECRET_ACCESS_KEY: REDACTED,
      headers: { authorization: REDACTED, accept: "application/json" },
      db: { password: REDACTED, host: "ep-test" },
      items: [{ refresh_token: REDACTED, id: 1 }],
      listingId: "L-1",
    });
  });

  it("no se cae con referencias circulares", () => {
    const node: Record<string, unknown> = { name: "a" };
    node.self = node;

    expect(redact(node)).toEqual({ name: "a", self: "[Circular]" });
  });

  it("repite los objetos compartidos que no son circulares", () => {
    const shared = { id: 1 };

    expect(redact({ x: shared, y: shared })).toEqual({ x: { id: 1 }, y: { id: 1 } });
  });

  it("oculta credenciales y parámetros sensibles dentro de URLs", () => {
    const result = redact({
      databaseUrl: "postgresql://owner:fake-pass@ep-test.neon.tech/neondb?sslmode=require",
      url: "https://graph.facebook.com/v1/me?fields=id&access_token=EAAB-fake",
      presigned: "https://r2.example/obj.jpg?X-Amz-Credential=AK%2Ffake&X-Amz-Signature=abc123",
    });

    expect(result).toEqual({
      databaseUrl: `postgresql://${REDACTED}@ep-test.neon.tech/neondb?sslmode=require`,
      url: `https://graph.facebook.com/v1/me?fields=id&access_token=${REDACTED}`,
      presigned: `https://r2.example/obj.jpg?X-Amz-Credential=${REDACTED}&X-Amz-Signature=${REDACTED}`,
    });
  });

  it("copia los errores a un objeto plano y redacta sus propiedades y su causa", () => {
    const cause = Object.assign(new Error("fallo de red"), { token: "t-cause" });
    const error = Object.assign(new Error("401 en https://api.test/x?access_token=EAAB-fake"), {
      config: { headers: { authorization: "Bearer LEAK" }, url: "https://api.test/x" },
      cause,
    });

    const result = redact({ err: error });

    expect(result).toMatchObject({
      err: {
        type: "Error",
        message: `401 en https://api.test/x?access_token=${REDACTED}`,
        config: { headers: { authorization: REDACTED }, url: "https://api.test/x" },
        cause: { type: "Error", message: "fallo de red", token: REDACTED },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/LEAK|EAAB-fake|t-cause/);
  });
});

describe("createLogger", () => {
  it("redacta los secretos de los objetos logueados", () => {
    const { logger, lines } = captureLogger();

    logger.info(
      { accessToken: "EAAB-secret", headers: { Authorization: "Bearer abc" }, listingId: "L-1" },
      "publicando",
    );

    const [line] = lines;
    expect(line).toMatchObject({
      msg: "publicando",
      accessToken: REDACTED,
      headers: { Authorization: REDACTED },
      listingId: "L-1",
    });
    expect(JSON.stringify(lines)).not.toMatch(/EAAB-secret|Bearer abc/);
  });

  it("redacta los secretos de los bindings de child()", () => {
    const { logger, lines } = captureLogger();

    logger.child({ platform: "instagram", clientSecret: "cs-123" }).info("conectando");

    expect(lines[0]).toMatchObject({ platform: "instagram", clientSecret: REDACTED });
    expect(JSON.stringify(lines)).not.toContain("cs-123");
  });

  it("redacta también en hijos de hijos", () => {
    const { logger, lines } = captureLogger();

    logger.child({ platform: "instagram" }).child({ refreshToken: "rt-123" }).info("renovando");

    expect(lines[0]).toMatchObject({ platform: "instagram", refreshToken: REDACTED });
    expect(JSON.stringify(lines)).not.toContain("rt-123");
  });

  it("redacta los bindings agregados con setBindings()", () => {
    const { logger, lines } = captureLogger();
    const child = logger.child({ platform: "instagram" });

    child.setBindings({ apiKey: "ak-123" });
    child.info("configurado");

    expect(lines[0]).toMatchObject({ platform: "instagram", apiKey: REDACTED });
    expect(JSON.stringify(lines)).not.toContain("ak-123");
  });

  it("redacta un error logueado directamente y las URLs del mensaje", () => {
    const { logger, lines } = captureLogger();
    const error = Object.assign(new Error("fallo"), {
      config: { headers: { authorization: "Bearer LEAK" } },
    });

    logger.error(error);
    logger.info("conectando a postgresql://owner:fake-pass@ep-test.neon.tech/neondb");

    expect(lines[0]).toMatchObject({ err: { message: "fallo" } });
    expect(lines[1]).toMatchObject({
      msg: `conectando a postgresql://${REDACTED}@ep-test.neon.tech/neondb`,
    });
    expect(JSON.stringify(lines)).not.toMatch(/LEAK|fake-pass/);
  });
});

describe("redactText", () => {
  it("oculta credenciales y parámetros sensibles de URLs en un texto libre", () => {
    expect(redactText("falló postgresql://u:p@host/db y https://x.test/a?api_key=k1&page=2")).toBe(
      `falló postgresql://${REDACTED}@host/db y https://x.test/a?api_key=${REDACTED}&page=2`,
    );
  });

  it("deja intacto un texto sin URLs sensibles", () => {
    expect(redactText("bucket inaccesible")).toBe("bucket inaccesible");
  });
});
