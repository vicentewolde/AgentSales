import { describe, expect, it } from "vitest";
import { REDACTED, redactText, scrubMessage } from "./redact.js";

describe("redactText", () => {
  it("oculta credenciales y parámetros sensibles de URLs en un texto libre", () => {
    expect(redactText("falló postgresql://u:p@host/db y https://x.test/a?api_key=k1&page=2")).toBe(
      `falló postgresql://${REDACTED}@host/db y https://x.test/a?api_key=${REDACTED}&page=2`,
    );
  });

  it("oculta firmas y credenciales de URLs prefirmadas", () => {
    expect(redactText("https://r2.test/o.jpg?X-Amz-Credential=AK&X-Amz-Signature=abc")).toBe(
      `https://r2.test/o.jpg?X-Amz-Credential=${REDACTED}&X-Amz-Signature=${REDACTED}`,
    );
  });

  it("oculta el code del OAuth y los secretos de un cuerpo de formulario (F3)", () => {
    expect(redactText("GET /oauth/instagram/callback?code=AQBx123#_&state=s1 respondió 302")).toBe(
      `GET /oauth/instagram/callback?code=${REDACTED}#_&state=s1 respondió 302`,
    );
    expect(
      redactText("client_id=1&client_secret=s3cr3t&grant_type=authorization_code&code=AQB"),
    ).toBe(`client_id=1&client_secret=${REDACTED}&grant_type=authorization_code&code=${REDACTED}`);
    expect(redactText("cuerpo: access_token=IGAA1&user_id=9")).toBe(
      `cuerpo: access_token=${REDACTED}&user_id=9`,
    );
  });

  it("no confunde otros parámetros que terminan en code, ni code en un mensaje", () => {
    expect(redactText("https://x.test/e?error_code=190&error_subcode=463")).toBe(
      "https://x.test/e?error_code=190&error_subcode=463",
    );
    expect(redactText("status code=500 retry; Error code=ECONNRESET")).toBe(
      "status code=500 retry; Error code=ECONNRESET",
    );
  });

  it("oculta el code en un fragmento y los valores sensibles de un JSON", () => {
    expect(redactText("https://x.test/cb#code=AQB&state=s")).toBe(
      `https://x.test/cb#code=${REDACTED}&state=s`,
    );
    expect(redactText('{"access_token": "IGAA\\"x", "user_id": 9, "client_secret":"s"}')).toBe(
      `{"access_token": "${REDACTED}", "user_id": 9, "client_secret":"${REDACTED}"}`,
    );
  });

  describe("tokens de Mercado Libre (F4)", () => {
    const ACCESS = "APP_USR-6092-3246532-cb45c82853f6e620bb0deda096b128d3-8035443";
    const REFRESH = "TG-5b9032b4e23464aed1f959f-1234567";
    const CODE = "TG-61a7c3f0e4b0a1000a1b2c3d-8035443";

    it("en la URL de vuelta del OAuth y en una URL con otros nombres de parámetro", () => {
      expect(
        redactText(
          `https://localhost/oauth/mercadolibre/callback?code=${CODE}&state=s1 copiada en la CLI`,
        ),
      ).toBe(
        `https://localhost/oauth/mercadolibre/callback?code=${REDACTED}&state=s1 copiada en la CLI`,
      );
      expect(redactText(`https://x.test/a?t=${ACCESS}&r=${REFRESH}&page=2`)).toBe(
        `https://x.test/a?t=${REDACTED}&r=${REDACTED}&page=2`,
      );
    });

    it("en el cuerpo de formulario del canje y del refresco", () => {
      expect(
        redactText(
          `grant_type=refresh_token&client_id=123&client_secret=s3cr3t&refresh_token=${REFRESH}`,
        ),
      ).toBe(
        `grant_type=refresh_token&client_id=123&client_secret=${REDACTED}&refresh_token=${REDACTED}`,
      );
      expect(
        redactText(
          `grant_type=authorization_code&client_id=123&code=${CODE}&redirect_uri=https://localhost/cb`,
        ),
      ).toBe(
        `grant_type=authorization_code&client_id=123&code=${REDACTED}&redirect_uri=https://localhost/cb`,
      );
    });

    it("en el JSON de la respuesta del canje, también con una clave que no es sensible", () => {
      expect(
        redactText(
          `{"access_token":"${ACCESS}","token_type":"Bearer","expires_in":21600,"scope":"offline_access read write","user_id":8035443,"refresh_token":"${REFRESH}"}`,
        ),
      ).toBe(
        `{"access_token":"${REDACTED}","token_type":"${REDACTED}","expires_in":21600,"scope":"offline_access read write","user_id":8035443,"refresh_token":"${REDACTED}"}`,
      );
      expect(redactText(`{"code": "${CODE}", "access": "${ACCESS}"}`)).toBe(
        `{"code": "${REDACTED}", "access": "${REDACTED}"}`,
      );
    });

    it("sueltos en un mensaje o una cabecera", () => {
      expect(redactText(`Authorization: Bearer ${ACCESS} rechazado (401)`)).toBe(
        `Authorization: Bearer ${REDACTED} rechazado (401)`,
      );
      expect(redactText(`el refresh ${REFRESH} ya se usó`)).toBe(
        `el refresh ${REDACTED} ya se usó`,
      );
    });

    it("codificados en una URL o escapados en un JSON", () => {
      expect(redactText(`https://x.test/r?next=%2Fcb%3Fcode%3D${CODE}%26state%3Ds`)).toBe(
        `https://x.test/r?next=%2Fcb%3Fcode%3D${REDACTED}%26state%3Ds`,
      );
      expect(redactText(`Authorization: Bearer%20${ACCESS}`)).toBe(
        `Authorization: Bearer%20${REDACTED}`,
      );
      expect(redactText(`{"msg":"falló\\n${REFRESH}"}`)).toBe(`{"msg":"falló\\n${REDACTED}"}`);
    });

    it("deja visibles los códigos de error, el sitio y palabras parecidas", () => {
      const text = "ML_AUTH_INVALID en MLC: invalid_grant (TG-1, TG-ab12, APP_USR sin guion)";

      expect(redactText(text)).toBe(text);
    });
  });

  describe("webhooks de Discord (F9)", () => {
    // Sin la palabra "token": un parámetro con ese nombre ya se oculta por su lado.
    const TOKEN = "falso_DE-prueba123abc";
    const KEPT = "https://discord.com/api/webhooks/123456789012345678/";

    it("oculta el token del final y deja visible el id", () => {
      expect(redactText(`POST ${KEPT}${TOKEN} respondió 404`)).toBe(
        `POST ${KEPT}${REDACTED} respondió 404`,
      );
      expect(redactText(`https://discordapp.com/api/webhooks/1/${TOKEN}?wait=true`)).toBe(
        `https://discordapp.com/api/webhooks/1/${REDACTED}?wait=true`,
      );
      expect(redactText(`https://ptb.discord.com/api/v10/webhooks/1/${TOKEN}/messages/2`)).toBe(
        `https://ptb.discord.com/api/v10/webhooks/1/${REDACTED}/messages/2`,
      );
    });

    it("también codificado en una URL, escapado en un JSON y en mayúsculas", () => {
      for (const text of [
        `https://x.test/r?to=https%3A%2F%2Fdiscord.com%2Fapi%2Fwebhooks%2F1%2F${TOKEN}`,
        `{"url":"https:\\/\\/discord.com\\/api\\/webhooks\\/1\\/${TOKEN}"}`,
        `HTTPS://DISCORD.COM/API/WEBHOOKS/1/${TOKEN}`,
        `{"webhookUrl": "${KEPT}${TOKEN}"}`,
      ]) {
        const redacted = redactText(text);
        expect(redacted, text).not.toContain(TOKEN);
        expect(redacted).toContain(REDACTED);
      }
    });

    it("deja visibles otras URLs de Discord y el nombre en un mensaje", () => {
      const text = "Discord rechazó el archivo: https://discord.com/channels/1/2 (webhooks 1/2)";
      expect(redactText(text)).toBe(text);
    });
  });

  describe("Bearer de cualquier plataforma (F9)", () => {
    it("en una cabecera, un JSON, codificado y con mayúsculas", () => {
      expect(redactText("Authorization: Bearer AAAA.bbb-ccc_ddd= rechazado")).toBe(
        `Authorization: Bearer ${REDACTED} rechazado`,
      );
      expect(redactText(`{"authorization":"Bearer li-token-falso"}`)).toBe(
        `{"authorization":"Bearer ${REDACTED}"}`,
      );
      expect(redactText("authorization=bearer%20x-token-falso&b=1")).toBe(
        `authorization=bearer%20${REDACTED}&b=1`,
      );
      expect(redactText("BEARER tiktok-token-falso, reintenta")).toBe(
        `BEARER ${REDACTED}, reintenta`,
      );
    });

    it("deja visible una palabra que solo contiene bearer", () => {
      const text = "cardbearer sin token; Bearer";
      expect(redactText(text)).toBe(text);
    });
  });

  it("deja intacto un texto sin URLs sensibles", () => {
    expect(redactText("bucket inaccesible")).toBe("bucket inaccesible");
  });
});

describe("scrubMessage", () => {
  it("quita claves de R2, rutas de disco (también entre comillas) y secretos de URLs firmadas", () => {
    const message = [
      "No existe brokers/b1/listings/l1/a.jpg",
      "ENOENT: no such file '/Users/op/tmp/x.jpg' (/var/folders/a/b)",
      "leyendo data/muestras/propiedades.xlsx y ./tmp/imports/x",
      "https://bucket.r2.cloudflarestorage.com/k?X-Amz-Credential=AKIA&X-Amz-Signature=abc123",
      "y .env",
    ].join(" ");
    const scrubbed = scrubMessage(message);
    for (const leak of [
      "brokers/",
      "/Users/op",
      "/var/folders",
      "data/muestras",
      "./tmp",
      "AKIA",
      "abc123",
      ".env",
    ]) {
      expect(scrubbed).not.toContain(leak);
    }
    expect(scrubbed).toContain("https://bucket.r2.cloudflarestorage.com/k");
  });

  it("oculta el token de un webhook de Discord y un Bearer (F9)", () => {
    const scrubbed = scrubMessage(
      "POST https://discord.com/api/webhooks/1/token-falso-1 falló con Bearer token-falso-2",
    );
    expect(scrubbed).not.toMatch(/token-falso/);
    expect(scrubbed).toContain(`https://discord.com/api/webhooks/1/${REDACTED}`);
  });

  it("deja visibles un comando de un tramo, una proporción y el texto normal", () => {
    const message = "Abre `claude` y usa /login; proporción 4:5 a 1,91:1 en dry-run";
    expect(scrubMessage(message)).toBe(message);
  });
});
