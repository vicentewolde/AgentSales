import { describe, expect, it } from "vitest";
import {
  type CardStyle,
  cardFooterParts,
  cardFooterText,
  contrastRatio,
  lowContrastPairs,
  nextCardTheme,
  parseCardStyle,
  themeOfPost,
} from "./card-style.js";

// F9.7 B4 (ADR-0043, D3): el estilo de las imágenes es un esquema acotado.

const theme = {
  name: "Claro",
  background: { kind: "solid", color: "#f5f5f7" },
  text: "#1d1d1f",
  secondary: "#6e6e73",
  accent: "#1062f0",
  headlineGradient: { from: "#1062f0", to: "#0f766e" },
  card: { background: "#ffffff", text: "#1d1d1f", label: "#6e6e73" },
  hero: { background: "#1062f0", text: "#ffffff", label: "#e8efff", accent: "#e2fff4" },
  medal: { ring: ["#fdfdfe", "#8e97a1"], disc: ["#4d95ff", "#0a2f86"] },
  glow: null,
};
const style = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  fonts: {
    headline: { family: "inter-tight", weight: 600, tracking: -0.028 },
    body: { family: "inter", weight: 500 },
  },
  margins: { side: 80, top: 120, bottom: 106 },
  cardRadius: 34,
  logo: {
    kind: "svg",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="4" fill="currentColor"/></svg>',
  },
  showBrandName: true,
  themes: [theme],
  ...overrides,
});

const issuesOf = (input: unknown) => {
  try {
    parseCardStyle(input);
    return [];
  } catch (error) {
    return (error as { details: { issues: { field: string }[] } }).details.issues.map(
      (issue) => issue.field,
    );
  }
};

describe("parseCardStyle", () => {
  it("acepta un estilo completo", () => {
    expect(parseCardStyle(style()).themes).toHaveLength(1);
  });

  it("rechaza colores, fuentes, tracking y temas fuera de lo permitido", () => {
    expect(issuesOf(style({ themes: [{ ...theme, text: "red" }] }))).toContain("themes.0.text");
    expect(
      issuesOf(
        style({
          fonts: {
            headline: { family: "comic", weight: 600, tracking: -0.1 },
            body: { family: "inter", weight: 500 },
          },
        }),
      ),
    ).toEqual(expect.arrayContaining(["fonts.headline.family", "fonts.headline.tracking"]));
    expect(issuesOf(style({ themes: [theme, theme, theme, theme, theme] }))).toContain("themes");
    expect(issuesOf(style({ themes: [] }))).toContain("themes");
  });

  it("un SVG con scripts, enlaces o imágenes externas no sirve; las máscaras propias sí", () => {
    for (const svg of [
      "<svg><script>alert(1)</script></svg>",
      '<svg><image href="https://ejemplo.cl/x.png"/></svg>',
      '<svg><rect fill="url(https://x/y)"/></svg>',
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>',
      "no es un svg",
    ]) {
      expect(issuesOf(style({ logo: { kind: "svg", svg } })), svg).toEqual(["logo.svg"]);
    }
    expect(
      issuesOf(
        style({
          logo: {
            kind: "svg",
            svg: '<svg><defs><mask id="m"><rect/></mask></defs><g mask="url(#m)"/></svg>',
          },
        }),
      ),
    ).toEqual([]);
    expect(issuesOf(style({ logo: { kind: "png", base64: "R0lGODlh" } }))).toEqual(["logo.base64"]);
  });
});

describe("rotación y contraste", () => {
  it("el siguiente tema rota y el de un post se ajusta si el estilo tiene menos", () => {
    expect([nextCardTheme(null, 4), nextCardTheme(0, 4), nextCardTheme(3, 4)]).toEqual([0, 1, 0]);
    expect(themeOfPost(5, 4)).toBe(1);
  });

  it("los pares con menos de 4,5:1 se informan", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21);
    expect(
      lowContrastPairs(parseCardStyle(style()).themes[0] as CardStyle["themes"][number]),
    ).toEqual([]);
    const bad = parseCardStyle(style({ themes: [{ ...theme, secondary: "#c0c0c0" }] })).themes[0];
    expect(lowContrastPairs(bad as CardStyle["themes"][number]).map((pair) => pair.what)).toEqual([
      "secundario",
    ]);
  });
});

describe("el pie de las láminas", () => {
  const broker = { website: null, instagramHandle: null };
  const account = (platform: string, displayName: string, status = "connected") => ({
    platform,
    displayName,
    status,
  });

  it("el estilo acepta el pie (sitio y usuarios) y sin él sigue valiendo", () => {
    expect(parseCardStyle(style()).footer).toBeUndefined();
    expect(
      parseCardStyle(style({ footer: { website: "agentpey.com", instagram: "@agentpey" } })).footer,
    ).toEqual({ website: "agentpey.com", instagram: "@agentpey", x: null });
    expect(issuesOf(style({ footer: { website: "agent pey.com" } }))).toContain("footer.website");
    expect(issuesOf(style({ footer: { x: "{x} hola" } }))).toContain("footer.x");
    expect(issuesOf(style({ footer: { tiktok: "agentpey" } }))).toContain("footer");
  });

  it("arma «sitio · {instagram} usuario · {x} usuario» con lo del estilo", () => {
    const parts = cardFooterParts({
      footer: { website: "https://agentpey.com/", instagram: "@agentpey", x: "agentpeyai" },
      broker,
      accounts: [],
    });
    expect(parts).toEqual({ website: "agentpey.com", instagram: "agentpey", x: "agentpeyai" });
    expect(cardFooterText(parts)).toBe("agentpey.com · {instagram} agentpey · {x} agentpeyai");
  });

  it("lo que falta sale de la marca y de sus cuentas; lo que no está en ninguna parte no va", () => {
    expect(
      cardFooterParts({
        footer: undefined,
        broker: { website: "www.vinny.cl", instagramHandle: "@vinny" },
        accounts: [account("x", "@vinnyx"), account("instagram", "@otra")],
      }),
    ).toEqual({ website: "vinny.cl", instagram: "vinny", x: "vinnyx" });
    // Sin sitio ni Instagram en la marca: el Instagram de la cuenta (también la «a mano»).
    const fromAccounts = cardFooterParts({
      footer: { website: null, instagram: null, x: null },
      broker,
      accounts: [
        account("x", "@vieja", "revoked"),
        account("instagram", "@agentpey", "expired"),
        account("linkedin", "AgentPey"),
      ],
    });
    expect(fromAccounts).toEqual({ website: null, instagram: "agentpey", x: null });
    expect(cardFooterText(fromAccounts)).toBe("{instagram} agentpey");
    // Un nombre que no es un usuario no se usa como tal.
    expect(
      cardFooterParts({ footer: undefined, broker, accounts: [account("x", "Agent Pey")] }).x,
    ).toBeNull();
    expect(cardFooterText({ website: null, instagram: null, x: null })).toBeNull();
  });
});
