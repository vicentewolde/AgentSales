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

  it("deja intacto un texto sin URLs sensibles", () => {
    expect(redactText("bucket inaccesible")).toBe("bucket inaccesible");
  });
});
