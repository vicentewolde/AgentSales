import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  type ContentRunView,
  type ContentView,
  contentApproveResponseSchema,
  contentEditResponseSchema,
  contentRunRequestResponseSchema,
  contentRunResponseSchema,
  contentUnapproveResponseSchema,
  ideaAcceptResponseSchema,
  type PostDetailResponse,
  type PostJson,
  type PublicationView,
  postDetailResponseSchema,
  postListResponseSchema,
  postPublishResponseSchema,
  postResponseSchema,
  postScheduleResponseSchema,
  postUploadCompleteResponseSchema,
  postUploadResponseSchema,
  publicationResponseSchema,
} from "@agentsales/api/contracts";
import {
  CONTENT_STATUS_TEXT,
  contentRunProgressText,
  formatChileTime,
  formatXUsd,
  healthReportSchema,
  isTerminalContentRun,
  LANGUAGE_TEXT,
  type Language,
  MUSIC_TRACK_IDS,
  type MusicTrackId,
  musicTrackText,
  PLATFORM_TEXT,
  POST_KIND_TEXT,
  POST_KINDS,
  POST_STATUSES,
  type PostKind,
  type PostPlatform,
  type PostStatus,
  PUBLICATION_QUEUED_WARNING_TEXT,
  PUBLICATION_STATUS_TEXT,
  postNetworkGaps,
  postPublishesOn,
  publicationFormatText,
  publicationModeText,
  X_LINK_POST_COST_USD,
  X_POST_COST_USD,
  xPostHasLink,
} from "@agentsales/core";
import type { Command } from "commander";
import { z } from "zod";
import { ApiCallError, type ApiClient, unwrap } from "../api-client.js";
import type { Colors } from "../colors.js";
import { type CliContext, exitWith, type Terminal } from "../context.js";
import { CliError, formatBytes, guarded, renderTable } from "../output.js";
import {
  createNodePutFile,
  type LocalUpload,
  type PutFile,
  sha256Of,
  uploadAll,
} from "../upload.js";
import { brandOf } from "./brand.js";
import { paintContentRunStatus, renderChecks } from "./content-view.js";
import { registerPostMedia } from "./post-media.js";
import { paintPublicationStatus } from "./publication-view.js";
import { atOption, collect, confirmLive } from "./schedule.js";
import {
  fetchBrokers,
  languageOption,
  manualConfirmHint,
  POST_PLATFORM_OPTION_NAMES,
  parseMusicTrack,
  platformShortName,
  postPlatformOption,
} from "./shared.js";
import { POST_STATUS_TEXT } from "./tracking.js";
import { type WaitDeps, waitForRun } from "./wait-run.js";

// F9-T12 (spec F9 §4.10): `agentsales post …`, los posts de una marca contra la API: crearlos,
// listarlos y verlos, subir sus medios directo a R2, pedir sus textos a la IA, editarlos,
// aprobarlos, publicarlos o programarlos, y archivarlos. Los textos van por red e idioma.

export type PostDeps = WaitDeps &
  Pick<Terminal, "confirm" | "stdinIsTty" | "readStdin"> & {
    client: ApiClient;
    /** Base de las rutas relativas de `upload` y `edit --file` (`INIT_CWD`). */
    cwd: string;
    /** El `PUT` a R2 de cada archivo (por defecto `node:http(s)`; los tests pasan un doble). */
    putFile?: PutFile;
  };

/** El tipo de un post: vive en core, junto a los demás textos (F9.5-T02). */
export { POST_KIND_TEXT } from "@agentsales/core";

/** El tope de un texto pasado con `--file` o por la entrada estándar (el de la API). */
const TEXT_MAX_CHARS = 20_000;

const show = (postId: string) => `agentsales post show ${postId}`;

/** El id de un post: un uuid, como lo muestra `agentsales post list`. */
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

/** `discord · español`: la red y el idioma de un texto o una publicación. */
const textName = (item: { platform: PostPlatform | string; language: Language }) =>
  `${PLATFORM_TEXT[item.platform as PostPlatform] ?? item.platform} · ${LANGUAGE_TEXT[item.language] ?? item.language}`;

/** Lo que cuesta un enlace en X (`x.md` §2, spec F9 §4.12), con los montos de core. */
const X_LINK_COST_TEXT = `${formatXUsd(X_LINK_POST_COST_USD)} en vez de ${formatXUsd(X_POST_COST_USD)}`;

/** El comando que permite un enlace en el texto de X del post (F9-T16). */
const xLinkCommand = (postId: string) => `agentsales post edit ${postId} --x-link`;

/**
 * Un texto de X que lleva un enlace sin la marca del post (`xLinkAllowed`, F9-T16): la revisión lo
 * da por error (`LINK_NOT_ALLOWED`) y no se aprueba hasta permitirlo o quitar el enlace.
 */
const needsXLinkMark = (
  post: Pick<PostJson, "xLinkAllowed">,
  content: Pick<ContentView, "platform" | "body">,
): boolean => content.platform === "x" && !post.xLinkAllowed && xPostHasLink(content.body);

/** Qué hacer con un texto de X con enlace sin la marca del post. */
const xLinkHint = (postId: string) =>
  `Si el enlace va, permítelo con ${xLinkCommand(postId)} (en X cuesta ${X_LINK_COST_TEXT}; el enlace también tiene que estar en el brief) y vuelve a aprobar; si no, quita el enlace del texto (agentsales post edit ${postId} --platform x --file <texto>)`;

/**
 * Qué hacer ante los errores de los posts (spec F9 §4.10): la API manda su código y su mensaje; la
 * CLI suma el comando que lo arregla. Con `xLinkMissing` (un texto de X con enlace sin la marca del
 * post), `CONTENT_HAS_ERRORS` dice cómo permitirlo.
 */
function postHint(error: ApiCallError, postId: string, xLinkMissing = false): string | undefined {
  if (error.code === "CONTENT_HAS_ERRORS" && xLinkMissing) return xLinkHint(postId);
  const hints: Record<string, string> = {
    POST_NOT_FOUND: "Mira tus posts con agentsales post list",
    POST_NOT_IDEA: `Ya no es una idea: míralo con ${show(postId)} (si la IA está redactando, sus textos aparecen ahí al terminar). Si quedó aceptada sin textos y sin redacción en curso, pídelos con agentsales post draft ${postId}; un post aceptado se archiva con agentsales post archive ${postId}`,
    QUEUE_UNAVAILABLE: `El worker o la cola no responden: arranca el worker (pnpm dev, o el del servidor) y vuelve a intentarlo; si fue al aceptar una idea, esa ya quedó aceptada sin textos: pídelos con agentsales post draft ${postId}`,
    POST_PLATFORM_EXCLUDED: `Esa red no está entre las del post: agrégala con agentsales post edit ${postId} --platforms <redes>`,
    POST_NOT_READY: `Mira su estado con ${show(postId)}: una idea se acepta primero y un post archivado ya no cambia`,
    POST_ARCHIVED: "Un post archivado no cambia: crea otro con agentsales post create",
    POST_HAS_PENDING_PUBLICATIONS: `Cancélalas con agentsales publications cancel <id> (o resuélvelas) antes de archivar el post o quitarle esa red; míralas con ${show(postId)}`,
    POST_NO_PLATFORMS:
      "Conecta una cuenta de la marca (agentsales accounts) o define la cadencia de una red en su perfil (agentsales brand edit)",
    LLM_BUDGET_EXCEEDED:
      "La marca llegó a su tope de IA del mes: mira el gasto con agentsales usage y pide al administrador subir el tope, o espera al mes siguiente",
    LLM_OUTPUT_INVALID: `La IA no entregó los textos en el formato pedido: vuelve a pedirlos con agentsales post draft ${postId}`,
    CONTENT_EDITED: `Para reemplazarlos, agentsales post draft ${postId} --replace-edits`,
    PUBLICATION_PENDING: `Publícalas o descártalas antes de pedir textos nuevos (${show(postId)})`,
    CONTENT_RUN_ACTIVE: `Espera a que terminen los textos (${show(postId)})`,
    CONTENT_NOT_FOUND: `Pide los textos con agentsales post draft ${postId}; las redes e idiomas que tiene salen en ${show(postId)}`,
    CONTENT_NOT_CURRENT: "El texto cambió: vuelve a intentarlo",
    CONTENT_HAS_ERRORS: `Corrige el texto (agentsales post edit ${postId} --platform <red> --language <idioma> --file <texto>) y vuelve a aprobar`,
    CONTENT_NOT_READY: `Faltan los medios que pide la red: súbelos con agentsales post upload ${postId} <archivos…>`,
    CONTENT_NOT_APPROVED: `Aprueba el texto con agentsales post approve ${postId} --platform <red>`,
    CONTENT_LOCKED: `Quita la aprobación (agentsales post approve ${postId} --platform <red> --undo) o descarta la publicación (agentsales publications cancel <id>)`,
    ACCOUNT_NOT_CONNECTED: "Conecta la cuenta de la red: agentsales accounts",
    NOTHING_TO_PUBLISH: `Mira el estado con ${show(postId)}`,
    PUBLICATION_IN_PROGRESS: `Espera a que termine (${show(postId)}) y vuelve a intentarlo`,
    PUBLISH_MODE_LOCKED:
      "Ya empezó en vivo y no se reintenta en simulación: descártala con agentsales publications cancel <id>, o reinicia la API en vivo si lo decides tú",
    OUTCOME_UNKNOWN_PENDING: `No se sabe si salió: dilo con agentsales publications resolve ${error.publicationId ?? "<id>"} --published|--not-published`,
    MANUAL_CONFIRM_PENDING: manualConfirmHint(error.publicationId),
  };
  return error.code === undefined ? undefined : hints[error.code];
}

/** Un error de la API con su consejo de posts, si lo tiene (los demás siguen su curso). */
function explained(error: unknown, postId: string): unknown {
  if (!(error instanceof ApiCallError) || error.status === undefined) return error;
  const hint = postHint(error, postId);
  if (hint === undefined) return error;
  return new CliError(error.code ?? "API_ERROR", error.apiMessage ?? error.message, hint);
}

/** Un rechazo para una red e idioma, con qué hacer, sin cortar los demás. */
function reasonOf(error: unknown, postId: string, xLinkMissing = false): string {
  if (!(error instanceof ApiCallError) || error.status === undefined) throw error;
  const message = `${error.code ?? "ERROR"}: ${error.apiMessage ?? error.message}`;
  const hint = postHint(error, postId, xLinkMissing);
  return hint === undefined ? message : `${message} → ${hint}`;
}

const fetchPost = (client: ApiClient, postId: string) =>
  unwrap(client.posts[":id"].$get({ param: { id: postId } }), postDetailResponseSchema).catch(
    (error: unknown) => {
      throw explained(error, postId);
    },
  );

/** `2026-10-21` (hora de Chile) → el inicio de ese día en Chile. */
function dayOption(option: string, text: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) {
    throw new CliError("DATE_INVALID", `${option} debe ser AAAA-MM-DD: "${text}"`);
  }
  return atOption(`${text.trim()} 00:00`);
}

/** El día siguiente de `AAAA-MM-DD`, en el mismo formato (para un `--to` que incluye ese día). */
function nextDay(text: string): string {
  const [year = 0, month = 1, day = 1] = text.trim().split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

// ── create, list y show ──────────────────────────────────────────────────

export type PostCreateOptions = {
  broker?: string;
  brief?: string;
  kind?: string;
  pillar?: string;
  date?: string;
};

/**
 * `agentsales post create "<tema>" [--brief] [--kind] [--pillar] [--date] [--broker]`: un post en
 * borrador con el brief del operador (lo que la IA puede afirmar, además del perfil de la marca).
 */
export function runPostCreate(deps: PostDeps, topic: string, options: PostCreateOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const kind = options.kind?.trim().toLowerCase();
    if (kind !== undefined && !(POST_KINDS as readonly string[]).includes(kind)) {
      throw new CliError(
        "POST_KIND_INVALID",
        `--kind debe ser ${POST_KINDS.join(", ")}: "${options.kind}"`,
      );
    }
    const plannedAt = options.date === undefined ? undefined : atOption(options.date);
    const brand = await brandOf(deps.client, options.broker);
    const { post } = await unwrap(
      deps.client.posts.$post({
        json: {
          brokerId: brand.id,
          topic,
          ...(options.brief === undefined ? {} : { brief: options.brief }),
          ...(kind === undefined ? {} : { kind: kind as PostKind }),
          ...(options.pillar === undefined ? {} : { pillar: options.pillar }),
          ...(plannedAt === undefined ? {} : { plannedAt }),
        },
      }),
      postResponseSchema,
    );
    deps.print(
      `${c.green("✓")} Post ${post.id} creado en ${brand.slug}: "${post.topic}" (${POST_STATUS_TEXT[post.status] ?? post.status}, ${POST_KIND_TEXT[post.kind] ?? post.kind})`,
    );
    deps.print(
      c.dim(
        `→ Sube sus medios con agentsales post upload ${post.id} <archivos…> y pide los textos con agentsales post draft ${post.id}`,
      ),
    );
    return 0;
  });
}

export type PostListOptions = {
  broker?: string;
  status?: string;
  from?: string;
  to?: string;
  json?: boolean;
};

/** `agentsales post list [--broker] [--status] [--from AAAA-MM-DD] [--to AAAA-MM-DD] [--json]`. */
export function runPostList(deps: PostDeps, options: PostListOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const status = options.status?.trim().toLowerCase();
    if (status !== undefined && !(POST_STATUSES as readonly string[]).includes(status)) {
      throw new CliError(
        "POST_STATUS_INVALID",
        `--status debe ser ${POST_STATUSES.join(", ")}: "${options.status}"`,
      );
    }
    const from = options.from === undefined ? undefined : dayOption("--from", options.from);
    // `--to` incluye ese día: hasta el inicio del siguiente (revisado antes, con su propio texto).
    if (options.to !== undefined) dayOption("--to", options.to);
    const to = options.to === undefined ? undefined : dayOption("--to", nextDay(options.to));
    const brokers = await fetchBrokers(deps.client);
    const brand =
      options.broker === undefined ? undefined : await brandOf(deps.client, options.broker);
    const { posts } = await unwrap(
      deps.client.posts.$get({
        query: {
          ...(brand === undefined ? {} : { brokerId: brand.id }),
          ...(status === undefined ? {} : { status: status as PostStatus }),
          ...(from === undefined ? {} : { from: from.toISOString() }),
          ...(to === undefined ? {} : { to: to.toISOString() }),
        },
      }),
      postListResponseSchema,
    );
    if (options.json) {
      deps.print(JSON.stringify({ posts }, null, 2));
      return 0;
    }
    if (posts.length === 0) {
      deps.print(c.yellow('No hay posts: crea uno con agentsales post create "<tema>"'));
      return 0;
    }
    deps.print(
      renderTable(
        ["ID", "MARCA", "ESTADO", "TIPO", "FECHA (CHILE)", "TEMA"],
        posts.map((post) => [
          post.id,
          brokers.get(post.brokerId)?.slug ?? post.brokerId,
          POST_STATUS_TEXT[post.status] ?? post.status,
          POST_KIND_TEXT[post.kind] ?? post.kind,
          post.plannedAt === null ? c.dim("—") : formatChileTime(post.plannedAt),
          post.topic,
        ]),
        c,
      ),
    );
    return 0;
  });
}

/** Un texto de post: red e idioma, estado, cuerpo, hashtags y revisión. */
export function renderPostContent(content: ContentView, c: Colors): string {
  const lines = [
    `${c.bold(textName(content))}  ${c.dim(
      `${CONTENT_STATUS_TEXT[content.status] ?? content.status} · ${content.promptVersion} · ${formatChileTime(content.updatedAt)}`,
    )}`,
    ...content.body.split("\n").map((line) => (line === "" ? "" : `  ${line}`)),
  ];
  if (content.hashtags.length > 0) lines.push("", `  ${content.hashtags.join(" ")}`);
  lines.push("", `  ${c.bold("Revisión:")}`, ...renderChecks(content, c, "    "));
  return lines.join("\n");
}

/** Lo que se hace con cada publicación pendiente del operador, por su id. */
export function publicationNextSteps(publication: PublicationView): string[] {
  const id = publication.id;
  switch (publication.status) {
    case "outcome_unknown":
      return [
        `Si salió: agentsales publications resolve ${id} --published (con el enlace: pbpaste | agentsales publications resolve ${id} --published --url-stdin)`,
        `Si no: agentsales publications resolve ${id} --not-published`,
      ];
    case "awaiting_manual_confirm":
      return [
        `Publícalo a mano y pega el enlace: pbpaste | agentsales publications confirm ${id} --url-stdin`,
        `Si no lo publicaste: agentsales publications not-published ${id}`,
      ];
    case "failed":
      return [
        // F9-T19: el consejo del error, como en el panel y la agenda.
        ...(publication.errorAdvice === null ? [] : [`Qué hacer: ${publication.errorAdvice}`]),
        `Reintenta: agentsales publications retry ${id}`,
        `O descártala: agentsales publications cancel ${id}`,
      ];
    case "approved":
      return [`Publica ya: agentsales publications retry ${id}, o prográmala con post schedule`];
    default:
      return [];
  }
}

/** Las publicaciones de un post: red, formato, idioma, estado, modo, hora y enlace o error. */
export function renderPostPublications(
  publications: readonly PublicationView[],
  c: Colors,
): string {
  const table = renderTable(
    ["ID", "RED", "FORMATO", "IDIOMA", "ESTADO", "MODO", "HORA (CHILE)", "ENLACE O ERROR"],
    publications.map((publication) => [
      publication.id,
      PLATFORM_TEXT[publication.platform] ?? publication.platform,
      publicationFormatText(publication.platform, publication.format, publication.mediaIds.length),
      publication.language,
      paintPublicationStatus(publication, c),
      publicationModeText(publication.dryRun),
      publication.publishedAt !== null
        ? formatChileTime(publication.publishedAt)
        : publication.scheduledAt !== null
          ? formatChileTime(publication.scheduledAt)
          : "",
      publication.externalUrl ??
        (publication.lastError === null
          ? ""
          : c.red(`${publication.lastError.code}: ${publication.lastError.message}`)),
    ]),
    c,
  );
  const steps = publications.flatMap((publication) => {
    const lines = publicationNextSteps(publication);
    return lines.length === 0
      ? []
      : [`  ${publication.id}:`, ...lines.map((line) => c.dim(`    → ${line}`))];
  });
  return [table, ...steps].join("\n");
}

/** `post show`: el post, sus medios con sus variantes, sus textos con su revisión y sus publicaciones. */
export function renderPostDetail(detail: PostDetailResponse, brandSlug: string, c: Colors): string {
  const { post, media, contents, latestRun, publications } = detail;
  const lines = [
    `${c.bold(post.topic)}  ${c.dim(`${POST_STATUS_TEXT[post.status] ?? post.status} · ${POST_KIND_TEXT[post.kind] ?? post.kind} · ${brandSlug}`)}`,
    `  Id: ${post.id}`,
    `  Fecha planificada: ${post.plannedAt === null ? "sin fecha" : `${formatChileTime(post.plannedAt)} (hora de Chile)`}`,
  ];
  lines.push(
    `  Redes: ${
      post.platforms === null
        ? "todas las de la marca"
        : post.platforms.map((platform) => PLATFORM_TEXT[platform] ?? platform).join(", ")
    }`,
  );
  if (post.pillar !== null) lines.push(`  Tema: ${post.pillar}`);
  // F9.5-T19: la música de sus videos (solo si tiene alguno o ya se eligió).
  if (post.musicTrackId !== null || media.some((item) => item.kind === "video")) {
    lines.push(`  Música de los videos: ${musicTrackText(post.musicTrackId)}`);
  }
  // F9-T16: la marca del operador que permite un enlace en X (sin ella, un texto con enlace no se aprueba).
  if (postPublishesOn(post, "x") || contents.some((content) => content.platform === "x")) {
    lines.push(
      `  Enlace en X: ${
        post.xLinkAllowed
          ? `permitido (un post con enlace cuesta ${X_LINK_COST_TEXT}; quítalo con agentsales post edit ${post.id} --no-x-link)`
          : `no permitido (permítelo con ${xLinkCommand(post.id)}; cuesta ${X_LINK_COST_TEXT})`
      }`,
    );
  }
  if (post.brief !== null) {
    const origin =
      post.briefOrigin === "operator" ? "tuyo" : "de la IA: no vale como fuente de hechos";
    lines.push(`  Brief (${origin}):`, ...post.brief.split("\n").map((line) => `    ${line}`));
  }
  lines.push(
    `  Últimos textos: ${
      latestRun === null
        ? "ninguno"
        : `${paintContentRunStatus(latestRun, c)} (${formatChileTime(latestRun.createdAt)})${
            latestRun.error === null
              ? ""
              : ` · ${c.red(`${latestRun.error.code}: ${latestRun.error.message}`)}`
          }`
    }`,
  );

  lines.push("", c.bold(`Medios (${media.length})`));
  if (media.length === 0) lines.push(c.dim("  (ninguno: súbelos con agentsales post upload)"));
  media.forEach((item, index) => {
    const variants =
      item.variants.length === 0
        ? c.yellow("procesando…")
        : `variantes: ${item.variants.join(", ")}`;
    lines.push(
      `  ${index + 1}. ${item.kind === "video" ? "video" : "imagen"} · ${item.mime} · ${formatBytes(item.bytes)} · ${variants}`,
    );
  });

  // Una red agregada al post después de redactar (F9-T21): falta su texto. Si no hay ninguno,
  // ese aviso basta (no se repite el "ninguno").
  const { missing } = postNetworkGaps(detail);
  lines.push("", c.bold(`Textos (${contents.length})`));
  if (contents.length === 0 && missing.length === 0)
    lines.push(c.dim(`  (ninguno: pídelos con agentsales post draft ${post.id})`));
  for (const content of contents) {
    lines.push(renderPostContent(content, c));
    if (needsXLinkMark(post, content)) {
      lines.push(
        c.yellow(`  Lleva un enlace y el post no lo permite en X: no se aprueba así.`),
        c.dim(`  → ${xLinkHint(post.id)}`),
      );
    }
    if (!postPublishesOn(post, content.platform)) {
      lines.push(
        c.yellow(
          `  ${PLATFORM_TEXT[content.platform] ?? content.platform} ya no está entre las redes del post: este texto no se publica ni se programa`,
        ),
      );
    }
    lines.push("");
  }
  if (missing.length > 0) {
    lines.push(
      c.yellow(
        `  Falta el texto de ${missing.map((platform) => PLATFORM_TEXT[platform] ?? platform).join(", ")}: pídelo con agentsales post draft ${post.id}`,
      ),
      "",
    );
  }

  lines.push(c.bold(`Publicaciones (${publications.length})`));
  if (publications.length === 0) {
    lines.push(c.dim(`  (ninguna: aprueba un texto con agentsales post approve ${post.id})`));
  } else {
    lines.push(renderPostPublications(publications, c));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * El detalle para `--json` sin las URLs de los medios: son URLs prefirmadas de R2 (dan acceso de
 * lectura por un rato) y la CLI no las imprime. Cada medio queda con su id, tipo, tamaño y variantes.
 */
export function withoutSignedUrls(detail: PostDetailResponse) {
  return {
    ...detail,
    media: detail.media.map(({ url: _url, thumbUrl: _thumbUrl, ...item }) => item),
  };
}

/** `agentsales post show <id> [--json]`. */
export function runPostShow(deps: PostDeps, id: string, options: { json?: boolean } = {}) {
  return guarded(deps, async () => {
    const postId = postIdOf(id);
    const detail = await fetchPost(deps.client, postId);
    if (options.json) {
      deps.print(JSON.stringify(withoutSignedUrls(detail), null, 2));
      return 0;
    }
    const brokers = await fetchBrokers(deps.client);
    deps.print(
      renderPostDetail(
        detail,
        brokers.get(detail.post.brokerId)?.slug ?? detail.post.brokerId,
        deps.colors,
      ),
    );
    return 0;
  });
}

// ── upload ───────────────────────────────────────────────────────────────

/** Vueltas de `complete` + subir de nuevo lo que R2 todavía no tiene. */
const COMPLETE_ROUNDS = 3;

/**
 * `agentsales post upload <id> <archivos…>` (spec F9 §4.5, ADR-0025): pide una URL por archivo (con
 * su sha256, calculado en streaming), sube directo a R2 con exactamente las cabeceras firmadas y
 * avance, y llama a `complete` hasta que no falte ninguno de los suyos (lo que falte se vuelve a
 * subir). Un archivo que el post ya tiene no se sube. Nunca imprime las URLs.
 */
export function runPostUpload(deps: PostDeps, id: string, paths: readonly string[]) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const postId = postIdOf(id);
    if (paths.length === 0) {
      throw new CliError(
        "POST_UPLOAD_INVALID",
        "Indica uno o más archivos (jpg, png, webp, heic, mp4 o mov)",
      );
    }
    const local = new Map<string, LocalUpload>();
    const files: { name: string; size: number; sha256: string }[] = [];
    for (const path of paths) {
      const full = resolve(deps.cwd, path);
      const info = await stat(full).catch(() => null);
      if (info === null) throw new CliError("POST_FILE_NOT_FOUND", `No existe ${full}`);
      if (!info.isFile()) throw new CliError("POST_FILE_INVALID", `${full} no es un archivo`);
      const name = basename(full);
      if (local.has(`file:${name}`)) {
        throw new CliError(
          "POST_FILE_INVALID",
          `Hay dos archivos que se llaman ${name}`,
          "Cámbiale el nombre a uno de ellos",
        );
      }
      const sha256 = await sha256Of(full);
      local.set(`file:${name}`, { path: full, size: info.size, sha256 });
      files.push({ name, size: info.size, sha256 });
    }
    const requested = await unwrap(
      deps.client.posts[":id"].uploads.$post({ param: { id: postId }, json: { files } }),
      postUploadResponseSchema,
    ).catch((error: unknown) => {
      throw explained(error, postId);
    });
    // Una URL por contenido: dos nombres con el mismo archivo son una sola subida.
    const targets = new Map<
      string,
      { kind: "file"; name: string; url: string; headers: Record<string, string> }
    >();
    for (const upload of requested.uploads) {
      if (upload.status === "existing") {
        deps.print(c.dim(`  ${upload.name}: el post ya lo tiene`));
        continue;
      }
      if (!targets.has(upload.uploadId)) {
        targets.set(upload.uploadId, {
          kind: "file",
          name: upload.name,
          url: upload.url,
          headers: upload.headers,
        });
      }
    }
    const putFile = deps.putFile ?? createNodePutFile();
    const send = async (
      pending: readonly {
        kind: "file";
        name: string;
        url: string;
        headers: Record<string, string>;
      }[],
    ) => {
      const total = pending.reduce(
        (sum, target) => sum + (local.get(`file:${target.name}`)?.size ?? 0),
        0,
      );
      deps.printError(c.dim(`Subiendo ${pending.length} archivo(s) (${formatBytes(total)}) a R2…`));
      let lastQuarter = 0;
      await uploadAll(pending, local, {
        putFile,
        sleep: deps.sleep,
        onProgress: ({ sentBytes, totalBytes, doneFiles, totalFiles }) => {
          const quarter = totalBytes === 0 ? 4 : Math.floor((sentBytes / totalBytes) * 4);
          if (quarter > lastQuarter && quarter < 4) {
            lastQuarter = quarter;
            deps.printError(c.dim(`  ${quarter * 25} % (${doneFiles} de ${totalFiles} archivos)`));
          }
        },
      });
    };
    let pending = [...targets.entries()];
    let media: PostDetailResponse["media"] = [];
    for (let round = 1; ; round += 1) {
      if (pending.length > 0) await send(pending.map(([, target]) => target));
      const done = await unwrap(
        deps.client.posts[":id"].uploads.complete.$post({ param: { id: postId } }),
        postUploadCompleteResponseSchema,
      ).catch((error: unknown) => {
        throw explained(error, postId);
      });
      media = done.media;
      const missing = new Set(done.missing);
      pending = [...targets.entries()].filter(([uploadId]) => missing.has(uploadId));
      if (pending.length === 0) break;
      if (round >= COMPLETE_ROUNDS) {
        throw new CliError(
          "POST_UPLOAD_INCOMPLETE",
          `R2 todavía no tiene ${pending.length} archivo(s): ${pending.map(([, target]) => target.name).join(", ")}`,
          `Vuelve a correr agentsales post upload ${postId} con esos archivos`,
        );
      }
      deps.printError(c.yellow(`  Faltan ${pending.length} archivo(s) en R2: los subo de nuevo`));
    }
    deps.print(
      `${c.green("✓")} ${targets.size === 0 ? "Nada nuevo que subir" : `${targets.size} archivo(s) subidos`}: el post tiene ${media.length} medio(s)`,
    );
    deps.print(c.dim(`→ El worker arma sus variantes; míralas con ${show(postId)}`));
    return 0;
  });
}

// ── draft ────────────────────────────────────────────────────────────────

export type PostDraftOptions = { replaceEdits?: boolean; wait?: boolean };

/** Resumen de una corrida de textos de un post. */
function renderDraftRun(run: ContentRunView, c: Colors, postId: string): string {
  const lines = [`${c.bold(`Textos ${run.id}`)}  ${paintContentRunStatus(run, c)}`];
  if (run.error !== null) {
    lines.push(`  ${c.red(`${run.error.code}: ${run.error.message}`)}`);
    const hint = postHint(new ApiCallError("", run.error.code, 409), postId);
    if (hint !== undefined) lines.push(`  ${c.dim(`→ ${hint}`)}`);
  }
  const llm = run.report?.llm;
  if (llm !== undefined) {
    lines.push(
      `  ${llm.promptVersion} · ${llm.attempts} intento(s) · ${Math.round(llm.durationMs / 1000)} s`,
    );
  }
  for (const warning of run.report?.warnings ?? []) lines.push(`  ${c.yellow("⚠")} ${warning}`);
  return lines.join("\n");
}

/**
 * `agentsales post draft <id> [--replace-edits] [--no-wait]` (spec F9 §4.9): pide a la IA un texto
 * por red e idioma y espera la corrida como `prepare` (`RUN_WAIT`). Al final, la revisión de cada
 * texto. Sale con 1 si la corrida falló.
 */
export function runPostDraft(deps: PostDeps, id: string, options: PostDraftOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const postId = postIdOf(id);
    const { contentRun, reused } = await unwrap(
      deps.client.posts[":id"].draft.$post({
        param: { id: postId },
        json: options.replaceEdits ? { replaceEdits: true } : {},
      }),
      contentRunRequestResponseSchema,
    ).catch((error: unknown) => {
      throw explained(error, postId);
    });
    if (reused)
      deps.printError(c.yellow("Ya había textos en preparación para este post: sigo esos"));
    if (options.wait === false) {
      deps.print(contentRun.id);
      deps.printError(c.dim(`→ Revisa el resultado con: ${show(postId)}`));
      return 0;
    }
    return waitForDraft(deps, contentRun, postId);
  });
}

/**
 * Espera la corrida de textos de un post (`RUN_WAIT`, como `prepare`) e imprime su resumen y la
 * revisión de cada texto. La usan `post draft` y `post accept --wait`, cada uno con **su** corrida:
 * esperar nunca pide textos nuevos. Devuelve 1 si la corrida falló o no terminó en el tope.
 */
async function waitForDraft(
  deps: PostDeps,
  contentRun: ContentRunView,
  postId: string,
): Promise<number> {
  const c = deps.colors;
  deps.print(`Textos ${contentRun.id}: ${contentRunProgressText(contentRun)}…`);
  const done = await waitForRun<ContentRunView>(deps, {
    run: contentRun,
    fetch: async () =>
      (
        await unwrap(
          deps.client["content-runs"][":id"].$get({ param: { id: contentRun.id } }),
          contentRunResponseSchema,
        )
      ).contentRun,
    isTerminal: (run) => isTerminalContentRun(run.status),
    progress: contentRunProgressText,
    laterCommand: show(postId),
    noun: "los textos",
  });
  if (done === null) return 1;
  deps.print("");
  deps.print(renderDraftRun(done, c, postId));
  if (done.status !== "succeeded") return 1;
  try {
    const { contents } = await fetchPost(deps.client, postId);
    deps.print("");
    deps.print(c.bold("Revisión"));
    for (const content of contents) {
      deps.print(
        `  ${textName(content)}: ${CONTENT_STATUS_TEXT[content.status] ?? content.status}`,
      );
      deps.print(renderChecks(content, c, "    ").join("\n"));
    }
  } catch {
    deps.printError(c.yellow(`No se pudo leer la revisión: mírala con ${show(postId)}`));
  }
  deps.print("");
  deps.print(c.dim(`→ Revisa y aprueba: ${show(postId)} y agentsales post approve ${postId}`));
  return 0;
}

// ── edit y approve ───────────────────────────────────────────────────────

/** La red y el idioma de un texto: `--language` o, si la red tiene uno solo, ese. */
async function textTarget(
  deps: PostDeps,
  postId: string,
  options: { platform?: string; language?: string },
): Promise<{ platform: PostPlatform; language: Language }> {
  if (options.platform === undefined) {
    throw new CliError(
      "PLATFORM_REQUIRED",
      "Indica la red con --platform",
      `Redes: ${POST_PLATFORM_OPTION_NAMES.join(", ")}`,
    );
  }
  const platform = postPlatformOption(options.platform);
  if (options.language !== undefined)
    return { platform, language: languageOption(options.language) };
  const { contents } = await fetchPost(deps.client, postId);
  const languages = contents
    .filter((item) => item.platform === platform)
    .map((item) => item.language);
  const [only, ...others] = languages;
  if (only === undefined || others.length > 0) {
    throw new CliError(
      only === undefined ? "CONTENT_NOT_FOUND" : "LANGUAGE_REQUIRED",
      only === undefined
        ? `El post no tiene texto de ${PLATFORM_TEXT[platform] ?? platform}`
        : `${PLATFORM_TEXT[platform] ?? platform} tiene textos en ${languages.join(" y ")}: indica cuál con --language`,
      only === undefined ? `Pide los textos con agentsales post draft ${postId}` : undefined,
    );
  }
  return { platform, language: only };
}

export type PostEditOptions = {
  platform?: string;
  language?: string;
  file?: string;
  hashtags?: string;
  /** Las redes del post (`x,linkedin`, o `todas`), F9-T21. */
  platforms?: string;
  /** Mover la fecha planificada (`"AAAA-MM-DD HH:MM"`, o `ninguna`), F9-T21. */
  date?: string;
  /** El brief del operador (`""` lo borra), F9-T21. */
  brief?: string;
  /** La marca que permite un enlace en X (`--x-link` / `--no-x-link`), F9-T16. */
  xLink?: boolean;
  /** La música de sus videos (`--music <pista|ninguna>`), F9.5-T19. */
  music?: string;
};

/** `--platforms x,linkedin` → esas redes; `todas` → `null` (todas las de la marca). */
function platformsOption(text: string): PostPlatform[] | null {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 1 && ["todas", "all"].includes((parts[0] ?? "").toLowerCase())) return null;
  if (parts.length === 0) {
    throw new CliError(
      "PLATFORM_INVALID",
      `--platforms necesita una o más redes separadas por comas (${POST_PLATFORM_OPTION_NAMES.join(", ")}), o "todas"`,
    );
  }
  return [...new Set(parts.map((part) => postPlatformOption(part)))];
}

/** Lo que `post edit` cambia del post mismo (no de un texto); `null` si no cambia nada. */
function postChangesOf(options: PostEditOptions) {
  const changes: {
    platforms?: PostPlatform[] | null;
    plannedAt?: Date | null;
    brief?: string | null;
    xLinkAllowed?: boolean;
    musicTrackId?: MusicTrackId | null;
  } = {};
  if (options.platforms !== undefined) changes.platforms = platformsOption(options.platforms);
  if (options.date !== undefined) {
    changes.plannedAt = ["ninguna", "none", ""].includes(options.date.trim().toLowerCase())
      ? null
      : dateOption(options.date);
  }
  if (options.brief !== undefined) {
    changes.brief = options.brief.trim() === "" ? null : options.brief;
  }
  if (options.xLink !== undefined) changes.xLinkAllowed = options.xLink;
  if (options.music !== undefined) changes.musicTrackId = parseMusicTrack(options.music);
  return Object.keys(changes).length === 0 ? null : changes;
}

/** `--date "AAAA-MM-DD HH:MM"` en hora de Chile. */
function dateOption(text: string): Date {
  try {
    return atOption(text);
  } catch (error) {
    if (error instanceof CliError) {
      throw new CliError(error.code, error.message.replace(/^--at/, "--date"), error.hint);
    }
    throw error;
  }
}

/** Los hashtags de `--hashtags "#a #b"` o `"#a,#b"` (vacío los borra). */
const hashtagsOf = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");

/**
 * `agentsales post edit <id> --platform <red> [--language es|en] [--file <texto>] [--hashtags]`:
 * reemplaza el texto (desde `--file` o la entrada estándar) y muestra la revisión. Un texto aprobado
 * sin publicaciones activas pierde la aprobación (core).
 */
export function runPostEdit(deps: PostDeps, id: string, options: PostEditOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const postId = postIdOf(id);
    // F9-T21: las redes, la fecha o el brief del post (una idea se edita así antes de aceptarla).
    const changes = postChangesOf(options);
    const editsText =
      options.platform !== undefined ||
      options.file !== undefined ||
      options.hashtags !== undefined;
    if (changes !== null) {
      const { post } = await unwrap(
        deps.client.posts[":id"].$patch({ param: { id: postId }, json: changes }),
        postResponseSchema,
      ).catch((error: unknown) => {
        throw explained(error, postId);
      });
      const summary = [
        `redes: ${post.platforms === null ? "todas las de la marca" : post.platforms.map((platform) => PLATFORM_TEXT[platform] ?? platform).join(", ")}`,
        `fecha: ${post.plannedAt === null ? "sin fecha" : `${formatChileTime(post.plannedAt)} (Chile)`}`,
        ...(changes.brief === undefined
          ? []
          : [`brief: ${post.brief === null ? "sin brief" : "tuyo"}`]),
        ...(changes.xLinkAllowed === undefined
          ? []
          : [
              post.xLinkAllowed
                ? `enlace en X: permitido, cuesta ${X_LINK_COST_TEXT}`
                : "enlace en X: no permitido",
            ]),
        ...(changes.musicTrackId === undefined
          ? []
          : [`música: ${musicTrackText(post.musicTrackId)} (los videos se rehacen solos)`]),
      ];
      deps.print(`${c.green("✓")} Post ${post.id} actualizado (${summary.join(" · ")})`);
      if (!editsText) {
        deps.print(
          c.dim(
            post.status === "idea"
              ? `→ Acéptala con agentsales post accept ${post.id} o descártala con agentsales post discard ${post.id}`
              : `→ Míralo con ${show(post.id)}`,
          ),
        );
        return 0;
      }
    }
    const target = await textTarget(deps, postId, options);
    let body: string | undefined;
    if (options.file !== undefined) {
      const path = resolve(deps.cwd, options.file);
      body = await readFile(path, "utf8").catch(() => {
        throw new CliError("POST_FILE_NOT_FOUND", `No se pudo leer ${path}`);
      });
    } else if (!deps.stdinIsTty()) {
      const piped = await deps.readStdin();
      // Con --hashtags y una entrada estándar vacía (un script sin TTY), se editan solo los hashtags.
      if (piped.trim() !== "" || options.hashtags === undefined) body = piped;
    } else if (options.hashtags === undefined) {
      throw new CliError(
        "TEXT_REQUIRED",
        "Falta el texto nuevo",
        `Pásalo con --file <archivo> o por la entrada estándar: pbpaste | agentsales post edit ${postId} --platform ${platformShortName(target.platform)}`,
      );
    }
    if (body !== undefined) {
      body = body.trim();
      if (body === "") throw new CliError("TEXT_REQUIRED", "El texto nuevo está vacío");
      if ([...body].length > TEXT_MAX_CHARS) {
        throw new CliError("TEXT_TOO_LONG", `El texto pasa de ${TEXT_MAX_CHARS} caracteres`);
      }
    }
    const { content } = await unwrap(
      deps.client.posts[":id"].contents[":platform"][":language"].$patch({
        param: { id: postId, platform: target.platform, language: target.language },
        json: {
          ...(body === undefined ? {} : { body }),
          ...(options.hashtags === undefined ? {} : { hashtags: hashtagsOf(options.hashtags) }),
        },
      }),
      contentEditResponseSchema,
    ).catch((error: unknown) => {
      throw explained(error, postId);
    });
    deps.print(`${c.green("✓")} ${textName(content)} editado`);
    deps.print(renderPostContent(content, c));
    deps.print(
      c.dim(
        `→ Apruébalo con agentsales post approve ${postId} --platform ${platformShortName(target.platform)} --language ${target.language}`,
      ),
    );
    return 0;
  });
}

export type PostApproveOptions = { platform?: string; language?: string; undo?: boolean };

/**
 * `agentsales post approve <id> [--platform] [--language] [--undo]`: aprueba el texto vigente de
 * cada red e idioma (o de los pedidos) y abre sus publicaciones si la marca tiene la cuenta
 * conectada. Con `--undo`, quita la aprobación y descarta lo que no salió. Informa cada texto y
 * sale con 1 si alguno no se pudo.
 */
export function runPostApprove(deps: PostDeps, id: string, options: PostApproveOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const postId = postIdOf(id);
    const platform =
      options.platform === undefined ? undefined : postPlatformOption(options.platform);
    const language = options.language === undefined ? undefined : languageOption(options.language);
    const { post, contents } = await fetchPost(deps.client, postId);
    // Sin red pedida, al aprobar, solo las redes del post (F9-T21): los textos de una red quitada
    // no se aprueban (el servidor los rechazaría con POST_PLATFORM_EXCLUDED).
    const skippedExcluded =
      platform === undefined && !options.undo
        ? contents.filter(
            (item) =>
              !postPublishesOn(post, item.platform) &&
              (language === undefined || item.language === language),
          )
        : [];
    const chosen = contents.filter(
      (item) =>
        (platform === undefined || item.platform === platform) &&
        (language === undefined || item.language === language) &&
        // Sin red pedida, con --undo, solo los aprobados.
        !(platform === undefined && options.undo && item.status !== "approved") &&
        !skippedExcluded.includes(item),
    );
    if (skippedExcluded.length > 0) {
      const names = [
        ...new Set(skippedExcluded.map((item) => PLATFORM_TEXT[item.platform] ?? item.platform)),
      ];
      deps.printError(
        c.dim(
          `  Sin aprobar: ${names.join(", ")} ya no está entre las redes del post (agrégala con agentsales post edit ${postId} --platforms <redes>)`,
        ),
      );
    }
    if (chosen.length === 0 && skippedExcluded.length > 0) {
      throw new CliError(
        "POST_PLATFORM_EXCLUDED",
        "Los textos del post son de redes que ya no están entre las suyas",
        `Agrégalas con agentsales post edit ${postId} --platforms <redes>`,
      );
    }
    if (chosen.length === 0) {
      throw new CliError(
        "CONTENT_NOT_FOUND",
        options.undo && platform === undefined
          ? "El post no tiene textos aprobados"
          : "El post no tiene textos de esa red o idioma",
        `Mira sus textos con ${show(postId)}, o pídelos con agentsales post draft ${postId}`,
      );
    }
    let failed = 0;
    /** Las redes aprobadas con publicación abierta (con cuenta) y las que no tienen cuenta. */
    const withAccount = new Set<PostPlatform>();
    const withoutAccount = new Set<PostPlatform>();
    /** Las aprobadas con cuenta que esperan sus medios (F9.5-T21). */
    const withPendingMedia = new Set<PostPlatform>();
    for (const content of chosen) {
      const param = {
        param: {
          id: postId,
          platform: content.platform as PostPlatform,
          language: content.language,
        },
      };
      try {
        if (options.undo) {
          const result = await unwrap(
            deps.client.posts[":id"].contents[":platform"][":language"].unapprove.$post(param),
            contentUnapproveResponseSchema,
          );
          const cancelled =
            result.cancelled.length > 0 ? ` · descartadas: ${result.cancelled.length}` : "";
          deps.print(`${c.green("✓")} ${textName(content)}: aprobación quitada${cancelled}`);
        } else {
          const result = await unwrap(
            deps.client.posts[":id"].contents[":platform"][":language"].approve.$post(param),
            contentApproveResponseSchema,
          );
          // F9.5-T21: sin los medios del post (o mientras se procesan) el texto se aprueba igual,
          // pero todavía no abre publicaciones: la API lo dice (`mediaPending`); no es que falte
          // la cuenta.
          const mediaPending = result.mediaPending === true;
          const opened =
            result.created.length > 0
              ? ` · listas para publicar o programar: ${result.created.length}`
              : mediaPending
                ? c.yellow(
                    ` · los medios faltan o se están procesando: súbelos con agentsales post upload ${postId} <archivos…> o espera a que terminen`,
                  )
                : result.publications.length === 0
                  ? c.dim(" · sin cuenta conectada en esa red: conéctala (agentsales accounts)")
                  : "";
          if (mediaPending) {
            withPendingMedia.add(param.param.platform);
          } else if (
            result.created.length > 0 ||
            result.publications.length > 0 ||
            result.skipped.length > 0
          ) {
            withAccount.add(param.param.platform);
          } else {
            withoutAccount.add(param.param.platform);
          }
          deps.print(`${c.green("✓")} ${textName(content)}: aprobado${opened}`);
          for (const skipped of result.skipped) {
            deps.printError(
              c.yellow(
                `  Ya hay una publicación activa de un texto anterior (${skipped.publicationId}): descártala o retírala para publicar este`,
              ),
            );
          }
        }
      } catch (error) {
        failed += 1;
        const xLinkMissing = !options.undo && needsXLinkMark(post, content);
        deps.printError(
          `${c.red("✗")} ${textName(content)}: ${reasonOf(error, postId, xLinkMissing)}`,
        );
      }
    }
    if (!options.undo && failed < chosen.length) {
      // Sin ninguna red con cuenta, publicar daría ACCOUNT_NOT_CONNECTED: lo que sigue es conectar
      // (ensayo de la demo de F9). Los textos quedan aprobados y `post publish` abre después sus
      // publicaciones.
      const missing = [...withoutAccount].filter((platform) => !withAccount.has(platform));
      deps.print(
        c.dim(
          withAccount.size === 0 && withPendingMedia.size > 0
            ? `→ Sube los medios con agentsales post upload ${postId} <archivos…> (o espera a que se procesen); después publícalo con agentsales post publish ${postId} o prográmalo con agentsales post schedule ${postId}`
            : withAccount.size === 0 && missing.length > 0
              ? `→ Conecta la cuenta de ${missing.map((platform) => PLATFORM_TEXT[platform] ?? platform).join(", ")} (agentsales accounts); después publícalo con agentsales post publish ${postId} o prográmalo con agentsales post schedule ${postId}`
              : `→ Publica con agentsales post publish ${postId}, o prográmalo con agentsales post schedule ${postId} --at "AAAA-MM-DD HH:MM"`,
        ),
      );
    }
    return failed > 0 ? 1 : 0;
  });
}

// ── publish, schedule y archive ──────────────────────────────────────────

export type PostPublishOptions = { platform?: string; yes?: boolean; wait?: boolean };

/** Lo que se espera al publicar: las publicaciones que quedaron en curso. */
type PublishWait = { status: string; publications: PublicationView[] };

/**
 * `agentsales post publish <id> [--platform] [--yes] [--no-wait]`: publica una red del post (todos
 * sus idiomas) o, sin `--platform`, cada red con un texto aprobado. Con la API en vivo pregunta
 * antes (salvo `--yes`). Espera a que cada una salga, falle, quede a mano o con resultado dudoso.
 */
export function runPostPublish(deps: PostDeps, id: string, options: PostPublishOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const postId = postIdOf(id);
    let platforms: PostPlatform[];
    if (options.platform !== undefined) {
      platforms = [postPlatformOption(options.platform)];
    } else {
      const { post, contents } = await fetchPost(deps.client, postId);
      const approved = [
        ...new Set(
          contents
            .filter((item) => item.status === "approved")
            .map((item) => item.platform as PostPlatform),
        ),
      ];
      if (approved.length === 0) {
        throw new CliError(
          "CONTENT_NOT_APPROVED",
          "El post no tiene textos aprobados",
          `Apruébalos con agentsales post approve ${postId}`,
        );
      }
      // Sin --platform, solo las redes del post (F9-T21): un texto aprobado de una red que le
      // quitaron no se publica.
      platforms = approved.filter((platform) => postPublishesOn(post, platform));
      if (platforms.length === 0) {
        throw new CliError(
          "POST_PLATFORM_EXCLUDED",
          `Los textos aprobados son de redes que ya no están en el post (${approved.map((platform) => PLATFORM_TEXT[platform] ?? platform).join(", ")})`,
          `Agrégalas con agentsales post edit ${postId} --platforms <redes>, o aprueba el texto de otra red`,
        );
      }
    }
    const { publishMode } = await unwrap(deps.client.health.$get(), healthReportSchema);
    if (publishMode === "live" && !options.yes) {
      const names = platforms.map((platform) => PLATFORM_TEXT[platform] ?? platform).join(", ");
      const confirmed = await deps.confirm(
        `La API está en vivo (PUBLISH_MODE=live): ¿publicar el post de verdad en ${names}?`,
      );
      if (!confirmed) {
        deps.printError(c.yellow("No se publicó nada: confirma en la terminal o usa --yes"));
        return 1;
      }
    }
    const targets: PublicationView[] = [];
    let failed = 0;
    for (const platform of platforms) {
      try {
        const result = await unwrap(
          deps.client.posts[":id"].publish.$post({ param: { id: postId }, json: { platform } }),
          postPublishResponseSchema,
        );
        const started = [...result.started, ...result.requeued];
        targets.push(...started);
        deps.print(
          `Publicando en ${PLATFORM_TEXT[platform] ?? platform}: ${started.length} publicación(es)${result.requeued.length > 0 ? ` (${result.requeued.length} ya estaban en curso)` : ""}`,
        );
        for (const skipped of result.skipped) {
          // La activa del texto anterior viene en `publications`: con sus medios, «imagen» o «carrusel».
          const active = result.publications.find((p) => p.id === skipped.publicationId);
          const media = active === undefined ? null : active.mediaIds.length;
          deps.printError(
            c.yellow(
              `  ${publicationFormatText(platform, skipped.format, media)}: ya hay una publicación activa de un texto anterior (${skipped.publicationId}): descártala o retírala para publicar este`,
            ),
          );
        }
        if (result.stranded.length > 0) {
          deps.printError(
            c.yellow(
              `  ${result.stranded.length} pendiente(s) de una cuenta desconectada no se publican: descártalas o reconecta la cuenta`,
            ),
          );
        }
      } catch (error) {
        failed += 1;
        deps.printError(
          `${c.red("✗")} ${PLATFORM_TEXT[platform] ?? platform}: ${reasonOf(error, postId)}`,
        );
      }
    }
    if (targets.length === 0) return 1;
    if (options.wait === false) {
      for (const publication of targets) deps.print(publication.id);
      deps.printError(c.dim(`→ Revisa el resultado con: ${show(postId)}`));
      return failed > 0 ? 1 : 0;
    }
    const startedAt = new Map(targets.map((p) => [p.id, p.updatedAt.getTime()]));
    const snapshot = (publications: PublicationView[]): PublishWait => ({
      status: publications.some((p) => p.status === "publishing") ? "publishing" : "done",
      publications,
    });
    const done = await waitForRun<PublishWait>(deps, {
      run: snapshot(targets),
      fetch: async () =>
        snapshot(
          await Promise.all(
            targets.map(
              async (publication) =>
                (
                  await unwrap(
                    deps.client.publications[":id"].$get({ param: { id: publication.id } }),
                    publicationResponseSchema,
                  )
                ).publication,
            ),
          ),
        ),
      isTerminal: (wait) => wait.status === "done",
      progress: (wait) =>
        wait.publications
          .map(
            (p) =>
              `${PLATFORM_TEXT[p.platform] ?? p.platform} [${p.language}]: ${PUBLICATION_STATUS_TEXT[p.status] ?? p.status}`,
          )
          .join(" · "),
      isQueued: (wait) =>
        wait.publications.every(
          (p) => p.status === "publishing" && p.updatedAt.getTime() === startedAt.get(p.id),
        ),
      laterCommand: show(postId),
      noun: "la publicación",
      queuedText: PUBLICATION_QUEUED_WARNING_TEXT,
    });
    if (done === null) return 1;
    deps.print("");
    deps.print(renderPostPublications(done.publications, c));
    if (done.publications.every((p) => p.dryRun)) {
      deps.print(c.dim("  Simulación: no se envió nada a las redes"));
    }
    const bad = done.publications.filter(
      (p) => p.status === "failed" || p.status === "outcome_unknown",
    );
    return failed > 0 || bad.length > 0 ? 1 : 0;
  });
}

export type PostScheduleOptions = { at?: string; platform?: string[]; yes?: boolean };

/**
 * `agentsales post schedule <id> --at "AAAA-MM-DD HH:MM" [--platform …] [--yes]`: programa cada
 * red pedida (o cada una con texto aprobado y la cuenta conectada) a esa hora de Chile; en vivo
 * pregunta (a la hora se publica de verdad). Sale con 1 si alguna red no se pudo.
 */
export function runPostSchedule(deps: PostDeps, id: string, options: PostScheduleOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const postId = postIdOf(id);
    if (options.at === undefined) {
      throw new CliError("SCHEDULE_AT_REQUIRED", 'Falta --at "AAAA-MM-DD HH:MM" (hora de Chile)');
    }
    const at = atOption(options.at);
    const platforms = options.platform?.map((option) => postPlatformOption(option));
    const live = await confirmLive(deps, options.yes ?? false);
    if (live === null) return 1;
    const { results } = await unwrap(
      deps.client.posts[":id"].schedule.$post({
        param: { id: postId },
        json: {
          at: at.toISOString(),
          ...(platforms === undefined ? {} : { platforms: [...new Set(platforms)] }),
        },
      }),
      postScheduleResponseSchema,
    ).catch((error: unknown) => {
      throw explained(error, postId);
    });
    for (const row of results) {
      const name =
        row.platform === null ? "El post" : (PLATFORM_TEXT[row.platform] ?? row.platform);
      if (row.outcome === "scheduled") {
        const publications = row.publications ?? [];
        const languages = publications.map((p) => p.language).join(", ");
        const mode =
          publications[0] === undefined ? "" : ` (${publicationModeText(publications[0].dryRun)})`;
        deps.print(
          `${c.green("✓")} ${name}${languages === "" ? "" : ` [${languages}]`}: programada para ${formatChileTime(row.at ?? at)}${mode}`,
        );
      } else {
        deps.print(`${c.yellow("–")} ${name}: no se programó (${row.code}: ${row.message})`);
      }
    }
    if (live) deps.print(c.red("Programado EN VIVO: a la hora se publica de verdad"));
    deps.print(c.dim(`→ Míralo en agentsales agenda o ${show(postId)}`));
    return results.some((row) => row.outcome === "skipped") ? 1 : 0;
  });
}

// ── accept y discard (las ideas del plan, F9-T21) ─────────────────────────

export type PostAcceptOptions = { wait?: boolean };

/**
 * `agentsales post accept <id> [--wait]` (spec F9 §4.9, ADR-0030 punto 3): la idea pasa a borrador
 * y la IA redacta sus textos (`post.draft`, solo para sus redes). Sin `--wait` no espera (se
 * aceptan varias seguidas y los textos se miran con `post show`); con `--wait` espera **esa**
 * corrida, como `post draft` la suya, sin pedir otra. Nunca sugiere `post draft` para esperar: eso
 * pide textos nuevos y vuelve a gastar IA (ensayo de la demo de F9). Aprobar y programar siguen
 * siendo pasos aparte.
 */
export function runPostAccept(deps: PostDeps, id: string, options: PostAcceptOptions = {}) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const postId = postIdOf(id);
    const { post, contentRun, reused } = await unwrap(
      deps.client.posts[":id"].accept.$post({ param: { id: postId } }),
      ideaAcceptResponseSchema,
    ).catch((error: unknown) => {
      throw explained(error, postId);
    });
    deps.print(
      `${c.green("✓")} Idea aceptada: "${post.topic}" (${POST_STATUS_TEXT[post.status] ?? post.status})`,
    );
    if (options.wait === true) {
      if (reused)
        deps.printError(c.yellow("Ya había textos en preparación para este post: sigo esos"));
      return waitForDraft(deps, contentRun, post.id);
    }
    deps.print(
      `  La IA redacta sus textos (${contentRun.id}${reused ? ", ya estaba en curso" : ""}): ${contentRunProgressText(contentRun)}`,
    );
    deps.print(
      c.dim(
        `→ Míralos cuando terminen con ${show(post.id)} (para esperarlos al aceptar, usa agentsales post accept <id> --wait); luego los apruebas y programas (no se publica sola)`,
      ),
    );
    return 0;
  });
}

/** `agentsales post discard <id>`: descarta una idea (no se vuelve a proponer en 60 días). */
export function runPostDiscard(deps: PostDeps, id: string) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const postId = postIdOf(id);
    const { post } = await unwrap(
      deps.client.posts[":id"].discard.$post({ param: { id: postId } }),
      postResponseSchema,
    ).catch((error: unknown) => {
      throw explained(error, postId);
    });
    deps.print(
      `${c.green("✓")} Idea descartada: "${post.topic}" (el plan no la vuelve a proponer en 60 días)`,
    );
    return 0;
  });
}

/** `agentsales post archive <id>`: lo descarta o lo da por terminado (ya no se programa). */
export function runPostArchive(deps: PostDeps, id: string) {
  const c = deps.colors;
  return guarded(deps, async () => {
    const postId = postIdOf(id);
    const { post } = await unwrap(
      deps.client.posts[":id"].archive.$post({ param: { id: postId } }),
      postResponseSchema,
    ).catch((error: unknown) => {
      throw explained(error, postId);
    });
    deps.print(`${c.green("✓")} Post ${post.id} archivado: "${post.topic}"`);
    return 0;
  });
}

export function register(program: Command, ctx: CliContext): void {
  const deps = (): PostDeps => ({
    ...ctx,
    client: ctx.api(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => performance.now(),
  });
  const networks = POST_PLATFORM_OPTION_NAMES.join(", ");
  const post = program
    .command("post")
    .description(
      "Posts de una marca: crear, subir medios, pedir textos, aprobar, publicar o programar",
    );
  post
    .command("create")
    .description("Crea un post en borrador con tu brief")
    .argument("<tema>", "de qué trata el post")
    .option("--brief <texto>", "lo que la IA puede usar y afirmar (además del perfil de la marca)")
    .option("--kind <tipo>", `tipo: ${POST_KINDS.join(", ")} (por defecto texto)`)
    .option("--pillar <línea>", "el tema de la marca del perfil editorial (su clave)")
    .option("--date <hora>", 'fecha planificada en hora de Chile: "AAAA-MM-DD HH:MM"')
    .option("--broker <slug>", "la marca (si ves más de una)")
    .action((topic: string, options: PostCreateOptions) =>
      exitWith(() => runPostCreate(deps(), topic, options)),
    );
  post
    .command("list")
    .description("Los posts de tus marcas")
    .option("--broker <slug>", "solo los de una marca")
    .option("--status <estado>", `solo un estado: ${POST_STATUSES.join(", ")}`)
    .option("--from <día>", "con fecha planificada desde ese día (AAAA-MM-DD, Chile)")
    .option("--to <día>", "hasta ese día, incluido (AAAA-MM-DD, Chile)")
    .option("--json", "salida en JSON")
    .action((options: PostListOptions) => exitWith(() => runPostList(deps(), options)));
  post
    .command("show")
    .description("Un post: estado, medios, textos por red e idioma con su revisión y publicaciones")
    .argument("<id>", "id del post (agentsales post list)")
    .option("--json", "salida en JSON")
    .action((id: string, options: { json?: boolean }) =>
      exitWith(() => runPostShow(deps(), id, options)),
    );
  post
    .command("upload")
    .description("Sube fotos o videos al post, directo a R2 (jpg, png, webp, heic, mp4 o mov)")
    .argument("<id>", "id del post")
    .argument("<archivos...>", "los archivos")
    .action((id: string, files: string[]) => exitWith(() => runPostUpload(deps(), id, files)));
  // F9.5-T25: conseguir imágenes (tarjetas, biblioteca o IA).
  registerPostMedia(post, ctx);
  post
    .command("draft")
    .description("Pide a la IA un texto por red e idioma y espera")
    .argument("<id>", "id del post")
    .option("--replace-edits", "reemplaza también los textos editados a mano o aprobados")
    .option("--no-wait", "imprime el id de la corrida y sale sin esperar")
    .action((id: string, options: PostDraftOptions) =>
      exitWith(() => runPostDraft(deps(), id, options)),
    );
  post
    .command("edit")
    .description(
      "Cambia el texto de una red e idioma (desde --file o la entrada estándar), o las redes, la fecha, el brief, el enlace en X o la música del post",
    )
    .argument("<id>", "id del post")
    .option("--platform <red>", `la red del texto: ${networks}`)
    .option("--language <idioma>", "es o en (si la red tiene los dos)")
    .option("--file <archivo>", "el texto nuevo (si no, se lee de la entrada estándar)")
    .option("--hashtags <lista>", 'los hashtags, separados por espacios o comas ("" los borra)')
    .option(
      "--platforms <redes>",
      `las redes del post, separadas por comas (${networks}), o "todas" (las de la marca)`,
    )
    .option("--date <hora>", 'mueve la fecha planificada: "AAAA-MM-DD HH:MM" (Chile), o "ninguna"')
    .option("--brief <texto>", 'el brief del post (pasa a ser tuyo; "" lo borra)')
    .option(
      "--x-link",
      `permite un enlace en el texto de X (cuesta ${X_LINK_COST_TEXT}; el enlace también va en el brief)`,
    )
    .option("--no-x-link", "quita el permiso del enlace en X")
    .option("--music <pista>", `la música de sus videos: ${MUSIC_TRACK_IDS.join(", ")} o ninguna`)
    .action((id: string, options: PostEditOptions) =>
      exitWith(() => runPostEdit(deps(), id, options)),
    );
  post
    .command("approve")
    .description("Aprueba los textos del post (o quita la aprobación con --undo)")
    .argument("<id>", "id del post")
    .option("--platform <red>", `solo una red: ${networks}`)
    .option("--language <idioma>", "solo un idioma: es o en")
    .option("--undo", "quita la aprobación y descarta las publicaciones que no salieron")
    .action((id: string, options: PostApproveOptions) =>
      exitWith(() => runPostApprove(deps(), id, options)),
    );
  post
    .command("publish")
    .description("Publica el post ahora y espera (en vivo pide confirmación)")
    .argument("<id>", "id del post")
    .option("--platform <red>", `solo una red: ${networks} (sin ella, cada red con texto aprobado)`)
    .option("--no-wait", "imprime los ids de las publicaciones y sale sin esperar")
    .option("--yes", "no pide confirmación con la API en vivo")
    .action((id: string, options: PostPublishOptions) =>
      exitWith(() => runPostPublish(deps(), id, options)),
    );
  post
    .command("schedule")
    .description('Programa el post a una hora de Chile (--at "2026-10-21 10:00")')
    .argument("<id>", "id del post")
    .option("--at <hora>", 'hora de Chile: "AAAA-MM-DD HH:MM"')
    .option(
      "--platform <red>",
      `solo esas redes: ${networks} (repetible o separado por comas)`,
      collect,
    )
    .option("--yes", "no pide confirmación en vivo")
    .action((id: string, options: PostScheduleOptions) =>
      exitWith(() => runPostSchedule(deps(), id, options)),
    );
  post
    .command("accept")
    .description("Acepta una idea del plan: pasa a borrador y la IA redacta sus textos")
    .argument("<id>", "id de la idea (agentsales plan show <plan>)")
    .option("--wait", "espera los textos de esta aceptación y muestra su revisión")
    .action((id: string, options: PostAcceptOptions) =>
      exitWith(() => runPostAccept(deps(), id, options)),
    );
  post
    .command("discard")
    .description("Descarta una idea del plan (no se vuelve a proponer en 60 días)")
    .argument("<id>", "id de la idea (agentsales plan show <plan>)")
    .action((id: string) => exitWith(() => runPostDiscard(deps(), id)));
  post
    .command("archive")
    .description("Archiva un post (descartado o terminado: ya no se programa)")
    .argument("<id>", "id del post")
    .action((id: string) => exitWith(() => runPostArchive(deps(), id)));
}
