import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  CONTENT_TMP_MAX_AGE_MS,
  cleanContentTmp,
  contentTmpRootOf,
  createAttemptDir,
} from "./content-tmp.js";

async function newRoot() {
  const root = await mkdtemp(join(tmpdir(), "agentsales-content-tmp-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Un directorio de corrida con un archivo, con fecha de hace `ageMs`. */
async function runDir(root: string, ageMs: number, name: string = randomUUID()) {
  const dir = join(root, name, randomUUID());
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "trabajo.tmp"), "x");
  const when = new Date(Date.now() - ageMs);
  await utimes(join(root, name), when, when);
  return name;
}

describe("temporales de contenido", () => {
  it("viven en <workspace>/tmp/content", () => {
    expect(contentTmpRootOf("/repo")).toBe("/repo/tmp/content");
  });

  it("cada intento tiene su directorio; al borrarlo se va también el de la corrida vacío", async () => {
    const root = await newRoot();
    const runId = randomUUID();

    const first = await createAttemptDir(root, runId);
    const second = await createAttemptDir(root, runId);
    expect(first.path).not.toBe(second.path);
    expect(existsSync(first.path) && existsSync(second.path)).toBe(true);

    // Otro intento de la misma corrida sigue: el de la corrida queda.
    await first.remove();
    expect(await readdir(join(root, runId))).toHaveLength(1);
    await second.remove();
    expect(await readdir(root)).toEqual([]);
    // Borrar dos veces no falla.
    await second.remove();
  });

  it("rechaza un id de corrida que no es uuid (arma una ruta)", async () => {
    await expect(createAttemptDir(await newRoot(), "../fuera")).rejects.toThrow("inválido");
  });

  it("al arrancar borra los de más de 24 h y deja los recientes y lo que no es de una corrida", async () => {
    const root = await newRoot();
    const old = await runDir(root, CONTENT_TMP_MAX_AGE_MS + 60_000);
    const recent = await runDir(root, 60 * 60 * 1000);
    const foreign = await runDir(root, CONTENT_TMP_MAX_AGE_MS + 60_000, "no-es-uuid");
    await writeFile(join(root, "suelto.txt"), "x");

    expect(await cleanContentTmp(root)).toEqual([old]);
    expect((await readdir(root)).sort()).toEqual([recent, foreign, "suelto.txt"].sort());
  });

  it("sin la carpeta todavía, no hay nada que borrar", async () => {
    expect(await cleanContentTmp(join(await newRoot(), "no-existe"))).toEqual([]);
  });
});
