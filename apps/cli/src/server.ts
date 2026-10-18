// F8-T08 (spec F8 §4.5, D11): a qué servidor habla la CLI. `agentsales login --api <dirección>`
// la guarda con la sesión; `AGENTSALES_API_URL` manda sobre la guardada (una prueba puntual); sin
// ninguna, la API local del `.env`. Toda llamada va a `<dirección>/api`.

/** Los únicos nombres que pueden ir por `http://`: la API del Mac. */
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1"]);

/** La API local: solo escucha en IPv4 (spec F0 §4.5). */
export const localServerUrl = (port: number) => `http://127.0.0.1:${port}`;

/** Si la dirección (ya validada) es la del Mac. */
export const isLocalServer = (url: string) => LOCAL_HOSTNAMES.has(new URL(url).hostname);

export class ServerUrlError extends Error {
  readonly code = "API_URL_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ServerUrlError";
  }
}

/**
 * Valida una dirección de servidor y la deja como origen (`https://dominio[:puerto]`, sin barra
 * final). Solo `https://`, salvo `localhost` y `127.0.0.1`: el token y la contraseña nunca viajan
 * sin cifrar por internet. Sin ruta, consulta, fragmento ni usuario (la CLI agrega `/api`).
 */
export function parseServerUrl(raw: string): string {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ServerUrlError(`"${text}" no es una dirección (ejemplo: https://agentsales.cl)`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ServerUrlError(`la dirección debe empezar con https:// (dice ${url.protocol}//)`);
  }
  if (url.protocol === "http:" && !LOCAL_HOSTNAMES.has(url.hostname)) {
    throw new ServerUrlError(
      `http:// solo se acepta con localhost o 127.0.0.1; un servidor va con https://${url.host}`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ServerUrlError("la dirección no puede llevar usuario ni contraseña");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ServerUrlError(`solo el dominio, sin ruta: ${url.origin} (la CLI agrega /api)`);
  }
  // `localhost` es la misma API que `127.0.0.1` (solo escucha en IPv4): una sola forma, así el
  // token de una sesión local no se pierde por cómo se escribió la dirección.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  return url.origin;
}

/** De dónde salió la dirección. */
export type ServerSource = "env" | "session" | "local";

export type ServerTarget = {
  /** El origen (`https://dominio`), sin `/api`. */
  url: string;
  source: ServerSource;
  /** Que no es la API del Mac: `doctor` no revisa lo del worker en este Mac. */
  remote: boolean;
  /**
   * El servidor de la sesión guardada (el que emitió el token), o `null` sin sesión. El token solo
   * viaja a ese servidor.
   */
  sessionUrl: string | null;
};

export type ServerResolution =
  | { ok: true; target: ServerTarget }
  | { ok: false; error: ServerUrlError };

/**
 * Elige la dirección: `AGENTSALES_API_URL`, la guardada con la sesión o la local. Una sesión de F7
 * (sin dirección) es de la API local. Una guardada que ya no es válida (alguien editó el archivo)
 * es un error si es la que se usaría, no un salto silencioso a otra; con `AGENTSALES_API_URL`,
 * manda el entorno (y la sesión no sirve en ningún servidor).
 */
export function resolveServer(input: {
  envUrl: string | undefined;
  /** La sesión guardada (`null` sin sesión) y su dirección (`undefined` en una de F7). */
  session: { apiUrl?: string | undefined } | null;
  localPort: number;
}): ServerResolution {
  const local = localServerUrl(input.localPort);
  const saved = input.session?.apiUrl;
  let sessionUrl: string | null = null;
  let sessionError: ServerUrlError | null = null;
  if (input.session !== null) {
    try {
      sessionUrl = saved === undefined ? local : parseServerUrl(saved);
    } catch (error) {
      if (!(error instanceof ServerUrlError)) throw error;
      sessionError = new ServerUrlError(`la sesión guardada: ${error.message}`);
    }
  }
  const target = (url: string, source: ServerSource): ServerResolution => ({
    ok: true,
    target: { url, source, remote: !isLocalServer(url), sessionUrl },
  });
  const envUrl = input.envUrl?.trim() ?? "";
  if (envUrl !== "") {
    try {
      return target(parseServerUrl(envUrl), "env");
    } catch (error) {
      if (!(error instanceof ServerUrlError)) throw error;
      return { ok: false, error: new ServerUrlError(`AGENTSALES_API_URL: ${error.message}`) };
    }
  }
  if (sessionError !== null) return { ok: false, error: sessionError };
  if (sessionUrl !== null && saved !== undefined) return target(sessionUrl, "session");
  return target(local, "local");
}

/** `https://dominio (AGENTSALES_API_URL)`, para `whoami`, `status` y `doctor`. */
export function describeServer(target: ServerTarget): string {
  const origin: Record<ServerSource, string> = {
    env: "AGENTSALES_API_URL",
    session: "guardada con la sesión",
    local: "la API local",
  };
  return `${target.url} (${origin[target.source]})`;
}

/**
 * El token de la sesión solo viaja al servidor que lo emitió: con `AGENTSALES_API_URL` apuntando a
 * otro, la CLI va sin sesión (la API dirá que falta entrar) en vez de entregarle el token.
 */
export function tokenFor(target: ServerTarget, token: string | undefined): string | undefined {
  return target.sessionUrl !== null && target.sessionUrl === target.url ? token : undefined;
}

/** A qué servidor va un comando y con qué token: el que arma `context.api()`. */
export function clientTarget(
  resolution: ServerResolution,
  token: string | undefined,
): { ok: true; url: string; token: string | undefined } | { ok: false; error: ServerUrlError } {
  if (!resolution.ok) return resolution;
  return { ok: true, url: resolution.target.url, token: tokenFor(resolution.target, token) };
}

/**
 * Dónde se cierra la sesión (`agentsales logout`): en el servidor que la emitió, aunque
 * `AGENTSALES_API_URL` apunte a otro, para que no quede viva allí y el token no viaje a otro. Sin
 * sesión (o con una dirección guardada inválida), el servidor de siempre, sin token.
 */
export function logoutTarget(
  resolution: ServerResolution,
  token: string | undefined,
): ReturnType<typeof clientTarget> {
  if (resolution.ok && resolution.target.sessionUrl !== null && token !== undefined) {
    return { ok: true, url: resolution.target.sessionUrl, token };
  }
  return clientTarget(resolution, undefined);
}
