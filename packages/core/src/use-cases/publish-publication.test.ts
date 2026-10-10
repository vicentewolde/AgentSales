import { describe, expect, it } from "vitest";
import type { AbortSignalLike } from "../abort.js";
import type { PublishMode } from "../enums.js";
import { AppError } from "../errors.js";
import type { MediaStorage } from "../ports/media-storage.js";
import type { Publisher } from "../ports/publisher.js";
import type { Publication } from "../publication.js";
import {
  createFakePublisher,
  createPublicationScenario,
  type FakePublisherOptions,
  type PublicationScenario,
} from "../testing/index.js";
import { publishListing } from "./publish-listing.js";
import { publishPublication } from "./publish-publication.js";

const NOW = new Date("2026-10-05T15:00:00Z");

/** Un aviso aprobado con carrusel y reel ya pasados a `publishing` en el modo pedido. */
async function setup(
  options: {
    dryRun?: boolean;
    workerMode?: PublishMode;
    publisher?: FakePublisherOptions;
    storage?: Pick<MediaStorage, "signedReadUrl">;
  } = {},
) {
  const t = await createPublicationScenario();
  const { started } = await publishListing(t.deps, {
    listingId: t.listingId,
    platform: "instagram",
    dryRun: options.dryRun ?? false,
    actor: "operator",
  });
  const fake = createFakePublisher(options.publisher);
  const deps = {
    publications: t.publications,
    platformAccounts: t.platformAccounts,
    contents: t.contents,
    media: t.media,
    listings: t.listings,
    brokers: t.brokers,
    storage: options.storage ?? t.storage,
    publishers: { instagram: fake },
    workerMode: options.workerMode ?? "live",
    mercadoLibre: null,
    now: () => NOW,
  };
  const [post, reel] = started;
  if (post === undefined || reel === undefined) throw new Error("faltan publicaciones");
  const run = (
    publication: Publication,
    extra: { isLastAttempt?: boolean; retryCount?: number; signal?: AbortSignalLike } = {},
  ) =>
    publishPublication(deps, {
      publicationId: publication.id,
      isLastAttempt: extra.isLastAttempt ?? false,
      ...(extra.retryCount === undefined ? {} : { retryCount: extra.retryCount }),
      ...(extra.signal === undefined ? {} : { signal: extra.signal }),
    });
  const attempts = async (publication: Publication) =>
    (await t.publications.listEvents(publication.id)).filter((e) => e.type === "publish_attempt");
  return { t, fake, deps, post, reel, run, attempts };
}

const current = (t: PublicationScenario, id: string) =>
  t.publications.all().find((publication) => publication.id === id);

describe("publishPublication · éxito", () => {
  it("en live: publicada con enlace y fecha, el aviso pasa a active y la bitácora guarda lo enviado sin URLs ni tokens", async () => {
    const { t, fake, post, run, attempts } = await setup();
    const result = await run(post);

    expect(result).toMatchObject({
      outcome: "published",
      publication: {
        status: "published",
        externalId: `fake-${post.id}-1`,
        externalUrl: `https://example.test/p/${post.id}`,
        publishedAt: NOW,
        lastError: null,
      },
    });
    expect((await t.listings.get(t.listingId))?.status).toBe("active");
    expect(fake.published).toHaveLength(1);
    const sentMedia = fake.published[0]?.input.media ?? [];
    expect(sentMedia.length).toBeGreaterThan(0);
    expect(sentMedia.every((item) => item.url.includes("ttl=3600"))).toBe(true);

    const [attempt] = await attempts(post);
    expect(attempt?.payload).toMatchObject({
      mode: "live",
      attempt: 1,
      retry: 0,
      result: "published",
      sent: { format: "post", account: { displayName: "@muestra" } },
    });
    const written = JSON.stringify(await t.publications.listEvents(post.id));
    expect(written).not.toContain("memory://");
    expect(written).not.toContain("IGAA-prueba");
  });

  it("dry_run con el worker en live: simula sin llamar a la plataforma y no cambia el aviso", async () => {
    const { t, fake, post, run, attempts } = await setup({ dryRun: true, workerMode: "live" });
    const result = await run(post);
    expect(result).toMatchObject({
      outcome: "published",
      publication: { status: "published", externalId: `dry-run:${post.id}`, externalUrl: null },
    });
    expect(fake.published).toEqual([]);
    expect((await t.listings.get(t.listingId))?.status).toBe("ready");
    expect((await attempts(post))[0]?.payload).toMatchObject({
      mode: "dry-run",
      result: "published",
      sent: { caption: expect.any(String) },
    });
  });

  it("dry_run con preflight (F4-T13): sus advertencias van a la bitácora del intento, sin publicar", async () => {
    const { fake, post, run, attempts } = await setup({
      dryRun: true,
      publisher: { preflight: { ok: true, notes: ["Conviene sumar más fotos"] } },
    });
    await expect(run(post)).resolves.toMatchObject({ outcome: "published" });
    expect(fake.preflighted).toHaveLength(1);
    expect(fake.published).toEqual([]);
    expect((await attempts(post))[0]?.payload).toMatchObject({
      mode: "dry-run",
      result: "published",
      notes: ["Conviene sumar más fotos"],
    });
  });

  it("las advertencias se guardan limpias y como mucho 20, también las de live", async () => {
    const notes = [
      "Mercado Libre avisa por brokers/b/listings/l/a.jpg ?access_token=IGAA-x",
      ...Array.from({ length: 25 }, (_, i) => `aviso ${i}`),
    ];
    const { post, run, attempts } = await setup({
      publisher: { steps: [{ result: { externalId: "X1", externalUrl: null, notes } }] },
    });
    await expect(run(post)).resolves.toMatchObject({ outcome: "published" });
    const saved = (await attempts(post))[0]?.payload as { notes?: string[] };
    expect(saved.notes).toHaveLength(20);
    expect(JSON.stringify(saved.notes)).not.toMatch(/brokers\/|IGAA-x/);
  });

  it("dry_run con preflight que rechaza: failed con PUBLISH_INPUT_INVALID", async () => {
    const { t, fake, post, run } = await setup({
      dryRun: true,
      publisher: {
        preflight: { ok: false, issues: [{ code: "X", message: "Mercado Libre no lo acepta" }] },
      },
    });
    await expect(run(post)).rejects.toMatchObject({ code: "PUBLISH_INPUT_INVALID" });
    expect(fake.published).toEqual([]);
    expect(current(t, post.id)).toMatchObject({
      status: "failed",
      lastError: {
        code: "PUBLISH_INPUT_INVALID",
        message: expect.stringContaining("no lo acepta"),
      },
    });
  });

  it("dry_run con el worker en dry-run también simula", async () => {
    const { fake, reel, run } = await setup({ dryRun: true, workerMode: "dry-run" });
    await expect(run(reel)).resolves.toMatchObject({ outcome: "published" });
    expect(fake.published).toEqual([]);
  });

  it("un aviso que ya no está ready no se toca al publicar en live", async () => {
    const { t, post, run } = await setup();
    await t.listings.changeStatus(t.listingId, "ready", "archived");
    await run(post);
    expect((await t.listings.get(t.listingId))?.status).toBe("archived");
  });

  it("guarda el progreso que entrega el publisher y el reintento lo recibe", async () => {
    const progress = {
      attemptStartedAt: "2026-10-05T12:00:00.000Z",
      childIds: [],
      containerId: "c-1",
    };
    const { t, fake, post, run } = await setup({
      publisher: {
        steps: [
          {
            progress,
            error: new AppError("IG_UNAVAILABLE", "Instagram no respondió", { retriable: true }),
          },
          {},
        ],
      },
    });
    await expect(run(post)).rejects.toMatchObject({ code: "IG_UNAVAILABLE" });
    expect(current(t, post.id)).toMatchObject({ status: "publishing", progress });
    await run(post, { retryCount: 1 });
    expect(fake.published.map((call) => call.progress)).toEqual([null, progress]);
  });
});

describe("publishPublication · nada que hacer", () => {
  it("una que no está en publishing no se toca (idempotente): sin eventos ni cambios", async () => {
    const { t, fake, post, reel, run } = await setup();
    await run(post);
    const before = await t.publications.listEvents(post.id);
    await expect(run(post)).resolves.toEqual({ outcome: "skipped", status: "published" });
    expect(await t.publications.listEvents(post.id)).toEqual(before);
    expect(current(t, post.id)?.attempts).toBe(1);

    await t.publications.transition(
      reel.id,
      {
        from: "publishing",
        to: "failed",
        changes: { lastError: { code: "X", message: "x", retriable: true } },
      },
      { actor: "system" },
    );
    await expect(run(reel)).resolves.toEqual({ outcome: "skipped", status: "failed" });
    expect(fake.published).toHaveLength(1);
  });

  it("una que no existe es PUBLICATION_NOT_FOUND", async () => {
    const { deps } = await setup();
    await expect(
      publishPublication(deps, { publicationId: "no-existe", isLastAttempt: true }),
    ).rejects.toMatchObject({ code: "PUBLICATION_NOT_FOUND" });
  });
});

describe("publishPublication · errores", () => {
  it("live con el worker en dry-run: PUBLISH_MODE_MISMATCH, failed, sin llamar a la plataforma", async () => {
    const { t, fake, post, run, attempts } = await setup({ workerMode: "dry-run" });
    await expect(run(post)).rejects.toMatchObject({
      code: "PUBLISH_MODE_MISMATCH",
      retriable: false,
    });
    expect(current(t, post.id)).toMatchObject({
      status: "failed",
      lastError: { code: "PUBLISH_MODE_MISMATCH", retriable: false },
    });
    expect(fake.published).toEqual([]);
    expect((await attempts(post))[0]?.payload).toMatchObject({ result: "failed", mode: "live" });
    expect((await t.listings.get(t.listingId))?.status).toBe("ready");
  });

  it("un error reintentable sigue en publishing y relanza; en el último intento queda failed", async () => {
    const unavailable = () =>
      new AppError("IG_UNAVAILABLE", "Instagram no respondió", { retriable: true });
    const { t, post, run, attempts } = await setup({
      publisher: { steps: [{ error: unavailable() }, { error: unavailable() }] },
    });
    await expect(run(post)).rejects.toMatchObject({ code: "IG_UNAVAILABLE", retriable: true });
    expect(current(t, post.id)?.status).toBe("publishing");
    await expect(run(post, { isLastAttempt: true, retryCount: 2 })).rejects.toMatchObject({
      code: "IG_UNAVAILABLE",
    });
    expect(current(t, post.id)).toMatchObject({
      status: "failed",
      lastError: { code: "IG_UNAVAILABLE", retriable: true },
    });
    expect((await attempts(post)).map((e) => [e.payload.result, e.payload.retry])).toEqual([
      ["retry", 0],
      ["failed", 2],
    ]);
  });

  it("un error no reintentable queda failed al primer intento", async () => {
    const { t, post, run } = await setup({
      publisher: {
        steps: [{ error: new AppError("IG_MEDIA_REJECTED", "Una imagen pesa más de 8 MB") }],
      },
    });
    await expect(run(post)).rejects.toMatchObject({ code: "IG_MEDIA_REJECTED" });
    expect(current(t, post.id)).toMatchObject({
      status: "failed",
      lastError: { code: "IG_MEDIA_REJECTED", message: "Una imagen pesa más de 8 MB" },
    });
  });

  it("IG_AUTH_INVALID deja la cuenta en expired", async () => {
    const { t, post, run } = await setup({
      publisher: {
        steps: [
          { error: new AppError("IG_AUTH_INVALID", "El acceso venció: reconecta la cuenta") },
        ],
      },
    });
    await expect(run(post)).rejects.toMatchObject({ code: "IG_AUTH_INVALID" });
    expect((await t.platformAccounts.get(t.account?.id ?? ""))?.status).toBe("expired");
    expect(current(t, post.id)?.status).toBe("failed");
  });

  it("credenciales ilegibles: CREDENTIALS_UNREADABLE, la cuenta en error y nada publicado", async () => {
    const { t, fake, post, run } = await setup();
    t.platformAccounts.corruptCredentials(t.account?.id ?? "");
    await expect(run(post)).rejects.toMatchObject({ code: "CREDENTIALS_UNREADABLE" });
    expect((await t.platformAccounts.get(t.account?.id ?? ""))?.status).toBe("error");
    expect(current(t, post.id)?.status).toBe("failed");
    expect(fake.published).toEqual([]);
  });

  it("una cuenta desconectada es ACCOUNT_NOT_CONNECTED", async () => {
    const { t, post, run } = await setup();
    await t.platformAccounts.disconnect(t.account?.id ?? "");
    await expect(run(post)).rejects.toMatchObject({ code: "ACCOUNT_NOT_CONNECTED" });
    expect(current(t, post.id)?.status).toBe("failed");
  });

  it("un input que la plataforma no acepta no se publica, en live y en dry-run", async () => {
    for (const dryRun of [false, true]) {
      const { t, fake, post, run } = await setup({
        dryRun,
        publisher: { issues: [{ code: "TOO_MANY_ITEMS", message: "Más de 10 imágenes" }] },
      });
      await expect(run(post)).rejects.toMatchObject({ code: "PUBLISH_INPUT_INVALID" });
      expect(fake.published).toEqual([]);
      expect(current(t, post.id)?.lastError?.message).toContain("Más de 10 imágenes");
    }
  });

  it("un formulario listo de un publisher sin paso manual nunca se da por publicado", async () => {
    const { t, post, run } = await setup({ publisher: { steps: [{ handoff: {} }] } });
    await expect(run(post)).rejects.toMatchObject({ code: "INTERNAL_ERROR", retriable: false });
    expect(current(t, post.id)).toMatchObject({
      status: "failed",
      externalId: null,
      lastError: { code: "INTERNAL_ERROR" },
    });
  });

  it("sin publisher para la plataforma es PUBLISHER_NOT_CONFIGURED", async () => {
    const { t, deps, post } = await setup();
    await expect(
      publishPublication(
        { ...deps, publishers: {} },
        { publicationId: post.id, isLastAttempt: false },
      ),
    ).rejects.toMatchObject({ code: "PUBLISHER_NOT_CONFIGURED", retriable: false });
    expect(current(t, post.id)?.status).toBe("failed");
  });

  it("R2 sin responder al firmar: reintentable, sigue en publishing", async () => {
    const storage = {
      async signedReadUrl(): Promise<string> {
        throw new AppError("STORAGE_UNAVAILABLE", "R2 no respondió", { retriable: true });
      },
    };
    const { t, fake, post, run } = await setup({ storage });
    await expect(run(post)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(current(t, post.id)?.status).toBe("publishing");
    expect(fake.published).toEqual([]);
  });

  it("el motivo guardado no lleva rutas ni secretos", async () => {
    const { t, post, run } = await setup({
      publisher: {
        steps: [
          {
            error: new AppError(
              "STORAGE_NOT_FOUND",
              "No existe brokers/b/listings/l/a.jpg ni /Users/op/tmp/x.jpg ?access_token=IGAA-x",
            ),
          },
        ],
      },
    });
    await expect(run(post)).rejects.toMatchObject({ code: "STORAGE_NOT_FOUND" });
    const message = current(t, post.id)?.lastError?.message ?? "";
    expect(message).not.toMatch(/brokers\/|\/Users\/|IGAA-x/);
  });

  it("un error que no es AppError queda como INTERNAL_ERROR, sin su mensaje", async () => {
    const { t, post, run } = await setup({
      publisher: { steps: [{ error: new Error("detalle interno con IGAA-secreto") }] },
    });
    await expect(run(post)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(JSON.stringify(current(t, post.id)?.lastError)).not.toContain("IGAA-secreto");
  });
});

describe("publishPublication · apagado", () => {
  it("con la señal disparada no toca nada (aunque sea el último intento) y relanza como reintentable", async () => {
    // Una señal a mano: core no carga los tipos de Node ni del navegador.
    const signal = { aborted: false, addEventListener() {}, removeEventListener() {} };
    const { t, post, deps, attempts } = await setup();
    const fake = createFakePublisher({
      steps: [{ error: new AppError("IG_MEDIA_REJECTED", "rechazado") }],
    });
    const abortingPublisher: Publisher = {
      ...fake,
      async publish(input, ctx) {
        signal.aborted = true;
        return fake.publish(input, ctx);
      },
    };
    await expect(
      publishPublication(
        { ...deps, publishers: { instagram: abortingPublisher } },
        { publicationId: post.id, isLastAttempt: true, signal },
      ),
    ).rejects.toMatchObject({ code: "PUBLISH_ABORTED", retriable: true });
    expect(current(t, post.id)?.status).toBe("publishing");
    expect(await attempts(post)).toEqual([]);
  });
});

/** Un repositorio cuyo `method` falla las próximas `times` veces con `error`. */
function failing<T extends object>(repo: T, method: keyof T, error: Error, times = 1): T {
  let left = times;
  return new Proxy(repo, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      if (key !== method) return value.bind(target);
      return (...args: unknown[]) => {
        if (left > 0) {
          left -= 1;
          return Promise.reject(error);
        }
        return value.apply(target, args);
      };
    },
  });
}

const dbDown = () => new AppError("DB_UNAVAILABLE", "La base no respondió", { retriable: true });

describe("publishPublication · guardar después de publicar", () => {
  const progress = {
    attemptStartedAt: "2026-10-05T12:00:00.000Z",
    childIds: [],
    containerId: "c-1",
  };

  it("si falla guardar published, sigue en publishing (PUBLISH_RESULT_NOT_SAVED, reintentable) y el reintento guarda sin publicar de nuevo", async () => {
    const { t, fake, deps, post, attempts } = await setup({ publisher: { steps: [{ progress }] } });
    const flaky = { ...deps, publications: failing(t.publications, "transition", dbDown()) };
    await expect(
      publishPublication(flaky, { publicationId: post.id, isLastAttempt: true }),
    ).rejects.toMatchObject({ code: "PUBLISH_RESULT_NOT_SAVED", retriable: true });
    expect(current(t, post.id)).toMatchObject({ status: "publishing", lastError: null });
    expect(await attempts(post)).toEqual([]);

    await publishPublication(deps, { publicationId: post.id, isLastAttempt: true, retryCount: 1 });
    expect(current(t, post.id)?.status).toBe("published");
    // El reintento recibe el progreso: el publisher real reconoce el medio ya publicado.
    expect(fake.published.map((call) => call.progress)).toEqual([null, progress]);
    expect((await attempts(post)).map((e) => e.payload.result)).toEqual(["published"]);
  });

  it("si falla la bitácora después de publicar, queda published igual y se avisa", async () => {
    const warnings: unknown[] = [];
    const { t, deps, post } = await setup();
    const flaky = {
      ...deps,
      publications: failing(t.publications, "addEvent", dbDown()),
      onWarning: (warning: unknown) => warnings.push(warning),
    };
    await expect(
      publishPublication(flaky, { publicationId: post.id, isLastAttempt: false }),
    ).resolves.toMatchObject({ outcome: "published" });
    expect(warnings).toEqual([
      { publicationId: post.id, step: "attempt_event", code: "DB_UNAVAILABLE" },
    ]);
  });

  it("si falla subir el aviso a active, queda published, se avisa, y un nuevo paso del job lo sube", async () => {
    const warnings: unknown[] = [];
    const { t, deps, post } = await setup();
    const flaky = {
      ...deps,
      listings: failing(t.listings, "changeStatus", dbDown()),
      onWarning: (warning: unknown) => warnings.push(warning),
    };
    await expect(
      publishPublication(flaky, { publicationId: post.id, isLastAttempt: false }),
    ).resolves.toMatchObject({ outcome: "published" });
    expect((await t.listings.get(t.listingId))?.status).toBe("ready");
    expect(warnings).toEqual([
      { publicationId: post.id, step: "listing_active", code: "DB_UNAVAILABLE" },
    ]);
    await expect(
      publishPublication(deps, { publicationId: post.id, isLastAttempt: false }),
    ).resolves.toEqual({ outcome: "skipped", status: "published" });
    expect((await t.listings.get(t.listingId))?.status).toBe("active");
  });

  it("si falla marcar failed porque la base no responde, relanza reintentable para que la cola reintente", async () => {
    const { t, deps, post } = await setup({
      publisher: { steps: [{ error: new AppError("IG_MEDIA_REJECTED", "rechazado") }] },
    });
    const flaky = { ...deps, publications: failing(t.publications, "transition", dbDown()) };
    await expect(
      publishPublication(flaky, { publicationId: post.id, isLastAttempt: false }),
    ).rejects.toMatchObject({ code: "DB_UNAVAILABLE", retriable: true });
    expect(current(t, post.id)?.status).toBe("publishing");
  });

  it("el aviso sube a active según la publicación (live), aunque el publisher diga simulated", async () => {
    const { t, post, run } = await setup({
      publisher: { steps: [{ result: { externalId: "x", externalUrl: null, simulated: true } }] },
    });
    await run(post);
    expect((await t.listings.get(t.listingId))?.status).toBe("active");
  });
});

describe("publishPublication · más rechazos", () => {
  it("un texto que no existe es CONTENT_NOT_FOUND; uno ya no aprobado, CONTENT_NOT_APPROVED", async () => {
    const missing = await setup();
    const noContent = { ...missing.deps, contents: { get: async () => null } };
    await expect(
      publishPublication(noContent, { publicationId: missing.post.id, isLastAttempt: false }),
    ).rejects.toMatchObject({ code: "CONTENT_NOT_FOUND" });

    const edited = await setup();
    await edited.t.contents.update(edited.post.contentId, { status: "edited" });
    await expect(edited.run(edited.post)).rejects.toMatchObject({ code: "CONTENT_NOT_APPROVED" });
    expect(current(edited.t, edited.post.id)?.status).toBe("failed");
  });

  it("credenciales ilegibles también detienen una simulación", async () => {
    const { t, post, run } = await setup({ dryRun: true });
    t.platformAccounts.corruptCredentials(t.account?.id ?? "");
    await expect(run(post)).rejects.toMatchObject({ code: "CREDENTIALS_UNREADABLE" });
    expect((await t.platformAccounts.get(t.account?.id ?? ""))?.status).toBe("error");
  });

  it("el evento del intento también lleva el motivo limpio", async () => {
    const { post, run, attempts } = await setup({
      publisher: {
        steps: [
          {
            error: new AppError(
              "STORAGE_NOT_FOUND",
              "No existe brokers/b/listings/l/a.jpg ni '/Users/op/tmp/x.jpg' ?X-Amz-Signature=firma",
            ),
          },
        ],
      },
    });
    await expect(run(post)).rejects.toMatchObject({ code: "STORAGE_NOT_FOUND" });
    // `sent` sí lleva las rutas de R2 (spec F3 §4.3); el motivo del error, no.
    const [attempt] = await attempts(post);
    expect(JSON.stringify(attempt?.payload.error)).not.toMatch(/brokers\/|\/Users\/|firma/);
    expect(attempt?.payload.error).toMatchObject({ code: "STORAGE_NOT_FOUND" });
  });
});

describe("publishPublication · apagado, más casos", () => {
  const manualSignal = () => ({ aborted: false, addEventListener() {}, removeEventListener() {} });

  it("un error reintentable con la señal se relanza tal cual; IG_AUTH_INVALID no vence la cuenta", async () => {
    for (const error of [
      new AppError("IG_UNAVAILABLE", "Instagram no respondió", { retriable: true }),
      new AppError("IG_AUTH_INVALID", "venció"),
    ]) {
      const signal = manualSignal();
      const { t, deps, post } = await setup();
      const fake = createFakePublisher({ steps: [{ error }] });
      const aborting: Publisher = {
        ...fake,
        async publish(input, ctx) {
          signal.aborted = true;
          return fake.publish(input, ctx);
        },
      };
      const rejection = await publishPublication(
        { ...deps, publishers: { instagram: aborting } },
        { publicationId: post.id, isLastAttempt: true, signal },
      ).catch((caught: unknown) => caught);
      expect(rejection).toMatchObject({
        code: error.retriable ? error.code : "PUBLISH_ABORTED",
        retriable: true,
      });
      expect(current(t, post.id)).toMatchObject({ status: "publishing", lastError: null });
      expect((await t.platformAccounts.get(t.account?.id ?? ""))?.status).toBe("connected");
    }
  });
});
