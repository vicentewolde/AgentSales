import { describe, expect, it } from "vitest";
import type { Media } from "../media.js";
import {
  composeCarousel,
  composePhotoSet,
  composeReel,
  coverPhoto,
  isPhotoReel,
  reelPhotos,
} from "./compose.js";
import { photoReelInput, photoReelPath, reelPath, renderPath, variantPath } from "./media-keys.js";

let next = 0;
const item = (overrides: Partial<Media>): Media => ({
  id: `m${++next}`,
  listingId: "l",
  postId: null,
  brokerId: "b",
  kind: "image",
  role: "original",
  variant: null,
  parentMediaId: null,
  storagePath: `p${next}`,
  mime: "image/jpeg",
  width: null,
  height: null,
  durationS: null,
  bytes: 1,
  checksum: `c${next}`,
  sortOrder: 0,
  isCover: false,
  ...overrides,
});

/** Fotos en orden, con sus variantes `ig_4x5` y `pi_4x3`, y los renders. */
function listingMedia(photos: number, options: { coverIndex?: number; renders?: boolean } = {}) {
  const media: Media[] = [];
  for (let i = 0; i < photos; i += 1) {
    const original = item({ sortOrder: i, isCover: i === options.coverIndex });
    media.push(
      original,
      item({ role: "processed", variant: "ig_4x5", parentMediaId: original.id }),
      item({ role: "processed", variant: "pi_4x3", parentMediaId: original.id }),
    );
  }
  if (options.renders !== false) {
    media.push(
      item({ role: "rendered", variant: "cover" }),
      item({ role: "rendered", variant: "spec_sheet" }),
    );
  }
  return media;
}

const parentsOf = (media: readonly Media[], items: readonly Media[]) =>
  items.map((x) =>
    x.role === "rendered" ? x.variant : media.findIndex((m) => m.id === x.parentMediaId),
  );

describe("composeCarousel", () => {
  it("portada, fotos ig_4x5 en orden sin la de portada, y la ficha al final", () => {
    const media = listingMedia(4, { coverIndex: 1 });
    const carousel = composeCarousel(media);
    const originals = media.filter((m) => m.role === "original");

    expect(carousel[0]?.variant).toBe("cover");
    expect(carousel.at(-1)?.variant).toBe("spec_sheet");
    expect(carousel.slice(1, -1).map((m) => m.parentMediaId)).toEqual(
      [originals[0], originals[2], originals[3]].map((o) => o?.id),
    );
    expect(parentsOf(media, carousel)).toHaveLength(5);
  });

  it("como máximo 10 elementos: 8 fotos más la portada y la ficha", () => {
    const carousel = composeCarousel(listingMedia(15));
    expect(carousel).toHaveLength(10);
    expect(carousel.filter((m) => m.variant === "ig_4x5")).toHaveLength(8);
  });

  it("con portada y sin ficha: la portada y hasta 9 fotos", () => {
    const media = listingMedia(12).filter((m) => m.variant !== "spec_sheet");
    const carousel = composeCarousel(media);
    expect(carousel).toHaveLength(10);
    expect(carousel[0]?.variant).toBe("cover");
    expect(carousel.filter((m) => m.variant === "ig_4x5")).toHaveLength(9);
  });

  it("sin renders, solo las fotos (incluida la de portada)", () => {
    const carousel = composeCarousel(listingMedia(3, { renders: false }));
    expect(carousel.map((m) => m.variant)).toEqual(["ig_4x5", "ig_4x5", "ig_4x5"]);
  });
});

describe("composePhotoSet y coverPhoto", () => {
  it("las pi_4x3, la portada primero y luego el orden del aviso", () => {
    const media = listingMedia(3, { coverIndex: 2 });
    const originals = media.filter((m) => m.role === "original");
    expect(composePhotoSet(media).map((m) => m.parentMediaId)).toEqual(
      [originals[2], originals[0], originals[1]].map((o) => o?.id),
    );
  });

  it("sin foto marcada, la portada es la primera", () => {
    const media = listingMedia(2);
    expect(coverPhoto(media)?.id).toBe(media.find((m) => m.role === "original")?.id);
  });
});

describe("composeReel", () => {
  it("el reel del primer video; si es de otro video, no cuenta", () => {
    const first = item({ kind: "video", sortOrder: 0 });
    const second = item({ kind: "video", sortOrder: 1 });
    const reelOfSecond = item({
      kind: "video",
      role: "processed",
      variant: "ig_reel",
      parentMediaId: second.id,
    });
    expect(composeReel([first, second, reelOfSecond])).toBeNull();

    const reelOfFirst = item({
      kind: "video",
      role: "processed",
      variant: "ig_reel",
      parentMediaId: first.id,
    });
    expect(composeReel([first, second, reelOfFirst])?.id).toBe(reelOfFirst.id);
    expect(isPhotoReel([first, second, reelOfFirst], reelOfFirst)).toBe(false);
  });

  it("sin video, el reel con fotos de la primera foto del reel (la portada), si hay 3 o más", () => {
    const media = listingMedia(3, { coverIndex: 2 });
    const originals = media.filter((m) => m.role === "original");
    const cover = originals[2] as Media;
    const reelOfCover = item({
      kind: "video",
      role: "processed",
      variant: "ig_reel",
      parentMediaId: cover.id,
    });
    expect(composeReel([...media, reelOfCover])?.id).toBe(reelOfCover.id);
    expect(isPhotoReel([...media, reelOfCover], reelOfCover)).toBe(true);

    // El de otra foto (una portada anterior) no cuenta.
    const reelOfOther = { ...reelOfCover, parentMediaId: originals[0]?.id ?? null };
    expect(composeReel([...media, reelOfOther])).toBeNull();

    // Con video, manda el video aunque haya un reel con fotos.
    const video = item({ kind: "video", sortOrder: 9 });
    expect(composeReel([...media, reelOfCover, video])).toBeNull();
  });
});

describe("reelPhotos", () => {
  it("las fotos procesadas, la portada primero y luego el orden, hasta 10", () => {
    const media = listingMedia(12, { coverIndex: 3 });
    const originals = media.filter((m) => m.role === "original");
    const photos = reelPhotos(media);

    expect(photos).toHaveLength(10);
    expect(photos.map((p) => originals.indexOf(p))).toEqual([3, 0, 1, 2, 4, 5, 6, 7, 8, 9]);
  });

  it("no cuenta una foto sin ig_4x5, y con menos de 3 no hay fotos para el reel", () => {
    const media = listingMedia(3);
    const firstOriginal = media.find((m) => m.role === "original");
    const withoutFirst = media.filter(
      (m) => !(m.variant === "ig_4x5" && m.parentMediaId === firstOriginal?.id),
    );
    expect(reelPhotos(media)).toHaveLength(3);
    expect(reelPhotos(withoutFirst)).toEqual([]);
    expect(reelPhotos(listingMedia(2))).toEqual([]);
  });
});

describe("claves de R2", () => {
  const ids = { brokerId: "b1", listingId: "l1" };
  it("variantes, reel y renders con su forma del spec (§4.2)", () => {
    expect(variantPath(ids, "ig_4x5", "abc", "1")).toBe(
      "brokers/b1/listings/l1/processed/ig_4x5/abc-v1.jpg",
    );
    expect(reelPath(ids, "vid", "txt")).toBe(
      "brokers/b1/listings/l1/processed/ig_reel/vid-txt.mp4",
    );
    expect(renderPath(ids, "cover", "in")).toBe("brokers/b1/listings/l1/rendered/cover/in.jpg");
    expect(photoReelPath(ids, "fotos", "txt")).toBe(
      "brokers/b1/listings/l1/processed/ig_reel/photos-fotos-txt.mp4",
    );
  });

  it("la entrada del reel con fotos dice que sale de fotos y cambia con el orden", () => {
    expect(photoReelInput(["a", "b", "c"])).toBe('{"photos":["a","b","c"],"source":"photos"}');
    expect(photoReelInput(["b", "a", "c"])).not.toBe(photoReelInput(["a", "b", "c"]));
  });
});
