import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ADR-0044: si el worker se apaga solo, quien lo vuelve a encender es la API, que entonces debe quedar
// siempre encendida. Activar uno sin el otro dejaría lo programado sin salir.

const flyToml = readFileSync(new URL("../../../fly.toml", import.meta.url), "utf8");

/** El valor de una clave en una línea activa (sin `#` delante), o `undefined`. */
const activeValue = (toml: string, key: string) =>
  new RegExp(`^\\s*${key}\\s*=\\s*"?(\\d+)"?`, "m").exec(toml)?.[1];

function pairingProblem(toml: string): string | null {
  const idleExit = Number(activeValue(toml, "WORKER_IDLE_EXIT_MINUTES") ?? 0);
  const minRunning = Number(activeValue(toml, "min_machines_running") ?? 0);
  if (idleExit > 0 && minRunning < 1) {
    return "WORKER_IDLE_EXIT_MINUTES activo pide min_machines_running = 1";
  }
  return null;
}

describe("fly.toml", () => {
  it("el worker se apaga solo solo con la API siempre encendida", () => {
    expect(pairingProblem(flyToml)).toBeNull();
  });

  it("la regla se nota en las líneas activas, no en las comentadas", () => {
    const withIdle = flyToml.replace(
      /^\s*# WORKER_IDLE_EXIT_MINUTES = "10"$/m,
      '  WORKER_IDLE_EXIT_MINUTES = "10"',
    );
    expect(withIdle).not.toBe(flyToml);
    expect(pairingProblem(withIdle)).not.toBeNull();
    const both = withIdle.replace(/^(\s*)min_machines_running = 0$/m, "$1min_machines_running = 1");
    expect(both).not.toBe(withIdle);
    expect(pairingProblem(both)).toBeNull();
  });
});
