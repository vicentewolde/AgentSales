import type { ContentMedia, ListingContentResponse } from "@agentsales/api/contracts";
import { describe, expect, it } from "vitest";
import { createColors } from "../colors.js";
import { renderContentMedia } from "./content-view.js";

const plain = createColors(false);

const reel: ContentMedia = {
  id: "media-reel",
  variant: "ig_reel",
  mime: "video/mp4",
  width: 1080,
  height: 1920,
  durationS: 9,
  url: "https://r2.test/reel.mp4",
};

const content = (overrides: Partial<ListingContentResponse> = {}): ListingContentResponse => ({
  contents: [],
  carousel: [],
  photos: [],
  reel: null,
  reelFromPhotos: false,
  latestRun: null,
  portalReadiness: { ready: true, issues: [] },
  marketplaceReadiness: { ready: true, issues: [] },
  ...overrides,
});

describe("renderContentMedia: el reel", () => {
  it("sin reel, del video o armado con las fotos (F9.5-T18)", () => {
    expect(renderContentMedia(content(), plain)).toContain("· Reel: no");
    expect(renderContentMedia(content({ reel }), plain)).toMatch(/· Reel: sí$/m);
    expect(renderContentMedia(content({ reel, reelFromPhotos: true }), plain)).toContain(
      "· Reel: sí, armado con tus fotos",
    );
  });
});
