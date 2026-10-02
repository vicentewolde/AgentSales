import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@agentsales/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeClock, harness, simulateWorker } from "../../test/harness.js";
import { createApiClient } from "../api-client.js";
import { createColors } from "../colors.js";
import { IMPORT_WAIT, type ImportDeps, type ImportOptions, runImport } from "./import.js";

let dir: string;

beforeEach(() => {
  // Archivos vacíos: la CLI solo verifica que existan; los lee el worker.
  dir = mkdtempSync(join(tmpdir(), "agentsales-cli-import-"));
  writeFileSync(join(dir, "propiedades.xlsx"), "");
  mkdirSync(join(dir, "medios"));
  writeFileSync(join(dir, "medios.zip"), "");
  writeFileSync(join(dir, "notas.txt"), "");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Harness = ReturnType<typeof harness>;

function run(
  h: Harness,
  clock: ReturnType<typeof fakeClock>,
  options: ImportOptions & { xlsx?: string; wait_?: ImportDeps["wait"] } = {},
) {
  const { xlsx = "propiedades.xlsx", wait_, ...rest } = options;
  return runImport(
    { ...h.io, client: h.client, cwd: dir, sleep: clock.sleep, now: clock.now, wait: wait_ },
    xlsx,
    rest,
  );
}

describe("runImport", () => {
  it("encola por /imports/local y consulta cada 2 s hasta que termina", async () => {
    const h = harness();
    const worker = simulateWorker(h);
    const clock = fakeClock(async (elapsed) => {
      if (elapsed === 4_000) await worker.start();
      if (elapsed === 8_000) await worker.finish();
    });

    const code = await run(h, clock, { media: "medios" });

    expect(code).toBe(1); // una fila con errores
    expect(clock.sleeps).toEqual([2_000, 2_000, 2_000, 2_000]);
    expect(h.queue.jobs).toHaveLength(1);
    expect(h.queue.jobs[0]?.name).toBe("import.run");
    const [created] = await h.importRuns.list();
    expect(h.requests.filter((r) => r === `GET /imports/${created?.id}`)).toHaveLength(4);
    expect(h.out[0]).toBe(`Carga ${created?.id} (propiedades.xlsx): en cola…`);
    expect(h.out).toContain("procesando…");
    expect(h.text()).toContain("terminada");
  });

  it("al terminar muestra el resumen y la tabla de errores por fila y columna", async () => {
    const h = harness();
    const worker = simulateWorker(h);
    const clock = fakeClock(async () => {
      await worker.start();
      await worker.finish();
    });

    expect(await run(h, clock, { media: "medios" })).toBe(1);

    const text = h.text();
    expect(text).toContain("Archivo: propiedades.xlsx · medios: medios");
    expect(text).toContain("Corredor: marca (creado)");
    expect(text).toContain("Propiedades: creadas 2 · actualizadas 0 · sin cambios 0 · con error 1");
    expect(text).toContain("Medios: subidos 3 · ya estaban 0 · omitidos 1 · con error 0");
    expect(text).toContain("Errores (1)");
    expect(text).toMatch(/Fila\s+Propiedad\s+Columna\s+Motivo/);
    expect(text).toMatch(/5\s+P-003\s+precio\s+Falta el precio/);
    expect(text).toContain("Fila 4 (P-002): Sin fotos: queda en borrador");
  });

  it("sin filas con error sale con 0", async () => {
    const h = harness();
    const report = {
      headers: { unknown: [], missing: [], duplicated: [] },
      broker: null,
      rows: [],
      media: { filesUploaded: 0, filesExisting: 0, filesSkipped: 0, filesFailed: 0 },
    };
    const worker = simulateWorker(h, report);
    const clock = fakeClock(async () => {
      await worker.start();
      await worker.finish();
    });

    expect(await run(h, clock)).toBe(0);
  });

  it("una carga que falla muestra el error y sale con 1", async () => {
    const h = harness();
    const worker = simulateWorker(h);
    const clock = fakeClock(() => worker.fail("BROKER_INVALID", "La hoja Corredor tiene errores"));

    expect(await run(h, clock)).toBe(1);
    expect(h.text()).toContain("falló");
    expect(h.text()).toContain("Error: BROKER_INVALID: La hoja Corredor tiene errores");
  });

  it("si sigue en cola a los 20 s avisa una sola vez que revise el worker", async () => {
    const h = harness();
    const worker = simulateWorker(h);
    const clock = fakeClock(async (elapsed) => {
      if (elapsed === 30_000) {
        await worker.start();
        await worker.finish();
      }
    });

    await run(h, clock);

    const warning = "Sigue en cola: ¿está corriendo el worker? (pnpm dev)";
    expect(h.out.filter((line) => line === warning)).toHaveLength(1);
    // Llega con la consulta de los 20 s, no antes.
    expect(h.out.indexOf(warning)).toBe(1);
    expect(clock.sleeps).toHaveLength(15);
  });

  it("deja de esperar al pasar el tope y dice cómo seguir la carga", async () => {
    const h = harness();
    const clock = fakeClock();

    const code = await run(h, clock, { wait_: { maxWaitMs: 10_000 } });

    const [created] = await h.importRuns.list();
    expect(code).toBe(1);
    expect(clock.sleeps).toHaveLength(5);
    expect(h.out.at(-1)).toBe(
      `Sigue en curso: revisa más tarde con agentsales imports ${created?.id}`,
    );
  });

  it("los tiempos son los del spec: cada 2 s, aviso a los 20 s y tope de 2 h", () => {
    expect(IMPORT_WAIT).toMatchObject({
      pollMs: 2_000,
      queuedWarningMs: 20_000,
      maxWaitMs: 7_200_000,
    });
  });

  it("--no-wait imprime solo el id y sale sin consultar", async () => {
    const h = harness();
    const clock = fakeClock();

    expect(await run(h, clock, { wait: false })).toBe(0);

    const [created] = await h.importRuns.list();
    expect(h.out).toEqual([created?.id]);
    expect(h.errors()).toContain(`agentsales imports ${created?.id}`);
    expect(clock.sleeps).toEqual([]);
    expect(h.requests).toEqual(["POST /imports/local"]);
  });

  it("resuelve las rutas relativas contra la carpeta del operador (INIT_CWD)", async () => {
    const h = harness();

    await run(h, fakeClock(), { xlsx: "./propiedades.xlsx", media: "medios/", wait: false });

    const [created] = await h.importRuns.list();
    expect(created?.input).toEqual({
      xlsxPath: join(dir, "propiedades.xlsx"),
      mediaDir: join(dir, "medios"),
      broker: null,
    });
  });

  it("acepta un .zip de medios, --broker como slug y --dry-run", async () => {
    const h = harness();

    await run(h, fakeClock(), {
      xlsx: join(dir, "propiedades.xlsx"),
      media: "medios.zip",
      broker: "Mi Corredor",
      dryRun: true,
      wait: false,
    });

    const [created] = await h.importRuns.list();
    expect(created?.input).toMatchObject({
      mediaDir: join(dir, "medios.zip"),
      broker: "mi-corredor",
    });
    expect(created?.dryRun).toBe(true);
  });

  it.each([
    [{ xlsx: "no-existe.xlsx" }, "IMPORT_FILE_NOT_FOUND: No existe el archivo"],
    [{ xlsx: "notas.txt" }, "IMPORT_FILE_INVALID"],
    [{ xlsx: "medios" }, "IMPORT_FILE_INVALID"],
    [{ media: "otra-carpeta" }, "MEDIA_FOLDER_NOT_FOUND"],
    [{ media: "notas.txt" }, "MEDIA_FOLDER_INVALID"],
    [{ broker: "---" }, "BROKER_INVALID"],
  ] as const)("%j es un error antes de llamar a la API", async (options, message) => {
    const h = harness();

    expect(await run(h, fakeClock(), options)).toBe(1);

    expect(h.errors()).toContain(`✗ ${message}`);
    expect(h.requests).toEqual([]);
    expect(h.out).toEqual([]);
  });

  it("con la API caída lo dice claro, sin stack trace, y sale con 1", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const out: string[] = [];
    const err: string[] = [];

    const code = await runImport(
      {
        print: (text) => out.push(text),
        printError: (text) => err.push(text),
        colors: createColors(false),
        client: createApiClient(port, { timeoutMs: 2_000 }),
        cwd: dir,
        ...fakeClock(),
      },
      "propiedades.xlsx",
    );

    expect(code).toBe(1);
    expect(err.join("\n")).toBe(
      "✗ La API no responde: nadie escucha en ese puerto (ECONNREFUSED)\n  → Levántala con pnpm dev",
    );
  });

  it("sin cargas locales en la API (fuera de desarrollo) sugiere pnpm dev o el panel", async () => {
    const h = harness({ deps: { localImports: false } });

    expect(await run(h, fakeClock())).toBe(1);
    expect(h.errors()).toContain("✗ LOCAL_IMPORTS_DISABLED");
    expect(h.errors()).toContain(
      "→ Levanta la API con pnpm dev, o sube los archivos desde el panel",
    );
  });

  it("con la cola caída muestra QUEUE_UNAVAILABLE y cómo arreglarlo", async () => {
    const h = harness({
      deps: {
        queue: {
          enqueue: async () => {
            throw new AppError("QUEUE_UNAVAILABLE", "La cola no responde", { retriable: true });
          },
        },
      },
    });

    expect(await run(h, fakeClock())).toBe(1);
    expect(h.errors()).toBe(
      "✗ QUEUE_UNAVAILABLE: La cola no responde\n  → Arranca el worker (pnpm dev) y reintenta",
    );
  });

  it("una consulta que falla se reintenta; tres seguidas, deja de esperar", async () => {
    let failing = 0;
    const h = harness({
      beforeRequest: (_url, method) => {
        if (method === "GET" && failing > 0) {
          failing -= 1;
          throw new TypeError("fetch failed");
        }
      },
    });
    const worker = simulateWorker(h);
    failing = 2;
    const clock = fakeClock(async (elapsed) => {
      if (elapsed === 6_000) {
        await worker.start();
        await worker.finish();
      }
    });

    await run(h, clock);
    expect(h.text()).toContain("terminada");

    const again = harness({
      beforeRequest: (_url, method) => {
        if (method === "GET") throw new TypeError("fetch failed");
      },
    });
    const clock2 = fakeClock();
    expect(await run(again, clock2)).toBe(1);
    expect(clock2.sleeps).toHaveLength(3);
    expect(again.errors()).toContain(
      "Dejé de esperar; revisa la carga más tarde con agentsales imports",
    );
    expect(again.errors()).toContain("✗ La API no responde: fetch failed");
  });

  it("el contador de fallas vuelve a cero cuando una consulta responde", async () => {
    // Por consulta: falla, falla, responde, falla, falla, responde (ya terminada).
    const outcomes = [false, false, true, false, false, true];
    const h = harness({
      beforeRequest: (_url, method) => {
        if (method === "GET" && outcomes.shift() === false) throw new TypeError("fetch failed");
      },
    });
    const worker = simulateWorker(h);
    const clock = fakeClock(async (elapsed) => {
      if (elapsed === 12_000) {
        await worker.start();
        await worker.finish();
      }
    });

    await run(h, clock);

    expect(clock.sleeps).toHaveLength(6);
    expect(h.text()).toContain("terminada");
    expect(h.errors()).toBe("");
  });

  it("un error de la API al consultar (no transitorio) corta de inmediato", async () => {
    const h = harness();
    // La carga ya no existe (por ejemplo, la API apunta a otra base): 404 al consultar.
    h.importRuns.get = async () => null;
    const clock = fakeClock();

    expect(await run(h, clock)).toBe(1);
    expect(clock.sleeps).toHaveLength(1);
    expect(h.errors()).toContain("✗ IMPORT_RUN_NOT_FOUND");
    expect(h.errors()).not.toContain("Dejé de esperar");
  });
});
