import { describe, expect, it } from "vitest";
import {
  BRAND_KNOWLEDGE_LIMITS,
  knowledgeForPrompt,
  knowledgeSources,
  normalizeBrandKnowledge,
  normalizeKnowledgeSourceText,
  normalizeKnowledgeUpdate,
} from "./brand-knowledge.js";
import type { BrokerData } from "./broker.js";
import { editorialProfileView } from "./editorial-profile.js";
import type { Post } from "./post.js";
import { buildSocialBrief, socialTargets } from "./social/brief.js";
import { buildPostCheckContext, checkPostContent, profileSources } from "./social/check.js";
import { buildPlanBrief } from "./social/plan.js";
import { buildPlanPrompt } from "./social/plan-prompt.js";
import { buildSocialPrompt } from "./social/prompt.js";
import {
  createInMemoryBrandKnowledgeRepository,
  createInMemoryBrokerRepository,
  createInMemoryEditorialProfileRepository,
} from "./testing/index.js";
import {
  addKnowledgeUpdate,
  archiveKnowledgeUpdate,
  editKnowledgeUpdate,
  editorialProfilesWithKnowledge,
  getBrandKnowledge,
  saveBrandKnowledge,
} from "./use-cases/brand-knowledge.js";

// El conocimiento de la marca (spec F9.7 B1 y B3, ADR-0043).

const NOW = new Date("2026-11-15T15:00:00.000Z");
const ADMIN = { role: "admin" as const, brokerId: null };
const brokerUser = (brokerId: string) => ({ role: "broker" as const, brokerId });

const brokerData = (slug: string): BrokerData => ({
  slug,
  name: `Persona ${slug}`,
  brandName: `Marca ${slug}`,
  primaryColor: "#112233",
  secondaryColor: "#112233",
  whatsapp: null,
  email: null,
  instagramHandle: null,
  website: null,
  tone: null,
  fixedHashtags: [],
});

describe("normalizeBrandKnowledge", () => {
  it("recorta, quita los ejemplos vacíos y marca los favoritos", () => {
    expect(
      normalizeBrandKnowledge({
        stance: "  Que los agentes compren con límites.  ",
        tone: "",
        examples: [
          { text: " Un relato con escena ", note: " abre con una escena ", favorite: true },
          { text: "   " },
        ],
      }),
    ).toEqual({
      stance: "Que los agentes compren con límites.",
      tone: null,
      examples: [{ text: "Un relato con escena", note: "abre con una escena", favorite: true }],
    });
  });

  it("rechaza lo que pasa de los topes, con cada campo", () => {
    const long = "a".repeat(BRAND_KNOWLEDGE_LIMITS.stance + 1);
    const error = (() => {
      try {
        normalizeBrandKnowledge({
          stance: long,
          tone: null,
          examples: Array.from({ length: 11 }, () => ({ text: "x" })),
        });
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(error).toMatchObject({ code: "KNOWLEDGE_INVALID" });
    const fields = (error as { details: { issues: { field: string }[] } }).details.issues.map(
      (issue) => issue.field,
    );
    expect(fields).toEqual(["stance", "examples"]);
  });

  it("no acepta caracteres escondidos (viajan al prompt)", () => {
    expect(() =>
      normalizeBrandKnowledge({ stance: "hola‮adiós", tone: null, examples: [] }),
    ).toThrow(expect.objectContaining({ code: "KNOWLEDGE_INVALID" }));
  });
});

describe("normalizeKnowledgeUpdate y el texto largo", () => {
  it("exige proyecto, fecha real y texto", () => {
    expect(
      normalizeKnowledgeUpdate({ project: " AgentPey ", date: "2026-11-10", text: " Salió v2 " }),
    ).toEqual({ project: "AgentPey", date: "2026-11-10", text: "Salió v2" });
    expect(() => normalizeKnowledgeUpdate({ project: "", date: "2026-02-30", text: "" })).toThrow(
      expect.objectContaining({ code: "KNOWLEDGE_INVALID" }),
    );
  });

  it("el texto largo va de 20 a 20.000 caracteres", () => {
    expect(() => normalizeKnowledgeSourceText("corto")).toThrow();
    expect(() => normalizeKnowledgeSourceText("x".repeat(20_001))).toThrow();
    expect(normalizeKnowledgeSourceText("  Notas de la reunión del lunes.  ")).toBe(
      "Notas de la reunión del lunes.",
    );
  });
});

describe("knowledgeForPrompt (B3)", () => {
  const at = (day: string) => new Date(`${day}T12:00:00.000Z`);
  it("postura y tono completos, hasta 3 ejemplos (favoritos primero) y novedades de 90 días (hasta 20)", () => {
    const examples = Array.from({ length: 5 }, (_, index) => ({
      text: `Ejemplo ${index}`,
      note: null,
      favorite: index === 4,
      createdAt: at(`2026-10-0${index + 1}`),
    }));
    const updates = [
      ...Array.from({ length: 22 }, (_, index) => ({
        date: `2026-11-${String(index + 1).padStart(2, "0")}`,
        project: "P",
        text: `Novedad ${index + 1}`,
        archivedAt: null,
      })),
      { date: "2026-08-01", project: "P", text: "Vieja", archivedAt: null },
      { date: "2026-11-14", project: "P", text: "Archivada", archivedAt: NOW },
    ];
    const context = knowledgeForPrompt({
      knowledge: { stance: "Postura", tone: "Relato con escena" },
      examples,
      updates,
      now: NOW,
    });
    expect(context?.stance).toBe("Postura");
    expect(context?.examples.map((example) => example.text)).toEqual([
      "Ejemplo 4",
      "Ejemplo 0",
      "Ejemplo 1",
    ]);
    expect(context?.updates).toHaveLength(20);
    expect(context?.updates[0]?.text).toBe("Novedad 22");
    expect(context?.updates.map((update) => update.text)).not.toContain("Vieja");
    expect(context?.updates.map((update) => update.text)).not.toContain("Archivada");
  });

  it("sin nada, null (el prompt no crece)", () => {
    expect(knowledgeForPrompt({ knowledge: null, examples: [], updates: [], now: NOW })).toBeNull();
  });
});

describe("D1: ejemplos = forma, novedades = hechos", () => {
  const knowledge = {
    stance: "La postura dice 500 clientes",
    tone: "Cuenta una escena",
    examples: [{ text: "Vendimos 900 unidades con Acme Corp.", note: "abre fuerte" }],
    updates: [{ date: "2026-11-10", project: "AgentPey en Stellar", text: "Pasamos 1.200 pagos." }],
  };
  const profile = { ...editorialProfileView("marca-1", null), knowledge };
  const broker = { brandName: "AgentPey", tone: null, fixedHashtags: [] };

  it("las fuentes de hechos llevan las novedades y nunca los ejemplos, la postura ni el tono", () => {
    expect(knowledgeSources(knowledge)).toEqual([
      "AgentPey en Stellar (2026-11-10): Pasamos 1.200 pagos.",
    ]);
    const sources = profileSources(profile, broker);
    expect(sources).toContain("1.200");
    expect(sources).not.toContain("900");
    expect(sources).not.toContain("Acme");
    expect(sources).not.toContain("500");
  });

  it("la revisión acepta la cifra de una novedad y marca la de un ejemplo", () => {
    const post: Pick<Post, "kind" | "topic" | "brief" | "briefOrigin" | "source" | "xLinkAllowed"> =
      {
        kind: "text",
        topic: "Pagos",
        brief: null,
        briefOrigin: "ai",
        source: "ai",
        xLinkAllowed: false,
      };
    const ctx = buildPostCheckContext({ post, profile, broker, media: [] });
    const ok = checkPostContent("linkedin", { body: "Pasamos 1.200 pagos.", hashtags: [] }, ctx);
    expect(ok.filter((check) => check.code === "FACT_NOT_IN_PROFILE")).toEqual([]);
    const copied = checkPostContent(
      "linkedin",
      { body: "Vendimos 900 unidades con Acme Corp.", hashtags: [] },
      ctx,
    );
    expect(copied.filter((check) => check.code === "FACT_NOT_IN_PROFILE").length).toBeGreaterThan(
      0,
    );
  });

  it("el prompt de los textos lleva postura, forma, ejemplos de forma y novedades, y la regla", () => {
    const brief = buildSocialBrief({
      post: {
        topic: "Pagos",
        brief: null,
        briefOrigin: "ai",
        source: "ai",
        pillar: null,
        kind: "text",
        xLinkAllowed: false,
      },
      profile,
      broker,
      targets: socialTargets(["linkedin"], ["es"]),
    });
    const { system, prompt } = buildSocialPrompt(brief);
    expect(system).toContain("ejemplos_de_forma");
    expect(system).toContain("nunca su contenido");
    expect(prompt).toContain("postura");
    expect(prompt).toContain("forma_de_contar");
    expect(prompt).toContain("Acme Corp.");
    expect(prompt).toContain("AgentPey en Stellar");
  });

  it("el prompt del plan lleva postura, forma y novedades, sin los ejemplos", () => {
    const brief = buildPlanBrief({
      broker,
      profile,
      period: { firstDay: "2026-11-16", lastDay: "2026-11-29", days: 14 },
      platforms: ["linkedin"],
      count: 3,
      history: { recentTopics: [], discardedTopics: [] },
    });
    const { system, prompt } = buildPlanPrompt(brief);
    expect(system).toContain("al menos una idea se apoya en una novedad");
    expect(prompt).toContain("novedades");
    expect(prompt).toContain("Pasamos 1.200 pagos.");
    expect(prompt).not.toContain("Acme");
  });
});

describe("casos de uso del conocimiento", () => {
  async function setup() {
    const brokers = createInMemoryBrokerRepository();
    const brandKnowledge = createInMemoryBrandKnowledgeRepository();
    const mine = await brokers.create(brokerData("mia"));
    const theirs = await brokers.create(brokerData("ajena"));
    return { deps: { brokers, brandKnowledge, now: () => NOW }, mine, theirs };
  }

  it("guarda postura, tono y ejemplos; lo ajeno no existe", async () => {
    const s = await setup();
    const saved = await saveBrandKnowledge(s.deps, brokerUser(s.mine.id), s.mine.id, {
      stance: "Postura",
      tone: "Tono",
      examples: [{ text: "Ejemplo", note: "por qué", favorite: true }],
    });
    expect(saved).toMatchObject({
      stance: "Postura",
      tone: "Tono",
      examples: [{ text: "Ejemplo" }],
    });
    await expect(
      getBrandKnowledge(s.deps, brokerUser(s.mine.id), s.theirs.id),
    ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND" });
    const empty = await getBrandKnowledge(s.deps, ADMIN, s.theirs.id);
    expect(empty).toMatchObject({ stance: null, examples: [], updates: [], updatedAt: null });
  });

  it("agrega, edita y archiva novedades; una archivada no se edita", async () => {
    const s = await setup();
    const update = await addKnowledgeUpdate(s.deps, ADMIN, s.mine.id, {
      project: "Comercios · Start-Up Chile",
      date: "2026-11-12",
      text: "Primer comercio en piloto.",
    });
    expect(update.source).toBe("operator");
    const edited = await editKnowledgeUpdate(s.deps, ADMIN, s.mine.id, update.id, {
      project: "Comercios",
      date: "2026-11-12",
      text: "Primer comercio en piloto, en Santiago.",
    });
    expect(edited.text).toContain("Santiago");
    await expect(
      archiveKnowledgeUpdate(s.deps, brokerUser(s.theirs.id), s.theirs.id, update.id),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_UPDATE_NOT_FOUND" });
    const archived = await archiveKnowledgeUpdate(s.deps, ADMIN, s.mine.id, update.id);
    expect(archived.archivedAt).not.toBeNull();
    await expect(
      editKnowledgeUpdate(s.deps, ADMIN, s.mine.id, update.id, {
        project: "x",
        date: "2026-11-12",
        text: "y",
      }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_UPDATE_ARCHIVED" });
    expect((await getBrandKnowledge(s.deps, ADMIN, s.mine.id)).updates).toEqual([]);
  });

  it("el perfil leído con el conocimiento lo trae, también sin perfil guardado", async () => {
    const s = await setup();
    const profiles = createInMemoryEditorialProfileRepository();
    const wrapped = editorialProfilesWithKnowledge(profiles, s.deps.brandKnowledge, () => NOW);
    expect(await wrapped.get(s.mine.id)).toBeNull();
    await addKnowledgeUpdate(s.deps, ADMIN, s.mine.id, {
      project: "AgentPey",
      date: "2026-11-10",
      text: "Salió la v2.",
    });
    const synthesized = await wrapped.get(s.mine.id);
    expect(synthesized?.knowledge?.updates).toEqual([
      { date: "2026-11-10", project: "AgentPey", text: "Salió la v2." },
    ]);
    expect(synthesized?.facts).toEqual([]);
    await profiles.upsert(s.mine.id, {
      ...editorialProfileView(s.mine.id, null),
      facts: ["Un hecho"],
    });
    const real = await wrapped.get(s.mine.id);
    expect(real?.facts).toEqual(["Un hecho"]);
    expect(real?.knowledge?.updates).toHaveLength(1);
  });
});
