import { AppError, type UfValue, type UfValueSource } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { runUfSmoke, UF_SMOKE_INVALID_TOKEN } from "./uf-smoke.js";

const TOKEN = "token-bde-secreto";
const NOW = new Date("2026-10-09T18:00:00Z");

function setup(values: UfValue[] | Error) {
  const out: string[] = [];
  const errors: string[] = [];
  const tokens: string[] = [];
  const sourceFor = (token: string): UfValueSource => ({
    async valuesBetween() {
      tokens.push(token);
      if (token === UF_SMOKE_INVALID_TOKEN) {
        throw new AppError("UF_SOURCE_AUTH_INVALID", "rechazado");
      }
      if (values instanceof Error) throw values;
      return values;
    },
  });
  return {
    out,
    errors,
    tokens,
    deps: {
      token: TOKEN as string | undefined,
      sourceFor,
      now: () => NOW,
      print: (line: string) => out.push(line),
      printError: (line: string) => errors.push(line),
    },
  };
}

describe("pnpm uf:smoke", () => {
  it("muestra la UF de hoy, si trae días futuros y cómo responde un token inventado, sin el token", async () => {
    const t = setup([
      { date: "2026-10-09", value: "41130.94" },
      { date: "2026-10-10", value: "41132.30" },
    ]);

    await expect(runUfSmoke(t.deps)).resolves.toBe(0);

    const all = [...t.out, ...t.errors].join("\n");
    expect(all).toContain("UF de hoy (2026-10-09): 41130.94");
    expect(all).toContain("Trae 1 días futuros");
    expect(all).toContain("Con un token inventado: UF_SOURCE_AUTH_INVALID");
    expect(all).not.toContain(TOKEN);
    expect(t.tokens).toEqual([TOKEN, UF_SMOKE_INVALID_TOKEN]);
  });

  it("sin el valor de hoy o con un error sale con 1", async () => {
    const missing = setup([{ date: "2026-10-08", value: "41126.12" }]);
    await expect(runUfSmoke(missing.deps)).resolves.toBe(1);

    const failing = setup(
      new AppError("UF_VALUE_UNAVAILABLE", "sin conexión", { retriable: true }),
    );
    await expect(runUfSmoke(failing.deps)).resolves.toBe(1);
    expect(failing.errors.join("\n")).toContain("UF_VALUE_UNAVAILABLE");
  });

  it("sin token no consulta nada", async () => {
    const t = setup([]);
    t.deps.token = undefined;

    await expect(runUfSmoke(t.deps)).resolves.toBe(1);
    expect(t.tokens).toEqual([]);
  });
});
