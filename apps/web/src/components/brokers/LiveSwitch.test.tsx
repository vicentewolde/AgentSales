// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../../test/harness.js";

// F9.5-T22 (ADR-0036): el interruptor del modo en vivo en la ficha del corredor (administrador).

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

async function setup(options: { owned?: boolean; server?: "live" | "dry-run" } = {}) {
  const h = harness({ deps: { publishMode: options.server ?? "live" } });
  const broker = await h.brokers.create(brokerData("vinny"), { kind: "brand" });
  if (options.owned ?? true) await h.brokers.setSettings(broker.id, { operatorOwned: true });
  h.renderApp(`/corredores/${broker.id}`);
  const region = await screen.findByRole("region", { name: "Modo en vivo" });
  return { h, broker, region };
}

describe("LiveSwitch", () => {
  it("explica las dos llaves y dice el estado: servidor, marca y lo que pasa hoy", async () => {
    const { region } = await setup({ server: "live" });
    expect(region.textContent).toContain("dos llaves");
    await waitFor(() => expect(region.textContent).toContain("Servidor: en vivo"));
    expect(region.textContent).toContain("Esta marca: apagada");
    expect(region.textContent).toContain("Hoy publica: en simulación");
  });

  it("encender pide escribir el slug: sin él, el botón no se activa; con él, queda en vivo", async () => {
    const { h, broker, region } = await setup({ server: "live" });
    fireEvent.click(within(region).getByRole("button", { name: "Encender el modo en vivo" }));
    const form = within(region).getByRole("form", { name: "Confirmar el modo en vivo" });
    const turnOn = within(form).getByRole("button", { name: "Encender" }) as HTMLButtonElement;
    expect(turnOn.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText(/Para confirmar, escribe/), {
      target: { value: "otra" },
    });
    expect(turnOn.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText(/Para confirmar, escribe/), {
      target: { value: "vinny" },
    });
    expect(turnOn.disabled).toBe(false);

    fireEvent.click(turnOn);

    await waitFor(async () =>
      expect((await h.brokers.findById(broker.id))?.liveEnabled).toBe(true),
    );
    await waitFor(() => expect(region.textContent).toContain("Esta marca: encendida"));
    expect(region.textContent).toContain("Hoy publica: de verdad");
    expect(within(region).getByRole("button", { name: "Apagar el modo en vivo" })).toBeTruthy();
  });

  it("apagar no pide confirmación", async () => {
    const { h, broker } = await setup({ server: "live" });
    await h.brokers.setLiveEnabled(broker.id, true);
    cleanup();
    h.renderApp(`/corredores/${broker.id}`);
    const again = await screen.findByRole("region", { name: "Modo en vivo" });

    fireEvent.click(await within(again).findByRole("button", { name: "Apagar el modo en vivo" }));

    await waitFor(async () =>
      expect((await h.brokers.findById(broker.id))?.liveEnabled).toBe(false),
    );
    expect(await within(again).findByText("apagada")).toBeTruthy();
  });

  it("con el servidor en simulación, encender avisa que aún no sale de verdad", async () => {
    const { region } = await setup({ server: "dry-run" });
    fireEvent.click(within(region).getByRole("button", { name: "Encender el modo en vivo" }));
    await waitFor(() =>
      expect(within(region).getByRole("alert").textContent).toContain("hoy está en simulación"),
    );
  });

  it("un corredor que no es propio no tiene botón y se explica por qué", async () => {
    const { region } = await setup({ owned: false });
    expect(within(region).queryByRole("button", { name: "Encender el modo en vivo" })).toBeNull();
    expect(region.textContent).toContain("no es propia");
  });
});
