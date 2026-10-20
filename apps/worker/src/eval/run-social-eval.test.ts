import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { profileSources, unsupportedFacts } from "@agentsales/core";
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
  similarTopics,
  topicSimilarity,
} from "./run-social-eval.js";
import {
  DEFAULT_EVAL_IDEAS,
  fakeSocialEvalOptions,
  parseIdeas,
  selectProfiles,
} from "./social-options.js";
import {
  SOCIAL_EVAL_PROFILES,
  type SocialEvalProfile,
  TWO_LANGUAGE_PROFILE,
} from "./social-profiles.js";

/** Martes 2026-10-20 a las 12:00 de Chile: el período va del miércoles 21 al martes 3. */
const NOW = new Date("2026-10-20T15:00:00Z");

const profile = (name: string): SocialEvalProfile => selectProfiles(name)[0] as SocialEvalProfile;

/** La evaluación con los proveedores dados y lo impreso. */
async function run(
  llm: Pick<SocialEvalDeps, "planLlm" | "textLlm">,
  profiles: readonly SocialEvalProfile[],
  ideas = DEFAULT_EVAL_IDEAS,
) {
  const lines: string[] = [];
  const result = await runSocialEval(
    { ...llm, print: (line) => lines.push(line), now: () => NOW },
    { profiles, ideas },
  );
  return { ...result, output: lines.join("\n") };
}

/** Los proveedores `fake` del script (el plan de ejemplo y el borrador de ejemplo). */
function fakeProviders() {
  const options = fakeSocialEvalOptions();
  return { planLlm: createLlmProvider(options.plan), textLlm: createLlmProvider(options.texts) };
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

describe("runSocialEval con fake", () => {
  it("el perfil sin hechos produce un plan sin cifras ni clientes inventados (F9-T22)", async () => {
    const item = profile("sin-hechos");
    expect(item.profile.facts).toEqual([]);
    const { exitCode, report, output } = await run(fakeProviders(), [item], item.count);

    const [evaluation] = report.profiles;
    expect(evaluation?.plan?.ideas).toHaveLength(item.count);
    expect(evaluation?.plan?.discarded).toEqual([]);
    const sources = profileSources(item.profile, item.broker);
    for (const idea of evaluation?.plan?.ideas ?? []) {
      const text = `${idea.topic}\n${idea.rationale}`;
      expect(text).not.toMatch(/\d/);
      expect(unsupportedFacts(text, sources)).toEqual([]);
    }
    // Los textos de todas sus ideas, sin cifras ni nombres fuera del perfil.
    expect(evaluation?.texts).toHaveLength(item.count);
    for (const text of evaluation?.texts ?? []) {
      expect(text.body).not.toMatch(/\d/);
      expect(text.checks.filter((check) => check.code === "FACT_NOT_IN_PROFILE")).toEqual([]);
    }
    expect(report.totals.outsideProfile).toBe(0);
    expect(exitCode).toBe(0);
    expect(output).toContain("fuera del perfil 0");
  });

  it("evalúa los tres perfiles, con un texto por idioma en el de dos idiomas, sin problemas", async () => {
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
    expect(report.totals).toMatchObject({
      repeated: 0,
      outsideProfile: 0,
      tooLong: 0,
      escapes: 0,
      massMentions: 0,
      failures: 0,
      textsWithErrors: 0,
    });
    // `fake` no informa tokens: el costo es 0, por separado y en total.
    expect(report.usage.plan).toMatchObject({ calls: 3, reportedCalls: 0, costUsd: 0 });
    expect(report.usage.texts).toMatchObject({ calls: 9, reportedCalls: 0, costUsd: 0 });
    expect(report.usage.total.calls).toBe(12);
    expect(output).toContain("fake no informa tokens (US$ 0)");
    expect(report.stopped).toBe(false);
    expect(exitCode).toBe(0);
  });

  it("con --ideas 0 solo pide el plan", async () => {
    const providers = fakeProviders();
    const { report } = await run(providers, [profile("sin-hechos")], 0);
    expect(report.usage.texts.calls).toBe(0);
    expect(report.profiles[0]?.texts).toEqual([]);
  });
});

/** Una idea del plan del perfil con historial (Instagram: lunes, miércoles y viernes a las 19:00). */
const idea = (tema: string, fecha: string, porque = "Es lo que más preguntan los vecinos.") => ({
  tema,
  linea: "cultivo",
  redes: ["instagram"],
  formato: "image",
  fecha,
  hora: "19:00",
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
  const item = profile("con-historial");
  const plan: ScriptedLlmResponse = {
    data: {
      ideas: [
        idea("Abonos para la huerta del barrio", "2026-10-21"),
        idea("Atendimos a 300 vecinos este año", "2026-10-23"),
        idea("Qué sembrar en primavera", "2026-10-26"),
        idea("Avisen a @everyone del taller", "2026-10-28"),
        idea("Abonos para la huerta del barrio", "2026-10-30"),
        idea("Cómo hacer compost en casa paso a paso", "2026-10-30"),
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

  it("ideas repetidas, fuera del perfil, menciones masivas, largos, escapes y el costo", async () => {
    const planLlm = createInMemoryLlmProvider([plan], "anthropic-api");
    const textLlm = createInMemoryLlmProvider(texts, "anthropic-api");
    const { exitCode, report, output } = await run({ planLlm, textLlm }, [item], 5);

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
    expect(first?.escapes.map((problem) => problem.code).sort()).toEqual([
      "HASHTAG_IN_BODY",
      "MARKDOWN",
    ]);
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
      escapes: 2,
      texts: 2,
      textsWithErrors: 2,
      failures: 0,
    });
    expect(evaluation?.textWarnings).toEqual(["Faltan hechos sobre la cosecha"]);

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
    expect(exitCode).toBe(1);
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
    const options = fakeSocialEvalOptions();
    const textLlm = createInMemoryLlmProvider([{ error: LLM_ERRORS.unavailable() }]);
    const item = profile("sin-hechos");
    const { report } = await run({ planLlm: createLlmProvider(options.plan), textLlm }, [item], 1);
    expect(report.profiles[0]?.failures).toEqual([
      expect.objectContaining({ stage: "textos", code: "LLM_UNAVAILABLE" }),
    ]);
    expect(report.totals.failures).toBe(1);
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
    expect(escapeProblems("linkedin", { body, hashtags: [] }, []).map((p) => p.code)).toEqual([
      "LINKEDIN_ESCAPE_OVERFLOW",
    ]);
    expect(
      escapeProblems("discord", { body: "Hola @​everyone", hashtags: [] }, []).map((p) => p.code),
    ).toEqual(["INVISIBLE_CHARACTERS"]);
    expect(escapeProblems("x", { body: "Texto limpio.", hashtags: ["#tag"] }, [])).toEqual([]);
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
});
