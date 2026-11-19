import { describe, expect, it } from "vitest";
import { editorialProfileView } from "../editorial-profile.js";
import { buildPostCheckContext, checkPostContent } from "./check.js";
import { applyHashtagPolicy, hashtagPolicy, hashtagsOutsideList } from "./post-hashtags.js";

// «Hashtags que siempre van» (2026-11-15).

const profile = (defaultHashtags: string[], aiHashtags: boolean | null = null) => ({
  ...editorialProfileView("marca-1", null),
  defaultHashtags,
  aiHashtags,
});

describe("hashtagPolicy", () => {
  it("junta los fijos de la marca y los del perfil; por defecto la IA no agrega otros si hay alguno", () => {
    expect(
      hashtagPolicy(profile(["#AgentPey", "agentpey"]), { fixedHashtags: ["#Chile"] }),
    ).toEqual({
      always: ["#Chile", "#AgentPey"],
      aiMayAdd: false,
    });
    expect(hashtagPolicy(profile([]), { fixedHashtags: [] })).toEqual({
      always: [],
      aiMayAdd: true,
    });
    expect(hashtagPolicy(profile(["#AgentPey"], true), { fixedHashtags: [] }).aiMayAdd).toBe(true);
    expect(hashtagPolicy(profile([], false), { fixedHashtags: [] }).aiMayAdd).toBe(false);
  });
});

describe("applyHashtagPolicy", () => {
  const strict = { always: ["#AgentPey"], aiMayAdd: false };
  const open = { always: ["#AgentPey"], aiMayAdd: true };

  it("los que siempre van al final en Instagram, X, LinkedIn y TikTok; nunca en Discord", () => {
    for (const platform of ["instagram", "x", "linkedin", "tiktok"] as const) {
      expect(applyHashtagPolicy(platform, ["#TiendasOnlineChile"], strict)).toEqual(["#AgentPey"]);
    }
    expect(applyHashtagPolicy("discord", ["#TiendasOnlineChile"], strict)).toEqual([]);
  });

  it("si la IA puede agregar otros, van después de los fijos y sin repetir", () => {
    expect(applyHashtagPolicy("instagram", ["#agentpey", "#EcommerceChile"], open)).toEqual([
      "#AgentPey",
      "#EcommerceChile",
    ]);
    expect(applyHashtagPolicy("discord", ["#EcommerceChile"], open)).toEqual(["#EcommerceChile"]);
  });

  it("hashtagsOutsideList: solo cuando la IA no puede agregar otros", () => {
    expect(hashtagsOutsideList(["#agentpey", "#EcommerceChile"], strict)).toEqual([
      "#EcommerceChile",
    ]);
    expect(hashtagsOutsideList(["#EcommerceChile"], open)).toEqual([]);
  });
});

describe("la revisión con hashtags que siempre van", () => {
  const ctx = (aiHashtags: boolean | null) =>
    buildPostCheckContext({
      post: {
        kind: "text",
        topic: "Tema",
        brief: null,
        briefOrigin: "operator",
        source: "manual",
        xLinkAllowed: false,
      },
      profile: profile(["#AgentPey"], aiHashtags),
      broker: { brandName: "AgentPey", fixedHashtags: [] },
      media: [],
    });

  it("un hashtag fuera de la lista es una advertencia si la IA no puede agregar otros", () => {
    const checks = checkPostContent(
      "linkedin",
      { body: "Hoy les cuento algo.", hashtags: ["#AgentPey", "#TiendasOnlineChile"] },
      ctx(null),
    );
    expect(checks.map((check) => [check.code, check.severity])).toEqual([
      ["HASHTAG_NOT_IN_LIST", "warning"],
    ]);
    expect(checks[0]?.message).toContain("#TiendasOnlineChile");
    expect(
      checkPostContent(
        "linkedin",
        { body: "Hoy les cuento algo.", hashtags: ["#AgentPey", "#TiendasOnlineChile"] },
        ctx(true),
      ),
    ).toEqual([]);
  });

  it("si no caben en X, la revisión lo dice (TOO_LONG) sin cortar el texto", () => {
    const body = "a ".repeat(140).trim();
    const checks = checkPostContent("x", { body, hashtags: ["#AgentPey"] }, ctx(null));
    expect(checks.map((check) => check.code)).toEqual(["TOO_LONG"]);
    expect(checks[0]?.message).toContain("contando los hashtags que siempre van (#AgentPey)");
  });
});
