import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, REDACTED, redact } from "./logger.js";

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

  it("oculta el desafío, los códigos de recuperación y el enlace otpauth, pero no sus conteos (F8-T15)", () => {
    expect(
      redact({
        challenge: "c-1",
        recoveryCodes: ["AAAA-BBBB"],
        otpauthUrl: "otpauth://totp/x",
        loginChallenges: 3,
        recoveryCodesLeft: 9,
        code: "TOTP_CODE_INVALID",
      }),
    ).toEqual({
      challenge: REDACTED,
      recoveryCodes: REDACTED,
      otpauthUrl: REDACTED,
      loginChallenges: 3,
      recoveryCodesLeft: 9,
      code: "TOTP_CODE_INVALID",
    });
  });

  it("deja visible la clave code (los códigos de error) y oculta los tokens de Instagram (F3)", () => {
    expect(
      redact({
        err: { code: "IG_AUTH_INVALID", message: "token vencido" },
        accessToken: "IGAA-1",
        credentials: { access_token: "IGAA-2", client_secret: "s" },
        url: "https://x.test/cb?code=AQB&state=s1",
      }),
    ).toEqual({
      err: { code: "IG_AUTH_INVALID", message: "token vencido" },
      accessToken: REDACTED,
      credentials: { access_token: REDACTED, client_secret: REDACTED },
      url: `https://x.test/cb?code=${REDACTED}&state=s1`,
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

  describe("webhook de Discord y Bearer (F9-T02)", () => {
    const WEBHOOK_TOKEN = "falso-webhook_ABC123";
    const WEBHOOK = `https://discord.com/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`;
    const BEARER = "falso-bearer.XYZ789";

    it("en el mensaje, en los campos y en los bindings de un log", () => {
      const { logger, lines } = captureLogger();

      logger
        .child({ target: WEBHOOK })
        .info(
          { webhookUrl: WEBHOOK, request: { url: WEBHOOK, header: `Bearer ${BEARER}` } },
          `POST ${WEBHOOK} con Authorization: Bearer ${BEARER} respondió 404`,
        );

      const [line] = lines;
      expect(line).toMatchObject({
        webhookUrl: REDACTED,
        msg: `POST https://discord.com/api/webhooks/123456789012345678/${REDACTED} con Authorization: Bearer ${REDACTED} respondió 404`,
      });
      expect(JSON.stringify(lines)).not.toContain(WEBHOOK_TOKEN);
      expect(JSON.stringify(lines)).not.toContain(BEARER);
    });

    it("en un error serializado: su mensaje, su pila, sus propiedades y su causa", () => {
      const { logger, lines } = captureLogger();
      const cause = new Error(`Bearer ${BEARER} rechazado`);
      const error = Object.assign(new Error(`Discord respondió 401 en ${WEBHOOK}`), {
        response: { body: `{"url":"${WEBHOOK}"}` },
        cause,
      });

      logger.error({ err: error }, "falló el envío");

      const serialized = JSON.stringify(redact({ err: error }));
      for (const text of [serialized, JSON.stringify(lines)]) {
        expect(text).not.toContain(WEBHOOK_TOKEN);
        expect(text).not.toContain(BEARER);
      }
      expect(redact({ err: error })).toMatchObject({
        err: {
          message: `Discord respondió 401 en https://discord.com/api/webhooks/123456789012345678/${REDACTED}`,
          response: {
            body: `{"url":"https://discord.com/api/webhooks/123456789012345678/${REDACTED}"}`,
          },
          cause: { message: `Bearer ${REDACTED} rechazado` },
        },
      });
      // pino junta la causa en el mensaje: también queda oculta ahí.
      expect(lines[0]).toMatchObject({
        msg: "falló el envío",
        err: { message: expect.stringContaining(REDACTED) },
      });
    });
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
