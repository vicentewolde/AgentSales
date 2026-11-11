import type { ContentView, PostJson, PostPublicationView } from "@agentsales/api/contracts";
import {
  formatChileDayTime,
  LANGUAGE_TEXT,
  PLATFORM_TEXT,
  type PostPlatform,
  postPublishesOn,
} from "@agentsales/core";
import { Badge } from "../ui/Badge.js";
import { Card } from "../ui/Card.js";
import type { BadgeTone } from "../ui/styles.js";
import { HelpDot } from "../ui/Tip.js";
import { type PostContentView, postContents } from "./labels.js";

/** Una fila del resumen: un texto (red e idioma), si se publica y en qué punto va. */
export type SummaryRow = {
  key: string;
  platform: PostPlatform;
  language: PostContentView["language"];
  /** `false`: este texto no sale (sin aprobar, o la red ya no es del post). */
  publishes: boolean;
  tone: BadgeTone;
  state: string;
  detail: string | null;
};

/** La publicación de un texto: la que fijó ese texto o, si no, la última de su red e idioma. */
function publicationOf(
  content: PostContentView,
  publications: readonly PostPublicationView[],
): PostPublicationView | undefined {
  const live = publications.filter((publication) => publication.status !== "cancelled");
  return (
    live.find((publication) => publication.contentId === content.id) ??
    live.find(
      (publication) =>
        publication.platform === content.platform && publication.language === content.language,
    )
  );
}

/**
 * Qué pasa con cada texto del post (red e idioma): si se va a publicar, cuándo y en qué punto va.
 * Las filas que salen van primero, por red; las que no, al final. Función pura: el panel solo la pinta.
 */
export function summaryRows(
  post: Pick<PostJson, "platforms">,
  contents: readonly ContentView[],
  publications: readonly PostPublicationView[],
  now: Date = new Date(),
): SummaryRow[] {
  const rows = postContents(contents).map((content): SummaryRow => {
    const base = {
      key: `${content.platform}:${content.language}`,
      platform: content.platform,
      language: content.language,
    };
    if (!postPublishesOn(post, content.platform)) {
      return {
        ...base,
        publishes: false,
        tone: "muted",
        state: "No se publica",
        detail: "esta red no está entre las del post",
      };
    }
    const publication = publicationOf(content, publications);
    if (publication !== undefined) {
      const sim = publication.dryRun ? " (simulación)" : "";
      switch (publication.status) {
        case "published":
          return {
            ...base,
            publishes: true,
            tone: "success",
            state: "Publicado",
            detail:
              publication.publishedAt === null
                ? null
                : `${formatChileDayTime(publication.publishedAt, now)}${sim}`,
          };
        case "scheduled":
          return {
            ...base,
            publishes: true,
            tone: "info",
            state: "Programado",
            detail:
              publication.scheduledAt === null
                ? null
                : `${formatChileDayTime(publication.scheduledAt, now)}${sim}`,
          };
        case "awaiting_manual_confirm":
          return {
            ...base,
            publishes: true,
            tone: "warning",
            state: "Te toca publicarlo a mano",
            detail: "cuando lo hagas, toca «Ya lo publiqué»",
          };
        case "publishing":
          return { ...base, publishes: true, tone: "info", state: "Publicándose…", detail: null };
        case "failed":
          return {
            ...base,
            publishes: true,
            tone: "danger",
            state: "Falló",
            detail: "mira Publicaciones más abajo",
          };
        case "outcome_unknown":
          return {
            ...base,
            publishes: true,
            tone: "warning",
            state: "Resultado dudoso",
            detail: "mira la red y dinos si salió",
          };
        default:
          break;
      }
    }
    return content.status === "approved"
      ? {
          ...base,
          publishes: true,
          tone: "warning",
          state: "Aprobado, falta programarlo",
          detail: "usa «Programar…» a la derecha",
        }
      : {
          ...base,
          publishes: false,
          tone: "muted",
          state: "No se publica",
          detail: "falta aprobar este texto",
        };
  });
  return [...rows.filter((row) => row.publishes), ...rows.filter((row) => !row.publishes)];
}

/**
 * «Qué se publica»: una línea por red e idioma que dice si ese texto sale, cuándo y en qué punto
 * va, para saber de un vistazo qué vale la pena editar. Cada red se programa por separado: puedes
 * publicar en X hoy y en Instagram días después.
 */
export function PostSummary({
  post,
  contents,
  publications,
}: {
  post: Pick<PostJson, "platforms">;
  contents: readonly ContentView[];
  publications: readonly PostPublicationView[];
}) {
  const rows = summaryRows(post, contents, publications);
  if (rows.length === 0) return null;
  const publishing = rows.filter((row) => row.publishes);
  return (
    <Card
      as="section"
      aria-label="Qué se publica"
      title={
        <>
          Qué se publica{" "}
          <HelpDot
            label="Cómo leer este resumen"
            text="Cada línea es un texto (una red en un idioma). «Se publica» significa que está aprobado y va a salir. Lo que dice «No se publica» no sale hasta que lo apruebes, así que no hace falta editarlo. Cada red se programa por separado: puedes dejar X para hoy e Instagram para días después."
          />
        </>
      }
      description={
        publishing.length === 0
          ? "Todavía nada está aprobado: aprueba un texto para que pueda publicarse."
          : `${publishing.length} de ${rows.length} textos van a salir.`
      }
    >
      <ul className="divide-y divide-line-soft">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm first:pt-0 last:pb-0"
          >
            <span className={`w-40 font-semibold ${row.publishes ? "text-fg" : "text-fg-muted"}`}>
              {PLATFORM_TEXT[row.platform]} · {LANGUAGE_TEXT[row.language]}
            </span>
            <Badge tone={row.tone}>{row.state}</Badge>
            {row.detail !== null && (
              <span className="text-fg-muted tabular-nums">{row.detail}</span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
