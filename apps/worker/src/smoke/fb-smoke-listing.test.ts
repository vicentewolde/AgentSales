import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPublicationScenario } from "@agentsales/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerFakeFacebook } from "../../test/fake-facebook.js";
import {
  type FbSmokeListingDeps,
  parseFbSmokeDiagnostics,
  runFbSmokeListing,
} from "./fb-smoke-listing.js";

// F5-T10: `fb:smoke --listing` con el publisher de verdad contra un Facebook falso de páginas
// locales (sin red). Llena el formulario después de la confirmación del operador, respeta el
// límite del día y nunca cambia estados ni deja eventos en AgentSales.

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function setup(
  options: { approve?: boolean; account?: boolean; liveAttemptsToday?: number; form?: string } = {},
) {
  const fb = await createWorkerFakeFacebook({
    "/marketplace/create/rental": options.form ?? "form.html",
  });
  cleanups.push(async () => {
    await fb.cleanup();
    expect(fb.unexpected).toEqual([]);
  });
  const t = await createPublicationScenario({
    platform: "fb_marketplace",
    approve: options.approve ?? true,
    account: options.account ?? true,
  });
  const listing = await t.listings.get(t.listingId);
  const out: string[] = [];
  const err: string[] = [];
  const questions: string[] = [];
  const answers: Array<string | null> = [];
  const counted: string[] = [];
  const deps: FbSmokeListingDeps = {
    brokers: t.brokers,
    listings: t.listings,
    accounts: t.platformAccounts,
    contents: t.contents,
    media: t.media,
    storage: t.storage,
    // Solo cuenta: el tipo no deja escribir, y el test lo revisa además con una foto de la base.
    publications: {
      async countLiveAttemptsSince(accountId) {
        counted.push(accountId);
        return options.liveAttemptsToday ?? 0;
      },
    },
    uf: {
      async valuesBetween(from, to) {
        return [
          { date: from, value: "41126.12" },
          { date: to, value: "41130.94" },
        ];
      },
    },
    dailyLimit: 3,
    openProfile: (brokerId) => fb.openProfile(brokerId),
    outputDir: join(fb.root, "tmp", "fb-smoke"),
    ask: async (question) => {
      questions.push(question);
      return answers.shift() ?? null;
    },
    now: () => new Date("2026-10-12T15:00:00Z"),
    print: (line) => out.push(line),
    printError: (line) => err.push(line),
    tuning: {
      fill: { pauseMs: 0, controlWaitMs: 1_000, photosWaitMs: 5_000, guardWaitMs: 1_000 },
      formWaitMs: 2_000,
      profileBusyWaitMs: 0,
    },
    closedPollMs: 20,
  };
  const before = JSON.stringify(t.publications.all());
  return {
    t,
    fb,
    deps,
    out,
    err,
    questions,
    answers,
    counted,
    ref: listing?.externalRef ?? "",
    listingId: t.listingId,
    unchanged: () => JSON.stringify(t.publications.all()) === before,
  };
}

describe("pnpm fb:smoke --listing", () => {
  it("pregunta, llena el formulario y espera a que el operador cierre la ventana, sin cambiar nada", async () => {
    const s = await setup();
    s.answers.push("s");

    const running = runFbSmokeListing(s.deps, { listingRef: s.ref });
    await expect.poll(() => s.out.join("\n"), { timeout: 10_000 }).toContain("Formulario lleno");
    const page = s.fb.profiles[0]?.page;
    if (page === undefined) throw new Error("no se abrió el perfil");
    expect(await page.locator('[name="precio"]').inputValue()).toBe("238559452");
    const clicks = await page.evaluate(
      () => (globalThis as unknown as { __clicks: string[] }).__clicks,
    );
    expect(clicks).not.toContain("siguiente");
    expect(clicks).not.toContain("publicar");
    // El operador revisa y cierra la ventana.
    await s.fb.profiles[0]?.close();

    await expect(running).resolves.toBe(0);
    expect(s.questions).toEqual(["¿Llenar el formulario real de Facebook? s/N "]);
    const out = s.out.join("\n");
    expect(out).toContain("Intentos en vivo de la cuenta hoy: 0 de 3.");
    expect(out).toContain("$238.559.452 (UF del 2026-10-12: $41.130,94)");
    expect(out).toContain("borra a mano el borrador");
    expect(out).toContain("No se cambió nada en AgentSales");
    expect(s.counted).toEqual([s.t.account?.id]);
    expect(s.unchanged()).toBe(true);
  });

  it("un corredor que no es propio (F7): se detiene sin preguntar ni abrir nada", async () => {
    const s = await setup();
    const listing = await s.t.listings.get(s.listingId);
    await s.t.brokers.setSettings(listing?.brokerId ?? "", { operatorOwned: false });

    await expect(runFbSmokeListing(s.deps, { listingRef: s.ref, yes: true })).resolves.toBe(1);
    expect(s.fb.profiles).toEqual([]);
    expect(s.questions).toEqual([]);
    expect(s.err.join("\n")).toContain("solo para tus corredores");
    expect(s.unchanged()).toBe(true);
  });

  it("sin un sí no abre nada", async () => {
    const s = await setup();
    s.answers.push("n");

    await expect(runFbSmokeListing(s.deps, { listingRef: s.ref })).resolves.toBe(1);
    expect(s.fb.profiles).toEqual([]);
    expect(s.out.join("\n")).toContain("No se llenó nada");
    expect(s.unchanged()).toBe(true);
  });

  it("con --yes no pregunta", async () => {
    const s = await setup();

    const running = runFbSmokeListing(s.deps, { listingRef: s.ref, yes: true });
    await expect.poll(() => s.out.join("\n"), { timeout: 10_000 }).toContain("Formulario lleno");
    await s.fb.profiles[0]?.close();

    await expect(running).resolves.toBe(0);
    expect(s.questions).toEqual([]);
  });

  it("con el límite del día alcanzado se niega sin preguntar ni abrir nada", async () => {
    const s = await setup({ liveAttemptsToday: 3 });

    await expect(runFbSmokeListing(s.deps, { listingRef: s.ref, yes: true })).resolves.toBe(1);
    expect(s.err.join("\n")).toContain("MARKETPLACE_DAILY_LIMIT");
    expect(s.out.join("\n")).toContain("3 de 3");
    expect(s.questions).toEqual([]);
    expect(s.fb.profiles).toEqual([]);
  });

  it("sin el texto de Marketplace aprobado no sigue", async () => {
    const s = await setup({ approve: false });

    await expect(runFbSmokeListing(s.deps, { listingRef: s.ref, yes: true })).resolves.toBe(1);
    expect(s.err.join("\n")).toContain("CONTENT_NOT_APPROVED");
    expect(s.err.join("\n")).toContain("--platform marketplace");
    expect(s.fb.profiles).toEqual([]);
  });

  it("sin el Facebook del corredor conectado no sigue", async () => {
    const s = await setup({ account: false });

    await expect(runFbSmokeListing(s.deps, { listingRef: s.ref, yes: true })).resolves.toBe(1);
    expect(s.err.join("\n")).toContain("accounts connect marketplace");
  });

  it("Ctrl+C con el formulario lleno cierra la ventana", async () => {
    const s = await setup();
    const abort = new AbortController();

    const running = runFbSmokeListing(s.deps, {
      listingRef: s.ref,
      yes: true,
      signal: abort.signal,
    });
    await expect.poll(() => s.out.join("\n"), { timeout: 10_000 }).toContain("Formulario lleno");
    abort.abort();

    await expect(running).resolves.toBe(0);
    expect(s.fb.profiles[0]?.isOpen()).toBe(false);
  });

  it("una propiedad que no existe se dice", async () => {
    const s = await setup();

    await expect(runFbSmokeListing(s.deps, { listingRef: "NO-EXISTE", yes: true })).resolves.toBe(
      1,
    );
    expect(s.err.join("\n")).toContain("LISTING_NOT_FOUND");
  });

  describe("--diagnostico", () => {
    it("entiende las variantes y rechaza las que no conoce", () => {
      expect(parseFbSmokeDiagnostics(undefined)).toEqual([]);
      expect(parseFbSmokeDiagnostics("errores, lento")).toEqual(["errores", "lento"]);
      expect(() => parseFbSmokeDiagnostics("rapido")).toThrow(/no conozco: rapido/);
      expect(() => parseFbSmokeDiagnostics(" , ")).toThrow(/admite: errores/);
    });

    it("sin fotos y sin evidencia llena el resto, y anota los errores de la página", async () => {
      const s = await setup({ form: "form-con-error.html" });

      const running = runFbSmokeListing(s.deps, {
        listingRef: s.ref,
        yes: true,
        diagnostics: ["errores", "sin-fotos", "sin-evidencia"],
      });
      await expect.poll(() => s.out.join("\n"), { timeout: 10_000 }).toContain("Formulario lleno");
      const page = s.fb.profiles[0]?.page;
      if (page === undefined) throw new Error("no se abrió el perfil");
      // Llenó el resto, pero no subió las fotos.
      expect(await page.locator('[name="precio"]').inputValue()).toBe("238559452");
      expect(await page.locator("#estado-fotos").innerText()).toBe("Se han adjuntado 0 fotos");
      await s.fb.profiles[0]?.close();

      await expect(running).resolves.toBe(0);
      const out = s.out.join("\n");
      expect(out).toContain("Modo diagnóstico: errores, sin-fotos, sin-evidencia.");
      expect(out).toMatch(/Diagnóstico: [1-9]\d* línea\(s\) anotadas en errores-de-la-pagina\.txt/);
      const dir = join(s.deps.outputDir, `fb-smoke-${s.listingId}`);
      expect(await readdir(dir)).toEqual(["errores-de-la-pagina.txt"]);
      const text = await readFile(join(dir, "errores-de-la-pagina.txt"), "utf8");
      expect(text).toContain("ERROR DE LA PÁGINA  Boom <url> <id>");
      expect(text).not.toContain("SECRETO");
      expect(s.unchanged()).toBe(true);
    });

    it("sin --diagnostico no anota nada ni omite nada", async () => {
      const s = await setup({ form: "form-con-error.html" });

      const running = runFbSmokeListing(s.deps, { listingRef: s.ref, yes: true });
      await expect.poll(() => s.out.join("\n"), { timeout: 10_000 }).toContain("Formulario lleno");
      await s.fb.profiles[0]?.close();

      await expect(running).resolves.toBe(0);
      expect(s.out.join("\n")).not.toContain("Modo diagnóstico");
      const dir = join(s.deps.outputDir, `fb-smoke-${s.listingId}`);
      expect((await readdir(dir)).sort()).toEqual(["formulario.aria.yml", "formulario.png"]);
    });
  });
});
