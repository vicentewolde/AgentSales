import { describe, expect, it } from "vitest";
import type { Content } from "../content.js";
import { AppError } from "../errors.js";
import type { Media } from "../media.js";
import type { PlatformAccount } from "../platform-account.js";
import type { Publisher, PublishInput } from "../ports/publisher.js";
import type { Publication } from "../publication.js";
import {
  contentBrokerFixture,
  contentListingFixture,
  createFakePublisher,
  createInMemoryMediaStorage,
} from "../testing/index.js";
import {
  buildPublishInput,
  checkPublishInput,
  maskWhatsapp,
  PUBLISH_MEDIA_URL_TTL_S,
  publishAttemptRecord,
} from "./input.js";

const at = new Date("2026-10-05T12:00:00Z");

/** El aviso de Portal y Marketplace (con notas internas, que nunca van al input) y su corredor. */
const LISTING = contentListingFixture({ id: "listing-1" });
const BROKER = contentBrokerFixture();
const HASH = "hash-del-aviso-1";
/** Repositorios con el aviso y su versión actual (`hash`, o `null` si el aviso no existe). */
const withListing = (hash: string | null = HASH, broker = BROKER) => ({
  listings: {
    get: async (id: string) => (id === LISTING.id && hash !== null ? LISTING : null),
    getSourceHash: async (id: string) => (id === LISTING.id ? hash : null),
  },
  brokers: { findById: async (id: string) => (id === broker.id ? broker : null) },
});

/** Instagram no lee el aviso ni el corredor: si los pidiera, el test lo notaría. */
const NO_LISTING = {
  listings: {
    get: async () => {
      throw new Error("Instagram no lee el aviso");
    },
    getSourceHash: async () => {
      throw new Error("Instagram no lee la versión del aviso");
    },
  },
  brokers: {
    findById: async () => {
      throw new Error("Instagram no lee el corredor");
    },
  },
};

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
    remoteState: null,
    listingSourceHash: null,
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
      { storage, ...NO_LISTING },
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
      { storage: createInMemoryMediaStorage(), ...NO_LISTING },
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
      { storage: createInMemoryMediaStorage(), ...NO_LISTING },
      { publication: publication(), content: content({ title: "Sobra" }), media: listingMedia },
    );
    expect(input.title).toBeNull();
  });

  it("en los otros canales el caption es el cuerpo y conserva el título", async () => {
    const input = await buildPublishInput(
      { storage: createInMemoryMediaStorage(), ...withListing() },
      {
        publication: publication({
          platform: "portal_inmobiliario",
          mediaIds: ["m-1"],
          listingSourceHash: HASH,
        }),
        content: content({ platform: "portal_inmobiliario", title: "Depto en Ñuñoa" }),
        media: listingMedia,
      },
    );
    expect(input.title).toBe("Depto en Ñuñoa");
    expect(input.caption).toBe("Departamento luminoso en Ñuñoa.");
  });

  it("Portal y Marketplace suman el aviso (sin notas internas) y el contacto del corredor", async () => {
    for (const platform of ["portal_inmobiliario", "fb_marketplace"] as const) {
      const input = await buildPublishInput(
        { storage: createInMemoryMediaStorage(), ...withListing() },
        {
          publication: publication({ platform, mediaIds: ["m-1"], listingSourceHash: HASH }),
          content: content({ platform, title: "Depto en Ñuñoa" }),
          media: listingMedia,
        },
      );
      expect(input.listing, platform).toEqual({
        id: LISTING.id,
        externalRef: LISTING.externalRef,
        operation: LISTING.operation,
        propertyType: LISTING.propertyType,
        region: LISTING.region,
        comuna: LISTING.comuna,
        address: LISTING.address,
        unitNumber: LISTING.unitNumber,
        showExactAddress: LISTING.showExactAddress,
        priceAmount: LISTING.priceAmount,
        priceCurrency: LISTING.priceCurrency,
        attributes: LISTING.attributes,
      });
      expect(input.brokerContact, platform).toEqual({
        name: BROKER.name,
        email: BROKER.email,
        whatsapp: BROKER.whatsapp,
      });
      expect(JSON.stringify(input)).not.toContain(LISTING.internalNotes ?? "-");
    }
  });

  it("Instagram no lleva el aviso ni el contacto, ni los lee", async () => {
    const input = await buildPublishInput(
      { storage: createInMemoryMediaStorage(), ...NO_LISTING },
      { publication: publication(), content: content(), media: listingMedia },
    );
    expect(input).not.toHaveProperty("listing");
    expect(input).not.toHaveProperty("brokerContact");
  });

  const changedCases: [string, string | null, string | null, string][] = [
    ["el aviso cambió (otra carga del Excel)", HASH, "otro-hash", "changed"],
    ["la publicación no tiene versión", null, HASH, "missing_version"],
    ["el aviso ya no existe", HASH, null, "changed"],
  ];
  it.each(changedCases)(
    "PUBLICATION_LISTING_CHANGED si %s, sin firmar nada",
    async (_, version, current, reason) => {
      const signed: string[] = [];
      const storage = {
        async signedReadUrl(path: string) {
          signed.push(path);
          return path;
        },
      };
      await expect(
        buildPublishInput(
          { storage, ...withListing(current) },
          {
            publication: publication({
              platform: "portal_inmobiliario",
              mediaIds: ["m-1"],
              listingSourceHash: version,
            }),
            content: content({ platform: "portal_inmobiliario", title: "Depto" }),
            media: listingMedia,
          },
        ),
      ).rejects.toMatchObject({
        code: "PUBLICATION_LISTING_CHANGED",
        retriable: false,
        details: { publicationId: "pub-1", reason },
      });
      expect(signed).toEqual([]);
    },
  );

  it("sin el corredor del aviso: BROKER_NOT_FOUND", async () => {
    const deps = {
      storage: createInMemoryMediaStorage(),
      ...withListing(HASH, contentBrokerFixture({ id: "otro-corredor" })),
    };
    await expect(
      buildPublishInput(deps, {
        publication: publication({
          platform: "portal_inmobiliario",
          mediaIds: ["m-1"],
          listingSourceHash: HASH,
        }),
        content: content({ platform: "portal_inmobiliario", title: "Depto" }),
        media: listingMedia,
      }),
    ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND" });
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
        { storage, ...NO_LISTING },
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
          { storage: createInMemoryMediaStorage(), ...NO_LISTING },
          { publication: publication(), content: other, media: listingMedia },
        ),
      ).rejects.toMatchObject({ code: "PUBLICATION_CONTENT_MISMATCH", retriable: false });
    }
  });

  it("un texto que ya no está aprobado es CONTENT_NOT_APPROVED", async () => {
    for (const status of ["draft", "edited"] as const) {
      await expect(
        buildPublishInput(
          { storage: createInMemoryMediaStorage(), ...NO_LISTING },
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
        { storage, ...NO_LISTING },
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
      { storage: createInMemoryMediaStorage(), ...NO_LISTING },
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

describe("publishAttemptRecord con el aviso (F4-T13)", () => {
  it("registra el aviso enviado y el contacto con el WhatsApp enmascarado", async () => {
    const input = await buildPublishInput(
      { storage: createInMemoryMediaStorage(), ...withListing() },
      {
        publication: publication({
          platform: "portal_inmobiliario",
          mediaIds: ["m-1"],
          listingSourceHash: HASH,
        }),
        content: content({ platform: "portal_inmobiliario", title: "Depto" }),
        media: listingMedia,
      },
    );
    const record = publishAttemptRecord(input, { id: "account-1", displayName: "CORREDORA" });

    expect(record.listing).toEqual(input.listing);
    expect(record.brokerContact).toEqual({
      name: BROKER.name,
      email: BROKER.email,
      whatsapp: "+56 9 ****2222",
    });
    const text = JSON.stringify(record);
    expect(text).not.toContain("1111 2222");
    expect(text).not.toContain("memory://");
    expect(text).not.toContain(LISTING.internalNotes ?? "-");
  });

  it.each([
    ["+56 9 1111 2222", "+56 9 ****2222"],
    ["+56911112222", "+56 9 ****2222"],
    ["912345678", "****5678"],
    ["+1 (555) 010-9999", "****9999"],
  ])("maskWhatsapp(%s) → %s", (whatsapp, masked) => {
    expect(maskWhatsapp(whatsapp)).toBe(masked);
  });

  it("maskWhatsapp(null) es null", () => {
    expect(maskWhatsapp(null)).toBeNull();
  });
});
