import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@agentsales/core";
import { createInMemoryJobQueue } from "@agentsales/core/testing";
import { BACKUP_STATUS_FILE, type ProcessRunner } from "@agentsales/db/backup";
import { afterEach, describe, expect, it } from "vitest";
import { captureLogger } from "../../test/content-fixture.js";
import {
  DB_BACKUP_KEY,
  DB_BACKUP_QUEUE,
  DB_BACKUP_SCHEDULE,
  dbBackupJob,
  requestBackupIfDue,
} from "./db-backup.js";
import { registerJobs, type WorkerBoss } from "./registry.js";

// F6-T14 (spec F6 §4.11): el job `db.backup` con un `pg_dump` falso.

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

async function setup(run: ProcessRunner) {
  const dir = await tempDir();
  const { logger, lines } = captureLogger();
  const boss = fakeBoss();
  const job = dbBackupJob({
    dir,
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

  it("respalda y registra el archivo, sin la conexión", async () => {
    const { dir, lines, run } = await setup(okRunner);

    await run();

    expect((await readdir(dir)).sort()).toEqual(
      [BACKUP_STATUS_FILE, "agentsales-20261015-1300.dump"].sort(),
    );
    expect(lines.find((line) => line.msg === "respaldo de la base listo")).toMatchObject({
      file: "agentsales-20261015-1300.dump",
    });
    expect(JSON.stringify(lines)).not.toContain("clave-secreta");
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

describe("requestBackupIfDue (arranque)", () => {
  const status = (lastSuccessAt: string | null) =>
    JSON.stringify({ lastSuccessAt, lastFile: null, lastFailureAt: null, lastFailureCode: null });

  it("encola si no hay respaldo o el último tiene más de 20 h; si es reciente, no", async () => {
    const queue = createInMemoryJobQueue();
    const dir = await tempDir();
    const deps = { dir, findTool: (tool: string) => `/fake/${tool}`, now: () => NOW };

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
      dir: await tempDir(),
      findTool: () => {
        throw new AppError("BACKUP_TOOL_NOT_INSTALLED", "no está");
      },
      now: () => NOW,
    });

    expect(decision).toBe("tool_missing");
    expect(queue.jobs).toEqual([]);
  });
});
