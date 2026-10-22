// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerData, harness } from "../../test/harness.js";

// F9.5-T20: el enlace de invitación o de restablecer no desaparece al recargar la página mientras
// no se pulse «Listo, ocultarlo»; vive solo en sessionStorage y se borra al ocultarlo, al vencer y
// al cerrar sesión.

/** Cada prueba monta el panel entero una o dos veces: con la máquina cargada, más de 5 s. */
const SLOW = 15_000;

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
  it(
    "el mismo enlace sigue ahí al recargar, hasta pulsar «Listo, ocultarlo»",
    async () => {
      const { h, broker, shown } = await invited();

      const after = await reload(h, broker.id);
      expect((await within(after).findByText(/\/invitacion#/)).textContent).toBe(shown);
      expect(after.textContent).toContain("Si perdiste el enlace, usa Restablecer");

      fireEvent.click(within(after).getByRole("button", { name: "Listo, ocultarlo" }));
      expect(within(after).queryByText(/\/invitacion#/)).toBeNull();
      expect(sessionStorage.length).toBe(0);
    },
    SLOW,
  );

  it(
    "después de ocultarlo, una recarga ya no lo trae",
    async () => {
      const { h, broker } = await invited();
      fireEvent.click(screen.getByRole("button", { name: "Listo, ocultarlo" }));

      const hidden = await reload(h, broker.id);
      await within(hidden).findByText(/todavía sin contraseña/);
      expect(within(hidden).queryByText(/\/invitacion#/)).toBeNull();
    },
    SLOW,
  );

  it(
    "solo vive en sessionStorage: ni localStorage ni la dirección de la página",
    async () => {
      const { shown } = await invited();
      const token = shown.split("#")[1] ?? "";
      expect(token).not.toBe("");

      expect(JSON.stringify({ ...sessionStorage })).toContain(shown);
      expect(JSON.stringify({ ...localStorage })).not.toContain(token);
      expect(window.location.href).not.toContain(token);
    },
    SLOW,
  );

  it(
    "un enlace vencido no vuelve al recargar y se borra",
    async () => {
      const { h, broker } = await invited();
      // Pasan más horas que lo que dura la invitación.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.now() + 72 * 60 * 60 * 1000));

      const after = await reload(h, broker.id);
      await within(after).findByText(/todavía sin contraseña/);
      expect(within(after).queryByText(/\/invitacion#/)).toBeNull();
      expect(sessionStorage.length).toBe(0);
    },
    SLOW,
  );

  it(
    "Copiar mensaje completo copia el mismo texto del correo, con el enlace",
    async () => {
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
    },
    SLOW,
  );

  it(
    "cerrar sesión borra los enlaces guardados",
    async () => {
      const { shown } = await invited();
      expect(sessionStorage.length).toBe(1);
      expect(shown).toContain("/invitacion#");

      fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));
      await waitFor(() => expect(sessionStorage.length).toBe(0));
    },
    SLOW,
  );
  it(
    "si la sesión vence, los enlaces guardados se borran",
    async () => {
      let expired = false;
      const h = harness({
        intercept: (method, path) =>
          expired && method === "GET" && path.startsWith("/users")
            ? Response.json(
                { error: { code: "AUTH_REQUIRED", message: "Tu sesión venció" } },
                { status: 401 },
              )
            : undefined,
      });
      const broker = await h.brokers.create(brokerData("casas"));
      h.renderApp(`/corredores/${broker.id}`);
      const users = await screen.findByRole("region", { name: "Usuarios" });
      fireEvent.change(within(users).getByLabelText("Correo"), {
        target: { value: "nuevo@ejemplo.cl" },
      });
      fireEvent.change(within(users).getByLabelText("Nombre"), { target: { value: "Nuevo" } });
      fireEvent.click(within(users).getByRole("button", { name: "Invitar" }));
      await within(users).findByText(/\/invitacion#/);
      expect(sessionStorage.length).toBe(1);

      // Al recargar, la API responde que la sesión venció: el panel lleva a Entrar y borra el enlace.
      expired = true;
      await reload(h, broker.id).catch(() => null);
      await waitFor(() => expect(sessionStorage.length).toBe(0));
    },
    SLOW,
  );

  it(
    "guardado, dura como mucho 2 horas aunque la invitación venza después",
    async () => {
      const { h, broker } = await invited();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000 + 60_000));

      const after = await reload(h, broker.id);
      await within(after).findByText(/todavía sin contraseña/);
      expect(within(after).queryByText(/\/invitacion#/)).toBeNull();
      expect(sessionStorage.length).toBe(0);
    },
    SLOW,
  );

  it(
    "si el invitado ya eligió su contraseña, el enlace no vuelve",
    async () => {
      const { h, broker } = await invited();
      const user = h.auth.repos.users.all().find((item) => item.email === "nuevo@ejemplo.cl");
      expect(user).toBeDefined();
      await h.auth.repos.users.setPassword(user?.id ?? "", "hash-de-prueba");

      const after = await reload(h, broker.id);
      await within(after).findByText(/nuevo@ejemplo\.cl/);
      await waitFor(() => expect(within(after).queryByText(/\/invitacion#/)).toBeNull());
      expect(sessionStorage.length).toBe(0);
    },
    SLOW,
  );
});
