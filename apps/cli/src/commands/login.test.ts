import { TEST_ADMIN, TEST_ADMIN_CLI_TOKEN } from "@agentsales/api/testing";
import { fakeTotpCode, fakeTotpStep } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { harness, PORT } from "../../test/harness.js";
import { localServerUrl } from "../server.js";
import { createMemorySessionStore } from "../session.js";
import { runListings } from "./listings.js";
import { runLogin, runLogout, runWhoami } from "./login.js";

// F7-T06 (spec F7 §4.10): entrar, salir y quién soy desde la CLI, contra la API en proceso.

/** La contraseña que "escribe" el operador. */
const typed = (value: string) => async () => ({ cancelled: false as const, value });
/** Lo que escribe en orden: la contraseña y después cada código; anota cada pregunta. */
const typedInOrder =
  (values: string[], prompts: string[] = []) =>
  async (prompt: string) => {
    prompts.push(prompt);
    return { cancelled: false as const, value: values.shift() ?? "" };
  };

type Harness = ReturnType<typeof harness>;

/** Lo que `login` recibe de la CLI: la API en proceso para cualquier servidor. */
const via = (h: Harness, envUrl?: string) => ({
  ...h.io,
  clientFor: h.clientAt,
  localPort: PORT,
  envUrl,
});

describe("agentsales login, whoami y logout", () => {
  it("entra, guarda el token sin mostrarlo, y whoami lo usa", async () => {
    const h = harness({ anonymous: true });
    const session = createMemorySessionStore();
    const code = await runLogin(
      { ...via(h), session, readPassword: typed(TEST_ADMIN.password) },
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
        { ...via(h), session, readPassword: typed("equivocada-larga") },
        { email: TEST_ADMIN.email },
      ),
    ).toBe(1);
    expect(h.errors()).toContain("AUTH_INVALID");
    expect(session.read()).toBeNull();

    const noTty = harness({ anonymous: true });
    expect(
      await runLogin(
        { ...via(noTty), session, readPassword: async () => null },
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
        { ...via(h), session, readPassword: async () => ({ cancelled: true }) },
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
    const deps = { ...via(h), session, readPassword: typed(TEST_ADMIN.password) };
    await runLogin(deps, { email: TEST_ADMIN.email });
    const first = session.read()?.token ?? "";
    await runLogin(deps, { email: TEST_ADMIN.email });
    const second = session.read()?.token ?? "";
    expect(second).not.toBe(first);
    expect(await runWhoami({ ...h.io, client: h.clientWith(first) })).toBe(1);
    expect(await runWhoami({ ...h.io, client: h.clientWith(second) })).toBe(0);
  });

  it("con el doble factor (F8-T16) pide el código sin mostrarlo; uno malo se corrige", async () => {
    const h = harness({ anonymous: true });
    // El administrador activa el doble factor con su sesión de la CLI.
    const admin = h.clientWith(TEST_ADMIN_CLI_TOKEN);
    await admin.auth.totp.setup.$post();
    const confirmed = await admin.auth.totp.confirm.$post({
      json: { code: fakeTotpCode(fakeTotpStep(new Date())) },
    });
    const { recoveryCodes } = (await confirmed.json()) as { recoveryCodes: string[] };

    const session = createMemorySessionStore();
    const prompts: string[] = [];
    const code = await runLogin(
      {
        ...via(h),
        session,
        readPassword: typedInOrder(
          [TEST_ADMIN.password, "000000", recoveryCodes[0] ?? ""],
          prompts,
        ),
      },
      { email: TEST_ADMIN.email },
    );

    expect(code).toBe(0);
    expect(prompts).toEqual([
      `Contraseña de ${TEST_ADMIN.email}: `,
      "Código de tu app de claves (o uno de recuperación): ",
      "Código de tu app de claves (o uno de recuperación): ",
    ]);
    expect(h.errors()).toContain("El código no sirve o ya se usó");
    expect(session.read()?.token).toBeDefined();
    expect(h.text()).not.toContain(recoveryCodes[0] ?? "?");
    expect(h.text()).toContain(`Entraste como ${TEST_ADMIN.email}`);

    // Tres códigos malos: no entra y no guarda nada.
    const again = harness({ anonymous: true });
    const empty = createMemorySessionStore();
    expect(
      await runLogin(
        {
          ...via(h),
          ...again.io,
          session: empty,
          readPassword: typedInOrder([TEST_ADMIN.password, "000000", "000001", "000002"]),
        },
        { email: TEST_ADMIN.email },
      ),
    ).toBe(1);
    expect(again.errors()).toContain("TOTP_CODE_INVALID");
    expect(empty.read()).toBeNull();
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

  it("--api guarda el servidor con la sesión y el pedido de entrar va allí, sin token", async () => {
    const h = harness({ anonymous: true });
    const session = createMemorySessionStore();
    const code = await runLogin(
      { ...via(h), session, readPassword: typed(TEST_ADMIN.password) },
      { email: TEST_ADMIN.email, api: "https://agentsales.agentpey.com/" },
    );
    expect(code).toBe(0);
    expect(session.read()?.apiUrl).toBe("https://agentsales.agentpey.com");
    expect(h.sent).toEqual([
      { origin: "https://agentsales.agentpey.com", path: "/auth/login", token: null },
    ]);
    expect(h.text()).toContain("en https://agentsales.agentpey.com");
  });

  it("sin --api, AGENTSALES_API_URL elige el servidor; sin ninguna, la local no se guarda", async () => {
    const h = harness({ anonymous: true });
    const session = createMemorySessionStore();
    await runLogin(
      { ...via(h, "https://otro.agentpey.com"), session, readPassword: typed(TEST_ADMIN.password) },
      { email: TEST_ADMIN.email },
    );
    expect(session.read()?.apiUrl).toBe("https://otro.agentpey.com");

    const local = harness({ anonymous: true });
    const localSession = createMemorySessionStore();
    await runLogin(
      { ...via(local), session: localSession, readPassword: typed(TEST_ADMIN.password) },
      { email: TEST_ADMIN.email },
    );
    expect(localSession.read()).not.toHaveProperty("apiUrl");
    expect(local.sent[0]?.origin).toBe(localServerUrl(PORT));
    // Una dirección local, aunque venga de --api, tampoco se guarda (sigue el API_PORT del .env).
    await runLogin(
      { ...via(local), session: localSession, readPassword: typed(TEST_ADMIN.password) },
      { email: TEST_ADMIN.email, api: "http://localhost:9999" },
    );
    expect(localSession.read()).not.toHaveProperty("apiUrl");
    expect(local.sent.at(-2)?.origin).toBe("http://127.0.0.1:9999");
  });

  it("--api con http:// remoto se rechaza antes de pedir la contraseña", async () => {
    const h = harness({ anonymous: true });
    const session = createMemorySessionStore();
    let asked = false;
    const code = await runLogin(
      {
        ...via(h),
        session,
        readPassword: async () => {
          asked = true;
          return { cancelled: false, value: TEST_ADMIN.password };
        },
      },
      { email: TEST_ADMIN.email, api: "http://agentsales.agentpey.com" },
    );
    expect(code).toBe(1);
    expect(asked).toBe(false);
    expect(h.errors()).toContain("API_URL_INVALID");
    expect(h.errors()).toContain("https://agentsales.agentpey.com");
    expect(h.sent).toEqual([]);
    expect(session.read()).toBeNull();
  });

  it("entrar en otro servidor cierra la sesión anterior en el suyo, y su token no viaja al nuevo", async () => {
    const h = harness({ anonymous: true });
    const session = createMemorySessionStore();
    const deps = { ...via(h), session, readPassword: typed(TEST_ADMIN.password) };
    await runLogin(deps, { email: TEST_ADMIN.email });
    const first = session.read()?.token ?? "";
    h.sent.length = 0;
    await runLogin(deps, { email: TEST_ADMIN.email, api: "https://agentsales.agentpey.com" });
    expect(h.sent).toEqual([
      { origin: "https://agentsales.agentpey.com", path: "/auth/login", token: null },
      { origin: localServerUrl(PORT), path: "/auth/logout", token: first },
    ]);
  });

  it("whoami dice el servidor, y avisa si AGENTSALES_API_URL apunta a otro que el de la sesión", async () => {
    const h = harness({ anonymous: true });
    const remote = "https://agentsales.agentpey.com";
    expect(
      await runWhoami({
        ...h.io,
        client: h.client,
        target: { url: remote, source: "env", remote: true, sessionUrl: localServerUrl(PORT) },
      }),
    ).toBe(1);
    expect(h.text()).toContain(`Servidor: ${remote} (AGENTSALES_API_URL)`);
    expect(h.errors()).toContain(`Tu sesión es de ${localServerUrl(PORT)}`);
  });
});
