import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { createLogger } from "@agentsales/config";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requestLogger } from "./request-logger.js";
import { localAccess } from "./security.js";
import { readApiVersion } from "./version.js";

describe("localAccess", () => {
  it("permite la API y el panel en 127.0.0.1 y localhost", () => {
    expect(localAccess(8787, 5173)).toEqual({
      allowedHosts: ["127.0.0.1:8787", "127.0.0.1:5173", "localhost:8787", "localhost:5173"],
      allowedOrigins: ["http://127.0.0.1:5173", "http://localhost:5173"],
    });
  });
});

describe("readApiVersion", () => {
  it("lee la versión del package.json de la API", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

    expect(readApiVersion()).toBe(pkg.version);
  });
});

describe("requestLogger", () => {
  function captured() {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger(
      { level: "debug" },
      new Writable({
        write(chunk, _encoding, callback) {
          lines.push(JSON.parse(chunk.toString()));
          callback();
        },
      }),
    );
    const app = new Hono()
      .use(requestLogger(logger))
      .get("/health", (c) => c.text("ok"))
      .get("/listings", (c) => c.text("ok"))
      .get("/roto", (c) => c.text("error", 500));
    return { app, lines };
  }

  it("registra método, ruta, status y duración; /health en debug y 5xx en warn", async () => {
    const { app, lines } = captured();

    await app.request("/health");
    await app.request("/listings?token=abc");
    await app.request("/roto");

    expect(lines.map(({ level, path, status }) => ({ level, path, status }))).toEqual([
      { level: 20, path: "/health", status: 200 },
      { level: 30, path: "/listings", status: 200 },
      { level: 40, path: "/roto", status: 500 },
    ]);
    expect(lines[1]).toMatchObject({ method: "GET", msg: "request" });
    expect(typeof lines[1]?.ms).toBe("number");
  });
});
