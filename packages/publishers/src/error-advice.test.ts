import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERIC_ERROR_ADVICE, publicationErrorAdvice } from "@agentsales/core";
import { describe, expect, it } from "vitest";

// F9-T19 (spec F9 §5): cada código de error que puede producir el publisher o la conexión de una
// red de contenido de marca tiene su consejo en `publicationErrorAdvice` (el panel y la CLI lo
// muestran bajo el error). La prueba lee el código de cada red (los archivos de su carpeta, sin
// subcarpetas) y junta todo literal `"PREFIJO_…"`: un código nuevo sin consejo la hace fallar. Es
// amplia a propósito (los códigos se escriben en `error(…)`, listas y `code:`), así que un literal
// con el prefijo que no sea un código también pide consejo o entrar a una lista. No ve códigos
// armados con plantillas (hoy no hay) ni los de la conexión de Instagram (`INSTAGRAM_*`, `OAUTH_*`),
// que se cubren en `F9_CONNECT_AND_RETIRE` de core.

const NETWORKS = {
  instagram: "IG_",
  linkedin: "LINKEDIN_",
  x: "X_",
  discord: "DISCORD_",
  tiktok: "TIKTOK_",
} as const;

/**
 * Los motivos de `validate` (`PublishIssue`): nunca quedan como código en `last_error`, sino dentro
 * de `PUBLISH_INPUT_INVALID` (que tiene su consejo) o en las verificaciones del texto.
 */
const VALIDATION_ISSUES = new Set([
  "LINKEDIN_TEXT_EMPTY",
  "LINKEDIN_MIXED_MEDIA",
  "LINKEDIN_TOO_MANY_IMAGES",
  "LINKEDIN_TOO_MANY_VIDEOS",
  "LINKEDIN_IMAGE_TYPE",
  "LINKEDIN_IMAGE_TOO_LARGE",
  "LINKEDIN_VIDEO_TYPE",
  "LINKEDIN_VIDEO_SIZE",
  "LINKEDIN_VIDEO_DURATION",
  "X_EMPTY_POST",
  "X_TEXT_TOO_LONG",
  "X_MEDIA_MIXED",
  "X_TOO_MANY_IMAGES",
  "X_TOO_MANY_VIDEOS",
  "X_IMAGE_TYPE",
  "X_IMAGE_TOO_LARGE",
  "X_VIDEO_TOO_LARGE",
  "X_VIDEO_DURATION",
  "DISCORD_EMPTY_MESSAGE",
  "DISCORD_TEXT_TOO_LONG",
  "DISCORD_TOO_MANY_FILES",
  "DISCORD_REQUEST_TOO_LARGE",
  "TIKTOK_VIDEO_REQUIRED",
  "TIKTOK_ONE_VIDEO_ONLY",
  "TIKTOK_VIDEO_FORMAT",
  "TIKTOK_VIDEO_TOO_LARGE",
  "TIKTOK_VIDEO_TOO_LONG",
  "TIKTOK_TEXT_TOO_LONG",
]);

const here = fileURLToPath(new URL(".", import.meta.url));

/** Los literales `"PREFIJO_…"` del código (sin las pruebas) de una red. */
function codesOf(network: keyof typeof NETWORKS): string[] {
  const dir = join(here, network);
  const pattern = new RegExp(`"(${NETWORKS[network]}[A-Z0-9_]+)"`, "g");
  const codes = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    for (const match of readFileSync(join(dir, file), "utf8").matchAll(pattern)) {
      if (match[1] !== undefined) codes.add(match[1]);
    }
  }
  return [...codes].sort();
}

describe("cada error de una red tiene su consejo (F9-T19)", () => {
  for (const network of Object.keys(NETWORKS) as Array<keyof typeof NETWORKS>) {
    const codes = codesOf(network);

    it(`${network}: encuentra sus códigos`, () => {
      expect(codes.length).toBeGreaterThan(5);
    });

    it.each(codes.filter((code) => !VALIDATION_ISSUES.has(code)))(
      `${network}: %s dice qué hacer`,
      (code) => {
        const advice = publicationErrorAdvice(code);
        expect(advice).not.toBe(GENERIC_ERROR_ADVICE);
        expect(advice.endsWith(".")).toBe(true);
      },
    );
  }

  it("la lista de motivos de validate no tiene códigos que ya no existen", () => {
    const all = new Set(
      (Object.keys(NETWORKS) as Array<keyof typeof NETWORKS>).flatMap((network) =>
        codesOf(network),
      ),
    );
    expect([...VALIDATION_ISSUES].filter((code) => !all.has(code))).toEqual([]);
  });
});
