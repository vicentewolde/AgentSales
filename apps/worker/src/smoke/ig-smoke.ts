import {
  type AbortSignalLike,
  AppError,
  type Broker,
  isAppError,
  type Listing,
  type Media,
  type MediaStorage,
  type PlatformAccount,
  type PlatformCredentials,
  PUBLISH_MEDIA_URL_TTL_S,
} from "@agentsales/core";
import {
  INSTAGRAM_POLL,
  type InstagramGraph,
  instagramContainerError,
} from "@agentsales/publishers";

// `pnpm ig:smoke` (spec F3-T19): con la cuenta conectada, crea **un** contenedor de imagen desde una
// URL firmada de R2 (la portada ya renderizada de un aviso de muestra), sondea hasta `FINISHED` o
// error e imprime el resultado. Comprueba que Meta descarga las URLs firmadas antes de la prueba en
// `live` (spec F3 §8). **Nunca** publica: `graph` no trae `publishContainer` (`media_publish`), y el
// contenedor sin publicar vence solo a las 24 h (nota de Instagram §4.4). No escribe en la base.
// Nunca imprime el token ni la URL firmada (la firma da acceso de lectura).

/** Caption del contenedor de prueba: nunca se publica, pero queda claro de dónde salió. */
export const IG_SMOKE_CAPTION = "AgentSales ig:smoke: contenedor de prueba, no se publica";

/** Lo que el smoke lee de cada repositorio: lo justo, para probarlo con datos a mano. */
export type IgSmokeDeps = {
  accounts: {
    list(): Promise<
      Pick<
        PlatformAccount,
        | "id"
        | "brokerId"
        | "platform"
        | "status"
        | "externalAccountId"
        | "displayName"
        | "hasCredentials"
      >[]
    >;
    getCredentials(id: string): Promise<PlatformCredentials>;
  };
  brokers: { list(): Promise<Pick<Broker, "id" | "slug">[]> };
  listings: { list(): Promise<Pick<Listing, "id" | "brokerId" | "externalRef">[]> };
  media: {
    listByListing(
      listingId: string,
    ): Promise<
      Pick<
        Media,
        "id" | "role" | "variant" | "storagePath" | "mime" | "width" | "height" | "bytes"
      >[]
    >;
  };
  storage: Pick<MediaStorage, "signedReadUrl">;
  /** Sin `publishContainer`: el smoke no puede publicar ni por error. */
  graph: Pick<InstagramGraph, "createContainer" | "containerStatus">;
  sleep(ms: number, signal?: AbortSignalLike): Promise<void>;
  /** Milisegundos desde un origen fijo (reloj del sondeo). */
  now(): number;
  print(line: string): void;
  printError(line: string): void;
};

export type IgSmokeOptions = {
  /** Slug del corredor; hace falta solo si hay cuentas conectadas en más de uno. */
  brokerSlug?: string;
  /** `id_propiedad` o id del aviso; por defecto, el primero (por `id_propiedad`) con portada. */
  listingRef?: string;
  signal?: AbortSignalLike;
};

/** Qué hacer ante los errores que tienen arreglo del lado del operador. */
const HINTS: Readonly<Record<string, string>> = {
  ACCOUNT_NOT_CONNECTED:
    "Conecta la cuenta: pbpaste | pnpm -s cli accounts connect instagram --broker <slug> --token-stdin",
  IG_AUTH_INVALID: "El token venció o se revocó: vuelve a conectar la cuenta",
  IG_PERMISSION_DENIED: "Revisa que el token tenga el permiso instagram_business_content_publish",
  IG_MEDIA_FETCH_FAILED:
    "Meta no pudo descargar la URL firmada de R2: es el riesgo de la nota §5 (plan B: prefijo público)",
  IG_MEDIA_REJECTED: "Meta descargó la imagen pero la rechazó: revisa el formato de la portada",
  RENDER_NOT_FOUND: "Prepara el aviso primero: pnpm -s cli prepare <id_propiedad>",
  DB_UNAVAILABLE: "Neon puede estar despertando: reintenta en unos segundos",
  STORAGE_UNAVAILABLE: "R2 no respondió: revisa la conexión y reintenta",
};

const smokeError = (code: string, message: string) => new AppError(code, message);

/** La cuenta de Instagram conectada (del corredor pedido, si hay más de una). */
async function findAccount(deps: IgSmokeDeps, brokerSlug: string | undefined) {
  const connected = (await deps.accounts.list()).filter(
    (account) =>
      account.platform === "instagram" && account.status === "connected" && account.hasCredentials,
  );
  const brokers = await deps.brokers.list();
  let candidates = connected;
  if (brokerSlug !== undefined) {
    const broker = brokers.find((item) => item.slug === brokerSlug);
    if (broker === undefined) {
      throw smokeError("BROKER_NOT_FOUND", `No existe el corredor ${brokerSlug}`);
    }
    candidates = connected.filter((account) => account.brokerId === broker.id);
  }
  const [account, ...others] = candidates;
  if (account === undefined) {
    throw smokeError(
      "ACCOUNT_NOT_CONNECTED",
      brokerSlug === undefined
        ? "No hay una cuenta de Instagram conectada"
        : `${brokerSlug} no tiene una cuenta de Instagram conectada`,
    );
  }
  if (others.length > 0) {
    throw smokeError(
      "BROKER_REQUIRED",
      "Hay cuentas de Instagram conectadas en varios corredores: elige uno con --broker <slug>",
    );
  }
  const slug = brokers.find((item) => item.id === account.brokerId)?.slug ?? account.brokerId;
  return { account, slug };
}

/** La portada renderizada (JPEG) del aviso pedido o del primero del corredor que tenga una. */
async function findRender(deps: IgSmokeDeps, brokerId: string, listingRef: string | undefined) {
  const listings = (await deps.listings.list())
    .filter((listing) => listing.brokerId === brokerId)
    .filter(
      (listing) =>
        listingRef === undefined || listing.externalRef === listingRef || listing.id === listingRef,
    )
    .sort((a, b) => a.externalRef.localeCompare(b.externalRef));
  if (listingRef !== undefined && listings.length === 0) {
    throw smokeError("LISTING_NOT_FOUND", `El corredor no tiene el aviso ${listingRef}`);
  }
  for (const listing of listings) {
    const cover = (await deps.media.listByListing(listing.id)).find(
      (media) =>
        media.role === "rendered" && media.variant === "cover" && media.mime === "image/jpeg",
    );
    if (cover !== undefined) return { listing, cover };
  }
  throw smokeError(
    "RENDER_NOT_FOUND",
    listingRef === undefined
      ? "Ningún aviso del corredor tiene la portada renderizada"
      : `${listingRef} no tiene la portada renderizada`,
  );
}

/**
 * El mensaje sin la cola del publisher (": se reintenta…"): el smoke no reintenta, se vuelve a
 * correr a mano.
 */
const smokeMessage = (error: AppError) => error.message.replace(/: se reintenta.*$/, "");

/** Código y subcódigo de Meta de un error `IG_*`, si llegaron (nunca el mensaje de Meta). */
function metaCodes(error: AppError): string {
  const code = error.details?.graphCode;
  const subcode = error.details?.graphSubcode;
  const parts = [
    typeof code === "number" ? `código ${code}` : null,
    typeof subcode === "number" ? `subcódigo ${subcode}` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;
const kilobytes = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

/**
 * Corre el smoke y devuelve el código de salida: 0 si el contenedor quedó `FINISHED`, 1 si no (o si
 * falta algo para empezar). Todo error sale como `✗ CÓDIGO: mensaje`, con una pista si la hay.
 */
export async function runIgSmoke(deps: IgSmokeDeps, options: IgSmokeOptions = {}): Promise<number> {
  const call = options.signal === undefined ? {} : { signal: options.signal };
  try {
    const { account, slug } = await findAccount(deps, options.brokerSlug);
    deps.print(`Cuenta: ${account.displayName} (${slug})`);
    const { listing, cover } = await findRender(deps, account.brokerId, options.listingRef);
    const size =
      cover.width === null || cover.height === null ? "" : `${cover.width}×${cover.height}, `;
    deps.print(`Imagen: portada de ${listing.externalRef} (${size}${kilobytes(cover.bytes)})`);

    // La misma vida que las URLs de una publicación (core, `buildPublishInput`).
    const imageUrl = await deps.storage.signedReadUrl(cover.storagePath, PUBLISH_MEDIA_URL_TTL_S);
    const { accessToken } = await deps.accounts.getCredentials(account.id);
    const containerId = await deps.graph.createContainer(
      accessToken,
      account.externalAccountId,
      { kind: "image", imageUrl, caption: IG_SMOKE_CAPTION },
      call,
    );
    deps.print(`Contenedor ${containerId} creado; esperando a que Instagram lo procese…`);

    // El ritmo del publisher (spec F3 §4.5): al tiro, a los 5, 10, 20 y 30 s y cada 60 s, hasta 5 min.
    const startedAt = deps.now();
    for (let round = 0; ; round += 1) {
      const status = await deps.graph.containerStatus(accessToken, containerId, call);
      const elapsed = deps.now() - startedAt;
      deps.print(`  ${status.statusCode} (${seconds(elapsed)})`);
      if (status.statusCode === "FINISHED") {
        deps.print(
          "✓ Meta descargó la imagen desde la URL firmada de R2. No se publicó nada: el contenedor vence solo en 24 h",
        );
        return 0;
      }
      if (status.statusCode === "ERROR") {
        // El código que daría el publisher para ese subcódigo, y el subcódigo tal cual.
        throw new AppError(
          instagramContainerError(status.subcode).code,
          "El contenedor quedó en ERROR",
          { details: { graphSubcode: status.subcode } },
        );
      }
      if (status.statusCode === "EXPIRED" || status.statusCode === "PUBLISHED") {
        // Un contenedor recién creado no debería estar así: se informa tal cual.
        throw smokeError(
          "IG_SMOKE_UNEXPECTED_STATUS",
          `El contenedor quedó en ${status.statusCode}`,
        );
      }
      const remaining = INSTAGRAM_POLL.maxWaitMs - elapsed;
      if (remaining <= 0) {
        throw smokeError(
          "IG_CONTAINER_TIMEOUT",
          `Instagram no terminó de procesar la imagen en ${seconds(INSTAGRAM_POLL.maxWaitMs)}`,
        );
      }
      const delay = Math.min(
        INSTAGRAM_POLL.firstDelaysMs[round] ?? INSTAGRAM_POLL.intervalMs,
        remaining,
      );
      await deps.sleep(delay, options.signal);
    }
  } catch (error) {
    if (!isAppError(error)) throw error;
    deps.printError(`✗ ${error.code}: ${smokeMessage(error)}${metaCodes(error)}`);
    const hint = HINTS[error.code];
    if (hint !== undefined) deps.printError(`  → ${hint}`);
    return 1;
  }
}
