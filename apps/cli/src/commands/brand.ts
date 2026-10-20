import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type EditorialProfileBody,
  type EditorialProfileJson,
  editorialProfileBodySchema,
  editorialProfileResponseSchema,
} from "@agentsales/api/contracts";
import {
  BROKER_KIND_TEXT,
  type Broker,
  DEFAULT_LANGUAGE_GAP_HOURS,
  EDITORIAL_WEEKDAY_TEXT,
  EDITORIAL_WEEKDAYS,
  type EditorialWeekday,
  isPostPlatform,
  LANGUAGE_TEXT,
  PLATFORM_SHORT_NAMES,
  PLATFORM_TEXT,
  POST_PLATFORMS,
  type PostPlatform,
} from "@agentsales/core";
import type { Command } from "commander";
import { type ApiClient, unwrap } from "../api-client.js";
import { type CliContext, exitWith } from "../context.js";
import { CliError, guarded, type Io } from "../output.js";
import { brokerSlugOf, fetchBrokers } from "./shared.js";

// F9-T09 (spec F9 §4.3 y §4.10): `agentsales brand show|edit`, el perfil editorial de una marca
// (o de un corredor): idiomas, público, líneas de contenido, hechos que la IA puede afirmar, cosas
// que evitar, cadencia por red y hashtags.

export type BrandDeps = Io & { client: ApiClient; cwd: string };

/** El tope del archivo de `--file`: un perfil lleno pesa unos pocos KB. */
const PROFILE_FILE_MAX_BYTES = 256 * 1024;

/**
 * La marca del comando: la de `--broker`, o la única que ve el usuario (el corredor, la suya).
 * El administrador con varias tiene que decir cuál.
 */
async function brandOf(client: ApiClient, option: string | undefined): Promise<Broker> {
  const brokers = [...(await fetchBrokers(client)).values()];
  if (option !== undefined) {
    const slug = brokerSlugOf(option);
    const broker = brokers.find((candidate) => candidate.slug === slug);
    if (broker === undefined) {
      throw new CliError(
        "BROKER_NOT_FOUND",
        `No existe la marca o el corredor ${slug}`,
        "Revisa el slug: agentsales brokers show <slug>",
      );
    }
    return broker;
  }
  const [only, ...others] = brokers;
  if (only === undefined) throw new CliError("BROKER_NOT_FOUND", "No hay marcas ni corredores");
  if (others.length > 0) {
    const brands = brokers.filter((broker) => broker.kind === "brand").map((b) => b.slug);
    throw new CliError(
      "BROKER_REQUIRED",
      "Indica de qué marca con --broker <slug>",
      brands.length > 0 ? `Tus marcas: ${brands.join(", ")}` : undefined,
    );
  }
  return only;
}

/** Solo los campos del perfil (lo que `--file` carga de vuelta). */
function profileData(profile: EditorialProfileJson): EditorialProfileBody {
  return {
    languages: profile.languages,
    audience: profile.audience,
    pillars: profile.pillars,
    facts: profile.facts,
    avoid: profile.avoid,
    cadence: profile.cadence,
    defaultHashtags: profile.defaultHashtags,
  };
}

/** El perfil legible: lo que la IA recibe de la marca. */
function printProfile(deps: Io, broker: Broker, profile: EditorialProfileJson): void {
  const c = deps.colors;
  const kind = broker.kind === "brand" ? ` · ${BROKER_KIND_TEXT.brand}` : "";
  deps.print(`${c.bold(`Perfil editorial de ${broker.brandName}`)} (${broker.slug})${kind}`);
  if (profile.updatedAt === null) {
    deps.print(
      c.yellow(
        `Todavía no tiene perfil: llénalo con agentsales brand edit --broker ${broker.slug} (o --file <perfil.json>)`,
      ),
    );
  }
  const [main, ...others] = profile.languages;
  deps.print(
    `Idiomas: ${main === undefined ? "—" : `${LANGUAGE_TEXT[main]} (principal)`}${others.map((lang) => `, ${LANGUAGE_TEXT[lang]}`).join("")}`,
  );
  deps.print(`Público: ${profile.audience ?? c.dim("sin definir")}`);
  deps.print("Líneas de contenido:");
  if (profile.pillars.length === 0) deps.print(c.dim("  (ninguna)"));
  for (const pillar of profile.pillars) {
    deps.print(
      `  · ${pillar.name} [${pillar.key}] · peso ${pillar.weight}${pillar.description === "" ? "" : `: ${pillar.description}`}`,
    );
  }
  deps.print(`Hechos que la IA puede afirmar (${profile.facts.length}):`);
  if (profile.facts.length === 0) {
    deps.print(c.dim("  (ninguno: la IA no afirmará cifras, clientes ni resultados)"));
  }
  profile.facts.forEach((fact, index) => {
    deps.print(`  ${index + 1}. ${fact}`);
  });
  deps.print("Cosas que evitar:");
  if (profile.avoid.length === 0) deps.print(c.dim("  (ninguna)"));
  for (const item of profile.avoid) deps.print(`  · ${item}`);
  deps.print("Cadencia (hora de Chile):");
  const networks = POST_PLATFORMS.filter((platform) => profile.cadence[platform] !== undefined);
  if (networks.length === 0) deps.print(c.dim("  (sin cadencia)"));
  for (const platform of networks) {
    const entry = profile.cadence[platform];
    if (entry === undefined) continue;
    const parts = [
      `${entry.postsPerWeek} por semana`,
      entry.days.length === 0
        ? "cualquier día"
        : entry.days.map((day) => EDITORIAL_WEEKDAY_TEXT[day]).join(", "),
      entry.hours.length === 0 ? "cualquier hora" : entry.hours.join(", "),
      ...(profile.languages.length > 1 ? [`${entry.languageGapHours} h entre idiomas`] : []),
    ];
    deps.print(`  · ${PLATFORM_TEXT[platform]}: ${parts.join(" · ")}`);
  }
  deps.print(
    `Hashtags: ${profile.defaultHashtags.length === 0 ? c.dim("(ninguno)") : profile.defaultHashtags.join(" ")}`,
  );
}

export type BrandShowOptions = { broker?: string; json?: boolean };

/**
 * `agentsales brand show [--broker <slug>] [--json]`: el perfil legible; con `--json`, solo los
 * campos, listo para editarlo y cargarlo con `brand edit --file`.
 */
export function runBrandShow(deps: BrandDeps, options: BrandShowOptions = {}) {
  return guarded(deps, async () => {
    const broker = await brandOf(deps.client, options.broker);
    const { profile } = await unwrap(
      deps.client.brokers[":id"]["editorial-profile"].$get({ param: { id: broker.id } }),
      editorialProfileResponseSchema,
    );
    if (options.json) deps.print(JSON.stringify(profileData(profile), null, 2));
    else printProfile(deps, broker, profile);
    return 0;
  });
}

/** Las opciones de `brand edit`: cada una reemplaza su campo; `--add-*` suman a la lista. */
export type BrandEditOptions = {
  broker?: string;
  file?: string;
  languages?: string;
  audience?: string;
  fact?: string[];
  addFact?: string[];
  avoid?: string[];
  addAvoid?: string[];
  pillar?: string[];
  cadence?: string[];
  removeCadence?: string[];
  hashtags?: string;
};

/** `lun`, `mié`, `miercoles`, `wed`… → el día de la cadencia. */
const DAY_ALIASES: Readonly<Record<string, EditorialWeekday>> = {
  lun: "mon",
  mar: "tue",
  mie: "wed",
  jue: "thu",
  vie: "fri",
  sab: "sat",
  dom: "sun",
  ...Object.fromEntries(EDITORIAL_WEEKDAYS.map((day) => [day, day])),
};

function dayOf(text: string, option: string): EditorialWeekday {
  const key = text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase()
    .slice(0, 3);
  const day = DAY_ALIASES[key];
  if (day === undefined) {
    throw new CliError(
      "CADENCE_INVALID",
      `--cadence "${option}": «${text}» no es un día`,
      "Usa lun, mar, mie, jue, vie, sab o dom, separados por comas",
    );
  }
  return day;
}

/** La red de `--cadence` o `--remove-cadence`: un nombre corto que publique posts. */
function networkOf(text: string, option: string): PostPlatform {
  const platform =
    PLATFORM_SHORT_NAMES[text.trim().toLowerCase() as keyof typeof PLATFORM_SHORT_NAMES];
  if (platform === undefined || !isPostPlatform(platform)) {
    throw new CliError(
      "CADENCE_INVALID",
      `${option}: «${text}» no es una red de posts`,
      `Usa ${POST_PLATFORMS.join(", ")}`,
    );
  }
  return platform;
}

const CADENCE_EXAMPLE = 'Por ejemplo: --cadence "instagram/3/lun,mie,vie/10:00,19:00/6"';

/**
 * `--cadence "<red>/<posts por semana>[/<días>[/<horas>[/<horas entre idiomas>]]]"`: la cadencia
 * de esa red (reemplaza la que tenía). Las horas son de Chile; las valida la API.
 */
function cadenceOf(option: string): [PostPlatform, EditorialProfileBody["cadence"][string]] {
  const [network = "", perWeek = "", days = "", hours = "", gap = "", ...rest] = option.split("/");
  const posts = Number(perWeek.trim());
  if (rest.length > 0 || perWeek.trim() === "" || !Number.isInteger(posts)) {
    throw new CliError(
      "CADENCE_INVALID",
      `--cadence "${option}": usa <red>/<posts por semana>/<días>/<horas>/<horas entre idiomas>`,
      CADENCE_EXAMPLE,
    );
  }
  const list = (text: string) =>
    text
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  const gapHours = gap.trim() === "" ? DEFAULT_LANGUAGE_GAP_HOURS : Number(gap.trim());
  if (!Number.isInteger(gapHours)) {
    throw new CliError(
      "CADENCE_INVALID",
      `--cadence "${option}": las horas entre idiomas son un número entero`,
      CADENCE_EXAMPLE,
    );
  }
  return [
    networkOf(network, `--cadence "${option}"`),
    {
      postsPerWeek: posts,
      days: list(days).map((day) => dayOf(day, option)),
      hours: list(hours),
      languageGapHours: gapHours,
    },
  ];
}

/** `--pillar "<clave>|<nombre>|<peso>|<descripción>"` (el peso, 1 si falta). */
function pillarOf(option: string): EditorialProfileBody["pillars"][number] {
  const [key = "", name = "", weight = "", ...description] = option.split("|");
  const value = weight.trim() === "" ? 1 : Number(weight.trim());
  if (key.trim() === "" || name.trim() === "" || !Number.isFinite(value)) {
    throw new CliError(
      "PILLAR_INVALID",
      `--pillar "${option}": usa <clave>|<nombre>|<peso>|<descripción>`,
      'Por ejemplo: --pillar "producto|Producto|2|Lo que hace AgentSales"',
    );
  }
  return {
    key: key.trim(),
    name: name.trim(),
    weight: value,
    description: description.join("|").trim(),
  };
}

/** El JSON de `--file`: los campos del perfil que trae (los que faltan quedan como estaban). */
async function profileFile(cwd: string, file: string): Promise<Partial<EditorialProfileBody>> {
  const path = resolve(cwd, file);
  let text: string;
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength > PROFILE_FILE_MAX_BYTES) {
      throw new CliError("FILE_TOO_LARGE", `${file} pasa de 256 KB: no parece un perfil editorial`);
    }
    text = bytes.toString("utf8");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "FILE_NOT_READABLE",
      `No se pudo leer ${file}`,
      "Revisa la ruta del archivo",
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CliError(
      "FILE_INVALID",
      `${file} no es un JSON válido`,
      "Parte de agentsales brand show --json > perfil.json, edítalo y cárgalo de nuevo",
    );
  }
  const parsed = editorialProfileBodySchema.partial().safeParse(json);
  if (!parsed.success) {
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(raíz)")),
    ];
    throw new CliError(
      "FILE_INVALID",
      `${file} no tiene la forma de un perfil editorial: revisa ${fields.join(", ")}`,
      "Los campos son languages, audience, pillars, facts, avoid, cadence y defaultHashtags (agentsales brand show --json muestra un ejemplo)",
    );
  }
  return parsed.data;
}

/** `agentsales brand edit` sin nada que cambiar. */
function hasChanges(options: BrandEditOptions): boolean {
  const { broker: _broker, ...rest } = options;
  return Object.values(rest).some((value) => value !== undefined);
}

/**
 * `agentsales brand edit [--broker <slug>] [--file <perfil.json>] [opciones]`: lee el perfil
 * vigente, le aplica el archivo y después las opciones, y guarda el perfil completo. La API lo
 * valida y dice qué corregir (`EDITORIAL_PROFILE_INVALID`). Un texto vacío (`--audience ""`) lo borra.
 */
export function runBrandEdit(deps: BrandDeps, options: BrandEditOptions) {
  return guarded(deps, async () => {
    if (!hasChanges(options)) {
      throw new CliError(
        "NOTHING_TO_CHANGE",
        "No hay nada que cambiar: indica qué editar",
        "Usa --file <perfil.json> o las opciones de cada campo (agentsales brand edit --help)",
      );
    }
    // Todo lo que se puede revisar antes de llamar a la API.
    const file = options.file === undefined ? {} : await profileFile(deps.cwd, options.file);
    const pillars = options.pillar?.map(pillarOf);
    const cadence = options.cadence?.map(cadenceOf);
    const removed = options.removeCadence?.map((network) => networkOf(network, "--remove-cadence"));

    const broker = await brandOf(deps.client, options.broker);
    const { profile: current } = await unwrap(
      deps.client.brokers[":id"]["editorial-profile"].$get({ param: { id: broker.id } }),
      editorialProfileResponseSchema,
    );
    const next: EditorialProfileBody = { ...profileData(current), ...file };
    if (options.languages !== undefined) {
      next.languages = options.languages.split(/[\s,]+/).filter(Boolean);
    }
    if (options.audience !== undefined) {
      next.audience = options.audience.trim() === "" ? null : options.audience;
    }
    if (pillars !== undefined) next.pillars = pillars;
    if (options.fact !== undefined) next.facts = options.fact;
    if (options.addFact !== undefined) next.facts = [...next.facts, ...options.addFact];
    if (options.avoid !== undefined) next.avoid = options.avoid;
    if (options.addAvoid !== undefined) next.avoid = [...next.avoid, ...options.addAvoid];
    if (cadence !== undefined || removed !== undefined) {
      const entries = { ...next.cadence };
      for (const [network, entry] of cadence ?? []) entries[network] = entry;
      for (const network of removed ?? []) delete entries[network];
      next.cadence = entries;
    }
    if (options.hashtags !== undefined) {
      next.defaultHashtags = options.hashtags.split(/[\s,]+/).filter(Boolean);
    }
    const { profile } = await unwrap(
      deps.client.brokers[":id"]["editorial-profile"].$put({
        param: { id: broker.id },
        json: next,
      }),
      editorialProfileResponseSchema,
    );
    deps.print(`${deps.colors.green("✓")} Perfil editorial guardado`);
    printProfile(deps, broker, profile);
    return 0;
  });
}

/** Junta las veces que se repite una opción (`--fact a --fact b`). */
const collect = (value: string, previous: string[] = []) => [...previous, value];

export function register(program: Command, ctx: CliContext): void {
  const deps = (): BrandDeps => ({ ...ctx, client: ctx.api() });
  const brand = program
    .command("brand")
    .description("El perfil editorial de una marca: lo que la IA sabe y cómo publica");
  brand
    .command("show")
    .description("Muestra el perfil editorial")
    .option("--broker <slug>", "la marca (si tienes más de una)")
    .option("--json", "solo los campos, para editarlos y cargarlos con brand edit --file")
    .action((options: BrandShowOptions) => exitWith(() => runBrandShow(deps(), options)));
  brand
    .command("edit")
    .description(
      "Edita el perfil editorial: cada opción reemplaza su campo; lo demás queda como estaba",
    )
    .option("--broker <slug>", "la marca (si tienes más de una)")
    .option("--file <perfil.json>", "carga los campos de un JSON (el de brand show --json)")
    .option("--languages <es,en>", "idiomas, el primero es el principal (es, en o es,en)")
    .option("--audience <texto>", "a quién le habla, en una o dos frases (vacío lo borra)")
    .option(
      "--pillar <clave|nombre|peso|descripción>",
      "una línea de contenido (repetible; reemplaza las líneas)",
      collect,
    )
    .option(
      "--fact <frase>",
      "un hecho que la IA puede afirmar (repetible; reemplaza la lista)",
      collect,
    )
    .option("--add-fact <frase>", "suma un hecho a la lista (repetible)", collect)
    .option("--avoid <texto>", "algo que no se usa (repetible; reemplaza la lista)", collect)
    .option("--add-avoid <texto>", "suma algo que evitar (repetible)", collect)
    .option(
      "--cadence <red/posts/días/horas/espacio>",
      'la cadencia de una red en hora de Chile, ej. "instagram/3/lun,mie,vie/10:00,19:00/6" (repetible)',
      collect,
    )
    .option("--remove-cadence <red>", "quita la cadencia de una red (repetible)", collect)
    .option("--hashtags <lista>", "hashtags del perfil, separados por espacio (reemplaza la lista)")
    .action((options: BrandEditOptions) => exitWith(() => runBrandEdit(deps(), options)));
}
