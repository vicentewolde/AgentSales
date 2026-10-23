import type { ContentView, PostWeekApproveResponse, PostWeekItem } from "@agentsales/api/contracts";
import {
  formatChileTime,
  LANGUAGE_TEXT,
  PLATFORM_TEXT,
  planWeekText,
  publicationModeText,
  WEEK_PROBLEM_TEXT,
} from "@agentsales/core";
import { useState } from "react";
import { Link } from "react-router";
import { useApprovePostWeek, usePostWeek } from "../../queries/brand-week.js";
import { useHealth } from "../../queries/health.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";
import { LiveConfirmButton } from "./LiveConfirm.js";
import { postContents } from "./labels.js";

/** Cómo está un texto antes de aprobar la semana: aprobado, con errores, sin medios o por aprobar. */
export function weekTextState(content: Pick<ContentView, "status" | "checks">): {
  text: string;
  tone: "success" | "danger" | "warning" | "neutral";
} {
  const errors = content.checks.filter((check) => check.severity === "error").length;
  if (errors > 0) {
    return {
      text: errors === 1 ? "1 error: no se aprueba" : `${errors} errores: no se aprueba`,
      tone: "danger",
    };
  }
  if (content.checks.some((check) => check.code === "MEDIA_REQUIREMENT")) {
    return { text: "falta la imagen o el video", tone: "warning" };
  }
  return content.status === "approved"
    ? { text: "aprobado", tone: "success" }
    : { text: "por aprobar", tone: "neutral" };
}

/** Una línea corta del texto (lo demás está en el post). */
const excerpt = (body: string) => {
  const line = body.replace(/\s+/g, " ").trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
};

/** Un post de la semana con sus textos por red: lo que se va a aprobar y programar. */
function WeekPost({ item }: { item: PostWeekItem }) {
  const texts = postContents(item.contents);
  return (
    <li className="rounded-xl border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-fg tabular-nums">
          {item.post.plannedAt === null ? "sin fecha" : formatChileTime(item.post.plannedAt)}
        </span>
        <Link
          to={`/contenido/${item.post.id}`}
          className="font-semibold text-fg underline-offset-2 hover:text-brand-700 hover:underline"
        >
          {item.post.topic}
        </Link>
      </div>
      {texts.length === 0 ? (
        <p className="mt-1 text-sm text-fg-muted">Sin textos todavía: la IA los está redactando.</p>
      ) : (
        <ul className="mt-2 space-y-1.5 text-sm">
          {texts.map((content) => {
            const state = weekTextState(content);
            return (
              <li key={content.id}>
                <span className="font-medium text-fg">
                  {PLATFORM_TEXT[content.platform]} · {LANGUAGE_TEXT[content.language]}
                </span>{" "}
                <Badge tone={state.tone}>{state.text}</Badge>
                <span className="block text-fg-muted">{excerpt(content.body)}</span>
                {content.platform === "linkedin" && (
                  <span className="block text-xs text-fg-subtle">
                    LinkedIn va a mano: a su hora, en el post, «Copiar texto y abrir LinkedIn».
                  </span>
                )}
                {content.platform === "tiktok" && (
                  <span className="block text-xs text-fg-subtle">
                    El video va como borrador a la app de TikTok: publicar directo espera la
                    auditoría de TikTok.
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/** Lo que hizo «Aprobar la semana»: lo programado y, con su motivo, lo que no se pudo. */
export function WeekResult({ result }: { result: PostWeekApproveResponse }) {
  const mode = publicationModeText(result.dryRun);
  return (
    <ul
      role="status"
      aria-label="Resultado de aprobar la semana"
      className="mt-3 space-y-2 text-sm"
    >
      {result.posts.map((post) => (
        <li key={post.postId}>
          <span className="font-medium text-fg">{post.topic}</span>
          <ul className="mt-0.5 space-y-0.5 pl-3">
            {post.scheduled.map((row) => (
              <li key={row.platform} className="text-success-800">
                ✓ {PLATFORM_TEXT[row.platform]}: programado para el {formatChileTime(row.at)} (hora
                de Chile, {mode})
              </li>
            ))}
            {post.problems.map((problem, index) => {
              const { text, hint } = WEEK_PROBLEM_TEXT[problem.kind];
              const where =
                problem.platform === null
                  ? "El post"
                  : `${PLATFORM_TEXT[problem.platform]}${problem.language === null ? "" : ` · ${LANGUAGE_TEXT[problem.language]}`}`;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: el orden de la respuesta no cambia
                <li key={index} className="text-warning-800">
                  – {where}: {text}. {problem.message}
                  {hint !== "" && <span className="block text-fg-muted">{hint}</span>}
                  {problem.kind === "account_missing" ? (
                    <Link to="/cuentas" className="font-medium underline underline-offset-2">
                      Ir a Cuentas
                    </Link>
                  ) : (
                    problem.kind !== "nothing_left" && (
                      <Link
                        to={`/contenido/${post.postId}`}
                        className="font-medium underline underline-offset-2"
                      >
                        Abrir el post
                      </Link>
                    )
                  )}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/**
 * «Aprobar la semana» (F9.5-T27): las ideas aceptadas de una semana con sus textos por red; un
 * botón aprueba los textos sin errores y programa cada post a su fecha (la de la cadencia, ADR-0034).
 * Nada se publica en el momento; en vivo pide confirmar antes, como programar.
 */
export function ApproveWeek({ brandId, week }: { brandId: string; week: string }) {
  const [open, setOpen] = useState(false);
  const preview = usePostWeek(brandId, week, open);
  const approve = useApprovePostWeek(brandId);
  const health = useHealth();
  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Aprobar la semana…
      </Button>
    );
  }
  const posts = preview.data?.posts ?? [];
  return (
    <section
      aria-label={`Aprobar la ${planWeekText(week).toLowerCase()}`}
      className="mt-2 rounded-xl border border-line bg-sand p-4"
    >
      <p className="text-sm text-fg-muted">
        Aprueba los textos sin errores de las ideas aceptadas y programa cada una a su fecha. Nada
        se publica ahora: sale solo a su hora.
      </p>
      {preview.error && <ErrorAlert error={preview.error} onRetry={() => void preview.refetch()} />}
      {preview.isPending && <p className="mt-2 text-sm text-fg-muted">Cargando la semana…</p>}
      {preview.data !== undefined && posts.length === 0 && (
        <p className="mt-2 text-sm text-fg-muted">
          No hay ideas aceptadas en esta semana: acepta las que quieras y vuelve aquí.
        </p>
      )}
      {posts.length > 0 && (
        <ul aria-label="Posts de la semana" className="mt-3 space-y-2">
          {posts.map((item) => (
            <WeekPost key={item.post.id} item={item} />
          ))}
        </ul>
      )}
      {(preview.data?.ideas ?? 0) > 0 && (
        <p className="mt-2 text-sm text-fg-muted">
          {preview.data?.ideas === 1
            ? "Una idea de esta semana sigue sin decidir: no entra."
            : `${preview.data?.ideas} ideas de esta semana siguen sin decidir: no entran.`}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <LiveConfirmButton
          label={approve.isPending ? "Aprobando…" : "Aprobar y programar la semana"}
          publishMode={health.data?.publishMode}
          pending={approve.isPending}
          disabled={posts.length === 0}
          liveMessage="El sistema está en vivo: a su hora, cada post se publica de verdad, sin volver a preguntar."
          confirmLabel="Sí, programar en vivo"
          onConfirm={() => approve.mutate(week)}
        />
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cerrar
        </Button>
      </div>
      {approve.data && <WeekResult result={approve.data} />}
      {approve.error && <ErrorAlert error={approve.error} />}
    </section>
  );
}
