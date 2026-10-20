import { GENERIC_ERROR_ADVICE, publicationErrorAdvice } from "@agentsales/core";
import { describe, expect, it } from "vitest";
import { OAUTH_PROVIDERS, OAUTH_REDIRECT_ERRORS } from "../contracts/index.js";

// F9-T19: cada código con que el OAuth vuelve al panel (`/cuentas?error=<código>`) tiene su consejo
// en `publicationErrorAdvice`, leído de la lista del contrato: un código nuevo sin consejo hace
// fallar esta prueba. El texto que ve el operador en el panel es `oauthErrorText` (con el nombre de
// la red); su prueba, por cada código y proveedor, está en
// `apps/web/src/components/accounts/accounts.test.ts`. Los códigos propios de cada red que también
// pueden volver (`IG_*`, `LINKEDIN_*`, `X_*`, `TIKTOK_*`) los cubre
// `packages/publishers/src/error-advice.test.ts`.

describe("los errores de la vuelta del OAuth dicen qué hacer (F9-T19)", () => {
  it.each([...OAUTH_REDIRECT_ERRORS])("%s tiene su consejo", (code) => {
    const advice = publicationErrorAdvice(code);
    expect(advice).not.toBe(GENERIC_ERROR_ADVICE);
    expect(advice.endsWith(".")).toBe(true);
  });

  it("cada red que conecta por OAuth tiene su código de app sin configurar, con consejo", () => {
    // `<RED>_NOT_CONFIGURED`: sin el par de la app en la API, conectar vuelve con ese código.
    const notConfigured = OAUTH_PROVIDERS.map(
      (provider) => `${provider.toUpperCase()}_NOT_CONFIGURED`,
    );
    expect(
      notConfigured.filter((code) => !(OAUTH_REDIRECT_ERRORS as readonly string[]).includes(code)),
    ).toEqual([]);
    for (const code of notConfigured) {
      expect(publicationErrorAdvice(code)).not.toBe(GENERIC_ERROR_ADVICE);
    }
  });
});
