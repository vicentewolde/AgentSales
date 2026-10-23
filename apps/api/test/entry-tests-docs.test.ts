import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findWorkspaceRoot } from "@agentsales/config";
import { ENTRY_TESTS, POST_PLATFORMS } from "@agentsales/core";
import { describe, expect, it } from "vitest";

// F9.5-T27: la «Lista para publicar a diario» dice si la prueba de entrada de cada red está hecha
// leyendo `ENTRY_TESTS` (core), que repite lo anotado en la nota de la red. Este test lee las notas
// y falla si el registro y ellas no dicen lo mismo: una prueba cuenta como hecha solo si su nota
// tiene «Resultado de Sx» o «Sx pasó», con la misma fecha.

const root = findWorkspaceRoot();

describe("las pruebas de entrada (F9.5-T27)", () => {
  it("ENTRY_TESTS dice lo mismo que las notas de cada red", async () => {
    for (const platform of POST_PLATFORMS) {
      const test = ENTRY_TESTS[platform];
      const note = await readFile(join(root, test.doc), "utf8");
      for (const code of test.codes) {
        const noted = note.includes(`Resultado de ${code}`) || note.includes(`${code} pasó`);
        if (test.passedOn === null) {
          expect(noted, `${platform}: ${code} no tiene resultado en ${test.doc}`).toBe(false);
        } else {
          expect(noted, `${platform}: ${code} debe estar anotada en ${test.doc}`).toBe(true);
          expect(note, `${platform}: la fecha de ${code}`).toContain(test.passedOn);
        }
      }
    }
  });
});
