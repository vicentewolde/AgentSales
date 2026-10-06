import { AppError, type ListingStatus, type Media, type PlatformAccount } from "@agentsales/core";
import {
  abortableSleep,
  createInstagramGraph,
  INSTAGRAM_GRAPH_VERSION,
  INSTAGRAM_POLL,
} from "@agentsales/publishers";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  describeUnexpected,
  IG_SMOKE_CAPTION,
  type IgSmokeDeps,
  runIgSmoke,
  smokeGraph,
} from "./ig-smoke.js";

const GRAPH = `https://graph.instagram.com/${INSTAGRAM_GRAPH_VERSION}`;
const TOKEN = "IGAAsmoke-token-secreto";
const SIGNED_URL = "https://r2.example/listings/p001/cover.jpg?X-Amz-Signature=firma-secreta";
const IG_USER = "17841400000000001";
const CONTAINER = "18000000000000001";

/** Lo que recibió el Instagram simulado (nunca sale a internet). */
type Recorded = { method: string; url: URL; authorization: string | null; form: URLSearchParams };
const requests: Recorded[] = [];
const server = setupServer();
server.events.on("request:start", async ({ request }) => {
  requests.push({
    method: request.method,
    url: new URL(request.url),
    authorization: request.headers.get("authorization"),
    form: new URLSearchParams(request.method === "POST" ? await request.clone().text() : ""),
  });
});
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());

/** Las llamadas a `media_publish`: el criterio central de F3-T19 es que nunca hay una. */
const publishCalls = () => requests.filter((r) => r.url.pathname.endsWith("/media_publish"));

/**
 * Instagram simulado: crear el contenedor responde `create` y cada consulta de estado toma el
 * siguiente de `statuses` (el último se repite). `media_publish` responde como Meta, para que una
 * llamada no se note en la salida: solo la detecta `publishCalls`.
 */
function useInstagram({
  create = () => HttpResponse.json({ id: CONTAINER }),
  statuses = [{ status_code: "FINISHED" }],
}: {
  create?: () => Response;
  statuses?: readonly Record<string, string>[];
} = {}) {
  let polls = 0;
  server.use(
    http.post(`${GRAPH}/:user/media`, create),
    http.post(`${GRAPH}/:user/media_publish`, () => HttpResponse.json({ id: "media-publicado" })),
    http.get(`${GRAPH}/:container`, () => {
      const status = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      return HttpResponse.json(status);
    }),
  );
  return { polls: () => polls };
}

const metaError = (status: number, code: number, subcode?: number) => () =>
  HttpResponse.json(
    { error: { message: `mensaje de Meta con ${TOKEN}`, code, error_subcode: subcode } },
    { status },
  );

const account = (
  overrides: Partial<PlatformAccount> = {},
): Awaited<ReturnType<IgSmokeDeps["accounts"]["list"]>>[number] => ({
  id: "account-1",
  brokerId: "broker-1",
  platform: "instagram",
  status: "connected",
  externalAccountId: IG_USER,
  displayName: "@corredora",
  hasCredentials: true,
  ...overrides,
});

const cover = (
  storagePath: string,
  overrides: Partial<Media> = {},
): Awaited<ReturnType<IgSmokeDeps["media"]["listByListing"]>>[number] => ({
  id: `media-${storagePath}`,
  role: "rendered",
  variant: "cover",
  storagePath,
  mime: "image/jpeg",
  width: 1080,
  height: 1350,
  bytes: 300 * 1024,
  ...overrides,
});

type ListingRow = { id: string; brokerId: string; externalRef: string; status?: ListingStatus };

type Setup = {
  accounts?: ReturnType<typeof account>[];
  /** Por defecto en `ready`. */
  listings?: ListingRow[];
  media?: Record<string, ReturnType<typeof cover>[]>;
  /** Tipo de cada objeto en R2 por ruta; `null` si no está. Por defecto, todos `image/jpeg`. */
  stored?: Record<string, string | null>;
};

/** Dependencias del smoke con datos a mano, el cliente de Instagram real (contra msw) y reloj falso. */
function setup({
  accounts = [account()],
  listings = [
    { id: "listing-2", brokerId: "broker-1", externalRef: "P002" },
    { id: "listing-1", brokerId: "broker-1", externalRef: "P001" },
  ],
  media = {
    "listing-1": [cover("p001/cover.jpg")],
    "listing-2": [cover("p002/cover.jpg")],
  },
  stored = {},
}: Setup = {}) {
  let clock = 0;
  const sleeps: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const signed: { path: string; ttl: number | undefined }[] = [];
  const credentialsOf: string[] = [];
  const deps: IgSmokeDeps = {
    accounts: {
      list: async () => accounts,
      getCredentials: async (id) => {
        credentialsOf.push(id);
        return { accessToken: TOKEN };
      },
    },
    brokers: {
      list: async () => [
        { id: "broker-1", slug: "corredora-uno" },
        { id: "broker-2", slug: "corredora-dos" },
      ],
    },
    listings: {
      list: async () => listings.map((listing) => ({ status: "ready" as const, ...listing })),
    },
    media: { listByListing: async (id) => media[id] ?? [] },
    storage: {
      head: async (path) => {
        const contentType = path in stored ? stored[path] : "image/jpeg";
        return contentType === null ? null : { size: 300 * 1024, contentType };
      },
      signedReadUrl: async (path, ttl) => {
        signed.push({ path, ttl });
        return SIGNED_URL;
      },
    },
    graph: smokeGraph(createInstagramGraph()),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    print: (line) => out.push(line),
    printError: (line) => err.push(line),
  };
  return { deps, sleeps, out, err, signed, credentialsOf };
}

/** La salida de cada corrida del test, para las revisiones comunes de `afterEach`. */
const outputs: string[][] = [];
async function run(ctx: ReturnType<typeof setup>, options = {}) {
  outputs.push(ctx.out, ctx.err);
  return runIgSmoke(ctx.deps, options);
}

afterEach(() => {
  // Se limpia antes de afirmar: un fallo aquí no arrastra a los tests siguientes.
  const published = publishCalls();
  const text = JSON.stringify(outputs);
  outputs.length = 0;
  requests.length = 0;
  server.resetHandlers();
  // En todos los casos: nunca `media_publish`, y la salida no lleva el token, la firma ni el
  // mensaje de Meta.
  expect(published).toEqual([]);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain("firma-secreta");
  expect(text).not.toContain("mensaje de Meta");
});

describe("runIgSmoke", () => {
  it("crea un contenedor de imagen con la URL firmada de la portada y termina en FINISHED", async () => {
    useInstagram();
    const ctx = setup();

    expect(await run(ctx)).toBe(0);

    // La portada del primer aviso por id_propiedad, firmada con la vida de una publicación (1 h).
    expect(ctx.signed).toEqual([{ path: "p001/cover.jpg", ttl: 3600 }]);
    const create = requests.filter((r) => r.method === "POST");
    expect(create).toHaveLength(1);
    expect(create[0]?.url.pathname).toBe(`/${INSTAGRAM_GRAPH_VERSION}/${IG_USER}/media`);
    expect(create[0]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(Object.fromEntries(create[0]?.form ?? [])).toEqual({
      image_url: SIGNED_URL,
      caption: IG_SMOKE_CAPTION,
    });
    expect(create[0]?.url.search).toBe("");
    expect(ctx.out).toEqual([
      "Cuenta: @corredora (corredora-uno)",
      "Imagen: portada de P001 (1080×1350, 300 KB)",
      `Contenedor ${CONTAINER} creado; esperando a que Instagram lo procese…`,
      "  FINISHED (0 s)",
      "✓ Meta descargó la imagen desde la URL firmada de R2. No se publicó nada: el contenedor vence solo en 24 h",
    ]);
    expect(ctx.err).toEqual([]);
    expect(ctx.sleeps).toEqual([]);
  });

  it("sondea con el ritmo del publisher mientras sigue en proceso", async () => {
    const ig = useInstagram({
      statuses: [
        { status_code: "IN_PROGRESS" },
        { status_code: "IN_PROGRESS" },
        { status_code: "UNKNOWN_NEW" },
        { status_code: "FINISHED" },
      ],
    });
    const ctx = setup();

    expect(await run(ctx)).toBe(0);
    expect(ig.polls()).toBe(4);
    expect(ctx.sleeps).toEqual(INSTAGRAM_POLL.firstDelaysMs.slice(0, 3));
    expect(ctx.out.filter((line) => line.startsWith("  "))).toEqual([
      "  IN_PROGRESS (0 s)",
      "  IN_PROGRESS (5 s)",
      "  UNKNOWN (15 s)",
      "  FINISHED (35 s)",
    ]);
  });

  it("si el contenedor queda en ERROR, muestra el estado, el código y el subcódigo", async () => {
    useInstagram({ statuses: [{ status_code: "ERROR", status: "Error: 2207052" }] });
    const ctx = setup();

    expect(await run(ctx)).toBe(1);
    expect(ctx.out.at(-1)).toBe("  ERROR (0 s)");
    expect(ctx.err).toEqual([
      "✗ IG_MEDIA_FETCH_FAILED: Instagram no pudo descargar una foto o el video (subcódigo 2207052)",
      "  → Meta no pudo descargar la URL firmada de R2: es el riesgo de la nota §5 (plan B: prefijo público)",
    ]);
  });

  it("un ERROR sin subcódigo es IG_UNAVAILABLE", async () => {
    useInstagram({ statuses: [{ status_code: "ERROR", status: "" }] });
    const ctx = setup();

    expect(await run(ctx)).toBe(1);
    expect(ctx.err).toEqual(["✗ IG_UNAVAILABLE: El contenedor quedó en ERROR, sin subcódigo"]);
  });

  it("un ERROR por la imagen dice qué tiene, no solo el código", async () => {
    useInstagram({ statuses: [{ status_code: "ERROR", status: "Error: 2207004" }] });
    const ctx = setup();

    expect(await run(ctx)).toBe(1);
    expect(ctx.err).toEqual([
      "✗ IG_MEDIA_REJECTED: Una imagen pesa más de 8 MB (subcódigo 2207004)",
      "  → Meta descargó la imagen pero la rechazó: revisa el formato de la portada",
    ]);
  });

  it("si Meta rechaza crear el contenedor, muestra el código y el subcódigo de Meta sin su mensaje", async () => {
    useInstagram({ create: metaError(400, 9004, 2207052) });
    const ctx = setup();

    expect(await run(ctx)).toBe(1);
    expect(ctx.err).toEqual([
      "✗ IG_MEDIA_FETCH_FAILED: Instagram no pudo descargar una foto o el video (código 9004, subcódigo 2207052)",
      "  → Meta no pudo descargar la URL firmada de R2: es el riesgo de la nota §5 (plan B: prefijo público)",
    ]);
    expect(requests.filter((r) => r.method === "GET")).toEqual([]);
  });

  it("un token vencido pide reconectar la cuenta", async () => {
    useInstagram({ create: metaError(400, 190) });
    const ctx = setup();

    expect(await run(ctx)).toBe(1);
    expect(ctx.err).toEqual([
      "✗ IG_AUTH_INVALID: El acceso a Instagram venció o ya no es válido: reconecta la cuenta (código 190)",
      "  → El token venció o se revocó: vuelve a conectar la cuenta",
    ]);
  });

  it("sin red, IG_UNAVAILABLE sin la cola de reintento del publisher", async () => {
    useInstagram({ create: () => HttpResponse.error() });
    const ctx = setup();

    expect(await run(ctx)).toBe(1);
    expect(ctx.err).toEqual(["✗ IG_UNAVAILABLE: No hubo conexión con Instagram"]);
  });

  it("si no termina en 5 minutos, IG_CONTAINER_TIMEOUT tras la última consulta en el plazo", async () => {
    const ig = useInstagram({ statuses: [{ status_code: "IN_PROGRESS" }] });
    const ctx = setup();

    expect(await run(ctx)).toBe(1);
    // 5, 10, 20 y 30 s, después cada 60 s, y la última espera recortada para consultar justo en el plazo.
    expect(ctx.sleeps).toEqual([5, 10, 20, 30, 60, 60, 60, 55].map((s) => s * 1000));
    expect(ctx.sleeps.reduce((total, ms) => total + ms, 0)).toBe(INSTAGRAM_POLL.maxWaitMs);
    expect(ctx.out.at(-1)).toBe("  IN_PROGRESS (300 s)");
    expect(ig.polls()).toBe(ctx.sleeps.length + 1);
    expect(ctx.err).toEqual([
      "✗ IG_CONTAINER_TIMEOUT: Instagram no terminó de procesar la imagen en 300 s",
    ]);
  });

  it.each(["EXPIRED", "PUBLISHED"])(
    "un contenedor nuevo en %s se informa y no se toca",
    async (code) => {
      useInstagram({ statuses: [{ status_code: code }] });
      const ctx = setup();

      expect(await run(ctx)).toBe(1);
      expect(ctx.err).toEqual([`✗ IG_SMOKE_UNEXPECTED_STATUS: El contenedor quedó en ${code}`]);
    },
  );

  describe("antes de llamar a Instagram", () => {
    it("sin cuenta conectada, pide conectarla", async () => {
      const ctx = setup({
        accounts: [
          account({ status: "expired" }),
          account({ id: "account-2", status: "revoked", hasCredentials: false }),
          account({ id: "account-3", platform: "portal_inmobiliario" }),
        ],
      });

      expect(await run(ctx)).toBe(1);
      expect(ctx.err).toEqual([
        "✗ ACCOUNT_NOT_CONNECTED: No hay una cuenta de Instagram conectada",
        "  → Conecta la cuenta: pbpaste | pnpm -s cli accounts connect instagram --broker <slug> --token-stdin",
      ]);
      expect(requests).toEqual([]);
      expect(ctx.credentialsOf).toEqual([]);
    });

    it("con cuentas en dos corredores pide --broker, y con él usa la de ese corredor", async () => {
      const accounts = [
        account(),
        account({ id: "account-2", brokerId: "broker-2", displayName: "@otra" }),
      ];
      const listings = [
        { id: "listing-1", brokerId: "broker-1", externalRef: "P001" },
        { id: "listing-9", brokerId: "broker-2", externalRef: "P009" },
      ];
      const media = {
        "listing-1": [cover("p001/cover.jpg")],
        "listing-9": [cover("p009/cover.jpg")],
      };
      const ambiguous = setup({ accounts, listings, media });

      expect(await run(ambiguous)).toBe(1);
      expect(ambiguous.err).toEqual([
        "✗ BROKER_REQUIRED: Hay cuentas de Instagram conectadas en varios corredores: elige uno con --broker <slug>",
      ]);
      expect(requests).toEqual([]);

      useInstagram();
      const chosen = setup({ accounts, listings, media });
      expect(await run(chosen, { brokerSlug: "corredora-dos" })).toBe(0);
      expect(chosen.out[0]).toBe("Cuenta: @otra (corredora-dos)");
      expect(chosen.signed.map((item) => item.path)).toEqual(["p009/cover.jpg"]);
      expect(chosen.credentialsOf).toEqual(["account-2"]);
    });

    it("un corredor que no existe o sin cuenta conectada", async () => {
      const unknown = setup();
      expect(await run(unknown, { brokerSlug: "nadie" })).toBe(1);
      expect(unknown.err).toEqual(["✗ BROKER_NOT_FOUND: No existe el corredor nadie"]);

      const withoutAccount = setup();
      expect(await run(withoutAccount, { brokerSlug: "corredora-dos" })).toBe(1);
      expect(withoutAccount.err[0]).toBe(
        "✗ ACCOUNT_NOT_CONNECTED: corredora-dos no tiene una cuenta de Instagram conectada",
      );
      expect(requests).toEqual([]);
    });

    it("salta los avisos sin portada JPEG renderizada y usa --listing por id_propiedad o id", async () => {
      useInstagram();
      const media = {
        "listing-1": [
          cover("p001/foto.jpg", { role: "processed", variant: "ig_4x5" }),
          cover("p001/ficha.jpg", { variant: "spec_sheet" }),
        ],
        "listing-2": [cover("p002/cover.jpg")],
        "listing-3": [cover("p003/cover.jpg")],
      };
      const listings = [
        { id: "listing-1", brokerId: "broker-1", externalRef: "P001" },
        { id: "listing-2", brokerId: "broker-1", externalRef: "P002" },
        { id: "listing-3", brokerId: "broker-1", externalRef: "P003" },
      ];
      const first = setup({ listings, media });
      expect(await run(first)).toBe(0);
      expect(first.signed.map((item) => item.path)).toEqual(["p002/cover.jpg"]);

      const byRef = setup({ listings, media });
      expect(await run(byRef, { listingRef: "P003" })).toBe(0);
      expect(byRef.signed.map((item) => item.path)).toEqual(["p003/cover.jpg"]);

      const byId = setup({ listings, media });
      expect(await run(byId, { listingRef: "listing-3" })).toBe(0);
      expect(byId.signed.map((item) => item.path)).toEqual(["p003/cover.jpg"]);
    });

    it("por defecto elige entre los avisos que se pueden preparar; con --listing, cualquiera", async () => {
      useInstagram();
      const listings: ListingRow[] = [
        { id: "listing-1", brokerId: "broker-1", externalRef: "P001", status: "archived" },
        { id: "listing-2", brokerId: "broker-1", externalRef: "P002", status: "draft" },
        { id: "listing-3", brokerId: "broker-1", externalRef: "P003", status: "paused" },
      ];
      const media = {
        "listing-1": [cover("p001/cover.jpg")],
        "listing-2": [cover("p002/cover.jpg")],
        "listing-3": [cover("p003/cover.jpg")],
      };
      const byDefault = setup({ listings, media });
      expect(await run(byDefault)).toBe(0);
      expect(byDefault.signed.map((item) => item.path)).toEqual(["p003/cover.jpg"]);

      const archived = setup({ listings, media });
      expect(await run(archived, { listingRef: "P001" })).toBe(0);
      expect(archived.signed.map((item) => item.path)).toEqual(["p001/cover.jpg"]);
    });

    it("sin portada renderizada o con un aviso que no es del corredor", async () => {
      const none = setup({ media: {} });
      expect(await run(none)).toBe(1);
      expect(none.err).toEqual([
        "✗ RENDER_NOT_FOUND: Ningún aviso del corredor tiene la portada renderizada",
        "  → Prepara el aviso primero: pnpm -s cli prepare <id_propiedad>",
      ]);

      const withoutCover = setup({ media: { "listing-1": [] } });
      expect(await run(withoutCover, { listingRef: "P001" })).toBe(1);
      expect(withoutCover.err[0]).toBe("✗ RENDER_NOT_FOUND: P001 no tiene la portada renderizada");

      const foreign = setup({
        listings: [{ id: "listing-9", brokerId: "broker-2", externalRef: "P009" }],
      });
      expect(await run(foreign, { listingRef: "P009" })).toBe(1);
      expect(foreign.err).toEqual(["✗ LISTING_NOT_FOUND: El corredor no tiene el aviso P009"]);
      expect(requests).toEqual([]);
    });
  });
  describe("cortes y fallos de la base, R2 o las credenciales", () => {
    it("Ctrl+C durante el sondeo corta con IG_ABORTED", async () => {
      useInstagram({ statuses: [{ status_code: "IN_PROGRESS" }] });
      const ctx = setup();
      const abort = new AbortController();
      ctx.deps.sleep = (ms, signal) => {
        abort.abort();
        return abortableSleep(ms, signal);
      };

      expect(await run(ctx, { signal: abort.signal })).toBe(1);
      expect(ctx.err).toEqual(["✗ IG_ABORTED: Se cortó la llamada a Instagram"]);
    });

    it("con la señal ya disparada no llama a Instagram", async () => {
      useInstagram();
      const ctx = setup();
      const abort = new AbortController();
      abort.abort();

      expect(await run(ctx, { signal: abort.signal })).toBe(1);
      expect(ctx.err).toEqual(["✗ IG_ABORTED: Se cortó la llamada a Instagram"]);
      expect(requests).toEqual([]);
    });

    it("un token ilegible pide reconectar, sin llamar a Instagram", async () => {
      const ctx = setup();
      ctx.deps.accounts.getCredentials = async () => {
        throw new AppError("CREDENTIALS_UNREADABLE", "No se pudieron leer las credenciales");
      };

      expect(await run(ctx)).toBe(1);
      expect(ctx.err).toEqual([
        "✗ CREDENTIALS_UNREADABLE: No se pudieron leer las credenciales",
        "  → El token guardado no se puede leer (¿cambió APP_ENCRYPTION_KEY?): vuelve a conectar la cuenta",
      ]);
      expect(requests).toEqual([]);
    });

    it("Neon dormido: el código y la pista", async () => {
      const ctx = setup();
      ctx.deps.accounts.list = async () => {
        throw new AppError("DB_UNAVAILABLE", "La base de datos no responde", { retriable: true });
      };

      expect(await run(ctx)).toBe(1);
      expect(ctx.err).toEqual([
        "✗ DB_UNAVAILABLE: La base de datos no responde",
        "  → Neon puede estar despertando: reintenta en unos segundos",
      ]);
    });

    it("una portada que falta en R2 no se culpa a la URL firmada", async () => {
      const ctx = setup({ stored: { "p001/cover.jpg": null } });

      expect(await run(ctx)).toBe(1);
      expect(ctx.err).toEqual([
        "✗ STORAGE_NOT_FOUND: La portada de P001 está en la base pero no en R2",
        "  → Vuelve a armar las imágenes del aviso: pnpm -s cli prepare <id_propiedad> --no-texts",
      ]);
      expect(ctx.signed).toEqual([]);
      expect(requests).toEqual([]);
    });

    it("R2 caído: el código y la pista", async () => {
      const ctx = setup();
      ctx.deps.storage.head = async () => {
        throw new AppError("STORAGE_UNAVAILABLE", "El almacenamiento no responde", {
          retriable: true,
        });
      };

      expect(await run(ctx)).toBe(1);
      expect(ctx.err).toEqual([
        "✗ STORAGE_UNAVAILABLE: El almacenamiento no responde",
        "  → R2 no respondió: revisa la conexión y reintenta",
      ]);
    });

    it("avisa si la portada en R2 no tiene el tipo image/jpeg, y sigue", async () => {
      useInstagram();
      const ctx = setup({ stored: { "p001/cover.jpg": "application/octet-stream" } });

      expect(await run(ctx)).toBe(0);
      expect(ctx.out).toContain(
        "  Aviso: la portada está guardada con el tipo application/octet-stream, no image/jpeg; Meta podría rechazarla",
      );
    });

    it("un error que no es AppError se deja al script", async () => {
      const ctx = setup();
      ctx.deps.listings.list = async () => {
        throw new Error("fallo inesperado");
      };

      await expect(run(ctx)).rejects.toThrow("fallo inesperado");
    });
  });

  describe("salvaguardas", () => {
    it("smokeGraph no deja publicar ni con un cast", () => {
      const graph = smokeGraph(createInstagramGraph());

      expect(Object.keys(graph).sort()).toEqual(["containerStatus", "createContainer"]);
      expect("publishContainer" in graph).toBe(false);
    });

    it("describeUnexpected quita las URLs y los secretos del mensaje", () => {
      const text = describeUnexpected(
        new Error(`No se pudo leer ${SIGNED_URL} (access_token=${TOKEN})`),
      );

      expect(text).not.toContain("firma-secreta");
      expect(text).not.toContain(TOKEN);
      expect(text).toContain("<url>");
      expect(describeUnexpected("texto suelto")).toBe("texto suelto");
    });
  });
});
