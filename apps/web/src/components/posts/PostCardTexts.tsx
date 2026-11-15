import type { PostCardTextsResponse } from "@agentsales/api/contracts";
import { CARD_TEXT_LIMITS, LANGUAGE_TEXT, type Language, type PostKind } from "@agentsales/core";
import { useState } from "react";
import { usePostCardTexts, useSavePostCardTexts } from "../../queries/post-card-texts.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Button } from "../ui/Button.js";
import { Card } from "../ui/Card.js";
import { Field, Input } from "../ui/Field.js";
import { cx } from "../ui/styles.js";

// «Láminas» en el detalle del post (spec F9.7 B5 y B7): el titular y el subtítulo de cada lámina
// por idioma (los escribe la IA al redactar; aquí se editan) y, en un carrusel, «Descargar PDF
// para LinkedIn». «Conseguir imagen → Tarjetas de la marca» las dibuja con el estilo de la marca.

type Row = { headline: string; subtitle: string };

function LanguageEditor({
  postId,
  language,
  kind,
  view,
  disabled,
}: {
  postId: string;
  language: Language;
  kind: PostKind;
  view: PostCardTextsResponse;
  disabled: boolean;
}) {
  const save = useSavePostCardTexts(postId);
  const saved = view.texts.filter((text) => text.language === language);
  const [rows, setRows] = useState<Row[]>(
    saved.length > 0
      ? saved.map((text) => ({ headline: text.headline, subtitle: text.subtitle }))
      : [{ headline: "", subtitle: "" }],
  );
  const max = kind === "image" ? 1 : CARD_TEXT_LIMITS.perLanguage;
  const change = (index: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  const approved = saved.some((text) => text.approved);
  return (
    <fieldset className="space-y-3" aria-label={`Láminas en ${LANGUAGE_TEXT[language]}`}>
      <legend className="text-sm font-semibold">
        {LANGUAGE_TEXT[language]}
        {saved.length > 0 && (
          <span className="ml-2 font-normal text-fg-subtle">
            {approved ? "revisadas por ti" : "escritas por la IA"}
          </span>
        )}
      </legend>
      {rows.map((row, index) => {
        const checks = saved[index]?.checks ?? [];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: filas editables sin id propio
          <div key={index} className="rounded-xl border border-line-soft p-3">
            <p className="text-xs font-semibold text-fg-muted">
              {index === 0 ? "Portada" : `Punto ${index}`}
            </p>
            <Field
              label="Titular"
              hint={`Hasta ${CARD_TEXT_LIMITS.headlineWords} palabras`}
              className="mt-1"
            >
              <Input
                value={row.headline}
                maxLength={CARD_TEXT_LIMITS.headlineChars}
                disabled={disabled}
                onChange={(event) => change(index, { headline: event.target.value })}
              />
            </Field>
            <Field
              label="Subtítulo"
              hint={`Hasta ${CARD_TEXT_LIMITS.subtitleWords} palabras`}
              className="mt-2"
            >
              <Input
                value={row.subtitle}
                maxLength={CARD_TEXT_LIMITS.subtitleChars}
                disabled={disabled}
                onChange={(event) => change(index, { subtitle: event.target.value })}
              />
            </Field>
            {checks.length > 0 && (
              <ul className="mt-2 space-y-1 text-sm">
                {checks.map((check) => (
                  <li
                    key={`${check.code}-${check.message}`}
                    className={cx(
                      check.severity === "error" ? "text-danger-700" : "text-warning-800",
                    )}
                  >
                    {check.message}
                  </li>
                ))}
              </ul>
            )}
            {index > 0 && !disabled && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-1"
                onClick={() => setRows((current) => current.filter((_, at) => at !== index))}
              >
                Quitar este punto
              </Button>
            )}
          </div>
        );
      })}
      {save.error && <ErrorAlert error={save.error} />}
      <div className="flex flex-wrap items-center gap-2">
        {rows.length < max && !disabled && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setRows((current) => [...current, { headline: "", subtitle: "" }])}
          >
            Agregar un punto
          </Button>
        )}
        <Button
          size="sm"
          disabled={disabled || rows.every((row) => row.headline.trim() === "")}
          loading={save.isPending}
          onClick={() =>
            save.mutate({
              language,
              texts: rows
                .filter((row) => row.headline.trim() !== "")
                .map((row) => ({ headline: row.headline, subtitle: row.subtitle })),
            })
          }
        >
          Guardar las láminas en {LANGUAGE_TEXT[language].toLowerCase()}
        </Button>
        <p role="status" className="text-sm text-success-800">
          {save.isSuccess && "Guardadas."}
        </p>
      </div>
    </fieldset>
  );
}

export function PostCardTexts({
  postId,
  kind,
  lockReason,
}: {
  postId: string;
  kind: PostKind;
  lockReason: string | null;
}) {
  const enabled = kind === "image" || kind === "carousel";
  const view = usePostCardTexts(postId, enabled);
  if (!enabled) return null;
  return (
    <Card as="section" aria-label="Láminas" title="Láminas">
      <p className="text-sm text-fg-muted">
        El texto de cada imagen: titular corto y subtítulo. La IA los escribe al redactar; lo que
        guardes aquí ya no lo cambia. «Conseguir imagen → Tarjetas de la marca» las dibuja.
      </p>
      {view.error && <ErrorAlert error={view.error} onRetry={() => void view.refetch()} />}
      {view.data !== undefined && (
        <div className="mt-3 space-y-5">
          {view.data.languages.map((language) => (
            <LanguageEditor
              key={`${language}-${view.data.texts.filter((text) => text.language === language).length}`}
              postId={postId}
              language={language}
              kind={kind}
              view={view.data}
              disabled={lockReason !== null}
            />
          ))}
          {kind === "carousel" && (
            <div>
              <p className="text-sm font-semibold">Para LinkedIn</p>
              <p className="text-xs text-fg-subtle">
                LinkedIn muestra un PDF como carrusel (varias imágenes quedan en cuadrícula
                recortada). Haz primero las tarjetas de ese idioma.
              </p>
              <div className="mt-1 flex flex-wrap gap-3">
                {view.data.languages.map((language) => (
                  <a
                    key={language}
                    className="text-sm font-semibold text-brand-800 underline underline-offset-2"
                    href={`/api/posts/${postId}/linkedin-pdf?language=${language}`}
                    download
                  >
                    Descargar PDF para LinkedIn ({LANGUAGE_TEXT[language].toLowerCase()})
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
