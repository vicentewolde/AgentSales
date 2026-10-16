import { describe, expect, it } from "vitest";
import { type Pingable, pingDatabase, readServerVersion } from "./health.js";

/** Base simulada: falla las primeras `failures` llamadas. */
function fakeDb(failures: number) {
  let calls = 0;
  const db: Pingable = {
    execute: async () => {
      calls++;
      if (calls <= failures) {
        throw new Error(`intento ${calls} falló`);
      }
      return { rows: [] };
    },
  };
  return { db, calls: () => calls };
}

describe("pingDatabase", () => {
  it("responde al primer intento", async () => {
    const { db, calls } = fakeDb(0);

    await pingDatabase(db, { retryDelayMs: 0 });

    expect(calls()).toBe(1);
  });

  it("reintenta una vez si la base está despertando", async () => {
    const { db, calls } = fakeDb(1);

    await pingDatabase(db, { retryDelayMs: 0 });

    expect(calls()).toBe(2);
  });

  it("lanza el error del último intento si todos fallan", async () => {
    const { db, calls } = fakeDb(5);

    await expect(pingDatabase(db, { retryDelayMs: 0 })).rejects.toThrow("intento 2 falló");
    expect(calls()).toBe(2);
  });
});

describe("readServerVersion (F6-T14)", () => {
  it("devuelve show server_version, reintentando como el ping", async () => {
    let calls = 0;
    const db: Pingable = {
      execute: async () => {
        calls++;
        if (calls === 1) throw new Error("despertando");
        return { rows: [{ server_version: " 18.6 " }] };
      },
    };

    expect(await readServerVersion(db, { retryDelayMs: 0 })).toBe("18.6");
    expect(calls).toBe(2);
  });
});
