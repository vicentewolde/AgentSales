import type {
  ContentView,
  PlatformAccountView,
  PublicationView,
  ReadinessView,
} from "@agentsales/api/contracts";
import {
  ACTIVE_PUBLICATION_STATUSES,
  accountOwnedBy,
  availablePublicationOperations,
  canPrepareContent,
  canPublishListing,
  canRelist,
  hasContentErrors,
  LISTING_NOT_PREPARABLE_TEXT,
  LISTING_NOT_PUBLISHABLE_TEXT,
  type ListingStatus,
  OPERATION_PLATFORMS,
  PENDING_PUBLICATION_STATUSES,
  PLATFORM_TEXT,
  type Platform,
  type PublishMode,
  publicationModeFixed,
} from "@agentsales/core";

// Las reglas de la API (ADR-0014, spec F3 §4.2 y §4.3) vistas desde el panel: qué botón se puede
// usar y, si no, por qué. La API las vuelve a revisar al pedir; esto es para explicar antes.

const pending = new Set<string>(PENDING_PUBLICATION_STATUSES);
const active = new Set<string>(ACTIVE_PUBLICATION_STATUSES);

/** Por qué no se puede preparar el contenido de nuevo: hay publicaciones pendientes (D3). */
export function prepareBlockedReason(publications: readonly PublicationView[]): string | null {
  return publications.some((publication) => pending.has(publication.status))
    ? "Hay publicaciones aprobadas que no han salido: publícalas o descártalas antes de preparar de nuevo (cambiaría lo aprobado)."
    : null;
}

/** De qué cuenta se habla en «Conecta tu cuenta de …» al faltar la del canal (F9.5-T20). */
const ACCOUNT_PLATFORM_TEXT: Partial<Record<Platform, string>> = {
  instagram: "tu cuenta de Instagram",
  portal_inmobiliario: "tu cuenta de Mercado Libre",
  fb_marketplace: "tu cuenta de Facebook",
};

/**
 * Por qué no se puede publicar ni programar un canal: el corredor no tiene una cuenta conectada de
 * esa red (F9.5-T20; `accountOwnedBy`, como las redes de un post). Sin saber aún las cuentas
 * (`undefined`) o el corredor, no bloquea: la API lo vuelve a revisar con `ACCOUNT_NOT_CONNECTED`.
 */
export function accountMissingReason(
  platform: Platform,
  accounts: readonly Pick<PlatformAccountView, "brokerId" | "platform" | "status">[] | undefined,
  brokerId: string | undefined,
): string | null {
  if (accounts === undefined || brokerId === undefined) return null;
  const connected = accounts.some(
    (account) =>
      accountOwnedBy(account, brokerId) &&
      account.platform === platform &&
      account.status === "connected",
  );
  return connected
    ? null
    : `Conecta ${ACCOUNT_PLATFORM_TEXT[platform] ?? "tu cuenta"} en Cuentas para publicar.`;
}

/** Cómo se saca de circulación una publicación activa: en Portal se cierra; en Instagram se retira. */
export const retireVerb = (platform: Platform) =>
  OPERATION_PLATFORMS.has(platform) ? "ciérrala" : "retírala";

/**
 * Por qué no se puede editar un texto: tiene una publicación activa (pendiente o publicada). En
 * lenguaje simple (F9.5-T15): es un aviso de qué hacer, no un error.
 */
export function editBlockedReason(
  content: ContentView,
  publications: readonly PublicationView[],
): string | null {
  return publications.some(
    (publication) => publication.contentId === content.id && active.has(publication.status),
  )
    ? `Ya se publicó o está por publicarse con este texto. Para cambiarlo, primero ${OPERATION_PLATFORMS.has(content.platform) ? "cierra" : "retira"} o descarta esas publicaciones.`
    : null;
}

/** Por qué no se puede aprobar un texto (la API lo vuelve a revisar). */
export function approveBlockedReason(
  content: ContentView,
  listingStatus: ListingStatus,
  runActive: boolean,
): string | null {
  if (!canPrepareContent(listingStatus)) return `${LISTING_NOT_PREPARABLE_TEXT}.`;
  if (runActive) return "Se está preparando el contenido: espera a que termine.";
  if (hasContentErrors(content.checks))
    return "La revisión tiene errores: corrígelos para poder aprobar.";
  return null;
}

/**
 * Por qué no se puede quitar la aprobación: una de sus publicaciones se está publicando o, en
 * Marketplace, espera el clic final (`MANUAL_CONFIRM_PENDING`: primero se dice si salió).
 */
export function unapproveBlockedReason(
  content: ContentView,
  publications: readonly PublicationView[],
): string | null {
  const own = publications.filter((publication) => publication.contentId === content.id);
  if (own.some((publication) => publication.status === "publishing")) {
    return "Hay una publicación en curso: espera a que termine.";
  }
  if (own.some((publication) => publication.status === "awaiting_manual_confirm")) {
    return "Una publicación espera tu clic final: di primero si la publicaste.";
  }
  return null;
}

/** Por qué no se puede publicar el canal (la API lo vuelve a revisar). */
export function publishBlockedReason(
  listingStatus: ListingStatus,
  runActive: boolean,
): string | null {
  if (!canPublishListing(listingStatus)) return `${LISTING_NOT_PUBLISHABLE_TEXT}.`;
  if (runActive) return "Se está preparando el contenido: espera a que termine.";
  return null;
}

/**
 * Por qué no se puede publicar en Portal (o Marketplace, desde F5-T13) además de lo común (spec
 * F4-T22): un texto aprobado cuya revisión (calculada al leer) tiene errores (`CONTENT_HAS_ERRORS`),
 * o un aviso al que le falta algo (`PORTAL_NOT_READY`, `MARKETPLACE_NOT_READY`). La API lo vuelve a
 * revisar al publicar.
 */
export function readinessPublishBlockedReason(
  content: ContentView | undefined,
  readiness: ReadinessView | null,
  channel = "Portal",
): string | null {
  if (content?.status === "approved" && hasContentErrors(content.checks)) {
    return "La revisión del texto tiene errores: quita la aprobación, corrígelo y vuelve a aprobarlo.";
  }
  if (readiness !== null && !readiness.ready) {
    return channel === "Portal"
      ? "Falta información para Portal (arriba): complétala en la planilla y vuelve a importarla."
      : `Falta información para ${channel} (arriba): complétala y vuelve a intentarlo.`;
  }
  return null;
}

/**
 * Por qué no se puede reintentar una fallida: ya empezó en vivo en la plataforma y el sistema está en
 * simulación (`PUBLISH_MODE_LOCKED`): la simulación la daría por publicada sin saber si salió.
 */
export function retryBlockedReason(
  publication: PublicationView,
  publishMode: PublishMode | undefined,
): string | null {
  return publication.startedLive && publishMode === "dry-run"
    ? `Ya empezó en vivo en ${PLATFORM_TEXT[publication.platform]}: solo se puede reintentar con el sistema en vivo, o descártala.`
    : null;
}

/**
 * Si hay algo que publicar con estos textos (F9.5-T02): un texto aprobado sin publicaciones activas
 * (nacen al publicar; las descartadas y las retiradas no cuentan, porque al publicar nacen otras,
 * `ACTIVE_PUBLICATION_STATUSES`) o con alguna aprobada o fallida. Si todas salieron, están saliendo
 * o están programadas, no hay botón Publicar. Lo usan el canal de un aviso y cada red de un post. La
 * API lo vuelve a revisar (`NOTHING_TO_PUBLISH`).
 */
export function hasSomethingToPublish(
  contents: readonly Pick<ContentView, "id" | "status">[],
  publications: readonly Pick<PublicationView, "contentId" | "status">[],
): boolean {
  return contents.some((content) => {
    if (content.status !== "approved") return false;
    const own = publications.filter(
      (publication) => publication.contentId === content.id && active.has(publication.status),
    );
    return (
      own.length === 0 ||
      own.some(
        (publication) => publication.status === "approved" || publication.status === "failed",
      )
    );
  });
}

/**
 * Las redes de un post con algo por publicar (F9.5-T02, `hasSomethingToPublish` por red, con todos
 * sus idiomas). Sin las publicaciones (cargando), todas: el panel no esconde lo que la API aceptaría.
 */
export function platformsToPublish<P extends Platform>(
  platforms: readonly P[],
  contents: readonly Pick<ContentView, "id" | "status" | "platform">[],
  publications: readonly Pick<PublicationView, "contentId" | "status" | "platform">[] | undefined,
): P[] {
  if (publications === undefined) return [...platforms];
  return platforms.filter((platform) =>
    hasSomethingToPublish(
      contents.filter((content) => content.platform === platform),
      publications.filter((publication) => publication.platform === platform),
    ),
  );
}

/**
 * El modo de una publicación para mostrarlo (D4 del spec F9.5, `shownPublicationMode`): el fijado,
 * o el del sistema mientras no se fija (aprobada, descartada sin intento o fallida que no empezó en
 * vivo).
 */
export const publicationModeOf = (
  publication: Pick<PublicationView, "dryRun" | "status" | "attempts" | "startedLive">,
) => ({ dryRun: publication.dryRun, modeFixed: publicationModeFixed(publication) });

/**
 * Qué se puede hacer con una publicación según su estado y su canal. Un aviso de Portal no se
 * marca como retirado: se pausa, reactiva y cierra por la API, y Actualizar lee su estado allá
 * (solo en vivo: en simulación no hay nada que leer; spec F4 §4.9).
 */
export function publicationActions(
  publication: PublicationView,
  /** Para republicar (`canRelist`, core): el estado de la propiedad y las ya republicadas. */
  context?: { listingStatus: ListingStatus; relisted: ReadonlySet<string> },
) {
  const { pause, resume, close, sync } = availablePublicationOperations(publication);
  const { status } = publication;
  const portal = publication.platform === "portal_inmobiliario";
  return {
    retry: status === "failed",
    // Calendario (spec F6 §4.3, F6-T12): programar una aprobada o fallida; una programada se
    // reprograma, se desprograma o se publica ahora (adelantarla).
    schedule: status === "approved" || status === "failed",
    reschedule: status === "scheduled",
    unschedule: status === "scheduled",
    publishNow: status === "scheduled",
    // Portal (spec F6 §4.7): mandar los cambios a un aviso publicado o pausado, y republicar uno
    // cerrado o vencido.
    update: portal && (status === "published" || status === "paused"),
    relist:
      portal &&
      context !== undefined &&
      canRelist(publication, context.listingStatus, context.relisted),
    cancel: status === "approved" || status === "failed" || status === "scheduled",
    // Marketplace (spec F5 §4.3): "Lo publiqué" con el enlace y "No lo publiqué".
    confirm: status === "awaiting_manual_confirm",
    retire: !OPERATION_PLATFORMS.has(publication.platform) && status === "published",
    pause,
    resume,
    close,
    sync,
  };
}

/**
 * Si pedir una publicación necesita confirmar que va en vivo: con la API en vivo y también mientras
 * no se sabe el modo (`/health` no respondió). Solo la simulación conocida no pregunta.
 */
export const needsLiveConfirm = (publishMode: PublishMode | undefined) => publishMode !== "dry-run";

/** El texto del botón Publicar según el canal y el modo de la API (neutro si todavía no se sabe). */
export function publishButtonText(
  platform: Platform,
  publishMode: PublishMode | undefined,
): string {
  const base = `Publicar en ${PLATFORM_TEXT[platform]}`;
  if (publishMode === "live") return `${base} (en vivo)`;
  if (publishMode === "dry-run") return `${base} (simulación)`;
  return base;
}

/**
 * Desde cuándo cuenta el tope de espera de una publicación (spec F3-T18): el más reciente entre su
 * último cambio y la hora del clic. Reencolar una que ya estaba en `publishing` no cambia
 * `updatedAt`, y una aprobada hace días no debe cortar la espera.
 */
export function waitStart(updatedAt: Date, requestedAt: Date | null): Date {
  return requestedAt !== null && requestedAt > updatedAt ? requestedAt : updatedAt;
}

/** El enlace de una publicada, solo si es `https` (viene de la API y va a un `href`). */
export function safeExternalUrl(url: string | null): string | null {
  return url?.startsWith("https://") ? url : null;
}
