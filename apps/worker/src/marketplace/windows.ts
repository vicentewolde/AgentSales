import type { Logger } from "@agentsales/config";
import {
  isAppError,
  type MarketplaceProgress,
  marketplaceProgressSchema,
  type Publication,
  type PublicationRepository,
} from "@agentsales/core";
import type { MarketplaceWindow } from "@agentsales/publishers/marketplace";

/** Cada cuánto relee la publicación de una ventana abierta (spec F5 §4.5). */
export const MARKETPLACE_WINDOW_POLL_MS = 5_000;

export type MarketplaceWindowsDeps = {
  publications: Pick<PublicationRepository, "get" | "updateProgress" | "listByStatus">;
  /** "Lo publiqué" con el enlace que vio la ventana (`confirmManualPublication`, actor `system`). */
  confirm(publicationId: string, url: string): Promise<unknown>;
  /** `MARKETPLACE_CONFIRM_TIMEOUT_MIN` en milisegundos. */
  timeoutMs: number;
  pollMs?: number;
  now?: () => Date;
  logger: Logger;
};

type Entry = {
  publicationId: string;
  brokerId: string;
  accountId: string;
  window: MarketplaceWindow;
  /** El intento de la publicación cuya ventana es (se fija al activarla). */
  attempt: number | null;
  timer: ReturnType<typeof setInterval> | null;
};

/** Solo el código: el mensaje de un error puede traer datos. */
const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/** El progreso de Marketplace de una publicación, o `null` si no lo tiene o no calza. */
const progressOf = (publication: Publication): MarketplaceProgress | null => {
  const parsed = marketplaceProgressSchema.safeParse(publication.progress);
  return parsed.success ? parsed.data : null;
};

/**
 * Anota que la ventana de un intento se cerró sin ver el aviso (`windowClosedAt`, spec F5 §4.5), sin
 * cambiar el estado: la publicación sigue esperando la palabra del operador (D11). Solo si sigue en
 * `awaiting_manual_confirm`, en ese intento y sin la marca; si cambió entretanto, no hace nada.
 */
export async function markWindowClosed(
  publications: Pick<PublicationRepository, "get" | "updateProgress">,
  publicationId: string,
  attempt: number | null,
  now: Date,
): Promise<boolean> {
  const publication = await publications.get(publicationId);
  if (publication === null || publication.status !== "awaiting_manual_confirm") return false;
  if (attempt !== null && publication.attempts !== attempt) return false;
  const progress = progressOf(publication);
  if (progress === null || progress.windowClosedAt !== undefined) return false;
  try {
    await publications.updateProgress(
      publicationId,
      { from: "awaiting_manual_confirm", attempts: publication.attempts },
      { ...progress, windowClosedAt: now.toISOString() },
    );
    return true;
  } catch (error) {
    if (isAppError(error) && error.code === "PUBLICATION_PROGRESS_STALE") return false;
    throw error;
  }
}

/**
 * Las ventanas de Marketplace que tiene el worker (spec F5 §4.5, ADR-0017): una por cuenta.
 * - `hold`: el publisher entrega la ventana con el formulario listo (`onHandoff`); queda pendiente.
 * - `activate`: el intento dejó la publicación en `awaiting_manual_confirm`; empieza a vigilar. Al
 *   ver el aviso, lo confirma (actor `system`) y cierra; si la ventana se cierra o vence el tope,
 *   anota `windowClosedAt` (sin cambiar el estado). Cada `pollMs` relee la publicación y, si ya no
 *   espera (el operador pegó el enlace o dijo "No lo publiqué"), cierra la ventana.
 * - `discard`: el intento no terminó en espera; cierra la pendiente.
 * - `closeForAccount` y `closeForBroker`: antes de abrir otro formulario de la cuenta o de borrar el
 *   perfil. `closeAll`, al apagar: anota `windowClosedAt` y cierra, antes de cerrar la base.
 * Nada de lo que falla aquí tumba el worker: va al log, solo con códigos.
 */
export function createMarketplaceWindows(deps: MarketplaceWindowsDeps) {
  const entries = new Map<string, Entry>();
  const now = deps.now ?? (() => new Date());
  const pollMs = deps.pollMs ?? MARKETPLACE_WINDOW_POLL_MS;

  const forget = (entry: Entry) => {
    if (entry.timer !== null) clearInterval(entry.timer);
    if (entries.get(entry.publicationId) === entry) entries.delete(entry.publicationId);
  };

  const closeEntry = async (entry: Entry) => {
    forget(entry);
    await entry.window
      .close()
      .catch((error: unknown) =>
        deps.logger.warn(
          { publicationId: entry.publicationId, code: codeOf(error) },
          "no se pudo cerrar la ventana de Marketplace",
        ),
      );
  };

  const noteClosed = async (entry: Entry, reason: string) => {
    forget(entry);
    try {
      const marked = await markWindowClosed(
        deps.publications,
        entry.publicationId,
        entry.attempt,
        now(),
      );
      deps.logger.info(
        { publicationId: entry.publicationId, reason, marked },
        "la ventana de Marketplace se cerró sin ver el aviso: espera la palabra del operador",
      );
    } catch (error) {
      deps.logger.warn(
        { publicationId: entry.publicationId, code: codeOf(error) },
        "no se pudo anotar el cierre de la ventana de Marketplace",
      );
    }
  };

  return {
    /** Cuántas ventanas hay (para los tests y el log del apagado). */
    size: () => entries.size,

    async hold(
      ref: { publicationId: string; brokerId: string; accountId: string },
      window: MarketplaceWindow,
    ): Promise<void> {
      const previous = entries.get(ref.publicationId);
      if (previous !== undefined) await closeEntry(previous);
      entries.set(ref.publicationId, { ...ref, window, attempt: null, timer: null });
    },

    async activate(publicationId: string): Promise<boolean> {
      const entry = entries.get(publicationId);
      if (entry === undefined) return false;
      const publication = await deps.publications.get(publicationId).catch(() => null);
      if (publication === null || publication.status !== "awaiting_manual_confirm") {
        await closeEntry(entry);
        return false;
      }
      entry.attempt = publication.attempts;
      entry.window.watch(
        {
          onItemUrl: async (url) => {
            forget(entry);
            await deps.confirm(publicationId, url);
            deps.logger.info(
              { publicationId },
              "Marketplace: el aviso se publicó (lo vio la ventana)",
            );
          },
          onClosed: (reason) => noteClosed(entry, reason),
          onError: (error) => {
            // `INVALID_TRANSITION`: el operador ya la confirmó o la marcó; no es un problema.
            if (!(isAppError(error) && error.code === "INVALID_TRANSITION")) {
              deps.logger.warn(
                { publicationId, code: codeOf(error) },
                "no se pudo registrar el aviso que vio la ventana",
              );
            }
          },
        },
        { timeoutMs: deps.timeoutMs },
      );
      entry.timer = setInterval(() => {
        void deps.publications
          .get(publicationId)
          .then(async (current) => {
            if (entries.get(publicationId) !== entry) return;
            if (
              current === null ||
              current.status !== "awaiting_manual_confirm" ||
              current.attempts !== entry.attempt
            ) {
              await closeEntry(entry);
            }
          })
          .catch(() => undefined);
      }, pollMs);
      entry.timer.unref?.();
      return true;
    },

    async discard(publicationId: string): Promise<void> {
      const entry = entries.get(publicationId);
      if (entry !== undefined) await closeEntry(entry);
    },

    async closeForAccount(accountId: string): Promise<void> {
      for (const entry of [...entries.values()]) {
        if (entry.accountId === accountId) await closeEntry(entry);
      }
    },

    async closeForBroker(brokerId: string): Promise<void> {
      for (const entry of [...entries.values()]) {
        if (entry.brokerId === brokerId) await closeEntry(entry);
      }
    },

    async closeAll(): Promise<void> {
      for (const entry of [...entries.values()]) {
        forget(entry);
        await markWindowClosed(deps.publications, entry.publicationId, entry.attempt, now()).catch(
          () => false,
        );
        await entry.window.close().catch(() => undefined);
      }
    },
  };
}

export type MarketplaceWindows = ReturnType<typeof createMarketplaceWindows>;

/**
 * Al arrancar (spec F5 §4.5): las publicaciones que esperan el clic final ya no tienen ventana (el
 * worker se apagó): se anota `windowClosedAt` en las que no lo tengan. Devuelve cuántas.
 */
export async function sweepClosedWindows(
  publications: Pick<PublicationRepository, "get" | "updateProgress" | "listByStatus">,
  now: Date,
): Promise<number> {
  let marked = 0;
  for (const publication of await publications.listByStatus("awaiting_manual_confirm")) {
    if (await markWindowClosed(publications, publication.id, publication.attempts, now))
      marked += 1;
  }
  return marked;
}
