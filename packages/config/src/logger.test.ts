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

  it("no se cae con referencias circulares", () => {
    const node: Record<string, unknown> = { name: "a" };
    node.self = node;

    expect(redact(node)).toEqual({ name: "a", self: "[Circular]" });
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
});
