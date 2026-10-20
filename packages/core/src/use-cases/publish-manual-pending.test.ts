import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { OUTCOME_UNKNOWN } from "../publish/outcome.js";
import {
  createFakePublisher,
  createPostPublicationScenario,
  createPublicationScenario,
  createSendOncePublisher,
} from "../testing/index.js";
import { markNotPublished } from "./confirm-manual-publication.js";
import { publishListing } from "./publish-listing.js";
import { publishPublication } from "./publish-publication.js";
import { resolvePublication } from "./resolve-publication.js";

// F9-T06, ajustes de la revisión (revisor y arquitecto): el traspaso a mano y un envío pendiente,
// la lista cerrada de redes con modo a mano, la espera ante un límite en un post y resolver en
// `dry-run`.

const NOW = new Date("2026-10-20T15:00:00Z");

const manualLinkedIn = () =>
  createPostPublicationScenario({
    texts: [{ platform: "linkedin", language: "es" }],
    accounts: [{ platform: "linkedin", meta: { mode: "manual" } }],
  });

describe("traspaso a mano y envío pendiente", () => {
  it("«no lo publiqué» a mano borra el traspaso: si la cuenta pasa a api, el reintento envía", async () => {
    const t = await manualLinkedIn();
    const publication = await t.toPublishing(t.publicationOf("linkedin"));
    await publishPublication(t.publishDeps({}), {
      publicationId: publication.id,
      isLastAttempt: false,
    });
    await expect(
      markNotPublished(t.subjectDeps, { publicationId: publication.id, actor: "operator" }),
    ).resolves.toMatchObject({ status: "failed", progress: null });

    await t.platformAccounts.mergeMeta(t.accounts.get("linkedin") ?? "", { mode: "api" });
    await t.publications.transition(
      publication.id,
      { from: "failed", to: "publishing", changes: { dryRun: false, incrementAttempts: true } },
      { actor: "operator" },
    );
    const linkedin = createSendOncePublisher("linkedin");
    await expect(
      publishPublication(t.publishDeps({ linkedin }), {
        publicationId: publication.id,
        isLastAttempt: false,
      }),
    ).resolves.toMatchObject({ outcome: "published" });
    expect(linkedin.sends).toHaveLength(1);
  });

  it("el camino a mano revisa un envío pendiente: dudoso si pudo salir, publicado si ya salió", async () => {
    const pending = await manualLinkedIn();
    const first = await pending.toPublishing(pending.publicationOf("linkedin"));
    await pending.publications.saveProgress(first.id, { send: { startedAt: NOW.toISOString() } });
    await expect(
      publishPublication(pending.publishDeps({}), {
        publicationId: first.id,
        isLastAttempt: false,
      }),
    ).resolves.toMatchObject({
      outcome: "outcome_unknown",
      publication: { lastError: { code: OUTCOME_UNKNOWN } },
    });

    const sent = await manualLinkedIn();
    const second = await sent.toPublishing(sent.publicationOf("linkedin"));
    await sent.publications.saveProgress(second.id, {
      send: {
        startedAt: NOW.toISOString(),
        result: { externalId: "urn:li:share:1", externalUrl: "https://www.linkedin.com/x" },
      },
    });
    await expect(
      publishPublication(sent.publishDeps({}), {
        publicationId: second.id,
        isLastAttempt: false,
      }),
    ).resolves.toMatchObject({
      outcome: "published",
      publication: { status: "published", externalId: "urn:li:share:1" },
    });
  });
});

describe("lista cerrada de redes con modo a mano", () => {
  it("en Instagram un meta.mode = manual no vale: publica por API como siempre", async () => {
    const t = await createPublicationScenario();
    await t.platformAccounts.mergeMeta(t.account?.id ?? "", { mode: "manual" });
    const { started } = await publishListing(t.deps, {
      listingId: t.listingId,
      platform: "instagram",
      dryRun: false,
      actor: "operator",
    });
    const [post] = started;
    if (post === undefined) throw new Error("falta la publicación");
    const fake = createFakePublisher();
    await expect(
      publishPublication(
        {
          publications: t.publications,
          platformAccounts: t.platformAccounts,
          contents: t.contents,
          media: t.media,
          listings: t.listings,
          brokers: t.brokers,
          storage: t.storage,
          publishers: { instagram: fake },
          workerMode: "live",
          marketplaceAutomation: true,
          mercadoLibre: null,
        },
        { publicationId: post.id, isLastAttempt: false },
      ),
    ).resolves.toMatchObject({ outcome: "published" });
    expect(fake.published).toHaveLength(1);
  });
});

describe("espera ante un límite con un post (hasta F9-T07)", () => {
  it("no lo reprograma: la cola reintenta y el último intento lo deja failed", async () => {
    const limit = () =>
      new AppError("DISCORD_RATE_LIMITED", "espera", {
        retriable: true,
        details: { waitMinutes: 5 },
      });
    const t = await createPostPublicationScenario();
    const first = limit();
    const second = limit();
    const discord = createSendOncePublisher("discord", {
      steps: [{ notSent: first }, { notSent: second }],
    });
    const deps = t.publishDeps({ discord });
    const publication = await t.toPublishing(t.publicationOf("discord"));

    await expect(
      publishPublication(deps, { publicationId: publication.id, isLastAttempt: false }),
    ).rejects.toBe(first);
    expect(t.current(publication.id)?.status).toBe("publishing");
    await expect(
      publishPublication(deps, { publicationId: publication.id, isLastAttempt: true }),
    ).rejects.toBe(second);
    expect(t.current(publication.id)).toMatchObject({
      status: "failed",
      scheduledAt: null,
      lastError: { code: "DISCORD_RATE_LIMITED" },
    });
  });
});

describe("resolvePublication en dry-run", () => {
  it("ignora el enlace: dry-run:<id> y sin enlace", async () => {
    const t = await createPostPublicationScenario();
    const publication = await t.toPublishing(t.publicationOf("discord"), { dryRun: true });
    await t.publications.transition(
      publication.id,
      {
        from: "publishing",
        to: "outcome_unknown",
        changes: { lastError: { code: OUTCOME_UNKNOWN, message: "x", retriable: false } },
      },
      { actor: "system" },
    );
    await expect(
      resolvePublication(t.subjectDeps, {
        publicationId: publication.id,
        outcome: "published",
        url: "https://discord.com/channels/1/2/3",
        actor: "operator",
      }),
    ).resolves.toMatchObject({
      publication: { externalId: `dry-run:${publication.id}`, externalUrl: null },
    });
  });
});
