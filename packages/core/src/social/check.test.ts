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

type PostFields = Pick<
  Post,
  "kind" | "topic" | "brief" | "briefOrigin" | "source" | "xLinkAllowed"
>;

// Con la marca del enlace en X (F9-T16): los casos de enlace en X sin ella van aparte.
const OPERATOR_POST: PostFields = {
  kind: "image",
  topic: "Lo que aprendimos en Valparaíso",
  brief: "Contar que ya integramos Discord. Más detalles en https://agentpey.com/discord",
  briefOrigin: "operator",
  source: "manual",
  xLinkAllowed: true,
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

  it("Discord: 2.000 contando el texto neutralizado, como al publicar (F9-T14)", () => {
    expect(codes("discord", "a".repeat(2000))).toEqual([]);
    // 2.000 visibles; con la arroba neutralizada son 2.001, que el publisher rechazaría.
    expect(codes("discord", `${"a".repeat(1991)}@everyone`)).toContain("TOO_LONG");
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

  it("los días y los meses completos no son nombres; los abreviados, solo junto a una fecha (ensayo de la demo de F9)", () => {
    // El hecho del perfil está en español; el texto de X, en inglés (la marca publica en los dos).
    const ctx = buildPostCheckContext({
      post: OPERATOR_POST,
      profile: {
        ...PROFILE,
        facts: ["Hasta el 9 de octubre de 2026: 26 compras en 3 tiendas de prueba"],
      },
      broker: BRAND,
      media: [{ role: "original", kind: "image" }],
    });
    expect(codes("x", "Up to Oct 9: 26 purchases in 3 test stores.", ctx)).toEqual([]);
    expect(codes("x", "Up to Oct. 9, we had 26 purchases in 3 test stores.", ctx)).toEqual([]);
    expect(codes("x", "See you Mon, Oct 9.", ctx)).toEqual([]);
    expect(codes("x", "Open Oct 9-26 and on Sun 9.", ctx)).toEqual([]);
    expect(codes("x", "We ship on Monday, October 9.", ctx)).toEqual([]);
    expect(codes("x", "On Monday we ship.", ctx)).toEqual([]);
    expect(
      codes("linkedin", "Lo contamos el Mié 9 y el 26 de Ene., de Lunes a Sáb. 3.", ctx),
    ).toEqual([]);
    // Una abreviatura que no va junto a una fecha puede ser un nombre real: se revisa.
    const singer = check("x", "We met Mon Laferte.", ctx);
    expect(singer.map((item) => item.code)).toEqual(["FACT_NOT_IN_PROFILE"]);
    expect(singer[0]?.message).toContain("«Mon Laferte»");
    expect(check("linkedin", "Visit Viña del Mar.", ctx).map((item) => item.message)).toEqual([
      "«Viña» parece un nombre propio que no está en el perfil ni en el brief del operador",
      "«Mar» parece un nombre propio que no está en el perfil ni en el brief del operador",
    ]);
    expect(codes("x", "We ship on Mon and Fri.", ctx)).toEqual([
      "FACT_NOT_IN_PROFILE",
      "FACT_NOT_IN_PROFILE",
    ]);
    // Un nombre real que no está en el perfil se sigue marcando, también junto a una fecha.
    const checks = check("x", "Up to Oct 9 we work with Banco Estado.", ctx);
    expect(checks.map((item) => item.code)).toEqual(["FACT_NOT_IN_PROFILE"]);
    expect(checks[0]?.message).toContain("«Banco Estado»");
    expect(codes("x", "We work with Banco Estado.", ctx)).toEqual(["FACT_NOT_IN_PROFILE"]);
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

  it("en X, un enlace del brief sin la marca explícita del post no se permite (F9-T16)", () => {
    const unmarked = context({ xLinkAllowed: false });
    const checks = check("x", "Ya integramos Discord: https://agentpey.com/discord", unmarked);
    expect(checks.map((item) => item.code)).toEqual(["LINK_NOT_ALLOWED", "LINK_COST"]);
    expect(checks[0]?.message).toContain("márcalo en el post");
    expect(checks[0]?.message).toContain("US$0,20");
    expect(hasContentErrors(checks)).toBe(true);
    // Sin enlace, la marca no importa; en otra red, tampoco.
    expect(codes("x", "Ya integramos Discord.", unmarked)).toEqual([]);
    expect(
      codes("linkedin", "Ya integramos Discord: https://agentpey.com/discord", unmarked),
    ).toEqual([]);
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
    expect(codes("x", "Fotos.", withMedia("carousel", 5))).toEqual(["MEDIA_NOT_SUPPORTED"]);
    expect(codes("instagram", "Fotos.", withMedia("carousel", 5))).toEqual([]);
  });

  it("las tarjetas son de un idioma: cada texto cuenta las imágenes de su idioma, no las de los dos", () => {
    // Una foto del usuario y tarjetas en español (4) y en inglés (4, una compartida con el español).
    const originals = [
      { id: "foto", role: "original" as const, kind: "image" as const },
      ...["es1", "es2", "es3", "en1", "en2", "en3", "cierre"].map((id) => ({
        id,
        role: "original" as const,
        kind: "image" as const,
      })),
    ];
    const cards = new Map<string, readonly ("es" | "en")[]>([
      ["es1", ["es"]],
      ["es2", ["es"]],
      ["es3", ["es"]],
      ["en1", ["en"]],
      ["en2", ["en"]],
      ["en3", ["en"]],
      ["cierre", ["es", "en"]],
    ]);
    const build = (withCards: boolean) =>
      buildPostCheckContext({
        post: { ...OPERATOR_POST, kind: "carousel" },
        profile: PROFILE,
        broker: BRAND,
        media: originals,
        ...(withCards ? { cards } : {}),
      });
    const x = (language: "es" | "en", ctx: PostCheckContext) =>
      checkPostContent("x", { body: "Fotos.", hashtags: [], language }, ctx).map(
        (item) => item.code,
      );
    const message = (language: "es" | "en", ctx: PostCheckContext) =>
      checkPostContent("x", { body: "Fotos.", hashtags: [], language }, ctx)[0]?.message;
    // Sin separar por idioma, las 8 imágenes pasan el tope de X (4).
    expect(x("es", build(false))).toEqual(["MEDIA_NOT_SUPPORTED"]);
    expect(message("es", build(false))).toContain("tiene 8 imágenes");
    // Por idioma, cada texto cuenta las suyas: la foto, sus 3 tarjetas y el cierre compartido (5).
    expect(message("en", build(true))).toContain("tiene 5 imágenes");
    // Sin la foto y con una tarjeta menos por idioma, cada idioma cumple por separado.
    const lean = buildPostCheckContext({
      post: { ...OPERATOR_POST, kind: "carousel" },
      profile: PROFILE,
      broker: BRAND,
      media: originals.filter(
        (item) => item.id !== "foto" && item.id !== "es3" && item.id !== "en3",
      ),
      cards,
    });
    expect(lean.mediaByLanguage).toEqual({
      es: { images: 3, videos: 0 },
      en: { images: 3, videos: 0 },
    });
    expect(x("es", lean)).toEqual([]);
    expect(x("en", lean)).toEqual([]);
  });

  it("Instagram necesita imagen o video, y TikTok solo video", () => {
    expect(codes("instagram", "Solo texto.", withMedia("text", 0))).toEqual([
      "MEDIA_NOT_SUPPORTED",
    ]);
    expect(codes("linkedin", "Solo texto.", withMedia("text", 0))).toEqual([]);
    expect(codes("tiktok", "Fotos.", withMedia("image", 1))).toEqual(["MEDIA_NOT_SUPPORTED"]);
    expect(codes("tiktok", "Video.", withMedia("video", 0, 1))).toEqual([]);
  });

  it("un carrusel de Instagram lleva de 2 a 10 imágenes; una imagen suelta, al menos una (F9-T13)", () => {
    expect(codes("instagram", "Fotos.", withMedia("carousel", 1))).toEqual(["MEDIA_REQUIREMENT"]);
    expect(codes("instagram", "Fotos.", withMedia("carousel", 2))).toEqual([]);
    expect(codes("instagram", "Fotos.", withMedia("carousel", 10))).toEqual([]);
    expect(codes("instagram", "Fotos.", withMedia("carousel", 11))).toEqual([
      "MEDIA_NOT_SUPPORTED",
    ]);
    expect(codes("instagram", "Foto.", withMedia("image", 1))).toEqual([]);
    // Fuera de Instagram, el carrusel no tiene ese mínimo.
    expect(codes("linkedin", "Fotos.", withMedia("carousel", 1))).toEqual([]);
  });

  it("un post de imagen con varias fotos en Instagram avisa que sale solo la primera, sin impedir aprobar", () => {
    const checks = checkPostContent(
      "instagram",
      { body: "Foto.", hashtags: [] },
      withMedia("image", 3),
    );
    expect(checks.map((item) => [item.code, item.severity])).toEqual([["MEDIA_UNUSED", "warning"]]);
    expect(checks[0]?.message).toBe(
      "Instagram publicará solo la primera de 3 fotos; usa carrusel para publicarlas todas",
    );
    expect(hasContentErrors(checks)).toBe(false);
    expect(codes("instagram", "Foto.", withMedia("image", 1))).toEqual([]);
    expect(codes("linkedin", "Fotos.", withMedia("image", 3))).toEqual([]);
    expect(codes("instagram", "Fotos.", withMedia("carousel", 3))).toEqual([]);
  });

  it("un post de imágenes sin imágenes avisa «Falta la imagen» y se puede aprobar (F9.5-T21)", () => {
    const checks = checkPostContent(
      "linkedin",
      { body: "Fotos.", hashtags: [] },
      withMedia("image", 0),
    );
    expect(checks.map((item) => [item.code, item.severity])).toEqual([
      ["MEDIA_REQUIREMENT", "warning"],
    ]);
    expect(checks[0]?.message).toMatch(/^Falta la imagen: /);
    expect(hasContentErrors(checks)).toBe(false);
  });

  it("lo que falta se dice por tipo: imagen, imágenes del carrusel o video (F9.5-T21)", () => {
    const message = (platform: PostPlatform, kind: PostKind, images: number, videos = 0) =>
      checkPostContent(
        platform,
        { body: "Texto.", hashtags: [] },
        withMedia(kind, images, videos),
      )[0]?.message;
    expect(message("instagram", "image", 0)).toMatch(/^Falta la imagen: /);
    expect(message("instagram", "carousel", 0)).toMatch(/^Faltan las imágenes del carrusel: /);
    expect(message("instagram", "carousel", 1)).toMatch(
      /^Faltan las imágenes del carrusel: Instagram pide de 2 a 10 y este tiene 1/,
    );
    expect(message("instagram", "video", 0)).toMatch(/^Falta el video: /);
    // Un carrusel con una sola imagen falta, pero no es un error: el texto se aprueba.
    expect(
      hasContentErrors(
        checkPostContent("instagram", { body: "Fotos.", hashtags: [] }, withMedia("carousel", 1)),
      ),
    ).toBe(false);
  });

  it("un error real sigue siendo error aunque también falten los medios", () => {
    const checks = checkPostContent(
      "x",
      { body: "a".repeat(400), hashtags: [] },
      withMedia("image", 0),
    );
    expect(checks.map((item) => [item.code, item.severity])).toEqual([
      ["TOO_LONG", "error"],
      ["MEDIA_REQUIREMENT", "warning"],
    ]);
    expect(hasContentErrors(checks)).toBe(true);
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

  it("las muletillas de IA son una advertencia, en español y en inglés, en cualquier red", () => {
    const es = check("linkedin", "No es solo una herramienta, es un aliado. ¡Súmate! ¡Ya! ¡Hoy!");
    expect(es).toEqual([
      {
        code: "AI_TELL",
        severity: "warning",
        message:
          "Suena escrito por IA: «no es solo X, es Y», 3 signos de exclamación. Cámbialo por algo concreto o dilo más simple",
      },
    ]);
    expect(hasContentErrors(es)).toBe(false);
    const en = check("x", "Unlock seamless publishing — it's a game-changer 🚀🔥", context(), []);
    expect(en.map((item) => [item.code, item.severity])).toEqual([["AI_TELL", "warning"]]);
    expect(en[0]?.message).toContain(
      "«unlock», «seamless», «game-changer», guion largo como pausa",
    );
    expect(en[0]?.message).toContain("emojis seguidos (🚀🔥)");
    expect(codes("discord", "Descubre lo nuevo")).toEqual(["AI_TELL"]);
  });

  it("un texto concreto no tiene muletillas, y los hashtags no se revisan", () => {
    expect(codes("instagram", CLEAN_ES, context(), ["#descubre"])).toEqual([]);
    expect(codes("linkedin", CLEAN_EN)).toEqual([]);
  });
});
