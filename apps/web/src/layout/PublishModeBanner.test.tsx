// @vitest-environment jsdom
import type { HealthReport } from "@agentsales/core";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";
import { BROKER_SCOPE_STORAGE_KEY } from "../scope/broker-scope.js";

// F9.5-T22 (ADR-0036): el banner dice el modo de la MARCA elegida; con «Todos», el del servidor y
// cuántas marcas están en vivo.

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const HEALTHY: HealthReport = {
  status: "ok",
  publishMode: "dry-run",
  version: "0.0.1",
  checks: {
    db: { ok: true, latencyMs: 60 },
    storage: { ok: true, latencyMs: 210 },
    queue: { ok: true, latencyMs: 65 },
  },
};

/** Tres marcas: AgentPey (propia y encendida), Vinny (propia y apagada) y un cliente (ajeno). */
async function setup(health: Partial<HealthReport>) {
  const h = harness({
    intercept: (_method, path) =>
      path === "/health" ? Response.json({ ...HEALTHY, ...health }) : undefined,
  });
  const agentpey = await h.brokers.create(brokerData("agentpey"), { kind: "brand" });
  await h.brokers.setSettings(agentpey.id, { operatorOwned: true });
  await h.brokers.setLiveEnabled(agentpey.id, true);
  const vinny = await h.brokers.create(brokerData("vinny"), { kind: "brand" });
  await h.brokers.setSettings(vinny.id, { operatorOwned: true });
  const client = await h.brokers.create(brokerData("cliente"));
  return { h, agentpey, vinny, client };
}

const banner = () => screen.getByRole("status");

describe("el banner del modo (F9.5-T22)", () => {
  it("una marca encendida con el servidor en vivo: «En vivo» con su nombre, en rojo y anunciado de inmediato", async () => {
    const s = await setup({ publishMode: "live", liveBrokers: ["agentpey"] });
    sessionStorage.setItem(BROKER_SCOPE_STORAGE_KEY, "agentpey");
    s.h.renderApp("/estado");

    await waitFor(() =>
      expect(banner().textContent).toBe(
        "En vivo: lo que publiques en Marca agentpey sale de verdad",
      ),
    );
    expect(banner().getAttribute("aria-live")).toBe("assertive");
  });

  it("una marca apagada con el servidor en vivo: «Simulación»", async () => {
    const s = await setup({ publishMode: "live", liveBrokers: ["agentpey"] });
    sessionStorage.setItem(BROKER_SCOPE_STORAGE_KEY, "vinny");
    s.h.renderApp("/estado");

    await waitFor(() =>
      expect(banner().textContent).toBe("Simulación: nada se publica en las redes"),
    );
    expect(banner().getAttribute("aria-live")).toBe("polite");
  });

  it("un corredor ajeno al operador, aunque tuviera la llave, siempre en simulación", async () => {
    const s = await setup({ publishMode: "live", liveBrokers: ["agentpey"] });
    sessionStorage.setItem(BROKER_SCOPE_STORAGE_KEY, "cliente");
    s.h.renderApp("/estado");

    await waitFor(() =>
      expect(banner().textContent).toBe("Simulación: nada se publica en las redes"),
    );
  });

  it("con el servidor en simulación, ni la marca encendida publica de verdad", async () => {
    const s = await setup({ publishMode: "dry-run", liveBrokers: ["agentpey"] });
    sessionStorage.setItem(BROKER_SCOPE_STORAGE_KEY, "agentpey");
    s.h.renderApp("/estado");

    await waitFor(() =>
      expect(banner().textContent).toBe("Simulación: nada se publica en las redes"),
    );
  });

  it("con «Todos» y el servidor en vivo: cuántas marcas publican de verdad, y cuáles", async () => {
    const s = await setup({ publishMode: "live", liveBrokers: ["agentpey"] });
    s.h.renderApp("/estado");

    await waitFor(() =>
      expect(banner().textContent).toBe(
        "El servidor está en vivo: 1 marca publica de verdad (agentpey)",
      ),
    );
    expect(banner().getAttribute("aria-live")).toBe("assertive");
  });

  it("con «Todos», el servidor en vivo y ninguna marca encendida: se dice y el tono es de simulación", async () => {
    const s = await setup({ publishMode: "live", liveBrokers: [] });
    s.h.renderApp("/estado");

    await waitFor(() =>
      expect(banner().textContent).toBe(
        "El servidor está en vivo, pero ninguna marca está encendida: todo se simula",
      ),
    );
    expect(banner().getAttribute("aria-live")).toBe("polite");
  });

  it("con «Todos» y el servidor en simulación: el texto de siempre", async () => {
    const s = await setup({ publishMode: "dry-run", liveBrokers: ["agentpey"] });
    s.h.renderApp("/estado");

    await waitFor(() =>
      expect(banner().textContent).toBe("Modo simulación: nada se publica en las redes"),
    );
  });

  it("la publicación automática solo se grita en rojo si la marca encendida publica de verdad", async () => {
    const s = await setup({
      publishMode: "live",
      liveBrokers: ["agentpey"],
      autoPublishBrokers: ["agentpey", "cliente"],
    });
    s.h.renderApp("/estado");

    await waitFor(() =>
      expect(banner().textContent).toContain(
        "Publicación automática EN VIVO: publica sin tu revisión (agentpey)",
      ),
    );
    expect(banner().textContent).not.toContain("cliente");
  });

  it("al elegir otra marca en el selector, el banner cambia", async () => {
    const s = await setup({ publishMode: "live", liveBrokers: ["agentpey"] });
    s.h.renderApp("/estado");
    const selector = (await screen.findByLabelText("Ver corredor")) as HTMLSelectElement;
    await waitFor(() => expect(selector.options.length).toBeGreaterThan(3));

    fireEvent.change(selector, { target: { value: "agentpey" } });
    await waitFor(() => expect(banner().textContent).toContain("En vivo: lo que publiques en"));
    fireEvent.change(selector, { target: { value: "vinny" } });
    await waitFor(() =>
      expect(banner().textContent).toBe("Simulación: nada se publica en las redes"),
    );
  });
});
