// @vitest-environment jsdom
import type { HealthReport } from "@agentsales/core";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { harness } from "../test/harness.js";
import { HEALTH_REFETCH_MS } from "./queries/health.js";

const healthyChecks = {
  db: { ok: true, latencyMs: 60 },
  storage: { ok: true, latencyMs: 210 },
  queue: { ok: true, latencyMs: 65 },
};

const healthy: HealthReport = {
  status: "ok",
  publishMode: "dry-run",
  version: "0.0.1",
  checks: healthyChecks,
};

/** El panel con `/health` respondido por `health` (los demás endpoints, por la API en proceso). */
function renderWithHealth(
  health: () => Promise<HealthReport> | HealthReport,
  initialPath = "/estado",
) {
  const h = harness({
    intercept: (_method, path) =>
      path === "/health"
        ? Promise.resolve(health()).then((report) => Response.json(report))
        : undefined,
  });
  h.renderApp(initialPath);
  return h;
}

const card = (name: string) => screen.getByRole("region", { name });
const banner = () => screen.getByRole("status");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("panel: Estado del sistema", () => {
  it("dice si el worker está encendido o apagado según su latido (F8-T12)", async () => {
    renderWithHealth(() => ({
      ...healthy,
      worker: {
        running: true,
        startedAt: "2026-10-18T13:00:00.000Z",
        lastBeatAt: "2026-10-18T14:00:00.000Z",
      },
    }));
    expect((await screen.findByText(/^Worker:/)).textContent).toBe(
      "Worker: encendido desde 2026-10-18 10:00",
    );
    cleanup();

    renderWithHealth(() => ({
      ...healthy,
      worker: {
        running: false,
        startedAt: "2026-10-18T13:00:00.000Z",
        lastBeatAt: "2026-10-18T14:00:00.000Z",
      },
    }));
    expect((await screen.findByText(/^Worker:/)).textContent).toContain(
      "apagado desde 2026-10-18 11:00",
    );
  });

  it("mientras consulta lo indica en la página y en el banner", async () => {
    renderWithHealth(() => new Promise(() => {}));

    expect(await screen.findByText("Consultando la API…")).toBeTruthy();
    expect(banner().textContent).toBe("Consultando el modo…");
  });

  it("muestra los tres checks con su latencia y el banner dry-run", async () => {
    renderWithHealth(() => healthy);

    await screen.findByRole("region", { name: "Base de datos" });
    expect(within(card("Base de datos")).getByText("OK")).toBeTruthy();
    expect(within(card("Base de datos")).getByText("60 ms")).toBeTruthy();
    expect(card("Almacenamiento")).toBeTruthy();
    expect(within(card("Cola de trabajos")).getByText(/el worker se ve abajo/)).toBeTruthy();
    expect(banner().textContent).toBe("Modo simulación: nada se publica en las redes");
    expect(screen.getByText(/Estado general:/).textContent).toContain("ok");
  });

  it("con la API real en proceso también funciona (contrato de /health)", async () => {
    harness().renderApp("/estado");

    await screen.findByRole("region", { name: "Base de datos" });
    expect(screen.getByText(/Estado general:/).textContent).toContain("ok");
  });

  it("con un check caído muestra degradado y el error", async () => {
    renderWithHealth(() => ({
      ...healthy,
      status: "degraded",
      checks: {
        ...healthyChecks,
        storage: { ok: false, latencyMs: 12, error: "R2 no respondió" },
      },
    }));

    await screen.findByRole("region", { name: "Almacenamiento" });
    expect(within(card("Almacenamiento")).getByText("Falla")).toBeTruthy();
    expect(within(card("Almacenamiento")).getByText("R2 no respondió")).toBeTruthy();
    expect(screen.getByText(/Estado general:/).textContent).toContain("degradado");
  });

  it("en vivo el banner lo anuncia de inmediato", async () => {
    renderWithHealth(() => ({ ...healthy, publishMode: "live" }));

    await screen.findByText("El servidor está en vivo: publican de verdad las marcas encendidas");
    expect(banner().getAttribute("aria-live")).toBe("assertive");
  });

  it("si la API no responde lo dice, sugiere pnpm dev y se recupera con Actualizar", async () => {
    let calls = 0;
    const h = harness({
      intercept: (_method, path) => {
        if (path !== "/health") return undefined;
        calls++;
        return calls === 1 ? new Response("Bad Gateway", { status: 502 }) : Response.json(healthy);
      },
    });
    h.renderApp("/estado");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("La API no responde (HTTP 502)");
    expect(alert.textContent).toContain("pnpm dev");
    expect(banner().textContent).toBe(
      "No se sabe si está en simulación o en vivo: el sistema no responde",
    );

    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));

    await screen.findByRole("region", { name: "Base de datos" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Propiedades y Seguimiento quedan habilitadas", async () => {
    renderWithHealth(() => healthy);

    const menu = screen.getByRole("navigation", { name: "Menú principal" });
    // F9.5-T03 (D11): «Hoy» es la primera entrada y lleva a `/`; «Estado», a `/estado`.
    const links = within(menu).getAllByRole("link");
    expect(links[0]?.textContent).toBe("Hoy");
    expect(links[0]?.getAttribute("href")).toBe("/");
    // «Estado» es del administrador: aparece cuando se sabe quién es.
    expect((await within(menu).findByRole("link", { name: "Estado" })).getAttribute("href")).toBe(
      "/estado",
    );
    expect(within(menu).getByRole("link", { name: "Propiedades" }).getAttribute("href")).toBe(
      "/propiedades",
    );
    expect(within(menu).getByRole("link", { name: "Seguimiento" }).getAttribute("href")).toBe(
      "/seguimiento",
    );
  });

  it("una ruta inexistente muestra un aviso dentro del layout", () => {
    renderWithHealth(() => healthy, "/no-existe");

    expect(screen.getByText("Esta página no existe.")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Menú principal" })).toBeTruthy();
  });
});

describe("sondeo de /health (Neon, ADR-0007)", () => {
  async function healthCallsAfter(initialPath: string, ms: number) {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const h = renderWithHealth(() => healthy, initialPath);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    return h.requests.filter((request) => request === "GET /health").length;
  }

  it("la página Estado consulta cada 30 s", async () => {
    expect(await healthCallsAfter("/estado", HEALTH_REFETCH_MS * 2 + 100)).toBe(3);
  });

  it("fuera de Estado el banner no sondea: una sola consulta", async () => {
    expect(await healthCallsAfter("/no-existe", HEALTH_REFETCH_MS * 2 + 100)).toBe(1);
  });
});
