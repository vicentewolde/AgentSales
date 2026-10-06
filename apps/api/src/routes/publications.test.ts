import { randomUUID } from "node:crypto";
import { AppError, type PublishMode } from "@agentsales/core";
import { createPublicationScenario, PUBLICATION_SCENARIO_TOKEN } from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import {
  CLIENT_HEADER,
  contentApproveResponseSchema,
  contentUnapproveResponseSchema,
  errorBodySchema,
  listingPublicationsResponseSchema,
  listingPublishResponseSchema,
  publicationEventsResponseSchema,
  publicationPublishResponseSchema,
  publicationResponseSchema,
  publicationRetireResponseSchema,
} from "../contracts/index.js";
import { testDeps } from "../testing/index.js";

const json = { "Content-Type": "application/json" };

/** Un aviso preparado con la cuenta de Instagram conectada (escenario de core) y la API sobre él. */
async function setup(
  options: {
    approve?: boolean;
    account?: boolean;
    publishMode?: PublishMode;
    queueFails?: () => AppError | undefined;
  } = {},
) {
  const t = await createPublicationScenario({
    nextId: randomUUID,
    approve: options.approve ?? true,
    account: options.account ?? true,
    ...(options.queueFails === undefined ? {} : { queueFails: options.queueFails }),
  });
  const app = createApp(
    testDeps({
      listings: t.listings,
      brokers: t.brokers,
      media: t.media,
      fieldDefinitions: t.fieldDefinitions,
      storage: t.storage,
      contents: t.contents,
      contentRuns: t.contentRuns,
      platformAccounts: t.platformAccounts,
      publications: t.publications,
      lock: t.deps.lock,
      queue: t.deps.queue,
      publishMode: options.publishMode ?? "dry-run",
    }),
  );
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    app.request(path, {
      method: "POST",
      headers: { ...json, ...headers },
      body: JSON.stringify(body),
    });
  const errorOf = async (response: Response) =>
    errorBodySchema.parse(await response.json()).error.code;
  return { t, app, post, errorOf };
}

describe("POST /contents/:id/approve y /unapprove", () => {
  it("aprueba el texto: nacen el carrusel y el reel en approved, con actor operator en la bitácora", async () => {
    const { t, app, post } = await setup({ approve: false });
    const contentId = await t.instagramId();

    const response = await post(`/contents/${contentId}/approve`);

    expect(response.status).toBe(200);
    const body = contentApproveResponseSchema.parse(await response.json());
    expect(body.content).toMatchObject({ id: contentId, status: "approved" });
    expect(body.created.map((publication) => publication.format).sort()).toEqual(["post", "reel"]);
    expect(body.created.every((publication) => publication.status === "approved")).toBe(true);
    expect(body.skipped).toEqual([]);
    expect(body.publications).toHaveLength(2);
    const [first] = body.created;
    const events = publicationEventsResponseSchema.parse(
      await (await app.request(`/publications/${first?.id}/events`)).json(),
    ).events;
    expect(events).toEqual([
      expect.objectContaining({
        type: "status_changed",
        fromStatus: null,
        toStatus: "approved",
        actor: "operator",
      }),
    ]);
  });

  it("la CLI se identifica con su cabecera y queda como actor cli", async () => {
    const { t, app, post } = await setup({ approve: false });
    const contentId = await t.instagramId();

    const body = contentApproveResponseSchema.parse(
      await (await post(`/contents/${contentId}/approve`, {}, { [CLIENT_HEADER]: "cli" })).json(),
    );

    const events = publicationEventsResponseSchema.parse(
      await (await app.request(`/publications/${body.created[0]?.id}/events`)).json(),
    ).events;
    expect(events[0]?.actor).toBe("cli");
  });

  it("quitar la aprobación deja el texto en edited y descarta las publicaciones; repetirlo es 409", async () => {
    const { t, post, errorOf } = await setup();
    const contentId = await t.instagramId();

    const response = await post(`/contents/${contentId}/unapprove`);

    expect(response.status).toBe(200);
    const body = contentUnapproveResponseSchema.parse(await response.json());
    expect(body.content.status).toBe("edited");
    expect(body.cancelled.map((publication) => publication.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    const again = await post(`/contents/${contentId}/unapprove`);
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toBe("CONTENT_NOT_APPROVED");
  });

  it("errores: texto inexistente 404, id que no es uuid 400, corrida activa 409", async () => {
    const { t, post, errorOf } = await setup({ approve: false });
    const contentId = await t.instagramId();
    await t.contentRuns.create({ listingId: t.listingId, texts: true });

    const cases: [Response, number, string][] = [
      [await post(`/contents/${randomUUID()}/approve`), 404, "CONTENT_NOT_FOUND"],
      [await post("/contents/no-es-uuid/approve"), 400, "REQUEST_INVALID"],
      [await post(`/contents/${contentId}/approve`), 409, "CONTENT_RUN_ACTIVE"],
    ];
    for (const [response, status, code] of cases) {
      expect(response.status).toBe(status);
      expect(await errorOf(response)).toBe(code);
    }
  });
});

describe("GET /listings/:id/publications", () => {
  it("lista las publicaciones con sus miniaturas firmadas, sin progress ni externalId", async () => {
    const { t, app } = await setup();

    const response = await app.request(`/listings/${t.listingId}/publications`);

    expect(response.status).toBe(200);
    const raw = (await response.json()) as { publications: Record<string, unknown>[] };
    const { publications } = listingPublicationsResponseSchema.parse(raw);
    expect(publications.map((publication) => publication.format).sort()).toEqual(["post", "reel"]);
    for (const publication of publications) {
      expect(publication.media.length).toBe(publication.mediaIds.length);
      expect(publication.media.every((media) => media.url.startsWith("memory://"))).toBe(true);
    }
    for (const publication of raw.publications) {
      expect(publication).not.toHaveProperty("progress");
      expect(publication).not.toHaveProperty("externalId");
    }
  });

  it("un medio que ya no está (una corrida posterior lo cambió) se omite", async () => {
    const { t } = await setup();
    const post = t.byFormat("post");
    const [gone] = post?.mediaIds ?? [];
    const { publications } = listingPublicationsResponseSchema.parse(
      await (
        await createApp(
          testDeps({
            listings: t.listings,
            media: {
              ...t.media,
              listByListing: async (id) =>
                (await t.media.listByListing(id)).filter((media) => media.id !== gone),
            },
            publications: t.publications,
            storage: t.storage,
          }),
        ).request(`/listings/${t.listingId}/publications`)
      ).json(),
    );
    const listed = publications.find((publication) => publication.id === post?.id);
    expect(listed?.media.map((media) => media.id)).not.toContain(gone);
    expect(listed?.media).toHaveLength((post?.mediaIds.length ?? 0) - 1);
  });

  it("un aviso que no existe es 404", async () => {
    const { app, errorOf } = await setup();
    const response = await app.request(`/listings/${randomUUID()}/publications`);
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toBe("LISTING_NOT_FOUND");
  });
});

describe("POST /listings/:id/publish", () => {
  it("en dry-run pasa las dos a publishing simuladas y las encola; el modo del cuerpo se ignora", async () => {
    const { t, post } = await setup();

    const response = await post(`/listings/${t.listingId}/publish`, {
      platform: "instagram",
      dryRun: false,
    });

    expect(response.status).toBe(202);
    const body = listingPublishResponseSchema.parse(await response.json());
    expect(body.started).toHaveLength(2);
    expect(body.started.every((p) => p.status === "publishing" && p.dryRun)).toBe(true);
    expect(body.requeued).toEqual([]);
    expect(t.queue.jobs.map((job) => job.name)).toEqual([
      "publication.publish",
      "publication.publish",
    ]);

    // Publicar otra vez reencola las que siguen en curso, sin cambiarlas.
    const again = listingPublishResponseSchema.parse(
      await (await post(`/listings/${t.listingId}/publish`, { platform: "instagram" })).json(),
    );
    expect(again.started).toEqual([]);
    expect(again.requeued).toHaveLength(2);
  });

  it("con PUBLISH_MODE=live la API las pide en vivo", async () => {
    const { t, post } = await setup({ publishMode: "live" });

    const body = listingPublishResponseSchema.parse(
      await (await post(`/listings/${t.listingId}/publish`, { platform: "instagram" })).json(),
    );

    expect(body.started.every((p) => p.dryRun === false)).toBe(true);
  });

  it("errores: canal inválido 400, sin texto aprobado 409, sin cuenta 409, aviso inexistente 404", async () => {
    const unapproved = await setup({ approve: false });
    const noAccount = await setup({ account: false });
    const cases: [Response, number, string][] = [
      [
        await unapproved.post(`/listings/${unapproved.t.listingId}/publish`, {
          platform: "tiktok",
        }),
        400,
        "REQUEST_INVALID",
      ],
      [
        await unapproved.post(`/listings/${unapproved.t.listingId}/publish`, {
          platform: "instagram",
        }),
        409,
        "CONTENT_NOT_APPROVED",
      ],
      [
        await noAccount.post(`/listings/${noAccount.t.listingId}/publish`, {
          platform: "instagram",
        }),
        409,
        "ACCOUNT_NOT_CONNECTED",
      ],
      [
        await unapproved.post(`/listings/${randomUUID()}/publish`, { platform: "instagram" }),
        404,
        "LISTING_NOT_FOUND",
      ],
    ];
    for (const [response, status, code] of cases) {
      expect(response.status).toBe(status);
      expect(await unapproved.errorOf(response)).toBe(code);
    }
  });

  it("sin cola es 503 y las publicaciones quedan en publishing (se reencolan publicando otra vez)", async () => {
    const { t, post, errorOf } = await setup({
      queueFails: () =>
        new AppError("QUEUE_UNAVAILABLE", "La cola no está disponible", { retriable: true }),
    });

    const response = await post(`/listings/${t.listingId}/publish`, { platform: "instagram" });

    expect(response.status).toBe(503);
    expect(await errorOf(response)).toBe("QUEUE_UNAVAILABLE");
    expect(t.publications.all().every((p) => p.status === "publishing")).toBe(true);
  });

  it("con todo publicado no hay nada que publicar (409)", async () => {
    const { t, post, errorOf } = await setup();
    await post(`/listings/${t.listingId}/publish`, { platform: "instagram" });
    for (const publication of t.publications.all()) {
      await t.publications.transition(
        publication.id,
        { from: "publishing", to: "published", changes: { publishedAt: new Date() } },
        { actor: "system" },
      );
    }

    const response = await post(`/listings/${t.listingId}/publish`, { platform: "instagram" });

    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe("NOTHING_TO_PUBLISH");
  });
});

describe("/publications/:id", () => {
  it("publicar una: 202 y la encola; otra vez la reencola (requeued)", async () => {
    const { t, post } = await setup();
    const id = t.byFormat("post")?.id ?? "";

    const first = publicationPublishResponseSchema.parse(
      await (await post(`/publications/${id}/publish`)).json(),
    );
    expect(first).toMatchObject({ requeued: false, publication: { status: "publishing" } });
    const second = await post(`/publications/${id}/publish`);
    expect(second.status).toBe(202);
    expect(publicationPublishResponseSchema.parse(await second.json()).requeued).toBe(true);
    expect(t.queue.jobs).toHaveLength(2);
  });

  it("descartar: approved → cancelled; en curso 409; ya descartada 409; inexistente 404", async () => {
    const { t, post, errorOf } = await setup();
    const postId = t.byFormat("post")?.id ?? "";
    const reelId = t.byFormat("reel")?.id ?? "";
    await post(`/publications/${reelId}/publish`);

    const cancelled = await post(`/publications/${postId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(publicationResponseSchema.parse(await cancelled.json()).publication.status).toBe(
      "cancelled",
    );

    const cases: [Response, number, string][] = [
      [await post(`/publications/${reelId}/cancel`), 409, "PUBLICATION_IN_PROGRESS"],
      [await post(`/publications/${postId}/cancel`), 409, "INVALID_TRANSITION"],
      [await post(`/publications/${randomUUID()}/cancel`), 404, "PUBLICATION_NOT_FOUND"],
    ];
    for (const [response, status, code] of cases) {
      expect(response.status).toBe(status);
      expect(await errorOf(response)).toBe(code);
    }
  });

  it("retirar en live exige removedByHand; la última publicada devuelve el aviso a ready", async () => {
    const { t, post, errorOf } = await setup({ publishMode: "live" });
    const id = t.byFormat("post")?.id ?? "";
    await post(`/publications/${id}/publish`);
    await t.publications.transition(
      id,
      {
        from: "publishing",
        to: "published",
        changes: {
          publishedAt: new Date(),
          externalId: "1789",
          externalUrl: "https://www.instagram.com/p/abc/",
        },
      },
      { actor: "system" },
    );
    await t.listings.changeStatus(t.listingId, "ready", "active");

    const unconfirmed = await post(`/publications/${id}/retire`);
    expect(unconfirmed.status).toBe(409);
    expect(await errorOf(unconfirmed)).toBe("REMOVAL_NOT_CONFIRMED");

    const response = await post(`/publications/${id}/retire`, { removedByHand: true });
    expect(response.status).toBe(200);
    expect(publicationRetireResponseSchema.parse(await response.json())).toMatchObject({
      publication: { status: "unpublished", externalUrl: "https://www.instagram.com/p/abc/" },
      listingBackToReady: true,
    });
    expect((await t.listings.get(t.listingId))?.status).toBe("ready");
  });

  it("retirar una que no está publicada es 409; removedByHand que no es booleano, 400", async () => {
    const { t, post, errorOf } = await setup();
    const id = t.byFormat("post")?.id ?? "";

    const notPublished = await post(`/publications/${id}/retire`, { removedByHand: true });
    expect(notPublished.status).toBe(409);
    expect(await errorOf(notPublished)).toBe("INVALID_TRANSITION");
    const invalid = await post(`/publications/${id}/retire`, { removedByHand: "si" });
    expect(invalid.status).toBe(400);
  });

  it("la bitácora de una que no existe es 404", async () => {
    const { app, errorOf } = await setup();
    const response = await app.request(`/publications/${randomUUID()}/events`);
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toBe("PUBLICATION_NOT_FOUND");
  });

  it("un formulario desde otro origen lo bloquea el CSRF, sin cambiar nada", async () => {
    const { t, app } = await setup();
    const id = t.byFormat("post")?.id ?? "";

    const response = await app.request(`/publications/${id}/cancel`, {
      method: "POST",
      headers: { Origin: "http://evil.test" },
      body: "{}",
    });

    expect(response.status).toBe(403);
    expect((await t.publications.get(id))?.status).toBe("approved");
  });
});

describe("respuestas sin secretos", () => {
  it("ninguna respuesta lleva el token, el progreso ni URLs de lo enviado a la plataforma", async () => {
    const { t, app, post } = await setup({ publishMode: "live" });
    const id = t.byFormat("post")?.id ?? "";
    await post(`/publications/${id}/publish`);
    await t.publications.saveProgress(id, {
      attemptStartedAt: new Date().toISOString(),
      childIds: ["contenedor-hijo-secreto"],
      containerId: "contenedor-secreto",
    });
    await t.publications.addEvent(id, {
      type: "publish_attempt",
      actor: "system",
      payload: {
        mode: "live",
        attempt: 1,
        retry: 0,
        result: "retry",
        error: { code: "IG_UNAVAILABLE", message: "Instagram no responde", retriable: true },
      },
    });

    const texts: string[] = [];
    for (const response of [
      await app.request(`/listings/${t.listingId}/publications`),
      await app.request(`/publications/${id}/events`),
      await post(`/publications/${id}/publish`),
      await post(`/listings/${t.listingId}/publish`, { platform: "instagram" }),
    ]) {
      texts.push(await response.text());
    }

    for (const text of texts) {
      expect(text).not.toContain(PUBLICATION_SCENARIO_TOKEN);
      expect(text).not.toContain("contenedor-secreto");
      expect(text).not.toContain("contenedor-hijo-secreto");
      expect(text).not.toContain('"progress"');
    }
  });
});
