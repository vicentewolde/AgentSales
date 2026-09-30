// @vitest-environment jsdom
import type { HealthReport } from "@agentsales/core";
import { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { ApiError, type HealthFetcher } from "./api.js";
import { HEALTH_REFETCH_MS } from "./health.js";

const healthy: HealthReport = {
  status: "ok",
  publishMode: "dry-run",
  version: "0.0.1",
  checks: {
    db: { ok: true, latencyMs: 60 },
    storage: { ok: true, latencyMs: 210 },
    queue: { ok: true, latencyMs: 65 },
  },
};

function renderApp(fetchHealth: HealthFetcher, initialPath = "/") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <App fetchHealth={fetchHealth} queryClient={queryClient} inMemory initialPath={initialPath} />,
  );
}

const card = (name: string) => screen.getByRole("region", { name });
const banner = () => screen.getByRole("status");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("panel: Estado del sistema", () => {
  it("mientras consulta lo indica en la página y en el banner", () => {
    renderApp(() => new Promise(() => {}));

    expect(screen.getByText("Consultando la API…")).toBeTruthy();
    expect(banner().textContent).toBe("Consultando PUBLISH_MODE…");
  });

  it("muestra los tres checks con su latencia y el banner dry-run", async () => {
    renderApp(async () => healthy);

    await screen.findByRole("region", { name: "Base de datos" });
    expect(within(card("Base de datos")).getByText("OK")).toBeTruthy();
    expect(within(card("Base de datos")).getByText("60 ms")).toBeTruthy();
    expect(card("Almacenamiento")).toBeTruthy();
    expect(within(card("Cola de trabajos")).getByText(/no indica si el worker/)).toBeTruthy();
    expect(banner().textContent).toBe("PUBLISH_MODE: dry-run — no se publica nada");
    expect(screen.getByText(/Estado general:/).textContent).toContain("ok");
  });

  it("con un check caído muestra degradado y el error", async () => {
    renderApp(async () => ({
      ...healthy,
      status: "degraded",
      checks: {
        ...healthy.checks,
        storage: { ok: false, latencyMs: 12, error: "R2 no respondió" },
      },
    }));

    await screen.findByRole("region", { name: "Almacenamiento" });
    expect(within(card("Almacenamiento")).getByText("Falla")).toBeTruthy();
    expect(within(card("Almacenamiento")).getByText("R2 no respondió")).toBeTruthy();
    expect(screen.getByText(/Estado general:/).textContent).toContain("degradado");
  });

  it("con PUBLISH_MODE=live el banner lo anuncia de inmediato", async () => {
    renderApp(async () => ({ ...healthy, publishMode: "live" }));

    await screen.findByText("PUBLISH_MODE: LIVE — las publicaciones son reales");
    expect(banner().getAttribute("aria-live")).toBe("assertive");
  });

  it("si la API no responde lo dice, sugiere pnpm dev y se recupera con Actualizar", async () => {
    let calls = 0;
    renderApp(async () => {
      calls++;
      if (calls === 1) throw new ApiError("La API no responde (HTTP 502)", "UNREACHABLE");
      return healthy;
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("La API no responde (HTTP 502)");
    expect(alert.textContent).toContain("pnpm dev");
    expect(banner().textContent).toBe("PUBLISH_MODE desconocido: la API no responde");

    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));

    await screen.findByRole("region", { name: "Base de datos" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("deja Propiedades y Publicaciones deshabilitadas", () => {
    renderApp(async () => healthy);

    const menu = screen.getByRole("navigation", { name: "Menú principal" });
    expect(within(menu).getByRole("link", { name: "Estado" })).toBeTruthy();
    expect(within(menu).getByText("Propiedades").getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).getByText("Publicaciones").getAttribute("aria-disabled")).toBe("true");
  });

  it("una ruta inexistente muestra un aviso dentro del layout", () => {
    renderApp(async () => healthy, "/no-existe");

    expect(screen.getByText("Esta página no existe.")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Menú principal" })).toBeTruthy();
  });
});

describe("sondeo de /health (Neon, ADR-0007)", () => {
  async function callsAfter(initialPath: string, ms: number) {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const fetcher = vi.fn<HealthFetcher>(async () => healthy);
    renderApp(fetcher, initialPath);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    return fetcher.mock.calls.length;
  }

  it("la página Estado consulta cada 30 s", async () => {
    expect(await callsAfter("/", HEALTH_REFETCH_MS * 2 + 100)).toBe(3);
  });

  it("fuera de Estado el banner no sondea: una sola consulta", async () => {
    expect(await callsAfter("/no-existe", HEALTH_REFETCH_MS * 2 + 100)).toBe(1);
  });
});
