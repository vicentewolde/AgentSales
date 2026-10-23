import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  isWorkerCheckTime,
  WORKER_ACTIVE_HOURS,
  WORKER_CHECK_GRACE_MINUTES,
  WORKER_CHECK_LEAD_MINUTES,
  WORKER_CHECK_MINUTE,
} from "@agentsales/core";
import { describe, expect, it } from "vitest";

// F9.5-T24 (ADR-0037): el workflow que enciende el worker calza con el horario de core (el que usan
// la agenda y `doctor` para decir la próxima revisión): el minuto del `cron`, la franja del día y la
// cuenta del paso «¿Toca encenderlo?», que se corre con bash contra `isWorkerCheckTime`.

const workflow = readFileSync(
  new URL("../../../.github/workflows/worker-schedule.yml", import.meta.url),
  "utf8",
);

/** El valor de una variable del `env` del workflow. */
const envOf = (name: string) => new RegExp(`^\\s+${name}: "([^"]*)"`, "m").exec(workflow)?.[1];

/** La cuenta de la franja del paso «¿Toca encenderlo?» (entre `# <franja>` y `# </franja>`). */
function bandScript(): string {
  const match = /# <franja>[^\n]*\n([\s\S]*?)\n\s*# <\/franja>/.exec(workflow);
  if (match?.[1] === undefined) throw new Error("no está la franja en el workflow");
  return match[1];
}

describe("worker-schedule.yml", () => {
  it("revisa cada hora en el minuto de core, con un solo cron", () => {
    const crons = [...workflow.matchAll(/- cron: "([^"]+)"/g)].map((match) => match[1]);
    expect(crons).toEqual([`${WORKER_CHECK_MINUTE} * * * *`]);
  });

  it("la franja del día es la de core", () => {
    expect(envOf("ACTIVE_FROM")).toBe(WORKER_ACTIVE_HOURS.from);
    expect(envOf("ACTIVE_UNTIL")).toBe(WORKER_ACTIVE_HOURS.until);
    expect(envOf("LEAD_MINUTES")).toBe(String(WORKER_CHECK_LEAD_MINUTES));
    expect(envOf("GRACE_MINUTES")).toBe(String(WORKER_CHECK_GRACE_MINUTES));
  });

  it("la cuenta de bash enciende en los mismos minutos del día que isWorkerCheckTime", () => {
    const script = `${bandScript()}
for m in $(seq 0 1439); do if in_band "$m"; then echo "$m 1"; else echo "$m 0"; fi; done`;
    const output = execFileSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        ACTIVE_FROM: envOf("ACTIVE_FROM") ?? "",
        ACTIVE_UNTIL: envOf("ACTIVE_UNTIL") ?? "",
        LEAD_MINUTES: envOf("LEAD_MINUTES") ?? "",
        GRACE_MINUTES: envOf("GRACE_MINUTES") ?? "",
      },
    });
    const fromBash = output
      .trim()
      .split("\n")
      .map((line) => line.split(" ")[1] === "1");
    expect(fromBash).toHaveLength(1440);
    const fromCore = Array.from({ length: 1440 }, (_, minute) => isWorkerCheckTime(minute));
    expect(fromBash).toEqual(fromCore);
    // Algunos casos a la vista: 05:50 no, 06:50 sí, 22:50 sí, 23:10 (atrasada) sí, 23:15 no.
    for (const [minute, expected] of [
      [5 * 60 + 50, false],
      [6 * 60 + 50, true],
      [22 * 60 + 50, true],
      [23 * 60 + 10, true],
      [23 * 60 + 15, false],
    ] as const) {
      expect(fromBash[minute]).toBe(expected);
    }
  });

  it("se enciende a pedido, sin permisos sobre el repositorio, y avisa sin el secreto", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("permissions: {}");
    expect(workflow).toContain("secrets.FLY_WORKER_START_TOKEN");
    expect(workflow).toContain("environment: worker-schedule");
    // Sin el secreto termina con un aviso, no con un error.
    expect(workflow).toMatch(/::warning::Falta el secreto FLY_WORKER_START_TOKEN/);
  });

  it("de Fly solo lista y enciende máquinas (lista blanca)", () => {
    const uses = [...workflow.matchAll(/\b(?:flyctl|fly)\s+([a-z-]+)(?:\s+([a-z-]+))?/g)].map(
      (match) => `${match[1]} ${match[2] ?? ""}`.trim(),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      // También en los mensajes: nada de deploy, stop, destroy, update, scale ni secrets.
      expect(["machine list", "machine start"]).toContain(use);
    }
  });
});
