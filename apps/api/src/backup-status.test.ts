import { readFile } from "node:fs/promises";
import { AppError } from "@agentsales/core";
import { createInMemoryMediaStorage } from "@agentsales/core/testing";
import { writeStoredBackupStatus } from "@agentsales/storage";
import { describe, expect, it } from "vitest";
import { BACKUP_STATUS_CACHE_MS, backupStatusReader, cachedFor } from "./backup-status.js";

// F8-T13 (spec F8 §4.9): la API lee el estado del respaldo en R2, con caché, y no tiene el token
// del bucket de respaldos.

const status = {
  lastSuccessAt: "2026-10-18T16:00:00.000Z",
  lastFile: "agentsales-20261018-1300.dump",
  lastFailureAt: null,
  lastFailureCode: null,
};

describe("el estado del respaldo en la API", () => {
  it("con R2 lee system/ del bucket principal y lo guarda 1 min", async () => {
    const storage = createInMemoryMediaStorage();
    let clock = 0;
    let reads = 0;
    const counted = {
      get: (path: string) => {
        reads += 1;
        return storage.get(path);
      },
    };
    const read = backupStatusReader({ target: "r2", storage: counted, now: () => clock });

    expect(await read()).toBeNull();
    await writeStoredBackupStatus(storage, status);
    clock = BACKUP_STATUS_CACHE_MS - 1;
    expect(await read()).toBeNull();
    clock = BACKUP_STATUS_CACHE_MS;
    expect(await read()).toEqual(status);
    expect(reads).toBe(2);
  });

  it("la caché no guarda una falla y dos consultas a la vez leen una sola vez", async () => {
    let calls = 0;
    let fail = true;
    const read = cachedFor(
      async () => {
        calls += 1;
        if (fail) throw new AppError("STORAGE_UNAVAILABLE", "sin red", { retriable: true });
        return "ok";
      },
      60_000,
      () => 0,
    );

    await expect(read()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    fail = false;
    expect(await Promise.all([read(), read()])).toEqual(["ok", "ok"]);
    expect(await read()).toBe("ok");
    expect(calls).toBe(2);
  });

  it("el servidor de la API no arma el bucket de respaldos ni guarda su token", async () => {
    const server = await readFile(new URL("./server.ts", import.meta.url), "utf8");

    expect(server).toMatch(/withoutBackupCredentials\(loadEnv\(\)\)/);
    expect(server).not.toMatch(/BACKUP_R2_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)|backupStorageOf/);
  });
});
