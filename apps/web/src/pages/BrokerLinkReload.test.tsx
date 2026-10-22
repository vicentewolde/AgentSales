// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerData, harness } from "../../test/harness.js";

// F9.5-T20: el enlace de invitación o de restablecer no desaparece al recargar la página mientras
// no se pulse «Listo, ocultarlo»; vive solo en sessionStorage y se borra al ocultarlo, al vencer y
// al cerrar sesión.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});

/** Abre al corredor, invita a un usuario y deja a la vista el enlace. */
async function invited() {
  const h = harness();
  const broker = await h.brokers.create(brokerData("casas"));
  h.renderApp(`/corredores/${broker.id}`);
  const users = await screen.findByRole("region", { name: "Usuarios" });
  fireEvent.change(within(users).getByLabelText("Correo"), {
    target: { value: "nuevo@ejemplo.cl" },
  });
  fireEvent.change(within(users).getByLabelText("Nombre"), { target: { value: "Nuevo" } });
  fireEvent.click(within(users).getByRole("button", { name: "Invitar" }));
  const shown = (await within(users).findByText(/\/invitacion#/)).textContent ?? "";
  return { h, broker, shown };
}

/** Recargar la página: se desmonta todo y la aplicación arranca de nuevo en la misma dirección. */
async function reload(h: ReturnType<typeof harness>, brokerId: string) {
  cleanup();
  h.renderApp(`/corredores/${brokerId}`);
  return screen.findByRole("region", { name: "Usuarios" });
}

describe("el enlace de invitación sobrevive a una recarga (F9.5-T20)", () => {
  it("el mismo enlace sigue ahí al recargar, hasta pulsar «Listo, ocultarlo»", async () => {
    const { h, broker, shown } = await invited();

    const after = await reload(h, broker.id);
    expect((await within(after).findByText(/\/invitacion#/)).textContent).toBe(shown);
    expect(after.textContent).toContain("Si perdiste el enlace, usa Restablecer");

    // Otra recarga más: sigue.
    const again = await reload(h, broker.id);
    expect((await within(again).findByText(/\/invitacion#/)).textContent).toBe(shown);

    fireEvent.click(within(again).getByRole("button", { name: "Listo, ocultarlo" }));
    expect(within(again).queryByText(/\/invitacion#/)).toBeNull();
    expect(sessionStorage.length).toBe(0);

    const hidden = await reload(h, broker.id);
    await within(hidden).findByText(/todavía sin contraseña/);
    expect(within(hidden).queryByText(/\/invitacion#/)).toBeNull();
  });

  it("solo vive en sessionStorage: ni localStorage ni la dirección de la página", async () => {
    const { shown } = await invited();
    const token = shown.split("#")[1] ?? "";
    expect(token).not.toBe("");

    expect(JSON.stringify({ ...sessionStorage })).toContain(shown);
    expect(JSON.stringify({ ...localStorage })).not.toContain(token);
    expect(window.location.href).not.toContain(token);
  });

  it("un enlace vencido no vuelve al recargar y se borra", async () => {
    const { h, broker } = await invited();
    // Pasan más horas que lo que dura la invitación.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 72 * 60 * 60 * 1000));

    const after = await reload(h, broker.id);
    await within(after).findByText(/todavía sin contraseña/);
    expect(within(after).queryByText(/\/invitacion#/)).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("Copiar mensaje completo copia el mismo texto del correo, con el enlace", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { shown } = await invited();

    fireEvent.click(screen.getByRole("button", { name: "Copiar mensaje completo" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const message = writeText.mock.calls[0]?.[0] ?? "";
    expect(message).toContain("Hola Nuevo:");
    expect(message).toContain(shown);
    expect(message).toContain("vence en");
    expect(await screen.findByText("Mensaje copiado")).toBeTruthy();
  });

  it("cerrar sesión borra los enlaces guardados", async () => {
    const { shown } = await invited();
    expect(sessionStorage.length).toBe(1);
    expect(shown).toContain("/invitacion#");

    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
    await waitFor(() => expect(sessionStorage.length).toBe(0));
  });
});
