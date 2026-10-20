import { access, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  type BrokerDetailResponse,
  brokerDetailResponseSchema,
  brokerResponseSchema,
} from "@agentsales/api/contracts";
import {
  autoPublishAllowed,
  BROKER_KIND_TEXT,
  BROKER_KINDS,
  type Broker,
  type BrokerKind,
  formatUsd,
  MAX_LOGO_BYTES,
  ONBOARDING_OWNER_TEXT,
  ONBOARDING_STEP_TEXT,
  parseUsdAmount,
} from "@agentsales/core";
import type { Command } from "commander";
import { z } from "zod";
import { type ApiClient, createHealthFetcher, unwrap } from "../api-client.js";
import { type CliContext, exitWith, type Terminal } from "../context.js";
import { CliError, guarded, type Io } from "../output.js";
import { brokerSlugOf, fetchBrokers } from "./shared.js";

// F6-T11 (spec F6 §4.10): activar o apagar `auto_publish` de un corredor. F7-T16 (spec F7 §4.10):
// crear y editar corredores, su logo y su planilla.

export type BrokersDeps = Io & Pick<Terminal, "confirm"> & { client: ApiClient };
export type AutoPublishOptions = { yes?: boolean };

/**
 * `agentsales brokers auto-publish <slug> on|off [--yes]`: pregunta siempre (en vivo, en rojo:
 * publicará sin tu revisión); `--yes` no pregunta.
 */
export function runAutoPublish(
  deps: BrokersDeps,
  slugOption: string,
  value: string,
  options: AutoPublishOptions = {},
) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const on = value.trim().toLowerCase();
    if (on !== "on" && on !== "off") {
      throw new CliError("AUTO_PUBLISH_INVALID", `Usa on u off: "${value}"`);
    }
    const slug = brokerSlugOf(slugOption);
    const broker = [...(await fetchBrokers(deps.client)).values()].find((b) => b.slug === slug);
    if (broker === undefined) {
      throw new CliError("BROKER_NOT_FOUND", `No existe el corredor ${slug}`);
    }
    // La regla de core (F9, ADR-0029): la publicación automática es de las propiedades.
    if (on === "on" && !autoPublishAllowed(broker)) {
      throw new CliError(
        "BROKER_IS_BRAND",
        `${slug} es una marca: la publicación automática es de las propiedades y no se activa en una marca`,
      );
    }
    const { publishMode } = await createHealthFetcher(deps.client)();
    if (on === "on" && publishMode === "live") {
      deps.printError(c.bold(c.bgRed(c.white(" La API está EN VIVO: publicará sin tu revisión "))));
    }
    if (!options.yes) {
      const question =
        on === "on"
          ? `¿Activar auto_publish de ${slug}? Al preparar los textos, se aprueban y publican solos (Marketplace queda como recordatorio)`
          : `¿Apagar auto_publish de ${slug}?`;
      if (!(await deps.confirm(question))) {
        deps.printError(c.yellow("No se cambió nada: confirma en la terminal o usa --yes"));
        return 1;
      }
    }
    const { broker: updated } = await unwrap(
      deps.client.brokers[":id"].$patch({
        param: { id: broker.id },
        json: { autoPublish: on === "on" },
      }),
      brokerResponseSchema,
    );
    deps.print(
      `${c.green("✓")} auto_publish de ${updated.slug}: ${updated.autoPublish ? "activado" : "apagado"}`,
    );
    return 0;
  });
}

/** El corredor por su slug (la API usa el id); `BROKER_NOT_FOUND` si no existe o no es suyo. */
async function brokerBySlug(client: ApiClient, slugOption: string): Promise<Broker> {
  const slug = brokerSlugOf(slugOption);
  const broker = [...(await fetchBrokers(client)).values()].find((b) => b.slug === slug);
  if (broker === undefined) throw new CliError("BROKER_NOT_FOUND", `No existe el corredor ${slug}`);
  return broker;
}

/** El corredor y su lista de alta (lo que falta y quién lo hace). */
function printBrokerDetail(deps: Io, { broker, onboarding }: BrokerDetailResponse): void {
  const c = deps.colors;
  deps.print(
    `${c.bold(broker.brandName)} (${broker.slug})${broker.kind === "brand" ? ` · ${BROKER_KIND_TEXT.brand}` : ""}${broker.operatorOwned ? " · propio" : ""}`,
  );
  deps.print(
    c.dim(
      `  Tope de IA: ${broker.llmMonthlyCapUsd === null ? "sin tope" : `${formatUsd(broker.llmMonthlyCapUsd)} al mes`} · publicación automática: ${broker.autoPublish ? "activada" : "apagada"}`,
    ),
  );
  deps.print("Lista de alta:");
  for (const step of onboarding) {
    deps.print(
      step.done
        ? `  ${c.green("✓")} ${ONBOARDING_STEP_TEXT[step.key]}`
        : `  ${c.yellow("·")} ${ONBOARDING_STEP_TEXT[step.key]}${step.pending === null ? "" : `: falta ${step.pending}`}${step.owner === null ? "" : ` (${ONBOARDING_OWNER_TEXT[step.owner]})`}`,
    );
  }
}

/** Las opciones de la marca, comunes a crear y editar. */
export type BrandOptions = {
  name?: string;
  brand?: string;
  color?: string;
  secondaryColor?: string;
  whatsapp?: string;
  email?: string;
  instagram?: string;
  website?: string;
  tone?: string;
  hashtags?: string;
  /** `--own`. */
  own?: boolean;
  /** `--not-own`. */
  notOwn?: boolean;
  /** `--cap <usd>` (texto) o `--no-cap` (false). */
  cap?: string | false;
};

/** Las opciones de la marca como cuerpo de la API (solo las que vinieron). */
function brandBody(options: BrandOptions) {
  // Los dos juntos no se resuelven en silencio.
  if (options.own && options.notOwn) {
    throw new CliError("OPTIONS_CONFLICT", "--own y --not-own no van juntos");
  }
  const own = options.notOwn ? false : options.own;
  let cap: number | null | undefined;
  if (options.cap === false) cap = null;
  else if (options.cap !== undefined) {
    // `--cap ""` no es "tope 0" ni "sin tope": para quitarlo está `--no-cap`. La regla, de core.
    let parsed: number | null = null;
    try {
      parsed = parseUsdAmount(options.cap);
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      throw new CliError("CAP_INVALID", `--cap debe ser un monto en dólares: "${options.cap}"`);
    }
    cap = parsed;
  }
  const optional = <K extends string>(key: K, value: string | undefined) =>
    value === undefined ? {} : ({ [key]: value } as Record<K, string>);
  return {
    ...optional("name", options.name),
    ...optional("brandName", options.brand),
    ...optional("primaryColor", options.color),
    ...optional("secondaryColor", options.secondaryColor),
    ...optional("whatsapp", options.whatsapp),
    ...optional("email", options.email),
    ...optional("instagramHandle", options.instagram),
    ...optional("website", options.website),
    ...optional("tone", options.tone),
    ...(options.hashtags === undefined
      ? {}
      : { fixedHashtags: options.hashtags.split(/[\s,]+/).filter(Boolean) }),
    ...(own === undefined ? {} : { operatorOwned: own }),
    ...(cap === undefined ? {} : { llmMonthlyCapUsd: cap }),
  };
}

export type CreateOptions = BrandOptions & { slug?: string; kind?: string };

/** `--kind broker|brand` (F9): un corredor (por defecto) o una marca que solo publica posts. */
function kindOption(option: string | undefined): BrokerKind | undefined {
  if (option === undefined) return undefined;
  const kind = option.trim().toLowerCase();
  if (!(BROKER_KINDS as readonly string[]).includes(kind)) {
    throw new CliError("KIND_INVALID", `--kind debe ser ${BROKER_KINDS.join(" o ")}: "${option}"`);
  }
  return kind as BrokerKind;
}

/** `agentsales brokers create --slug <slug> --name … --brand … --color … [más]` (administrador). */
export function runBrokerCreate(deps: BrokersDeps, options: CreateOptions) {
  return guarded(deps, async () => {
    if (
      options.slug === undefined ||
      options.name === undefined ||
      options.brand === undefined ||
      options.color === undefined
    ) {
      throw new CliError(
        "BROKER_FIELDS_REQUIRED",
        "Faltan --slug, --name, --brand y --color (#RRGGBB): son obligatorios",
      );
    }
    const kind = kindOption(options.kind);
    const detail = await unwrap(
      deps.client.brokers.$post({
        json: {
          ...brandBody(options),
          ...(kind === undefined ? {} : { kind }),
          slug: options.slug,
          name: options.name,
          brandName: options.brand,
          primaryColor: options.color,
        },
      }),
      brokerDetailResponseSchema,
    );
    deps.print(
      `${deps.colors.green("✓")} ${detail.broker.kind === "brand" ? "Marca creada" : "Corredor creado"}`,
    );
    printBrokerDetail(deps, detail);
    return 0;
  });
}

/**
 * `agentsales brokers edit <slug> [opciones]`: la marca (el corredor, la suya) y, solo el
 * administrador, `--own`/`--not-own` y `--cap`/`--no-cap`. Un texto vacío (`--website ""`) lo borra.
 */
export function runBrokerEdit(deps: BrokersDeps, slugOption: string, options: BrandOptions) {
  return guarded(deps, async () => {
    const body = brandBody(options);
    if (Object.keys(body).length === 0) {
      throw new CliError("NOTHING_TO_CHANGE", "No hay nada que cambiar: indica qué editar");
    }
    const broker = await brokerBySlug(deps.client, slugOption);
    const detail = await unwrap(
      deps.client.brokers[":id"].$patch({ param: { id: broker.id }, json: body }),
      brokerDetailResponseSchema,
    );
    deps.print(`${deps.colors.green("✓")} Corredor actualizado`);
    printBrokerDetail(deps, detail);
    return 0;
  });
}

/** `agentsales brokers show <slug>`: el corredor y su lista de alta. */
export function runBrokerShow(deps: BrokersDeps, slugOption: string) {
  return guarded(deps, async () => {
    const broker = await brokerBySlug(deps.client, slugOption);
    const detail = await unwrap(
      deps.client.brokers[":id"].$get({ param: { id: broker.id } }),
      brokerDetailResponseSchema,
    );
    printBrokerDetail(deps, detail);
    return 0;
  });
}

/** `agentsales brokers logo <slug> <archivo>`: PNG, JPEG o WebP de hasta 5 MB (nunca SVG). */
export function runBrokerLogo(
  deps: BrokersDeps & { cwd: string },
  slugOption: string,
  file: string,
) {
  return guarded(deps, async () => {
    const path = resolve(deps.cwd, file);
    // El tamaño antes de leerlo: un archivo enorme no se carga en memoria (la API acepta 5 MB).
    const size = await stat(path).then(
      (info) => info.size,
      () => null,
    );
    if (size === null) throw new CliError("FILE_NOT_READABLE", `No se pudo leer ${file}`);
    if (size > MAX_LOGO_BYTES) {
      throw new CliError("LOGO_TOO_LARGE", `${file} pasa de 5 MB`, "Usa una versión más liviana");
    }
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = new Uint8Array(await readFile(path));
    } catch {
      throw new CliError("FILE_NOT_READABLE", `No se pudo leer ${file}`);
    }
    const broker = await brokerBySlug(deps.client, slugOption);
    const { broker: updated } = await unwrap(
      deps.client.brokers[":id"].logo.$post({
        param: { id: broker.id },
        form: { logo: new File([bytes], basename(path)) },
      }),
      brokerResponseSchema,
    );
    deps.print(`${deps.colors.green("✓")} Logo de ${updated.slug} guardado`);
    deps.print(
      deps.colors.dim(
        "→ Lo ya preparado no cambia: prepara de nuevo solo las imágenes (agentsales prepare <id> --no-texts)",
      ),
    );
    return 0;
  });
}

export type TemplateOptions = { out?: string; force?: boolean };

/**
 * `agentsales brokers template <slug> [--out <archivo>] [--force]`: baja la planilla del corredor
 * (la plantilla con su hoja Corredor llena). No pisa un archivo que existe sin `--force`.
 */
export function runBrokerTemplate(
  deps: BrokersDeps & { cwd: string },
  slugOption: string,
  options: TemplateOptions = {},
) {
  return guarded(deps, async () => {
    const broker = await brokerBySlug(deps.client, slugOption);
    const path = resolve(deps.cwd, options.out ?? `planilla-${broker.slug}.xlsx`);
    const exists = await access(path).then(
      () => true,
      () => false,
    );
    const fileExists = () =>
      new CliError(
        "FILE_EXISTS",
        `Ya existe ${path}`,
        "Usa --force para reemplazarlo u otro --out",
      );
    if (exists && !options.force) throw fileExists();
    const response = await deps.client.brokers[":id"]["template.xlsx"].$get({
      param: { id: broker.id },
    });
    // Un error llega como JSON: `unwrap` lo traduce (y no hay planilla que guardar).
    if (!response.ok) await unwrap(response, z.never());
    if (!response.ok) throw new CliError("TEMPLATE_FAILED", "No se pudo bajar la planilla");
    const bytes = new Uint8Array(await response.arrayBuffer());
    try {
      // Sin `--force`, `wx` tampoco pisa uno que apareció entre medio.
      await writeFile(path, bytes, options.force ? {} : { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw fileExists();
      throw new CliError(
        "FILE_NOT_WRITABLE",
        `No se pudo guardar ${path}`,
        "Revisa que la carpeta exista y se pueda escribir, o usa otro --out",
      );
    }
    deps.print(`${deps.colors.green("✓")} Planilla de ${broker.slug} guardada en ${path}`);
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  const deps = () => ({ ...ctx, client: ctx.api() });
  const brokers = program.command("brokers").description("Corredores");
  const brandOptions = (command: Command) =>
    command
      .option("--name <nombre>", "nombre de la persona")
      .option("--brand <marca>", "nombre de la marca")
      .option("--color <#RRGGBB>", "color primario")
      .option("--secondary-color <#RRGGBB>", "color secundario (vacío: el primario)")
      .option("--whatsapp <número>", "WhatsApp con código de país")
      .option("--email <correo>", "correo de contacto")
      .option("--instagram <usuario>", "usuario de Instagram")
      .option("--website <sitio>", "sitio web")
      .option("--tone <texto>", "cómo suenan los textos")
      .option("--hashtags <lista>", "hashtags fijos, separados por espacio")
      .option("--own", "corredor propio (solo el administrador)")
      .option("--not-own", "no propio: usa la API de Anthropic (solo el administrador)")
      .option("--cap <usd>", "tope de IA del mes en dólares (solo el administrador)")
      .option("--no-cap", "sin tope de IA (solo el administrador)");
  brandOptions(
    brokers
      .command("create")
      .description("Crea un corredor o una marca (administrador)")
      .option("--slug <slug>", "identificador: minúsculas, números y guiones")
      .option(
        "--kind <broker|brand>",
        "broker (corredor con propiedades, por defecto) o brand (marca que solo publica posts)",
      ),
  ).action((options: CreateOptions) => exitWith(() => runBrokerCreate(deps(), options)));
  brandOptions(
    brokers.command("edit").description("Edita un corredor").argument("<slug>", "corredor"),
  ).action((slug: string, options: BrandOptions) =>
    exitWith(() => runBrokerEdit(deps(), slug, options)),
  );
  brokers
    .command("show")
    .description("El corredor y su lista de alta")
    .argument("<slug>", "corredor")
    .action((slug: string) => exitWith(() => runBrokerShow(deps(), slug)));
  brokers
    .command("logo")
    .description("Sube el logo del corredor (PNG, JPEG o WebP de hasta 5 MB)")
    .argument("<slug>", "corredor")
    .argument("<archivo>", "el logo")
    .action((slug: string, file: string) => exitWith(() => runBrokerLogo(deps(), slug, file)));
  brokers
    .command("template")
    .description("Baja la planilla de Excel del corredor, con su hoja Corredor llena")
    .argument("<slug>", "corredor")
    .option("--out <archivo>", "dónde guardarla (por defecto planilla-<slug>.xlsx)")
    .option("--force", "reemplaza el archivo si existe")
    .action((slug: string, options: TemplateOptions) =>
      exitWith(() => runBrokerTemplate(deps(), slug, options)),
    );
  brokers
    .command("auto-publish")
    .description(
      "Activa (on) o apaga (off) la publicación automática de un corredor: al preparar los textos se aprueba y publica sin tu revisión",
    )
    .argument("<slug>", "corredor")
    .argument("<on|off>", "on u off")
    .option("--yes", "no pide confirmación")
    .action((slug: string, value: string, options: AutoPublishOptions) =>
      exitWith(() => runAutoPublish({ ...ctx, client: ctx.api() }, slug, value, options)),
    );
}
