import { describe, expect, it } from "vitest";
import { toPgConnectionString } from "./client.js";

describe("toPgConnectionString", () => {
  it("fija sslmode=verify-full para mantener la verificación del certificado", () => {
    const url = toPgConnectionString(
      "postgresql://owner:fake%40pass@ep-test.sa-east-1.aws.neon.tech/neondb?sslmode=require",
    );

    expect(url).toBe(
      "postgresql://owner:fake%40pass@ep-test.sa-east-1.aws.neon.tech/neondb?sslmode=verify-full",
    );
  });

  it("no toca otros modos ni otros parámetros", () => {
    const url = "postgresql://o:p@ep-test.neon.tech/db?sslmode=verify-full&application_name=x";

    expect(toPgConnectionString(url)).toBe(url);
  });
});
