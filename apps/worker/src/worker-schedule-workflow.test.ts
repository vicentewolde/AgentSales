import { readFileSync } from "node:fs";
import {
  WORKER_ACTIVE_HOURS,
  WORKER_CHECK_LEAD_MINUTES,
  WORKER_CHECK_MINUTE,
} from "@agentsales/core";
import { describe, expect, it } from "vitest";

// F9.5-T24 (ADR-0037): el workflow que enciende el worker calza con el horario de core (el que usan
// la agenda y `doctor` para decir la próxima revisión): el minuto del `cron` y la franja del día.

const workflow = readFileSync(
  new URL("../../../.github/workflows/worker-schedule.yml", import.meta.url),
  "utf8",
);

describe("worker-schedule.yml", () => {
  it("revisa cada hora en el minuto de core, con un solo cron", () => {
    const crons = [...workflow.matchAll(/- cron: "([^"]+)"/g)].map((match) => match[1]);
    expect(crons).toEqual([`${WORKER_CHECK_MINUTE} * * * *`]);
  });

  it("la franja del día es la de core", () => {
    expect(workflow).toContain(`ACTIVE_FROM: "${WORKER_ACTIVE_HOURS.from}"`);
    expect(workflow).toContain(`ACTIVE_UNTIL: "${WORKER_ACTIVE_HOURS.until}"`);
    expect(workflow).toContain(`LEAD_MINUTES: "${WORKER_CHECK_LEAD_MINUTES}"`);
  });

  it("se enciende a pedido, sin permisos sobre el repositorio, y avisa sin el secreto", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toContain("secrets.FLY_WORKER_START_TOKEN");
    expect(workflow).toContain("environment: worker-schedule");
    // Sin el secreto termina con un aviso, no con un error.
    expect(workflow).toMatch(/::warning::Falta el secreto FLY_WORKER_START_TOKEN/);
    // Solo enciende: nunca despliega, apaga ni cambia secretos.
    expect(workflow).not.toMatch(/flyctl (deploy|secrets|scale)|machine (stop|destroy|update)/);
  });
});
