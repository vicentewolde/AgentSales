import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findWorkspaceRoot } from "@agentsales/config";
import { ENTRY_TESTS, POST_PLATFORMS } from "@agentsales/core";
import { describe, expect, it } from "vitest";

// F9.5-T27: la «Lista para publicar a diario» dice si la prueba de entrada de cada red está hecha
// leyendo `ENTRY_TESTS` (core), que repite lo anotado en la nota de la red. Cada nota lleva una
// línea legible por máquina por prueba (`<!-- entry-test: S4 passed 2026-10-21 -->` o
// `<!-- entry-test: S2 pending -->`); este test la lee y falla si el registro no dice lo mismo.

const root = findWorkspaceRoot();
const MARKER = /<!-- entry-test: (S\d) (passed (\d{4}-\d{2}-\d{2})|pending) -->/g;

/** Las líneas de una nota: código → día en que pasó, o `null` si sigue pendiente. */
function entryTestMarkers(note: string): Map<string, string | null> {
  const found = new Map<string, string | null>();
  for (const match of note.matchAll(MARKER)) {
    const [, code, , day] = match;
    if (code === undefined) continue;
    if (found.has(code)) throw new Error(`${code} anotada dos veces`);
    found.set(code, day ?? null);
  }
  return found;
}

describe("las pruebas de entrada (F9.5-T27)", () => {
  it("lee las líneas de una nota", () => {
    const markers = entryTestMarkers(
      "x\n<!-- entry-test: S2 pending -->\n<!-- entry-test: S4 passed 2026-10-21 -->\n",
    );
    expect([...markers]).toEqual([
      ["S2", null],
      ["S4", "2026-10-21"],
    ]);
    expect(() =>
      entryTestMarkers("<!-- entry-test: S2 pending -->\n<!-- entry-test: S2 pending -->"),
    ).toThrow("dos veces");
  });

  it("ENTRY_TESTS dice lo mismo que la línea de cada nota", async () => {
    for (const platform of POST_PLATFORMS) {
      const test = ENTRY_TESTS[platform];
      const markers = entryTestMarkers(await readFile(join(root, test.doc), "utf8"));
      expect([...markers.keys()], `${platform}: las pruebas de ${test.doc}`).toEqual(test.codes);
      for (const code of test.codes) {
        expect(markers.get(code), `${platform}: ${code} en ${test.doc}`).toBe(test.passedOn);
      }
    }
  });

  it("ninguna nota dice que una prueba pasada sigue pendiente", async () => {
    for (const platform of POST_PLATFORMS) {
      const test = ENTRY_TESTS[platform];
      if (test.passedOn === null) continue;
      const note = await readFile(join(root, test.doc), "utf8");
      for (const code of test.codes) {
        expect(note, `${platform}: ${test.doc}`).not.toMatch(
          new RegExp(`\\*\\*${code} (sigue )?pendiente`),
        );
      }
    }
  });
});
