import { Writable } from "node:stream";
import { createLogger } from "@agentsales/config";
import { describe, expect, it } from "vitest";
import { defineJob } from "./define.js";

const logger = createLogger(
  { level: "silent" },
  new Writable({ write: (_chunk, _encoding, callback) => callback() }),
);
const policy = { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 };
const context = (jobId: string) => ({ jobId, logger, isLastAttempt: false });

describe("defineJob", () => {
  it("valida los datos con el esquema de core (JOB_PAYLOADS) y llama al handler con lo parseado", async () => {
    const received: unknown[] = [];
    const job = defineJob({
      name: "import.run",
      queue: policy,
      handler: async (data, { jobId, isLastAttempt }) => {
        received.push({ data, jobId, isLastAttempt });
      },
    });
    const importRunId = "7f1c2a4e-9b3d-4f6a-8c2e-1d5b9a7e3f10";

    await job.run({ importRunId, extra: "se descarta" }, context("j1"));

    expect(job).toMatchObject({ name: "import.run", queue: policy });
    expect(received).toEqual([{ data: { importRunId }, jobId: "j1", isLastAttempt: false }]);
  });

  it("con datos inválidos lanza JOB_PAYLOAD_INVALID no reintentable y no llama al handler", async () => {
    let called = false;
    const job = defineJob({
      name: "import.run",
      queue: policy,
      handler: async () => {
        called = true;
      },
    });

    await expect(job.run({ importRunId: 42 }, context("j2"))).rejects.toMatchObject({
      code: "JOB_PAYLOAD_INVALID",
      retriable: false,
      details: { issues: [expect.objectContaining({ path: "importRunId" })] },
    });
    expect(called).toBe(false);
  });
});
