import { describe, expect, it } from "vitest";
import { REDACTED, redactText } from "./redact.js";

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

  it("no confunde otros parámetros que terminan en code", () => {
    expect(redactText("https://x.test/e?error_code=190&error_subcode=463")).toBe(
      "https://x.test/e?error_code=190&error_subcode=463",
    );
  });

  it("deja intacto un texto sin URLs sensibles", () => {
    expect(redactText("bucket inaccesible")).toBe("bucket inaccesible");
  });
});
