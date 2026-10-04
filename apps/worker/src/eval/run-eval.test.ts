import { type NewListing, SAMPLE_CONTENT_DRAFT } from "@agentsales/core";
import {
  contentBrokerFixture,
  contentDefinitionsFixture,
  contentListingFixture,
  createInMemoryBrokerRepository,
  createInMemoryFieldDefinitionRepository,
  createInMemoryListingRepository,
  createInMemoryLlmProvider,
  LLM_ERRORS,
  type ScriptedLlmResponse,
} from "@agentsales/core/testing";
import { describe, expect, it } from "vitest";
import { DEFAULT_EVAL_BROKER, evalFolderName, fileNamer, runEval } from "./run-eval.js";

/** El borrador de ejemplo con un número que no está en los datos del aviso. */
const DRAFT_WITH_INVENTED_NUMBER = {
  ...SAMPLE_CONTENT_DRAFT,
  instagram: { ...SAMPLE_CONTENT_DRAFT.instagram, body: "Tiene 847 m² de jardín privado." },
};

const NOTES = "acepta ofertas bajo la tasación";
const ADDRESS = "Calle Secreta 4321";

/**
 * Un corredor de pruebas con avisos (por defecto, P001 listo y P009 en borrador); la IA responde
 * `responses`, en orden.
 */
async function setup(
  responses: ScriptedLlmResponse[],
  refs: readonly (readonly [string, boolean])[] = [
    ["P001", true],
    ["P009", false],
  ],
) {
  const broker = contentBrokerFixture({ slug: DEFAULT_EVAL_BROKER });
  const listings = createInMemoryListingRepository();
  const add = async (externalRef: string, ready: boolean) => {
    const {
      id: _id,
      status: _s,
      closeReason: _c,
      createdAt: _a,
      updatedAt: _u,
      ...rest
    } = contentListingFixture({
      externalRef,
      brokerId: broker.id,
      address: ADDRESS,
      internalNotes: NOTES,
    });
    const listing = await listings.create({
      ...(rest as Omit<NewListing, "sourceHash">),
      sourceHash: "h",
    });
    if (ready) await listings.promoteToReady(listing.id);
    return listing;
  };
  for (const [externalRef, ready] of refs) await add(externalRef, ready);
  const files = new Map<string, string>();
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    listings,
    brokers: createInMemoryBrokerRepository([broker]),
    fieldDefinitions: createInMemoryFieldDefinitionRepository(contentDefinitionsFixture()),
    llm: createInMemoryLlmProvider(responses),
    outDir: "/tmp/eval/prueba",
    writeFile: async (path: string, text: string) => void files.set(path, text),
    print: (line: string) => void out.push(line),
    printError: (line: string) => void err.push(line),
  };
  return { deps, files, out, err };
}

describe("pnpm eval:content (runEval)", () => {
  it("un borrador limpio sale con 0 y deja los textos en tmp/eval", async () => {
    const t = await setup([{ data: SAMPLE_CONTENT_DRAFT }]);

    expect(await runEval(t.deps, { brokerSlug: DEFAULT_EVAL_BROKER })).toBe(0);
    // Solo los avisos listos: P009 está en borrador.
    expect([...t.files.keys()]).toEqual(["/tmp/eval/prueba/P001.md"]);
    const text = t.files.get("/tmp/eval/prueba/P001.md") ?? "";
    expect(text).toContain("## Instagram");
    expect(text).toContain("## Portal Inmobiliario");
    expect(text).toContain("- sin problemas");
    expect(t.out[0]).toBe("✓ P001");
    expect(t.out).toContain("  Instagram: sin problemas");
    expect(t.out).toContain("Evaluadas 1 de 1 · con errores 0");
  });

  it("un número inventado sale con 1 y muestra el error del canal", async () => {
    const t = await setup([{ data: DRAFT_WITH_INVENTED_NUMBER }]);

    expect(await runEval(t.deps, { brokerSlug: DEFAULT_EVAL_BROKER })).toBe(1);
    expect(t.out[0]).toBe("✗ P001");
    expect(t.out.join("\n")).toMatch(/Instagram: ✗ NUMBER_NOT_IN_DATA: El número «847»/);
    expect(t.out).toContain("Evaluadas 1 de 1 · con errores 1");
  });

  it("si la IA falla, lo dice por aviso y sale con 1", async () => {
    const t = await setup([{ error: LLM_ERRORS.authRequired() }]);

    expect(await runEval(t.deps, { brokerSlug: DEFAULT_EVAL_BROKER })).toBe(1);
    expect(t.out[0]).toMatch(/^✗ P001: LLM_AUTH_REQUIRED: La CLI de Claude no tiene sesión/);
    expect(t.out).toContain("Evaluadas 0 de 1 · con errores 0 · no se pudieron evaluar 1");
    expect(t.files.size).toBe(0);
  });

  it("un corredor que no existe, o sin avisos listos, sale con 1 y lo explica", async () => {
    const t = await setup([]);

    expect(await runEval(t.deps, { brokerSlug: "otro" })).toBe(1);
    expect(t.err).toEqual(["✗ No existe el corredor otro: indica otro con --broker <slug>"]);

    const empty = await setup([]);
    const [ready] = await empty.deps.listings.list({ status: "ready" });
    await empty.deps.listings.changeStatus(ready?.id ?? "", "ready", "paused");
    expect(await runEval(empty.deps, { brokerSlug: DEFAULT_EVAL_BROKER })).toBe(1);
    expect(empty.err).toEqual([
      `✗ ${DEFAULT_EVAL_BROKER} no tiene propiedades listas para evaluar`,
    ]);
  });

  it("si la IA falla en un aviso, sigue con los demás y sale con 1", async () => {
    const t = await setup(
      [{ error: LLM_ERRORS.unavailable() }, { data: SAMPLE_CONTENT_DRAFT }],
      [
        ["P001", true],
        ["P002", true],
      ],
    );

    expect(await runEval(t.deps, { brokerSlug: DEFAULT_EVAL_BROKER })).toBe(1);
    expect(t.out[0]).toMatch(/^✗ P001: LLM_UNAVAILABLE/);
    expect(t.out).toContain("✓ P002");
    expect([...t.files.keys()]).toEqual(["/tmp/eval/prueba/P002.md"]);
    expect(t.out).toContain("Evaluadas 1 de 2 · con errores 0 · no se pudieron evaluar 1");
  });

  it("con Ctrl+C (signal) no pide nada más a la IA y sale con 1", async () => {
    const controller = new AbortController();
    const t = await setup(
      [{ data: SAMPLE_CONTENT_DRAFT }, { data: SAMPLE_CONTENT_DRAFT }],
      [
        ["P001", true],
        ["P002", true],
      ],
    );
    const write = t.deps.writeFile;
    t.deps.writeFile = async (path, text) => {
      await write(path, text);
      controller.abort(); // el operador corta después del primer aviso
    };

    expect(
      await runEval(t.deps, { brokerSlug: DEFAULT_EVAL_BROKER, signal: controller.signal }),
    ).toBe(1);
    expect(t.deps.llm.requests).toHaveLength(1);
    expect(t.out).toContain("Evaluación cortada: no se pidió nada más a la IA.");
    expect(t.out).toContain("Evaluadas 1 de 2 · con errores 0");
  });

  it("los textos no llevan la dirección ni las notas internas", async () => {
    const t = await setup([{ data: SAMPLE_CONTENT_DRAFT }]);

    await runEval(t.deps, { brokerSlug: DEFAULT_EVAL_BROKER });

    const text = [...t.files.values(), ...t.out].join("\n");
    expect(text).not.toContain("Secreta");
    expect(text).not.toContain("tasación");
  });

  it("un fallo que no es de la aplicación (la base) se propaga", async () => {
    const t = await setup([]);
    t.deps.listings.list = async () => {
      throw new Error("Connection terminated unexpectedly");
    };

    await expect(runEval(t.deps, { brokerSlug: DEFAULT_EVAL_BROKER })).rejects.toThrow(
      "Connection terminated",
    );
  });
});

describe("archivos de la evaluación", () => {
  it("nombres seguros y únicos para cualquier id_propiedad", () => {
    const nameOf = fileNamer();
    expect(nameOf("P001")).toBe("P001.md");
    expect(nameOf("A/1")).toBe("A_1.md");
    expect(nameOf("A_1")).toBe("A_1-2.md");
    expect(nameOf("../../etc")).toBe("__.._etc.md"); // sin barras: queda dentro de la carpeta
    expect(nameOf("..")).toBe("_.md");
    expect(nameOf("ñuñoa 3")).toBe("_u_oa_3.md");
  });

  it("la carpeta lleva la hora local con milisegundos", () => {
    expect(evalFolderName(new Date(2026, 9, 3, 21, 5, 7, 42))).toBe("2026-10-03_21-05-07-042");
  });
});
