import {
  type AbortSignalLike,
  AppError,
  accessTokenProvider,
  assemblePublishInput,
  type Broker,
  type ContentRepository,
  isAppError,
  isMercadoLibreRejectedAfterRefresh,
  type ListingRepository,
  type MediaRepository,
  type MediaStorage,
  type MercadoLibreTokenDeps,
  type PlatformAccountRepository,
  type Publisher,
  type PublishIssue,
  publicationPlan,
  signPublishMedia,
  toPublishListing,
} from "@agentsales/core";
import {
  type MercadoLibreItemBody,
  type MercadoLibreItems,
  type MercadoLibrePictures,
  type MercadoLibreValidator,
  PORTAL_NO_QUOTA_NOTE,
} from "@agentsales/publishers";
import {
  errorOf,
  HINTS,
  type MlSmokeError,
  mercadoLibreCodes,
  REJECTED_AFTER_REFRESH_HINT,
} from "./ml-smoke.js";

// `pnpm ml:smoke --listing <id_propiedad>` (spec F4-T23): arma el aviso real de una propiedad con
// el mismo camino que publicar (el texto vigente de Portal, las fotos 4:3, el aviso y el contacto
// del corredor) y le pregunta a Mercado Libre con `preflight` (`POST /items/validate`) si lo
// aceptaría, **sin publicar**: el publisher del worker se arma con escrituras de ítems y fotos que
// lanzan un error (`readOnlyItems`, `NO_PICTURES`, `NO_PICTURE_BYTES`), así que ni por error se
// crea, cambia o sube nada. Lo corre el operador antes de la prueba en `live`: con el usuario de
// prueba y su paquete (D15) confirma lo que quedó abierto en T10 y T11.

/** Lo que una escritura del smoke respondería: nunca debe pasar. */
const writeBlocked = (what: string) =>
  new AppError(
    "ML_SMOKE_WRITE_BLOCKED",
    `ml:smoke nunca ${what} en Mercado Libre: se cortó antes de llamar`,
  );

/**
 * El cliente de ítems sin escrituras, también al ejecutar: crear, cambiar el estado, cargar la
 * descripción y ocultar la dirección lanzan `ML_SMOKE_WRITE_BLOCKED` sin llamar; las lecturas
 * pasan tal cual.
 */
export function readOnlyItems(items: MercadoLibreItems): MercadoLibreItems {
  return {
    get: (...args) => items.get(...args),
    getDescription: (...args) => items.getDescription(...args),
    getLastModeration: (...args) => items.getLastModeration(...args),
    findBySellerCustomField: (...args) => items.findBySellerCustomField(...args),
    searchItems: (...args) => items.searchItems(...args),
    create: async () => {
      throw writeBlocked("crea un aviso");
    },
    setStatus: async () => {
      throw writeBlocked("cambia el estado de un aviso");
    },
    addDescription: async () => {
      throw writeBlocked("carga una descripción");
    },
    hideAddress: async () => {
      throw writeBlocked("cambia la dirección de un aviso");
    },
  };
}

/** Las fotos nunca se suben desde el smoke. */
export const NO_PICTURES: MercadoLibrePictures = {
  upload: async () => {
    throw writeBlocked("sube una foto");
  },
};

/** Ni se leen sus bytes de R2 (solo se sube lo que se lee). */
export const NO_PICTURE_BYTES: Pick<MediaStorage, "get"> = {
  get: async () => {
    throw writeBlocked("sube una foto");
  },
};

/**
 * Guarda lo que se mandó a `validate` para el informe, sin el contacto ni las URLs firmadas: la
 * dirección y el WhatsApp del corredor solo se marcan como presentes.
 */
export function recordingValidator(validator: MercadoLibreValidator) {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    validator: {
      validate: (
        accessToken: string,
        body: MercadoLibreItemBody,
        options?: { signal?: AbortSignal },
      ) => {
        sent.push(redactedBody(body));
        return validator.validate(accessToken, body, options);
      },
    } satisfies MercadoLibreValidator,
  };
}

/** El cuerpo para el informe: lo que confirma T23 (atributos, ubicación, descripción), sin datos de contacto. */
export function redactedBody(body: MercadoLibreItemBody): Record<string, unknown> {
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(body));
  if ("seller_contact" in copy) copy.seller_contact = "(presente, oculto en el informe)";
  if (Array.isArray(copy.pictures))
    copy.pictures = `${copy.pictures.length} foto(s) por URL firmada`;
  const location = copy.location;
  if (typeof location === "object" && location !== null && "address_line" in location) {
    (location as Record<string, unknown>).address_line = "(presente, oculta en el informe)";
  }
  if (typeof copy.description === "object" && copy.description !== null) {
    const text = (copy.description as Record<string, unknown>).plain_text;
    copy.description = typeof text === "string" ? `${text.length} caracteres` : "(presente)";
  }
  return copy;
}

export type MlSmokeListingDeps = {
  accounts: Pick<
    PlatformAccountRepository,
    "list" | "get" | "getCredentials" | "withCredentialsLock" | "changeStatus"
  >;
  brokers: { list(): Promise<Pick<Broker, "id" | "slug" | "name" | "email" | "whatsapp">[]> };
  listings: Pick<ListingRepository, "list">;
  contents: Pick<ContentRepository, "listCurrent">;
  media: Pick<MediaRepository, "listByListing">;
  storage: Pick<MediaStorage, "signedReadUrl">;
  /** El refresco de Mercado Libre, o `null` sin `ML_APP_ID` y `ML_CLIENT_SECRET`. */
  mercadoLibre: MercadoLibreTokenDeps["mercadoLibre"];
  /** El publisher del worker (`createWorkerPortal`) con escrituras que lanzan un error. */
  publisher: Publisher;
  /** Lo que se mandó a `validate` (`recordingValidator`), para el informe. */
  sentBodies: () => readonly Record<string, unknown>[];
  writeReport(report: MlSmokeListingReport): Promise<string>;
  now(): Date;
  print(line: string): void;
  printError(line: string): void;
};

export type MlSmokeListingOptions = {
  /** El `id_propiedad` del Excel. */
  listingRef: string;
  /** El corredor, si el `id_propiedad` está en más de uno. */
  brokerSlug?: string;
  signal?: AbortSignalLike;
};

/**
 * Qué dijo Mercado Libre: `accepted` (lo aceptaría), `unverified` (sin cupo no revisó el aviso,
 * D14: no es un 204), `rejected` (con los motivos) o `error` (no se pudo preguntar).
 */
export type MlSmokeListingOutcome = "accepted" | "unverified" | "rejected" | "error";

export type MlSmokeListingReport = {
  generatedAt: string;
  listing: string;
  broker: string;
  account: string;
  content: { status: string; promptVersion: string };
  pictures: number;
  outcome: MlSmokeListingOutcome;
  issues: PublishIssue[];
  notes: string[];
  /** Lo que se mandó a `validate`, sin contacto ni URLs (`redactedBody`). */
  sent: Record<string, unknown>[];
  error: MlSmokeError | null;
};

/** Un error antes de preguntar (la propiedad, el texto, la cuenta): se dice y se sale con 1. */
class SmokeStop extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

/**
 * Corre `ml:smoke --listing`: busca la propiedad y la cuenta de Mercado Libre de su corredor, arma
 * el `PublishInput` como lo haría publicar (`publicationPlan`, `signPublishMedia`,
 * `assemblePublishInput`) y llama a `preflight`. Sale con 0 si Mercado Libre lo aceptaría o si no
 * lo pudo revisar por falta de cupo (lo dice: "no verificado"); con 1 si lo rechaza o si algo
 * falla. Nunca imprime tokens, el WhatsApp ni la dirección.
 */
export async function runMlSmokeListing(
  deps: MlSmokeListingDeps,
  options: MlSmokeListingOptions,
): Promise<number> {
  try {
    return await run(deps, options);
  } catch (error) {
    if (error instanceof SmokeStop) {
      deps.printError(`✗ ${error.code}: ${error.message}`);
      if (error.hint !== undefined) deps.printError(`  → ${error.hint}`);
      return 1;
    }
    throw error;
  }
}

async function run(deps: MlSmokeListingDeps, options: MlSmokeListingOptions): Promise<number> {
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
      candidate.platform === "portal_inmobiliario" &&
      candidate.brokerId === listing.brokerId &&
      candidate.status === "connected" &&
      candidate.hasCredentials,
  );
  if (account === undefined) {
    throw new SmokeStop(
      "ACCOUNT_NOT_CONNECTED",
      `${slug} no tiene una cuenta de Mercado Libre conectada`,
      `Conéctala (con pnpm dev): pnpm -s cli accounts connect mercadolibre --broker ${slug}`,
    );
  }
  const content = (await deps.contents.listCurrent(listing.id)).find(
    (item) => item.platform === "portal_inmobiliario",
  );
  if (content === undefined) {
    throw new SmokeStop(
      "CONTENT_NOT_READY",
      `${ref} no tiene texto de Portal`,
      `Prepáralo (con pnpm dev): pnpm -s cli prepare ${ref}`,
    );
  }
  const all = await deps.media.listByListing(listing.id);
  let mediaIds: string[];
  try {
    mediaIds = publicationPlan("portal_inmobiliario", all)[0]?.mediaIds ?? [];
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
  const pictures = mediaIds.flatMap((id) => all.filter((item) => item.id === id));
  const input = assemblePublishInput({
    // `seller_custom_field` del aviso: una marca del smoke, nunca la de una publicación.
    publicationId: `ml-smoke-${listing.id}`,
    platform: "portal_inmobiliario",
    format: "post",
    content,
    media: await signPublishMedia(deps.storage, pictures),
    listingData: {
      listing: toPublishListing(listing),
      brokerContact: {
        name: broker?.name ?? "",
        email: broker?.email ?? null,
        whatsapp: broker?.whatsapp ?? null,
      },
    },
  });

  deps.print(`Propiedad: ${ref} (${slug}) · cuenta ${account.displayName}`);
  deps.print(
    `Texto de Portal: ${content.status} · ${pictures.length} foto(s) · pidiendo a Mercado Libre que lo revise, sin publicar…`,
  );
  if (content.status !== "approved") {
    deps.print("  (el texto no está aprobado: se revisa igual, pero publicar exige aprobarlo)");
  }

  const report: MlSmokeListingReport = {
    generatedAt: deps.now().toISOString(),
    listing: ref,
    broker: slug,
    account: account.displayName,
    content: { status: content.status, promptVersion: content.promptVersion },
    pictures: pictures.length,
    outcome: "error",
    issues: [],
    notes: [],
    sent: [],
    error: null,
  };
  if (deps.publisher.preflight === undefined) {
    throw new SmokeStop("PUBLISHER_NOT_CONFIGURED", "El publisher de Portal no tiene preflight");
  }
  try {
    const result = await deps.publisher.preflight(input, {
      account,
      accessToken: accessTokenProvider(
        { platformAccounts: deps.accounts, mercadoLibre: deps.mercadoLibre, now: deps.now },
        account.id,
      ),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!result.ok) {
      report.outcome = "rejected";
      report.issues = result.issues;
      deps.printError("✗ Mercado Libre (o la revisión de AgentSales) no lo aceptaría:");
      for (const issue of result.issues) deps.printError(`  • ${issue.code}: ${issue.message}`);
    } else {
      report.notes = result.notes ?? [];
      const noQuota = report.notes.includes(PORTAL_NO_QUOTA_NOTE);
      report.outcome = noQuota ? "unverified" : "accepted";
      deps.print(
        noQuota
          ? "! No verificado: la cuenta no tiene un paquete con cupo, así que Mercado Libre no revisó el aviso (402). Con el usuario de prueba y su paquete (D15) sí lo revisa"
          : "✓ Mercado Libre aceptaría el aviso (validate respondió sin errores)",
      );
      for (const note of report.notes.filter((note) => note !== PORTAL_NO_QUOTA_NOTE)) {
        deps.print(`  · ${note}`);
      }
    }
  } catch (error) {
    if (!isAppError(error)) throw error;
    // Un 402 con causas que bloquean llega como `ML_ITEM_REJECTED` lanzado (no `{ ok: false }`):
    // se informa con sus causas (spec F4-T23).
    report.error = errorOf("preflight", error);
    report.outcome = error.code === "ML_ITEM_REJECTED" ? "rejected" : "error";
    deps.printError(`✗ ${error.code}: ${error.message}${mercadoLibreCodes(report.error)}`);
    const hint = isMercadoLibreRejectedAfterRefresh(error)
      ? REJECTED_AFTER_REFRESH_HINT
      : HINTS[error.code];
    if (hint !== undefined) deps.printError(`  → ${hint}`);
  }
  report.sent = [...deps.sentBodies()];
  try {
    deps.print(`Informe completo: ${await deps.writeReport(report)}`);
  } catch (error) {
    deps.printError(
      `✗ No se pudo guardar el informe: ${isAppError(error) ? error.code : "error inesperado"}`,
    );
    return 1;
  }
  if (report.outcome === "accepted" || report.outcome === "unverified") {
    deps.print("No se creó ni se cambió nada en Mercado Libre");
    return 0;
  }
  return 1;
}
