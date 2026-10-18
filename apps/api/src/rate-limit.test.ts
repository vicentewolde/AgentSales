import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { ErrorBody } from "./errors.js";
import {
  clientIpResolver,
  createRateLimiter,
  RATE_LIMITS,
  type RateLimitDeps,
  rateLimitKeyOf,
} from "./rate-limit.js";
import { TEST_ADMIN, TEST_ADMIN_TOKEN, testDeps } from "./testing/index.js";

// F8-T14 (spec F8 §4.8, ADR-0026): los límites por IP y por usuario, en memoria.

const MINUTE = 60_000;
const json = { "content-type": "application/json", origin: "http://localhost:5173" };

/** La app con un reloj propio y la IP en `X-Test-IP` (como `Fly-Client-IP` en el servidor). */
function setup() {
  let clock = 0;
  const rateLimit: RateLimitDeps = {
    limiter: createRateLimiter({ now: () => clock }),
    clientIp: clientIpResolver("X-Test-IP", () => "socket"),
  };
  const app = createApp(testDeps({ rateLimit }));
  const login = (ip: string, password = "equivocada") =>
    app.request("/auth/login", {
      method: "POST",
      headers: { ...json, "x-test-ip": ip },
      body: JSON.stringify({ email: TEST_ADMIN.email, password }),
    });
  return {
    app,
    login,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const codeOf = async (response: Response) => ((await response.json()) as ErrorBody).error.code;

describe("createRateLimiter", () => {
  it("cuenta por clave y por ventana fija; al vencer, la ventana se renueva", () => {
    let clock = 0;
    const limiter = createRateLimiter({ now: () => clock });
    const rule = { name: "r", limit: 2, windowMs: MINUTE };

    expect(limiter.hit("a", rule)).toBeNull();
    clock = 10_000;
    expect(limiter.hit("a", rule)).toBeNull();
    expect(limiter.hit("a", rule)).toBe(50_000);
    expect(limiter.hit("b", rule)).toBeNull();
    clock = MINUTE;
    expect(limiter.hit("a", rule)).toBeNull();
  });

  it("lleno, borra primero las del tope general y deja los de entrar", () => {
    const limiter = createRateLimiter({ now: () => 0, maxKeys: 3 });
    const login = { name: "login-minute", limit: 1, windowMs: MINUTE };
    const api = { name: RATE_LIMITS.api[0].name, limit: 1, windowMs: MINUTE };
    limiter.hit("a", login);
    limiter.hit("b", api);
    limiter.hit("c", api);
    // Llega una clave nueva: se va la más vieja del tope general, no el intento de entrar.
    limiter.hit("d", login);
    expect(limiter.hit("a", login)).not.toBeNull();
    expect(limiter.hit("b", api)).toBeNull();
  });

  it("con demasiadas claves borra las vencidas y nunca crece sin fin", () => {
    let clock = 0;
    const limiter = createRateLimiter({ now: () => clock, maxKeys: 3 });
    const rule = { name: "r", limit: 1, windowMs: MINUTE };
    for (const key of ["a", "b", "c"]) limiter.hit(key, rule);
    expect(limiter.hit("a", rule)).not.toBeNull();
    clock = MINUTE;
    // Llena de nuevo: las tres de antes vencieron y se borran.
    for (const key of ["d", "e", "f"]) expect(limiter.hit(key, rule)).toBeNull();
    expect(limiter.hit("a", rule)).toBeNull();
  });
});

describe("la IP del cliente", () => {
  const contextWith = (headers: Record<string, string>) =>
    ({ req: { header: (name: string) => headers[name.toLowerCase()] } }) as unknown as Context;

  it("con CLIENT_IP_HEADER usa esa cabecera; si no viene, la del socket", () => {
    const resolve = clientIpResolver("Fly-Client-IP", () => "10.0.0.1");
    expect(resolve(contextWith({ "fly-client-ip": "200.1.2.3" }))).toBe("200.1.2.3");
    expect(resolve(contextWith({}))).toBe("10.0.0.1");
  });

  it("una IPv6 cuenta por su /64; una IPv4 escrita como IPv6, como la IPv4", () => {
    expect(rateLimitKeyOf("2001:db8:aa:bb:1:2:3:4")).toBe("2001:db8:aa:bb::/64");
    expect(rateLimitKeyOf("2001:0db8:00aa:00bb:ffff::1")).toBe("2001:db8:aa:bb::/64");
    expect(rateLimitKeyOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitKeyOf("::1")).toBe("0:0:0:0::/64");
    expect(rateLimitKeyOf("::ffff:200.1.2.3")).toBe("200.1.2.3");
    expect(rateLimitKeyOf("200.1.2.3")).toBe("200.1.2.3");
  });

  it("sin configurarla, X-Forwarded-For se ignora", () => {
    const resolve = clientIpResolver(undefined, () => "10.0.0.1");
    expect(resolve(contextWith({ "x-forwarded-for": "1.1.1.1", "fly-client-ip": "2.2.2.2" }))).toBe(
      "10.0.0.1",
    );
    expect(clientIpResolver(undefined, () => undefined)(contextWith({}))).toBe("unknown");
  });
});

describe("los límites en la API", () => {
  it("entrar: 10 por minuto por IP, con 429 RATE_LIMITED y Retry-After; otra IP sigue", async () => {
    const { login, advance } = setup();
    for (let attempt = 0; attempt < 9; attempt += 1) {
      expect((await login("1.1.1.1")).status).toBe(401);
    }
    // El décimo fallo bloquea al usuario (F7); el undécimo pedido ya pasa el tope de la IP.
    expect((await login("1.1.1.1")).status).toBe(401);
    advance(15_000);
    const limited = await login("1.1.1.1");
    expect(limited.status).toBe(429);
    expect(await codeOf(limited)).toBe("RATE_LIMITED");
    expect(limited.headers.get("retry-after")).toBe("45");
    expect(await codeOf(await login("2.2.2.2"))).toBe("AUTH_LOCKED");
  });

  it("entrar: además 50 por hora por IP, aunque cada minuto quede bajo 10", async () => {
    const { login, advance } = setup();
    for (let minute = 0; minute < 5; minute += 1) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        expect((await login("3.3.3.3")).status).not.toBe(429);
      }
      advance(MINUTE);
    }
    const limited = await login("3.3.3.3");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBe(55 * 60);
  });

  it("cambiar de dirección dentro del mismo /64 no salta el tope de entrar", async () => {
    const { login } = setup();
    for (let n = 0; n < 10; n += 1) {
      expect((await login(`2001:db8:1:2::${n + 1}`)).status).not.toBe(429);
    }
    expect((await login("2001:db8:1:2::ffff")).status).toBe(429);
    expect((await login("2001:db8:1:3::1")).status).not.toBe(429);
  });

  it("aceptar una invitación: 10 por hora por IP", async () => {
    const { app } = setup();
    const accept = () =>
      app.request("/auth/invitations/accept", {
        method: "POST",
        headers: { ...json, "x-test-ip": "4.4.4.4" },
        body: JSON.stringify({ token: "no-existe", password: "una-clave-larga-123" }),
      });
    for (let attempt = 0; attempt < 10; attempt += 1) expect((await accept()).status).toBe(410);
    expect((await accept()).status).toBe(429);
  });

  it("toda la API: 300 por minuto por IP y, con sesión, también por usuario", async () => {
    const { app, advance } = setup();
    const health = (ip: string, token?: string) =>
      app.request("/health", {
        headers: {
          "x-test-ip": ip,
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
      });
    for (let attempt = 0; attempt < RATE_LIMITS.api[0].limit; attempt += 1) {
      expect((await health("5.5.5.5")).status).toBe(200);
    }
    expect((await health("5.5.5.5")).status).toBe(429);

    // El mismo usuario desde muchas IP: lo frena su propio tope.
    advance(MINUTE);
    for (let attempt = 0; attempt < RATE_LIMITS.api[0].limit; attempt += 1) {
      expect((await health(`6.0.0.${attempt % 250}`, TEST_ADMIN_TOKEN)).status).toBe(200);
    }
    expect((await health("7.7.7.7", TEST_ADMIN_TOKEN)).status).toBe(429);
    expect((await health("7.7.7.7")).status).toBe(200);
  });
});
