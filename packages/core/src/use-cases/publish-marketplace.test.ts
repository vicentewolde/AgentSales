import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import type { UfValue, UfValueSource } from "../ports/uf-value-source.js";
import type { Publication } from "../publication.js";
import { DRY_RUN_HANDOFF_NOTE } from "../publish/dry-run.js";
import {
  createFakePublisher,
  createPublicationScenario,
  type FakePublishStep,
} from "../testing/index.js";
import { cancelPublication } from "./cancel-publication.js";
import { confirmManualPublication, markNotPublished } from "./confirm-manual-publication.js";
import { connectManualMarketplaceAccount } from "./connect-marketplace-account.js";
import { requireMarketplaceStartable } from "./publication-start.js";
import { publishListing } from "./publish-listing.js";
import { BY_HAND_NOTE, publishPublication } from "./publish-publication.js";
import { startPublication } from "./start-publication.js";
import { unapproveContent } from "./unapprove-content.js";

// Marketplace en dos tiempos (spec F5 §4.3 y §4.7, F5-T05): el intento deja el formulario listo y
// la publicación se confirma con el enlace o con "No lo publiqué".

/** 15:00 en Santiago (UTC-3 en octubre). */
const NOW = new Date("2026-10-09T18:00:00Z");
const UF_TODAY: UfValue = { date: "2026-10-09", value: "41130.94" };
const UF_YESTERDAY: UfValue = { date: "2026-10-08", value: "41126.12" };
const ITEM_URL = "https://www.facebook.com/marketplace/item/123456789/?ref=share";

/** Una fuente de la UF falsa: los valores pedidos, en orden. */
function fakeUf(values: UfValue[] = [UF_YESTERDAY, UF_TODAY]) {
  const calls: Array<{ from: string; to: string }> = [];
  const source: UfValueSource = {
    async valuesBetween(from, to) {
      calls.push({ from, to });
      return values.filter((value) => value.date >= from && value.date <= to);
    },
  };
  return { source, calls };
}

async function setup(
  options: {
    dryRun?: boolean;
    clock?: () => Date;
    dailyLimit?: number;
    uf?: UfValueSource;
    steps?: FakePublishStep[];
  } = {},
) {
  const clock = options.clock ?? (() => NOW);
  const t = await createPublicationScenario({ platform: "fb_marketplace", clock });
  const fake = createFakePublisher({
    platform: "fb_marketplace",
    formats: ["post"],
    manualConfirm: true,
    ...(options.steps === undefined ? {} : { steps: options.steps }),
  });
  const uf = options.uf ?? fakeUf().source;
  const startDeps = {
    ...t.deps,
    marketplace: { dailyLimit: options.dailyLimit ?? 3, ufConfigured: true },
    now: clock,
  };
  const attemptDeps = {
    publications: t.publications,
    platformAccounts: t.platformAccounts,
    contents: t.contents,
    media: t.media,
    listings: t.listings,
    brokers: t.brokers,
    storage: t.storage,
    publishers: { fb_marketplace: fake },
    workerMode: "live" as const,
    mercadoLibre: null,
    marketplaceDailyLimit: options.dailyLimit ?? 3,
    uf,
    now: clock,
  };
  const publish = async () => {
    const { started } = await publishListing(startDeps, {
      listingId: t.listingId,
      platform: "fb_marketplace",
      dryRun: options.dryRun ?? false,
      actor: "operator",
    });
    const publication = started[0];
    if (publication === undefined) throw new Error("no se inició la publicación");
    return publication;
  };
  const attempt = (publication: Publication, extra: { isLastAttempt?: boolean } = {}) =>
    publishPublication(attemptDeps, {
      publicationId: publication.id,
      isLastAttempt: extra.isLastAttempt ?? false,
    });
  const manualDeps = { lock: t.deps.lock, publications: t.deps.publications, now: clock };
  const current = async (id: string) => t.publications.get(id);
  const events = async (id: string) => t.publications.listEvents(id);
  return { t, fake, startDeps, attemptDeps, publish, attempt, manualDeps, current, events };
}

describe("Marketplace · el intento deja el formulario listo", () => {
  it("live: publishing → awaiting_manual_confirm con el progreso del intento y el precio en pesos", async () => {
    const s = await setup();
    const publication = await s.publish();

    const result = await s.attempt(publication);

    expect(result.outcome).toBe("awaiting_manual_confirm");
    const waiting = await s.current(publication.id);
    expect(waiting).toMatchObject({ status: "awaiting_manual_confirm", externalId: null });
    // 5.800 UF × 41.130,94 = 238.559.452 pesos.
    expect(waiting?.progress).toEqual({
      attempt: 1,
      simulated: false,
      formReadyAt: NOW.toISOString(),
      photos: 2,
      priceClp: 238_559_452,
      ufValue: "41130.94",
      ufDate: "2026-10-09",
    });
    // El publisher recibe el precio ya calculado y no pide credenciales.
    expect(s.fake.published[0]?.input).toMatchObject({ priceClp: 238_559_452, uf: UF_TODAY });
    const attempt = (await s.events(publication.id)).find((e) => e.type === "publish_attempt");
    expect(attempt?.payload).toMatchObject({
      mode: "live",
      result: "awaiting_manual_confirm",
      sent: { priceClp: 238_559_452, uf: UF_TODAY },
    });
  });

  it("dry-run: simula el formulario listo sin llamar al publisher (también convierte la UF)", async () => {
    const s = await setup({ dryRun: true });
    const publication = await s.publish();

    await expect(s.attempt(publication)).resolves.toMatchObject({
      outcome: "awaiting_manual_confirm",
    });

    expect(s.fake.published).toEqual([]);
    expect((await s.current(publication.id))?.progress).toMatchObject({
      simulated: true,
      priceClp: 238_559_452,
    });
    const attempt = (await s.events(publication.id)).find((e) => e.type === "publish_attempt");
    expect(attempt?.payload).toMatchObject({
      mode: "dry-run",
      result: "awaiting_manual_confirm",
      notes: [DRY_RUN_HANDOFF_NOTE],
    });
  });

  it("un publisher con paso manual que da el aviso por publicado es INTERNAL_ERROR, nunca published", async () => {
    const s = await setup();
    s.fake.publish = async () => ({
      externalId: "x",
      externalUrl: null,
      simulated: false,
    });
    const publication = await s.publish();

    await expect(s.attempt(publication)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect((await s.current(publication.id))?.status).toBe("failed");
  });

  it("si no se puede guardar el formulario listo: PUBLISH_RESULT_NOT_SAVED, reintentable", async () => {
    const s = await setup();
    const publication = await s.publish();
    const transition = s.t.publications.transition.bind(s.t.publications);
    s.attemptDeps.publications = {
      ...s.t.publications,
      transition: async (id, move, event) => {
        if (move.to === "awaiting_manual_confirm") {
          throw new AppError("DB_UNAVAILABLE", "sin base", { retriable: true });
        }
        return transition(id, move, event);
      },
    };

    await expect(s.attempt(publication)).rejects.toMatchObject({
      code: "PUBLISH_RESULT_NOT_SAVED",
      retriable: true,
    });
    expect((await s.current(publication.id))?.status).toBe("publishing");
    // El intento abrió el formulario: deja su evento y cuenta para el límite.
    const attempt = (await s.events(publication.id)).find((e) => e.type === "publish_attempt");
    expect(attempt?.payload).toMatchObject({
      result: "retry",
      error: { code: "PUBLISH_RESULT_NOT_SAVED" },
    });
    await expect(
      s.t.publications.countLiveAttemptsSince(publication.platformAccountId, new Date(0)),
    ).resolves.toBe(1);
  });

  it("sin el valor de la UF de hoy: UF_VALUE_MISSING, failed, sin abrir el formulario", async () => {
    const s = await setup({ uf: fakeUf([UF_YESTERDAY]).source });
    const publication = await s.publish();

    await expect(s.attempt(publication)).rejects.toMatchObject({
      code: "UF_VALUE_MISSING",
      retriable: false,
    });
    expect(s.fake.published).toEqual([]);
    expect((await s.current(publication.id))?.status).toBe("failed");
  });
});

describe("Marketplace · confirmar o no", () => {
  it("live: el enlace lo deja published con el id y la forma limpia, y el aviso pasa a active", async () => {
    const s = await setup();
    const publication = await s.publish();
    await s.attempt(publication);

    const { publication: published, changed } = await confirmManualPublication(s.manualDeps, {
      publicationId: publication.id,
      url: ITEM_URL,
      actor: "operator",
    });

    expect(changed).toBe(true);
    expect(published).toMatchObject({
      status: "published",
      externalId: "123456789",
      externalUrl: "https://www.facebook.com/marketplace/item/123456789/",
      publishedAt: NOW,
    });
    expect((await s.t.listings.get(s.t.listingId))?.status).toBe("active");
    const confirmed = (await s.events(publication.id)).at(-1);
    expect(confirmed).toMatchObject({
      toStatus: "published",
      actor: "operator",
      payload: { mode: "live", confirmedBy: "operator" },
    });
    // Dos veces con el mismo enlace: no cambia; con otro, 409.
    await expect(
      confirmManualPublication(s.manualDeps, {
        publicationId: publication.id,
        url: "https://m.facebook.com/marketplace/item/123456789",
        actor: "system",
      }),
    ).resolves.toMatchObject({ changed: false });
    await expect(
      confirmManualPublication(s.manualDeps, {
        publicationId: publication.id,
        url: "https://www.facebook.com/marketplace/item/999/",
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "PUBLICATION_ALREADY_CONFIRMED" });
    await expect(
      confirmManualPublication(s.manualDeps, { publicationId: publication.id, actor: "operator" }),
    ).rejects.toMatchObject({ code: "MARKETPLACE_URL_REQUIRED" });
  });

  it("live: sin enlace o con uno que no es de Marketplace no cambia nada", async () => {
    const s = await setup();
    const publication = await s.publish();
    await s.attempt(publication);

    await expect(
      confirmManualPublication(s.manualDeps, { publicationId: publication.id, actor: "operator" }),
    ).rejects.toMatchObject({ code: "MARKETPLACE_URL_REQUIRED" });
    await expect(
      confirmManualPublication(s.manualDeps, {
        publicationId: publication.id,
        url: "https://evil.test/marketplace/item/1/",
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "MARKETPLACE_URL_INVALID" });
    expect((await s.current(publication.id))?.status).toBe("awaiting_manual_confirm");
  });

  it("dry-run: confirma sin enlace (lo ignora) y el aviso no pasa a active", async () => {
    const s = await setup({ dryRun: true });
    const publication = await s.publish();
    await s.attempt(publication);

    const { publication: published } = await confirmManualPublication(s.manualDeps, {
      publicationId: publication.id,
      url: ITEM_URL,
      actor: "operator",
    });

    expect(published).toMatchObject({
      status: "published",
      externalId: `dry-run:${publication.id}`,
      externalUrl: null,
    });
    expect((await s.t.listings.get(s.t.listingId))?.status).toBe("ready");
  });

  it("No lo publiqué: failed con su motivo; reintentar abre un intento nuevo con progreso nuevo", async () => {
    const s = await setup();
    const publication = await s.publish();
    await s.attempt(publication);

    const failed = await markNotPublished(s.manualDeps, {
      publicationId: publication.id,
      actor: "operator",
    });

    expect(failed).toMatchObject({
      status: "failed",
      lastError: { code: "MARKETPLACE_NOT_PUBLISHED", retriable: false },
    });
    const { publication: again } = await startPublication(s.startDeps, {
      publicationId: publication.id,
      dryRun: false,
      actor: "operator",
    });
    await s.attempt(again);
    expect((await s.current(publication.id))?.progress).toMatchObject({ attempt: 2 });
    // No se deshace: la máquina no permite failed → published (D14).
    await markNotPublished(s.manualDeps, { publicationId: publication.id, actor: "operator" });
    await expect(
      confirmManualPublication(s.manualDeps, {
        publicationId: publication.id,
        url: ITEM_URL,
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });

  it("mientras espera: descartar, quitar la aprobación y publicar de nuevo dan MANUAL_CONFIRM_PENDING", async () => {
    const s = await setup();
    const publication = await s.publish();
    await s.attempt(publication);

    await expect(
      cancelPublication(s.t.deps, { publicationId: publication.id, actor: "operator" }),
    ).rejects.toMatchObject({ code: "MANUAL_CONFIRM_PENDING" });
    await expect(
      unapproveContent(
        { ...s.t.approveDeps, lock: s.t.deps.lock },
        { contentId: publication.contentId, actor: "operator" },
      ),
    ).rejects.toMatchObject({ code: "MANUAL_CONFIRM_PENDING" });
    await expect(
      startPublication(s.startDeps, {
        publicationId: publication.id,
        dryRun: false,
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "MANUAL_CONFIRM_PENDING" });
    await expect(
      publishListing(s.startDeps, {
        listingId: s.t.listingId,
        platform: "fb_marketplace",
        dryRun: false,
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "MANUAL_CONFIRM_PENDING" });
    expect((await s.current(publication.id))?.status).toBe("awaiting_manual_confirm");
  });
});

describe("Marketplace · límite diario y un formulario a la vez", () => {
  /** Marca "No lo publiqué" y reintenta: otro intento de la misma publicación. */
  const retry = async (s: Awaited<ReturnType<typeof setup>>, publication: Publication) => {
    await markNotPublished(s.manualDeps, { publicationId: publication.id, actor: "operator" });
    const { publication: again } = await startPublication(s.startDeps, {
      publicationId: publication.id,
      dryRun: false,
      actor: "operator",
    });
    return again;
  };

  it("la misma publicación reintentada cuenta cada vez: el cuarto intento del día es MARKETPLACE_DAILY_LIMIT", async () => {
    const s = await setup();
    let publication = await s.publish();
    await s.attempt(publication);
    publication = await retry(s, publication);
    await s.attempt(publication);
    publication = await retry(s, publication);
    await s.attempt(publication);
    await markNotPublished(s.manualDeps, { publicationId: publication.id, actor: "operator" });

    // Aviso temprano en la API (lo que manda es el intento, siguiente test).
    await expect(
      startPublication(s.startDeps, {
        publicationId: publication.id,
        dryRun: false,
        actor: "operator",
      }),
    ).rejects.toMatchObject({ code: "MARKETPLACE_DAILY_LIMIT", retriable: false });
    expect((await s.current(publication.id))?.status).toBe("failed");
  });

  it("el intento revisa el límite también: con el límite cumplido, queda failed sin abrir nada", async () => {
    const s = await setup({ dailyLimit: 1 });
    const publication = await s.publish();
    await s.attempt(publication);
    await markNotPublished(s.manualDeps, { publicationId: publication.id, actor: "operator" });
    // Saltándose la API (como un reintento de la cola), el intento lo frena.
    await s.t.publications.transition(
      publication.id,
      { from: "failed", to: "publishing", changes: { dryRun: false, incrementAttempts: true } },
      { actor: "operator" },
    );

    await expect(s.attempt(publication)).rejects.toMatchObject({
      code: "MARKETPLACE_DAILY_LIMIT",
    });
    expect(s.fake.published).toHaveLength(1);
  });

  it("los intentos de ayer (en Santiago) no cuentan para hoy", async () => {
    let now = new Date("2026-10-09T02:00:00Z"); // 23:00 del 8 en Santiago
    const s = await setup({
      dailyLimit: 1,
      clock: () => now,
      uf: fakeUf([{ date: "2026-10-07", value: "41120.00" }, UF_YESTERDAY, UF_TODAY]).source,
    });
    const publication = await s.publish();
    await s.attempt(publication);

    now = NOW; // 15:00 del 9
    const again = await retry(s, publication);
    await expect(s.attempt(again)).resolves.toMatchObject({ outcome: "awaiting_manual_confirm" });
  });

  it("en simulación no cuenta: con el límite en 1, se simula una y otra vez", async () => {
    const s = await setup({ dryRun: true, dailyLimit: 1 });
    const publication = await s.publish();
    await s.attempt(publication);
    await markNotPublished(s.manualDeps, { publicationId: publication.id, actor: "operator" });
    const { publication: again } = await startPublication(s.startDeps, {
      publicationId: publication.id,
      dryRun: true,
      actor: "operator",
    });

    await expect(s.attempt(again)).resolves.toMatchObject({ outcome: "awaiting_manual_confirm" });
  });

  it("otra publicación de la cuenta esperando el clic: MARKETPLACE_FORM_OPEN en cualquier modo", async () => {
    const s = await setup();
    const first = await s.publish();
    // Otro aviso de la misma cuenta con su formulario esperando (en simulación).
    const other = await s.t.publications.create(
      {
        listingId: "otro-aviso",
        platformAccountId: first.platformAccountId,
        platform: "fb_marketplace",
        format: "post",
        contentId: first.contentId,
        mediaIds: [],
        listingSourceHash: "h",
      },
      { actor: "operator" },
    );
    await s.t.publications.transition(
      other.id,
      { from: "approved", to: "publishing", changes: { dryRun: true, incrementAttempts: true } },
      { actor: "operator" },
    );
    await s.t.publications.transition(
      other.id,
      { from: "publishing", to: "awaiting_manual_confirm" },
      { actor: "system" },
    );

    await expect(s.attempt(first)).rejects.toMatchObject({
      code: "MARKETPLACE_FORM_OPEN",
      retriable: false,
    });
    expect(s.fake.published).toEqual([]);
    await expect(
      startPublication(s.startDeps, { publicationId: first.id, dryRun: false, actor: "operator" }),
    ).rejects.toMatchObject({ code: "MARKETPLACE_FORM_OPEN" });
  });
});

describe("Marketplace · nunca espera sola ante un límite (F6, ADR-0018)", () => {
  it("un error con señal de espera deja la publicación failed, no programada", async () => {
    const s = await setup({
      steps: [
        {
          error: new AppError("MARKETPLACE_UNAVAILABLE", "límite", {
            details: { waitMinutes: 30 },
          }),
        },
      ],
    });
    const publication = await s.publish();

    await expect(s.attempt(publication)).rejects.toMatchObject({ code: "MARKETPLACE_UNAVAILABLE" });
    expect(await s.current(publication.id)).toMatchObject({ status: "failed", scheduledAt: null });
  });
});

describe("Marketplace a mano (F7-T15, ADR-0023)", () => {
  /** Un corredor que no es propio, con la cuenta a mano en vez del perfil. */
  async function byHand(options: Parameters<typeof setup>[0] = {}) {
    const s = await setup(options);
    const listing = await s.t.listings.get(s.t.listingId);
    const brokerId = listing?.brokerId ?? "";
    const broker = await s.t.brokers.setSettings(brokerId, { operatorOwned: false });
    const account = await connectManualMarketplaceAccount(
      {
        brokers: s.t.brokers,
        platformAccounts: s.t.platformAccounts,
        publications: s.t.publications,
        queue: s.t.queue,
        now: () => NOW,
      },
      { broker: broker.slug },
    );
    return { ...s, account, brokerId };
  }

  it.each([false, true])(
    "dryRun %s: llega a awaiting_manual_confirm sin llamar a ningún publisher, con el modo anotado",
    async (dryRun) => {
      const s = await byHand({ dryRun });
      const publication = await s.publish();
      expect(publication.platformAccountId).toBe(s.account.id);

      const result = await s.attempt(publication);
      expect(result.outcome).toBe("awaiting_manual_confirm");
      expect(s.fake.published).toHaveLength(0);
      expect(await s.current(publication.id)).toMatchObject({
        status: "awaiting_manual_confirm",
        dryRun,
        progress: { byHand: true, simulated: dryRun, priceClp: 238_559_452, photos: 2 },
      });
      const attempts = (await s.events(publication.id)).filter(
        (event) => event.type === "publish_attempt",
      );
      expect(attempts.at(-1)?.payload).toMatchObject({
        mode: dryRun ? "dry-run" : "live",
        result: "awaiting_manual_confirm",
        notes: [BY_HAND_NOTE],
      });
    },
  );

  it("sin límite diario: con el tope en 1, publicar otra vez en vivo sigue andando", async () => {
    const s = await byHand({ dailyLimit: 1 });
    const publication = await s.publish();
    await s.attempt(publication);
    await markNotPublished(s.manualDeps, { publicationId: publication.id, actor: "operator" });
    const { publication: again } = await startPublication(s.startDeps, {
      publicationId: publication.id,
      dryRun: false,
      actor: "operator",
    });
    await expect(s.attempt(again)).resolves.toMatchObject({ outcome: "awaiting_manual_confirm" });
    expect(s.fake.published).toHaveLength(0);
  });

  it("confirmar con el enlace y 'No lo publiqué' como en F5", async () => {
    const s = await byHand();
    const publication = await s.publish();
    await s.attempt(publication);
    const { publication: published } = await confirmManualPublication(s.manualDeps, {
      publicationId: publication.id,
      url: ITEM_URL,
      actor: "operator",
    });
    expect(published).toMatchObject({ status: "published", externalId: "123456789" });

    const other = await byHand();
    const second = await other.publish();
    await other.attempt(second);
    await markNotPublished(other.manualDeps, { publicationId: second.id, actor: "operator" });
    expect((await other.current(second.id))?.status).toBe("failed");
  });

  it("varios avisos de la cuenta a mano pueden esperar a la vez (sin 'un formulario a la vez')", async () => {
    const s = await byHand();
    const waitingElsewhere = { id: "otra", platformAccountId: s.account.id };
    const locked = {
      media: s.t.media,
      brokers: s.t.brokers,
      platformAccounts: s.t.platformAccounts,
      publications: {
        listByStatus: async () => [waitingElsewhere as Publication],
        countLiveAttemptsSince: async () => 99,
      },
    };
    const listing = await s.t.listings.get(s.t.listingId);
    if (listing === null) throw new Error("sin aviso");
    const input = {
      listing,
      accountIds: [s.account.id],
      channelIds: [],
      dryRun: false,
      options: { ufConfigured: true, dailyLimit: 3 },
      now: NOW,
    };
    await expect(requireMarketplaceStartable(locked, input)).resolves.toBeUndefined();
    // La misma situación con una cuenta de perfil sí lo impide.
    const profile = {
      ...locked,
      // Un corredor propio, para que el perfil esté permitido y se vea el formulario abierto.
      brokers: {
        findById: async (id: string) => {
          const found = await s.t.brokers.findById(id);
          return found === null ? null : { ...found, operatorOwned: true };
        },
      },
      platformAccounts: {
        get: async () => ({
          ...s.account,
          externalAccountId: "1",
          meta: { userId: "1", connectedAt: "", sessionCheckedAt: "" },
        }),
      },
    };
    await expect(requireMarketplaceStartable(profile, input)).rejects.toMatchObject({
      code: "MARKETPLACE_FORM_OPEN",
    });
  });

  it("una cuenta de perfil de un corredor que no es propio no abre el formulario", async () => {
    const s = await setup();
    const publication = await s.publish();
    const listing = await s.t.listings.get(s.t.listingId);
    await s.t.brokers.setSettings(listing?.brokerId ?? "", { operatorOwned: false });
    await expect(s.attempt(publication, { isLastAttempt: true })).rejects.toMatchObject({
      code: "MARKETPLACE_AUTOMATION_NOT_ALLOWED",
    });
    expect(s.fake.published).toHaveLength(0);
    expect((await s.current(publication.id))?.status).toBe("failed");
  });

  it("en vivo con el worker en simulación: PUBLISH_MODE_MISMATCH, como en F5", async () => {
    const s = await byHand();
    const publication = await s.publish();
    await expect(
      publishPublication(
        { ...s.attemptDeps, workerMode: "dry-run" },
        { publicationId: publication.id, isLastAttempt: true },
      ),
    ).rejects.toMatchObject({ code: "PUBLISH_MODE_MISMATCH" });
    expect(s.fake.published).toHaveLength(0);
  });

  it("con una cuenta de perfil de un corredor que no es propio, pedir publicar ya da 403 (aviso temprano)", async () => {
    const s = await setup();
    const listing = await s.t.listings.get(s.t.listingId);
    await s.t.brokers.setSettings(listing?.brokerId ?? "", { operatorOwned: false });
    await expect(s.publish()).rejects.toMatchObject({ code: "MARKETPLACE_AUTOMATION_NOT_ALLOWED" });
  });

  it("a mano, un título de más de 60 caracteres: PUBLISH_INPUT_INVALID (failed), sin quedar esperando", async () => {
    const s = await byHand();
    const publication = await s.publish();
    const content = await s.t.contents.get(publication.contentId);
    if (content === null) throw new Error("sin texto");
    await expect(
      publishPublication(
        {
          ...s.attemptDeps,
          contents: {
            ...s.t.contents,
            get: async () => ({ ...content, title: "x".repeat(61) }),
          },
        },
        { publicationId: publication.id, isLastAttempt: true },
      ),
    ).rejects.toMatchObject({ code: "PUBLISH_INPUT_INVALID" });
    expect((await s.current(publication.id))?.status).toBe("failed");
  });
});
