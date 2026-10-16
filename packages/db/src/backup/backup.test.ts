import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError, isAppError, isBackupStale } from "@agentsales/core";
import { afterEach, describe, expect, it } from "vitest";
import { childEnv, pgEnvFromUrl } from "./connection.js";
import { BACKUP_LOCK_FILE, backupFileName, runBackup } from "./run-backup.js";
import type { ProcessRunner } from "./runner.js";
import { BACKUP_STATUS_FILE, readBackupStatus } from "./status.js";
import {
  canDumpServer,
  DEFAULT_LIBPQ_BIN_DIR,
  findPgTool,
  parsePgToolVersion,
  parseServerVersion,
} from "./tools.js";

// F6-T14 (spec F6 §4.11): el respaldo local con un `pg_dump` falso. Nunca se conecta a una base.

const URL_WITH_SECRET =
  "postgresql://neondb_owner:clave%40secreta@ep-cool-123-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
// 2026-10-15 14:05 en Chile (UTC-3).
const NOW = new Date("2026-10-15T17:05:00.000Z");
const FAKE_TOOL = (tool: string) => `/fake/bin/${tool}`;

const temporaries: string[] = [];
afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentsales-backup-"));
  temporaries.push(dir);
  return dir;
}

type Call = { command: string; args: readonly string[]; env: Record<string, string> };

/** Un `pg_dump` y un `pg_restore` falsos, en proceso: `pg_dump` escribe en `-f`. */
function fakeRunner(
  options: {
    dump?: { exitCode: number; stderr?: string };
    list?: { exitCode: number; stdout?: string };
  } = {},
) {
  const calls: Call[] = [];
  const run: ProcessRunner = async (command, args, { env }) => {
    calls.push({ command, args, env });
    if (command.endsWith("pg_dump")) {
      const out = args[args.indexOf("-f") + 1];
      if (out !== undefined) await writeFile(out, "PGDMP-falso");
      const dump = options.dump ?? { exitCode: 0 };
      return { exitCode: dump.exitCode, stdout: "", stderr: dump.stderr ?? "" };
    }
    const list = options.list ?? { exitCode: 0, stdout: ";\n; Archive created at …\n" };
    return { exitCode: list.exitCode, stdout: list.stdout ?? "", stderr: "" };
  };
  return { run, calls };
}

const backupIn = (dir: string, run: ProcessRunner, now = NOW) =>
  runBackup({
    dir,
    databaseUrl: URL_WITH_SECRET,
    run,
    findTool: FAKE_TOOL,
    now: () => now,
    processEnv: { PATH: "/usr/bin", HOME: "/Users/x", DATABASE_URL: URL_WITH_SECRET, OTRA: "x" },
  });

const caught = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("no falló");
};

const mode = async (path: string) => (await stat(path)).mode & 0o777;

/** Respaldos viejos, uno por día de septiembre. */
async function oldBackups(dir: string, count: number): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const names = Array.from(
    { length: count },
    (_, index) => `agentsales-202609${String(index + 1).padStart(2, "0")}-1300.dump`,
  );
  for (const name of names) await writeFile(join(dir, name), "viejo");
  return names;
}

describe("findPgTool y las versiones", () => {
  it("con PG_BIN_DIR busca solo ahí; sin él, en el PATH y después en libpq de Homebrew", () => {
    const seen: string[] = [];
    const exists = (wanted: string) => (path: string) => {
      seen.push(path);
      return path === wanted;
    };

    expect(
      findPgTool("pg_dump", { binDir: "/opt/pg", isExecutable: exists("/opt/pg/pg_dump") }),
    ).toBe("/opt/pg/pg_dump");
    expect(
      findPgTool("pg_restore", {
        pathEnv: "/usr/local/bin:/usr/bin",
        isExecutable: exists(`${DEFAULT_LIBPQ_BIN_DIR}/pg_restore`),
      }),
    ).toBe(`${DEFAULT_LIBPQ_BIN_DIR}/pg_restore`);
    expect(seen.slice(1)).toEqual([
      "/usr/local/bin/pg_restore",
      "/usr/bin/pg_restore",
      `${DEFAULT_LIBPQ_BIN_DIR}/pg_restore`,
    ]);
  });

  it("sin la herramienta: BACKUP_TOOL_NOT_INSTALLED, no reintentable, con cómo instalarla", () => {
    const error = (() => {
      try {
        findPgTool("pg_dump", { pathEnv: "/usr/bin", isExecutable: () => false });
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(isAppError(error) && error.code).toBe("BACKUP_TOOL_NOT_INSTALLED");
    expect(isAppError(error) && error.retriable).toBe(false);
    expect((error as Error).message).toContain("brew install libpq");
  });

  it("lee las versiones y pg_dump solo vuelca un servidor de su versión mayor o anterior", () => {
    const client = parsePgToolVersion("pg_dump (PostgreSQL) 18.6 (Homebrew)");
    expect(client).toEqual({ major: 18, minor: 6 });
    expect(parseServerVersion("17.5 (Debian 17.5-1)")).toEqual({ major: 17, minor: 5 });
    expect(parsePgToolVersion("otra cosa")).toBeNull();
    if (client === null) throw new Error("sin versión");
    expect(canDumpServer(client, { major: 18, minor: 9 })).toBe(true);
    expect(canDumpServer(client, { major: 19, minor: 0 })).toBe(false);
  });
});

describe("la conexión de pg_dump", () => {
  it("va por variables de entorno: directa (sin -pooler), verify-full y los certificados del sistema", () => {
    expect(pgEnvFromUrl(URL_WITH_SECRET)).toEqual({
      PGHOST: "ep-cool-123.sa-east-1.aws.neon.tech",
      PGUSER: "neondb_owner",
      PGPASSWORD: "clave@secreta",
      PGDATABASE: "neondb",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "system",
      PGCHANNELBINDING: "require",
    });
    expect(pgEnvFromUrl("postgresql://u:p@localhost:5433/app?sslmode=disable")).toEqual({
      PGHOST: "localhost",
      PGPORT: "5433",
      PGUSER: "u",
      PGPASSWORD: "p",
      PGDATABASE: "app",
      PGSSLMODE: "disable",
    });
  });

  it("el proceso hijo no hereda el entorno entero (ni DATABASE_URL)", () => {
    expect(
      childEnv({ PGHOST: "h" }, { PATH: "/usr/bin", DATABASE_URL: "x", ANTHROPIC_API_KEY: "y" }),
    ).toEqual({ PATH: "/usr/bin", PGHOST: "h" });
  });
});

describe("runBackup", () => {
  it("vuelca con los argumentos sin la contraseña, comprueba que se lee, lo deja 0600 en una carpeta 0700 y guarda el estado", async () => {
    const dir = join(await tempDir(), "respaldos");
    const { run, calls } = fakeRunner();

    const result = await backupIn(dir, run);

    expect(result).toMatchObject({
      file: "agentsales-20261015-1405.dump",
      deleted: [],
      pruneFailed: false,
    });
    expect(calls.map((call) => [call.command, call.args])).toEqual([
      [
        "/fake/bin/pg_dump",
        [
          "-Fc",
          "--no-owner",
          "--no-acl",
          "--exclude-schema=pgboss",
          "-f",
          join(dir, "agentsales-20261015-1405.dump.partial"),
        ],
      ],
      ["/fake/bin/pg_restore", ["--list", join(dir, "agentsales-20261015-1405.dump.partial")]],
    ]);
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain("secreta");
    expect(calls[0]?.env).toMatchObject({
      PATH: "/usr/bin",
      PGPASSWORD: "clave@secreta",
      PGSSLMODE: "verify-full",
      PGSSLROOTCERT: "system",
    });
    expect(calls[0]?.env).not.toHaveProperty("DATABASE_URL");
    expect(calls[1]?.env).toEqual({ PATH: "/usr/bin", HOME: "/Users/x" });
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(join(dir, result.file))).toBe(0o600);
    expect((await readdir(dir)).sort()).toEqual([BACKUP_STATUS_FILE, result.file].sort());
    expect(await mode(join(dir, BACKUP_STATUS_FILE))).toBe(0o600);
    expect(await readBackupStatus(dir)).toEqual({
      lastSuccessAt: NOW.toISOString(),
      lastFile: result.file,
      lastFailureAt: null,
      lastFailureCode: null,
    });
  });

  it("después de un éxito deja los últimos 14 y no toca otros archivos de la carpeta", async () => {
    const dir = await tempDir();
    const old = await oldBackups(dir, 15);
    await writeFile(join(dir, "notas.txt"), "mío");

    const result = await backupIn(dir, fakeRunner().run);

    expect(result.deleted).toEqual(old.slice(0, 2));
    const left = (await readdir(dir)).filter((name) => name.endsWith(".dump"));
    expect(left).toHaveLength(14);
    expect(left).toContain(result.file);
    expect(await readFile(join(dir, "notas.txt"), "utf8")).toBe("mío");
  });

  it("si pg_dump falla: BACKUP_FAILED reintentable, la salida redactada, sin .partial y sin borrar los buenos", async () => {
    const dir = await tempDir();
    const old = await oldBackups(dir, 15);
    const { run } = fakeRunner({
      dump: {
        exitCode: 1,
        stderr: `pg_dump: error: connection to ${URL_WITH_SECRET} failed: server version mismatch`,
      },
    });

    const error = await caught(backupIn(dir, run));

    expect(isAppError(error) && error.code).toBe("BACKUP_FAILED");
    expect(isAppError(error) && error.retriable).toBe(true);
    expect((error as Error).message).toContain("server version mismatch");
    expect((error as Error).message).not.toContain("secreta");
    const names = await readdir(dir);
    expect(names.filter((name) => name.endsWith(".partial"))).toEqual([]);
    expect(names.filter((name) => name.endsWith(".dump")).sort()).toEqual(old);
  });

  it("un volcado que no se lee (pg_restore falla o no lista nada) se borra y no desplaza a los buenos", async () => {
    for (const list of [{ exitCode: 1 }, { exitCode: 0, stdout: "  " }]) {
      const dir = await tempDir();
      const old = await oldBackups(dir, 14);

      const error = await caught(backupIn(dir, fakeRunner({ list }).run));

      expect(isAppError(error) && error.code).toBe("BACKUP_FAILED");
      expect((await readdir(dir)).filter((name) => name.includes(".dump")).sort()).toEqual(old);
    }
  });

  it("una falla conserva el último bueno en el estado y anota su código", async () => {
    const dir = await tempDir();
    await backupIn(dir, fakeRunner().run);
    const later = new Date(NOW.getTime() + 24 * 3600_000);

    await caught(backupIn(dir, fakeRunner({ dump: { exitCode: 1 } }).run, later));

    expect(await readBackupStatus(dir)).toEqual({
      lastSuccessAt: NOW.toISOString(),
      lastFile: "agentsales-20261015-1405.dump",
      lastFailureAt: later.toISOString(),
      lastFailureCode: "BACKUP_FAILED",
    });
  });

  it("sin pg_dump: BACKUP_TOOL_NOT_INSTALLED, también en el estado", async () => {
    const dir = await tempDir();
    const error = await caught(
      runBackup({
        dir,
        databaseUrl: URL_WITH_SECRET,
        findTool: () => {
          throw new AppError("BACKUP_TOOL_NOT_INSTALLED", "no está");
        },
        now: () => NOW,
      }),
    );

    expect(isAppError(error) && error.code).toBe("BACKUP_TOOL_NOT_INSTALLED");
    expect((await readBackupStatus(dir))?.lastFailureCode).toBe("BACKUP_TOOL_NOT_INSTALLED");
  });

  it("borra un .partial viejo de un corte, pero no uno reciente (otro respaldo en curso)", async () => {
    const dir = await tempDir();
    const old = join(dir, "agentsales-20261001-1300.dump.partial");
    const recent = join(dir, "agentsales-20261015-1404.dump.partial");
    await writeFile(old, "a medias");
    await writeFile(recent, "en curso");
    const at = (minutesBefore: number) => new Date(NOW.getTime() - minutesBefore * 60_000);
    await utimes(old, at(31), at(31));
    await utimes(recent, at(1), at(1));

    await backupIn(dir, fakeRunner().run);

    expect((await readdir(dir)).filter((name) => name.endsWith(".partial"))).toEqual([
      "agentsales-20261015-1404.dump.partial",
    ]);
  });

  it("con otro respaldo en curso: BACKUP_IN_PROGRESS sin tocar nada; un candado de más de 15 min se toma", async () => {
    const dir = await tempDir();
    const lock = (minutesBefore: number) =>
      writeFile(
        join(dir, BACKUP_LOCK_FILE),
        JSON.stringify({ pid: 1, startedAt: new Date(NOW.getTime() - minutesBefore * 60_000) }),
      );
    await lock(5);
    const { run, calls } = fakeRunner();

    const error = await caught(backupIn(dir, run));

    expect(isAppError(error) && error.code).toBe("BACKUP_IN_PROGRESS");
    expect(isAppError(error) && error.retriable).toBe(true);
    expect(calls).toEqual([]);
    expect(await readBackupStatus(dir)).toBeNull();
    expect(await readdir(dir)).toEqual([BACKUP_LOCK_FILE]);

    await lock(16);
    const result = await backupIn(dir, run);
    expect(result.file).toBe("agentsales-20261015-1405.dump");
    // Al terminar suelta el candado.
    expect(await readdir(dir)).not.toContain(BACKUP_LOCK_FILE);
  });

  it("la contraseña suelta en la salida de pg_dump también se redacta", async () => {
    const dir = await tempDir();
    const error = await caught(
      backupIn(
        dir,
        fakeRunner({ dump: { exitCode: 1, stderr: "auth failed for clave@secreta" } }).run,
      ),
    );
    expect((error as Error).message).toBe(
      "pg_dump terminó con código 1: auth failed for [REDACTED]",
    );
  });

  it("si la herramienta desaparece al lanzarla (ENOENT del spawn): BACKUP_TOOL_NOT_INSTALLED", async () => {
    const dir = await tempDir();
    const run: ProcessRunner = async (command) => {
      throw Object.assign(new Error(`spawn ${command} ENOENT`), {
        code: "ENOENT",
        syscall: `spawn ${command}`,
      });
    };

    const error = await caught(backupIn(dir, run));

    expect(isAppError(error) && error.code).toBe("BACKUP_TOOL_NOT_INSTALLED");
    expect((error as Error).message).toContain("pg_dump");
  });

  it("un corte por apagado es BACKUP_ABORTED y no se anota como falla", async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    const run: ProcessRunner = async () => {
      controller.abort();
      return { exitCode: null, stdout: "", stderr: "" };
    };

    const error = await caught(
      runBackup({
        dir,
        databaseUrl: URL_WITH_SECRET,
        run,
        findTool: FAKE_TOOL,
        now: () => NOW,
        signal: controller.signal,
      }),
    );

    expect(isAppError(error) && error.code).toBe("BACKUP_ABORTED");
    expect(isAppError(error) && error.retriable).toBe(true);
    expect(await readBackupStatus(dir)).toBeNull();
    expect((await readdir(dir)).filter((name) => name.includes(".dump"))).toEqual([]);
  });

  it("si no se pueden borrar los viejos, el respaldo nuevo vale igual", async () => {
    const dir = await tempDir();
    await oldBackups(dir, 14);
    // Una carpeta con nombre de respaldo: borrarla como archivo falla.
    await mkdir(join(dir, "agentsales-20260801-1300.dump"));

    const result = await backupIn(dir, fakeRunner().run);

    expect(result).toMatchObject({ pruneFailed: true, deleted: [] });
    expect((await readBackupStatus(dir))?.lastSuccessAt).toBe(NOW.toISOString());
  });

  it("una DATABASE_URL ilegible es BACKUP_FAILED sin mostrarla", async () => {
    const dir = await tempDir();
    const error = await caught(
      runBackup({
        dir,
        databaseUrl: "no es una url clave-secreta",
        run: fakeRunner().run,
        findTool: FAKE_TOOL,
        now: () => NOW,
      }),
    );
    expect(isAppError(error) && error.code).toBe("BACKUP_FAILED");
    expect((error as Error).message).not.toContain("clave-secreta");
  });

  it("con programas de verdad: un pg_dump falso en PG_BIN_DIR recibe la conexión por el entorno", async () => {
    const bin = await tempDir();
    const dir = await tempDir();
    await writeFile(
      join(bin, "pg_dump"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$@" > "$(dirname "$0")/args.txt"',
        'env > "$(dirname "$0")/env.txt"',
        'while [ $# -gt 0 ]; do if [ "$1" = "-f" ]; then shift; out="$1"; fi; shift; done',
        'printf "PGDMP" > "$out"',
      ].join("\n"),
    );
    await writeFile(
      join(bin, "pg_restore"),
      ["#!/bin/sh", '[ -s "$2" ] && echo "; Archive created" || exit 1'].join("\n"),
    );
    await chmod(join(bin, "pg_dump"), 0o755);
    await chmod(join(bin, "pg_restore"), 0o755);

    const result = await runBackup({
      dir,
      databaseUrl: URL_WITH_SECRET,
      binDir: bin,
      now: () => NOW,
      processEnv: { PATH: "/usr/bin:/bin", DATABASE_URL: URL_WITH_SECRET },
    });

    expect(result.bytes).toBe(5);
    const args = await readFile(join(bin, "args.txt"), "utf8");
    expect(args).not.toContain("secreta");
    expect(args).toContain("--exclude-schema=pgboss");
    const env = await readFile(join(bin, "env.txt"), "utf8");
    expect(env).toContain("PGPASSWORD=clave@secreta");
    expect(env).toContain("PGSSLROOTCERT=system");
    expect(env).not.toContain("DATABASE_URL");
  });
});

describe("estado y nombres", () => {
  it("el nombre va en hora de Chile", () => {
    expect(backupFileName(new Date("2026-01-01T02:30:00.000Z"))).toBe(
      "agentsales-20251231-2330.dump",
    );
  });

  it("un estado ilegible cuenta como sin respaldo, y sin respaldo o de más de 48 h está atrasado", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, BACKUP_STATUS_FILE), "{roto");

    expect(await readBackupStatus(dir)).toBeNull();
    expect(isBackupStale(null, NOW)).toBe(true);
    const status = {
      lastSuccessAt: NOW.toISOString(),
      lastFile: null,
      lastFailureAt: null,
      lastFailureCode: null,
    };
    expect(isBackupStale(status, new Date(NOW.getTime() + 47 * 3600_000))).toBe(false);
    expect(isBackupStale(status, new Date(NOW.getTime() + 49 * 3600_000))).toBe(true);
    expect(isBackupStale({ ...status, lastSuccessAt: "ayer" }, NOW)).toBe(true);
  });
});
