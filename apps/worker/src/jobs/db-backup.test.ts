import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, type BackupStatus } from "@agentsales/core";
import { createInMemoryJobQueue, createInMemoryMediaStorage } from "@agentsales/core/testing";
import { BACKUP_STATUS_FILE, type ProcessRunner, readBackupStatus } from "@agentsales/db/backup";
import { QUEUE_SCHEMA } from "@agentsales/queue";
import {
  BACKUP_STATUS_PATH,
  readStoredBackupStatus,
  writeStoredBackupStatus,
} from "@agentsales/storage";
import { afterEach, describe, expect, it } from "vitest";
import { captureLogger } from "../../test/content-fixture.js";
import {
  BACKUP_OBJECT_PREFIX,
  type BackupTarget,
  backupStatusOf,
  DB_BACKUP_KEY,
  DB_BACKUP_QUEUE,
  DB_BACKUP_SCHEDULE,
  dbBackupJob,
  requestBackupIfDue,
} from "./db-backup.js";
import { registerJobs, type WorkerBoss } from "./registry.js";

// F6-T14 (spec F6 §4.11) y F8-T13 (spec F8 §4.9): el job `db.backup` con un `pg_dump` falso y, para
// R2, dobles en memoria de los dos buckets. Nunca se conecta a una base ni a R2.

const SECRET_URL = "postgresql://u:clave-secreta@ep-x.neon.tech/neondb?sslmode=require";
const NOW = new Date("2026-10-15T16:00:00.000Z");

const temporaries: string[] = [];
afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "agentsales-db-backup-"));
  temporaries.push(dir);
  return dir;
}

function fakeBoss() {
  const bossCalls: { name: string; args: unknown[] }[] = [];
  let work: Parameters<WorkerBoss["work"]>[2] | undefined;
  const boss: WorkerBoss = {
    createQueue: async (...args) => {
      bossCalls.push({ name: "createQueue", args });
    },
    updateQueue: async () => {},
    getQueue: async () => ({ policy: "exclusive" }),
    work: async (_name, _options, handler) => {
      work = handler;
      return "w1";
    },
    schedule: async (...args) => {
      bossCalls.push({ name: "schedule", args });
    },
  };
  const run = () => work?.([{ id: "job-1", data: {}, retryCount: 0, retryLimit: 1 }]);
  return { boss, bossCalls, run };
}

const okRunner: ProcessRunner = async (command, args) => {
  if (command.endsWith("pg_dump")) {
    await writeFile(args[args.indexOf("-f") + 1] ?? "", "PGDMP");
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  return { exitCode: 0, stdout: "; Archive created", stderr: "" };
};

async function setup(run: ProcessRunner, target?: BackupTarget) {
  const dir = await tempDir();
  const { logger, lines } = captureLogger();
  const boss = fakeBoss();
  const job = dbBackupJob({
    target: target ?? { kind: "local", dir },
    databaseUrl: SECRET_URL,
    signal: new AbortController().signal,
    run,
    findTool: (tool) => `/fake/${tool}`,
    now: () => NOW,
  });
  await registerJobs(boss.boss, [job], logger);
  return { dir, lines, ...boss };
}

describe("db.backup", () => {
  it("la cola es exclusive con 1 reintento y 15 min, y el cron corre a las 13:00 de Chile", async () => {
    const { bossCalls } = await setup(okRunner);

    expect(DB_BACKUP_QUEUE).toEqual({
      policy: "exclusive",
      retryLimit: 1,
      retryDelay: 300,
      retryBackoff: false,
      expireInSeconds: 900,
    });
    expect(bossCalls).toEqual([
      { name: "createQueue", args: ["db.backup", DB_BACKUP_QUEUE] },
      {
        name: "schedule",
        args: [
          "db.backup",
          "0 13 * * *",
          {},
          { tz: "America/Santiago", missed: "skip", singletonKey: DB_BACKUP_KEY },
        ],
      },
    ]);
    expect(DB_BACKUP_SCHEDULE.singletonKey).toBe(DB_BACKUP_KEY);
  });

  it("respalda sin el esquema de la cola (QUEUE_SCHEMA) y registra el archivo, sin la conexión", async () => {
    const args: string[][] = [];
    const { dir, lines, run } = await setup(async (command, commandArgs, options) => {
      args.push([...commandArgs]);
      return okRunner(command, commandArgs, options);
    });

    await run();

    expect((await readdir(dir)).sort()).toEqual(
      [BACKUP_STATUS_FILE, "agentsales-20261015-1300.dump"].sort(),
    );
    expect(lines.find((line) => line.msg === "respaldo de la base listo")).toMatchObject({
      file: "agentsales-20261015-1300.dump",
    });
    expect(JSON.stringify(lines)).not.toContain("clave-secreta");
    expect(args[0]).toContain(`--exclude-schema=${QUEUE_SCHEMA}`);
  });

  it("una falla sube para el reintento y el log lleva solo el código", async () => {
    const { lines, run } = await setup(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: `could not connect to ${SECRET_URL}`,
    }));

    await expect(run()).rejects.toMatchObject({ code: "BACKUP_FAILED", retriable: true });
    expect(lines.find((line) => line.level === 50)).toMatchObject({ code: "BACKUP_FAILED" });
    expect(JSON.stringify(lines)).not.toContain("clave-secreta");
  });
});

describe("db.backup a R2 (F8-T13)", () => {
  /** Los dos buckets en memoria y una carpeta temporal propia, para ver que no queda nada. */
  async function r2Setup(run: ProcessRunner = okRunner) {
    const backups = createInMemoryMediaStorage();
    const media = createInMemoryMediaStorage();
    const tmpRoot = await tempDir();
    const target: BackupTarget = { kind: "r2", backups, status: media, tmpRoot };
    return { backups, media, tmpRoot, ...(await setup(run, target)) };
  }

  const dumpKey = (day: number) =>
    `${BACKUP_OBJECT_PREFIX}agentsales-202609${String(day).padStart(2, "0")}-1300.dump`;

  it("sube el volcado comprobado al bucket de respaldos, guarda el estado en system/ y no deja nada en el disco", async () => {
    const { backups, media, tmpRoot, lines, run } = await r2Setup();

    await run();

    expect([...backups.objects.keys()]).toEqual(["db/agentsales-20261015-1300.dump"]);
    const dump = backups.objects.get("db/agentsales-20261015-1300.dump");
    expect(new TextDecoder().decode(dump?.body)).toBe("PGDMP");
    // El sha256 del volcado va con la subida: R2 rechaza un contenido distinto.
    expect(dump?.sha256).toBe("b5a26a21290c39819235a235b8ed66b3bd98ed90c8316c8949bfbb7419cac878");
    expect([...media.objects.keys()]).toEqual([BACKUP_STATUS_PATH]);
    expect(await readStoredBackupStatus(media)).toEqual({
      lastSuccessAt: NOW.toISOString(),
      lastFile: "agentsales-20261015-1300.dump",
      lastFailureAt: null,
      lastFailureCode: null,
    });
    // Ni el estado ni los volcados van al bucket de respaldos, y la carpeta temporal se borra.
    expect(backups.objects.has(BACKUP_STATUS_PATH)).toBe(false);
    expect(await readdir(tmpRoot)).toEqual([]);
    expect(lines.find((line) => line.msg === "respaldo de la base listo")).toMatchObject({
      file: "agentsales-20261015-1300.dump",
      target: "r2",
      deleted: 0,
    });
  });

  it("un volcado que no se lee no se sube, y el estado anota la falla sin perder el último bueno", async () => {
    const { backups, media, tmpRoot, run } = await r2Setup(async (command, args, options) =>
      command.endsWith("pg_restore")
        ? { exitCode: 1, stdout: "", stderr: "pg_restore: input file is too short" }
        : okRunner(command, args, options),
    );
    const good: BackupStatus = {
      lastSuccessAt: "2026-10-14T16:00:00.000Z",
      lastFile: "agentsales-20261014-1300.dump",
      lastFailureAt: null,
      lastFailureCode: null,
    };
    await writeStoredBackupStatus(media, good);

    await expect(run()).rejects.toMatchObject({ code: "BACKUP_FAILED", retriable: true });

    expect(backups.objects.size).toBe(0);
    expect(backups.uploads).toEqual([]);
    expect(await readStoredBackupStatus(media)).toEqual({
      ...good,
      lastFailureAt: NOW.toISOString(),
      lastFailureCode: "BACKUP_FAILED",
    });
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("deja los últimos 14 en el bucket y no toca otros objetos", async () => {
    const { backups, run } = await r2Setup();
    for (let day = 1; day <= 14; day += 1) {
      await backups.put(
        dumpKey(day),
        new TextEncoder().encode("viejo"),
        "application/octet-stream",
      );
    }
    await backups.put("db/notas.txt", new TextEncoder().encode("x"), "text/plain");
    await backups.put("otro/agentsales-20260901-1300.dump", new Uint8Array(1), "x");

    await run();

    const dumps = [...backups.objects.keys()].filter((key) => key.endsWith(".dump")).sort();
    expect(dumps.filter((key) => key.startsWith("db/"))).toHaveLength(14);
    expect(backups.objects.has(dumpKey(1))).toBe(false);
    expect(backups.objects.has(dumpKey(2))).toBe(true);
    expect(backups.objects.has("db/agentsales-20261015-1300.dump")).toBe(true);
    expect(backups.objects.has("db/notas.txt")).toBe(true);
    expect(backups.objects.has("otro/agentsales-20260901-1300.dump")).toBe(true);
  });

  it("si R2 no recibe el volcado: falla para el reintento, anota el código y no borra los viejos", async () => {
    const backups = createInMemoryMediaStorage({
      failUpload: () => new AppError("STORAGE_UNAVAILABLE", "R2 no responde", { retriable: true }),
    });
    const media = createInMemoryMediaStorage();
    const tmpRoot = await tempDir();
    await backups.objects.set(dumpKey(1), { body: new Uint8Array(1), contentType: "x" });
    const { lines, run } = await setup(okRunner, { kind: "r2", backups, status: media, tmpRoot });

    await expect(run()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", retriable: true });

    expect([...backups.objects.keys()]).toEqual([dumpKey(1)]);
    expect((await readStoredBackupStatus(media))?.lastFailureCode).toBe("STORAGE_UNAVAILABLE");
    expect(lines.find((line) => line.level === 50)).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(await readdir(tmpRoot)).toEqual([]);
  });

  it("backupStatusOf lee el estado de donde queda el respaldo", async () => {
    const media = createInMemoryMediaStorage();
    const dir = await tempDir();
    const status: BackupStatus = {
      lastSuccessAt: NOW.toISOString(),
      lastFile: "agentsales-20261015-1300.dump",
      lastFailureAt: null,
      lastFailureCode: null,
    };
    await writeStoredBackupStatus(media, status);

    const r2: BackupTarget = { kind: "r2", backups: createInMemoryMediaStorage(), status: media };
    expect(await backupStatusOf(r2)()).toEqual(status);
    expect(await backupStatusOf({ kind: "local", dir })()).toBeNull();
    expect(await readBackupStatus(dir)).toBeNull();
  });
});

describe("requestBackupIfDue (arranque)", () => {
  const status = (lastSuccessAt: string | null) =>
    JSON.stringify({ lastSuccessAt, lastFile: null, lastFailureAt: null, lastFailureCode: null });

  it("encola si no hay respaldo o el último tiene más de 20 h; si es reciente, no", async () => {
    const queue = createInMemoryJobQueue();
    const dir = await tempDir();
    const deps = {
      readStatus: backupStatusOf({ kind: "local", dir }),
      findTool: (tool: string) => `/fake/${tool}`,
      now: () => NOW,
    };

    expect(await requestBackupIfDue(queue, deps)).toBe("enqueued");
    await writeFile(
      join(dir, BACKUP_STATUS_FILE),
      status(new Date(NOW.getTime() - 19 * 3600_000).toISOString()),
    );
    expect(await requestBackupIfDue(queue, deps)).toBe("recent");
    await writeFile(
      join(dir, BACKUP_STATUS_FILE),
      status(new Date(NOW.getTime() - 21 * 3600_000).toISOString()),
    );
    expect(await requestBackupIfDue(queue, deps)).toBe("enqueued");
    expect(queue.jobs).toMatchObject([
      { name: "db.backup", data: {}, options: { singletonKey: DB_BACKUP_KEY } },
      { name: "db.backup", data: {}, options: { singletonKey: DB_BACKUP_KEY } },
    ]);
  });

  it("sin pg_dump no encola (fallaría en cada arranque)", async () => {
    const queue = createInMemoryJobQueue();
    const decision = await requestBackupIfDue(queue, {
      readStatus: async () => null,
      findTool: () => {
        throw new AppError("BACKUP_TOOL_NOT_INSTALLED", "no está");
      },
      now: () => NOW,
    });

    expect(decision).toBe("tool_missing");
    expect(queue.jobs).toEqual([]);
  });
});
