import { describe, expect, it } from "vitest";
import type { Platform, PublicationStatus, PublishMode } from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import {
  canDoListingAction,
  LISTING_ACTION_FROM,
  LISTING_ACTIONS,
  LISTING_MANUAL_TRANSITIONS,
  listingActionFor,
} from "../listing.js";
import type { NewListing } from "../ports/listing-repository.js";
import type { PlatformContext, PublishedRef, RemoteStatus } from "../ports/publisher.js";
import type { Publication } from "../publication.js";
import { createPublicationScenario, type PublicationScenario } from "../testing/index.js";
import { changeListingStatus } from "./change-listing-status.js";
import type { PublicationOperation, PublicationOperations } from "./publication-operations.js";
import { publishListing } from "./publish-listing.js";

// F6-T08 (spec F6 §4.8, ADR-0019): la propiedad manda sobre sus publicaciones.

// La hora real: el token del escenario vence una hora después de crearlo.
const NOW = new Date();
const PORTAL = "portal_inmobiliario";
const ITEM_ID = "MLC1234567890";
const REMOTE: Record<PublicationOperation | "getStatus", string> = {
  pause: "paused",
  resume: "active",
  close: "closed",
  getStatus: "active",
};

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return isAppError(error) ? error.code : String(error);
  }
  return null;
};

/**
 * Una propiedad con su publicación de Portal publicada (en vivo con su progreso y la propiedad
 * `active`, o simulada y la propiedad `ready`). `onCall` corre dentro de cada llamada a Portal.
 */
async function setup(
  options: {
    dryRun?: boolean;
    apiMode?: PublishMode;
    onCall?: (operation: PublicationOperation) => Promise<void>;
    fail?: AppError | (() => AppError | undefined);
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
      sellerContact: { contact: "C", email: null, countryCode2: "56", phone2: "911112222" },
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
      changes: { externalId: dryRun ? `dry-run:${started.id}` : ITEM_ID, publishedAt: NOW },
    },
    { actor: "system" },
  );
  const calls: string[] = [];
  const make =
    (operation: PublicationOperation | "getStatus") =>
    async (_ref: PublishedRef, _ctx: PlatformContext): Promise<RemoteStatus> => {
      calls.push(operation);
      if (operation !== "getStatus") await options.onCall?.(operation);
      const failure = typeof options.fail === "function" ? options.fail() : options.fail;
      if (failure !== undefined) throw failure;
      return { status: REMOTE[operation], subStatus: [], stopTime: null, expirationTime: null };
    };
  const operations: PublicationOperations = {
    pause: make("pause"),
    resume: make("resume"),
    close: make("close"),
    getStatus: make("getStatus"),
  };
  const deps = {
    ...t.deps,
    platformAccounts: t.platformAccounts,
    mercadoLibre: null,
    operationsFor: (platform: string) => (platform === PORTAL ? operations : undefined),
    apiMode: options.apiMode ?? "live",
    now: () => NOW,
  };
  const find = (id: string) => t.publications.all().find((p) => p.id === id) as Publication;
  return { t, deps, portalId: started.id, calls, find };
}

/** Una publicación de otra cuenta, llevada al estado pedido (simulada salvo `dryRun: false`). */
async function addPublication(
  t: PublicationScenario,
  platform: Platform,
  status: PublicationStatus,
  { dryRun = true }: { dryRun?: boolean } = {},
): Promise<string> {
  const created = await t.publications.create(
    {
      listingId: t.listingId,
      platformAccountId: `cuenta-${platform}-${status}`,
      platform,
      format: "post",
      contentId: await t.portalId(),
      mediaIds: [],
      listingSourceHash: "h",
    },
    { actor: "operator" },
  );
  const id = created.id;
  const move = (from: PublicationStatus, to: PublicationStatus, changes = {}) =>
    t.publications.transition(id, { from, to, changes }, { actor: "system" });
  if (status === "approved") return id;
  if (status === "scheduled") {
    await move("approved", "scheduled", { dryRun, scheduledAt: new Date(NOW.getTime() + 3600e3) });
    return id;
  }
  await move("approved", "publishing", { dryRun });
  if (status === "publishing") return id;
  if (status === "failed") {
    await move("publishing", "failed", {
      lastError: { code: "X", message: "x", retriable: false },
    });
  } else if (status === "awaiting_manual_confirm") {
    await move("publishing", "awaiting_manual_confirm");
  } else if (status === "published") {
    await move("publishing", "published", { externalId: `ext-${id}`, publishedAt: NOW });
  } else {
    throw new Error(`estado no soportado: ${status}`);
  }
  return id;
}

const statusOf = async (t: PublicationScenario) => (await t.listings.get(t.listingId))?.status;

describe("la tabla de acciones de la propiedad", () => {
  it("cada acción sale de sus estados y llega a uno que la tabla manual permite", () => {
    for (const action of LISTING_ACTIONS) {
      for (const from of LISTING_ACTION_FROM[action]) {
        expect(canDoListingAction(action, from)).toBe(true);
      }
    }
    expect(canDoListingAction("resume", "active")).toBe(false);
    expect(canDoListingAction("archive", "active")).toBe(false);
    expect(canDoListingAction("close", "draft")).toBe(false);
    expect(LISTING_MANUAL_TRANSITIONS.active).toEqual(["paused", "closed"]);
  });

  it("la ruta vieja traduce cada estado a su acción", () => {
    expect(listingActionFor("draft", "ready")).toBe("ready");
    expect(listingActionFor("paused", "ready")).toBe("resume");
    expect(listingActionFor("archived", "ready")).toBe("reopen");
    expect(listingActionFor("closed", "ready")).toBe("reopen");
    expect(listingActionFor("active", "paused")).toBe("pause");
    expect(listingActionFor("ready", "archived")).toBe("archive");
    expect(listingActionFor("ready", "ready")).toBeNull();
  });
});

describe("changeListingStatus", () => {
  it("pausar: pausa Portal (marcada por la propiedad), desprograma lo programado y pide confirmar", async () => {
    const { t, deps, portalId, calls, find } = await setup();
    const scheduled = await addPublication(t, "instagram", "scheduled");

    expect(
      await codeOf(
        changeListingStatus(deps, { listingId: t.listingId, action: "pause", actor: "operator" }),
      ),
    ).toBe("LISTING_ACTION_NOT_CONFIRMED");
    expect(calls).toEqual([]);
    expect(find(scheduled).status).toBe("scheduled");

    const result = await changeListingStatus(deps, {
      listingId: t.listingId,
      action: "pause",
      confirmed: true,
      actor: "operator",
    });

    expect(result.listing.status).toBe("paused");
    expect(calls).toEqual(["pause"]);
    expect(find(portalId).status).toBe("paused");
    expect(find(scheduled)).toMatchObject({ status: "approved", scheduledAt: null });
    expect(result.changed.map((p) => p.id).sort()).toEqual([portalId, scheduled].sort());
    expect((await t.publications.listEvents(portalId)).at(-1)).toMatchObject({
      type: "status_changed",
      toStatus: "paused",
      payload: { byListing: true },
    });
    expect(result.manualTasks).toEqual([]);
  });

  it("pausar sin nada que cambiar no pide confirmación", async () => {
    const { t, deps, portalId } = await setup({ dryRun: true, apiMode: "dry-run" });
    await t.publications.transition(
      portalId,
      { from: "published", to: "unpublished" },
      { actor: "operator" },
    );

    const result = await changeListingStatus(deps, {
      listingId: t.listingId,
      action: "pause",
      actor: "operator",
    });
    expect(result.listing.status).toBe("paused");
    expect(result.changed).toEqual([]);
  });

  it("reanudar: solo la de Portal que pausó la propiedad; queda active si sigue en vivo", async () => {
    const { t, deps, portalId, calls, find } = await setup();
    await changeListingStatus(deps, {
      listingId: t.listingId,
      action: "pause",
      confirmed: true,
      actor: "operator",
    });

    const result = await changeListingStatus(deps, {
      listingId: t.listingId,
      action: "resume",
      actor: "operator",
    });

    expect(calls).toEqual(["pause", "resume"]);
    expect(find(portalId).status).toBe("published");
    expect(result.listing.status).toBe("active");
  });

  it("reanudar no toca una pausa hecha a mano, y sin nada en vivo queda ready", async () => {
    const { t, deps, portalId, calls, find } = await setup({ dryRun: true, apiMode: "dry-run" });
    await t.publications.transition(
      portalId,
      { from: "published", to: "paused" },
      { actor: "operator" },
    );
    t.listings.setStatus(t.listingId, "paused");

    const result = await changeListingStatus(deps, {
      listingId: t.listingId,
      action: "resume",
      actor: "operator",
    });

    expect(calls).toEqual([]);
    expect(find(portalId).status).toBe("paused");
    expect(result.listing.status).toBe("ready");
  });

  it("cerrar: pide motivo y confirmación; cierra Portal sin devolver la propiedad a ready, descarta lo pendiente, baja las simulaciones y deja las tareas a mano", async () => {
    const { t, deps, portalId, calls, find } = await setup();
    const approved = await addPublication(t, "instagram", "approved");
    const failed = await addPublication(t, "fb_marketplace", "failed");
    const simulated = await addPublication(t, "instagram", "published");
    const live = await addPublication(t, "fb_marketplace", "published", { dryRun: false });

    expect(
      await codeOf(
        changeListingStatus(deps, { listingId: t.listingId, action: "close", actor: "operator" }),
      ),
    ).toBe("CLOSE_REASON_REQUIRED");
    expect(
      await codeOf(
        changeListingStatus(deps, {
          listingId: t.listingId,
          action: "close",
          reason: "sold",
          actor: "operator",
        }),
      ),
    ).toBe("LISTING_ACTION_NOT_CONFIRMED");

    const result = await changeListingStatus(deps, {
      listingId: t.listingId,
      action: "close",
      reason: "sold",
      confirmed: true,
      actor: "operator",
    });

    expect(calls).toEqual(["close"]);
    expect(result.listing).toMatchObject({ status: "closed", closeReason: "sold" });
    expect(find(portalId).status).toBe("unpublished");
    expect(find(approved).status).toBe("cancelled");
    expect(find(failed).status).toBe("cancelled");
    expect(find(simulated).status).toBe("unpublished");
    expect(find(live).status).toBe("published");
    expect(result.manualTasks.map((p) => p.id)).toEqual([live]);
    expect((await t.publications.listEvents(approved)).at(-1)).toMatchObject({
      toStatus: "cancelled",
      payload: { byListing: true, action: "close" },
    });
  });

  it("reabrir borra el motivo; queda active si le queda algo en vivo", async () => {
    const { t, deps } = await setup();
    await addPublication(t, "fb_marketplace", "published", { dryRun: false });
    await changeListingStatus(deps, {
      listingId: t.listingId,
      action: "close",
      reason: "rented",
      confirmed: true,
      actor: "operator",
    });

    const result = await changeListingStatus(deps, {
      listingId: t.listingId,
      action: "reopen",
      actor: "operator",
    });
    expect(result.listing).toMatchObject({ status: "active", closeReason: null });
  });

  it("una de Portal en vivo con la API en simulación: PUBLISH_MODE_MISMATCH sin cambiar nada", async () => {
    const { t, deps, calls, find } = await setup({ apiMode: "dry-run" });
    const scheduled = await addPublication(t, "instagram", "scheduled");

    expect(
      await codeOf(
        changeListingStatus(deps, {
          listingId: t.listingId,
          action: "pause",
          confirmed: true,
          actor: "operator",
        }),
      ),
    ).toBe("PUBLISH_MODE_MISMATCH");
    expect(calls).toEqual([]);
    expect(find(scheduled).status).toBe("scheduled");
    expect(await statusOf(t)).toBe("active");
  });

  it("espera a lo que se está publicando o espera el clic final", async () => {
    for (const [status, code] of [
      ["publishing", "PUBLICATION_IN_PROGRESS"],
      ["awaiting_manual_confirm", "MANUAL_CONFIRM_PENDING"],
    ] as const) {
      const { t, deps, calls } = await setup();
      await addPublication(t, "fb_marketplace", status);
      for (const action of ["pause", "close", "archive"] as const) {
        expect(
          await codeOf(
            changeListingStatus(deps, {
              listingId: t.listingId,
              action,
              reason: "withdrawn",
              confirmed: true,
              actor: "operator",
            }),
          ),
        ).toBe(action === "archive" ? "INVALID_TRANSITION" : code);
      }
      expect(calls).toEqual([]);
      expect(await statusOf(t)).toBe("active");
    }
  });

  it("archivar con algo publicado en vivo: LISTING_HAS_LIVE_PUBLICATIONS", async () => {
    const { t, deps } = await setup();
    await changeListingStatus(deps, {
      listingId: t.listingId,
      action: "pause",
      confirmed: true,
      actor: "operator",
    });
    expect(
      await codeOf(
        changeListingStatus(deps, {
          listingId: t.listingId,
          action: "archive",
          confirmed: true,
          actor: "operator",
        }),
      ),
    ).toBe("LISTING_HAS_LIVE_PUBLICATIONS");
    expect(await statusOf(t)).toBe("paused");
  });

  it("archivar con algo publicado, aunque sea simulado: 409; después de cerrar, archiva y descarta lo pendiente con confirmación", async () => {
    const { t, deps, portalId, calls, find } = await setup({ dryRun: true, apiMode: "dry-run" });
    const simulated = await addPublication(t, "instagram", "published");

    expect(
      await codeOf(
        changeListingStatus(deps, {
          listingId: t.listingId,
          action: "archive",
          confirmed: true,
          actor: "operator",
        }),
      ),
    ).toBe("LISTING_HAS_LIVE_PUBLICATIONS");

    await changeListingStatus(deps, {
      listingId: t.listingId,
      action: "close",
      reason: "withdrawn",
      confirmed: true,
      actor: "operator",
    });
    expect(find(portalId).status).toBe("unpublished");
    expect(find(simulated).status).toBe("unpublished");
    const pending = await addPublication(t, "fb_marketplace", "scheduled");

    expect(
      await codeOf(
        changeListingStatus(deps, { listingId: t.listingId, action: "archive", actor: "operator" }),
      ),
    ).toBe("LISTING_ACTION_NOT_CONFIRMED");
    const result = await changeListingStatus(deps, {
      listingId: t.listingId,
      action: "archive",
      confirmed: true,
      actor: "operator",
    });

    expect(calls).toEqual([]);
    // Archivar una cerrada conserva el motivo; reabrir lo borra.
    expect(result.listing).toMatchObject({ status: "archived", closeReason: "withdrawn" });
    const reopened = await changeListingStatus(deps, {
      listingId: t.listingId,
      action: "reopen",
      actor: "operator",
    });
    expect(reopened.listing).toMatchObject({ status: "ready", closeReason: null });
    expect(find(pending).status).toBe("cancelled");
  });

  it("archivar sin nada que cambiar no pide confirmación", async () => {
    const { t, deps, portalId } = await setup({ dryRun: true, apiMode: "dry-run" });
    await t.publications.transition(
      portalId,
      { from: "published", to: "unpublished" },
      { actor: "operator" },
    );
    const result = await changeListingStatus(deps, {
      listingId: t.listingId,
      action: "archive",
      actor: "operator",
    });
    expect(result.listing.status).toBe("archived");
  });

  it("dejarla lista exige una foto", async () => {
    const { t, deps } = await setup({ dryRun: true, apiMode: "dry-run" });
    const { externalRef: _r, ...rest } = (await t.listings.get(
      t.listingId,
    )) as unknown as NewListing;
    const bare = await t.listings.create({ ...rest, externalRef: "SIN-FOTO", sourceHash: "x" });

    expect(
      await codeOf(
        changeListingStatus(deps, { listingId: bare.id, action: "ready", actor: "operator" }),
      ),
    ).toBe("INVALID_TRANSITION");

    t.listings.setStatus(t.listingId, "draft");
    const result = await changeListingStatus(deps, {
      listingId: t.listingId,
      action: "ready",
      actor: "operator",
    });
    expect(result.listing.status).toBe("ready");
  });

  it("una acción que no sale de ese estado: INVALID_TRANSITION; una propiedad que no existe: LISTING_NOT_FOUND", async () => {
    const { t, deps } = await setup();
    expect(
      await codeOf(
        changeListingStatus(deps, { listingId: t.listingId, action: "resume", actor: "operator" }),
      ),
    ).toBe("INVALID_TRANSITION");
    expect(
      await codeOf(
        changeListingStatus(deps, { listingId: "no-existe", action: "pause", actor: "operator" }),
      ),
    ).toBe("LISTING_NOT_FOUND");
  });

  it("si Portal falla, la propiedad no cambia (lo programado ya quedó desprogramado)", async () => {
    const { t, deps, find } = await setup({
      fail: new AppError("ML_UNAVAILABLE", "sin red", { retriable: true }),
    });
    const scheduled = await addPublication(t, "instagram", "scheduled");

    expect(
      await codeOf(
        changeListingStatus(deps, {
          listingId: t.listingId,
          action: "pause",
          confirmed: true,
          actor: "operator",
        }),
      ),
    ).toBe("ML_UNAVAILABLE");
    expect(await statusOf(t)).toBe("active");
    expect(find(scheduled).status).toBe("approved");
  });

  it("la fase 3 relee: una pendiente nueva se descarta; una propiedad cambiada aborta", async () => {
    let fresh = "";
    const first = await setup({
      onCall: async () => {
        fresh = await addPublication(first.t, "instagram", "approved");
      },
    });
    await changeListingStatus(first.deps, {
      listingId: first.t.listingId,
      action: "close",
      reason: "withdrawn",
      confirmed: true,
      actor: "operator",
    });
    expect(first.find(fresh).status).toBe("cancelled");
    expect(await statusOf(first.t)).toBe("closed");

    const second = await setup({
      onCall: async () => {
        second.t.listings.setStatus(second.t.listingId, "paused");
      },
    });
    expect(
      await codeOf(
        changeListingStatus(second.deps, {
          listingId: second.t.listingId,
          action: "pause",
          confirmed: true,
          actor: "operator",
        }),
      ),
    ).toBe("INVALID_TRANSITION");
  });

  it("archivar espera a lo que se está publicando o espera el clic final", async () => {
    for (const [status, code] of [
      ["publishing", "PUBLICATION_IN_PROGRESS"],
      ["awaiting_manual_confirm", "MANUAL_CONFIRM_PENDING"],
    ] as const) {
      const { t, deps, portalId } = await setup({ dryRun: true, apiMode: "dry-run" });
      await t.publications.transition(
        portalId,
        { from: "published", to: "unpublished" },
        { actor: "operator" },
      );
      await addPublication(t, "fb_marketplace", status);
      expect(
        await codeOf(
          changeListingStatus(deps, {
            listingId: t.listingId,
            action: "archive",
            confirmed: true,
            actor: "operator",
          }),
        ),
      ).toBe(code);
      expect(await statusOf(t)).toBe("ready");
    }
  });

  it("una falla de Portal se puede repetir; lo ya aplicado se salta", async () => {
    let failures = 1;
    let inFlight = "";
    const s = await setup({
      fail: () =>
        failures-- > 0 ? new AppError("ML_UNAVAILABLE", "sin red", { retriable: true }) : undefined,
      onCall: async () => {
        // En el segundo intento, mientras se llama a Portal, otra empieza a publicarse.
        if (failures === 0 && inFlight === "") {
          inFlight = await addPublication(s.t, "instagram", "publishing");
        }
      },
    });
    const pause = () =>
      changeListingStatus(s.deps, {
        listingId: s.t.listingId,
        action: "pause",
        confirmed: true,
        actor: "operator",
      });

    expect(await codeOf(pause())).toBe("ML_UNAVAILABLE");
    // Portal quedó pausada, pero la fase 3 ve la que se está publicando: 409 y la propiedad igual.
    expect(await codeOf(pause())).toBe("PUBLICATION_IN_PROGRESS");
    expect(s.find(s.portalId).status).toBe("paused");
    expect(await statusOf(s.t)).toBe("active");

    await s.t.publications.transition(
      inFlight,
      {
        from: "publishing",
        to: "failed",
        changes: { lastError: { code: "X", message: "x", retriable: false } },
      },
      { actor: "system" },
    );
    const result = await pause();
    // Portal ya estaba pausada: no se llama de nuevo.
    expect(s.calls).toEqual(["pause", "pause"]);
    expect(result.listing.status).toBe("paused");
    expect(s.find(inFlight).status).toBe("failed");
  });

  it("una de Portal que sale mientras se cierra: INVALID_TRANSITION para repetir", async () => {
    let extra = "";
    const s = await setup({
      dryRun: true,
      apiMode: "dry-run",
    });
    // En simulación no hay llamadas: la publicación nueva aparece entre la fase 1 y la 3 con un
    // candado que la crea al entrar por segunda vez.
    let runs = 0;
    const deps = {
      ...s.deps,
      lock: {
        run: (async (listingId, fn) => {
          runs += 1;
          if (runs === 2) {
            extra = await addPublication(s.t, "portal_inmobiliario", "published");
          }
          return s.deps.lock.run(listingId, fn);
        }) as typeof s.deps.lock.run,
      },
    };
    expect(
      await codeOf(
        changeListingStatus(deps, {
          listingId: s.t.listingId,
          action: "close",
          reason: "sold",
          confirmed: true,
          actor: "operator",
        }),
      ),
    ).toBe("INVALID_TRANSITION");
    expect(s.find(extra).status).toBe("published");
    expect(await statusOf(s.t)).toBe("ready");
  });

  it("lo que la tabla deja igual: pausar y reanudar no tocan approved, failed, Portal pausada a mano ni Instagram en vivo", async () => {
    const { t, deps, portalId, find } = await setup({ dryRun: true, apiMode: "dry-run" });
    await t.publications.transition(
      portalId,
      { from: "published", to: "paused" },
      { actor: "operator" },
    );
    const approved = await addPublication(t, "instagram", "approved");
    const failed = await addPublication(t, "fb_marketplace", "failed");
    const live = await addPublication(t, "instagram", "published", { dryRun: false });
    const before = () => [approved, failed, live, portalId].map((id) => find(id).status);
    const statuses = before();

    await changeListingStatus(deps, {
      listingId: t.listingId,
      action: "pause",
      confirmed: true,
      actor: "operator",
    });
    expect(before()).toEqual(statuses);
    const scheduled = await addPublication(t, "fb_marketplace", "scheduled");

    const resumed = await changeListingStatus(deps, {
      listingId: t.listingId,
      action: "resume",
      actor: "operator",
    });
    expect(before()).toEqual(statuses);
    expect(find(scheduled).status).toBe("scheduled");
    // Instagram sigue en vivo: la propiedad queda activa.
    expect(resumed.listing.status).toBe("active");
  });

  it("cerrar cierra también una de Portal pausada", async () => {
    const { t, deps, portalId, calls, find } = await setup();
    await t.publications.transition(
      portalId,
      { from: "published", to: "paused" },
      { actor: "operator" },
    );
    await changeListingStatus(deps, {
      listingId: t.listingId,
      action: "close",
      reason: "rented",
      confirmed: true,
      actor: "operator",
    });
    expect(calls).toEqual(["close"]);
    expect(find(portalId).status).toBe("unpublished");
    expect(await statusOf(t)).toBe("closed");
  });
});
