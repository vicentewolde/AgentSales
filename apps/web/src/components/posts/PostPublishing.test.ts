import type { ContentView } from "@agentsales/api/contracts";
import { describe, expect, it } from "vitest";
import { approvedPlatforms, platformsWithoutAccount } from "./PostPublishing.js";

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

describe("platformsWithoutAccount (ensayo de la demo de F9)", () => {
  const account = (
    platform: "discord" | "x" | "linkedin",
    status: "connected" | "expired" = "connected",
    brokerId = "marca",
  ) => ({ brokerId, platform, status });

  it("las redes sin una cuenta conectada de la marca; mientras no se saben las cuentas, ninguna", () => {
    const platforms = ["discord", "x", "linkedin"] as const;
    expect(platformsWithoutAccount(platforms, undefined, "marca")).toEqual([]);
    expect(platformsWithoutAccount(platforms, [], "marca")).toEqual(["discord", "x", "linkedin"]);
    expect(
      platformsWithoutAccount(
        platforms,
        [account("discord"), account("x", "expired"), account("linkedin", "connected", "otra")],
        "marca",
      ),
    ).toEqual(["x", "linkedin"]);
  });
});
