import { Writable } from "node:stream";
import { createLogger } from "@agentsales/config";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineJob } from "./define.js";

const logger = createLogger(
  { level: "silent" },
  new Writable({ write: (_chunk, _encoding, callback) => callback() }),
);
const policy = { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 };

describe("defineJob", () => {
  it("valida los datos con zod y llama al handler con los datos ya parseados", async () => {
    const received: unknown[] = [];
    const job = defineJob({
      name: "media.process",
      schema: z.object({ mediaId: z.string().uuid() }),
      queue: policy,
      handler: async (data, { jobId }) => {
        received.push({ data, jobId });
      },
    });
    const mediaId = "7f1c2a4e-9b3d-4f6a-8c2e-1d5b9a7e3f10";

    await job.run({ mediaId, extra: "se descarta" }, { jobId: "j1", logger });

    expect(job).toMatchObject({ name: "media.process", queue: policy });
    expect(received).toEqual([{ data: { mediaId }, jobId: "j1" }]);
  });

  it("con datos inválidos lanza JOB_PAYLOAD_INVALID no reintentable y no llama al handler", async () => {
    let called = false;
    const job = defineJob({
      name: "media.process",
      schema: z.object({ mediaId: z.string().uuid() }),
      queue: policy,
      handler: async () => {
        called = true;
      },
    });

    await expect(job.run({ mediaId: 42 }, { jobId: "j2", logger })).rejects.toMatchObject({
      code: "JOB_PAYLOAD_INVALID",
      retriable: false,
      details: { issues: [expect.objectContaining({ path: "mediaId" })] },
    });
    expect(called).toBe(false);
  });
});
