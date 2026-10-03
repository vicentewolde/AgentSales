import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { createInMemoryHtmlRenderer, createInMemorySlideTemplates } from "./slides.js";

const photo = { mime: "image/jpeg" as const, sha256: "foto", bytes: new Uint8Array([1, 2]) };

describe("dobles de plantillas y render", () => {
  it("las plantillas devuelven el mismo HTML para los mismos datos, sin bytes", () => {
    const templates = createInMemorySlideTemplates("7");
    const data = {
      operation: "sale" as const,
      propertyType: "Casa",
      comuna: null,
      price: "UF 1",
      facts: [],
      photo,
      brand: { brandName: "X", primaryColor: "#000000", secondaryColor: "#FFFFFF", logo: null },
    };

    const first = templates.cover(data);
    expect(templates.cover({ ...data, photo: { ...photo, bytes: new Uint8Array([9]) } })).toBe(
      first,
    );
    expect(first).toContain("<!-- cover v7 -->");
    expect(first).not.toContain('"bytes"');
    expect(templates.calls.map((call) => call.kind)).toEqual(["cover", "cover"]);
  });

  it("el renderizador da bytes deterministas, registra, falla a pedido y respeta el signal", async () => {
    const renderer = createInMemoryHtmlRenderer({
      fail: (html) => (html === "malo" ? new AppError("RENDER_FAILED", "falló") : undefined),
    });
    const a = await renderer.render("a", { width: 1, height: 2, format: "png" });
    const again = await renderer.render("a", { width: 1, height: 2, format: "png" });
    const b = await renderer.render("b", { width: 1, height: 2, format: "png" });

    expect(a.sha256).toBe(again.sha256);
    expect(a.sha256).not.toBe(b.sha256);
    await expect(
      renderer.render("malo", { width: 1, height: 1, format: "jpeg" }),
    ).rejects.toMatchObject({
      code: "RENDER_FAILED",
    });
    const signal = { aborted: true, addEventListener() {}, removeEventListener() {} };
    await expect(
      renderer.render("a", { width: 1, height: 1, format: "jpeg" }, signal),
    ).rejects.toMatchObject({ code: "RENDER_ABORTED", retriable: true });
    expect(renderer.calls).toHaveLength(4);
  });
});
