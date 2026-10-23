import { inScope } from "../access.js";
import { chileDateOf, chileDateStart, formatChileTime } from "../chile-time.js";
import {
  isPostPlatform,
  LANGUAGES,
  type Language,
  POST_PLATFORMS,
  type PostPlatform,
} from "../enums.js";
import { AppError, isAppError } from "../errors.js";
import { assertCan, scopeOf } from "../permissions.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { ContentRepository } from "../ports/content-repository.js";
import type { PostRepository } from "../ports/post-repository.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import { canDraftPost, type Post } from "../post.js";
import type { Publication, PublicationActor } from "../publication.js";
import { addDays, weekOf } from "../social/plan-slots.js";
import { postPublishesOn } from "../social/post-networks.js";
import { postSubject } from "../subject.js";
import type { SubjectLocks } from "../subject-lock.js";
import type { User } from "../user.js";
import { type ApproveContentDeps, approveContent } from "./approve-content.js";
import { type GetPostContentDeps, getPostContent, type PostContent } from "./get-post-content.js";
import { schedulePost } from "./schedule-publications.js";

// «Aprobar la semana» (F9.5-T27): las ideas aceptadas de una semana de una marca, con sus textos
// por red, se aprueban y se programan **de una vez**, cada post a su fecha (la de la ranura de la
// cadencia que le dio el plan, ADR-0034). Nunca publica en el momento: programar exige la hora en
// el futuro (`SCHEDULE_TOO_SOON`) y lo programado lo dispara el reloj a su hora. Lo que no se pudo
// vuelve con su motivo, post por post y red por red.

type Actor = Pick<User, "id" | "role" | "brokerId">;

/** Una semana de lunes a domingo (hora de Chile), por su lunes, y su rango `[from, to)`. */
export type PostWeekRange = { week: string; lastDay: string; from: Date; to: Date };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * La semana de un día (`AAAA-MM-DD`, cualquiera de la semana): su lunes, su domingo y su rango.
 * `WEEK_INVALID` (400) si el día no tiene esa forma o no existe.
 */
export function postWeekRange(day: string): PostWeekRange {
  const invalid = () =>
    new AppError(
      "WEEK_INVALID",
      `La semana se pide con un día "AAAA-MM-DD": "${day.slice(0, 20)}"`,
    );
  if (!DAY.test(day)) throw invalid();
  const parsed = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) throw invalid();
  const week = weekOf(day);
  const next = addDays(week, 7);
  return { week, lastDay: addDays(week, 6), from: chileDateStart(week), to: chileDateStart(next) };
}

/** Sin día pedido, la semana de mañana (hora de Chile): el domingo da la que empieza. */
export const defaultWeekDay = (now: Date): string => addDays(chileDateOf(now), 1);

/** El corredor o la marca, si el usuario lo ve y puede `posts.manage` (lo ajeno no existe). */
async function requireBrand(
  deps: { brokers: Pick<BrokerRepository, "findById"> },
  actor: Actor,
  brokerId: string,
) {
  const notFound = new AppError("BROKER_NOT_FOUND", `No existe el corredor ${brokerId}`, {
    details: { id: brokerId },
  });
  if (!inScope(scopeOf(actor), brokerId)) throw notFound;
  assertCan(actor, "posts.manage", brokerId);
  const broker = await deps.brokers.findById(brokerId);
  if (broker === null) throw notFound;
  return broker;
}

/** Un post con fecha: los de la semana siempre la tienen (la consulta filtra por `planned_at`). */
type DatedPost = Post & { plannedAt: Date };
const isDated = (post: Post): post is DatedPost => post.plannedAt !== null;

/** Los posts de la semana: los aceptados (borrador o listos) y cuántas ideas siguen sin decidir. */
async function weekPosts(
  deps: { posts: Pick<PostRepository, "list"> },
  actor: Actor,
  brokerId: string,
  range: PostWeekRange,
): Promise<{ accepted: DatedPost[]; ideas: number }> {
  const all = await deps.posts.list(
    { brokerId, status: ["idea", "draft", "ready"], from: range.from, to: range.to },
    scopeOf(actor),
  );
  const sorted = all
    .filter(isDated)
    .sort((a, b) => a.plannedAt.getTime() - b.plannedAt.getTime() || a.id.localeCompare(b.id));
  return {
    accepted: sorted.filter((post) => canDraftPost(post.status)),
    ideas: sorted.filter((post) => post.status === "idea").length,
  };
}

export type PostWeekDeps = GetPostContentDeps & {
  posts: Pick<PostRepository, "get" | "list">;
  now?: () => Date;
};

export type PostWeek = PostWeekRange & {
  /** Los posts aceptados de la semana, por fecha, con sus textos (y su revisión) y publicaciones. */
  posts: PostContent[];
  /** Las ideas de la semana que siguen sin aceptar ni descartar (no entran al aprobar la semana). */
  ideas: number;
};

/**
 * Lo que «Aprobar la semana» va a mirar (`GET /brokers/:id/week`): los posts aceptados de la
 * semana de `day` (sin él, la de mañana), con su fecha, sus textos por red e idioma con la revisión y sus publicaciones.
 * Lo ajeno no existe (`BROKER_NOT_FOUND`); sin `posts.manage`, `FORBIDDEN`.
 */
export async function getPostWeek(
  deps: PostWeekDeps,
  actor: Actor,
  { brokerId, day }: { brokerId: string; day?: string | undefined },
): Promise<PostWeek> {
  const range = postWeekRange(day ?? defaultWeekDay((deps.now ?? (() => new Date()))()));
  await requireBrand(deps, actor, brokerId);
  const { accepted, ideas } = await weekPosts(deps, actor, brokerId, range);
  const posts: PostContent[] = [];
  for (const post of accepted) posts.push(await getPostContent(deps, actor, post.id));
  return { ...range, posts, ideas };
}

/**
 * Por qué no se pudo una red de un post:
 * - `no_texts`: la IA todavía no redacta sus textos (o los está redactando: `CONTENT_RUN_ACTIVE`);
 * - `text_errors`: la revisión encontró errores (se corrigen en el post);
 * - `media_missing`: faltan la imagen o el video (o se están procesando, F9.5-T21);
 * - `account_missing`: la marca no tiene la cuenta conectada;
 * - `date`: la fecha ya pasó, está muy cerca o muy lejos;
 * - `nothing_left`: ya está publicado o publicándose;
 * - `other`: otro motivo (va su código y mensaje).
 */
export const WEEK_PROBLEM_KINDS = [
  "no_texts",
  "text_errors",
  "media_missing",
  "account_missing",
  "date",
  "nothing_left",
  "other",
] as const;
export type WeekProblemKind = (typeof WEEK_PROBLEM_KINDS)[number];

const KIND_OF_CODE: Readonly<Record<string, WeekProblemKind>> = {
  POST_NO_TEXTS: "no_texts",
  CONTENT_RUN_ACTIVE: "no_texts",
  CONTENT_HAS_ERRORS: "text_errors",
  X_LINK_NOT_ALLOWED: "text_errors",
  CONTENT_NOT_READY: "media_missing",
  ACCOUNT_NOT_CONNECTED: "account_missing",
  SCHEDULE_TOO_SOON: "date",
  SCHEDULE_TOO_FAR: "date",
  SCHEDULE_AT_INVALID: "date",
  NOTHING_TO_PUBLISH: "nothing_left",
};

export const weekProblemKind = (code: string): WeekProblemKind => KIND_OF_CODE[code] ?? "other";

/** Cada motivo en palabras y qué hacer (la CLI y el panel). */
export const WEEK_PROBLEM_TEXT: Readonly<Record<WeekProblemKind, { text: string; hint: string }>> =
  {
    no_texts: {
      text: "Sin textos todavía",
      hint: "Si la IA está redactando, espera a que termine; si no, pídelos en el post. Después vuelve a aprobar la semana.",
    },
    text_errors: {
      text: "El texto tiene errores",
      hint: "Corrígelo en el post y vuelve a aprobar la semana.",
    },
    media_missing: {
      text: "Falta la imagen o el video",
      hint: "Súbela o consíguela en el post; el texto ya quedó aprobado.",
    },
    account_missing: {
      text: "Sin cuenta conectada",
      hint: "Conéctala en Cuentas; el texto ya quedó aprobado.",
    },
    date: {
      text: "La fecha no sirve",
      hint: "Mueve la fecha del post a más adelante, o publícalo tú desde el post.",
    },
    nothing_left: { text: "Ya salió o está saliendo", hint: "" },
    other: { text: "No se pudo", hint: "" },
  };

export type WeekProblem = {
  /** La red, o `null` si es del post entero. */
  platform: PostPlatform | null;
  /** El idioma, si es de un texto. */
  language: Language | null;
  kind: WeekProblemKind;
  code: string;
  message: string;
};

/**
 * Una red que «Aprobar la semana» no tocó porque ya tiene algo del operador (F9.5-T27): repetirla
 * nunca pisa lo que él hizo.
 * - `scheduled`: ya está programada (aunque sea a otra hora: el operador pudo moverla);
 * - `failed`: falló; se reintenta con su comando, no aquí;
 * - `unscheduled`: el operador la desprogramó; se vuelve a programar con su comando.
 */
export type WeekKept = {
  platform: PostPlatform;
  publicationId: string;
  status: "scheduled" | "failed" | "unscheduled";
  /** La hora a la que está programada (solo `scheduled`). */
  at: Date | null;
  message: string;
  /** El comando para reintentarla o programarla (`null` en `scheduled`). */
  command: string | null;
};

export type WeekPostResult = {
  postId: string;
  topic: string;
  plannedAt: Date;
  /** Los textos que quedaron aprobados (ya lo estaban o se aprobaron ahora). */
  approved: { platform: PostPlatform; language: Language }[];
  /** Las redes que quedaron programadas, a la fecha del post, con sus publicaciones. */
  scheduled: { platform: PostPlatform; at: Date; publicationIds: string[] }[];
  /** Las redes que ya tenían algo del operador y no se tocaron. */
  kept: WeekKept[];
  problems: WeekProblem[];
};

export type ApprovePostWeekResult = PostWeekRange & {
  posts: WeekPostResult[];
  ideas: number;
};

export type ApprovePostWeekDeps = ApproveContentDeps &
  SubjectLocks & {
    brokers: Pick<BrokerRepository, "findById">;
    posts: Pick<PostRepository, "get" | "list">;
    contents: Pick<ContentRepository, "get" | "listCurrent">;
    /** Lo que ya hizo el operador en cada red (programar, desprogramar, reintentar): no se pisa. */
    publications: Pick<PublicationRepository, "listBySubject" | "listEvents">;
    now?: () => Date;
  };

/**
 * Lo que el operador ya hizo en una red del post y la semana no debe pisar: una publicación
 * programada (a la hora que sea), una fallida o una que él desprogramó (volvió de `scheduled` a
 * `approved`). La primera que encuentra, o `null` si la red se puede programar.
 */
async function keptOf(
  deps: Pick<ApprovePostWeekDeps, "publications">,
  publications: readonly Publication[],
  platform: PostPlatform,
): Promise<WeekKept | null> {
  const own = publications.filter((publication) => publication.platform === platform);
  const scheduled = own.find((publication) => publication.status === "scheduled");
  if (scheduled?.scheduledAt != null) {
    return {
      platform,
      publicationId: scheduled.id,
      status: "scheduled",
      at: scheduled.scheduledAt,
      message: `Ya está programado para el ${formatChileTime(scheduled.scheduledAt)} (hora de Chile): no se cambia`,
      command: null,
    };
  }
  const failed = own.find((publication) => publication.status === "failed");
  if (failed !== undefined) {
    return {
      platform,
      publicationId: failed.id,
      status: "failed",
      at: null,
      message: "Falló: no se reintenta sola; reinténtala tú cuando esté lista",
      command: `pnpm -s cli publications retry ${failed.id}`,
    };
  }
  for (const publication of own.filter((item) => item.status === "approved")) {
    const events = await deps.publications.listEvents(publication.id);
    const last = events.filter((event) => event.toStatus === "approved").at(-1);
    if (last?.fromStatus === "scheduled") {
      return {
        platform,
        publicationId: publication.id,
        status: "unscheduled",
        at: null,
        message: "La desprogramaste: queda aprobada, sin hora",
        command: `pnpm -s cli schedule --publication ${publication.id} --at "AAAA-MM-DD HH:MM"`,
      };
    }
  }
  return null;
}

/** Un error que no es del pedido (la base, la red) corta todo: lo hecho queda escrito. */
const asProblem = (
  error: unknown,
  where: { platform: PostPlatform | null; language: Language | null },
): WeekProblem => {
  if (!isAppError(error) || error.retriable) throw error;
  return { ...where, kind: weekProblemKind(error.code), code: error.code, message: error.message };
};

/**
 * «Aprobar la semana» (`POST /brokers/:id/week/approve`, F9.5-T27): para cada post aceptado de la
 * semana de `day`, en orden de fecha, aprueba cada texto vigente de sus redes que no tenga errores
 * (`approveContent`, el mismo de aprobar uno; idempotente) y programa las redes aprobadas a la
 * fecha del post (`schedulePost`, con las mismas revisiones de programar uno: cuenta conectada,
 * medios, hora en el futuro). **Nunca publica en el momento.** El modo (`dryRun`) lo pone quien
 * llama: el de la marca (ADR-0036). Un post o una red que no se puede no corta el resto: queda en
 * `problems` con su motivo. **Nunca pisa lo que hizo el operador:** una red ya programada (a la hora
 * que sea), fallida o que él desprogramó no se toca y va en `kept`, con su estado y su comando. Un
 * error reintentable (la base) corta el pedido con lo ya hecho escrito; repetirlo es seguro.
 */
export async function approvePostWeek(
  deps: ApprovePostWeekDeps,
  actor: Actor,
  {
    brokerId,
    day,
    dryRun,
    by,
  }: { brokerId: string; day?: string | undefined; dryRun: boolean; by: PublicationActor },
): Promise<ApprovePostWeekResult> {
  // Un solo reloj para toda la semana (como `scheduleListings`).
  const now = (deps.now ?? (() => new Date()))();
  const range = postWeekRange(day ?? defaultWeekDay(now));
  await requireBrand(deps, actor, brokerId);
  const fixed = { ...deps, now: () => now };
  const { accepted, ideas } = await weekPosts(deps, actor, brokerId, range);
  const posts: WeekPostResult[] = [];
  for (const post of accepted) {
    const { plannedAt } = post;
    const result: WeekPostResult = {
      postId: post.id,
      topic: post.topic,
      plannedAt,
      approved: [],
      scheduled: [],
      kept: [],
      problems: [],
    };
    posts.push(result);
    // En el orden de las redes y de los idiomas, como los muestra el post.
    const texts = (await deps.contents.listCurrent(postSubject(post.id)))
      .filter(
        (content) => isPostPlatform(content.platform) && postPublishesOn(post, content.platform),
      )
      .sort(
        (a, b) =>
          (POST_PLATFORMS as readonly string[]).indexOf(a.platform) -
            (POST_PLATFORMS as readonly string[]).indexOf(b.platform) ||
          LANGUAGES.indexOf(a.language) - LANGUAGES.indexOf(b.language),
      );
    if (texts.length === 0) {
      result.problems.push({
        platform: null,
        language: null,
        kind: "no_texts",
        code: "POST_NO_TEXTS",
        message:
          "Sin textos todavía: espera a que la IA los redacte (o pídelos en el post) y vuelve a aprobar la semana",
      });
      continue;
    }
    for (const content of texts) {
      const platform = content.platform as PostPlatform;
      try {
        await approveContent(deps, { contentId: content.id, actor: by });
        result.approved.push({ platform, language: content.language });
      } catch (error) {
        result.problems.push(asProblem(error, { platform, language: content.language }));
      }
    }
    const existing = await deps.publications.listBySubject(postSubject(post.id));
    const platforms: PostPlatform[] = [];
    for (const platform of new Set(result.approved.map((text) => text.platform))) {
      const kept = await keptOf(deps, existing, platform);
      if (kept === null) platforms.push(platform);
      else result.kept.push(kept);
    }
    if (platforms.length === 0) continue;
    try {
      const { results } = await schedulePost(fixed, {
        postId: post.id,
        platforms,
        at: plannedAt,
        dryRun,
        actor: by,
      });
      for (const row of results) {
        const platform =
          row.platform !== null && isPostPlatform(row.platform) ? row.platform : null;
        if (row.outcome === "scheduled" && platform !== null) {
          result.scheduled.push({
            platform,
            at: row.at,
            publicationIds: row.publications.map((publication) => publication.id),
          });
        } else if (row.outcome === "skipped") {
          result.problems.push({
            platform,
            language: null,
            kind: weekProblemKind(row.code),
            code: row.code,
            message: row.message,
          });
        }
      }
    } catch (error) {
      result.problems.push(asProblem(error, { platform: null, language: null }));
    }
  }
  return { ...range, posts, ideas };
}
