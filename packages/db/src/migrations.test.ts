import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "./migrations.js";

describe("MIGRATIONS_FOLDER", () => {
  it("apunta a packages/db/drizzle, que existe", () => {
    expect(basename(MIGRATIONS_FOLDER)).toBe("drizzle");
    expect(basename(dirname(MIGRATIONS_FOLDER))).toBe("db");
    expect(existsSync(MIGRATIONS_FOLDER)).toBe(true);
  });
});
