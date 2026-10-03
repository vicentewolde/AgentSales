import { describe, expect, it } from "vitest";
import { JOB_NAMES, JOB_PAYLOADS } from "./jobs.js";

describe("contrato de jobs", () => {
  it("cada nombre tiene su esquema, y nada más", () => {
    expect(Object.keys(JOB_PAYLOADS).sort()).toEqual([...JOB_NAMES].sort());
  });

  it("import.run lleva solo el id del run, que debe ser un uuid", () => {
    const id = "7f1c2a4e-9b3d-4f6a-8c2e-1d5b9a7e3f10";
    expect(JOB_PAYLOADS["import.run"].parse({ importRunId: id, otro: 1 })).toEqual({
      importRunId: id,
    });
    expect(JOB_PAYLOADS["import.run"].safeParse({ importRunId: "run-1" }).success).toBe(false);
  });

  it("content.prepare lleva solo el id de la corrida, que debe ser un uuid", () => {
    const id = "7f1c2a4e-9b3d-4f6a-8c2e-1d5b9a7e3f10";
    expect(JOB_PAYLOADS["content.prepare"].parse({ contentRunId: id, texts: true })).toEqual({
      contentRunId: id,
    });
    expect(JOB_PAYLOADS["content.prepare"].safeParse({ contentRunId: "run-1" }).success).toBe(
      false,
    );
  });
});
