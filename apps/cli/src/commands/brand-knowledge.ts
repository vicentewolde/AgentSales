import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type AcceptProposalBody,
  acceptProposalResponseSchema,
  type BrandKnowledgeBody,
  type BrandKnowledgeResponse,
  brandKnowledgeBodySchema,
  brandKnowledgeResponseSchema,
  discardProposalResponseSchema,
  type KnowledgeProposalJson,
  knowledgeProposalsResponseSchema,
  knowledgeRunDetailResponseSchema,
  knowledgeRunResponseSchema,
  knowledgeUpdateResponseSchema,
  knowledgeUpdatesResponseSchema,
} from "@agentsales/api/contracts";
import { BRAND_KNOWLEDGE_LIMITS } from "@agentsales/core";
import type { Command } from "commander";
import { type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { CliError, guarded, type Io } from "../output.js";
import { brandOf } from "./brand.js";
import { type WaitDeps, waitForRun } from "./wait-run.js";

// F9.7 B1 y B2 (ADR-0043): `agentsales brand knowledge|update|propose|proposals`, el conocimiento
// de la marca. Los ejemplos son guía de forma; las novedades, fuente de hechos (D1). Lo que propone
// la IA desde un texto no entra sin que el operador lo acepte (D2).

export type KnowledgeDeps = Io & { client: ApiClient; cwd: string };

/** Un archivo de texto o JSON de `--file`: el tope del texto largo y un poco de holgura. */
const FILE_MAX_BYTES = BRAND_KNOWLEDGE_LIMITS.sourceText * 4 + 4096;

async function readTextFile(cwd: string, file: string): Promise<string> {
  const path = resolve(cwd, file);
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch {
    throw new CliError("FILE_NOT_FOUND", `No se pudo leer ${file}`);
  }
  if (raw.byteLength > FILE_MAX_BYTES) {
    throw new CliError("FILE_TOO_LARGE", `${file} es demasiado grande`);
  }
  return raw.toString("utf8");
}

function printKnowledge(
  deps: Io,
  brandName: string,
  knowledge: BrandKnowledgeResponse["knowledge"],
): void {
  const c = deps.colors;
  deps.print(c.bold(`Conocimiento de ${brandName}`));
  deps.print(`Qué queremos transmitir: ${knowledge.stance ?? c.dim("sin definir")}`);
  deps.print(`Tono y forma de contar: ${knowledge.tone ?? c.dim("sin definir")}`);
  deps.print(`Ejemplos que me gustan (${knowledge.examples.length}; guía de forma, no de hechos):`);
  knowledge.examples.forEach((example, index) => {
    const star = example.favorite ? "★ " : "";
    const preview = example.text.replace(/\s+/gu, " ").slice(0, 100);
    deps.print(`  ${index + 1}. ${star}${preview}${example.text.length > 100 ? "…" : ""}`);
    if (example.note !== null) deps.print(c.dim(`     por qué: ${example.note}`));
  });
  deps.print(
    `Novedades (${knowledge.updates.length}; la IA ve ${knowledge.updatesForAi}, las de 90 días):`,
  );
  if (knowledge.updates.length === 0) deps.print(c.dim("  (ninguna)"));
  for (const update of knowledge.updates) {
    deps.print(`  · ${update.date} · ${update.project}: ${update.text} ${c.dim(update.id)}`);
  }
}

async function fetchKnowledge(client: ApiClient, brokerId: string) {
  return (
    await unwrap(
      client.brokers[":id"].knowledge.$get({ param: { id: brokerId } }),
      brandKnowledgeResponseSchema,
    )
  ).knowledge;
}

export type KnowledgeShowOptions = { broker?: string; json?: boolean };

/** `agentsales brand knowledge show [--broker] [--json]`. */
export function runKnowledgeShow(deps: KnowledgeDeps, options: KnowledgeShowOptions = {}) {
  return guarded(deps, async () => {
    const broker = await brandOf(deps.client, options.broker);
    const knowledge = await fetchKnowledge(deps.client, broker.id);
    if (options.json) {
      const body: BrandKnowledgeBody = {
        stance: knowledge.stance,
        tone: knowledge.tone,
        examples: knowledge.examples.map(({ text, note, favorite }) => ({ text, note, favorite })),
      };
      deps.print(JSON.stringify(body, null, 2));
      return 0;
    }
    printKnowledge(deps, broker.brandName, knowledge);
    return 0;
  });
}

export type KnowledgeEditOptions = {
  broker?: string;
  stance?: string;
  tone?: string;
  file?: string;
};

/**
 * `agentsales brand knowledge edit [--stance] [--tone] [--file conocimiento.json]`: lee el vigente,
 * le aplica el archivo (`stance`, `tone`, `examples`, el de `knowledge show --json`) y las opciones,
 * y guarda. Un texto vacío lo borra.
 */
export function runKnowledgeEdit(deps: KnowledgeDeps, options: KnowledgeEditOptions) {
  return guarded(deps, async () => {
    if (options.stance === undefined && options.tone === undefined && options.file === undefined) {
      throw new CliError(
        "NOTHING_TO_CHANGE",
        "No hay nada que cambiar",
        "Usa --stance, --tone o --file <conocimiento.json> (el de brand knowledge show --json)",
      );
    }
    let file: Partial<BrandKnowledgeBody> = {};
    if (options.file !== undefined) {
      let json: unknown;
      try {
        json = JSON.parse(await readTextFile(deps.cwd, options.file));
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw new CliError("FILE_INVALID", `${options.file} no es un JSON válido`);
      }
      const parsed = brandKnowledgeBodySchema.partial().safeParse(json);
      if (!parsed.success) {
        throw new CliError(
          "FILE_INVALID",
          `${options.file} no tiene la forma del conocimiento (stance, tone y examples)`,
          "Parte de agentsales brand knowledge show --json",
        );
      }
      file = parsed.data;
    }
    const broker = await brandOf(deps.client, options.broker);
    const current = await fetchKnowledge(deps.client, broker.id);
    const blankToNull = (text: string) => (text.trim() === "" ? null : text);
    const next: BrandKnowledgeBody = {
      stance: current.stance,
      tone: current.tone,
      examples: current.examples.map(({ text, note, favorite }) => ({ text, note, favorite })),
      ...file,
    };
    if (options.stance !== undefined) next.stance = blankToNull(options.stance);
    if (options.tone !== undefined) next.tone = blankToNull(options.tone);
    const { knowledge } = await unwrap(
      deps.client.brokers[":id"].knowledge.$put({ param: { id: broker.id }, json: next }),
      brandKnowledgeResponseSchema,
    );
    deps.print(`${deps.colors.green("✓")} Conocimiento guardado`);
    printKnowledge(deps, broker.brandName, knowledge);
    return 0;
  });
}

export type UpdateAddOptions = { broker?: string; project: string; date?: string; text: string };

/** La fecha de hoy en Chile (`AAAA-MM-DD`). */
const todayInChile = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date());

/** `agentsales brand update add --project <p> [--date AAAA-MM-DD] --text <t>`. */
export function runUpdateAdd(deps: KnowledgeDeps, options: UpdateAddOptions) {
  return guarded(deps, async () => {
    const broker = await brandOf(deps.client, options.broker);
    const { update } = await unwrap(
      deps.client.brokers[":id"].knowledge.updates.$post({
        param: { id: broker.id },
        json: {
          project: options.project,
          date: options.date ?? todayInChile(),
          text: options.text,
        },
      }),
      knowledgeUpdateResponseSchema,
    );
    deps.print(
      `${deps.colors.green("✓")} Novedad guardada (${update.date} · ${update.project}): la IA la puede afirmar`,
    );
    deps.print(deps.colors.dim(update.id));
    return 0;
  });
}

export type UpdateListOptions = { broker?: string; archived?: boolean; json?: boolean };

/** `agentsales brand update list [--archived] [--json]`. */
export function runUpdateList(deps: KnowledgeDeps, options: UpdateListOptions = {}) {
  return guarded(deps, async () => {
    const broker = await brandOf(deps.client, options.broker);
    const { updates } = await unwrap(
      deps.client.brokers[":id"].knowledge.updates.$get({
        param: { id: broker.id },
        query: options.archived ? { archived: "true" } : {},
      }),
      knowledgeUpdatesResponseSchema,
    );
    if (options.json) {
      deps.print(JSON.stringify(updates, null, 2));
      return 0;
    }
    if (updates.length === 0) deps.print(deps.colors.dim("Sin novedades"));
    for (const update of updates) {
      const archived = update.archivedAt === null ? "" : deps.colors.dim(" (archivada)");
      deps.print(`${update.date} · ${update.project}: ${update.text}${archived}`);
      deps.print(deps.colors.dim(`  ${update.id}`));
    }
    return 0;
  });
}

/** `agentsales brand update archive <id>`: deja de ser fuente de hechos. */
export function runUpdateArchive(deps: KnowledgeDeps, id: string, options: { broker?: string }) {
  return guarded(deps, async () => {
    const broker = await brandOf(deps.client, options.broker);
    await unwrap(
      deps.client.brokers[":id"].knowledge.updates[":updateId"].$delete({
        param: { id: broker.id, updateId: id },
      }),
      knowledgeUpdateResponseSchema,
    );
    deps.print(`${deps.colors.green("✓")} Novedad archivada: la IA ya no la usa`);
    return 0;
  });
}

function printProposals(deps: Io, proposals: readonly KnowledgeProposalJson[]): void {
  const c = deps.colors;
  if (proposals.length === 0) {
    deps.print(c.dim("No hay propuestas pendientes"));
    return;
  }
  for (const proposal of proposals) {
    const head =
      proposal.kind === "update"
        ? `Novedad · ${proposal.date ?? "sin fecha"} · ${proposal.project ?? ""}`
        : "Hecho";
    deps.print(`${c.bold(head)}: ${proposal.text}`);
    deps.print(c.dim(`  ${proposal.id}`));
  }
  deps.print(
    c.dim(
      "Acepta con agentsales brand proposals accept <id> (con --text, --project o --date para editar) o descarta con … discard <id>",
    ),
  );
}

export type ProposeOptions = { broker?: string; file?: string; wait?: boolean };

/**
 * `agentsales brand propose --file <texto> [--no-wait]` (o el texto por la entrada estándar): la IA
 * lee el texto y propone novedades y hechos; nada entra sin que lo aceptes. Gasta IA de la marca.
 */
export function runPropose(
  deps: KnowledgeDeps & WaitDeps & { stdinIsTty: () => boolean; readStdin: () => Promise<string> },
  options: ProposeOptions,
) {
  return guarded(deps, async () => {
    let text: string;
    if (options.file !== undefined) text = await readTextFile(deps.cwd, options.file);
    else if (!deps.stdinIsTty()) text = await deps.readStdin();
    else {
      throw new CliError(
        "TEXT_REQUIRED",
        "Falta el texto",
        "Usa --file <notas.txt> o pásalo por la entrada estándar (pbpaste | agentsales brand propose)",
      );
    }
    const broker = await brandOf(deps.client, options.broker);
    const { run } = await unwrap(
      deps.client.brokers[":id"].knowledge.proposals.$post({
        param: { id: broker.id },
        json: { text },
      }),
      knowledgeRunResponseSchema,
    );
    const later = `agentsales brand proposals --broker ${broker.slug}`;
    if (options.wait === false) {
      deps.print(`Leyendo el texto (${run.id}): revisa las propuestas con ${later}`);
      return 0;
    }
    const fetchDetail = async () =>
      unwrap(
        deps.client.brokers[":id"].knowledge.runs[":runId"].$get({
          param: { id: broker.id, runId: run.id },
        }),
        knowledgeRunDetailResponseSchema,
      );
    const done = await waitForRun(deps, {
      run,
      fetch: async () => (await fetchDetail()).run,
      isTerminal: (current) => current.status === "succeeded" || current.status === "failed",
      progress: (current) => (current.status === "queued" ? "en cola" : "leyendo el texto"),
      laterCommand: later,
      noun: "la lectura",
    });
    if (done === null) return 0;
    if (done.status === "failed") {
      throw new CliError(
        done.error?.code ?? "KNOWLEDGE_RUN_FAILED",
        done.error?.message ?? "La lectura falló",
      );
    }
    const detail = await fetchDetail();
    for (const warning of detail.run.warnings) deps.print(deps.colors.yellow(`Aviso: ${warning}`));
    printProposals(
      deps,
      detail.proposals.filter((proposal) => proposal.status === "pending"),
    );
    return 0;
  });
}

/** `agentsales brand proposals [--json]`: lo que espera tu decisión. */
export function runProposalsList(
  deps: KnowledgeDeps,
  options: { broker?: string; json?: boolean } = {},
) {
  return guarded(deps, async () => {
    const broker = await brandOf(deps.client, options.broker);
    const view = await unwrap(
      deps.client.brokers[":id"].knowledge.proposals.$get({ param: { id: broker.id } }),
      knowledgeProposalsResponseSchema,
    );
    if (options.json) deps.print(JSON.stringify(view, null, 2));
    else printProposals(deps, view.pending);
    return 0;
  });
}

export type ProposalAcceptOptions = {
  broker?: string;
  text?: string;
  project?: string;
  date?: string;
  as?: string;
};

/** `agentsales brand proposals accept <id> [--text] [--project] [--date] [--as update|fact]`. */
export function runProposalAccept(deps: KnowledgeDeps, id: string, options: ProposalAcceptOptions) {
  return guarded(deps, async () => {
    if (options.as !== undefined && options.as !== "update" && options.as !== "fact") {
      throw new CliError("OPTION_INVALID", "--as es update (novedad) o fact (hecho)");
    }
    const broker = await brandOf(deps.client, options.broker);
    const json: AcceptProposalBody = {
      ...(options.as === undefined ? {} : { kind: options.as }),
      ...(options.text === undefined ? {} : { text: options.text }),
      ...(options.project === undefined ? {} : { project: options.project }),
      ...(options.date === undefined ? {} : { date: options.date }),
    };
    const result = await unwrap(
      deps.client.brokers[":id"].knowledge.proposals[":proposalId"].accept.$post({
        param: { id: broker.id, proposalId: id },
        json,
      }),
      acceptProposalResponseSchema,
    );
    deps.print(
      result.kind === "update"
        ? `${deps.colors.green("✓")} Novedad agregada (${result.update.date} · ${result.update.project})`
        : `${deps.colors.green("✓")} Hecho agregado al perfil (${result.facts.length} hechos)`,
    );
    return 0;
  });
}

/** `agentsales brand proposals discard <id>`. */
export function runProposalDiscard(deps: KnowledgeDeps, id: string, options: { broker?: string }) {
  return guarded(deps, async () => {
    const broker = await brandOf(deps.client, options.broker);
    await unwrap(
      deps.client.brokers[":id"].knowledge.proposals[":proposalId"].discard.$post({
        param: { id: broker.id, proposalId: id },
      }),
      discardProposalResponseSchema,
    );
    deps.print(`${deps.colors.green("✓")} Propuesta descartada`);
    return 0;
  });
}

const BROKER_OPTION = ["--broker <slug>", "la marca (si tienes más de una)"] as const;

/** Registra `brand knowledge`, `brand update`, `brand propose` y `brand proposals`. */
export function registerKnowledge(brand: Command, ctx: CliContext): void {
  const deps = (): KnowledgeDeps => ({ ...ctx, client: ctx.api() });
  const knowledge = brand
    .command("knowledge")
    .description("El conocimiento de la marca: qué transmite, su tono y ejemplos (guía de forma)");
  knowledge
    .command("show")
    .description("Muestra la postura, el tono, los ejemplos y las novedades")
    .option(...BROKER_OPTION)
    .option("--json", "postura, tono y ejemplos, para editarlos y cargarlos con --file")
    .action((options: KnowledgeShowOptions) => exitWith(() => runKnowledgeShow(deps(), options)));
  knowledge
    .command("edit")
    .description("Cambia la postura, el tono o los ejemplos; lo demás queda como estaba")
    .option(...BROKER_OPTION)
    .option("--stance <texto>", "qué queremos transmitir (hasta 2.000; vacío lo borra)")
    .option("--tone <texto>", "tono y forma de contar (hasta 2.000; vacío lo borra)")
    .option("--file <conocimiento.json>", "stance, tone y examples (el de knowledge show --json)")
    .action((options: KnowledgeEditOptions) => exitWith(() => runKnowledgeEdit(deps(), options)));

  const update = brand
    .command("update")
    .description("Las novedades de los proyectos: la IA las puede afirmar (fuente de hechos)");
  update
    .command("add")
    .description("Agrega una novedad")
    .option(...BROKER_OPTION)
    .requiredOption("--project <nombre>", "el proyecto (ej. «AgentPey en Stellar»)")
    .option("--date <AAAA-MM-DD>", "la fecha de la novedad (por defecto hoy, en Chile)")
    .requiredOption("--text <texto>", "la novedad, hasta 1.000 caracteres")
    .action((options: UpdateAddOptions) => exitWith(() => runUpdateAdd(deps(), options)));
  update
    .command("list")
    .description("Lista las novedades activas (con --archived, también las archivadas)")
    .option(...BROKER_OPTION)
    .option("--archived", "incluye las archivadas")
    .option("--json", "salida en JSON")
    .action((options: UpdateListOptions) => exitWith(() => runUpdateList(deps(), options)));
  update
    .command("archive <id>")
    .description("Archiva una novedad: deja de ser fuente de hechos")
    .option(...BROKER_OPTION)
    .action((id: string, options: { broker?: string }) =>
      exitWith(() => runUpdateArchive(deps(), id, options)),
    );

  brand
    .command("propose")
    .description(
      "La IA lee un texto largo (notas, informe, README) y propone novedades y hechos; tú decides (gasta IA)",
    )
    .option(...BROKER_OPTION)
    .option("--file <texto.txt>", "el texto (o por la entrada estándar)")
    .option("--no-wait", "pide la lectura y sale sin esperar")
    .action((options: ProposeOptions) =>
      exitWith(() =>
        runPropose(
          {
            ...deps(),
            stdinIsTty: ctx.stdinIsTty,
            readStdin: ctx.readStdin,
            sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
            now: () => performance.now(),
          },
          options,
        ),
      ),
    );

  const proposals = brand
    .command("proposals")
    .description("Las propuestas de la IA que esperan tu decisión")
    .option(...BROKER_OPTION)
    .option("--json", "salida en JSON")
    .action((options: { broker?: string; json?: boolean }) =>
      exitWith(() => runProposalsList(deps(), options)),
    );
  proposals
    .command("accept <id>")
    .description("Acepta una propuesta (con --text, --project o --date la editas antes)")
    .option(...BROKER_OPTION)
    .option("--text <texto>", "el texto como quieres que quede")
    .option("--project <nombre>", "el proyecto de una novedad")
    .option("--date <AAAA-MM-DD>", "la fecha de una novedad")
    .option("--as <update|fact>", "aceptarla como novedad (update) o como hecho (fact)")
    .action((id: string, _options: ProposalAcceptOptions, command: Command) =>
      exitWith(() =>
        runProposalAccept(deps(), id, command.optsWithGlobals() as ProposalAcceptOptions),
      ),
    );
  proposals
    .command("discard <id>")
    .description("Descarta una propuesta")
    .option(...BROKER_OPTION)
    .action((id: string, _options: { broker?: string }, command: Command) =>
      exitWith(() =>
        runProposalDiscard(deps(), id, command.optsWithGlobals() as { broker?: string }),
      ),
    );
}
