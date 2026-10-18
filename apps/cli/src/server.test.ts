import { describe, expect, it } from "vitest";
import {
  clientTarget,
  describeServer,
  localServerUrl,
  logoutTarget,
  parseServerUrl,
  resolveServer,
  ServerUrlError,
  tokenFor,
} from "./server.js";

// F8-T08 (spec F8 §4.5, D11): a qué servidor habla la CLI.

describe("parseServerUrl", () => {
  it("deja el origen, sin barra final", () => {
    expect(parseServerUrl(" https://agentsales.agentpey.com/ ")).toBe(
      "https://agentsales.agentpey.com",
    );
    expect(parseServerUrl("https://agentsales.cl:8443")).toBe("https://agentsales.cl:8443");
  });

  it("http:// solo con localhost o 127.0.0.1", () => {
    // `localhost` queda como `127.0.0.1`: la misma API, y el mismo servidor para el token.
    expect(parseServerUrl("http://localhost:8787")).toBe("http://127.0.0.1:8787");
    expect(parseServerUrl("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    for (const remote of [
      "http://agentsales.agentpey.com",
      "http://192.168.1.10:8787",
      "http://localhost.evil.com",
    ]) {
      expect(() => parseServerUrl(remote)).toThrow(ServerUrlError);
    }
    expect(() => parseServerUrl("http://agentsales.agentpey.com")).toThrow(/https:\/\//);
  });

  it("rechaza otro protocolo, una ruta, una consulta o un usuario", () => {
    for (const bad of [
      "agentsales.agentpey.com",
      "ftp://agentsales.agentpey.com",
      "https://agentsales.agentpey.com/api",
      "https://agentsales.agentpey.com/?x=1",
      "https://agentsales.agentpey.com/#x",
      "https://yo:clave@agentsales.agentpey.com",
    ]) {
      expect(() => parseServerUrl(bad), bad).toThrow(ServerUrlError);
    }
  });
});

describe("resolveServer", () => {
  const remote = "https://agentsales.agentpey.com";
  const local = localServerUrl(8787);

  it("sin sesión ni AGENTSALES_API_URL, la API local del .env", () => {
    const resolved = resolveServer({ envUrl: undefined, session: null, localPort: 8787 });
    expect(resolved).toEqual({
      ok: true,
      target: { url: local, source: "local", remote: false, sessionUrl: null },
    });
  });

  it("una sesión de F7 (sin dirección) sigue siendo local, con el puerto del .env", () => {
    const resolved = resolveServer({ envUrl: "", session: {}, localPort: 9000 });
    expect(resolved).toEqual({
      ok: true,
      target: {
        url: "http://127.0.0.1:9000",
        source: "local",
        remote: false,
        sessionUrl: "http://127.0.0.1:9000",
      },
    });
  });

  it("la dirección guardada con la sesión", () => {
    const resolved = resolveServer({
      envUrl: undefined,
      session: { apiUrl: remote },
      localPort: 8787,
    });
    expect(resolved).toEqual({
      ok: true,
      target: { url: remote, source: "session", remote: true, sessionUrl: remote },
    });
  });

  it("AGENTSALES_API_URL manda sobre la guardada", () => {
    const resolved = resolveServer({
      envUrl: "https://otro.agentpey.com",
      session: { apiUrl: remote },
      localPort: 8787,
    });
    expect(resolved).toEqual({
      ok: true,
      target: {
        url: "https://otro.agentpey.com",
        source: "env",
        remote: true,
        sessionUrl: remote,
      },
    });
  });

  it("un AGENTSALES_API_URL con http:// remoto es un error, no un salto a otra dirección", () => {
    const resolved = resolveServer({
      envUrl: "http://agentsales.agentpey.com",
      session: { apiUrl: remote },
      localPort: 8787,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.message).toMatch(/^AGENTSALES_API_URL: /);
  });

  it("una dirección guardada que alguien cambió a http:// remoto es un error", () => {
    const resolved = resolveServer({
      envUrl: undefined,
      session: { apiUrl: "http://agentsales.agentpey.com" },
      localPort: 8787,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.message).toMatch(/^la sesión guardada: /);
  });
});

describe("resolveServer · una sesión guardada inválida", () => {
  it("con AGENTSALES_API_URL válida manda el entorno, y la sesión no vale en ningún servidor", () => {
    const resolved = resolveServer({
      envUrl: "https://agentsales.agentpey.com",
      session: { apiUrl: "http://agentsales.agentpey.com" },
      localPort: 8787,
    });
    expect(resolved).toEqual({
      ok: true,
      target: {
        url: "https://agentsales.agentpey.com",
        source: "env",
        remote: true,
        sessionUrl: null,
      },
    });
  });
});

describe("clientTarget y logoutTarget", () => {
  const remote = "https://agentsales.agentpey.com";
  const resolution = (url: string, sessionUrl: string | null) =>
    ({
      ok: true,
      target: { url, source: "env", remote: true, sessionUrl },
    }) as const;

  it("un comando va al servidor elegido, con el token solo si es el de la sesión", () => {
    expect(clientTarget(resolution(remote, remote), "t")).toEqual({
      ok: true,
      url: remote,
      token: "t",
    });
    expect(clientTarget(resolution("https://otro.cl", remote), "t")).toEqual({
      ok: true,
      url: "https://otro.cl",
      token: undefined,
    });
  });

  it("logout cierra en el servidor de la sesión aunque AGENTSALES_API_URL apunte a otro", () => {
    expect(logoutTarget(resolution("https://otro.cl", remote), "t")).toEqual({
      ok: true,
      url: remote,
      token: "t",
    });
    // Sin sesión, al servidor elegido y sin token.
    expect(logoutTarget(resolution("https://otro.cl", null), undefined)).toEqual({
      ok: true,
      url: "https://otro.cl",
      token: undefined,
    });
  });

  it("una dirección inválida no llama a nadie", () => {
    const error = new ServerUrlError("AGENTSALES_API_URL: mala");
    expect(clientTarget({ ok: false, error }, "t")).toEqual({ ok: false, error });
    expect(logoutTarget({ ok: false, error }, "t")).toEqual({ ok: false, error });
  });
});

describe("tokenFor", () => {
  const target = (url: string, sessionUrl: string | null) => ({
    url,
    source: "env" as const,
    remote: true,
    sessionUrl,
  });

  it("el token solo viaja al servidor que lo emitió", () => {
    const remote = "https://agentsales.agentpey.com";
    expect(tokenFor(target(remote, remote), "t")).toBe("t");
    expect(tokenFor(target("https://otro.agentpey.com", remote), "t")).toBeUndefined();
    expect(tokenFor(target(remote, localServerUrl(8787)), "t")).toBeUndefined();
    expect(tokenFor(target(remote, null), "t")).toBeUndefined();
  });
});

describe("describeServer", () => {
  it("dice de dónde salió la dirección", () => {
    expect(
      describeServer({
        url: "https://agentsales.agentpey.com",
        source: "session",
        remote: true,
        sessionUrl: null,
      }),
    ).toBe("https://agentsales.agentpey.com (guardada con la sesión)");
  });
});
