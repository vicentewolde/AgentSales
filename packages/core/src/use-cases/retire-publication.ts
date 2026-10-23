import type { AbortSignalLike } from "../abort.js";
import type { Platform, PublishMode } from "../enums.js";
import { AppError } from "../errors.js";
import { PLATFORM_TEXT } from "../labels.js";
import { isManualAccount } from "../platform-account.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import { type AccessTokenProvider, storedAccessToken } from "../ports/publisher.js";
import type { PlatformTokenRefresher } from "../ports/token-refresher.js";
import type { Publication, PublicationActor } from "../publication.js";
import { liveModeMismatch } from "../publish-mode.js";
import { runOnSubject, type SubjectLocks } from "../subject-lock.js";
import { ROTATING_TOKEN_PLATFORMS, rotatingAccessTokenProvider } from "./ensure-access-token.js";
import { expireAccountIfRejected } from "./platform-auth.js";
import {
  codeOf,
  listingBackToReadyIfLast,
  OPERATION_PLATFORMS,
  type PublicationOperations,
} from "./publication-operations.js";
import { publicationNotFound } from "./publication-start.js";

/**
 * Borrar lo publicado por la API al retirar (F9-T19, LinkedIn en modo `api`; F9.5-T09, X): el modo
 * de la API, las cuentas (el token guardado o, en una red con token que rota, el que asegura
 * `ensureRotatingAccessToken` bajo el candado de credenciales; un acceso rechazado la deja
 * `expired`) y el `remove` de cada plataforma (`operationsFor`, sin envolver: el modo lo decide la
 * publicación).
 */
export type RetireRemovalDeps = {
  /** El modo de este pedido para la publicación: el de su marca (ADR-0036). */
  apiMode: PublishMode;
  /** El `PUBLISH_MODE` del servidor, solo para explicar un `PUBLISH_MODE_MISMATCH` (nunca decide). */
  serverMode?: PublishMode;
  platformAccounts: Pick<
    PlatformAccountRepository,
    "get" | "getCredentials" | "changeStatus" | "withCredentialsLock"
  >;
  operationsFor(platform: Platform): PublicationOperations | undefined;
  /**
   * F9.5-T09: la renovación de las redes con token que rota (X), la misma del intento y de
   * `tokens.refresh`. Sin la de la red, un token por vencer es `TOKEN_REFRESH_NOT_CONFIGURED`.
   */
  refreshers?: Readonly<Partial<Record<Platform, PlatformTokenRefresher>>>;
  now?: () => Date;
  /** Un paso secundario que falló sin cortar (el estado de la cuenta): solo ids y códigos. */
  onWarning?: (warning: { publicationId: string; step: "account_status"; code: string }) => void;
};

/**
 * Las redes que AgentSales sabe borrar por la API al retirar (F9-T19, LinkedIn; F9.5-T09, X), con la
 * cuenta en modo `api`. La CLI la usa para avisar antes de preguntar; quien decide es el `remove`
 * de `operationsFor`. TikTok no está: no tiene cómo borrar por la API (D9 de F9.5).
 */
export const REMOTE_DELETE_PLATFORMS: ReadonlySet<Platform> = new Set(["linkedin", "x"]);

/** `postLock` hace falta para una publicación de un post (sin él, `SUBJECT_NOT_LISTING`). */
export type RetirePublicationDeps = SubjectLocks & {
  /** Fuera del candado: solo para saber de qué sujeto es la publicación. */
  publications: Pick<PublicationRepository, "get">;
  /** Sin esto, `deleteRemote` responde `RETIRE_DELETE_UNSUPPORTED` (F9-T19). */
  removal?: RetireRemovalDeps;
};

export type RetiredPublication = {
  publication: Publication;
  /**
   * `true` si era la última publicada en `live` y el aviso volvió de `active` a `ready`. Siempre
   * `false` en un post: nunca pasa a `active` (ADR-0029 punto 4).
   */
  listingBackToReady: boolean;
};

/**
 * Marca como retirada una publicación (spec F3 §4.3 y D8, `POST /publications/:id/retire`):
 * `published` → `unpublished`, con su evento, dentro del candado de su sujeto (el del aviso o,
 * desde F9-T07, el del post). Con Instagram Login no
 * se puede borrar por la API, así que en `live` el operador confirma que la borró a mano
 * (`removedByHand`); en `dry-run` no hay nada que borrar. Si era la última publicada en `live` del
 * aviso, el aviso vuelve de `active` a `ready` (cambio del sistema, condicional: si el aviso ya
 * cambió, no se toca). Errores (`AppError`):
 * - no existe → `PUBLICATION_NOT_FOUND` (404);
 * - es de una plataforma que se cierra desde AgentSales (Portal) → `RETIRE_NOT_SUPPORTED` (409, spec
 *   F4 §4.9): se usa Cerrar;
 * - en `live` sin la confirmación → `REMOVAL_NOT_CONFIRMED` (409), sin cambiar nada;
 * - no está publicada → `INVALID_TRANSITION` (409).
 *
 * F9-T19, `deleteRemote` (LinkedIn con la cuenta en modo `api`; desde F9.5-T09, también X): en vez
 * de confirmar que se borró a mano, se borra por la API **antes y fuera** del candado, con el token
 * guardado (X: el que asegura `ensureRotatingAccessToken`). Solo con la publicación en `live` y la
 * API en `live` (`PUBLISH_MODE_MISMATCH`: en simulación nunca se llama); en `dry-run` no hay nada
 * que borrar y se retira igual. `RETIRE_DELETE_UNSUPPORTED` (409) si la plataforma no borra por la
 * API o la cuenta está a mano, y `TIKTOK_DELETE_UNSUPPORTED` (409, D9 de F9.5) en TikTok, que no
 * tiene cómo borrar por la API; el `remove` de la plataforma puede negarse (LinkedIn: un enlace
 * pegado a mano no trae el id que acepta la API). Borrar es idempotente: si guardar el cambio falla
 * después, retirar de nuevo vuelve a borrar sin error.
 */
export async function retirePublication(
  deps: RetirePublicationDeps,
  {
    publicationId,
    actor,
    removedByHand = false,
    deleteRemote = false,
    signal,
  }: {
    publicationId: string;
    actor: PublicationActor;
    removedByHand?: boolean;
    /** F9-T19: borrar por la API (no se junta con `removedByHand`). */
    deleteRemote?: boolean;
    signal?: AbortSignalLike;
  },
): Promise<RetiredPublication> {
  const found = await deps.publications.get(publicationId);
  if (found === null) throw publicationNotFound(publicationId);
  if (OPERATION_PLATFORMS.has(found.platform)) {
    throw new AppError(
      "RETIRE_NOT_SUPPORTED",
      "Esta publicación se cierra desde AgentSales: usa Cerrar en vez de marcarla como retirada",
      { details: { publicationId, platform: found.platform } },
    );
  }
  if (deleteRemote && removedByHand) {
    throw new AppError(
      "RETIRE_OPTIONS_INVALID",
      "O la borraste a mano, o la borra AgentSales: no las dos",
      { details: { publicationId } },
    );
  }
  const removedByApi = deleteRemote && !found.dryRun;
  if (removedByApi) await removeRemote(deps.removal, found, signal);

  return runOnSubject(deps, found.subject, async (locked) => {
    const publication = await locked.repos.publications.get(publicationId);
    if (publication === null) throw publicationNotFound(publicationId);
    if (publication.status !== "published") {
      throw new AppError("INVALID_TRANSITION", "Solo se retira una publicación publicada", {
        details: { publicationId, from: publication.status, to: "unpublished" },
      });
    }
    const live = !publication.dryRun;
    if (live && !removedByHand && !removedByApi) {
      throw new AppError(
        "REMOVAL_NOT_CONFIRMED",
        `Bórrala a mano en ${PLATFORM_TEXT[publication.platform]} y confirma que lo hiciste antes de marcarla como retirada`,
        { details: { publicationId } },
      );
    }
    const retired = await locked.repos.publications.transition(
      publicationId,
      { from: "published", to: "unpublished" },
      {
        actor,
        payload: {
          mode: live ? "live" : "dry-run",
          removedByHand: live && !removedByApi,
          ...(removedByApi ? { removedByApi: true } : {}),
        },
      },
    );
    // Lo del aviso (volver de `active` a `ready`) no aplica a un post.
    const listingBackToReady =
      live && locked.kind === "listing"
        ? await listingBackToReadyIfLast(locked.repos, locked.subject.id)
        : false;
    return { publication: retired, listingBackToReady };
  });
}

/** No se borra por la API: se borra a mano y se confirma. */
const deleteUnsupported = (publication: Publication, reason: string) =>
  new AppError(
    "RETIRE_DELETE_UNSUPPORTED",
    `${reason}: bórrala a mano en ${PLATFORM_TEXT[publication.platform]} y márcala como retirada confirmando que lo hiciste`,
    { details: { publicationId: publication.id, platform: publication.platform } },
  );

/** TikTok no tiene cómo borrar por la API (D9 de F9.5, `tiktok.md` §1): se borra en la app. */
const tiktokDeleteUnsupported = (publication: Publication) =>
  new AppError(
    "TIKTOK_DELETE_UNSUPPORTED",
    "TikTok no deja borrar un video por la API: bórralo a mano en la app de TikTok y después márcalo como retirado sin borrar",
    { details: { publicationId: publication.id, platform: publication.platform } },
  );

/**
 * Borra en la plataforma una publicación en `live` (F9-T19), fuera del candado. Revisa antes, sin
 * llamar: que esté publicada, que no sea de TikTok (D9), que la plataforma borre por la API, la API
 * en `live`, la cuenta conectada y en modo `api`, y el id en la plataforma. El token es el guardado
 * o, en una red con token que rota (`ROTATING_TOKEN_PLATFORMS`: X, F9.5-T09), el que asegura
 * `ensureRotatingAccessToken`: lo renueva, si le quedan menos de 30 min o la red lo rechazó, **una**
 * vez y dentro del candado de credenciales (renovarlo en dos lugares a la vez lo invalida, S4).
 * Un acceso rechazado deja la cuenta `expired`.
 */
async function removeRemote(
  removal: RetireRemovalDeps | undefined,
  publication: Publication,
  signal: AbortSignalLike | undefined,
): Promise<void> {
  const publicationId = publication.id;
  if (publication.status !== "published") {
    throw new AppError("INVALID_TRANSITION", "Solo se retira una publicación publicada", {
      details: { publicationId, from: publication.status, to: "unpublished" },
    });
  }
  if (publication.platform === "tiktok") throw tiktokDeleteUnsupported(publication);
  const remove = removal?.operationsFor(publication.platform)?.remove;
  if (removal === undefined || remove === undefined) {
    throw deleteUnsupported(publication, "Esta red no se borra desde AgentSales");
  }
  if (removal.apiMode !== "live") {
    throw liveModeMismatch({
      what: "Esta publicación está en vivo",
      nothing: "no se borró nada en la red",
      serverMode: removal.serverMode,
      publicationId,
    });
  }
  const account = await removal.platformAccounts.get(publication.platformAccountId);
  if (account === null || account.status !== "connected") {
    throw new AppError(
      "ACCOUNT_NOT_CONNECTED",
      "La cuenta de esta publicación no está conectada: reconéctala o bórrala a mano",
      { details: { publicationId, accountStatus: account?.status ?? null } },
    );
  }
  if (isManualAccount(account)) {
    throw deleteUnsupported(publication, "La cuenta publica a mano");
  }
  if (publication.externalId === null) {
    throw deleteUnsupported(publication, "La publicación no tiene su id en la red");
  }
  try {
    await remove(
      { externalId: publication.externalId, progress: publication.progress },
      {
        account,
        accessToken: await removalToken(removal, publication, account.id),
        ...(signal === undefined ? {} : { signal }),
      },
    );
  } catch (error) {
    await expireAccountIfRejected(removal.platformAccounts, account.id, error, (failure) =>
      removal.onWarning?.({ publicationId, step: "account_status", code: codeOf(failure) }),
    );
    throw error;
  }
}

/**
 * El token para borrar: en una red con token que rota (X), el proveedor de
 * `ensureRotatingAccessToken` (la misma política del intento, con el candado de credenciales; lee
 * las credenciales él mismo); en las demás, el guardado.
 */
async function removalToken(
  removal: RetireRemovalDeps,
  publication: Publication,
  accountId: string,
): Promise<AccessTokenProvider> {
  if (!ROTATING_TOKEN_PLATFORMS.has(publication.platform)) {
    return storedAccessToken(await removal.platformAccounts.getCredentials(accountId));
  }
  return rotatingAccessTokenProvider(
    {
      platformAccounts: removal.platformAccounts,
      refreshers: removal.refreshers ?? {},
      ...(removal.now === undefined ? {} : { now: removal.now }),
      onWarning: (warning) =>
        removal.onWarning?.({
          publicationId: publication.id,
          step: "account_status",
          code: warning.code,
        }),
    },
    accountId,
  );
}
