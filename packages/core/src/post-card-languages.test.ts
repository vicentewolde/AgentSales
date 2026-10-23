import { describe, expect, it } from "vitest";
import type { Language } from "./enums.js";
import type { Media } from "./media.js";
import {
  type CardLanguages,
  cardLanguagesOf,
  hiddenCardIds,
  loadCardLanguages,
  mediaForLanguage,
} from "./post-card-languages.js";
import type { PostImageRequest, PostImageRun } from "./post-image.js";
import {
  createInMemoryMediaRepository,
  createInMemoryPlatformAccountRepository,
  createInMemoryPostImageRunRepository,
  createInMemoryPublicationRepository,
} from "./testing/index.js";
import { planPostPublications } from "./use-cases/open-publications.js";

// F9.5 (arreglo del idioma de las tarjetas): cada pedido de tarjetas es de un idioma, y la
// publicación de cada texto toma las tarjetas de su idioma. Sin columna nueva: el idioma de un
// medio sale de los pedidos terminados del post.

const run = (
  mediaIds: string[],
  language: Language | undefined,
  overrides: Partial<Pick<PostImageRun, "source" | "status">> = {},
): Pick<PostImageRun, "source" | "status" | "request" | "mediaIds"> => ({
  source: "card",
  status: "succeeded",
  request: {
    source: "card",
    format: "4:5",
    ...(language === undefined ? {} : { language }),
  } satisfies PostImageRequest,
  mediaIds,
  ...overrides,
});

describe("cardLanguagesOf", () => {
  it("cada medio recibe el idioma de su pedido; el compartido (el cierre) recibe los dos", () => {
    const cards = cardLanguagesOf([
      run(["cover-es", "closing"], "es"),
      run(["cover-en", "closing"], "en"),
    ]);
    expect(cards.get("cover-es")).toEqual(["es"]);
    expect(cards.get("cover-en")).toEqual(["en"]);
    expect(cards.get("closing")).toEqual(["es", "en"]);
  });

  it("un pedido anterior al idioma deja la tarjeta sin idioma conocido", () => {
    expect(cardLanguagesOf([run(["old"], undefined)]).get("old")).toEqual([]);
  });

  it("ignora lo que no son tarjetas terminadas (otra fuente, en curso o fallido)", () => {
    const ignored = [
      run(["stock"], "es", { source: "stock" }),
      run(["running"], "es", { status: "running" }),
      run(["failed"], "es", { status: "failed" }),
    ];
    expect(cardLanguagesOf(ignored).size).toBe(0);
  });

  it("sin repositorio, nada se separa por idioma", async () => {
    expect((await loadCardLanguages(undefined, "post-1")).size).toBe(0);
  });
});

describe("hiddenCardIds", () => {
  const ids = ["foto", "cover-es", "cover-en", "closing"];
  const cards: CardLanguages = new Map<string, readonly Language[]>([
    ["cover-es", ["es"]],
    ["cover-en", ["en"]],
    ["closing", ["es", "en"]],
  ]);

  it("cada idioma esconde las tarjetas del otro; la foto del usuario nunca", () => {
    expect([...hiddenCardIds(ids, cards, "es")]).toEqual(["cover-en"]);
    expect([...hiddenCardIds(ids, cards, "en")]).toEqual(["cover-es"]);
  });

  it("sin tarjetas de su idioma, usa las únicas que haya, sin mezclar", () => {
    const onlyEnglish: CardLanguages = new Map([
      ["cover-en", ["en"]],
      ["closing", ["en"]],
    ]);
    expect(hiddenCardIds(ids, onlyEnglish, "es").size).toBe(0);
  });

  it("las de un pedido anterior al idioma sirven a un idioma sin tarjetas, pero no a uno que ya tiene", () => {
    const mixed: CardLanguages = new Map<string, readonly Language[]>([
      ["old", []],
      ["cover-en", ["en"]],
    ]);
    // El español no tiene: usa las sin idioma, no las del inglés.
    expect([...hiddenCardIds(["old", "cover-en"], mixed, "es")]).toEqual(["cover-en"]);
    // El inglés ya tiene las suyas: las sin idioma no se mezclan.
    expect([...hiddenCardIds(["old", "cover-en"], mixed, "en")]).toEqual(["old"]);
  });

  it("el cierre que comparten dos idiomas no cuenta como tarjeta propia: sin otra, usa las únicas que haya", () => {
    // Se quitaron las tarjetas en español: solo queda el cierre [es, en] y las del inglés.
    const left: CardLanguages = new Map<string, readonly Language[]>([
      ["cover-en", ["en"]],
      ["closing", ["es", "en"]],
    ]);
    expect(hiddenCardIds(ids, left, "es").size).toBe(0);
    expect([...hiddenCardIds(ids, left, "en")]).toEqual([]);
    // Con una sola imagen compartida y las de otro idioma, el español no queda con solo el cierre.
    const both: CardLanguages = new Map<string, readonly Language[]>([
      ["cover-es", ["es"]],
      ["cover-en", ["en"]],
      ["closing", ["es", "en"]],
    ]);
    expect([...hiddenCardIds(ids, both, "es")]).toEqual(["cover-en"]);
  });

  it("sin tarjetas en el post, no esconde nada", () => {
    expect(hiddenCardIds(ids, new Map(), "es").size).toBe(0);
  });
});

describe("mediaForLanguage", () => {
  const media = (id: string, parentMediaId: string | null): Media => ({
    id,
    listingId: null,
    postId: "p1",
    brokerId: "b1",
    kind: "image",
    role: parentMediaId === null ? "original" : "processed",
    variant: parentMediaId === null ? null : "ig_4x5",
    parentMediaId,
    storagePath: `posts/p1/${id}.jpg`,
    mime: "image/jpeg",
    width: null,
    height: null,
    durationS: null,
    bytes: 1,
    checksum: id,
    sortOrder: 0,
    isCover: false,
  });

  it("quita las tarjetas del otro idioma con sus variantes", () => {
    const all = [media("a", null), media("a-4x5", "a"), media("b", null), media("b-4x5", "b")];
    const cards: CardLanguages = new Map<string, readonly Language[]>([
      ["a", ["es"]],
      ["b", ["en"]],
    ]);
    expect(mediaForLanguage(all, cards, "es").map((item) => item.id)).toEqual(["a", "a-4x5"]);
    expect(mediaForLanguage(all, cards, "en").map((item) => item.id)).toEqual(["b", "b-4x5"]);
  });
});

describe("planPostPublications: cada texto toma las tarjetas de su idioma", () => {
  async function setup(options: { runs: ("es" | "en" | "old")[] } = { runs: ["es", "en"] }) {
    const media = createInMemoryMediaRepository();
    const platformAccounts = createInMemoryPlatformAccountRepository();
    const publications = createInMemoryPublicationRepository();
    const postImageRuns = createInMemoryPostImageRunRepository();
    await platformAccounts.upsertConnected({
      brokerId: "b1",
      platform: "x",
      externalAccountId: "x-1",
      displayName: "@marca",
      tokenExpiresAt: null,
      meta: {},
      credentials: { accessToken: "token-de-prueba", refreshToken: "refresh-de-prueba" },
    });
    const post = {
      id: "p1",
      brokerId: "b1",
      kind: "carousel" as const,
      platforms: null,
    };
    // Una foto del usuario (sin tarjeta) y, por cada pedido, su tarjeta con su variante 4:5.
    const makeImage = async (name: string, sortOrder: number) => {
      const original = await media.create({
        listingId: null,
        postId: "p1",
        brokerId: "b1",
        kind: "image",
        storagePath: `posts/p1/original/${name}.jpg`,
        mime: "image/jpeg",
        bytes: 1,
        checksum: name.padEnd(64, "0"),
        sortOrder,
        isCover: false,
      });
      await media.upsertDerivative({
        role: "processed",
        variant: "ig_4x5",
        parentMediaId: original.id,
        postId: "p1",
        brokerId: "b1",
        kind: "image",
        storagePath: `posts/p1/ig_4x5/${name}.jpg`,
        mime: "image/jpeg",
        bytes: 1,
        checksum: `${name}-4x5`.padEnd(64, "0"),
        width: 1080,
        height: 1350,
        durationS: null,
      });
      return original.id;
    };
    const upload = await makeImage("subida", 0);
    const byRun: Record<string, string[]> = {};
    let order = 1;
    for (const which of options.runs) {
      const ids = [
        await makeImage(`cover-${which}`, order++),
        await makeImage(`punto-${which}`, order++),
      ];
      byRun[which] = ids;
      const created = await postImageRuns.create({
        postId: "p1",
        brokerId: "b1",
        source: "card",
        request: {
          source: "card",
          format: "4:5",
          ...(which === "old" ? {} : { language: which }),
        },
        createdBy: null,
      });
      await postImageRuns.markRunning(created.id);
      await postImageRuns.markSucceeded(created.id, ids);
    }
    const plan = async (language: Language) => {
      const content = { id: `c-${language}`, platform: "x", language } as never;
      const opening = await planPostPublications(
        { platformAccounts, media, publications, postImageRuns },
        { post: post as never, content },
      );
      return opening.toCreate.map((item) => item.mediaIds);
    };
    return { plan, upload, byRun, media };
  }

  const variantsOf = async (
    media: Awaited<ReturnType<typeof setup>>["media"],
    originals: string[],
  ) => {
    const all = await media.listBySubject({ kind: "post", id: "p1" });
    return originals.map((id) => all.find((item) => item.parentMediaId === id)?.id);
  };

  it("el texto en español lleva sus tarjetas y el en inglés las suyas; la foto del usuario va en los dos", async () => {
    const s = await setup();
    const [es] = await s.plan("es");
    const [en] = await s.plan("en");
    const esExpected = await variantsOf(s.media, [s.upload, ...(s.byRun.es ?? [])]);
    const enExpected = await variantsOf(s.media, [s.upload, ...(s.byRun.en ?? [])]);
    expect(es).toEqual(esExpected);
    expect(en).toEqual(enExpected);
    expect(es).not.toEqual(en);
  });

  it("sin tarjetas de su idioma, usa las únicas que haya, sin mezclar", async () => {
    const s = await setup({ runs: ["en"] });
    const [es] = await s.plan("es");
    expect(es).toEqual(await variantsOf(s.media, [s.upload, ...(s.byRun.en ?? [])]));
  });

  it("las tarjetas de un pedido anterior al idioma sirven al idioma que no tiene las suyas", async () => {
    const s = await setup({ runs: ["old", "en"] });
    const [es] = await s.plan("es");
    expect(es).toEqual(await variantsOf(s.media, [s.upload, ...(s.byRun.old ?? [])]));
    const [en] = await s.plan("en");
    expect(en).toEqual(await variantsOf(s.media, [s.upload, ...(s.byRun.en ?? [])]));
  });
});
