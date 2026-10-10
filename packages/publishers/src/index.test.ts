import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("@agentsales/publishers (raíz)", () => {
  it("no carga Marketplace ni Playwright: la API importa la raíz (spec F5 §4.1)", async () => {
    const index = await readFile(join(import.meta.dirname, "index.ts"), "utf8");

    expect(index).not.toMatch(/marketplace/i);
    expect(index).not.toMatch(/playwright/i);
  });
});
