import { describe, expect, it } from "vitest";
import type { PublishMode } from "../enums.js";
import { AppError } from "../errors.js";
import { MERCADOLIBRE_REJECTED_AFTER_REFRESH } from "../ports/mercadolibre-auth.js";
import type { PlatformContext, PublishedRef, RemoteStatus } from "../ports/publisher.js";
import type { Publication } from "../publication.js";
import { withDryRun } from "../publish/dry-run.js";
import { structuredCopy } from "../testing/copy.js";
import {
  createFakePublisher,
  createPublicationScenario,
  PORTAL_SCENARIO_TOKENS,
  type PublicationScenario,
} from "../testing/index.js";
import { closePublication } from "./close-publication.js";
import { pausePublication } from "./pause-publication.js";
import type {
  OperationWarning,
  PublicationOperation,
  PublicationOperations,
} from "./publication-operations.js";
import { publishListing } from "./publish-listing.js";
import { resumePublication } from "./resume-publication.js";
import { retirePublication } from "./retire-publication.js";
import { syncPublication, syncTarget } from "./sync-publication.js";

// F4-T17: pausar, reactivar, cerrar y sincronizar en core (spec F4 §4.9).

// La hora real: el token del escenario vence una hora después de crearlo.
const NOW = new Date();
const PORTAL = "portal_inmobiliario";
const ITEM_ID = "MLC1234567890";
const SELLER_CONTACT = {
  contact: "Corredora",
  email: "c@corredor.test",
  countryCode2: "56",
  phone2: "911112222",
};

const status = (value: string, extra: Partial<RemoteStatus> = {}): RemoteStatus => ({
  status: value,
  subStatus: [],
  stopTime: "2027-04-07T12:00:00.000-03:00",
  expirationTime: null,
  ...extra,
});

/** Operaciones de Portal guionadas: cada una responde con `respond` y queda registrada. */
function fakeOperations(
  respond: (
    operation: PublicationOperation | "getStatus",
    ref: PublishedRef,
    ctx: PlatformContext,
  ) => Promise<RemoteStatus> = async (operation) =>
    status({ pause: "paused", resume: "active", close: "closed", getStatus: "active" }[operation]),
) {
  const calls: Array<{ operation: string; ref: PublishedRef; token: string }> = [];
  const make =
    (operation: PublicationOperation | "getStatus") =>
    async (ref: PublishedRef, ctx: PlatformContext) => {
      calls.push({ operation, ref: structuredCopy(ref), token: await ctx.accessToken() });
      return respond(operation, ref, ctx);
    };
  const operations: Required<PublicationOperations> = {
    pause: make("pause"),
    resume: make("resume"),
    close: make("close"),
    getStatus: make("getStatus"),
  };
  return { operations, calls };
}

/** Una publicación de Portal ya publicada (en `live`, con su progreso y el aviso `active`). */
async function setup(
  options: {
    dryRun?: boolean;
    apiMode?: PublishMode;
    operations?: PublicationOperations;
    lockFails?: () => Error | undefined;
  } = {},
) {
  const t = await createPublicationScenario({ platform: PORTAL });
  const dryRun = options.dryRun ?? false;
  const [started] = (
    await publishListing(t.deps, {
      listingId: t.listingId,
      platform: PORTAL,
      dryRun,
      actor: "operator",
    })
  ).started;
  if (started === undefined) throw new Error("falta la publicación");
  if (!dryRun) {
    await t.publications.saveProgress(started.id, {
      pictureIds: ["1-MLC_PIC"],
      sellerContact: SELLER_CONTACT,
      createRequestedAt: NOW.toISOString(),
      itemId: ITEM_ID,
      descriptionDone: true,
    });
    await t.listings.changeStatus(t.listingId, "ready", "active");
  }
  await t.publications.transition(
    started.id,
    {
      from: "publishing",
      to: "published",
      changes: {
        externalId: dryRun ? `dry-run:${started.id}` : ITEM_ID,
        externalUrl: null,
        publishedAt: NOW,
      },
    },
    { actor: "system" },
  );
  const fake = fakeOperations();
  const operations = options.operations ?? fake.operations;
  const asked: string[] = [];
  const warnings: OperationWarning[] = [];
  const deps = {
    ...t.deps,
    lock: {
      run: ((listingId, fn) => {
        const failure = options.lockFails?.();
        if (failure !== undefined) return Promise.reject(failure);
        return t.deps.lock.run(listingId, fn);
      }) as typeof t.deps.lock.run,
    },
    platformAccounts: t.platformAccounts,
    mercadoLibre: null,
    operationsFor: (platform: string) => {
      asked.push(platform);
      return platform === PORTAL ? operations : undefined;
    },
    apiMode: options.apiMode ?? "live",
    now: () => NOW,
    onWarning: (warning: OperationWarning) => warnings.push(warning),
  };
  const current = () => t.publications.all().find((p) => p.id === started.id) as Publication;
  return { t, deps, id: started.id, calls: fake.calls, asked, warnings, current };
}

const syncJobs = (t: PublicationScenario) =>
  t.queue.jobs.filter((job) => job.name === "publication.sync");

/** Otra publicación del mismo aviso, ya publicada (de Instagram, para no chocar con el post de Portal). */
async function otherPublished(t: PublicationScenario, dryRun: boolean): Promise<Publication> {
  const other = await t.publications.create(
    {
      listingId: t.listingId,
      platformAccountId: "cuenta-instagram",
      platform: "instagram",
      format: "post",
      contentId: await t.instagramId(),
      mediaIds: [],
      listingSourceHash: "h",
    },
    { actor: "operator" },
  );
  await t.publications.transition(
    other.id,
    { from: "approved", to: "publishing", changes: { dryRun } },
    { actor: "operator" },
  );
  return t.publications.transition(
    other.id,
    { from: "publishing", to: "published", changes: { externalId: "ig-1" } },
    { actor: "system" },
  );
}

describe("pausar, reactivar y cerrar en live", () => {
  it("pausar llama fuera del candado con el progreso y el token, y guarda paused con lo informado", async () => {
    const { t, deps, id, calls, current } = await setup();

    const result = await pausePublication(deps, { publicationId: id, actor: "operator" });

    expect(calls).toEqual([
      {
        operation: "pause",
        ref: { externalId: ITEM_ID, progress: expect.objectContaining({ itemId: ITEM_ID }) },
        token: PORTAL_SCENARIO_TOKENS.accessToken,
      },
    ]);
    expect(result).toMatchObject({ publication: { status: "paused" }, listingBackToReady: false });
    expect(current().remoteState).toEqual({
      ...status("paused"),
      checkedAt: NOW.toISOString(),
    });
    const [event] = (await t.publications.listEvents(id)).slice(-1);
    expect(event).toMatchObject({
      fromStatus: "published",
      toStatus: "paused",
      actor: "operator",
      payload: { mode: "live", operation: "pause", remote: { status: "paused" } },
    });
    // Pausar no cambia el aviso.
    expect((await t.listings.get(t.listingId))?.status).toBe("active");
  });

  it("reactivar devuelve una pausada a published", async () => {
    const { deps, id } = await setup();
    await pausePublication(deps, { publicationId: id, actor: "operator" });

    await expect(
      resumePublication(deps, { publicationId: id, actor: "cli" }),
    ).resolves.toMatchObject({
      publication: { status: "published", remoteState: { status: "active" } },
    });
  });

  it("cerrar en live pide confirmación (sin llamar); confirmado, cierra y el aviso vuelve a ready", async () => {
    const { t, deps, id, calls, current } = await setup();

    await expect(
      closePublication(deps, { publicationId: id, actor: "operator" }),
    ).rejects.toMatchObject({ code: "CLOSE_NOT_CONFIRMED", retriable: false });
    expect(calls).toEqual([]);
    expect(current().status).toBe("published");

    const result = await closePublication(deps, {
      publicationId: id,
      actor: "operator",
      confirmed: true,
    });

    expect(result).toMatchObject({
      publication: { status: "unpublished" },
      listingBackToReady: true,
    });
    expect((await t.listings.get(t.listingId))?.status).toBe("ready");
  });

  it("cerrar una pausada también vale", async () => {
    const { deps, id } = await setup();
    await pausePublication(deps, { publicationId: id, actor: "operator" });
    await expect(
      closePublication(deps, { publicationId: id, actor: "operator", confirmed: true }),
    ).resolves.toMatchObject({ publication: { status: "unpublished" } });
  });

  it("un estado que la máquina no permite es INVALID_TRANSITION, sin llamar", async () => {
    const { deps, id, calls } = await setup();
    await expect(
      resumePublication(deps, { publicationId: id, actor: "operator" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await pausePublication(deps, { publicationId: id, actor: "operator" });
    await expect(
      pausePublication(deps, { publicationId: id, actor: "operator" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect(calls.map((call) => call.operation)).toEqual(["pause"]);
  });

  it("una publicación de live con la API en dry-run: PUBLISH_MODE_MISMATCH y nada cambia", async () => {
    const { deps, id, calls, asked, current } = await setup({ apiMode: "dry-run" });

    for (const run of [
      () => pausePublication(deps, { publicationId: id, actor: "operator" }),
      () => closePublication(deps, { publicationId: id, actor: "operator", confirmed: true }),
    ]) {
      await expect(run()).rejects.toMatchObject({
        code: "PUBLISH_MODE_MISMATCH",
        retriable: false,
      });
    }
    expect(calls).toEqual([]);
    expect(asked).toEqual([]);
    expect(current().status).toBe("published");
  });

  it("un remote_state que no calza se avisa y el cambio se guarda igual", async () => {
    const fake = fakeOperations(async () => status("paused", { stopTime: "mañana" }));
    const { deps, id, warnings, current } = await setup({ operations: fake.operations });

    await pausePublication(deps, { publicationId: id, actor: "operator" });

    expect(current()).toMatchObject({ status: "paused", remoteState: null });
    expect(warnings).toEqual([
      { publicationId: id, step: "remote_state", code: "PUBLICATION_REMOTE_STATE_INVALID" },
    ]);
  });
});

describe("el modo lo decide la publicación", () => {
  it("dry-run: se cambia en simulación, sin pedir las operaciones ni llamar (cerrar sin confirmar)", async () => {
    const { t, deps, id, calls, asked, current } = await setup({ dryRun: true, apiMode: "live" });

    await pausePublication(deps, { publicationId: id, actor: "operator" });
    await resumePublication(deps, { publicationId: id, actor: "operator" });
    await closePublication(deps, { publicationId: id, actor: "operator" });

    expect(calls).toEqual([]);
    expect(asked).toEqual([]);
    expect(current()).toMatchObject({ status: "unpublished", remoteState: null });
    const last = (await t.publications.listEvents(id)).slice(-1)[0];
    expect(last?.payload).toEqual({ mode: "dry-run", operation: "close" });
  });

  it("live con un publisher envuelto por withDryRun (sin operaciones): PUBLISHER_NOT_CONFIGURED, nunca una simulación", async () => {
    const wrapped = withDryRun(
      createFakePublisher({ platform: PORTAL, formats: ["post"], operations: {} }),
    );
    const { deps, id, current } = await setup({ operations: wrapped });

    await expect(
      pausePublication(deps, { publicationId: id, actor: "operator" }),
    ).rejects.toMatchObject({ code: "PUBLISHER_NOT_CONFIGURED" });
    expect(current().status).toBe("published");
  });

  it("Instagram no se opera desde aquí (OPERATION_NOT_SUPPORTED); Portal no se retira (RETIRE_NOT_SUPPORTED)", async () => {
    const instagram = await createPublicationScenario();
    const [post] = (
      await publishListing(instagram.deps, {
        listingId: instagram.listingId,
        platform: "instagram",
        dryRun: true,
        actor: "operator",
      })
    ).started;
    const { deps, id } = await setup();
    await expect(
      pausePublication(
        { ...deps, publications: instagram.deps.publications },
        { publicationId: post?.id ?? "", actor: "operator" },
      ),
    ).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });

    await expect(
      retirePublication(deps, { publicationId: id, actor: "operator", removedByHand: true }),
    ).rejects.toMatchObject({ code: "RETIRE_NOT_SUPPORTED" });
  });
});

describe("errores de la plataforma", () => {
  it("ML_AUTH_INVALID (también rejected_after_refresh) deja la cuenta expired y no cambia la publicación", async () => {
    const fake = fakeOperations(async () => {
      throw new AppError("ML_AUTH_INVALID", "rechazado otra vez", {
        details: { reason: MERCADOLIBRE_REJECTED_AFTER_REFRESH },
      });
    });
    const { t, deps, id, current } = await setup({ operations: fake.operations });

    await expect(
      pausePublication(deps, { publicationId: id, actor: "operator" }),
    ).rejects.toMatchObject({ code: "ML_AUTH_INVALID" });
    expect(current().status).toBe("published");
    expect((await t.platformAccounts.get(current().platformAccountId))?.status).toBe("expired");
  });

  it("una respuesta perdida (ML_UNAVAILABLE o ML_ABORTED) encola un sync; otro error no", async () => {
    for (const [code, retriable, expectSync] of [
      ["ML_UNAVAILABLE", true, true],
      ["ML_ABORTED", true, true],
      ["ML_ITEM_REJECTED", false, false],
    ] as const) {
      const fake = fakeOperations(async () => {
        throw new AppError(code, "falla", { retriable });
      });
      const { t, deps, id, current } = await setup({ operations: fake.operations });

      await expect(
        closePublication(deps, { publicationId: id, actor: "operator", confirmed: true }),
      ).rejects.toMatchObject({ code });
      expect(current().status).toBe("published");
      expect(syncJobs(t)).toHaveLength(expectSync ? 1 : 0);
    }
  });

  it("Mercado Libre respondió bien y falló guardar: se encola un sync, que lo corrige", async () => {
    let failSave = true;
    const remote = { status: "active" };
    const fake = fakeOperations(async (operation) => {
      if (operation === "pause") remote.status = "paused";
      return status(remote.status);
    });
    const { t, deps, id, current } = await setup({
      operations: fake.operations,
      lockFails: () =>
        failSave ? new AppError("DB_UNAVAILABLE", "sin base", { retriable: true }) : undefined,
    });

    await expect(
      pausePublication(deps, { publicationId: id, actor: "operator" }),
    ).rejects.toMatchObject({ code: "DB_UNAVAILABLE" });
    expect(current().status).toBe("published");
    expect(syncJobs(t).map((job) => job.data)).toEqual([{ publicationId: id }]);

    failSave = false;
    await expect(syncPublication(deps, { publicationId: id })).resolves.toMatchObject({
      outcome: "synced",
      changed: { from: "published", to: "paused" },
    });
    expect(current()).toMatchObject({ status: "paused", remoteState: { status: "paused" } });
  });
});

describe("sincronizar", () => {
  it("la tabla de estados remotos (incluido uno desconocido)", () => {
    const cases: Array<[Publication["status"], string, string[], Publication["status"] | null]> = [
      ["published", "active", [], null],
      ["published", "paused", [], "paused"],
      ["paused", "active", [], "published"],
      ["paused", "paused", [], null],
      ["published", "closed", [], "unpublished"],
      ["paused", "closed", ["expired"], "unpublished"],
      ["published", "closed", ["deleted"], "unpublished"],
      ["published", "paused", ["picture_download_pending"], null],
      ["published", "not_yet_active", ["picture_download_pending"], null],
      ["published", "under_review", [], null],
      ["published", "not_yet_active", [], null],
      ["published", "payment_required", [], null],
      ["paused", "inactive", [], null],
    ];
    for (const [from, remote, subStatus, expected] of cases) {
      expect(syncTarget(from, { status: remote, subStatus }), `${from} + ${remote}`).toBe(expected);
    }
  });

  it("guarda lo leído con un evento sync y, si cambia, el estado con actor system", async () => {
    const fake = fakeOperations(async () =>
      status("paused", {
        reason: { code: "ABANDONED_ITEM_REX_DEN", message: "La reportaron como no disponible" },
      }),
    );
    const { t, deps, id, current } = await setup({ operations: fake.operations });

    await syncPublication(deps, { publicationId: id });

    expect(current()).toMatchObject({
      status: "paused",
      remoteState: { status: "paused", reason: { code: "ABANDONED_ITEM_REX_DEN" } },
    });
    const events = (await t.publications.listEvents(id)).slice(-2);
    expect(events.map((event) => [event.type, event.actor])).toEqual([
      ["sync", "system"],
      ["status_changed", "system"],
    ]);
    expect(events[0]?.payload).toMatchObject({ remote: { status: "paused" } });
  });

  it("solo guarda lo leído si el estado no cambia (activo, en revisión, desconocido)", async () => {
    for (const remote of ["active", "under_review", "payment_required"]) {
      const fake = fakeOperations(async () => status(remote));
      const { deps, id, current } = await setup({ operations: fake.operations });
      await expect(syncPublication(deps, { publicationId: id })).resolves.toMatchObject({
        changed: null,
      });
      expect(current()).toMatchObject({ status: "published", remoteState: { status: remote } });
    }
  });

  it("cerrado en Mercado Libre: unpublished y el aviso vuelve a ready", async () => {
    const fake = fakeOperations(async () => status("closed", { subStatus: ["expired"] }));
    const { t, deps, id } = await setup({ operations: fake.operations });

    await expect(syncPublication(deps, { publicationId: id })).resolves.toMatchObject({
      changed: { from: "published", to: "unpublished" },
      listingBackToReady: true,
    });
    expect((await t.listings.get(t.listingId))?.status).toBe("ready");
  });

  it("un sync que leyó antes de que el operador pausara no deshace la pausa (PUBLICATION_SYNC_STALE)", async () => {
    let operatorPauses: (() => Promise<unknown>) | undefined;
    const fake = fakeOperations(async () => {
      // Mientras se lee Mercado Libre (que todavía dice activo), el operador pausa.
      await operatorPauses?.();
      return status("active");
    });
    const { t, deps, id, current } = await setup({ operations: fake.operations });
    operatorPauses = () =>
      t.publications.transition(
        id,
        { from: "published", to: "paused" },
        { actor: "operator", payload: { mode: "live", operation: "pause" } },
      );

    await expect(syncPublication(deps, { publicationId: id })).rejects.toMatchObject({
      code: "PUBLICATION_SYNC_STALE",
      retriable: true,
    });
    expect(current()).toMatchObject({ status: "paused", remoteState: null });
  });

  it("se salta lo que no corresponde: dry-run, sin publicar, Instagram", async () => {
    const dryRun = await setup({ dryRun: true });
    await expect(syncPublication(dryRun.deps, { publicationId: dryRun.id })).resolves.toMatchObject(
      { outcome: "skipped", reason: "dry_run" },
    );

    const { deps, id, calls } = await setup();
    await closePublication(deps, { publicationId: id, actor: "operator", confirmed: true });
    await expect(syncPublication(deps, { publicationId: id })).resolves.toMatchObject({
      outcome: "skipped",
      reason: "not_published",
    });
    expect(calls.map((call) => call.operation)).toEqual(["close"]);
  });

  it("corre aunque la API esté en dry-run (solo lee)", async () => {
    const { deps, id } = await setup({ apiMode: "dry-run" });
    await expect(syncPublication(deps, { publicationId: id })).resolves.toMatchObject({
      outcome: "synced",
    });
  });

  it("un ML_AUTH_INVALID al sincronizar deja la cuenta expired", async () => {
    const fake = fakeOperations(async () => {
      throw new AppError("ML_AUTH_INVALID", "rechazado otra vez", {
        details: { reason: MERCADOLIBRE_REJECTED_AFTER_REFRESH },
      });
    });
    const { t, deps, id, current } = await setup({ operations: fake.operations });

    await expect(syncPublication(deps, { publicationId: id })).rejects.toMatchObject({
      code: "ML_AUTH_INVALID",
    });
    expect((await t.platformAccounts.get(current().platformAccountId))?.status).toBe("expired");
  });

  it("con la cuenta desconectada no llama: ACCOUNT_NOT_CONNECTED", async () => {
    const { t, deps, id, calls, current } = await setup();
    await t.platformAccounts.disconnect(current().platformAccountId);

    await expect(syncPublication(deps, { publicationId: id })).rejects.toMatchObject({
      code: "ACCOUNT_NOT_CONNECTED",
    });
    expect(calls).toEqual([]);
  });
});

describe("revisión de F4-T17", () => {
  it("cerrar no devuelve el aviso a ready si queda otra publicada en live; una de dry-run no cuenta", async () => {
    const { t, deps, id } = await setup();
    await otherPublished(t, false);
    await expect(
      closePublication(deps, { publicationId: id, actor: "operator", confirmed: true }),
    ).resolves.toMatchObject({ listingBackToReady: false });
    expect((await t.listings.get(t.listingId))?.status).toBe("active");

    const second = await setup();
    await otherPublished(second.t, true);
    await expect(
      closePublication(second.deps, {
        publicationId: second.id,
        actor: "operator",
        confirmed: true,
      }),
    ).resolves.toMatchObject({ listingBackToReady: true });
  });

  it("cerrar una publicación de dry-run no toca el aviso", async () => {
    const { t, deps, id } = await setup({ dryRun: true });
    await t.listings.changeStatus(t.listingId, "ready", "active");
    await expect(
      closePublication(deps, { publicationId: id, actor: "operator" }),
    ).resolves.toMatchObject({ listingBackToReady: false });
    expect((await t.listings.get(t.listingId))?.status).toBe("active");
  });

  it("si un sync ya aplicó lo pedido mientras se llamaba, la operación termina bien (sin INVALID_TRANSITION)", async () => {
    let syncApplies: (() => Promise<unknown>) | undefined;
    const fake = fakeOperations(async () => {
      await syncApplies?.();
      return status("paused");
    });
    const { t, deps, id, current } = await setup({ operations: fake.operations });
    syncApplies = () =>
      t.publications.transition(
        id,
        { from: "published", to: "paused" },
        { actor: "system", payload: { mode: "live", sync: true, remoteStatus: "paused" } },
      );

    await expect(
      pausePublication(deps, { publicationId: id, actor: "operator" }),
    ).resolves.toMatchObject({
      publication: { status: "paused", remoteState: { status: "paused" } },
    });
    expect(current().status).toBe("paused");
    expect(syncJobs(t)).toEqual([]);
  });

  it("una respuesta perdida marca la publicación (un sync en curso queda viejo) y pide el sync en 30 s", async () => {
    const fake = fakeOperations(async () => {
      throw new AppError("ML_UNAVAILABLE", "sin respuesta", { retriable: true });
    });
    const { t, deps, id, current } = await setup({ operations: fake.operations });
    const before = current().updatedAt.getTime();

    await expect(
      pausePublication(deps, { publicationId: id, actor: "operator" }),
    ).rejects.toMatchObject({ code: "ML_UNAVAILABLE" });

    expect(current().updatedAt.getTime()).toBeGreaterThan(before);
    expect(current().status).toBe("published");
    const [job] = syncJobs(t);
    expect(job?.options).toMatchObject({
      singletonKey: id,
      startAfter: new Date(NOW.getTime() + 30_000),
    });
  });

  it("si la cola falla o ya había un sync, se avisa sin cortar", async () => {
    const fake = fakeOperations(async () => {
      throw new AppError("ML_ABORTED", "cortada", { retriable: true });
    });
    for (const [queue, code] of [
      [
        {
          enqueue: async () => {
            throw new AppError("QUEUE_UNAVAILABLE", "sin cola", { retriable: true });
          },
        },
        "QUEUE_UNAVAILABLE",
      ],
      [{ enqueue: async () => null }, "SYNC_ALREADY_QUEUED"],
    ] as const) {
      const { deps, id, warnings } = await setup({ operations: fake.operations });
      await expect(
        pausePublication({ ...deps, queue }, { publicationId: id, actor: "operator" }),
      ).rejects.toMatchObject({ code: "ML_ABORTED" });
      expect(warnings).toContainEqual({ publicationId: id, step: "enqueue_sync", code });
    }
  });

  it("si no se puede marcar la cuenta vencida, se avisa y el error de la plataforma sube igual", async () => {
    const fake = fakeOperations(async () => {
      throw new AppError("ML_AUTH_INVALID", "rechazado otra vez");
    });
    const { deps, id, warnings } = await setup({ operations: fake.operations });
    const platformAccounts = {
      ...deps.platformAccounts,
      changeStatus: async () => {
        throw new AppError("DB_UNAVAILABLE", "sin base", { retriable: true });
      },
    };

    await expect(
      pausePublication({ ...deps, platformAccounts }, { publicationId: id, actor: "operator" }),
    ).rejects.toMatchObject({ code: "ML_AUTH_INVALID" });
    expect(warnings).toContainEqual({
      publicationId: id,
      step: "account_status",
      code: "DB_UNAVAILABLE",
    });
  });

  it("el sync se salta Instagram y la tabla trata las dos grafías de procesar fotos", async () => {
    const { t, deps } = await setup();
    const instagram = await otherPublished(t, false);
    await expect(syncPublication(deps, { publicationId: instagram.id })).resolves.toMatchObject({
      outcome: "skipped",
      reason: "not_supported",
    });
    expect(
      syncTarget("published", { status: "paused", subStatus: ["picture_downloading_pending"] }),
    ).toBeNull();
    expect(
      syncTarget("paused", { status: "paused", subStatus: ["picture_download_pending"] }),
    ).toBeNull();
  });
});
