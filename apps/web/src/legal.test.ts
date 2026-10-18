import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// F8-T18 (spec F8 D19): las páginas públicas son HTML estático (el revisor de Meta no corre
// JavaScript) y dicen lo que pide Meta (nota de Instagram §13.4 y §13.5). Que se sirvan sin sesión y
// con la CSP lo prueba la API (`server-app.test.ts`).

const page = (name: string) =>
  readFileSync(new URL(`../public/legal/${name}.html`, import.meta.url), "utf8");
const PAGES = ["terminos", "privacidad", "eliminacion-de-datos"] as const;

describe("páginas públicas", () => {
  it.each(PAGES)(
    "%s: en español, sin JavaScript ni estilos en línea, marcada como borrador",
    (name) => {
      const html = page(name);
      expect(html).toMatch(/^<!doctype html>\n<html lang="es">/);
      expect(html).not.toMatch(/<script|<style|style=|\son[a-z]+=/i);
      expect(html).toContain('<link rel="stylesheet" href="/legal/legal.css">');
      // Hasta que el operador la apruebe (F8-T18): el aviso y los datos por completar.
      expect(html).toContain("Borrador en revisión");
      // Enlaza a las otras dos y a Entrar.
      for (const other of PAGES.filter((p) => p !== name)) {
        expect(html).toContain(`href="/legal/${other}.html"`);
      }
      expect(html).toContain('href="/entrar"');
    },
  );

  it("los datos del responsable están completos; solo falta la fecha de aprobación", () => {
    for (const name of PAGES) {
      const html = page(name);
      expect(html).toContain('href="mailto:vicente@agentpey.com"');
      // Lo único que queda entre corchetes es la fecha, que se pone al aprobar los textos.
      const pending = html.match(/\[[A-ZÁÉÍÓÚÑ ]+\]/g) ?? [];
      expect(pending).toEqual(["[FECHA DE APROBACIÓN]"]);
    }
    expect(page("privacidad")).toContain("Vicente Wolde Cepeda");
    expect(page("privacidad")).toContain("15 días hábiles");
    expect(page("terminos")).toContain("sin costo durante 7 días");
  });

  it("la privacidad dice qué datos, para qué, los proveedores y cómo pedir el borrado", () => {
    const html = page("privacidad");
    for (const text of [
      "Qué datos guardamos",
      "Para qué los usamos",
      "token de acceso",
      "No vendemos",
      "Neon",
      "Cloudflare R2",
      "Fly.io",
      "Anthropic",
      "Cómo borrar tus datos",
      "Reportar un problema de seguridad",
    ]) {
      expect(html).toContain(text);
    }
  });

  it("los términos piden revisar los textos de la IA antes de publicar y dan el contacto", () => {
    const html = page("terminos");
    expect(html).toContain("Revisa y aprueba cada texto antes de publicarlo");
    expect(html).toContain("Ayuda y seguridad");
    expect(html).toContain('href="mailto:');
  });

  it("borrar los datos explica quitar la app en Instagram, el correo y lo que no se borra", () => {
    const html = page("eliminacion-de-datos");
    expect(html).toContain("Si conectaste tu cuenta de Instagram");
    expect(html).toContain("Por correo");
    expect(html).toContain("Qué no podemos borrar nosotros");
  });
});
