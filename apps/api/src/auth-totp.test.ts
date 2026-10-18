import { Writable } from "node:stream";
import { createLogger } from "@agentsales/config";
import { fakeTotpCode, fakeTotpStep } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { ErrorBody } from "./errors.js";
import {
  TEST_ADMIN,
  TEST_ADMIN_CLI_TOKEN,
  TEST_ADMIN_TOKEN,
  testAuth,
  testDeps,
} from "./testing/index.js";

// F8-T15 (spec F8 §4.8, ADR-0026): el doble factor en la API: activar, entrar en dos pasos con un
// código o uno de recuperación, desactivar, y que la clave y los códigos nunca salgan en el log.

const ORIGIN = "http://localhost:5173";

function setup() {
  const auth = testAuth();
  const logged: string[] = [];
  const logger = createLogger(
    { level: "debug" },
    new Writable({
      write: (chunk, _encoding, callback) => {
        logged.push(String(chunk));
        callback();
      },
    }),
  );
  const app = createApp(testDeps({ logger, auth }));
  const send = (path: string, init: { token?: string; body?: unknown; method?: string } = {}) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  /** Activa el doble factor del administrador con su sesión de la CLI. */
  const enable = async () => {
    const setupResponse = await send("/auth/totp/setup", { token: TEST_ADMIN_CLI_TOKEN, body: {} });
    const { secret, otpauthUrl } = (await setupResponse.json()) as {
      secret: string;
      otpauthUrl: string;
    };
    const confirm = await send("/auth/totp/confirm", {
      token: TEST_ADMIN_CLI_TOKEN,
      body: { code: fakeTotpCode(fakeTotpStep(new Date())) },
    });
    const { recoveryCodes } = (await confirm.json()) as { recoveryCodes: string[] };
    return { setupResponse, confirm, secret, otpauthUrl, recoveryCodes };
  };
  const loginCli = async () =>
    send("/auth/login", {
      body: { email: TEST_ADMIN.email, password: TEST_ADMIN.password, client: "cli" },
    });
  return { app, auth, logged, send, enable, loginCli };
}

const errorOf = async (response: Response) => ((await response.json()) as ErrorBody).error;

describe("el doble factor en la API", () => {
  it("activar: la clave y el enlace, sin caché; confirmar da 10 códigos y cierra las demás sesiones", async () => {
    const { send, enable } = setup();
    expect(await (await send("/auth/totp", { token: TEST_ADMIN_CLI_TOKEN })).json()).toEqual({
      enabled: false,
      recoveryCodesLeft: 0,
    });

    const { setupResponse, confirm, otpauthUrl, recoveryCodes } = await enable();

    expect(setupResponse.status).toBe(200);
    expect(setupResponse.headers.get("cache-control")).toBe("no-store");
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\/AgentSales%3Aadmin%40ejemplo\.cl\?secret=/);
    expect(confirm.status).toBe(200);
    expect(confirm.headers.get("cache-control")).toBe("no-store");
    expect(recoveryCodes).toHaveLength(10);
    // La sesión con la que se activó sigue; la del panel se cerró.
    const me = await send("/auth/me", { token: TEST_ADMIN_CLI_TOKEN });
    expect(((await me.json()) as { user: { totpEnabled: boolean } }).user.totpEnabled).toBe(true);
    expect((await send("/auth/me", { token: TEST_ADMIN_TOKEN })).status).toBe(401);
    expect(await (await send("/auth/totp", { token: TEST_ADMIN_CLI_TOKEN })).json()).toEqual({
      enabled: true,
      recoveryCodesLeft: 10,
    });
    // Ya activo: empezar de nuevo es 409.
    const again = await send("/auth/totp/setup", { token: TEST_ADMIN_CLI_TOKEN, body: {} });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe("TOTP_ALREADY_ENABLED");
  });

  it("entrar: la contraseña da el segundo paso sin sesión; el código la abre", async () => {
    const { send, enable, loginCli } = setup();
    const { recoveryCodes } = await enable();

    const first = await loginCli();
    expect(first.status).toBe(200);
    expect(first.headers.get("set-cookie")).toBeNull();
    const step = (await first.json()) as {
      totpRequired: boolean;
      challenge: string;
      token?: string;
    };
    expect(step.totpRequired).toBe(true);
    expect(step).not.toHaveProperty("token");

    const wrong = await send("/auth/login/totp", {
      body: { challenge: step.challenge, code: "000000", client: "cli" },
    });
    expect(wrong.status).toBe(401);
    expect((await errorOf(wrong)).code).toBe("TOTP_CODE_INVALID");

    const second = await send("/auth/login/totp", {
      body: { challenge: step.challenge, code: recoveryCodes[0], client: "cli" },
    });
    expect(second.status).toBe(200);
    const { token } = (await second.json()) as { token: string };
    expect((await send("/auth/me", { token })).status).toBe(200);

    // El desafío ya se usó.
    const reused = await send("/auth/login/totp", {
      body: { challenge: step.challenge, code: recoveryCodes[1], client: "cli" },
    });
    expect((await errorOf(reused)).code).toBe("LOGIN_CHALLENGE_INVALID");
  });

  it("el panel recibe la sesión del segundo paso en la cookie", async () => {
    const { send, enable } = setup();
    const { recoveryCodes } = await enable();
    const first = await send("/auth/login", {
      body: { email: TEST_ADMIN.email, password: TEST_ADMIN.password },
    });
    const { challenge } = (await first.json()) as { challenge: string };

    const second = await send("/auth/login/totp", {
      body: { challenge, code: recoveryCodes[0] },
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("set-cookie")).toMatch(/^agentsales_session=.+HttpOnly/);
    expect(await second.json()).not.toHaveProperty("token");
  });

  it("desactivar pide un código; sin él sigue activo", async () => {
    const { send, enable } = setup();
    const { recoveryCodes } = await enable();

    const wrong = await send("/auth/totp/disable", {
      token: TEST_ADMIN_CLI_TOKEN,
      body: { code: "000000" },
    });
    expect(wrong.status).toBe(401);
    const ok = await send("/auth/totp/disable", {
      token: TEST_ADMIN_CLI_TOKEN,
      body: { code: recoveryCodes[2] },
    });
    expect(ok.status).toBe(204);
    const login = await send("/auth/login", {
      body: { email: TEST_ADMIN.email, password: TEST_ADMIN.password, client: "cli" },
    });
    expect(await login.json()).toHaveProperty("token");
  });

  it("la clave, los códigos y el desafío nunca salen en el log", async () => {
    const { send, enable, loginCli, logged } = setup();
    const { secret, recoveryCodes } = await enable();
    const { challenge } = (await (await loginCli()).json()) as { challenge: string };
    await send("/auth/login/totp", { body: { challenge, code: "000000", client: "cli" } });
    await send("/auth/login/totp", { body: { challenge, code: recoveryCodes[0], client: "cli" } });

    const text = logged.join("");
    expect(text).not.toContain(secret);
    expect(text).not.toContain(challenge);
    for (const code of recoveryCodes) expect(text).not.toContain(code);
  });
});
