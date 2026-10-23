import {
  type PostImageRunView,
  postImageOptionsResponseSchema,
  postImageRunResponseSchema,
  postImageStockResponseSchema,
} from "@agentsales/api/contracts";
import {
  formatUsd,
  LANGUAGE_TEXT,
  LANGUAGES,
  type Language,
  POST_IMAGE_FORMATS,
  type PostImageFormat,
  type PostImageRequest,
} from "@agentsales/core";
import type { Command } from "commander";
import { z } from "zod";
import { type ApiClient, unwrap } from "../api-client.js";
import type { Colors } from "../colors.js";
import { type CliContext, exitWith } from "../context.js";
import { CliError, guarded } from "../output.js";
import { type WaitDeps, waitForRun } from "./wait-run.js";

// F9.5-T25 (ADR-0038): `agentsales post media <id>`, conseguir imágenes para un post sin medios:
// tarjetas de la marca (`--card`), una foto de la biblioteca (`--stock "<búsqueda>" --pick <n>`) o
// una imagen con IA (`--ai "<indicación>"`). El worker las consigue (`post.image`) y quedan como
// medios del post, igual que una foto subida. Nunca imprime una URL firmada ni la de un archivo.

export type PostMediaDeps = WaitDeps & { client: ApiClient };

export type PostMediaOptions = {
  card?: boolean;
  /** Con `--card`: `es`, `en` o `all` (las tarjetas de cada idioma, una después de otra). */
  language?: string;
  /** Con `--card`: quita antes las tarjetas anteriores del post (nunca lo que subiste). */
  replace?: boolean;
  stock?: string;
  pick?: string;
  people?: boolean;
  ai?: string;
  format?: string;
  wait?: boolean;
};

const SOURCE_TEXT = { card: "tarjetas", stock: "biblioteca", ai: "IA" } as const;
const STATUS_TEXT: Record<string, string> = {
  queued: "en cola",
  running: "consiguiendo",
  succeeded: "listo",
  failed: "falló",
};

const show = (postId: string) => `agentsales post show ${postId}`;
const media = (postId: string) => `agentsales post media ${postId}`;

function postIdOf(id: string): string {
  const trimmed = id.trim();
  if (!z.uuid().safeParse(trimmed).success) {
    throw new CliError(
      "POST_ID_INVALID",
      `"${id}" no es el id de un post`,
      "Mira los ids con agentsales post list",
    );
  }
  return trimmed;
}

function formatOf(text: string | undefined): PostImageFormat {
  if (text === undefined) return "4:5";
  const found = POST_IMAGE_FORMATS.find((format) => format === text.trim());
  if (found === undefined) {
    throw new CliError(
      "POST_IMAGE_FORMAT_INVALID",
      `--format debe ser ${POST_IMAGE_FORMATS.join(" o ")}: "${text}"`,
    );
  }
  return found;
}

/** Una línea de un pedido: cuándo, de dónde, su estado y, si falló, el motivo. */
function runLine(run: PostImageRunView, c: Colors): string {
  const state = STATUS_TEXT[run.status] ?? run.status;
  const painted =
    run.status === "failed" ? c.red(state) : run.status === "succeeded" ? c.green(state) : state;
  const cost = run.costUsd === null ? "" : ` · ${formatUsd(run.costUsd)}`;
  const reason = run.error === null ? "" : `: ${run.error.message}`;
  return `${SOURCE_TEXT[run.source] ?? run.source} · ${painted}${cost}${reason}`;
}

/** Sin una fuente: lo que se puede usar, lo que falta y lo propuesto. */
async function printOptions(deps: PostMediaDeps, postId: string): Promise<number> {
  const c = deps.colors;
  const options = await unwrap(
    deps.client.posts[":id"].images.$get({ param: { id: postId } }),
    postImageOptionsResponseSchema,
  );
  const { stock, ai } = options.sources;
  deps.print(c.bold("Conseguir imagen"));
  deps.print(`  Tarjetas de la marca (US$ 0): ${media(postId)} --card [--format 4:5|9:16]`);
  if (options.cards !== null) {
    const several = options.cards.languages.length > 1;
    for (const item of options.cards.languages) {
      const lead = several ? `En ${LANGUAGE_TEXT[item.language]}: ` : "";
      const said =
        item.count === null ? item.message : `${several ? "saldrían" : "Saldrían"} ${item.message}`;
      deps.print(`    ${lead}${said}`);
      if (item.existing > 0) {
        deps.print(
          c.yellow(
            `    Ya tiene ${item.existing} en ${LANGUAGE_TEXT[item.language]} de pedidos anteriores: agrega --replace para quitarlas antes (lo que subiste no se toca).`,
          ),
        );
      }
    }
    if (several) {
      deps.print(
        c.dim(
          `    Cada texto se publica con las tarjetas de su idioma: --language ${LANGUAGES.join("|")}|all`,
        ),
      );
    }
  }
  deps.print(
    stock.available
      ? `  Biblioteca (Pixabay): ${media(postId)} --stock "${options.suggestions.query}"`
      : `  Biblioteca (Pixabay): ${c.yellow(`falta ${stock.missing ?? "su clave"} en el servidor`)}`,
  );
  if (!ai.available) {
    deps.print(`  Crear con IA: ${c.yellow(`falta ${ai.missing ?? "su clave"} en el servidor`)}`);
  } else {
    const spent = `${formatUsd(ai.spentUsd)} de ${formatUsd(ai.capUsd ?? 0)} este mes`;
    deps.print(
      ai.capReached
        ? `  Crear con IA: ${c.red(`llegaste al tope de este mes (${spent})`)}`
        : `  Crear con IA (${formatUsd(ai.priceUsd ?? 0)} por imagen; ${spent}): ${media(postId)} --ai "${options.suggestions.prompt}"`,
    );
    deps.print(
      c.dim(
        "    El modelo y el precio son los de la configuración, sin verificar hasta la prueba del operador: el gasto es una estimación.",
      ),
    );
  }
  if (options.runs.length > 0) {
    deps.print("");
    deps.print(c.bold("Últimos pedidos"));
    for (const run of options.runs) deps.print(`  ${runLine(run, c)}`);
  }
  return 0;
}

/**
 * Los idiomas de las tarjetas que pide `--language`: ninguno (el servidor usa el principal de la
 * marca), uno, o `all`: los de la marca y sus textos, uno después de otro.
 */
async function cardLanguagesOf(
  deps: PostMediaDeps,
  postId: string,
  text: string | undefined,
): Promise<Language[]> {
  if (text === undefined) return [];
  const wanted = text.trim().toLowerCase();
  if (wanted === "all") {
    const options = await unwrap(
      deps.client.posts[":id"].images.$get({ param: { id: postId } }),
      postImageOptionsResponseSchema,
    );
    return (options.cards?.languages ?? []).map((item) => item.language);
  }
  const found = LANGUAGES.find((language) => language === wanted);
  if (found === undefined) {
    throw new CliError(
      "POST_IMAGE_LANGUAGE_INVALID",
      `--language debe ser ${LANGUAGES.join(", ")} o all: "${text}"`,
    );
  }
  return [found];
}

/** Espera un pedido e imprime cómo terminó; 1 si falló o si no terminó a tiempo. */
async function waitForImage(
  deps: PostMediaDeps,
  postId: string,
  run: PostImageRunView,
): Promise<number> {
  const c = deps.colors;
  deps.print(`Imágenes ${run.id}: ${STATUS_TEXT[run.status] ?? run.status}…`);
  const done = await waitForRun<PostImageRunView>(deps, {
    run,
    fetch: async () =>
      (
        await unwrap(
          deps.client.posts[":id"].images[":runId"].$get({ param: { id: postId, runId: run.id } }),
          postImageRunResponseSchema,
        )
      ).run,
    isTerminal: (current) => current.status === "succeeded" || current.status === "failed",
    progress: (current) => STATUS_TEXT[current.status] ?? current.status,
    laterCommand: media(postId),
    noun: "las imágenes",
  });
  if (done === null) return 1;
  if (done.status === "failed") {
    deps.printError(c.red(`No se consiguió: ${done.error?.message ?? "falló"}`));
    if (done.error !== null) deps.printError(c.dim(`(${done.error.code})`));
    return 1;
  }
  const count = done.mediaIds.length;
  deps.print(
    c.green(
      `Listo: ${count === 1 ? "1 medio quedó" : `${count} medios quedaron`} en el post (${SOURCE_TEXT[done.source]})`,
    ),
  );
  if (done.costUsd !== null) {
    deps.print(`Costo: ${formatUsd(done.costUsd)}${done.model === null ? "" : ` (${done.model})`}`);
  }
  if (done.request.source === "card" && (done.request.thenLanguages?.length ?? 0) > 0) {
    deps.print(
      c.dim(
        `→ Después se hacen las tarjetas en ${done.request.thenLanguages?.map((l) => LANGUAGE_TEXT[l]).join(" y ")}: sigue con ${media(postId)}`,
      ),
    );
  }
  deps.print(c.dim(`→ Se arman sus variantes en un momento. Revísalos con ${show(postId)}`));
  return 0;
}

/**
 * `agentsales post media <id> [--card | --stock "<búsqueda>" [--pick <n>] | --ai "<indicación>"]`
 * (F9.5-T25). Sin fuente, muestra lo disponible. `--stock` sin `--pick` lista los resultados
 * numerados (sin personas, salvo `--people`); con `--pick <n>`, pide esa. Espera el pedido salvo
 * `--no-wait`.
 */
export function runPostMedia(deps: PostMediaDeps, id: string, options: PostMediaOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const postId = postIdOf(id);
    const chosen = [options.card === true, options.stock !== undefined, options.ai !== undefined];
    if (chosen.filter(Boolean).length > 1) {
      throw new CliError("POST_MEDIA_OPTIONS", "Elige una sola fuente: --card, --stock o --ai");
    }
    if (options.replace === true && options.card !== true) {
      throw new CliError("POST_MEDIA_OPTIONS", "--replace va con --card");
    }
    if (options.language !== undefined && options.card !== true) {
      throw new CliError("POST_MEDIA_OPTIONS", "--language va con --card");
    }
    if (options.pick !== undefined && options.stock === undefined) {
      throw new CliError("POST_MEDIA_OPTIONS", '--pick va con --stock "<búsqueda>"');
    }
    if (!chosen.some(Boolean)) return printOptions(deps, postId);
    const format = formatOf(options.format);

    let request: PostImageRequest;
    if (options.card === true) {
      const languages = await cardLanguagesOf(deps, postId, options.language);
      const [first, ...rest] = languages;
      request = {
        source: "card",
        format,
        ...(first === undefined ? {} : { language: first }),
        ...(rest.length > 0 ? { thenLanguages: rest } : {}),
        ...(options.replace === true ? { replaceCards: true } : {}),
      };
    } else if (options.stock !== undefined) {
      const query = options.stock.trim();
      const { photos } = await unwrap(
        deps.client.posts[":id"].images.stock.$get({
          param: { id: postId },
          query: { q: query, ...(options.people === true ? { people: "1" } : {}) },
        }),
        postImageStockResponseSchema,
      );
      if (photos.length === 0) {
        deps.print(`La biblioteca no tiene fotos para "${query}": prueba con otras palabras.`);
        return 1;
      }
      if (options.pick === undefined) {
        deps.print(c.bold(`Biblioteca (Pixabay): "${query}"`));
        photos.forEach((photo, index) => {
          const tags = photo.tags.slice(0, 5).join(", ");
          deps.print(
            `  ${String(index + 1).padStart(2)}. id ${photo.id} · ${photo.width}×${photo.height} · ${tags} · de ${photo.author}`,
          );
          deps.print(`      ${c.dim(photo.pageUrl)}`);
        });
        deps.print(c.dim(`→ Elige una con: ${media(postId)} --stock "${query}" --pick <n o id>`));
        return 0;
      }
      // El id de la foto (no depende del orden) o su número en la lista.
      const pick = options.pick.trim();
      const index = Number(pick);
      const photo =
        photos.find((item) => item.id === pick) ??
        (Number.isInteger(index) && index >= 1 ? photos[index - 1] : undefined);
      if (photo === undefined) {
        throw new CliError(
          "POST_MEDIA_PICK_INVALID",
          `--pick debe ser un número del 1 al ${photos.length} o el id de una foto de la lista: "${options.pick}"`,
        );
      }
      request = { source: "stock", photoId: photo.id, query, format };
    } else {
      request = { source: "ai", prompt: options.ai ?? "", format };
    }

    const { run } = await unwrap(
      deps.client.posts[":id"].images.$post({ param: { id: postId }, json: request }),
      postImageRunResponseSchema,
    );
    if (options.wait === false) {
      deps.print(run.id);
      deps.printError(c.dim(`→ Revisa cómo va con: ${media(postId)}`));
      return 0;
    }
    return waitForImage(deps, postId, run);
  });
}

/** `post media`, colgado de `post` (lo registra `post.ts`). */
export function registerPostMedia(post: Command, ctx: CliContext): void {
  post
    .command("media")
    .description(
      "Consigue imágenes para el post: tarjetas de la marca, una foto de la biblioteca o una imagen con IA",
    )
    .argument("<id>", "id del post")
    .option(
      "--card",
      "tarjetas con el texto del post sobre los colores y el logo de la marca (US$ 0)",
    )
    .option(
      "--replace",
      "con --card: quita antes las tarjetas anteriores del post (lo que subiste no se toca)",
    )
    .option(
      "--language <es|en|all>",
      "con --card: el idioma de las tarjetas (portada, puntos y cierre salen del texto en ese idioma); all, las de cada idioma",
    )
    .option("--stock <búsqueda>", "busca en la biblioteca de Pixabay (lista los resultados)")
    .option("--pick <n o id>", "con --stock: elige el resultado n (desde 1) o la foto con ese id")
    .option("--people", "con --stock: incluye fotos con personas")
    .option("--ai <indicación>", "crea una imagen con IA (sin texto dentro; tiene costo y tope)")
    .option("--format <proporción>", `${POST_IMAGE_FORMATS.join(" o ")} (por defecto 4:5)`)
    .option("--no-wait", "imprime el id del pedido y sale sin esperar")
    .action((id: string, options: PostMediaOptions) =>
      exitWith(() =>
        runPostMedia(
          {
            ...ctx,
            client: ctx.api(),
            sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
            now: () => performance.now(),
          },
          id,
          options,
        ),
      ),
    );
}
