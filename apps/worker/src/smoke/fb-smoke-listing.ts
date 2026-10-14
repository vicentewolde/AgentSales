import {
  type AbortSignalLike,
  assemblePublishInput,
  type BrokerRepository,
  type ContentRepository,
  isAppError,
  type ListingRepository,
  MARKETPLACE_TIME_ZONE,
  type MediaRepository,
  type MediaStorage,
  marketplacePrice,
  marketplacePriceText,
  marketplaceReadiness,
  type PlatformAccountRepository,
  type PublicationRepository,
  publicationPlan,
  signPublishMedia,
  startOfDayIn,
  toPublishListing,
  type UfValueSource,
} from "@agentsales/core";
import {
  createMarketplacePublisher,
  type MarketplaceProfile,
  type MarketplacePublisherDeps,
  type MarketplaceWindow,
} from "@agentsales/publishers/marketplace";
import { readPictureFrom } from "../portal.js";

export type FbSmokeListingDeps = {
  brokers: Pick<BrokerRepository, "list">;
  listings: Pick<ListingRepository, "list">;
  accounts: Pick<PlatformAccountRepository, "list">;
  contents: Pick<ContentRepository, "listCurrent">;
  media: Pick<MediaRepository, "listByListing">;
  storage: Pick<MediaStorage, "signedReadUrl" | "get">;
  /** Solo para contar los intentos de hoy: el smoke no cambia estados ni deja eventos. */
  publications: Pick<PublicationRepository, "countLiveAttemptsSince">;
  /** El valor de la UF (`null` sin `BCCH_API_TOKEN`). */
  uf: UfValueSource | null;
  /** `MARKETPLACE_DAILY_LIMIT`. */
  dailyLimit: number;
  /** Abre el perfil del corredor (con ventana; los tests, sin ella y sin red). */
  openProfile(brokerId: string): Promise<MarketplaceProfile>;
  /** `<workspace>/tmp/fb-smoke`: la evidencia del formulario lleno queda en una subcarpeta. */
  outputDir: string;
  /** Pregunta en la terminal; `null` si se cortó la entrada. */
  ask(question: string): Promise<string | null>;
  now(): Date;
  print(line: string): void;
  printError(line: string): void;
  /** El ritmo y los topes del llenado (los tests: sin pausas). */
  tuning?: Pick<MarketplacePublisherDeps, "fill" | "formWaitMs" | "profileBusyWaitMs" | "maxMs">;
  /** Cada cuánto mira si el operador cerró la ventana. */
  closedPollMs?: number;
};

export type FbSmokeListingOptions = {
  /** El `id_propiedad` del Excel. */
  listingRef: string;
  /** El corredor, si el `id_propiedad` está en más de uno. */
  brokerSlug?: string;
  /** `--yes`: no pregunta antes de llenar. */
  yes?: boolean;
  signal?: AbortSignalLike;
};

/** Un motivo para no seguir (la propiedad, la cuenta, el texto, el límite): se dice y se sale con 1. */
class SmokeStop extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/** Lo que el operador puede responder para seguir. */
const YES = /^\s*(s|si|sí)\s*$/i;

/**
 * `pnpm fb:smoke --listing <id_propiedad>` (spec F5 §4.8, F5-T10): llena el formulario real de
 * Marketplace con ese aviso y sus fotos (el precio en pesos), como `publish`, y deja la ventana
 * abierta hasta que el operador la cierre. Como escribe en Facebook (fotos y quizás un borrador):
 * - pregunta antes (`s/N`, o `--yes`), dice cuántos intentos lleva la cuenta hoy y se niega si se
 *   llegó al límite;
 * - **nunca** hace clic en Siguiente ni Publicar, no vigila la ventana para confirmar nada, **no
 *   cambia estados ni deja eventos** (por eso no suma al límite: lo corre el operador, a propósito).
 * Sale con 0 si el formulario quedó lleno; con 1 si algo lo impidió.
 */
export async function runFbSmokeListing(
  deps: FbSmokeListingDeps,
  options: FbSmokeListingOptions,
): Promise<number> {
  try {
    return await run(deps, options);
  } catch (error) {
    if (error instanceof SmokeStop) {
      deps.printError(`✗ ${error.code}: ${error.message}`);
      if (error.hint !== undefined) deps.printError(`  → ${error.hint}`);
      return 1;
    }
    if (isAppError(error)) {
      deps.printError(`✗ ${error.code}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function run(deps: FbSmokeListingDeps, options: FbSmokeListingOptions): Promise<number> {
  const ref = options.listingRef.trim();
  const brokers = await deps.brokers.list();
  let matches = await deps.listings.list({ externalRef: ref });
  if (options.brokerSlug !== undefined) {
    const wanted = brokers.find((broker) => broker.slug === options.brokerSlug);
    if (wanted === undefined) {
      throw new SmokeStop("BROKER_NOT_FOUND", `No existe el corredor ${options.brokerSlug}`);
    }
    matches = matches.filter((listing) => listing.brokerId === wanted.id);
  }
  const [listing, ...others] = matches;
  if (listing === undefined) {
    throw new SmokeStop(
      "LISTING_NOT_FOUND",
      `No existe la propiedad ${ref}`,
      "Revisa el código con pnpm -s cli listings",
    );
  }
  if (others.length > 0) {
    throw new SmokeStop(
      "LISTING_AMBIGUOUS",
      `${ref} existe en ${matches.length} corredores`,
      "Indica cuál con --broker <slug>",
    );
  }
  const broker = brokers.find((item) => item.id === listing.brokerId);
  const slug = broker?.slug ?? listing.brokerId;

  const account = (await deps.accounts.list()).find(
    (candidate) =>
      candidate.platform === "fb_marketplace" &&
      candidate.brokerId === listing.brokerId &&
      candidate.status === "connected",
  );
  if (account === undefined) {
    throw new SmokeStop(
      "ACCOUNT_NOT_CONNECTED",
      `${slug} no tiene su Facebook conectado`,
      `Conéctalo (con pnpm dev): pnpm -s cli accounts connect marketplace --broker ${slug}`,
    );
  }
  const content = (await deps.contents.listCurrent(listing.id)).find(
    (item) => item.platform === "fb_marketplace",
  );
  if (content === undefined || content.status !== "approved") {
    throw new SmokeStop(
      "CONTENT_NOT_APPROVED",
      `${ref} no tiene el texto de Marketplace aprobado`,
      `Apruébalo (con pnpm dev): pnpm -s cli approve ${ref} --platform marketplace`,
    );
  }
  const all = await deps.media.listByListing(listing.id);
  let mediaIds: string[];
  try {
    mediaIds = publicationPlan("fb_marketplace", all)[0]?.mediaIds ?? [];
  } catch (error) {
    if (isAppError(error)) {
      throw new SmokeStop(
        error.code,
        error.message,
        `Prepáralo (con pnpm dev): pnpm -s cli prepare ${ref}`,
      );
    }
    throw error;
  }
  const photos = mediaIds.flatMap((id) => all.filter((item) => item.id === id));
  const publishListing = toPublishListing(listing);
  const readiness = marketplaceReadiness(publishListing, {
    photos: photos.length,
    ufConfigured: deps.uf !== null,
  });
  if (!readiness.ready) {
    deps.printError(`✗ MARKETPLACE_NOT_READY: a ${ref} le falta algo para Marketplace:`);
    for (const issue of readiness.issues) deps.printError(`  • ${issue.message}`);
    return 1;
  }

  const now = deps.now();
  const today = await deps.publications.countLiveAttemptsSince(
    account.id,
    startOfDayIn(MARKETPLACE_TIME_ZONE, now),
  );
  deps.print(
    `Propiedad: ${ref} (${slug}) · cuenta ${account.displayName} · ${photos.length} foto(s)`,
  );
  deps.print(`Intentos en vivo de la cuenta hoy: ${today} de ${deps.dailyLimit}.`);
  if (today >= deps.dailyLimit) {
    throw new SmokeStop(
      "MARKETPLACE_DAILY_LIMIT",
      `La cuenta ya llegó a ${deps.dailyLimit} intentos hoy: no se llena otro formulario`,
      "Vuelve a intentarlo mañana",
    );
  }
  const price = await marketplacePrice(publishListing, {
    uf: deps.uf,
    now,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  // El mismo texto que la CLI y el panel ("$238.559.452 (UF del 2026-10-12: $41.130,94)").
  deps.print(
    `Precio en el formulario: ${marketplacePriceText({
      priceClp: price.priceClp,
      ufValue: price.uf?.value ?? null,
      ufDate: price.uf?.date ?? null,
    })}`,
  );
  if (options.yes !== true) {
    deps.print(
      "Esto escribe en Facebook (sube las fotos y puede dejar un borrador). Nunca publica.",
    );
    const answer = await deps.ask("¿Llenar el formulario real de Facebook? s/N ");
    if (answer === null || !YES.test(answer)) {
      deps.print("No se llenó nada.");
      return 1;
    }
  }

  const input = {
    ...assemblePublishInput({
      // Una marca del smoke, nunca la de una publicación: no hay publicación ni eventos.
      publicationId: `fb-smoke-${listing.id}`,
      platform: "fb_marketplace",
      format: "post",
      content,
      media: await signPublishMedia(deps.storage, photos),
      listingData: {
        listing: publishListing,
        brokerContact: {
          name: broker?.name ?? "",
          email: broker?.email ?? null,
          whatsapp: broker?.whatsapp ?? null,
        },
      },
    }),
    priceClp: price.priceClp,
    uf: price.uf,
  };
  let handed: MarketplaceWindow | undefined;
  const publisher = createMarketplacePublisher({
    openProfile: deps.openProfile,
    readPhoto: readPictureFrom(deps.storage),
    tmpRoot: deps.outputDir,
    // Sin registro de ventanas: el smoke tiene la suya y nadie confirma nada.
    closeAccountWindows: async () => undefined,
    onHandoff: async (_ref, window) => {
      handed = window;
    },
    ...deps.tuning,
  });
  deps.print(
    "Se abre una ventana de Chromium y se llena el formulario (el sistema no hace clic en Siguiente ni Publicar)…",
  );
  await publisher.publish(input, {
    account,
    progress: null,
    saveProgress: async () => undefined,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const window = handed;
  if (window === undefined) throw new Error("el formulario no entregó su ventana");
  deps.print("✓ Formulario lleno. Revísalo en la ventana; no hagas clic en Publicar.");
  deps.print("  Ciérrala cuando termines (Ctrl+C también la cierra).");
  deps.print(
    "  Después, en Facebook → Marketplace → Tus publicaciones, borra a mano el borrador si quedó uno.",
  );
  await waitUntilClosed(window, deps.closedPollMs ?? 1_000, options.signal);
  deps.print("Se cerró la ventana. No se cambió nada en AgentSales.");
  return 0;
}

/** Espera a que el operador cierre la ventana; un corte (Ctrl+C) la cierra. */
async function waitUntilClosed(
  window: MarketplaceWindow,
  pollMs: number,
  signal: AbortSignalLike | undefined,
): Promise<void> {
  while (window.isOpen()) {
    if (signal?.aborted) {
      await window.close();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
