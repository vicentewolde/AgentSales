import { describe, expect, it } from "vitest";
import { contentJobSetup, silentLogger } from "../test/content-fixture.js";
import { contentPrepareJob } from "./jobs/content-prepare.js";
import { stopWorker } from "./shutdown.js";

describe("apagado del worker", () => {
  it("dispara el signal, espera a que el handler termine y recién después cierra el navegador", async () => {
    const events: string[] = [];
    let llmCalled: () => void = () => {};
    const called = new Promise<void>((resolve) => {
      llmCalled = resolve;
    });
    const t = await contentJobSetup({
      llm: {
        name: "fake",
        generateStructured: ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              events.push("la IA ve el corte");
              reject(new Error("cortada"));
            });
            llmCalled();
          }),
      },
    });
    const runId = await t.newRun();
    // El handler corre como lo haría pg-boss, y queda esperando a la IA.
    const handler = contentPrepareJob(t.deps)
      .run({ contentRunId: runId }, { jobId: "j1", logger: silentLogger, isLastAttempt: true })
      .catch((error: { code?: string }) => events.push(`handler termina con ${error.code}`));
    await called;

    await stopWorker(
      {
        abortJobs: () => {
          events.push("corte");
          t.abort.abort();
        },
        // pg-boss espera a los handlers activos.
        stopBoss: async () => {
          await handler;
          events.push("pg-boss detenido");
        },
        closeRenderer: async () => void events.push("navegador cerrado"),
        closeDatabase: async () => void events.push("base cerrada"),
      },
      silentLogger,
    );

    expect(events).toEqual([
      "corte",
      "la IA ve el corte",
      "handler termina con CONTENT_RUN_ABORTED",
      "pg-boss detenido",
      "navegador cerrado",
      "base cerrada",
    ]);
    // Corte en el último intento: la corrida no queda en failed.
    expect(await t.contentRuns.get(runId)).toMatchObject({ status: "running" });
  });

  it("si detener pg-boss falla, el navegador se cierra igual y el error sube", async () => {
    const events: string[] = [];

    await expect(
      stopWorker(
        {
          abortJobs: () => void events.push("corte"),
          stopBoss: async () => {
            throw new Error("sin conexión");
          },
          closeRenderer: async () => void events.push("navegador cerrado"),
          closeDatabase: async () => void events.push("base cerrada"),
        },
        silentLogger,
      ),
    ).rejects.toThrow("sin conexión");
    expect(events).toEqual(["corte", "navegador cerrado"]);
  });

  it("un error al cerrar el navegador no impide cerrar la base", async () => {
    const events: string[] = [];

    await stopWorker(
      {
        abortJobs: () => {},
        stopBoss: async () => {},
        closeRenderer: async () => {
          throw new Error("Chromium no responde");
        },
        closeDatabase: async () => void events.push("base cerrada"),
      },
      silentLogger,
    );
    expect(events).toEqual(["base cerrada"]);
  });
});
