import { TEST_ADMIN } from "@agentsales/api/testing";
import { describe, expect, it } from "vitest";
import { harness } from "../../test/harness.js";
import { createMemorySessionStore } from "../session.js";
import { runListings } from "./listings.js";
import { runLogin, runLogout, runWhoami } from "./login.js";

// F7-T06 (spec F7 §4.10): entrar, salir y quién soy desde la CLI, contra la API en proceso.

/** La contraseña que "escribe" el operador. */
const typed = (value: string) => async () => ({ cancelled: false as const, value });

describe("agentsales login, whoami y logout", () => {
  it("entra, guarda el token sin mostrarlo, y whoami lo usa", async () => {
    const h = harness({ anonymous: true });
    const session = createMemorySessionStore();
    const code = await runLogin(
      { ...h.io, client: h.client, session, readPassword: typed(TEST_ADMIN.password) },
      { email: TEST_ADMIN.email },
    );
    expect(code).toBe(0);
    const saved = session.read();
    expect(saved).toMatchObject({ email: TEST_ADMIN.email });
    expect(h.text()).toContain(`Entraste como ${TEST_ADMIN.email} (administrador)`);
    expect(h.text()).not.toContain(saved?.token ?? "?");

    const who = harness({ anonymous: true });
    expect(await runWhoami({ ...who.io, client: h.clientWith(saved?.token ?? "") })).toBe(0);
    expect(who.text()).toContain(`<${TEST_ADMIN.email}> · administrador`);

    expect(await runLogout({ ...h.io, client: h.clientWith(saved?.token ?? ""), session })).toBe(0);
    expect(session.read()).toBeNull();
    // La sesión también se cerró en la API.
    const after = harness({ anonymous: true });
    expect(await runWhoami({ ...after.io, client: h.clientWith(saved?.token ?? "") })).toBe(1);
    expect(after.errors()).toContain("AUTH_REQUIRED");
  });

  it("una contraseña mala no guarda nada; sin terminal pide correrlo en la terminal", async () => {
    const h = harness({ anonymous: true });
    const session = createMemorySessionStore();
    expect(
      await runLogin(
        { ...h.io, client: h.client, session, readPassword: typed("equivocada-larga") },
        { email: TEST_ADMIN.email },
      ),
    ).toBe(1);
    expect(h.errors()).toContain("AUTH_INVALID");
    expect(session.read()).toBeNull();

    const noTty = harness({ anonymous: true });
    expect(
      await runLogin(
        { ...noTty.io, client: noTty.client, session, readPassword: async () => null },
        { email: TEST_ADMIN.email },
      ),
    ).toBe(1);
    expect(noTty.errors()).toContain("LOGIN_NEEDS_TERMINAL");
  });

  it("Ctrl+C cancela sin entrar ni decir que falta una terminal", async () => {
    const h = harness({ anonymous: true });
    const session = createMemorySessionStore();
    expect(
      await runLogin(
        { ...h.io, client: h.client, session, readPassword: async () => ({ cancelled: true }) },
        { email: TEST_ADMIN.email },
      ),
    ).toBe(1);
    expect(h.errors()).toContain("LOGIN_CANCELLED");
    expect(h.errors()).not.toContain("terminal interactiva");
    expect(session.read()).toBeNull();
  });

  it("entrar de nuevo cierra en la API la sesión anterior de esta CLI", async () => {
    const h = harness({ anonymous: true });
    const session = createMemorySessionStore();
    const deps = (client = h.client) => ({
      ...h.io,
      client,
      session,
      readPassword: typed(TEST_ADMIN.password),
    });
    await runLogin(deps(), { email: TEST_ADMIN.email });
    const first = session.read()?.token ?? "";
    await runLogin(deps(h.clientWith(first)), { email: TEST_ADMIN.email });
    const second = session.read()?.token ?? "";
    expect(second).not.toBe(first);
    expect(await runWhoami({ ...h.io, client: h.clientWith(first) })).toBe(1);
    expect(await runWhoami({ ...h.io, client: h.clientWith(second) })).toBe(0);
  });

  it("salir con la API apagada borra la local y avisa que en el servidor sigue", async () => {
    const h = harness({
      anonymous: true,
      beforeRequest: () => {
        throw new TypeError("fetch failed");
      },
    });
    const session = createMemorySessionStore({ token: "t", email: "a@ejemplo.cl", savedAt: "x" });
    expect(await runLogout({ ...h.io, client: h.client, session })).toBe(0);
    expect(session.read()).toBeNull();
    expect(h.errors()).toContain("sigue válida");
  });

  it("salir sin sesión no falla, y con una vencida borra la local igual", async () => {
    const h = harness({ anonymous: true });
    const empty = createMemorySessionStore();
    expect(await runLogout({ ...h.io, client: h.client, session: empty })).toBe(0);
    expect(h.text()).toContain("No había una sesión");
    const stale = createMemorySessionStore({
      token: "vencido",
      email: "a@ejemplo.cl",
      savedAt: "x",
    });
    expect(await runLogout({ ...h.io, client: h.clientWith("vencido"), session: stale })).toBe(0);
    expect(stale.read()).toBeNull();
  });

  it("un comando sin sesión dice cómo entrar y sale con 1", async () => {
    const h = harness({ anonymous: true });
    expect(await runListings({ ...h.io, client: h.client }, {})).toBe(1);
    expect(h.errors()).toContain("AUTH_REQUIRED");
    expect(h.errors()).toContain("Inicia sesión: agentsales login");
  });
});
