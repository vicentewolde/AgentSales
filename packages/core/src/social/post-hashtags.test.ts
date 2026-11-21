import { describe, expect, it } from "vitest";
import { editorialProfileView } from "../editorial-profile.js";
import { buildPostCheckContext, checkPostContent } from "./check.js";
import {
  alwaysHashtagsFor,
  applyHashtagPolicy,
  hashtagPolicy,
  hashtagsOutsideList,
  hashtagWords,
} from "./post-hashtags.js";

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

describe("hashtags por idioma (2026-11-21)", () => {
  const byLanguage = {
    ...profile(["#AgentPey"]),
    hashtagsByLanguage: { es: ["ia", "#chatgpt"], en: ["#AI", "#agents"] },
  };
  const policy = hashtagPolicy(byLanguage, { fixedHashtags: [] });

  it("los de todos los idiomas primero y después los del idioma del texto", () => {
    expect(policy.byLanguage).toEqual({ es: ["#ia", "#chatgpt"], en: ["#AI", "#agents"] });
    expect(alwaysHashtagsFor(policy, "es")).toEqual(["#AgentPey", "#ia", "#chatgpt"]);
    expect(alwaysHashtagsFor(policy, "en")).toEqual(["#AgentPey", "#AI", "#agents"]);
    expect(alwaysHashtagsFor(policy)).toEqual(["#AgentPey"]);
    expect(applyHashtagPolicy("x", [], policy, "en")).toEqual(["#AgentPey", "#AI", "#agents"]);
    expect(applyHashtagPolicy("discord", [], policy, "en")).toEqual([]);
  });

  it("solo con hashtags de un idioma, la IA tampoco agrega otros por defecto", () => {
    const only = hashtagPolicy(
      { ...profile([]), hashtagsByLanguage: { en: ["#AI"] } },
      { fixedHashtags: [] },
    );
    expect(only.aiMayAdd).toBe(false);
    // Sin ninguno por idioma, la regla es la de siempre (sin el campo).
    expect(hashtagPolicy(profile([]), { fixedHashtags: [] })).toEqual({
      always: [],
      aiMayAdd: true,
    });
  });

  it("la revisión: #AI no es aviso en inglés, pero #ia sí lo es en inglés", () => {
    expect(hashtagsOutsideList(["#AgentPey", "#AI"], policy, "en")).toEqual([]);
    expect(hashtagsOutsideList(["#AgentPey", "#ia"], policy, "en")).toEqual(["#ia"]);
    expect(hashtagsOutsideList(["#ia"], policy, "es")).toEqual([]);
    const ctx = buildPostCheckContext({
      post: {
        kind: "text",
        topic: "Tema",
        brief: null,
        briefOrigin: "operator",
        source: "manual",
        xLinkAllowed: false,
      },
      profile: byLanguage,
      broker: { brandName: "AgentPey", fixedHashtags: [] },
      media: [],
    });
    expect(
      checkPostContent(
        "x",
        { body: "Hoy les cuento algo.", hashtags: ["#AgentPey", "#AI"], language: "en" },
        ctx,
      ),
    ).toEqual([]);
    expect(
      checkPostContent(
        "x",
        { body: "Hoy les cuento algo.", hashtags: ["#AgentPey", "#ia"], language: "en" },
        ctx,
      ).map((check) => check.code),
    ).toEqual(["HASHTAG_NOT_IN_LIST"]);
  });
});

describe("hashtagWords: un hashtag pegado en palabras (2026-11-21)", () => {
  it("separa CamelCase, siglas, números y guiones bajos", () => {
    expect(hashtagWords("#BlackFriday")).toBe("Black Friday");
    expect(hashtagWords("#AIAgents")).toBe("AI Agents");
    expect(hashtagWords("#Web3")).toBe("Web 3");
    expect(hashtagWords("#CyberDay2026")).toBe("Cyber Day 2026");
    expect(hashtagWords("#cyber_monday")).toBe("cyber monday");
    expect(hashtagWords("#ÑuñoaCentro")).toBe("Ñuñoa Centro");
    expect(hashtagWords("#blackfriday")).toBe("blackfriday");
  });

  it("la revisión no marca «Black Friday» si #BlackFriday es un hashtag fijo", () => {
    const ctx = buildPostCheckContext({
      post: {
        kind: "text",
        topic: "Tema",
        brief: null,
        briefOrigin: "operator",
        source: "manual",
        xLinkAllowed: false,
      },
      profile: profile(["#BlackFriday", "#CyberDay2026"], true),
      broker: { brandName: "AgentPey", fixedHashtags: [] },
      media: [],
    });
    expect(
      checkPostContent(
        "linkedin",
        { body: "Se viene el Black Friday y el Cyber Day 2026.", hashtags: [] },
        ctx,
      ),
    ).toEqual([]);
    // Un nombre que no está en ninguna fuente sigue marcándose.
    expect(
      checkPostContent("linkedin", { body: "Se viene el Prime Day.", hashtags: [] }, ctx).map(
        (check) => check.code,
      ),
    ).toEqual(["FACT_NOT_IN_PROFILE"]);
  });
});
