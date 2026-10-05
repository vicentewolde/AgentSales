import { describe, expect, it } from "vitest";
import type { Content } from "../content.js";
import { AppError } from "../errors.js";
import type { Media } from "../media.js";
import type { PlatformAccount } from "../platform-account.js";
import type { Publisher, PublishInput } from "../ports/publisher.js";
import type { Publication } from "../publication.js";
import { createFakePublisher, createInMemoryMediaStorage } from "../testing/index.js";
import {
  buildPublishInput,
  checkPublishInput,
  PUBLISH_MEDIA_URL_TTL_S,
  publishAttemptRecord,
} from "./input.js";

const at = new Date("2026-10-05T12:00:00Z");

function mediaItem(id: string, overrides: Partial<Media> = {}): Media {
  return {
    id,
    listingId: "listing-1",
    brokerId: "broker-1",
    kind: "image",
    role: "processed",
    variant: "ig_4x5",
    parentMediaId: `original-${id}`,
    storagePath: `brokers/broker-1/listings/listing-1/processed/ig_4x5/${id}.jpg`,
    mime: "image/jpeg",
    width: 1080,
    height: 1350,
    durationS: null,
    bytes: 250_000,
    checksum: `sha-${id}`,
    sortOrder: 0,
    isCover: false,
    ...overrides,
  };
}

function content(overrides: Partial<Content> = {}): Content {
  return {
    id: "content-1",
    listingId: "listing-1",
    contentRunId: "run-1",
    platform: "instagram",
    title: null,
    body: "Departamento luminoso en Ñuñoa.",
    hashtags: ["#nunoa", "#departamentoventa"],
    status: "approved",
    llmProvider: "fake",
    llmModel: "modelo-falso",
    promptVersion: "1",
    rawOutput: {},
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function publication(overrides: Partial<Publication> = {}): Publication {
  return {
    id: "pub-1",
    listingId: "listing-1",
    platformAccountId: "account-1",
    platform: "instagram",
    format: "post",
    contentId: "content-1",
    mediaIds: ["m-3", "m-1"],
    status: "publishing",
    scheduledAt: null,
    publishedAt: null,
    externalId: null,
    externalUrl: null,
    attempts: 1,
    lastError: null,
    dryRun: true,
    progress: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

const listingMedia = [mediaItem("m-1"), mediaItem("m-2"), mediaItem("m-3", { sortOrder: 2 })];

describe("buildPublishInput", () => {
  it("arma el caption de Instagram y los medios de media_ids en su orden, con URLs nuevas de 1 h", async () => {
    const storage = createInMemoryMediaStorage();
    const input = await buildPublishInput(
      { storage },
      { publication: publication(), content: content(), media: listingMedia },
    );
    expect(input).toEqual({
      publicationId: "pub-1",
      platform: "instagram",
      format: "post",
      title: null,
      caption: "Departamento luminoso en Ñuñoa.\n\n#nunoa #departamentoventa",
      media: ["m-3", "m-1"].map((id) => {
        const { storagePath, mime, bytes, width, height, durationS, kind } = mediaItem(id);
        return {
          mediaId: id,
          kind,
          mime,
          storagePath,
          url: `memory://${storagePath}?ttl=${PUBLISH_MEDIA_URL_TTL_S}`,
          bytes,
          width,
          height,
          durationS,
        };
      }),
    });
    expect(PUBLISH_MEDIA_URL_TTL_S).toBe(3600);
  });

  it("un reel lleva el video con su duración", async () => {
    const reel = mediaItem("reel-1", {
      kind: "video",
      variant: "ig_reel",
      mime: "video/mp4",
      width: 1080,
      height: 1920,
      durationS: 42.5,
      storagePath: "brokers/broker-1/listings/listing-1/processed/ig_reel/a-b.mp4",
    });
    const input = await buildPublishInput(
      { storage: createInMemoryMediaStorage() },
      {
        publication: publication({ format: "reel", mediaIds: ["reel-1"] }),
        content: content({ hashtags: [] }),
        media: [...listingMedia, reel],
      },
    );
    expect(input.format).toBe("reel");
    expect(input.caption).toBe("Departamento luminoso en Ñuñoa.");
    expect(input.media).toMatchObject([{ mediaId: "reel-1", kind: "video", durationS: 42.5 }]);
  });

  it("en Instagram no hay título, aunque el texto traiga uno", async () => {
    const input = await buildPublishInput(
      { storage: createInMemoryMediaStorage() },
      { publication: publication(), content: content({ title: "Sobra" }), media: listingMedia },
    );
    expect(input.title).toBeNull();
  });

  it("en los otros canales el caption es el cuerpo y conserva el título", async () => {
    const input = await buildPublishInput(
      { storage: createInMemoryMediaStorage() },
      {
        publication: publication({ platform: "portal_inmobiliario", mediaIds: ["m-1"] }),
        content: content({ platform: "portal_inmobiliario", title: "Depto en Ñuñoa" }),
        media: listingMedia,
      },
    );
    expect(input.title).toBe("Depto en Ñuñoa");
    expect(input.caption).toBe("Departamento luminoso en Ñuñoa.");
  });

  it("un medio fijado que falta es PUBLICATION_MEDIA_MISSING, sin firmar nada", async () => {
    const signed: string[] = [];
    const storage = {
      async signedReadUrl(path: string) {
        signed.push(path);
        return `memory://${path}`;
      },
    };
    const otherListing = mediaItem("m-9", { listingId: "listing-2" });
    for (const mediaIds of [["m-1", "m-404"], ["m-9"]]) {
      const error = await buildPublishInput(
        { storage },
        {
          publication: publication({ mediaIds }),
          content: content(),
          media: [...listingMedia, otherListing],
        },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: "PUBLICATION_MEDIA_MISSING", retriable: false });
    }
    expect(signed).toEqual([]);
  });

  it("un texto que no es el de la publicación (otro id o canal) es PUBLICATION_CONTENT_MISMATCH", async () => {
    for (const other of [content({ id: "content-2" }), content({ platform: "fb_marketplace" })]) {
      await expect(
        buildPublishInput(
          { storage: createInMemoryMediaStorage() },
          { publication: publication(), content: other, media: listingMedia },
        ),
      ).rejects.toMatchObject({ code: "PUBLICATION_CONTENT_MISMATCH", retriable: false });
    }
  });

  it("un texto que ya no está aprobado es CONTENT_NOT_APPROVED", async () => {
    for (const status of ["draft", "edited"] as const) {
      await expect(
        buildPublishInput(
          { storage: createInMemoryMediaStorage() },
          { publication: publication(), content: content({ status }), media: listingMedia },
        ),
      ).rejects.toMatchObject({ code: "CONTENT_NOT_APPROVED", retriable: false });
    }
  });

  it("un error de R2 al firmar pasa tal cual", async () => {
    const unavailable = new AppError("STORAGE_UNAVAILABLE", "R2 no respondió", { retriable: true });
    const storage = {
      async signedReadUrl(): Promise<string> {
        throw unavailable;
      },
    };
    await expect(
      buildPublishInput(
        { storage },
        { publication: publication(), content: content(), media: listingMedia },
      ),
    ).rejects.toBe(unavailable);
  });
});

describe("checkPublishInput", () => {
  const input: PublishInput = {
    publicationId: "pub-1",
    platform: "instagram",
    format: "reel",
    title: null,
    caption: "Hola",
    media: [],
  };

  it("acepta un input válido", () => {
    const publisher = createFakePublisher();
    expect(() => checkPublishInput(publisher, input)).not.toThrow();
    expect(publisher.validated).toHaveLength(1);
  });

  it("los motivos de la plataforma salen en PUBLISH_INPUT_INVALID, no reintentable", () => {
    const issues = [
      { code: "NO_MEDIA", message: "Falta el video del reel" },
      { code: "CAPTION_TOO_LONG", message: "El caption supera los 2.200 caracteres" },
    ];
    const publisher = createFakePublisher({ issues });
    const error = (() => {
      try {
        checkPublishInput(publisher, input);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toMatchObject({
      code: "PUBLISH_INPUT_INVALID",
      retriable: false,
      details: { publicationId: "pub-1", issues },
    });
    expect(error).toMatchObject({ message: expect.stringContaining("Falta el video del reel") });
    expect(error).toMatchObject({
      message: expect.stringContaining("El caption supera los 2.200 caracteres"),
    });
  });

  it("un rechazo sin motivos sigue siendo un rechazo", () => {
    const publisher: Publisher = {
      ...createFakePublisher(),
      validate: () => ({ ok: false, issues: [] }),
    };
    expect(() => checkPublishInput(publisher, input)).toThrow(
      expect.objectContaining({
        code: "PUBLISH_INPUT_INVALID",
        details: expect.objectContaining({
          issues: [expect.objectContaining({ code: "INPUT_REJECTED" })],
        }),
      }),
    );
  });

  it("otra plataforma o un formato que no publica se rechazan sin llamar a validate", () => {
    const portal = createFakePublisher({ platform: "portal_inmobiliario", formats: ["post"] });
    expect(() => checkPublishInput(portal, input)).toThrow(
      expect.objectContaining({
        code: "PUBLISH_INPUT_INVALID",
        details: expect.objectContaining({
          issues: [expect.objectContaining({ code: "PLATFORM_MISMATCH" })],
        }),
      }),
    );
    const postOnly = createFakePublisher({ formats: ["post"] });
    expect(() => checkPublishInput(postOnly, input)).toThrow(
      expect.objectContaining({
        details: expect.objectContaining({
          issues: [expect.objectContaining({ code: "FORMAT_NOT_SUPPORTED" })],
        }),
      }),
    );
    expect(portal.validated).toEqual([]);
    expect(postOnly.validated).toEqual([]);
  });
});

describe("publishAttemptRecord", () => {
  const account: Pick<PlatformAccount, "id" | "displayName"> = {
    id: "account-1",
    displayName: "@corredora",
  };

  it("registra formato, caption completo, medios (ruta, tipo, tamaño y medidas) y la cuenta, sin URLs", async () => {
    const input = await buildPublishInput(
      { storage: createInMemoryMediaStorage() },
      { publication: publication(), content: content(), media: listingMedia },
    );
    const record = publishAttemptRecord(input, account);
    expect(record).toEqual({
      platform: "instagram",
      format: "post",
      title: null,
      caption: input.caption,
      media: input.media.map(({ url: _url, ...item }) => item),
      account: { id: "account-1", displayName: "@corredora" },
    });
    expect(JSON.stringify(record)).not.toContain("memory://");
  });
});
