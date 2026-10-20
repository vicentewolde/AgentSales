import { describe, expect, it } from "vitest";
import { hasContentErrors } from "../content/check.js";
import { editorialProfileView } from "../editorial-profile.js";
import type { PostKind, PostPlatform } from "../enums.js";
import type { Post } from "../post.js";
import { buildPostCheckContext, checkPostContent, type PostCheckContext } from "./check.js";

// La revisión de los textos de un post (spec F9 §4.4, ADR-0030 punto 7).

const BRAND = { brandName: "AgentPey", fixedHashtags: ["#AgentPey"] };

const PROFILE = {
  ...editorialProfileView("marca-1", null),
  audience: "Corredores independientes de Chile",
  pillars: [
    { key: "producto", name: "Producto", description: "Cómo funciona por dentro", weight: 1 },
  ],
  facts: [
    "AgentPey publica en Instagram, Portal Inmobiliario y Facebook Marketplace",
    "Hoy lo usan 12 corredores",
    "La guía está en agentpey.com/guia",
  ],
  avoid: ["gratis", "garantizado"],
  defaultHashtags: ["#corretaje"],
};

type PostFields = Pick<Post, "kind" | "topic" | "brief" | "briefOrigin" | "source">;

const OPERATOR_POST: PostFields = {
  kind: "image",
  topic: "Lo que aprendimos en Valparaíso",
  brief: "Contar que ya integramos Discord. Más detalles en https://agentpey.com/discord",
  briefOrigin: "operator",
  source: "manual",
};

function context(
  post: Partial<PostFields> = {},
  media: { images?: number; videos?: number } = { images: 1 },
): PostCheckContext {
  const items = [
    ...Array.from({ length: media.images ?? 0 }, () => ({
      role: "original" as const,
      kind: "image" as const,
    })),
    ...Array.from({ length: media.videos ?? 0 }, () => ({
      role: "original" as const,
      kind: "video" as const,
    })),
    // Las variantes no cuentan como medios del operador.
    { role: "processed" as const, kind: "image" as const },
  ];
  return buildPostCheckContext({
    post: { ...OPERATOR_POST, ...post },
    profile: PROFILE,
    broker: BRAND,
    media: items,
  });
}

const check = (
  platform: PostPlatform,
  body: string,
  ctx: PostCheckContext = context(),
  hashtags: string[] = [],
) => checkPostContent(platform, { body, hashtags }, ctx);

const codes = (...args: Parameters<typeof check>) => check(...args).map((item) => item.code);

const CLEAN_ES =
  "Hoy les cuento cómo AgentPey publica en Instagram y Portal Inmobiliario.\n¿Qué te gustaría ver en octubre?";
const CLEAN_EN = "Today I share how AgentPey works inside. What would you like to see in October?";

describe("checkPostContent: un texto limpio", () => {
  it("no tiene observaciones en ninguna red ni idioma", () => {
    for (const platform of ["instagram", "x", "linkedin", "discord"] as const) {
      expect(check(platform, CLEAN_ES)).toEqual([]);
      expect(check(platform, CLEAN_EN)).toEqual([]);
    }
  });
});

describe("checkPostContent: largo por red", () => {
  it("Instagram: 2.200 con los hashtags", () => {
    const tags = ["#uno"];
    expect(codes("instagram", "a".repeat(2200 - 6), context(), tags)).toEqual([]);
    expect(codes("instagram", "a".repeat(2200 - 5), context(), tags)).toEqual(["TOO_LONG"]);
  });

  it("Instagram: hasta 30 hashtags, contando los que van dentro del texto", () => {
    const tags = Array.from({ length: 29 }, (_, i) => `#tag${String.fromCharCode(97 + (i % 26))}`);
    expect(codes("instagram", "Hola #extra", context(), tags)).toEqual([]);
    expect(codes("instagram", "Hola #extra #otro", context(), tags)).toEqual(["HASHTAG_LIMIT"]);
  });

  it("X: 280 ponderados (un emoji pesa 2)", () => {
    expect(codes("x", `${"a".repeat(278)}🚀`)).toEqual([]);
    expect(codes("x", `${"a".repeat(279)}🚀`)).toEqual(["TOO_LONG"]);
    const [tooLong] = check("x", "a".repeat(281));
    expect(tooLong?.message).toContain("281 caracteres ponderados");
  });

  it("LinkedIn: 3.000 contando los escapes de sus caracteres reservados", () => {
    expect(codes("linkedin", "a".repeat(3000))).toEqual([]);
    // 2.999 visibles y 3.001 escapados: los dos paréntesis llevan su barra.
    expect(codes("linkedin", `${"a".repeat(2997)}()`)).toEqual(["TOO_LONG"]);
  });

  it("Discord: 2.000", () => {
    expect(codes("discord", "a".repeat(2000))).toEqual([]);
    expect(codes("discord", "a".repeat(2001))).toEqual(["TOO_LONG"]);
  });
});

describe("checkPostContent: menciones", () => {
  it("un @everyone o un @here impide aprobar, en cualquier red", () => {
    for (const platform of ["discord", "instagram", "x", "linkedin"] as const) {
      const checks = check(platform, "Atención @everyone, novedades");
      expect(checks.map((item) => item.code)).toEqual(["MASS_MENTION"]);
      expect(hasContentErrors(checks)).toBe(true);
    }
    expect(codes("discord", "Hola @Here")).toEqual(["MASS_MENTION"]);
  });

  it("detecta la mención masiva pegada a otra cosa, con ancho cero o con la arroba ancha", () => {
    for (const body of [
      "a@everyone",
      "Hola @@everyone",
      "fin.@here",
      "x@here ahora",
      "Atención @\u200Beveryone",
      "Atención @every\u200Done",
      "Atención @\u2060here",
      "Atención \uFEFF@here",
      "Atención \uFF20everyone",
    ]) {
      expect(codes("discord", body)).toContain("MASS_MENTION");
    }
    expect(codes("discord", "Atención", context(), ["#ok", "@here"])).toContain("MASS_MENTION");
    // Otras palabras que empiezan igual no son menciones masivas.
    expect(codes("discord", "Escríbenos a contacto@hereford.example")).not.toContain(
      "MASS_MENTION",
    );
  });

  it("una mención que no está en las fuentes es un hecho ajeno; un correo no es mención", () => {
    expect(codes("instagram", "Gracias @alguien por la idea")).toEqual(["FACT_NOT_IN_PROFILE"]);
    expect(codes("instagram", "Escríbenos a hola@agentpey.com")).toEqual(["FACT_NOT_IN_PROFILE"]);
    const withMention = context({ brief: "Agradecer a @vinny por la idea" });
    expect(codes("instagram", "Gracias @vinny por la idea", withMention)).toEqual([]);
  });
});

describe("checkPostContent: hechos fuera del perfil", () => {
  it("una cifra ajena al perfil impide aprobar; una de los hechos, no", () => {
    const checks = check("linkedin", "Ya somos 500 corredores usando la plataforma.");
    expect(checks.map((item) => item.code)).toEqual(["FACT_NOT_IN_PROFILE"]);
    expect(checks[0]?.message).toContain("«500»");
    expect(hasContentErrors(checks)).toBe(true);
    expect(codes("linkedin", "Hoy lo usan 12 corredores.")).toEqual([]);
  });

  it("las cifras se comparan sin separadores, en los dos idiomas, y también en los hashtags", () => {
    const ctx = context({ brief: "Llegamos a 1.000 avisos publicados" });
    expect(codes("x", "We reached 1,000 listings.", ctx)).toEqual([]);
    expect(codes("x", "Seguimos.", ctx, ["#2026"])).toEqual(["FACT_NOT_IN_PROFILE"]);
  });

  it("los marcadores de una lista numerada y el 24/7 no son cifras", () => {
    expect(
      codes(
        "linkedin",
        "Tres ideas:\n1. Publicar con calma.\n2) Revisar cada texto.\n 10. Medir.",
        context(),
      ),
    ).toEqual([]);
    expect(codes("linkedin", "Soporte 24/7 para tus avisos.")).toEqual([]);
    // Una cifra dentro de la línea de la lista sí se revisa.
    expect(codes("linkedin", "1. Somos 40 personas.")).toEqual(["FACT_NOT_IN_PROFILE"]);
    expect(codes("linkedin", "Atendemos 24/72 casos.")).toContain("FACT_NOT_IN_PROFILE");
  });

  it("una cifra pegada a letras (B2B, web3) es parte de un nombre, no una cifra", () => {
    expect(codes("linkedin", "Pensamos en B2B y en la web3 sin apuro.")).toEqual([]);
  });

  it("un nombre propio que no está en el perfil impide aprobar; los del perfil, las redes y los meses, no", () => {
    const checks = check("linkedin", "Esta semana firmamos con Banco Central.");
    expect(checks.map((item) => item.code)).toEqual(["FACT_NOT_IN_PROFILE"]);
    expect(checks[0]?.message).toContain("«Banco Central»");
    expect(
      codes(
        "linkedin",
        "En octubre, AgentPey suma Discord. Los Corredores independientes lo piden.",
      ),
    ).toEqual([]);
  });

  it("una sigla o un énfasis en mayúsculas de 2 a 6 letras no es un nombre", () => {
    expect(codes("linkedin", "Esto es GRATIS para siempre, con IA y B2B.")).toEqual(["AVOID_TERM"]);
    expect(codes("linkedin", "Les presento a ACMECORP hoy.")).toEqual(["FACT_NOT_IN_PROFILE"]);
  });

  it("una ciudad que está en el perfil es fuente; una que no, se marca", () => {
    const ctx = buildPostCheckContext({
      post: OPERATOR_POST,
      profile: { ...PROFILE, audience: "Corredores de Santiago y Concepción" },
      broker: BRAND,
      media: [{ role: "original", kind: "image" }],
    });
    expect(codes("linkedin", "Hoy estuvimos en Concepción.", ctx)).toEqual([]);
    expect(codes("linkedin", "Hoy estuvimos en Temuco.", ctx)).toEqual(["FACT_NOT_IN_PROFILE"]);
  });

  it("una línea con forma de título (Title Case) se tolera como nombres, no como cifras", () => {
    expect(codes("linkedin", "How We Pick Our Networks\nToday I share our criteria.")).toEqual([]);
    const numbers = check("linkedin", "Our Best 500 Client Stories\nToday I share.");
    expect(numbers.map((item) => item.message)).toEqual([
      "La cifra «500» no está en los hechos del perfil ni en el brief del operador",
    ]);
    // Con puntuación final ya no es un título: sus nombres se revisan.
    expect(codes("linkedin", "Today We Meet Banco Central.")).toEqual(["FACT_NOT_IN_PROFILE"]);
  });

  it("la mayúscula que abre una frase, una línea o una pregunta no es un nombre", () => {
    expect(codes("instagram", "Nuevo mes.\nArrancamos. ¿Listos? «Vamos» con todo")).toEqual([]);
  });

  it("el brief del operador es fuente de hechos; un brief de la IA no vale", () => {
    const text = "Ya integramos Discord: más en https://agentpey.com/discord";
    expect(codes("linkedin", text, context())).toEqual([]);
    const fromAi = context({ briefOrigin: "ai" });
    const checks = check("linkedin", "Esta semana sumamos Valdivia como cliente.", fromAi);
    expect(checks.map((item) => item.code)).toEqual(["FACT_NOT_IN_PROFILE"]);
    expect(codes("linkedin", text, fromAi)).toEqual(["FACT_NOT_IN_PROFILE"]);
  });

  it("el tema es fuente solo en un post manual (el de una idea lo escribió la IA)", () => {
    const text = "Esto aprendimos en Valparaíso.";
    expect(codes("instagram", `Les cuento. ${text}`, context())).toEqual([]);
    expect(codes("instagram", `Les cuento. ${text}`, context({ source: "ai" }))).toEqual([
      "FACT_NOT_IN_PROFILE",
    ]);
  });
});

describe("checkPostContent: enlaces", () => {
  it("un enlace que no está en las fuentes impide aprobar", () => {
    const checks = check("linkedin", "Más en https://otra-empresa.com/oferta");
    expect(checks.map((item) => item.code)).toEqual(["FACT_NOT_IN_PROFILE"]);
  });

  it("en X, un enlace del brief del operador se permite con el aviso de su costo", () => {
    const checks = check("x", "Ya integramos Discord: https://agentpey.com/discord");
    expect(checks.map((item) => [item.code, item.severity])).toEqual([["LINK_COST", "warning"]]);
    expect(checks[0]?.message).toContain("US$0,20");
    expect(hasContentErrors(checks)).toBe(false);
  });

  it("en X, un enlace de los hechos que el operador no marcó en el brief no se permite", () => {
    expect(codes("x", "La guía: agentpey.com/guia")).toEqual(["LINK_NOT_ALLOWED", "LINK_COST"]);
    expect(codes("linkedin", "La guía: agentpey.com/guia")).toEqual([]);
  });
});

describe("checkPostContent: medios", () => {
  const withMedia = (kind: PostKind, images: number, videos = 0) =>
    context({ kind }, { images, videos });

  it("un post de video exige video", () => {
    expect(codes("instagram", CLEAN_ES, withMedia("video", 1))).toEqual(["MEDIA_REQUIREMENT"]);
    expect(codes("instagram", CLEAN_ES, withMedia("video", 0, 1))).toEqual([]);
  });

  it("X admite hasta 4 imágenes", () => {
    expect(codes("x", "Fotos.", withMedia("carousel", 4))).toEqual([]);
    expect(codes("x", "Fotos.", withMedia("carousel", 5))).toEqual(["MEDIA_REQUIREMENT"]);
    expect(codes("instagram", "Fotos.", withMedia("carousel", 5))).toEqual([]);
  });

  it("Instagram necesita imagen o video, y TikTok solo video", () => {
    expect(codes("instagram", "Solo texto.", withMedia("text", 0))).toEqual(["MEDIA_REQUIREMENT"]);
    expect(codes("linkedin", "Solo texto.", withMedia("text", 0))).toEqual([]);
    expect(codes("tiktok", "Fotos.", withMedia("image", 1))).toEqual(["MEDIA_REQUIREMENT"]);
    expect(codes("tiktok", "Video.", withMedia("video", 0, 1))).toEqual([]);
  });

  it("un post de imágenes sin imágenes no se aprueba", () => {
    expect(codes("linkedin", "Fotos.", withMedia("image", 0))).toEqual(["MEDIA_REQUIREMENT"]);
  });
});

describe("checkPostContent: advertencias", () => {
  it("lo que el perfil pide evitar es una advertencia", () => {
    const checks = check("instagram", "Pruébalo gratis esta semana.");
    expect(checks.map((item) => [item.code, item.severity])).toEqual([["AVOID_TERM", "warning"]]);
  });

  it("markdown es una advertencia, salvo en Discord, que lo muestra", () => {
    expect(codes("linkedin", "Esto es **importante**.")).toEqual(["MARKDOWN"]);
    expect(codes("discord", "Esto es **importante**.")).toEqual([]);
  });
});
