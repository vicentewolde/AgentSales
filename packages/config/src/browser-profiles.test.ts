import { describe, expect, it } from "vitest";
import { resolveBrowserProfilesDir } from "./browser-profiles.js";
import { EnvError } from "./env.js";

const paths = {
  homeDir: "/Users/operador",
  workspaceRoot: "/Users/operador/dev/AgentSales",
  caseInsensitive: false,
};

describe("resolveBrowserProfilesDir", () => {
  it("expande ~/ con la carpeta del usuario", () => {
    expect(resolveBrowserProfilesDir("~/.agentsales/browser-profiles", paths)).toBe(
      "/Users/operador/.agentsales/browser-profiles",
    );
  });

  it("deja una ruta absoluta fuera del proyecto tal cual (normalizada)", () => {
    expect(resolveBrowserProfilesDir("/srv/perfiles/./fb", paths)).toBe("/srv/perfiles/fb");
    expect(resolveBrowserProfilesDir("/Users/operador/dev/AgentSales-perfiles", paths)).toBe(
      "/Users/operador/dev/AgentSales-perfiles",
    );
  });

  it.each([
    "/Users/operador/dev/AgentSales",
    "/Users/operador/dev/AgentSales/.browser-profiles",
    "/Users/operador/dev/AgentSales/tmp/../.perfiles",
    "~/dev/AgentSales/perfiles",
  ])("rechaza una carpeta dentro del proyecto (%s), sin mostrarla", (value) => {
    let caught: unknown;
    try {
      resolveBrowserProfilesDir(value, paths);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EnvError);
    expect((caught as EnvError).issues.map((issue) => issue.variable)).toEqual([
      "BROWSER_PROFILES_DIR",
    ]);
    expect((caught as EnvError).message).not.toContain("/Users/operador");
  });

  it("en macOS (sin distinguir mayúsculas) también reconoce el proyecto escrito de otra forma", () => {
    expect(() =>
      resolveBrowserProfilesDir("/users/operador/DEV/agentsales/perfiles", {
        ...paths,
        caseInsensitive: true,
      }),
    ).toThrow(EnvError);
    expect(resolveBrowserProfilesDir("/users/operador/DEV/agentsales/perfiles", paths)).toBe(
      "/users/operador/DEV/agentsales/perfiles",
    );
  });

  it("sin proyecto (un despliegue) solo expande la ruta", () => {
    expect(
      resolveBrowserProfilesDir("~/perfiles", { homeDir: "/home/app", workspaceRoot: null }),
    ).toBe("/home/app/perfiles");
  });
});
