import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type LLMProvider,
  profileSources,
  SAMPLE_SOCIAL_DRAFT,
  samplePlanResponse,
  unsupportedFacts,
} from "@agentsales/core";
import {
  createInMemoryLlmProvider,
  LLM_ERRORS,
  type ScriptedLlmResponse,
} from "@agentsales/core/testing";
import { createLlmProvider } from "@agentsales/llm";
import { describe, expect, it } from "vitest";
import {
  escapeProblems,
  runSocialEval,
  type SocialEvalDeps,
  type SocialEvalUsage,
  similarTopics,
  socialEvalExitCode,
  topicSimilarity,
  usageLine,
} from "./run-social-eval.js";
import {
  DEFAULT_EVAL_IDEAS,
  FAKE_LLM_ENV,
  parseIdeas,
  selectProfiles,
  socialEvalProviderOptions,
} from "./social-options.js";
import {
  SOCIAL_EVAL_PROFILES,
  type SocialEvalProfile,
  TWO_LANGUAGE_PROFILE,
} from "./social-profiles.js";

/** Martes 2026-10-20 a las 12:00 de Chile: el período va del miércoles 21 al martes 3. */
const NOW = new Date("2026-10-20T15:00:00Z");

/** Un espacio de ancho cero (U+200B), escrito con su escape. */
const ZERO_WIDTH_SPACE = "\u200B";

const profile = (name: string): SocialEvalProfile => selectProfiles(name)[0] as SocialEvalProfile;

/** La evaluación con los proveedores dados y lo impreso. */
async function run(
  llm: Pick<SocialEvalDeps, "planLlm" | "textLlm">,
  profiles: readonly SocialEvalProfile[],
  { ideas = DEFAULT_EVAL_IDEAS, strict = false }: { ideas?: number; strict?: boolean } = {},
) {
  const lines: string[] = [];
  const result = await runSocialEval(
    { ...llm, print: (line) => lines.push(line), now: () => NOW },
    { profiles, ideas, strict },
  );
  return { ...result, output: lines.join("\n") };
}

/** Los proveedores `fake` del script (los del worker: el plan de ejemplo y el borrador de ejemplo). */
function fakeProviders() {
  const options = socialEvalProviderOptions(FAKE_LLM_ENV, {});
  return { planLlm: createLlmProvider(options.plan), textLlm: createLlmProvider(options.texts) };
}

/** Un `fake` del plan que antepone ideas con estos temas al plan de ejemplo (mismas redes y formato). */
function planWithInventedIdeas(topics: readonly string[]): LLMProvider {
  return createLlmProvider({
    provider: "fake",
    data: null,
    respond: ({ prompt }) => {
      const sample = samplePlanResponse(prompt);
      const [base] = sample.ideas;
      if (base === undefined) throw new Error("el plan de ejemplo no trajo ideas");
      return { ...sample, ideas: [...topics.map((tema) => ({ ...base, tema })), ...sample.ideas] };
    },
  });
}

describe("los perfiles de prueba", () => {
  it("son inventados y cubren sin hechos, dos idiomas e historial", () => {
    const names = SOCIAL_EVAL_PROFILES.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
    expect(SOCIAL_EVAL_PROFILES.some((item) => item.profile.facts.length === 0)).toBe(true);
    expect(profile(TWO_LANGUAGE_PROFILE).profile.languages).toEqual(["es", "en"]);
    expect(
      SOCIAL_EVAL_PROFILES.some(
        (item) => item.history.recentTopics.length > 0 && item.history.discardedTopics.length > 0,
      ),
    ).toBe(true);
    // Los enlaces de los perfiles son de `example.com` (reservado para documentación).
    for (const item of SOCIAL_EVAL_PROFILES) {
      for (const fact of item.profile.facts) {
        for (const link of fact.match(/https?:\/\/\S+/g) ?? [])
          expect(link).toMatch(/example\.com/);
      }
    }
  });
});

describe("el perfil sin hechos (primer criterio de F9-T22)", () => {
  const item = profile("sin-hechos");

  it("descarta las ideas que inventan cifras o clientes y cuenta cada una", async () => {
    expect(item.profile.facts).toEqual([]);
    const invented = [
      "Atendimos a 300 clientes",
      "Nuestra clienta María González triplicó sus ventas",
      "Más de 50 marcas confían en nosotros",
    ];
    const { exitCode, report, output } = await run(
      { planLlm: planWithInventedIdeas(invented), textLlm: fakeProviders().textLlm },
      [item],
      { ideas: item.count },
    );

    const [evaluation] = report.profiles;
    expect(evaluation?.plan?.discarded).toEqual(
      invented.map((topic) => ({
        topic,
        code: "FACT_NOT_IN_PROFILE",
        message: expect.any(String),
      })),
    );
    expect(evaluation?.plan?.discarded.map((idea) => idea.message)).toEqual([
      "La cifra «300» no está en los hechos del perfil",
      "«María González» parece un nombre propio que no está en el perfil",
      "La cifra «50» no está en los hechos del perfil",
    ]);
    expect(report.totals).toMatchObject({
      ideasAccepted: item.count,
      ideasDiscarded: 3,
      discardedByCode: { FACT_NOT_IN_PROFILE: 3 },
      outsideProfile: 3,
    });
    // Lo que queda (el plan y sus textos) no afirma nada fuera del perfil.
    const sources = profileSources(item.profile, item.broker);
    for (const idea of evaluation?.plan?.ideas ?? []) {
      const text = `${idea.topic}\n${idea.rationale}`;
      expect(text).not.toMatch(/\d/);
      expect(unsupportedFacts(text, sources)).toEqual([]);
    }
    expect(evaluation?.texts).toHaveLength(item.count);
    for (const text of evaluation?.texts ?? []) {
      expect(text.body).not.toMatch(/\d/);
      expect(text.checks.filter((check) => check.code === "FACT_NOT_IN_PROFILE")).toEqual([]);
    }
    // Las descartadas son la defensa funcionando: estadística, no un error de la evaluación.
    expect(output).toContain("3 descartadas por el plan (FACT_NOT_IN_PROFILE 3)");
    expect(exitCode).toBe(0);
  });

  it("cuenta las ideas que hablan de «nosotros» sin ser un equipo (FIRST_PERSON_PLURAL, F9.5-T23)", async () => {
    const plural = ["Lo que nuestro estudio aprendió", "Una pregunta para quienes nos leen"];
    const { report, output } = await run(
      { planLlm: planWithInventedIdeas(plural), textLlm: fakeProviders().textLlm },
      [item],
      { ideas: 0 },
    );
    expect(report.profiles[0]?.plan?.discarded.map((idea) => idea.code)).toEqual([
      "FIRST_PERSON_PLURAL",
      "FIRST_PERSON_PLURAL",
    ]);
    expect(report.totals).toMatchObject({
      firstPersonPlural: 2,
      discardedByCode: { FIRST_PERSON_PLURAL: 2 },
    });
    expect(output).toContain("en plural 2");
  });

  it("con --strict, las ideas descartadas sí hacen salir con 1", async () => {
    const { exitCode, output } = await run(
      {
        planLlm: planWithInventedIdeas(["Atendimos a 300 clientes"]),
        textLlm: fakeProviders().textLlm,
      },
      [item],
      { ideas: 0, strict: true },
    );
    expect(output).toContain("Resultado: ✗ el plan descartó ideas (--strict)");
    expect(exitCode).toBe(1);
  });
});

describe("runSocialEval con fake", () => {
  it("evalúa los cuatro perfiles, con un texto por idioma en el de dos idiomas, sin problemas", async () => {
    const { exitCode, report, output } = await run(fakeProviders(), SOCIAL_EVAL_PROFILES);
    expect(report.profiles.map((item) => item.profile)).toEqual(
      SOCIAL_EVAL_PROFILES.map((item) => item.name),
    );
    const twoLanguages = report.profiles.find((item) => item.profile === TWO_LANGUAGE_PROFILE);
    expect(twoLanguages?.plan?.ideas).toHaveLength(10);
    expect(twoLanguages?.texts.map((text) => text.language).sort()).toEqual([
      "en",
      "en",
      "en",
      "es",
      "es",
      "es",
    ]);
    // Solo el perfil con pedido (F9.5-T23) descarta: la idea de ejemplo que trae su cliente y su cifra
    // falsos (`FACT_NOT_IN_PROFILE`); el pedido no se vuelve un hecho.
    const withGuidance = report.profiles.find((item) => item.profile === "con-pedido");
    expect(withGuidance?.plan?.discarded.map((item) => item.code)).toEqual(["FACT_NOT_IN_PROFILE"]);
    expect(withGuidance?.plan?.discarded[0]?.topic).toContain("Los Cerezos");
    for (const idea of withGuidance?.plan?.ideas ?? []) {
      expect(idea.topic).not.toMatch(/Cerezos|340/);
    }
    expect(output).toContain("Pedido del operador: Cuenta que Inmobiliaria Los Cerezos");
    expect(report.totals).toMatchObject({
      ideasDiscarded: 1,
      discardedByCode: { FACT_NOT_IN_PROFILE: 1 },
      repeated: 0,
      firstPersonPlural: 0,
      outsideProfile: 1,
      tooLong: 0,
      escapes: 0,
      massMentions: 0,
      aiTells: 0,
      failures: 0,
      textsWithErrors: 0,
    });
    // `fake` no informa tokens: el costo es 0, por separado y en total.
    expect(report.usage.plan).toMatchObject({ calls: 4, reportedCalls: 0, costUsd: 0 });
    expect(report.usage.texts).toMatchObject({ calls: 12, reportedCalls: 0, costUsd: 0 });
    expect(report.usage.total.calls).toBe(16);
    expect(output).toContain("fake no informa tokens (US$ 0)");
    expect(output).toContain("Resultado: ✓");
    expect(report.stopped).toBe(false);
    expect(exitCode).toBe(0);
  });

  it("con --ideas 0 solo pide el plan", async () => {
    const { report } = await run(fakeProviders(), [profile("sin-hechos")], { ideas: 0 });
    expect(report.usage.texts.calls).toBe(0);
    expect(report.profiles[0]?.texts).toEqual([]);
  });
});

/**
 * Una idea del plan del perfil con historial, sin fecha ni hora (ADR-0034: el código la agenda en
 * Instagram, lunes, miércoles y viernes a las 19:00).
 */
const idea = (tema: string, porque = "Es lo que más preguntan los vecinos.") => ({
  tema,
  linea: "cultivo",
  redes: ["instagram"],
  formato: "image",
  porque,
});

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens,
  requestId: null,
});

describe("runSocialEval cuenta los problemas que se le inyectan", () => {
  it("ideas repetidas, fuera del perfil, menciones masivas, largos, markdown y el costo", async () => {
    const item = profile("con-historial");
    const plan: ScriptedLlmResponse = {
      data: {
        ideas: [
          idea("Abonos para la huerta del barrio"),
          idea("Atendimos a 300 vecinos este año"),
          idea("Qué sembrar en primavera"),
          idea("Avisen a @everyone del taller"),
          idea("Abonos para la huerta del barrio"),
          idea("Cómo hacer compost en casa paso a paso"),
        ],
        warnings: [],
      },
      model: "claude-sonnet-5-5",
      usage: usage(2000, 1000),
    };
    const texts: ScriptedLlmResponse[] = [
      {
        data: {
          texts: [
            {
              platform: "instagram",
              language: "es",
              body: `Hola @everyone, **mira** esto #huerta\n${"a".repeat(2300)}`,
              hashtags: ["#huerta"],
            },
          ],
          warnings: [],
        },
        model: "claude-sonnet-5-5",
        usage: usage(1000, 500),
      },
      {
        data: {
          texts: [
            {
              platform: "instagram",
              language: "es",
              body: "Cosechamos 500 kilos con Juan Pérez.",
              hashtags: ["#compost"],
            },
          ],
          warnings: ["Faltan hechos sobre la cosecha"],
        },
        model: "claude-sonnet-5-5",
        usage: usage(1000, 500),
      },
    ];
    const planLlm = createInMemoryLlmProvider([plan], "anthropic-api");
    const textLlm = createInMemoryLlmProvider(texts, "anthropic-api");
    const { exitCode, report, output } = await run({ planLlm, textLlm }, [item], { ideas: 5 });

    const [evaluation] = report.profiles;
    expect(evaluation?.plan?.ideas.map((accepted) => accepted.topic)).toEqual([
      "Abonos para la huerta del barrio",
      "Cómo hacer compost en casa paso a paso",
    ]);
    expect(report.totals.discardedByCode).toEqual({
      FACT_NOT_IN_PROFILE: 1,
      REPEATED_TOPIC: 1,
      MASS_MENTION: 1,
      DUPLICATE_IN_PLAN: 1,
    });
    expect(evaluation?.plan?.similar).toEqual([
      {
        topic: "Cómo hacer compost en casa paso a paso",
        like: "Cómo hacer compost en casa",
        against: "historial",
      },
    ]);
    const [first, second] = evaluation?.texts ?? [];
    expect(first?.checks.map((check) => check.code).sort()).toEqual(
      ["MARKDOWN", "MASS_MENTION", "TOO_LONG"].sort(),
    );
    // El markdown es una advertencia de la revisión, no un escape.
    expect(first?.escapes.map((problem) => problem.code)).toEqual(["HASHTAG_IN_BODY"]);
    expect(second?.checks.map((check) => check.code)).toEqual([
      "FACT_NOT_IN_PROFILE",
      "FACT_NOT_IN_PROFILE",
    ]);
    expect(report.totals).toMatchObject({
      ideasRequested: item.count,
      ideasAccepted: 2,
      ideasDiscarded: 4,
      repeated: 2,
      similar: 1,
      outsideProfile: 3,
      massMentions: 2,
      tooLong: 1,
      escapes: 1,
      texts: 2,
      textsWithErrors: 2,
      failures: 0,
    });
    expect(evaluation?.textWarnings).toEqual(["Faltan hechos sobre la cosecha"]);
    // El markdown sale una sola vez, como advertencia.
    expect(output.match(/MARKDOWN/g)).toHaveLength(2); // la lista del texto y el detalle
    expect(output).toContain("⚠ MARKDOWN");
    expect(output).not.toContain("✗ MARKDOWN");

    // Sonnet 5.5: US$2 por millón de entrada y US$10 de salida (la tabla de core).
    expect(report.usage.plan).toMatchObject({ calls: 1, inputTokens: 2000, costUsd: 0.014 });
    expect(report.usage.texts).toMatchObject({ calls: 2, outputTokens: 1000, costUsd: 0.014 });
    expect(report.usage.total).toMatchObject({ calls: 3, costUsd: 0.028 });
    expect(output).toContain("plan: 1 llamada · ");
    expect(output).toContain("2.000 tokens de entrada · 1.000 de salida · US$ 0,0140");
    expect(output).toContain("total: 3 llamadas");
    expect(output).toContain("US$ 0,0280");
    expect(output).toContain("por texto (red e idioma): US$ 0,0070");
    expect(output).toContain("✗ REPEATED_TOPIC: Qué sembrar en primavera");
    expect(output).toContain("Resultado: ✗ 2 textos con errores · 1 problemas de escape");
    expect(exitCode).toBe(1);
  });

  it("ideas parecidas entre sí y sin ranura (F9.5): se cuentan, sin fechas de la IA", async () => {
    const item = profile("con-historial");
    // Discord: martes y sábado a las 10:00, 2 por semana; el período deja 4 ranuras (sáb 24,
    // mar 27, sáb 31 y mar 3). La quinta idea de solo Discord no cabe.
    const discordIdea = (tema: string) => ({ ...idea(tema), redes: ["discord"], formato: "text" });
    const plan: ScriptedLlmResponse = {
      data: {
        ideas: [
          idea("Cómo hacer compost con hojas secas"),
          idea("Cómo hacer compost con hojas secas paso a paso"),
          discordIdea("Riego por goteo"),
          discordIdea("Semillas que se guardan"),
          discordIdea("Herramientas para empezar"),
          discordIdea("Plagas comunes de otoño"),
          discordIdea("Una cosecha compartida"),
        ],
        warnings: [],
      },
    };
    const { report, output } = await run(
      { planLlm: createInMemoryLlmProvider([plan]), textLlm: fakeProviders().textLlm },
      [item],
      { ideas: 0 },
    );
    const [evaluation] = report.profiles;
    expect(evaluation?.plan?.discarded.map((discarded) => discarded.code)).toEqual([
      "IDEA_TOO_SIMILAR",
      "NO_SLOT",
    ]);
    expect(report.totals).toMatchObject({
      ideasAccepted: 5,
      ideasDiscarded: 2,
      repeated: 1,
      noSlot: 1,
      discardedByCode: { IDEA_TOO_SIMILAR: 1, NO_SLOT: 1 },
    });
    expect(output).toContain("sin ranura 1");
    // Las fechas las puso el código, en las ranuras de Instagram y Discord y primero en las semanas
    // con menos ideas: la primera semana ya tiene la de Instagram del miércoles 21.
    expect(evaluation?.plan?.ideas.map((accepted) => accepted.plannedAt)).toEqual([
      "2026-10-21T22:00:00.000Z",
      "2026-10-27T13:00:00.000Z",
      "2026-11-03T13:00:00.000Z",
      "2026-10-24T13:00:00.000Z",
      "2026-10-31T13:00:00.000Z",
    ]);
  });

  it("descartadas antes, términos a evitar, enlaces en X, hashtags, LinkedIn e invisibles", async () => {
    const base = profile("dos-idiomas");
    const item: SocialEvalProfile = {
      ...base,
      history: { recentTopics: [], discardedTopics: ["Una idea que ya descartamos"] },
    };
    const planIdea = (tema: string, red: string, formato: string) => ({
      tema,
      linea: "producto",
      redes: [red],
      formato,
      porque: "Ayuda a entender el producto.",
    });
    const plan: ScriptedLlmResponse = {
      data: {
        ideas: [
          planIdea("Cómo planificar turnos de soporte", "x", "text"),
          planIdea("Lo que cambió en la última versión", "linkedin", "text"),
          planIdea("El equipo por dentro", "instagram", "image"),
          planIdea("Una idea que ya descartamos", "x", "text"),
        ],
        warnings: [],
      },
    };
    const letters = "abcdefghijklmnopqrstuvwxyz";
    const thirtyTags = Array.from(
      { length: 30 },
      (_, i) => `#tag${letters[i % 26]}${letters[Math.floor(i / 26)]}`,
    );
    const draft = (
      es: { body: string; hashtags?: string[] },
      en: { body: string },
      red: string,
    ) => ({
      data: {
        texts: [
          { platform: red, language: "es", body: es.body, hashtags: es.hashtags ?? [] },
          { platform: red, language: "en", body: en.body, hashtags: [] },
        ],
        warnings: [],
      },
    });
    const textLlm = createInMemoryLlmProvider([
      draft(
        { body: "Más detalles en https://brujula.example.com" },
        { body: "Tell us what you think." },
        "x",
      ),
      draft(
        { body: `${"(a) ".repeat(700)}fin` },
        { body: `Hello team,${ZERO_WIDTH_SPACE} see you soon.` },
        "linkedin",
      ),
      draft(
        { body: "Así trabajamos #extra", hashtags: thirtyTags },
        { body: "We never talk about competencia here." },
        "instagram",
      ),
    ]);
    const { exitCode, report } = await run(
      { planLlm: createInMemoryLlmProvider([plan]), textLlm },
      [item],
      { ideas: 3 },
    );

    const [evaluation] = report.profiles;
    expect(evaluation?.plan?.discarded.map((discarded) => discarded.code)).toEqual([
      "DISCARDED_TOPIC",
    ]);
    const byText = (platform: string, language: string) =>
      evaluation?.texts.find((text) => text.platform === platform && text.language === language);
    expect(byText("x", "es")?.checks.map((check) => check.code)).toEqual([
      "LINK_NOT_ALLOWED",
      "LINK_NOT_ALLOWED",
      "LINK_COST",
    ]);
    expect(byText("linkedin", "es")?.checks.map((check) => check.code)).toEqual(["TOO_LONG"]);
    expect(byText("linkedin", "es")?.escapes.map((problem) => problem.code)).toEqual([
      "LINKEDIN_ESCAPE_OVERFLOW",
    ]);
    expect(byText("linkedin", "en")?.escapes.map((problem) => problem.code)).toEqual([
      "INVISIBLE_CHARACTERS",
    ]);
    expect(byText("instagram", "es")?.checks.map((check) => check.code)).toEqual(["HASHTAG_LIMIT"]);
    expect(byText("instagram", "es")?.escapes.map((problem) => problem.code)).toEqual([
      "HASHTAG_IN_BODY",
    ]);
    expect(byText("instagram", "en")?.checks.map((check) => check.code)).toEqual(["AVOID_TERM"]);
    expect(report.totals).toMatchObject({
      repeated: 1,
      outsideProfile: 2,
      tooLong: 2,
      escapes: 3,
      avoided: 1,
      massMentions: 0,
      texts: 6,
      textsWithErrors: 3,
    });
    expect(exitCode).toBe(1);
  });
});

describe("runSocialEval cuenta las muletillas de IA", () => {
  it("son una advertencia: se cuentan y no cambian el resultado", async () => {
    const item = profile("con-historial");
    const plan: ScriptedLlmResponse = {
      data: { ideas: [idea("Cómo regar en verano")], warnings: [] },
    };
    const textLlm = createInMemoryLlmProvider([
      {
        data: {
          texts: [
            {
              platform: "instagram",
              language: "es",
              body: "Descubre el huerto. Sin duda, la cosecha te espera. ¡Ya! ¡Hoy! ¡Ven!",
              hashtags: ["#huerta"],
            },
          ],
          warnings: [],
        },
      },
    ]);
    const { exitCode, report, output } = await run(
      { planLlm: createInMemoryLlmProvider([plan]), textLlm },
      [item],
      { ideas: 1 },
    );

    const [text] = report.profiles[0]?.texts ?? [];
    expect(text?.checks.map((check) => [check.code, check.severity])).toEqual([
      ["AI_TELL", "warning"],
    ]);
    // «descubre», «sin duda», «te espera» y 3 signos de exclamación.
    expect(report.totals).toMatchObject({ aiTells: 4, textsWithErrors: 0 });
    expect(output).toContain("⚠ AI_TELL");
    expect(output).toContain("muletillas de IA 4");
    expect(exitCode).toBe(0);
  });
});

describe("runSocialEval sin red", () => {
  it("un proveedor que no responde queda como falla del perfil y sigue con el siguiente", async () => {
    const planLlm = createInMemoryLlmProvider([
      { error: LLM_ERRORS.unavailable() },
      { error: LLM_ERRORS.unavailable() },
    ]);
    const textLlm = createInMemoryLlmProvider([]);
    const profiles = [profile("sin-hechos"), profile("con-historial")];
    const { exitCode, report, output } = await run({ planLlm, textLlm }, profiles);
    expect(report.profiles.map((item) => item.failures)).toEqual([
      [{ stage: "plan", topic: null, code: "LLM_UNAVAILABLE", message: "La IA no respondió" }],
      [{ stage: "plan", topic: null, code: "LLM_UNAVAILABLE", message: "La IA no respondió" }],
    ]);
    expect(report.stopped).toBe(false);
    expect(output).toContain("✗ plan: LLM_UNAVAILABLE: La IA no respondió");
    expect(output).not.toMatch(/\n\s+at /);
    expect(exitCode).toBe(1);
  });

  it("sin sesión se detiene: no gasta en los perfiles que quedan", async () => {
    const planLlm = createInMemoryLlmProvider([{ error: LLM_ERRORS.authRequired() }]);
    const textLlm = createInMemoryLlmProvider([]);
    const { exitCode, report, output } = await run({ planLlm, textLlm }, SOCIAL_EVAL_PROFILES);
    expect(report.profiles).toHaveLength(1);
    expect(planLlm.requests).toHaveLength(1);
    expect(report.stopped).toBe(true);
    expect(output).toContain("Evaluación cortada");
    expect(exitCode).toBe(1);
  });

  it("una falla en los textos de una idea no tumba las demás", async () => {
    const textLlm = createInMemoryLlmProvider([{ error: LLM_ERRORS.unavailable() }]);
    const item = profile("sin-hechos");
    const { report } = await run({ planLlm: fakeProviders().planLlm, textLlm }, [item], {
      ideas: 1,
    });
    expect(report.profiles[0]?.failures).toEqual([
      expect.objectContaining({ stage: "textos", code: "LLM_UNAVAILABLE" }),
    ]);
    expect(report.totals.failures).toBe(1);
  });

  it("una excepción inesperada conserva el informe parcial y lo gastado, y se detiene", async () => {
    const textLlm: LLMProvider = {
      name: "fake",
      async generateStructured() {
        throw new Error("algo raro");
      },
    };
    const { exitCode, report, output } = await run(
      { planLlm: fakeProviders().planLlm, textLlm },
      SOCIAL_EVAL_PROFILES,
    );
    expect(report.profiles).toHaveLength(1);
    expect(report.profiles[0]?.plan?.ideas.length).toBeGreaterThan(0);
    expect(report.profiles[0]?.failures).toEqual([
      expect.objectContaining({ stage: "textos", code: "INTERNAL_ERROR", message: "algo raro" }),
    ]);
    expect(report.usage).toMatchObject({ plan: { calls: 1 }, texts: { calls: 1 } });
    expect(report.stopped).toBe(true);
    expect(output).not.toMatch(/\n\s+at /);
    expect(exitCode).toBe(1);
  });
});

describe("la evaluación no toca la base", () => {
  it("el script no importa la base ni la lógica recibe repositorios", () => {
    const script = readFileSync(
      fileURLToPath(new URL("../scripts/eval-social.ts", import.meta.url)),
      "utf8",
    );
    const logic = readFileSync(
      fileURLToPath(new URL("./run-social-eval.ts", import.meta.url)),
      "utf8",
    );
    for (const source of [script, logic]) {
      expect(source).not.toContain("@agentsales/db");
      expect(source).not.toMatch(/createDb|Repository/);
    }
  });
});

describe("las piezas de la evaluación", () => {
  it("topicSimilarity y similarTopics: parecidas, no iguales ni distintas", () => {
    expect(
      topicSimilarity("Cómo hacer compost en casa", "Cómo hacer compost en casa paso a paso"),
    ).toBe(0.75);
    expect(topicSimilarity("Qué sembrar en primavera", "El taller del sábado")).toBe(0);
    expect(
      similarTopics(
        ["Regar sin desperdiciar agua en verano", "Otra idea", "Otra idea distinta"],
        ["Regar sin desperdiciar agua"],
      ),
    ).toEqual([
      {
        topic: "Regar sin desperdiciar agua en verano",
        like: "Regar sin desperdiciar agua",
        against: "historial",
      },
      { topic: "Otra idea distinta", like: "Otra idea", against: "plan" },
    ]);
  });

  it("escapeProblems: LinkedIn que solo cabe sin escapes y caracteres invisibles", () => {
    const body = `${"(a) ".repeat(700)}fin`;
    expect(escapeProblems("linkedin", { body, hashtags: [] }).map((p) => p.code)).toEqual([
      "LINKEDIN_ESCAPE_OVERFLOW",
    ]);
    for (const hidden of ["\u200B", "\u200D", "\u2060", "\uFEFF", "\uFF20"]) {
      expect(
        escapeProblems("discord", { body: `Hola ${hidden}equipo`, hashtags: [] }).map(
          (p) => p.code,
        ),
      ).toEqual(["INVISIBLE_CHARACTERS"]);
    }
    expect(escapeProblems("x", { body: "Texto limpio.", hashtags: ["#tag"] })).toEqual([]);
    // El markdown no es un escape (es la advertencia MARKDOWN de la revisión).
    expect(escapeProblems("instagram", { body: "Un **énfasis**.", hashtags: [] })).toEqual([]);
  });

  it("usageLine: si solo algunas llamadas informaron tokens, el costo es parcial", () => {
    const partial: SocialEvalUsage = {
      calls: 2,
      reportedCalls: 1,
      promptChars: 1000,
      inputTokens: 2000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 1000,
      costUsd: 0.014,
      models: ["claude-sonnet-5-5"],
    };
    expect(usageLine("textos", partial, "anthropic-api")).toBe(
      "textos: 2 llamadas · 1.000 caracteres de prompt · 1 de 2 llamadas informadas · " +
        "2.000 tokens de entrada · 1.000 de salida · US$ 0,0140 (parcial: falta lo no informado)",
    );
    expect(usageLine("textos", { ...partial, reportedCalls: 2 }, "anthropic-api")).not.toContain(
      "parcial",
    );
  });

  it("socialEvalExitCode: las descartadas solo cuentan con --strict", () => {
    const totals = (changes: Record<string, number>) => ({
      ideasRequested: 3,
      ideasAccepted: 2,
      ideasDiscarded: 0,
      discardedByCode: {},
      repeated: 0,
      noSlot: 0,
      firstPersonPlural: 0,
      similar: 0,
      outsideProfile: 0,
      tooLong: 0,
      escapes: 0,
      massMentions: 0,
      avoided: 0,
      aiTells: 0,
      texts: 2,
      textsWithErrors: 0,
      failures: 0,
      ...changes,
    });
    expect(socialEvalExitCode(totals({}), { stopped: false })).toBe(0);
    expect(socialEvalExitCode(totals({ ideasDiscarded: 1, repeated: 1 }), { stopped: false })).toBe(
      0,
    );
    expect(
      socialEvalExitCode(totals({ ideasDiscarded: 1 }), { stopped: false, strict: true }),
    ).toBe(1);
    expect(
      socialEvalExitCode(totals({ similar: 2, avoided: 1, aiTells: 3 }), { stopped: false }),
    ).toBe(0);
    expect(socialEvalExitCode(totals({ textsWithErrors: 1 }), { stopped: false })).toBe(1);
    expect(socialEvalExitCode(totals({ escapes: 1 }), { stopped: false })).toBe(1);
    expect(socialEvalExitCode(totals({ failures: 1 }), { stopped: false })).toBe(1);
    expect(socialEvalExitCode(totals({}), { stopped: true })).toBe(1);
  });

  it("selectProfiles y parseIdeas validan las opciones", () => {
    expect(selectProfiles(undefined)).toHaveLength(SOCIAL_EVAL_PROFILES.length);
    expect(selectProfiles("dos-idiomas").map((item) => item.name)).toEqual(["dos-idiomas"]);
    expect(() => selectProfiles("otra")).toThrow("No existe el perfil «otra»");
    expect(parseIdeas(undefined)).toBe(DEFAULT_EVAL_IDEAS);
    expect(parseIdeas("0")).toBe(0);
    expect(parseIdeas("10")).toBe(10);
    for (const raw of ["-1", "2.5", "abc", "21"]) expect(() => parseIdeas(raw)).toThrow("--ideas");
  });

  it("los proveedores fake son los del worker (plan de ejemplo y borrador de ejemplo)", async () => {
    const { textLlm } = fakeProviders();
    const response = await textLlm.generateStructured({ system: "", prompt: "", jsonSchema: {} });
    expect(response.data).toEqual(SAMPLE_SOCIAL_DRAFT);
  });
});
