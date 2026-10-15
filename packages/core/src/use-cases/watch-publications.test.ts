import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import type { Publication } from "../publication.js";
import { createPublicationScenario, type PublicationScenario } from "../testing/index.js";
import { STALE_PUBLISHING_MS, watchPublications } from "./watch-publications.js";

const toPublishing = (t: PublicationScenario, id: string, dryRun = true) =>
  t.publications.transition(
    id,
    { from: "approved", to: "publishing", changes: { dryRun } },
    { actor: "operator" },
  );

const watch = (t: PublicationScenario, now: Date) =>
  watchPublications({
    publications: t.publications,
    platformAccounts: t.platformAccounts,
    queue: t.queue,
    now: () => now,
  });

const later = () => new Date(Date.now() + STALE_PUBLISHING_MS + 60_000);

describe("watchPublications", () => {
  it("reencola una publishing atascada (más de 70 min) y no una reciente", async () => {
    const t = await createPublicationScenario();
    const post = t.byFormat("post") as Publication;
    await toPublishing(t, post.id);

    expect((await watch(t, new Date())).requeued).toEqual([]);
    const result = await watch(t, later());

    expect(result.requeued).toEqual([post.id]);
    expect(t.queue.jobs).toEqual([
      {
        name: "publication.publish",
        data: { publicationId: post.id },
        options: { singletonKey: post.id },
      },
    ]);
  });

  it("nunca reencola una de Marketplace: un formulario no se reabre sin el operador (D7)", async () => {
    const t = await createPublicationScenario({ platform: "fb_marketplace" });
    const post = t.byFormat("post") as Publication;
    await toPublishing(t, post.id);

    const result = await watch(t, later());

    expect(result.requeued).toEqual([]);
    expect(t.queue.jobs).toEqual([]);
  });

  it("encola el sync de Portal en vivo con la cuenta conectada, y no el de una simulación", async () => {
    const t = await createPublicationScenario({ platform: "portal_inmobiliario" });
    const post = t.byFormat("post") as Publication;
    await toPublishing(t, post.id, false);
    await t.publications.transition(
      post.id,
      { from: "publishing", to: "published", changes: { externalId: "MLC1" } },
      { actor: "system" },
    );

    const result = await watch(t, new Date());

    expect(result.syncs).toEqual({ enqueued: 1, alreadyQueued: 0, failed: [] });
    expect(t.queue.jobs).toEqual([
      {
        name: "publication.sync",
        data: { publicationId: post.id },
        options: { singletonKey: post.id },
      },
    ]);
  });

  it("una que no se pudo reencolar no corta las demás y queda informada con su código", async () => {
    let calls = 0;
    const t = await createPublicationScenario({
      queueFails: () =>
        calls++ === 0
          ? new AppError("QUEUE_UNAVAILABLE", "cola caída", { retriable: true })
          : undefined,
    });
    const post = t.byFormat("post") as Publication;
    const reel = t.byFormat("reel") as Publication;
    await toPublishing(t, post.id);
    await toPublishing(t, reel.id);

    const result = await watch(t, later());

    expect(result.requeueFailed).toEqual([{ publicationId: post.id, code: "QUEUE_UNAVAILABLE" }]);
    expect(result.requeued).toEqual([reel.id]);
  });
});
