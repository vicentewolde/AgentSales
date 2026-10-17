import { TEST_ADMIN } from "@agentsales/api/testing";
import { describe, expect, it } from "vitest";
import { harness } from "../../test/harness.js";
import { createMemorySessionStore } from "../session.js";
import { runListings } from "./listings.js";
import { runLogin, runLogout, runWhoami } from "./login.js";

// F7-T06 (spec F7 §4.10): entrar, salir y quién soy desde la CLI, contra la API en proceso.

describe("agentsales login, whoami y logout", () => {
  it("entra, guarda el token sin mostrarlo, y whoami lo usa", async () => {
    const h = harness({ anonymous: true });
    const session = createMemorySessionStore();
    const code = await runLogin(
      { ...h.io, client: h.client, session, readPassword: async () => TEST_ADMIN.password },
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
        { ...h.io, client: h.client, session, readPassword: async () => "equivocada-larga" },
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
