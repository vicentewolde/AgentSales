import type {
  ContentView,
  PlatformAccountView,
  PostJson,
  PostPublicationView,
  PostScheduleResponse,
  PublicationView,
} from "@agentsales/api/contracts";
import {
  accountOwnedBy,
  confirmsWithoutUrl,
  formatChileDayTime,
  LANGUAGE_TEXT,
  PLATFORM_TEXT,
  type PostPlatform,
  type PublishMode,
  postPublishesOn,
  publicationFormatText,
} from "@agentsales/core";
import { useId, useState } from "react";
import { Link } from "react-router";
import { useAccounts } from "../../queries/accounts.js";
import { usePostPublicationAction, usePublishPost, useSchedulePost } from "../../queries/posts.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { ErrorLine } from "../ErrorLine.js";
import { OutcomeBox } from "../publications/OutcomeBox.js";
import { PublicationMode } from "../publications/PublicationMode.js";
import {
  platformsToPublish,
  publicationModeOf,
  publishButtonText,
  safeExternalUrl,
} from "../publications/publications.js";
import { ScheduleForm } from "../publications/ScheduleForm.js";
import { PublicationStatusBadge } from "../StatusBadge.js";
import { Button } from "../ui/Button.js";
import { Input } from "../ui/Field.js";
import { HandAssist } from "./HandAssist.js";
import { isHandPlatform } from "./hand.js";
import { LiveConfirmButton } from "./LiveConfirm.js";
import { postContents } from "./labels.js";
import {
  CONFIRMED_WITHOUT_LINK_TEXT,
  confirmedWithoutLink,
  linkedinDownloads,
} from "./linkedin.js";
import { GET_IMAGE_ANCHOR, POST_MEDIA_ANCHOR } from "./media-anchor.js";
import {
  defaultChosen,
  languagesByPlatform,
  MIN_SPACING_MINUTES,
  ONE_PER_NETWORK_TEXT,
  type PublishRow,
  platformsWithSeveral,
  publishRows,
  SUGGESTED_SPACING_MINUTES,
} from "./publish-choice.js";

/**
 * Las redes con al menos un texto aprobado, en el orden de los textos (el de la API). Con el post,
 * solo las que están entre sus redes (`postPublishesOn`, F9-T21): una red quitada no se ofrece.
 */
export function approvedPlatforms(
  contents: readonly ContentView[],
  post?: Pick<PostJson, "platforms">,
): PostPlatform[] {
  const platforms: PostPlatform[] = [];
  for (const content of postContents(contents)) {
    const { platform } = content;
    if (content.status !== "approved" || platforms.includes(platform)) continue;
    if (post !== undefined && !postPublishesOn(post, platform)) continue;
    platforms.push(platform);
  }
  return platforms;
}

/**
 * Las redes que no tienen una cuenta conectada de la marca del post (ensayo de la demo de F9;
 * `accountOwnedBy`, F9.5-T12): publicarlas o programarlas daría `ACCOUNT_NOT_CONNECTED`.
 * Mientras no se saben las cuentas (`undefined`), ninguna: el panel no esconde nada que la API
 * podría aceptar.
 */
export function platformsWithoutAccount(
  platforms: readonly PostPlatform[],
  accounts: readonly Pick<PlatformAccountView, "brokerId" | "platform" | "status">[] | undefined,
  brokerId: string,
): PostPlatform[] {
  if (accounts === undefined) return [];
  return platforms.filter(
    (platform) =>
      !accounts.some(
        (account) =>
          accountOwnedBy(account, brokerId) &&
          account.platform === platform &&
          account.status === "connected",
      ),
  );
}

/**
 * Lo que falta de medios en cada red con texto aprobado (F9.5-T21): la advertencia
 * `MEDIA_REQUIREMENT` de su revisión («Falta la imagen: …»). Publicar y programar esperan a que
 * existan, así que esas redes no se ofrecen todavía. Devuelve el motivo por red.
 */
export function platformsMissingMedia(
  platforms: readonly PostPlatform[],
  contents: readonly ContentView[],
): Map<PostPlatform, string> {
  const missing = new Map<PostPlatform, string>();
  for (const content of postContents(contents)) {
    if (content.status !== "approved" || !platforms.includes(content.platform)) continue;
    const check = content.checks.find((item) => item.code === "MEDIA_REQUIREMENT");
    if (check !== undefined && !missing.has(content.platform)) {
      missing.set(content.platform, check.message);
    }
  }
  return missing;
}

/** El resultado de programar, red por red: la hora o el motivo de lo que se saltó. */
function ScheduleResults({ result }: { result: PostScheduleResponse }) {
  const lines: { key: string; ok: boolean; text: string }[] = [];
  result.results.forEach((row, index) => {
    const name = row.platform === null ? "El post" : PLATFORM_TEXT[row.platform];
    if (row.outcome !== "scheduled") {
      lines.push({
        key: `${index}`,
        ok: false,
        text: `${name}: ${row.message ?? "no se programó"}`,
      });
      return;
    }
    const publications = row.publications ?? [];
    const times = new Set(publications.map((p) => p.scheduledAt?.getTime()));
    if (publications.length > 1 && times.size > 1) {
      for (const p of publications) {
        lines.push({
          key: p.id,
          ok: true,
          text: `${name} · ${LANGUAGE_TEXT[p.language]}: programado para el ${formatChileDayTime(p.scheduledAt ?? row.at ?? new Date())} (hora de Chile)`,
        });
      }
      return;
    }
    lines.push({
      key: `${index}`,
      ok: true,
      text: `${name}: programado para el ${row.at === undefined ? "" : formatChileDayTime(row.at)} (hora de Chile)`,
    });
  });
  return (
    <ul role="status" className="mt-2 space-y-1 text-sm">
      {lines.map((line) => (
        <li key={line.key} className={line.ok ? "text-success-800" : "text-warning-800"}>
          {line.text}
        </li>
      ))}
    </ul>
  );
}

/** Una casilla por texto aprobado: «Instagram · español». */
function TextRows({
  rows,
  picked,
  onToggle,
  idPrefix,
  legend,
}: {
  rows: readonly PublishRow[];
  picked: readonly string[];
  onToggle: (contentId: string, on: boolean) => void;
  idPrefix: string;
  legend: string;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 font-medium text-fg">{legend}</legend>
      {rows.map((row) => (
        <label
          key={row.contentId}
          htmlFor={`${idPrefix}-${row.contentId}`}
          className="flex items-center gap-2"
        >
          <input
            id={`${idPrefix}-${row.contentId}`}
            type="checkbox"
            checked={picked.includes(row.contentId)}
            onChange={(event) => onToggle(row.contentId, event.target.checked)}
          />
          {PLATFORM_TEXT[row.platform]} · {LANGUAGE_TEXT[row.language]}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Publicar y programar (spec F9 §4.10): un botón por red con algo por publicar (una red por pedido,
 * como la API; todos sus idiomas) y programar las redes elegidas a una hora de Chile. El modo lo
 * pone la API; en vivo se confirma antes. Una red sin cuenta conectada no se ofrece: su botón queda
 * desactivado con el motivo y el enlace a Cuentas, y no entra en programar. Si todo salió o está
 * saliendo, no hay botón Publicar (F9.5-T02).
 */
export function PostPublishBar({
  postId,
  post,
  contents,
  publications,
  publishMode,
  lockReason,
}: {
  postId: string;
  /**
   * Sus redes (`platforms`): las quitadas no se ofrecen (F9-T21); su marca, por las cuentas; y su
   * tipo, para el enlace a subir lo que falta (F9.5-T21).
   */
  post: Pick<PostJson, "platforms" | "brokerId" | "kind">;
  contents: readonly ContentView[];
  /** Las publicaciones del post: una red con todo publicado no tiene botón (`undefined`: cargando). */
  publications?: readonly PublicationView[] | undefined;
  publishMode: PublishMode | undefined;
  lockReason: string | null;
}) {
  const ids = useId();
  const publish = usePublishPost(postId);
  const schedule = useSchedulePost(postId);
  // Todas las cuentas que la sesión puede ver (su alcance), no las del corredor del selector: un
  // administrador con otro corredor elegido mira igual las redes de la marca del post (F9.5-T12).
  const accounts = useAccounts();
  const platforms = approvedPlatforms(contents, post);
  const excludedOnly = platforms.length === 0 && approvedPlatforms(contents).length > 0;
  const unconnected = platformsWithoutAccount(platforms, accounts.data?.accounts, post.brokerId);
  // F9.5-T21: sin los medios del post no se publica ni se programa; el texto ya quedó aprobado.
  const noMedia = platformsMissingMedia(platforms, contents);
  const ready = platforms.filter(
    (platform) => !unconnected.includes(platform) && !noMedia.has(platform),
  );
  const [scheduling, setScheduling] = useState(false);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [spacing, setSpacing] = useState(SUGGESTED_SPACING_MINUTES);
  const [scheduleResult, setScheduleResult] = useState<PostScheduleResponse | null>(null);
  const [published, setPublished] = useState<string | null>(null);
  const unconnectedText = unconnected.map((platform) => PLATFORM_TEXT[platform]).join(", ");
  const toPublish = platformsToPublish(platforms, contents, publications);
  // Se programa lo que tiene algo por publicar y cuenta conectada.
  const schedulable = ready.filter((platform) => toPublish.includes(platform));
  // Un renglón por texto aprobado con algo por publicar. Por defecto sale UNO por red: los idiomas
  // son el mismo post; el otro se marca a conciencia.
  const rows = publishRows(ready, contents, publications);
  const picked = (chosen ?? defaultChosen(rows, contents, publications)).filter((id) =>
    rows.some((row) => row.contentId === id),
  );
  const toggle = (contentId: string, on: boolean) =>
    setChosen(on ? [...picked, contentId] : picked.filter((id) => id !== contentId));
  const languagesOf = languagesByPlatform(rows, picked);
  const toSchedule = schedulable.filter((platform) => languagesOf.has(platform));
  const several = platformsWithSeveral(rows, picked);
  const multiLanguage = platforms.some(
    (platform) => rows.filter((r) => r.platform === platform).length > 1,
  );
  const spacingTooShort = several.length > 0 && spacing < MIN_SPACING_MINUTES;
  if (platforms.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        {excludedOnly
          ? "Los textos aprobados son de redes que ya no están en el post: agrégalas con «Editar el post» o aprueba el texto de otra red."
          : "Aprueba al menos un texto para publicarlo o programarlo."}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {toPublish.length === 0 && (
        <p className="text-sm text-fg-muted">
          Todo lo aprobado ya salió, está saliendo o está programado: míralo en Publicaciones, más
          abajo.
        </p>
      )}
      {multiLanguage && !scheduling && (
        <div className="space-y-1 text-sm">
          <TextRows
            rows={rows.filter((row) => rows.filter((r) => r.platform === row.platform).length > 1)}
            picked={picked}
            onToggle={toggle}
            idPrefix={`${ids}-publish`}
            legend="Qué texto sale"
          />
          <p className="text-xs text-fg-subtle">{ONE_PER_NETWORK_TEXT}</p>
          {several.length > 0 && (
            <p className="text-warning-800">
              Marcaste los dos idiomas de {several.map((p) => PLATFORM_TEXT[p]).join(", ")}: al
              publicar saldrán los dos a la vez.
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {toPublish.map((platform) => (
          <LiveConfirmButton
            key={platform}
            label={publishButtonText(platform, publishMode)}
            publishMode={publishMode}
            pending={publish.isPending}
            disabled={
              lockReason !== null ||
              unconnected.includes(platform) ||
              noMedia.has(platform) ||
              !languagesOf.has(platform)
            }
            {...(lockReason !== null
              ? { title: lockReason }
              : unconnected.includes(platform)
                ? { title: `Sin cuenta conectada en ${PLATFORM_TEXT[platform]}` }
                : noMedia.has(platform)
                  ? { title: noMedia.get(platform) ?? "" }
                  : !languagesOf.has(platform)
                    ? { title: "Marca el texto que quieres publicar" }
                    : {})}
            onConfirm={() =>
              publish.mutate(
                { platform, languages: languagesOf.get(platform) ?? [] },
                {
                  onSuccess: (result) =>
                    setPublished(
                      `${PLATFORM_TEXT[platform]}: ${result.started.length + result.requeued.length} publicación(es) en curso${
                        result.skipped.length > 0
                          ? ` (${result.skipped.length} ya tenía una activa de otro texto)`
                          : ""
                      }.`,
                    ),
                },
              )
            }
          />
        ))}
        {!scheduling && toPublish.length > 0 && (
          <Button
            variant="secondary"
            size="sm"
            disabled={lockReason !== null || schedulable.length === 0}
            {...(lockReason === null && schedulable.length === 0
              ? {
                  title:
                    noMedia.size > 0
                      ? "Faltan los medios del post: súbelos o consíguelos"
                      : "Ninguna red aprobada tiene cuenta conectada",
                }
              : {})}
            onClick={() => setScheduling(true)}
          >
            Programar…
          </Button>
        )}
      </div>
      <p className="text-xs text-fg-subtle">
        Cada botón publica los textos marcados de esa red. «Programar…» deja elegir varias redes a
        la vez; cada una sale con sus textos marcados.
      </p>
      {noMedia.size > 0 && (
        <p className="text-sm text-warning-800">
          {[...new Set(noMedia.values())].join(" ")}{" "}
          <a href={`#${POST_MEDIA_ANCHOR}`} className="font-medium underline underline-offset-2">
            {post.kind === "video" ? "Subir el video" : "Subir imágenes"}
          </a>{" "}
          o{" "}
          <a href={`#${GET_IMAGE_ANCHOR}`} className="font-medium underline underline-offset-2">
            Conseguir imagen
          </a>
          . El texto aprobado no se pierde: publicar y programar se activan cuando estén.
        </p>
      )}
      {unconnected.length > 0 && (
        <p className="text-sm text-warning-800">
          Sin cuenta conectada en {unconnectedText}: conéctala en{" "}
          <Link to="/cuentas" className="font-medium underline underline-offset-2">
            Cuentas
          </Link>{" "}
          para {ready.length === 0 ? "publicar o programar el post" : "publicar ahí"}. El texto
          aprobado no se pierde.
        </p>
      )}
      {published !== null && (
        <p role="status" className="text-sm text-fg-muted">
          {published}
        </p>
      )}
      {publish.error && <ErrorAlert error={publish.error} />}
      {scheduling && schedulable.length > 0 && (
        <ScheduleForm
          publishMode={publishMode}
          pending={schedule.isPending}
          submitLabel="Programar"
          extra={
            <div className="space-y-2">
              <TextRows
                rows={rows.filter((row) => schedulable.includes(row.platform))}
                picked={picked}
                onToggle={toggle}
                idPrefix={`${ids}-schedule`}
                legend="Textos a programar"
              />
              {multiLanguage && <p className="text-xs text-fg-subtle">{ONE_PER_NETWORK_TEXT}</p>}
              {several.length > 0 && (
                <div
                  role="alert"
                  className="rounded-lg border border-warning-200 bg-warning-50 p-3"
                >
                  <p className="font-medium text-warning-800">
                    Marcaste los dos idiomas de {several.map((p) => PLATFORM_TEXT[p]).join(", ")}: a
                    la misma hora saldrían dos iguales. Deja un espacio entre uno y otro.
                  </p>
                  <label className="mt-2 flex flex-wrap items-center gap-2 text-fg">
                    Minutos entre uno y otro
                    <Input
                      type="number"
                      width="auto"
                      min={MIN_SPACING_MINUTES}
                      max={240}
                      value={spacing}
                      onChange={(event) => setSpacing(Number(event.target.value))}
                      className="w-24"
                    />
                  </label>
                  {spacingTooShort && (
                    <p className="mt-1 text-danger-700">
                      Deja al menos {MIN_SPACING_MINUTES} minutos entre los dos.
                    </p>
                  )}
                </div>
              )}
            </div>
          }
          onSubmit={async (at) => {
            if (toSchedule.length === 0 || spacingTooShort) return;
            setScheduleResult(null);
            const all: PostScheduleResponse["results"] = [];
            // Una red por pedido: cada una lleva sus propios idiomas.
            for (const platform of toSchedule) {
              const languages = languagesOf.get(platform) ?? [];
              try {
                const done = await schedule.mutateAsync({
                  platforms: [platform],
                  languages,
                  at,
                  ...(languages.length > 1 ? { spacingMinutes: spacing } : {}),
                });
                all.push(...done.results);
              } catch {
                // El error queda en `schedule.error`; lo ya programado se muestra abajo.
                setScheduleResult({ results: all });
                return;
              }
            }
            setScheduleResult({ results: all });
            setScheduling(false);
          }}
          onCancel={() => setScheduling(false)}
        />
      )}
      {scheduleResult && <ScheduleResults result={scheduleResult} />}
      {schedule.error && <ErrorAlert error={schedule.error} />}
    </div>
  );
}

/**
 * «Agregar el enlace» a una publicación a mano ya confirmada sin él (solo en vivo): se guarda con
 * el mismo `confirm` y deja abrir el post desde Seguimiento. En simulación no se guarda nada y la
 * nota lo dice.
 */
function AddLinkBox({
  publicationId,
  platform,
  live,
  pending,
  error,
  onSave,
}: {
  publicationId: string;
  platform: PostPublicationView["platform"];
  live: boolean;
  pending: boolean;
  error: Error | null;
  onSave: (url: string) => void;
}) {
  const id = useId();
  const [url, setUrl] = useState("");
  const value = url.trim();
  if (!live) {
    return (
      <p className="mt-2 text-xs text-fg-subtle">
        Esta publicación es de simulación: no salió de verdad, así que aquí no se guarda ningún
        enlace.
      </p>
    );
  }
  return (
    <div className="mt-2 min-w-0 rounded-lg border border-line bg-canvas p-3">
      <label htmlFor={`${id}-${publicationId}`} className="mb-1 block text-xs font-medium text-fg">
        Agregar el enlace de la publicación en {PLATFORM_TEXT[platform]}
      </label>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <Input
            id={`${id}-${publicationId}`}
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://"
            autoComplete="off"
          />
        </div>
        <Button size="sm" disabled={pending || value === ""} onClick={() => onSave(value)}>
          Guardar enlace
        </Button>
      </div>
      <p className="mt-1 text-xs text-fg-subtle">
        Con el enlace podrás abrir el post desde Seguimiento. Una vez guardado no se cambia.
      </p>
      {error !== null && <ErrorAlert error={error} />}
    </div>
  );
}

/** Una publicación del post: red, idioma, estado, hora y lo que se puede hacer con ella. */
function PublicationRow({
  postId,
  publication,
  publishMode,
  content,
}: {
  postId: string;
  publication: PostPublicationView;
  publishMode: PublishMode | undefined;
  /** Su texto (el que fijó la publicación), para copiarlo en LinkedIn a mano (F9.5-T27). */
  content: ContentView | undefined;
}) {
  const action = usePostPublicationAction(postId);
  const { status } = publication;
  const link = safeExternalUrl(publication.externalUrl);
  const when =
    status === "published" && publication.publishedAt !== null
      ? `publicada el ${formatChileDayTime(publication.publishedAt)}`
      : publication.scheduledAt !== null && status === "scheduled"
        ? `programada para el ${formatChileDayTime(publication.scheduledAt)}`
        : null;
  return (
    <li className="py-3 text-sm first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold text-fg">
          {PLATFORM_TEXT[publication.platform]} · {LANGUAGE_TEXT[publication.language]}
        </span>
        <PublicationStatusBadge status={status} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="text-fg-subtle">
          {publicationFormatText(
            publication.platform,
            publication.format,
            publication.mediaIds.length,
          )}
        </span>
        <PublicationMode publication={publicationModeOf(publication)} publishMode={publishMode} />
        {when !== null && (
          <span className="text-fg-muted tabular-nums">· {when} (hora de Chile)</span>
        )}
        {link !== null && (
          <a
            href={link}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-brand-700 underline underline-offset-2"
          >
            Ver en {PLATFORM_TEXT[publication.platform]}
          </a>
        )}
        {confirmedWithoutLink(publication) && (
          <span className="text-fg-muted">· {CONFIRMED_WITHOUT_LINK_TEXT}</span>
        )}
      </div>
      {status === "published" &&
        confirmsWithoutUrl(publication.platform) &&
        publication.externalUrl === null && (
          <AddLinkBox
            publicationId={publication.id}
            platform={publication.platform}
            live={!publication.dryRun}
            pending={action.isPending}
            error={action.error}
            onSave={(url) => action.mutate({ kind: "confirm", id: publication.id, url })}
          />
        )}
      {publication.lastError !== null && status === "failed" && (
        <p className="mt-2 text-danger-700">
          <ErrorLine error={publication.lastError} />
          {publication.errorAdvice !== null && (
            <span className="block text-fg-muted">{publication.errorAdvice}</span>
          )}
        </p>
      )}
      {publication.platform === "tiktok" && (
        <p className="mt-1 text-xs text-fg-subtle">
          El video va como borrador a la app de TikTok: lo publicas desde el teléfono y lo confirmas
          con el enlace. Publicar directo espera la auditoría de TikTok.
        </p>
      )}
      {isHandPlatform(publication.platform) && status === "awaiting_manual_confirm" && (
        <HandAssist
          platform={publication.platform}
          content={content}
          downloads={linkedinDownloads(publication.media)}
        />
      )}
      {(status === "outcome_unknown" || status === "awaiting_manual_confirm") && (
        <OutcomeBox
          publication={publication}
          pending={action.isPending}
          onAction={(next) => action.mutate(next)}
        />
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {status === "failed" && (
          <LiveConfirmButton
            label="Reintentar"
            publishMode={publishMode}
            pending={action.isPending}
            onConfirm={() => action.mutate({ kind: "publish", id: publication.id })}
          />
        )}
        {status === "scheduled" && (
          <Button
            variant="secondary"
            size="sm"
            disabled={action.isPending}
            onClick={() => action.mutate({ kind: "unschedule", id: publication.id })}
          >
            Desprogramar
          </Button>
        )}
        {(status === "approved" || status === "failed" || status === "scheduled") && (
          <Button
            variant="ghost"
            size="sm"
            disabled={action.isPending}
            onClick={() => action.mutate({ kind: "cancel", id: publication.id })}
          >
            Descartar
          </Button>
        )}
      </div>
      {action.error && <ErrorAlert error={action.error} />}
    </li>
  );
}

/** Las publicaciones del post, las más nuevas primero (como las entrega la API). */
export function PostPublications({
  postId,
  publications,
  publishMode,
  contents = [],
}: {
  postId: string;
  publications: readonly PostPublicationView[];
  publishMode: PublishMode | undefined;
  /** Los textos del post: el de cada publicación, para LinkedIn a mano (F9.5-T27). */
  contents?: readonly ContentView[];
}) {
  if (publications.length === 0) {
    return <p className="text-sm text-fg-muted">Todavía no tiene publicaciones.</p>;
  }
  return (
    <ul className="divide-y divide-line">
      {publications.map((publication) => (
        <PublicationRow
          key={publication.id}
          postId={postId}
          publication={publication}
          publishMode={publishMode}
          content={contents.find((content) => content.id === publication.contentId)}
        />
      ))}
    </ul>
  );
}
