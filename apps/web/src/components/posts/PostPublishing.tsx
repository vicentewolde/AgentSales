import type {
  ContentView,
  PlatformAccountView,
  PostJson,
  PostScheduleResponse,
  PublicationView,
} from "@agentsales/api/contracts";
import {
  accountOwnedBy,
  formatChileTime,
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
import { LiveConfirmButton } from "./LiveConfirm.js";
import { postContents } from "./labels.js";
import { POST_MEDIA_ANCHOR } from "./media-anchor.js";

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
  return (
    <ul role="status" className="mt-2 space-y-1 text-sm">
      {result.results.map((row, index) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: el orden de la respuesta no cambia.
          key={index}
          className={row.outcome === "scheduled" ? "text-success-800" : "text-warning-800"}
        >
          {row.platform === null ? "El post" : PLATFORM_TEXT[row.platform]}:{" "}
          {row.outcome === "scheduled"
            ? `programado para el ${row.at === undefined ? "" : formatChileTime(row.at)} (hora de Chile)`
            : (row.message ?? "no se programó")}
        </li>
      ))}
    </ul>
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
  /** Sus redes (`platforms`): las quitadas no se ofrecen (F9-T21); y su marca, por las cuentas. */
  post: Pick<PostJson, "platforms" | "brokerId">;
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
  const [chosen, setChosen] = useState<PostPlatform[] | null>(null);
  const [published, setPublished] = useState<string | null>(null);
  const selected = (chosen ?? ready).filter((platform) => ready.includes(platform));
  const unconnectedText = unconnected.map((platform) => PLATFORM_TEXT[platform]).join(", ");
  const toPublish = platformsToPublish(platforms, contents, publications);
  // Se programa lo que tiene algo por publicar y cuenta conectada.
  const schedulable = ready.filter((platform) => toPublish.includes(platform));
  const toSchedule = selected.filter((platform) => schedulable.includes(platform));
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
      <div className="flex flex-wrap gap-2">
        {toPublish.map((platform) => (
          <LiveConfirmButton
            key={platform}
            label={publishButtonText(platform, publishMode)}
            publishMode={publishMode}
            pending={publish.isPending}
            disabled={
              lockReason !== null || unconnected.includes(platform) || noMedia.has(platform)
            }
            {...(lockReason !== null
              ? { title: lockReason }
              : unconnected.includes(platform)
                ? { title: `Sin cuenta conectada en ${PLATFORM_TEXT[platform]}` }
                : noMedia.has(platform)
                  ? { title: noMedia.get(platform) ?? "" }
                  : {})}
            onConfirm={() =>
              publish.mutate(platform, {
                onSuccess: (result) =>
                  setPublished(
                    `${PLATFORM_TEXT[platform]}: ${result.started.length + result.requeued.length} publicación(es) en curso${
                      result.skipped.length > 0
                        ? ` (${result.skipped.length} ya tenía una activa de otro texto)`
                        : ""
                    }.`,
                  ),
              })
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
      {noMedia.size > 0 && (
        <p className="text-sm text-warning-800">
          {[...new Set(noMedia.values())].join(" ")}{" "}
          <a href={`#${POST_MEDIA_ANCHOR}`} className="font-medium underline underline-offset-2">
            {[...noMedia.values()].every((message) => message.startsWith("Falta el video"))
              ? "Subir el video"
              : "Subir imágenes"}
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
            <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
              <legend className="mb-2 font-medium text-fg">Redes</legend>
              {schedulable.map((platform) => (
                <label
                  key={platform}
                  htmlFor={`${ids}-${platform}`}
                  className="flex items-center gap-2"
                >
                  <input
                    id={`${ids}-${platform}`}
                    type="checkbox"
                    checked={selected.includes(platform)}
                    onChange={(event) =>
                      setChosen(
                        event.target.checked
                          ? [...selected, platform]
                          : selected.filter((item) => item !== platform),
                      )
                    }
                  />
                  {PLATFORM_TEXT[platform]}
                </label>
              ))}
            </fieldset>
          }
          onSubmit={(at) => {
            if (toSchedule.length === 0) return;
            schedule.mutate(
              { platforms: toSchedule, at },
              { onSuccess: () => setScheduling(false) },
            );
          }}
          onCancel={() => setScheduling(false)}
        />
      )}
      {schedule.data && <ScheduleResults result={schedule.data} />}
      {schedule.error && <ErrorAlert error={schedule.error} />}
    </div>
  );
}

/** Una publicación del post: red, idioma, estado, hora y lo que se puede hacer con ella. */
function PublicationRow({
  postId,
  publication,
  publishMode,
}: {
  postId: string;
  publication: PublicationView;
  publishMode: PublishMode | undefined;
}) {
  const action = usePostPublicationAction(postId);
  const { status } = publication;
  const link = safeExternalUrl(publication.externalUrl);
  const when =
    status === "published" && publication.publishedAt !== null
      ? `publicada el ${formatChileTime(publication.publishedAt)}`
      : publication.scheduledAt !== null && status === "scheduled"
        ? `programada para el ${formatChileTime(publication.scheduledAt)}`
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
      </div>
      {publication.lastError !== null && status === "failed" && (
        <p className="mt-2 text-danger-700">
          {publication.lastError.message}
          {publication.errorAdvice !== null && (
            <span className="block text-fg-muted">{publication.errorAdvice}</span>
          )}
        </p>
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
}: {
  postId: string;
  publications: readonly PublicationView[];
  publishMode: PublishMode | undefined;
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
        />
      ))}
    </ul>
  );
}
