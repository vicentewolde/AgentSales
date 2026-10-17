import { createFakeSecretTokens, createInMemoryUserRepositories } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { type AuthAdminDeps, runAuthAdmin } from "../src/auth-admin.js";

// F7-T05 (spec F7 §4.2): `pnpm auth:admin` crea o restablece al administrador y deja el enlace en
// el portapapeles, sin imprimirlo.

function setup(options: { clipboard?: boolean } = {}) {
  const repos = createInMemoryUserRepositories();
  const copied: string[] = [];
  const out: string[] = [];
  const deps: AuthAdminDeps = {
    ...repos,
    tokens: createFakeSecretTokens(),
    panelUrl: "http://localhost:5173",
    clipboardReady: async () => options.clipboard ?? true,
    copyToClipboard: async (text) => {
      copied.push(text);
    },
    print: (line) => out.push(line),
    printError: (line) => out.push(line),
  };
  return { deps, repos, copied, out };
}

describe("pnpm auth:admin", () => {
  it("crea el administrador y deja el enlace en el portapapeles, sin imprimirlo", async () => {
    const s = setup();
    expect(await runAuthAdmin(s.deps, { email: "Vinny@Ejemplo.cl", name: undefined })).toBe(0);
    const [admin] = s.repos.users.all();
    expect(admin).toMatchObject({ email: "vinny@ejemplo.cl", name: "vinny", role: "admin" });
    expect(s.copied).toEqual(["http://localhost:5173/invitacion#token-1"]);
    expect(s.out.join("\n")).toContain("creado");
    expect(s.out.join("\n")).not.toContain("token-1");
    expect(s.repos.invitations.all()[0]).toMatchObject({ purpose: "invite", createdBy: null });
  });

  it("si ya existe, le da un enlace de restablecer, lo desbloquea, lo reactiva y cierra sus sesiones", async () => {
    const s = setup();
    const admin = s.repos.seed.user({
      email: "vinny@ejemplo.cl",
      name: "Vinny",
      role: "admin",
      brokerId: null,
      passwordHash: "fake:x",
    });
    s.repos.seed.session({ userId: admin.id, tokenHash: "h" });
    await s.repos.users.setDisabled(admin.id, new Date());
    await s.repos.users.recordLoginFailure(admin.id, {
      now: new Date(),
      lockAfter: 1,
      lockForMs: 60_000,
    });
    expect(await runAuthAdmin(s.deps, { email: "vinny@ejemplo.cl", name: undefined })).toBe(0);
    expect(s.repos.users.all()[0]).toMatchObject({ disabledAt: null, lockedUntil: null });
    expect(s.repos.sessions.all()).toEqual([]);
    expect(s.repos.invitations.all()[0]).toMatchObject({ purpose: "reset" });
    expect(s.out.join("\n")).toContain("ya existía");
  });

  it("sin portapapeles no hace nada; sin correo, lo pide; un correo de corredor se rechaza", async () => {
    const offline = setup({ clipboard: false });
    expect(await runAuthAdmin(offline.deps, { email: "a@ejemplo.cl", name: undefined })).toBe(1);
    expect(offline.repos.users.all()).toEqual([]);

    const s = setup();
    expect(await runAuthAdmin(s.deps, { email: undefined, name: undefined })).toBe(1);
    expect(s.out.join("\n")).toContain("--email");

    s.repos.seed.user({ email: "corredor@ejemplo.cl", name: "C", role: "broker", brokerId: "b1" });
    expect(await runAuthAdmin(s.deps, { email: "corredor@ejemplo.cl", name: undefined })).toBe(1);
    expect(s.out.join("\n")).toContain("USER_NOT_ADMIN");
    expect(s.copied).toEqual([]);
  });
});
