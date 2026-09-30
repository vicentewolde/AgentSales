// @vitest-environment jsdom
import type { HealthReport } from "@agentsales/core";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { ApiUnavailableError, type HealthFetcher } from "./api.js";

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

function renderApp(fetchHealth: HealthFetcher) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<App fetchHealth={fetchHealth} queryClient={queryClient} inMemory />);
}

afterEach(() => {
  cleanup();
});

describe("panel: Estado del sistema", () => {
  it("muestra los tres checks con su latencia y el banner dry-run", async () => {
    renderApp(async () => healthy);

    const db = await screen.findByRole("listitem", { name: "Base de datos" });
    expect(within(db).getByText("OK")).toBeTruthy();
    expect(within(db).getByText("60 ms")).toBeTruthy();
    expect(screen.getByRole("listitem", { name: "Almacenamiento" })).toBeTruthy();
    expect(
      within(screen.getByRole("listitem", { name: "Cola de trabajos" })).getByText(
        /no indica si el worker está corriendo/,
      ),
    ).toBeTruthy();
    expect(screen.getByText("PUBLISH_MODE: dry-run — no se publica nada")).toBeTruthy();
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

    const storage = await screen.findByRole("listitem", { name: "Almacenamiento" });
    expect(within(storage).getByText("Falla")).toBeTruthy();
    expect(within(storage).getByText("R2 no respondió")).toBeTruthy();
    expect(screen.getByText(/Estado general:/).textContent).toContain("degradado");
  });

  it("con PUBLISH_MODE=live muestra el banner rojo", async () => {
    renderApp(async () => ({ ...healthy, publishMode: "live" }));

    const banner = await screen.findByText("PUBLISH_MODE: LIVE — las publicaciones son reales");
    expect(banner.className).toContain("bg-red-600");
  });

  it("si la API no responde lo dice y sugiere pnpm dev", async () => {
    renderApp(async () => {
      throw new ApiUnavailableError("La API no responde (HTTP 502)");
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("La API no responde (HTTP 502)");
    expect(alert.textContent).toContain("pnpm dev");
    expect(screen.getByText("PUBLISH_MODE desconocido: la API no responde")).toBeTruthy();
  });

  it("deja Propiedades y Publicaciones deshabilitadas", () => {
    renderApp(async () => healthy);

    const menu = screen.getByRole("navigation", { name: "Menú principal" });
    expect(within(menu).getByRole("link", { name: "Estado" })).toBeTruthy();
    expect(within(menu).getByText("Propiedades").getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).getByText("Publicaciones").getAttribute("aria-disabled")).toBe("true");
  });
});
