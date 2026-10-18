import { AppError } from "@agentsales/core";
import { createInMemoryMediaStorage } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import {
  BACKUP_STATUS_PATH,
  readStoredBackupStatus,
  writeStoredBackupStatus,
} from "./backup-status.js";

// F8-T13 (spec F8 §4.9): el estado del respaldo en `system/` del bucket principal.

const status = {
  lastSuccessAt: "2026-10-18T16:00:00.000Z",
  lastFile: "agentsales-20261018-1300.dump",
  lastFailureAt: null,
  lastFailureCode: null,
};

describe("el estado del respaldo en el almacenamiento", () => {
  it("se escribe como JSON en system/ y se vuelve a leer", async () => {
    const storage = createInMemoryMediaStorage();
    expect(await readStoredBackupStatus(storage)).toBeNull();

    await writeStoredBackupStatus(storage, status);

    expect(BACKUP_STATUS_PATH).toBe("system/estado-respaldo.json");
    expect(storage.objects.get(BACKUP_STATUS_PATH)?.contentType).toBe("application/json");
    expect(await readStoredBackupStatus(storage)).toEqual(status);
  });

  it("un estado roto cuenta como sin respaldo; un R2 caído se lanza", async () => {
    const storage = createInMemoryMediaStorage();
    await storage.put(BACKUP_STATUS_PATH, Buffer.from("{roto"), "application/json");
    expect(await readStoredBackupStatus(storage)).toBeNull();
    await storage.put(BACKUP_STATUS_PATH, Buffer.from('{"x":1}'), "application/json");
    expect(await readStoredBackupStatus(storage)).toBeNull();

    const down = {
      get: async () => {
        throw new AppError("STORAGE_UNAVAILABLE", "sin red", { retriable: true });
      },
    };
    await expect(readStoredBackupStatus(down)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
  });
});
