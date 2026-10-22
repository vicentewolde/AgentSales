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

  it("enlaza las páginas públicas con enlaces comunes, fuera de la app (F8-T18)", async () => {
    const h = harness({ session: "none" });
    h.renderApp("/entrar");
    await screen.findByRole("heading", { name: "Entrar" });

    const nav = screen.getByRole("navigation", { name: "Páginas legales" });
    const links = [...nav.querySelectorAll("a")].map((a) => [
      a.textContent,
      a.getAttribute("href"),
    ]);
    expect(links).toEqual([
      ["Términos de uso", "/legal/terminos.html"],
      ["Privacidad", "/legal/privacidad.html"],
      ["Borrar tus datos", "/legal/eliminacion-de-datos.html"],
    ]);
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
    // Quedan solo las dos que siembra el arnés (panel y CLI): la de este login se borró.
    await waitFor(() => expect(h.auth.repos.sessions.all()).toHaveLength(2));
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

    await screen.findByRole("heading", { name: "Crea tu usuario en AgentSales" });
    await screen.findByLabelText("Contraseña");
    fill("Contraseña", "una-clave-larga-1");
    fill("Repite la contraseña", "otra-clave-larga-1");
    fireEvent.click(screen.getByRole("button", { name: "Guardar y entrar" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Las dos contraseñas no son iguales.",
    );

    fill("Repite la contraseña", "una-clave-larga-1");
    fireEvent.click(screen.getByRole("button", { name: "Guardar y entrar" }));
    // Entra a la portada «Hoy» (F9.5-T03, D11).
    expect(await screen.findByRole("heading", { level: 1, name: "Hoy" })).toBeTruthy();
    expect(await screen.findByText("nueva@ejemplo.cl")).toBeTruthy();
    await waitFor(async () =>
      expect((await h.auth.users.findByEmail("nueva@ejemplo.cl"))?.hasPassword).toBe(true),
    );
  });

  it("explica que crea un usuario", async () => {
    const h = harness({ session: "none" });
    const { token } = await invite(h);
    h.renderApp(`/invitacion#${token}`);

    await screen.findByRole("heading", { name: "Crea tu usuario en AgentSales" });
    await screen.findByLabelText("Contraseña");
    expect(
      screen.getByText(/Estás creando tu usuario en AgentSales: elige una contraseña/),
    ).toBeTruthy();
    // Sin sesión abierta, sin aviso.
    expect(screen.queryByRole("button", { name: "Seguir y cerrar esa sesión" })).toBeNull();
  });

  it("con una sesión abierta en el navegador, avisa y no la cierra sin confirmar (F9.5-T15)", async () => {
    const h = harness({ session: "none" });
    const { token } = await invite(h);
    // El administrador entra en este navegador…
    h.renderApp("/entrar");
    await login(TEST_ADMIN.email, TEST_ADMIN.password);
    expect(await screen.findByRole("heading", { level: 1, name: "Hoy" })).toBeTruthy();
    // Las dos que siembra el arnés y la de este login.
    expect(h.auth.repos.sessions.all()).toHaveLength(3);
    cleanup();

    // …y abre el enlace en otra pestaña del mismo navegador (la misma cookie).
    h.renderApp(`/invitacion#${token}`);
    const warning = await screen.findByText(/Tienes abierta la sesión de/);
    expect(warning.textContent).toContain(TEST_ADMIN.email);
    expect(warning.textContent).toContain(
      "Si sigues, se cierra. Para seguir como administrador, abre este enlace en una ventana privada.",
    );
    // Sin confirmar: ni formulario ni sesión cerrada.
    expect(screen.queryByLabelText("Contraseña")).toBeNull();
    expect(h.auth.repos.sessions.all()).toHaveLength(3);
    expect(h.requests).not.toContain("POST /auth/logout");

    fireEvent.click(screen.getByRole("button", { name: "Seguir y cerrar esa sesión" }));
    await screen.findByLabelText("Contraseña");
    expect(h.auth.repos.sessions.all()).toHaveLength(2);
    expect(screen.queryByText(/Tienes abierta la sesión de/)).toBeNull();

    fill("Contraseña", "una-clave-larga-1");
    fill("Repite la contraseña", "una-clave-larga-1");
    fireEvent.click(screen.getByRole("button", { name: "Guardar y entrar" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Hoy" })).toBeTruthy();
    expect(await screen.findByText("nueva@ejemplo.cl")).toBeTruthy();
  });

  it("un enlace usado o sin token lo explica", async () => {
    const h = harness({ session: "none" });
    h.renderApp("/invitacion#token-que-no-existe");
    await screen.findByRole("heading", { name: "Crea tu usuario en AgentSales" });
    await screen.findByLabelText("Contraseña");
    fill("Contraseña", "una-clave-larga-1");
    fill("Repite la contraseña", "una-clave-larga-1");
    fireEvent.click(screen.getByRole("button", { name: "Guardar y entrar" }));
    expect((await screen.findByRole("alert")).textContent).toContain("pide uno nuevo");

    cleanup();
    harness({ session: "none" }).renderApp("/invitacion");
    expect((await screen.findByRole("alert")).textContent).toContain("incompleto");
  });
});
