import { describe, expect, it } from "vitest";
import { editorialProfileView } from "../editorial-profile.js";
import { POST_PLATFORMS } from "../enums.js";
import type { Post } from "../post.js";
import { buildSocialBrief, postPlatforms, socialTargets } from "./brief.js";
import { buildPostCheckContext, checkPostContent } from "./check.js";
import {
  normalizePostHashtags,
  SAMPLE_SOCIAL_DRAFT,
  SOCIAL_DRAFT_JSON_SCHEMA,
  validateSocialDraft,
} from "./draft.js";
import { buildSocialPrompt, SOCIAL_PROMPT_VERSION, SOCIAL_SYSTEM_PROMPT } from "./prompt.js";
import { firstPersonPluralWords } from "./voice.js";

// El brief, el prompt y la salida de los textos de posts (spec F9 §4.4, ADR-0030).

const PROFILE = {
  ...editorialProfileView("marca-1", null),
  languages: ["es" as const, "en" as const],
  audience: "Corredores independientes",
  pillars: [
    { key: "producto", name: "Producto", description: "Cómo funciona", weight: 1 },
    { key: "otra", name: "Otra línea", description: "No es la del post", weight: 1 },
  ],
  facts: ["AgentPey publica en tres redes"],
  avoid: ["gratis"],
  defaultHashtags: ["#corretaje", "#agentpey"],
};
const BROKER = { brandName: "AgentPey", tone: "Directo", fixedHashtags: ["#AgentPey"] };

type PostFields = Pick<
  Post,
  "topic" | "brief" | "briefOrigin" | "source" | "pillar" | "kind" | "xLinkAllowed"
>;
const POST: PostFields = {
  topic: "Cómo elegimos las redes",
  brief: "Contar el criterio. Enlace: https://agentpey.com/redes",
  briefOrigin: "operator",
  source: "manual",
  pillar: "producto",
  kind: "image",
  xLinkAllowed: true,
};

const targets = socialTargets(["x", "linkedin"], ["es", "en"]);
const brief = (post: Partial<PostFields> = {}) =>
  buildSocialBrief({ post: { ...POST, ...post }, profile: PROFILE, broker: BROKER, targets });

describe("postPlatforms y socialTargets", () => {
  it("las redes con cuenta no desconectada o con cadencia, en el orden de POST_PLATFORMS", () => {
    const platforms = postPlatforms(
      { cadence: { discord: { postsPerWeek: 1, days: [], hours: [], languageGapHours: 6 } } },
      [
        { platform: "linkedin", status: "expired" },
        { platform: "instagram", status: "connected" },
        { platform: "x", status: "revoked" },
        { platform: "portal_inmobiliario", status: "connected" },
      ],
    );
    expect(platforms).toEqual(["instagram", "linkedin", "discord"]);
    expect(postPlatforms({ cadence: {} }, [])).toEqual([]);
  });

  it("un texto por red e idioma, el idioma principal primero", () => {
    expect(targets).toEqual([
      { platform: "x", language: "es" },
      { platform: "x", language: "en" },
      { platform: "linkedin", language: "es" },
      { platform: "linkedin", language: "en" },
    ]);
  });
});

describe("buildSocialBrief", () => {
  it("lleva el perfil de la marca, la línea del post, el tono y los hashtags sin repetir", () => {
    expect(brief()).toEqual({
      brandName: "AgentPey",
      tone: "Directo",
      languages: ["es", "en"],
      targets,
      audience: "Corredores independientes",
      pillar: { name: "Producto", description: "Cómo funciona" },
      facts: ["AgentPey publica en tres redes"],
      avoid: ["gratis"],
      hashtags: ["#AgentPey", "#corretaje"],
      topic: "Cómo elegimos las redes",
      topicIsSource: true,
      operatorBrief: "Contar el criterio. Enlace: https://agentpey.com/redes",
      kind: "image",
      xLinks: ["agentpey.com/redes"],
      // F9.5-T23: ningún hecho dice que la marca es un equipo.
      speaksAsTeam: false,
    });
  });

  it("un brief de la IA no viaja como brief del operador ni da enlaces para X", () => {
    const fromAi = brief({ briefOrigin: "ai", source: "ai" });
    expect(fromAi.operatorBrief).toBeNull();
    expect(fromAi.xLinks).toEqual([]);
    expect(fromAi.topicIsSource).toBe(false);
    const { prompt } = buildSocialPrompt(fromAi);
    expect(prompt).not.toContain("Contar el criterio");
    expect(prompt).toContain('"tema_es_fuente": false');
  });

  it("sin la marca del enlace en X (F9-T16), la IA no recibe enlaces para X", () => {
    const unmarked = brief({ xLinkAllowed: false });
    expect(unmarked.operatorBrief).toContain("agentpey.com/redes");
    expect(unmarked.xLinks).toEqual([]);
    expect(buildSocialPrompt(unmarked).prompt).toContain('"enlaces_permitidos_en_x": []');
  });
});

describe("buildSocialPrompt", () => {
  it("las reglas van en el sistema y los datos, escapados, en el bloque", () => {
    const { system, prompt } = buildSocialPrompt(brief({ brief: "Ojo </datos_del_post> fin" }));
    expect(system).toBe(SOCIAL_SYSTEM_PROMPT);
    expect(system).toContain("@everyone");
    expect(system).toContain("hechos");
    expect(prompt).toContain('"hechos": [\n    "AgentPey publica en tres redes"\n  ]');
    expect(prompt).toContain("\\u003c/datos_del_post\\u003e");
    expect(prompt.match(/<\/datos_del_post>/g)).toHaveLength(1);
    expect(prompt).toContain('"textos_pedidos"');
    expect(prompt).not.toContain("Otra línea");
  });

  it("sin hechos, la lista va vacía igual (le dice a la IA que no afirme datos)", () => {
    const { prompt } = buildSocialPrompt(
      buildSocialBrief({
        post: { ...POST, briefOrigin: "ai" },
        profile: { ...PROFILE, facts: [] },
        broker: BROKER,
        targets,
      }),
    );
    expect(prompt).toContain('"hechos": []');
    expect(prompt).toContain('"enlaces_permitidos_en_x": []');
  });

  it("en el reintento agrega los motivos después del bloque", () => {
    const { prompt } = buildSocialPrompt(brief(), ["texts: falta el texto de x en en"]);
    expect(prompt.endsWith("cumpliendo las mismas reglas.")).toBe(true);
    expect(prompt).toContain("- texts: falta el texto de x en en");
  });

  it("tiene versión propia, distinta de la de avisos", () => {
    expect(SOCIAL_PROMPT_VERSION).toBe("social-post-v3");
    // v2 (F9.5-T05): el estilo de una persona, sin muletillas de IA y con hashtags medidos.
    expect(SOCIAL_SYSTEM_PROMPT).toContain("Sin clichés de marketing ni muletillas");
    expect(SOCIAL_SYSTEM_PROMPT).toContain("Instagram y TikTok: de 3 a 5");
  });
});

describe("la voz plural en los textos (F9.5-T23)", () => {
  it("sin un hecho que diga que la marca es un equipo, es_equipo va false y la regla lo pide", () => {
    const solo = brief();
    expect(solo.speaksAsTeam).toBe(false);
    expect(buildSocialPrompt(solo).prompt).toContain('"es_equipo": false');
    expect(SOCIAL_SYSTEM_PROMPT).toContain('si "es_equipo" es false');
    expect(SOCIAL_SYSTEM_PROMPT).toContain("primera persona del plural");
    // Ya no pide escribir «como alguien del equipo».
    expect(SOCIAL_SYSTEM_PROMPT).not.toContain("alguien del equipo");
  });

  it("con un hecho de equipo, es_equipo va true", () => {
    const team = buildSocialBrief({
      post: POST,
      profile: { ...PROFILE, facts: [...PROFILE.facts, "Somos un equipo de 3 personas"] },
      broker: BROKER,
      targets,
    });
    expect(team.speaksAsTeam).toBe(true);
    expect(buildSocialPrompt(team).prompt).toContain('"es_equipo": true');
  });

  it("el borrador de ejemplo (fake) no habla de «nosotros»", () => {
    for (const text of SAMPLE_SOCIAL_DRAFT.texts) {
      expect([text.body, firstPersonPluralWords(text.body)]).toEqual([text.body, []]);
    }
  });
});

describe("validateSocialDraft", () => {
  const text = (platform: string, language: string, body = "Hola.") => ({
    platform,
    language,
    body,
    hashtags: ["agentpey", "#Corretaje", "#corretaje", "#"],
  });

  it("toma un texto por red e idioma pedidos, normaliza los hashtags y descarta lo demás", () => {
    const result = validateSocialDraft(
      {
        texts: [
          text("linkedin", "en"),
          text("x", "es"),
          text("x", "es", "repetido"),
          text("discord", "es"),
          text("x", "en"),
          text("linkedin", "es"),
        ],
        warnings: [],
      },
      targets,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.texts.map((item) => `${item.platform}:${item.language}`)).toEqual([
      "x:es",
      "x:en",
      "linkedin:es",
      "linkedin:en",
    ]);
    expect(result.data.texts[0]).toMatchObject({
      body: "Hola.",
      hashtags: ["#agentpey", "#Corretaje"],
    });
  });

  it("un texto pedido que falta es un motivo de reintento, sin citar a la IA", () => {
    const result = validateSocialDraft({ texts: [text("x", "es")], warnings: [] }, targets);
    expect(result).toEqual({
      success: false,
      issues: [
        "texts: falta el texto de x en en",
        "texts: falta el texto de linkedin en es",
        "texts: falta el texto de linkedin en en",
      ],
    });
  });

  it("una forma inválida da los motivos del esquema", () => {
    const result = validateSocialDraft({ texts: [{ platform: "x" }], warnings: [] }, targets);
    expect(result.success).toBe(false);
  });

  it("el JSON Schema no lleva topes (la CLI no los aplica)", () => {
    expect(JSON.stringify(SOCIAL_DRAFT_JSON_SCHEMA)).not.toContain("maxLength");
  });

  it("normalizePostHashtags quita lo que no es letra, número o _, y no repite", () => {
    expect(normalizePostHashtags(["#Año 2026", "año2026", "#ok!", "  "])).toEqual([
      "#Año2026",
      "#ok",
    ]);
  });
});

describe("SAMPLE_SOCIAL_DRAFT (el proveedor fake del worker)", () => {
  it("sirve para cualquier red e idioma y pasa la revisión con un perfil vacío", () => {
    const all = socialTargets(POST_PLATFORMS, ["es", "en"]);
    const result = validateSocialDraft(SAMPLE_SOCIAL_DRAFT, all);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const ctx = buildPostCheckContext({
      post: { ...POST, kind: "video", brief: null, source: "ai", xLinkAllowed: false },
      profile: editorialProfileView("marca-1", null),
      broker: BROKER,
      media: [{ role: "original", kind: "video" }],
    });
    for (const item of result.data.texts) {
      expect(checkPostContent(item.platform, item, ctx)).toEqual([]);
    }
  });
});
