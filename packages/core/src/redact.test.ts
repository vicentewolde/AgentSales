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

  it("deja visibles un comando de un tramo, una proporción y el texto normal", () => {
    const message = "Abre `claude` y usa /login; proporción 4:5 a 1,91:1 en dry-run";
    expect(scrubMessage(message)).toBe(message);
  });
});
