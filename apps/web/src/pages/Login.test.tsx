// @vitest-environment jsdom
import { TEST_ADMIN } from "@agentsales/api/testing";
import { inviteUser, type User } from "@agentsales/core";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { harness } from "../../test/harness.js";
import { returnPathOf } from "./LoginPage.js";

// F7-T07 (spec F7 §4.11): entrar, la invitación, salir y la vuelta a la página donde estaba, sobre
// la API en proceso sin la sesión por defecto (las cookies como en el navegador).

afterEach(cleanup);

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function login(email: string, password: string) {
  fill("Correo", email);
  fill("Contraseña", password);
  fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
}

describe("entrar", () => {
  it("sin sesión lleva a Entrar y, al entrar, vuelve a la página que se pidió", async () => {
    const h = harness({ session: "none" });
    h.renderApp("/propiedades");

    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeTruthy();
    await login(TEST_ADMIN.email, TEST_ADMIN.password);

    expect(await screen.findByRole("heading", { name: "Propiedades" })).toBeTruthy();
    // El menú dice quién entró.
    expect(await screen.findByText(TEST_ADMIN.email)).toBeTruthy();
  });

  it("mal: el mensaje de la API, sin entrar", async () => {
    const h = harness({ session: "none" });
    h.renderApp("/entrar");
    await login(TEST_ADMIN.email, "equivocada-larga");

    expect((await screen.findByRole("alert")).textContent).toBe(
      "El correo o la contraseña no son correctos",
    );
    expect(screen.getByRole("heading", { name: "Entrar" })).toBeTruthy();
  });

  it("solo vuelve a una ruta del panel", () => {
    expect(returnPathOf("/propiedades?estado=ready")).toBe("/propiedades?estado=ready");
    for (const value of [
      null,
      "https://malo.example",
      "//malo.example",
      "/\\malo.example",
      "/\tmalo",
      "propiedades",
      "/entrar",
    ]) {
      expect(returnPathOf(value)).toBe("/");
    }
  });
});

describe("salir", () => {
  it("cerrar sesión lleva a Entrar, y lo que sigue pide entrar de nuevo", async () => {
    const h = harness({ session: "none" });
    h.renderApp("/entrar");
    await login(TEST_ADMIN.email, TEST_ADMIN.password);
    fireEvent.click(await screen.findByRole("button", { name: "Cerrar sesión" }));

    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeTruthy();
    // Queda solo la sesión que siembra el arnés: la de este login se borró.
    await waitFor(() => expect(h.auth.repos.sessions.all()).toHaveLength(1));
  });
});

describe("la invitación", () => {
  async function invite(h: ReturnType<typeof harness>) {
    const admin = (await h.auth.users.get(TEST_ADMIN.id)) as User;
    return inviteUser(h.auth, {
      actor: admin,
      email: "nueva@ejemplo.cl",
      name: "Nueva",
      role: "admin",
      brokerId: null,
    });
  }

  it("elige la contraseña con el enlace y entra al panel", async () => {
    const h = harness({ session: "none" });
    const { token } = await invite(h);
    h.renderApp(`/invitacion#${token}`);

    await screen.findByRole("heading", { name: "Elige tu contraseña" });
    fill("Contraseña", "una-clave-larga-1");
    fill("Repite la contraseña", "otra-clave-larga-1");
    fireEvent.click(screen.getByRole("button", { name: "Guardar y entrar" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Las dos contraseñas no son iguales.",
    );

    fill("Repite la contraseña", "una-clave-larga-1");
    fireEvent.click(screen.getByRole("button", { name: "Guardar y entrar" }));
    expect(await screen.findByRole("heading", { name: "Estado del sistema" })).toBeTruthy();
    expect(await screen.findByText("nueva@ejemplo.cl")).toBeTruthy();
    await waitFor(async () =>
      expect((await h.auth.users.findByEmail("nueva@ejemplo.cl"))?.hasPassword).toBe(true),
    );
  });

  it("un enlace usado o sin token lo explica", async () => {
    const h = harness({ session: "none" });
    h.renderApp("/invitacion#token-que-no-existe");
    await screen.findByRole("heading", { name: "Elige tu contraseña" });
    fill("Contraseña", "una-clave-larga-1");
    fill("Repite la contraseña", "una-clave-larga-1");
    fireEvent.click(screen.getByRole("button", { name: "Guardar y entrar" }));
    expect((await screen.findByRole("alert")).textContent).toContain("pide uno nuevo");

    cleanup();
    harness({ session: "none" }).renderApp("/invitacion");
    expect((await screen.findByRole("alert")).textContent).toContain("incompleto");
  });
});
