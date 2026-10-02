import { describe, expect, it } from "vitest";
import { ApiCallError } from "./api-client.js";
import { createColors } from "./colors.js";
import { CliError, formatBytes, guarded, renderFailure, renderTable } from "./output.js";

const plain = createColors(false);
const c = createColors(true);

describe("renderFailure", () => {
  it("un error de la CLI es CODE: mensaje con su sugerencia", () => {
    expect(renderFailure(new CliError("X_FAILED", "algo pasó", "haz esto"), plain)).toBe(
      "✗ X_FAILED: algo pasó\n  → haz esto",
    );
  });

  it("si la API no respondió, lo dice y sugiere levantarla", () => {
    expect(renderFailure(new ApiCallError("sin respuesta en 30 s", "TIMEOUT"), plain)).toBe(
      "✗ La API no responde: sin respuesta en 30 s\n  → Levántala con pnpm dev",
    );
  });

  it.each([
    ["DB_UNAVAILABLE", "Neon puede estar despertando"],
    ["QUEUE_UNAVAILABLE", "Arranca el worker"],
    ["STORAGE_UNAVAILABLE", "pnpm storage:check"],
    ["HOST_NOT_ALLOWED", "API_PORT"],
  ])("%s trae su sugerencia", (code, hint) => {
    const text = renderFailure(new ApiCallError(`${code}: mensaje`, code, 503), plain);
    expect(text?.split("\n")[0]).toBe(`✗ ${code}: mensaje`);
    expect(text?.split("\n")[1]).toContain(hint);
  });

  it("un error de la API sin sugerencia es una sola línea", () => {
    expect(
      renderFailure(new ApiCallError("REQUEST_INVALID: x", "REQUEST_INVALID", 400), plain),
    ).toBe("✗ REQUEST_INVALID: x");
  });

  it("otro error no es esperable: devuelve null", () => {
    expect(renderFailure(new Error("bug"), plain)).toBeNull();
  });
});

describe("guarded", () => {
  const io = () => {
    const err: string[] = [];
    return { err, io: { print: () => {}, printError: (t: string) => err.push(t), colors: plain } };
  };

  it("un fallo esperable se muestra y sale con 1", async () => {
    const { err, io: deps } = io();
    expect(
      await guarded(deps, async () => {
        throw new CliError("X", "y");
      }),
    ).toBe(1);
    expect(err).toEqual(["✗ X: y"]);
  });

  it("un bug sigue su curso", async () => {
    const { io: deps } = io();
    await expect(
      guarded(deps, async () => {
        throw new TypeError("bug");
      }),
    ).rejects.toThrow("bug");
  });
});

describe("renderTable", () => {
  it("alinea las columnas sin contar los colores, y no rellena la última", () => {
    const text = renderTable(
      ["A", "Bb", "C"],
      [
        [c.red("xyz"), "1", "último"],
        ["w", "22", "x"],
      ],
      plain,
    );
    expect(text.split("\n")).toEqual(["A    Bb  C", `${c.red("xyz")}  1   último`, "w    22  x"]);
  });
});

describe("formatBytes", () => {
  it.each([
    [512, "512 B"],
    [1536, "1,5 kB"],
    [1_258_291, "1,2 MB"],
    [3 * 1024 ** 3, "3,0 GB"],
  ])("%d → %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
