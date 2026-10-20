import type { ContentView } from "@agentsales/api/contracts";
import { describe, expect, it } from "vitest";
import { approvedPlatforms } from "./PostPublishing.js";

// F9-T21: publicar solo ofrece las redes con texto aprobado que están entre las del post.

const text = (platform: ContentView["platform"], status: ContentView["status"]) =>
  ({ platform, status, language: "es" }) as ContentView;

describe("approvedPlatforms", () => {
  const contents = [
    text("discord", "approved"),
    text("x", "approved"),
    text("x", "approved"),
    text("linkedin", "draft"),
  ];

  it("sin el post, las redes con un texto aprobado, sin repetir y en orden", () => {
    expect(approvedPlatforms(contents)).toEqual(["discord", "x"]);
  });

  it("con el post, solo las suyas: una red quitada no se ofrece", () => {
    expect(approvedPlatforms(contents, { platforms: null })).toEqual(["discord", "x"]);
    expect(approvedPlatforms(contents, { platforms: ["x", "linkedin"] })).toEqual(["x"]);
    expect(approvedPlatforms(contents, { platforms: ["linkedin"] })).toEqual([]);
  });
});
