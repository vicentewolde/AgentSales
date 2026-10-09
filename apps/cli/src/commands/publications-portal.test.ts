import {
  AppError,
  type PlatformContext,
  type Publication,
  type PublicationOperations,
  type PublishMode,
  publishListing,
  type RemoteStatus,
} from "@agentsales/core";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicationHarness } from "../../test/harness.js";
import {
  register,
  runPublicationOperation,
  runPublications,
  runRetirePublication,
  runSyncPublication,
} from "./publications.js";

// F4-T20: pausar, reactivar, cerrar y actualizar un aviso de Portal desde la CLI (spec F4 §4.12),
// sobre la API real en proceso con operaciones dobles (nunca Mercado Libre).

const PORTAL = "portal_inmobiliario";
const ITEM_URL = "https://www.portalinmobiliario.com/MLC-1234567890";

const status = (value: string, extra: Partial<RemoteStatus> = {}): RemoteStatus => ({
  status: value,
  subStatus: [],
  stopTime: "2027-04-07T09:00:00.000-03:00",
  expirationTime: null,
  ...extra,
});

/** Operaciones de Portal guionadas: cada llamada se registra. */
function fakeOperations(
  respond: (operation: string) => Promise<RemoteStatus> = async (operation) =>
    status({ pause: "paused", resume: "active", close: "closed" }[operation] ?? "active"),
) {
  const calls: string[] = [];
  const make = (operation: string) => async (_ref: unknown, ctx: PlatformContext) => {
    await ctx.accessToken();
    calls.push(operation);
    return respond(operation);
  };
  const operations: PublicationOperations = {
    pause: make("pause"),
    resume: make("resume"),
    close: make("close"),
    getStatus: make("getStatus"),
  };
  return { operations, calls };
}

async function setup(
  options: {
    publishMode?: PublishMode;
    operations?: PublicationOperations;
    beforeRequest?: (url: string, method: string) => void;
    afterResponse?: (url: string, method: string, response: Response) => Response;
  } = {},
) {
  const fake = fakeOperations();
  const { h, t } = await publicationHarness({
    platform: PORTAL,
    publishMode: options.publishMode ?? "live",
    operations: options.operations ?? fake.operations,
    ...(options.beforeRequest === undefined ? {} : { beforeRequest: options.beforeRequest }),
    ...(options.afterResponse === undefined ? {} : { afterResponse: options.afterResponse }),
  });
  return { h, t, calls: fake.calls };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const deps = (
  { h }: Pick<Setup, "h">,
  confirm: (question: string) => Promise<boolean> = async () => {
    throw new Error("no debía preguntar");
  },
) => ({ ...h.io, client: h.client, confirm });

/** El aviso de Portal publicado (en vivo o en simulación), como lo deja el worker. */
async function published(t: Setup["t"], dryRun: boolean): Promise<Publication> {
  const [started] = (
    await publishListing(t.deps, { listingId: t.listingId, platform: PORTAL, dryRun, actor: "cli" })
  ).started;
  if (started === undefined) throw new Error("falta la publicación");
  if (!dryRun) await t.listings.changeStatus(t.listingId, "ready", "active");
  return t.publications.transition(
    started.id,
    {
      from: "publishing",
      to: "published",
      changes: {
        externalId: dryRun ? `dry-run:${started.id}` : "MLC1234567890",
        ...(dryRun ? {} : { externalUrl: ITEM_URL }),
      },
    },
    { actor: "system" },
  );
}

const externalRefOf = async (t: Setup["t"]) => (await t.listings.get(t.listingId))?.externalRef;

describe("publications pause, resume y close", () => {
  it("en vivo pausa, reactiva y cierra con confirmación, y muestra el estado en Mercado Libre", async () => {
    const { h, t, calls } = await setup();
    const publication = await published(t, false);
    const questions: string[] = [];
    const confirm = async (question: string) => {
      questions.push(question);
      return true;
    };

    expect(await runPublicationOperation(deps({ h }), "pause", publication.id)).toBe(0);
    expect(h.text()).toContain("✓ aviso de Portal Inmobiliario pausado: pausada (en vivo)");
    expect(h.text()).toContain("En Mercado Libre: pausado · vence 2027-04-07");

    expect(await runPublicationOperation(deps({ h }), "resume", publication.id)).toBe(0);
    expect(h.text()).toContain("✓ aviso de Portal Inmobiliario reactivado: publicada (en vivo)");
    expect(h.text()).toContain("En Mercado Libre: activo");

    expect(await runPublicationOperation(deps({ h }, confirm), "close", publication.id)).toBe(0);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("¿Cerrar de verdad el aviso de Portal Inmobiliario");
    expect(questions[0]).toContain(ITEM_URL);
    expect(questions[0]).toContain("Es irreversible");
    expect(h.text()).toContain("✓ aviso de Portal Inmobiliario cerrado: retirada (en vivo)");
    expect(h.text()).toContain("En Mercado Libre: cerrado");
    expect(h.text()).toContain("la propiedad volvió a lista");
    expect(h.text()).not.toContain("Simulación");

    expect(calls).toEqual(["pause", "resume", "close"]);
    const events = await t.publications.listEvents(publication.id);
    expect(events.filter((event) => event.type === "status_changed").at(-1)).toMatchObject({
      toStatus: "unpublished",
      actor: "cli",
    });
  });

  it("si Mercado Libre informa un motivo de pausa, lo muestra debajo del estado", async () => {
    const fake = fakeOperations(async () =>
      status("paused", {
        reason: {
          code: "PAUSED_PREVENTION_PRICE",
          message: "Mercado Libre la pausó por el precio",
        },
      }),
    );
    const { h, t } = await setup({ operations: fake.operations });
    const publication = await published(t, false);

    expect(await runPublicationOperation(deps({ h }), "pause", publication.id)).toBe(0);
    expect(h.text()).toContain(
      "  En Mercado Libre: pausado por Mercado Libre · vence 2027-04-07\n  Mercado Libre la pausó por el precio",
    );
  });

  it("cerrar en vivo sin confirmar no llama a Mercado Libre ni cambia nada", async () => {
    const { h, t, calls } = await setup();
    const publication = await published(t, false);

    const code = await runPublicationOperation(
      deps({ h }, async () => false),
      "close",
      publication.id,
    );

    expect(code).toBe(1);
    expect(h.errors()).toContain("No se cerró: confirma en la terminal o usa --yes");
    expect(calls).toEqual([]);
    expect(h.requests.some((request) => request.startsWith("POST"))).toBe(false);
    expect((await t.publications.get(publication.id))?.status).toBe("published");
  });

  it("una pausada en vivo también pregunta; una fallida o una de Instagram no (la API explica)", async () => {
    const paused = await setup();
    const publication = await published(paused.t, false);
    await paused.t.publications.transition(
      publication.id,
      { from: "published", to: "paused" },
      { actor: "system" },
    );
    const questions: string[] = [];
    expect(
      await runPublicationOperation(
        deps(paused, async (question) => {
          questions.push(question);
          return false;
        }),
        "close",
        publication.id,
      ),
    ).toBe(1);
    expect(questions).toHaveLength(1);
    expect(paused.calls).toEqual([]);

    const failed = await setup();
    const id = failed.t.publications.all()[0]?.id ?? "";
    await failed.t.publications.transition(
      id,
      { from: "approved", to: "publishing", changes: { dryRun: false, incrementAttempts: true } },
      { actor: "system" },
    );
    await failed.t.publications.transition(
      id,
      {
        from: "publishing",
        to: "failed",
        changes: { lastError: { code: "X", message: "x", retriable: false } },
      },
      { actor: "system" },
    );
    expect(await runPublicationOperation(deps(failed), "close", id)).toBe(1);
    expect(failed.h.errors()).toContain("INVALID_TRANSITION");

    const instagram = await publicationHarness();
    const post = instagram.t.byFormat("post")?.id ?? "";
    await instagram.t.publications.transition(
      post,
      { from: "approved", to: "publishing", changes: { dryRun: false, incrementAttempts: true } },
      { actor: "system" },
    );
    await instagram.t.publications.transition(
      post,
      { from: "publishing", to: "published", changes: { externalId: "1789" } },
      { actor: "system" },
    );
    expect(await runPublicationOperation(deps(instagram), "close", post)).toBe(1);
    expect(instagram.h.errors()).toContain("OPERATION_NOT_SUPPORTED");
  });

  it("--yes cierra en vivo sin preguntar (manda confirmed)", async () => {
    const { h, t, calls } = await setup();
    const publication = await published(t, false);

    expect(await runPublicationOperation(deps({ h }), "close", publication.id, { yes: true })).toBe(
      0,
    );
    expect(calls).toEqual(["close"]);
    expect((await t.publications.get(publication.id))?.status).toBe("unpublished");
  });

  it("en simulación no pregunta ni llama a Mercado Libre, y lo dice", async () => {
    const { h, t, calls } = await setup({ publishMode: "dry-run" });
    const publication = await published(t, true);

    expect(await runPublicationOperation(deps({ h }), "close", publication.id)).toBe(0);
    expect(h.text()).toContain("cerrado: retirada (simulación)");
    expect(h.text()).toContain("Simulación: no se cambió nada en Mercado Libre");
    expect(calls).toEqual([]);
  });

  it("una en vivo con la API en simulación: PUBLISH_MODE_MISMATCH con qué hacer", async () => {
    const { h, t, calls } = await setup({ publishMode: "dry-run" });
    const publication = await published(t, false);

    expect(await runPublicationOperation(deps({ h }), "pause", publication.id)).toBe(1);
    expect(h.errors()).toContain("PUBLISH_MODE_MISMATCH");
    expect(h.errors()).toContain("PUBLISH_MODE=live pnpm dev");
    expect(calls).toEqual([]);
  });

  it("si la API no responde en 30 s, no reintenta: dice que pudo aplicarse y cómo revisarlo", async () => {
    const cases = [
      ["pause", "La pausa"],
      ["resume", "La reactivación"],
      ["close", "El cierre"],
    ] as const;
    for (const [operation, noun] of cases) {
      const { h, t } = await setup({
        beforeRequest: (url, method) => {
          if (method === "POST" && url.endsWith(`/${operation}`)) {
            throw new DOMException("se acabó el tiempo", "TimeoutError");
          }
        },
      });
      const publication = await published(t, false);
      if (operation === "resume") {
        await t.publications.transition(
          publication.id,
          { from: "published", to: "paused" },
          { actor: "system" },
        );
      }

      expect(
        await runPublicationOperation(deps({ h }), operation, publication.id, { yes: true }),
        operation,
      ).toBe(1);
      const errors = h.errors();
      expect(errors).toContain("OPERATION_UNCONFIRMED");
      expect(errors).toContain(`${noun} pudo haberse aplicado en Mercado Libre`);
      expect(errors).toContain("sin respuesta en 30 s");
      expect(errors).toContain("No lo repitas todavía");
      expect(errors).toContain(`agentsales publications ${await externalRefOf(t)}`);
      expect(errors).toContain(`agentsales publications sync ${publication.id}`);
      expect(errors).not.toContain("Levántala con pnpm dev");
      expect(h.requests.filter((request) => request.endsWith(`/${operation}`))).toHaveLength(1);
    }
  });

  it("si la respuesta se corta cuando la API ya cerró el aviso, lo dice sin reintentar", async () => {
    const { h, t, calls } = await setup({
      afterResponse: (url, method, response) => {
        if (method !== "POST" || !url.endsWith("/close")) return response;
        Object.defineProperty(response, "json", {
          value: async () => {
            throw new DOMException("se acabó el tiempo", "TimeoutError");
          },
        });
        return response;
      },
    });
    const publication = await published(t, false);

    expect(await runPublicationOperation(deps({ h }), "close", publication.id, { yes: true })).toBe(
      1,
    );
    expect(h.errors()).toContain("El cierre pudo haberse aplicado en Mercado Libre");
    expect(h.errors()).toContain("la API dejó de responder a mitad de la respuesta");
    // El cambio sí se aplicó: por eso no se repite solo.
    expect((await t.publications.get(publication.id))?.status).toBe("unpublished");
    expect(calls).toEqual(["close"]);
    expect(h.requests.filter((request) => request.endsWith("/close"))).toHaveLength(1);
  });

  it("una conexión cortada también es no confirmada; ECONNREFUSED no (el pedido no llegó)", async () => {
    const reset = await setup({
      beforeRequest: (url, method) => {
        if (method === "POST" && url.endsWith("/pause")) {
          throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
        }
      },
    });
    const first = await published(reset.t, false);
    expect(await runPublicationOperation(deps(reset), "pause", first.id)).toBe(1);
    expect(reset.h.errors()).toContain("OPERATION_UNCONFIRMED");
    expect(reset.h.errors()).toContain("ECONNRESET");

    const refused = await setup({
      beforeRequest: (url, method) => {
        if (method === "POST" && url.endsWith("/pause")) {
          throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
        }
      },
    });
    const second = await published(refused.t, false);
    expect(await runPublicationOperation(deps(refused), "pause", second.id)).toBe(1);
    expect(refused.h.errors()).not.toContain("OPERATION_UNCONFIRMED");
    expect(refused.h.errors()).toContain("La API no responde");
  });

  it("los errores de Mercado Libre llegan con qué hacer en la CLI (sin el botón del panel)", async () => {
    const cases: Array<[AppError, string]> = [
      [
        new AppError("ML_ABORTED", "Se cortó la llamada a Mercado Libre", { retriable: true }),
        "En un momento, mira el estado con agentsales publications",
      ],
      [
        new AppError("ML_AUTH_INVALID", "El acceso de Mercado Libre no es válido"),
        "agentsales accounts connect mercadolibre --broker <slug>",
      ],
    ];
    for (const [error, hint] of cases) {
      const fake = fakeOperations(async () => {
        throw error;
      });
      const { h, t } = await setup({ operations: fake.operations });
      const publication = await published(t, false);

      expect(await runPublicationOperation(deps({ h }), "pause", publication.id), error.code).toBe(
        1,
      );
      expect(h.errors()).toContain(error.code);
      expect(h.errors()).toContain(hint);
      expect(h.errors()).not.toContain("(Actualizar)");
    }
  });

  it("reactivar una publicada es INVALID_TRANSITION con el comando para ver su estado", async () => {
    const { h, t, calls } = await setup();
    const publication = await published(t, false);

    expect(await runPublicationOperation(deps({ h }), "resume", publication.id)).toBe(1);
    expect(h.errors()).toContain("INVALID_TRANSITION");
    expect(h.errors()).toContain(
      `Mira su estado con agentsales publications ${await externalRefOf(t)}`,
    );
    expect(calls).toEqual([]);
  });

  it("una de Instagram no se pausa: OPERATION_NOT_SUPPORTED, con retire como salida", async () => {
    const { h, t } = await publicationHarness();
    const id = t.byFormat("post")?.id ?? "";

    expect(await runPublicationOperation(deps({ h }), "pause", id)).toBe(1);
    expect(h.errors()).toContain("OPERATION_NOT_SUPPORTED");
    expect(h.errors()).toContain("agentsales publications retire <id>");
  });

  it("un id que no es uuid se rechaza sin llamar a la API", async () => {
    const { h } = await setup();

    expect(await runPublicationOperation(deps({ h }), "close", "P-001")).toBe(1);
    expect(h.errors()).toContain("PUBLICATION_ID_INVALID");
    expect(h.requests).toEqual([]);
  });
});

describe("publications sync", () => {
  it("pide la lectura (queda en cola) y, si ya había una, dice que ya está programada", async () => {
    const { h, t } = await setup();
    const publication = await published(t, false);

    expect(await runSyncPublication(deps({ h }), publication.id)).toBe(0);
    expect(h.text()).toContain(
      "✓ Se pidió leer el estado del aviso de Portal Inmobiliario en Mercado Libre",
    );
    expect(h.errors()).toContain(`agentsales publications ${await externalRefOf(t)}`);
    expect(t.queue.jobs.filter((job) => job.name === "publication.sync")).toHaveLength(1);

    vi.spyOn(t.deps.queue, "enqueue").mockResolvedValueOnce(null);
    expect(await runSyncPublication(deps({ h }), publication.id)).toBe(0);
    expect(h.text()).toContain(
      "✓ Ya hay una lectura programada del aviso de Portal Inmobiliario en Mercado Libre",
    );
  });

  it("si la API no contesta, no se sabe si quedó pedida: sugiere mirar o repetirla", async () => {
    const { h, t } = await setup({
      beforeRequest: (url, method) => {
        if (method === "POST" && url.endsWith("/sync")) {
          throw new DOMException("se acabó el tiempo", "TimeoutError");
        }
      },
    });
    const publication = await published(t, false);

    expect(await runSyncPublication(deps({ h }), publication.id)).toBe(1);
    expect(h.errors()).toContain("OPERATION_UNCONFIRMED: No se supo si la lectura quedó pedida");
    expect(h.errors()).not.toContain("pudo haberse aplicado");
    expect(h.errors()).toContain(`o repite agentsales publications sync ${publication.id}`);
  });

  it("una en simulación no tiene nada que leer: PUBLICATION_NOT_PUBLISHED", async () => {
    const { h, t } = await setup({ publishMode: "dry-run" });
    const publication = await published(t, true);

    expect(await runSyncPublication(deps({ h }), publication.id)).toBe(1);
    expect(h.errors()).toContain("PUBLICATION_NOT_PUBLISHED");
    expect(t.queue.jobs.filter((job) => job.name === "publication.sync")).toEqual([]);
  });
});

describe("publications con Portal", () => {
  it("muestra el estado en Mercado Libre, el vencimiento y el motivo si la pausó Mercado Libre", async () => {
    const { h, t } = await setup();
    const publication = await published(t, false);
    await t.publications.transition(
      publication.id,
      { from: "published", to: "paused" },
      { actor: "system", payload: { mode: "live", sync: true, remoteStatus: "paused" } },
    );
    const remote = {
      ...status("paused", {
        reason: {
          code: "PAUSED_PREVENTION_PRICE",
          message: "Mercado Libre la pausó por el precio",
        },
      }),
      checkedAt: new Date().toISOString(),
    };
    await t.publications.setRemoteState(publication.id, remote, {
      type: "sync",
      actor: "system",
      payload: { remote },
    });

    expect(await runPublications(deps({ h }), t.listingId, { events: true })).toBe(0);
    const text = h.text();
    expect(text).toContain("EN MERCADO LIBRE");
    expect(text).toMatch(
      /aviso\s+pausada\s+en vivo\s+\d+\s+pausado por Mercado Libre\s+2027-04-07/,
    );
    expect(text).toContain(`${publication.id}: Mercado Libre la pausó por el precio`);
    expect(text).toContain("publicada → pausada · leído de Mercado Libre: pausado");
    expect(text).toContain("sistema  lectura de Mercado Libre");
  });

  it("retirar un aviso de Portal no pregunta: la API dice que se cierra", async () => {
    const { h, t } = await setup();
    const publication = await published(t, false);

    expect(await runRetirePublication(deps({ h }), publication.id)).toBe(1);
    expect(h.errors()).toContain("RETIRE_NOT_SUPPORTED");
    expect(h.errors()).toContain(`agentsales publications close ${publication.id}`);
    expect((await t.publications.get(publication.id))?.status).toBe("published");
  });
});

describe("publications pause|resume|close|sync · registro en commander", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("cada subcomando llega a su operación; close acepta --yes", async () => {
    const { h, t, calls } = await setup();
    const publication = await published(t, false);
    const program = new Command().exitOverride();
    register(program, {
      ...h.io,
      api: () => h.client,
      cwd: ".",
      confirm: async () => {
        throw new Error("no debía preguntar");
      },
      stdinIsTty: () => false,
      readStdin: async () => "",
      openUrl: () => {},
    });

    for (const args of [
      ["publications", "pause", publication.id],
      ["publications", "resume", publication.id],
      ["publications", "sync", publication.id],
      ["publications", "close", publication.id, "--yes"],
    ]) {
      await program.parseAsync(args, { from: "user" });
      expect(process.exitCode, args.join(" ")).toBe(0);
    }
    expect(calls).toEqual(["pause", "resume", "close"]);
    expect(t.queue.jobs.filter((job) => job.name === "publication.sync")).toHaveLength(1);
  });
});
