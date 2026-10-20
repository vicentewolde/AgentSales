import { isAppError } from "../errors.js";
import type { ContentRunRepository } from "../ports/content-repository.js";
import { SCHEDULE_OVERDUE_MS } from "../schedule.js";
import { listingSubject } from "../subject.js";
import {
  type AutoPublishDeps,
  type AutoPublishResult,
  autoPublishListing,
} from "./auto-publish-listing.js";

// El `auto_publish` cortado (spec F8 §4.10, T12): una corrida que terminó bien pero cuyo
// `auto_publish` no llegó a resolverse (el worker se reinició justo al terminar) se retoma al
// arrancar, una sola vez.

export type ResumeAutoPublishDeps = AutoPublishDeps & {
  contentRuns: Pick<
    ContentRunRepository,
    "listAutoPublishPending" | "markAutoPublishDone" | "latest"
  >;
};

/** Lo que pasó con cada corrida pendiente; solo ids, códigos y resultados. */
export type ResumedAutoPublish =
  | { listingId: string; outcome: "resumed"; result: AutoPublishResult }
  /** Otra corrida más nueva, publicaciones creadas después, o ya la tomó otro proceso. */
  | { listingId: string; outcome: "skipped"; reason: "superseded" | "touched" | "taken" }
  | { listingId: string; outcome: "failed"; code: string };

/**
 * Retoma los `auto_publish` cortados de las corridas terminadas hace 12 h o menos (las mismas 12 h
 * que una publicación atrasada, `SCHEDULE_OVERDUE_MS`; una más vieja queda para el operador, que la
 * ve en la agenda). Cada corrida se anota primero (`markAutoPublishDone`): un corte a mitad no la
 * repite. Se retoma solo si sigue siendo la última corrida de la propiedad y no hay publicaciones
 * creadas después de que terminó (ni el operador ni un intento anterior la tocaron). Una que falla
 * no corta las demás.
 */
export async function resumeCutAutoPublish(
  deps: ResumeAutoPublishDeps,
  { now = new Date() }: { now?: Date } = {},
): Promise<ResumedAutoPublish[]> {
  const results: ResumedAutoPublish[] = [];
  const pending = await deps.contentRuns.listAutoPublishPending(
    new Date(now.getTime() - SCHEDULE_OVERDUE_MS),
  );
  for (const run of pending) {
    // `listAutoPublishPending` solo trae corridas de avisos: los posts no tienen `auto_publish`.
    if (run.subject.kind !== "listing") continue;
    const listingId = run.subject.id;
    try {
      if (!(await deps.contentRuns.markAutoPublishDone(run.id))) {
        results.push({ listingId, outcome: "skipped", reason: "taken" });
        continue;
      }
      const latest = await deps.contentRuns.latest(listingSubject(listingId));
      if (latest?.id !== run.id) {
        results.push({ listingId, outcome: "skipped", reason: "superseded" });
        continue;
      }
      const finishedAt = run.finishedAt ?? now;
      const touched = await deps.lock.run(listingId, async (locked) =>
        (await locked.publications.listBySubject(listingSubject(listingId))).some(
          (publication) => publication.createdAt >= finishedAt,
        ),
      );
      if (touched) {
        results.push({ listingId, outcome: "skipped", reason: "touched" });
        continue;
      }
      results.push({
        listingId,
        outcome: "resumed",
        result: await autoPublishListing(deps, { listingId }),
      });
    } catch (error) {
      results.push({
        listingId,
        outcome: "failed",
        code: isAppError(error) ? error.code : "INTERNAL_ERROR",
      });
    }
  }
  return results;
}
