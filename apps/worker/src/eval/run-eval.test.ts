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
import { DEFAULT_EVAL_BROKER, runEval } from "./run-eval.js";

/** El borrador de ejemplo con un número que no está en los datos del aviso. */
const DRAFT_WITH_INVENTED_NUMBER = {
  ...SAMPLE_CONTENT_DRAFT,
  instagram: { ...SAMPLE_CONTENT_DRAFT.instagram, body: "Tiene 847 m² de jardín privado." },
};

/** Un corredor de pruebas con un aviso listo y otro en borrador; la IA responde `responses`. */
async function setup(responses: ScriptedLlmResponse[]) {
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
    } = contentListingFixture({ externalRef, brokerId: broker.id });
    const listing = await listings.create({
      ...(rest as Omit<NewListing, "sourceHash">),
      sourceHash: "h",
    });
    if (ready) await listings.promoteToReady(listing.id);
    return listing;
  };
  await add("P001", true);
  await add("P009", false);
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
});
