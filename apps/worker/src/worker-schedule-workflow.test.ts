import { readFileSync } from "node:fs";
import { WORKER_WINDOW_LEAD_MINUTES, WORKER_WINDOWS } from "@agentsales/core";
import { describe, expect, it } from "vitest";

// F9.5-T24 (ADR-0037): las ventanas del workflow que enciende el worker calzan con las de core (las
// que usan la agenda y `doctor`). El workflow las tiene dos veces: `WORKER_WINDOWS` (hora de Chile) y
// los `cron` (UTC), uno por cada horario de Chile, `WORKER_WINDOW_LEAD_MINUTES` antes.

const workflow = readFileSync(
  new URL("../../../.github/workflows/worker-schedule.yml", import.meta.url),
  "utf8",
);

const toMinutes = (time: string) => {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return hours * 60 + minutes;
};

/** El cron diario (UTC) de un minuto del día en Chile con ese desfase de UTC (en horas). */
const cronFor = (chileMinutes: number, utcOffsetHours: number) => {
  const utc = (((chileMinutes + utcOffsetHours * 60) % 1440) + 1440) % 1440;
  return `${utc % 60} ${Math.floor(utc / 60)} * * *`;
};

describe("worker-schedule.yml", () => {
  it("WORKER_WINDOWS es la lista de core", () => {
    expect(workflow).toMatch(new RegExp(`WORKER_WINDOWS: "${WORKER_WINDOWS.join(" ")}"`));
  });

  it("un cron por ventana y por horario de Chile (UTC−3 y UTC−4), unos minutos antes, y nada más", () => {
    const crons = [...workflow.matchAll(/- cron: "([^"]+)"/g)].map((match) => match[1]);
    const expected = WORKER_WINDOWS.flatMap((window) =>
      [3, 4].map((offset) => cronFor(toMinutes(window) - WORKER_WINDOW_LEAD_MINUTES, offset)),
    );
    expect([...crons].sort()).toEqual([...expected].sort());
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
