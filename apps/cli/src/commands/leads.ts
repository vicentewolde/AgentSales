import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type LeadView,
  leadListResponseSchema,
  leadResponseSchema,
  leadWebhookSecretResponseSchema,
} from "@agentsales/api/contracts";
import { LEAD_STATUSES, type LeadStatus } from "@agentsales/core";
import type { Command } from "commander";
import { z } from "zod";
import { type ApiClient, unwrap } from "../api-client.js";
import type { Colors } from "../colors.js";
import { type CliContext, exitWith, type Terminal } from "../context.js";
import { CliError, guarded, type Io, renderTable } from "../output.js";
import { type BrandDeps, brandOf } from "./brand.js";

// F10-T05 (ADR-0033): los leads de un corredor desde la terminal. Tienen datos personales de
// terceros: se muestran solo a quien tiene sesión, `export` los baja a un archivo y `erase` los
// borra (deja la atribución). El secreto del webhook de ManyChat se muestra una sola vez.

export type LeadsDeps = Omit<BrandDeps, "cwd"> & Pick<Terminal, "confirm"> & { cwd: string };
type Quiet = Io & { client: ApiClient };

const STATUS_TEXT: Readonly<Record<LeadStatus, string>> = {
  new: "nuevo",
  contacted: "contactado",
  visit_scheduled: "visita agendada",
  won: "ganado",
  lost: "perdido",
};

const paintStatus = (status: LeadStatus, c: Colors): string => {
  const text = STATUS_TEXT[status];
  if (status === "new") return c.yellow(text);
  if (status === "won") return c.green(text);
  if (status === "lost") return c.dim(text);
  return text;
};

const dayOf = (date: Date): string => date.toISOString().slice(0, 16).replace("T", " ");

function statusOption(text: string): LeadStatus {
  const found = LEAD_STATUSES.find((s) => s === text);
  if (found === undefined) {
    throw new CliError(
      "LEAD_STATUS_INVALID",
      `Estado desconocido: "${text}"`,
      `Los estados: ${LEAD_STATUSES.join(", ")}`,
    );
  }
  return found;
}

function renderLead(lead: LeadView, c: Colors): string[] {
  const lines = [
    `${c.bold(lead.name ?? (lead.erasedAt === null ? "(sin nombre)" : "(borrado)"))}  ${paintStatus(lead.status, c)}`,
    `  id:          ${lead.id}`,
    `  recibido:    ${dayOf(lead.createdAt)} · ${lead.source}`,
    `  teléfono:    ${lead.phone ?? "—"}`,
    `  correo:      ${lead.email ?? "—"}`,
    `  propiedad:   ${lead.listingId ?? "—"}`,
    `  anuncio:     ${lead.adId ?? "—"}${lead.campaign === null ? "" : ` · campaña ${lead.campaign}`}`,
    `  asignado a:  ${lead.assignedTo ?? "—"}`,
    `  consentimiento: ${dayOf(lead.consent.at)}${lead.consent.text === null ? "" : ` · «${lead.consent.text}»`}`,
  ];
  if (lead.erasedAt !== null) {
    lines.push(c.dim(`  Datos personales borrados el ${dayOf(lead.erasedAt)}`));
  }
  return lines;
}

export type LeadsListOptions = {
  broker?: string;
  status?: string;
  listing?: string;
  limit?: string;
  json?: boolean;
};

/** `agentsales leads list [--broker] [--status] [--listing <id>] [--limit N] [--json]`. */
export function runLeadsList(deps: LeadsDeps, options: LeadsListOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const status = options.status === undefined ? undefined : statusOption(options.status);
    const limit = options.limit === undefined ? undefined : Number(options.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) {
      throw new CliError("LEAD_LIMIT_INVALID", "--limit es un número entero de 1 a 500");
    }
    const broker = await brandOf(deps.client, options.broker);
    const { leads } = await unwrap(
      deps.client.brokers[":id"].leads.$get({
        param: { id: broker.id },
        query: {
          ...(status === undefined ? {} : { status }),
          ...(options.listing === undefined ? {} : { listing: options.listing }),
          limit: String(limit ?? 100),
        },
      }),
      leadListResponseSchema,
    );
    if (options.json) {
      deps.print(JSON.stringify(leads, null, 2));
      return 0;
    }
    if (leads.length === 0) {
      deps.print("No hay leads con ese filtro.");
      return 0;
    }
    deps.print(
      renderTable(
        ["Id", "Recibido", "Nombre", "Contacto", "Estado", "Origen"],
        leads.map((lead) => [
          lead.id.slice(0, 8),
          dayOf(lead.createdAt),
          lead.name ?? (lead.erasedAt === null ? "—" : "(borrado)"),
          lead.phone ?? lead.email ?? "—",
          paintStatus(lead.status, c),
          lead.source,
        ]),
        c,
      ),
    );
    deps.print(c.dim("→ agentsales leads show <id> · leads status <id> <estado>"));
    return 0;
  });
}

/** Un lead por su id completo o por el prefijo que muestra la lista (único dentro del corredor). */
async function resolveLeadId(
  deps: Quiet,
  broker: string | undefined,
  idOption: string,
): Promise<string> {
  const id = idOption.trim().toLowerCase();
  if (z.uuid().safeParse(id).success) return id;
  if (!/^[0-9a-f]{4,}$/.test(id)) {
    throw new CliError("LEAD_ID_INVALID", `El id del lead no es válido: "${idOption}"`);
  }
  const owner = await brandOf(deps.client, broker);
  const { leads } = await unwrap(
    deps.client.brokers[":id"].leads.$get({ param: { id: owner.id }, query: { limit: "500" } }),
    leadListResponseSchema,
  );
  const matches = leads.filter((lead) => lead.id.startsWith(id));
  const [only, ...rest] = matches;
  if (only === undefined) {
    throw new CliError("LEAD_NOT_FOUND", `No hay un lead que empiece con ${id}`);
  }
  if (rest.length > 0) {
    throw new CliError("LEAD_ID_AMBIGUOUS", `Más de un lead empieza con ${id}: usa más letras`);
  }
  return only.id;
}

/** `agentsales leads show <id>`. */
export function runLeadsShow(deps: LeadsDeps, id: string, options: { broker?: string } = {}) {
  return guarded(deps, async () => {
    const leadId = await resolveLeadId(deps, options.broker, id);
    const { lead } = await unwrap(
      deps.client.leads[":id"].$get({ param: { id: leadId } }),
      leadResponseSchema,
    );
    for (const line of renderLead(lead, deps.colors)) deps.print(line);
    return 0;
  });
}

/** `agentsales leads status <id> <estado>`. */
export function runLeadsStatus(
  deps: LeadsDeps,
  id: string,
  statusText: string,
  options: { broker?: string } = {},
) {
  return guarded(deps, async () => {
    const status = statusOption(statusText);
    const leadId = await resolveLeadId(deps, options.broker, id);
    const { lead } = await unwrap(
      deps.client.leads[":id"].status.$post({ param: { id: leadId }, json: { status } }),
      leadResponseSchema,
    );
    deps.print(
      `${deps.colors.green("✓")} Lead ${lead.id.slice(0, 8)}: ${STATUS_TEXT[lead.status]}`,
    );
    return 0;
  });
}

/** `agentsales leads assign <id> <usuario|ninguno>`: el id del usuario (agentsales users list). */
export function runLeadsAssign(
  deps: LeadsDeps,
  id: string,
  user: string,
  options: { broker?: string } = {},
) {
  return guarded(deps, async () => {
    const userId = user === "ninguno" ? null : user;
    if (userId !== null && !z.uuid().safeParse(userId).success) {
      throw new CliError(
        "LEAD_ASSIGNEE_INVALID",
        `El usuario es su id (agentsales users list) o "ninguno": "${user}"`,
      );
    }
    const leadId = await resolveLeadId(deps, options.broker, id);
    const { lead } = await unwrap(
      deps.client.leads[":id"].assign.$post({ param: { id: leadId }, json: { userId } }),
      leadResponseSchema,
    );
    deps.print(
      `${deps.colors.green("✓")} Lead ${lead.id.slice(0, 8)}: ${lead.assignedTo === null ? "sin asignar" : `asignado a ${lead.assignedTo}`}`,
    );
    return 0;
  });
}

/** `agentsales leads erase <id> [--yes]`: borra nombre, teléfono y correo; no se deshace. */
export function runLeadsErase(
  deps: LeadsDeps,
  id: string,
  options: { broker?: string; yes?: boolean } = {},
) {
  return guarded(deps, async () => {
    const leadId = await resolveLeadId(deps, options.broker, id);
    if (
      options.yes !== true &&
      !(await deps.confirm(
        `Borrar el nombre, el teléfono y el correo del lead ${leadId.slice(0, 8)}? No se deshace (la atribución queda)`,
      ))
    ) {
      deps.print("No se borró nada.");
      return 1;
    }
    const { lead } = await unwrap(
      deps.client.leads[":id"].erase.$post({ param: { id: leadId } }),
      leadResponseSchema,
    );
    deps.print(
      `${deps.colors.green("✓")} Datos personales del lead ${lead.id.slice(0, 8)} borrados`,
    );
    return 0;
  });
}

export type LeadsExportOptions = { broker?: string; out?: string; force?: boolean };

/** `agentsales leads export [--broker] [--out <archivo>] [--force]`: un CSV con los leads. */
export function runLeadsExport(deps: LeadsDeps, options: LeadsExportOptions = {}) {
  return guarded(deps, async () => {
    const broker = await brandOf(deps.client, options.broker);
    const path = resolve(deps.cwd, options.out ?? `leads-${broker.slug}.csv`);
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
    const response = await deps.client.brokers[":id"]["leads.csv"].$get({
      param: { id: broker.id },
    });
    if (!response.ok) await unwrap(response, z.never());
    if (!response.ok) throw new CliError("EXPORT_FAILED", "No se pudo bajar la lista de leads");
    const text = await response.text();
    try {
      await writeFile(path, text, options.force ? {} : { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw fileExists();
      throw new CliError(
        "FILE_NOT_WRITABLE",
        `No se pudo guardar ${path}`,
        "Revisa que la carpeta exista y se pueda escribir, o usa otro --out",
      );
    }
    deps.print(`${deps.colors.green("✓")} Leads de ${broker.slug} guardados en ${path}`);
    deps.print(deps.colors.dim("Tiene datos personales de terceros: guárdalo con cuidado."));
    return 0;
  });
}

/**
 * `agentsales leads webhook-secret [--broker] [--yes]`: genera o rota el secreto del webhook de
 * ManyChat. Se muestra una sola vez; el anterior deja de servir (hay que actualizar ManyChat).
 */
export function runLeadsWebhookSecret(
  deps: LeadsDeps,
  options: { broker?: string; yes?: boolean } = {},
) {
  return guarded(deps, async () => {
    const broker = await brandOf(deps.client, options.broker);
    if (
      options.yes !== true &&
      !(await deps.confirm(
        `Generar un secreto nuevo del webhook de ${broker.slug}? El anterior deja de servir`,
      ))
    ) {
      deps.print("No se cambió nada.");
      return 1;
    }
    const { secret, path } = await unwrap(
      deps.client.brokers[":id"].leads["webhook-secret"].$post({ param: { id: broker.id } }),
      leadWebhookSecretResponseSchema,
    );
    const c = deps.colors;
    deps.print(`${c.green("✓")} Secreto nuevo para ${broker.slug} (no se vuelve a mostrar):`);
    deps.print(`  ${secret}`);
    deps.print("");
    deps.print("En ManyChat, en el «External Request»:");
    deps.print(`  Método y ruta:  POST <dirección de la API>${path.replace(/^\/api/, "")}`);
    deps.print("  Cabecera:       x-agentsales-secret: <el secreto de arriba>");
    deps.print(c.dim("No lo pegues en el chat ni lo guardes en git."));
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  const deps = (): LeadsDeps => ({ ...ctx, client: ctx.api() });
  const leads = program
    .command("leads")
    .description("Los leads de un corredor (datos personales de terceros): ver, mover y exportar");
  leads
    .command("list")
    .description("Lista los leads (más nuevos primero)")
    .option("--broker <slug>", "el corredor (si ves más de uno)")
    .option("--status <estado>", `solo un estado: ${LEAD_STATUSES.join(", ")}`)
    .option("--listing <id>", "solo los de una propiedad")
    .option("--limit <n>", "cuántos (hasta 500; por defecto 100)")
    .option("--json", "salida en JSON")
    .action((options: LeadsListOptions) => exitWith(() => runLeadsList(deps(), options)));
  leads
    .command("show")
    .description("Un lead con su atribución y su consentimiento")
    .argument("<id>", "el id o su comienzo (agentsales leads list)")
    .option("--broker <slug>", "el corredor, si usas el comienzo del id")
    .action((id: string, options: { broker?: string }) =>
      exitWith(() => runLeadsShow(deps(), id, options)),
    );
  leads
    .command("status")
    .description(`Cambia el estado de un lead: ${LEAD_STATUSES.join(", ")}`)
    .argument("<id>", "el id o su comienzo")
    .argument("<estado>", "el estado nuevo")
    .option("--broker <slug>", "el corredor, si usas el comienzo del id")
    .action((id: string, status: string, options: { broker?: string }) =>
      exitWith(() => runLeadsStatus(deps(), id, status, options)),
    );
  leads
    .command("assign")
    .description("Asigna un lead a un usuario del corredor (o «ninguno»)")
    .argument("<id>", "el id o su comienzo")
    .argument("<usuario>", "el id del usuario (agentsales users list) o «ninguno»")
    .option("--broker <slug>", "el corredor, si usas el comienzo del id")
    .action((id: string, user: string, options: { broker?: string }) =>
      exitWith(() => runLeadsAssign(deps(), id, user, options)),
    );
  leads
    .command("erase")
    .description("Borra el nombre, el teléfono y el correo de un lead (no se deshace)")
    .argument("<id>", "el id o su comienzo")
    .option("--broker <slug>", "el corredor, si usas el comienzo del id")
    .option("--yes", "no pide confirmación")
    .action((id: string, options: { broker?: string; yes?: boolean }) =>
      exitWith(() => runLeadsErase(deps(), id, options)),
    );
  leads
    .command("export")
    .description("Baja los leads a un CSV (no toma una fórmula de planilla por valor)")
    .option("--broker <slug>", "el corredor (si ves más de uno)")
    .option("--out <archivo>", "dónde guardarlo (por defecto leads-<slug>.csv)")
    .option("--force", "reemplaza el archivo si existe")
    .action((options: LeadsExportOptions) => exitWith(() => runLeadsExport(deps(), options)));
  leads
    .command("webhook-secret")
    .description("Genera o rota el secreto del webhook de ManyChat (se muestra una vez)")
    .option("--broker <slug>", "el corredor (si ves más de uno)")
    .option("--yes", "no pide confirmación")
    .action((options: { broker?: string; yes?: boolean }) =>
      exitWith(() => runLeadsWebhookSecret(deps(), options)),
    );
}
