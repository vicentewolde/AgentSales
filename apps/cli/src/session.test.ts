import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliSessionPath, createFileSessionStore } from "./session.js";

// F7-T06 (spec F7 §4.10): la sesión de la CLI en un archivo `0600`, en una carpeta `0700`.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("el archivo de sesión", () => {
  it("vive en ~/.agentsales, fuera del proyecto", () => {
    expect(cliSessionPath("/Users/operador")).toBe("/Users/operador/.agentsales/cli-session.json");
  });

  it("se guarda con 0600 en una carpeta 0700, se lee y se borra", () => {
    const home = mkdtempSync(join(tmpdir(), "agentsales-sesion-"));
    dirs.push(home);
    const store = createFileSessionStore(cliSessionPath(home));
    expect(store.read()).toBeNull();
    const session = { token: "t-secreto", email: "a@ejemplo.cl", savedAt: "2026-10-17T00:00:00Z" };
    store.write(session);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".agentsales")).mode & 0o777).toBe(0o700);
    expect(store.read()).toEqual(session);
    store.clear();
    expect(store.read()).toBeNull();
    store.clear();
  });

  it("un archivo roto o con otra forma es como no tener sesión", () => {
    const home = mkdtempSync(join(tmpdir(), "agentsales-sesion-"));
    dirs.push(home);
    const store = createFileSessionStore(cliSessionPath(home));
    store.write({ token: "t", email: "a@ejemplo.cl", savedAt: "x" });
    expect(readFileSync(store.path, "utf8")).toContain('"token"');
    for (const content of ["{roto", JSON.stringify({ token: "" })]) {
      writeFileSync(store.path, content);
      expect(store.read()).toBeNull();
    }
  });

  it("guarda el servidor de login --api; una sesión de F7 (sin él) se sigue leyendo", () => {
    const home = mkdtempSync(join(tmpdir(), "agentsales-sesion-"));
    dirs.push(home);
    const store = createFileSessionStore(cliSessionPath(home));
    const remote = {
      token: "t",
      email: "a@ejemplo.cl",
      savedAt: "x",
      apiUrl: "https://agentsales.agentpey.com",
    };
    store.write(remote);
    expect(store.read()).toEqual(remote);
    writeFileSync(store.path, JSON.stringify({ token: "t", email: "a@ejemplo.cl", savedAt: "x" }));
    expect(store.read()).toEqual({ token: "t", email: "a@ejemplo.cl", savedAt: "x" });
  });
});
