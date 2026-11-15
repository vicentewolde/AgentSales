import {
  CARD_COMPOSITIONS,
  type CardComposition,
  type CardTheme,
  POST_IMAGE_FORMATS,
  type PostImageFormat,
} from "@agentsales/core";
import { type ChangeEvent, useEffect, useState } from "react";
import { useCardStyle, useCardStylePreview, useSaveCardStyle } from "../../queries/card-style.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Alert } from "../ui/Alert.js";
import { Button } from "../ui/Button.js";
import { Field, Select, Textarea } from "../ui/Field.js";

// «Estilo de imágenes» en Mi marca (spec F9.7 B4, ADR-0043 D3): el manual de diseño de la marca
// como datos (colores, fuentes de la lista, márgenes, logo y hasta 4 temas que se rotan, uno por
// post). Se edita como JSON (o se carga un archivo, como `docs/marca/agentpey/estilo.json`) y se ve
// en una lámina de muestra antes de guardar.

const COMPOSITION_TEXT: Readonly<Record<CardComposition, string>> = {
  announce: "Anuncio (logo, objeto central y titular)",
  explain: "Explicar (titular y tarjetas en grilla)",
};

/** El color de muestra del fondo de un tema (el primero de su degradado). */
const backgroundOf = (theme: CardTheme) =>
  theme.background.kind === "solid" ? theme.background.color : theme.background.from;

function ThemeSwatches({ themes }: { themes: readonly CardTheme[] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-2" aria-label="Temas que se rotan">
      {themes.map((theme) => (
        <li
          key={theme.name}
          className="flex items-center gap-2 rounded-xl border border-line-soft px-3 py-2 text-sm"
        >
          {[backgroundOf(theme), theme.text, theme.accent].map((color, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: tres muestras fijas por tema
              key={index}
              aria-hidden="true"
              className="inline-block size-4 rounded-full ring-1 ring-line-soft"
              // Los colores de la marca no son tokens del panel: se muestran tal cual.
              style={{ backgroundColor: color }}
            />
          ))}
          {theme.name}
        </li>
      ))}
    </ul>
  );
}

export function CardStyleSection({ brokerId }: { brokerId: string }) {
  const current = useCardStyle(brokerId);
  const save = useSaveCardStyle(brokerId);
  const preview = useCardStylePreview(brokerId);
  const [draft, setDraft] = useState<string | null>(null);
  const [theme, setTheme] = useState(0);
  const [composition, setComposition] = useState<CardComposition>("announce");
  const [format, setFormat] = useState<PostImageFormat>("4:5");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const saved = current.data?.style ?? null;
  const text = draft ?? (saved === null ? "" : JSON.stringify(saved, null, 2));
  const imageUrl = preview.data;
  useEffect(
    () => () => {
      if (imageUrl !== undefined) URL.revokeObjectURL(imageUrl);
    },
    [imageUrl],
  );

  const parsed = (): unknown => {
    try {
      setJsonError(null);
      return JSON.parse(text) as unknown;
    } catch {
      setJsonError("No es un JSON válido");
      return undefined;
    }
  };
  const showPreview = () => {
    const style = parsed();
    if (style !== undefined) preview.mutate({ style, theme, composition, format });
  };
  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file !== undefined) setDraft(await file.text());
  };
  const themes = (() => {
    try {
      const value = JSON.parse(text) as { themes?: CardTheme[] };
      return Array.isArray(value.themes) ? value.themes : [];
    } catch {
      return [];
    }
  })();

  return (
    <section aria-label="Estilo de imágenes" className="mt-6">
      <h2 className="text-lg font-semibold">Estilo de imágenes</h2>
      <p className="text-sm text-fg-muted">
        Con estilo, «Tarjetas de la marca» dibuja las láminas con tus colores, fuentes y logo, y
        rota hasta 4 temas (uno por post). Sin estilo, salen como hasta ahora.
      </p>
      {current.error && <ErrorAlert error={current.error} onRetry={() => void current.refetch()} />}
      {themes.length > 0 && <ThemeSwatches themes={themes} />}
      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div>
          <Field
            label="Estilo (JSON)"
            hint="Colores #RRGGBB, fuentes inter-tight o inter, hasta 4 temas."
          >
            <Textarea
              rows={14}
              spellCheck={false}
              className="font-mono text-xs"
              value={text}
              onChange={(event) => setDraft(event.target.value)}
            />
          </Field>
          <label className="mt-2 inline-flex items-center gap-2 text-sm pointer-coarse:min-h-11">
            Cargar un archivo
            <input
              type="file"
              accept="application/json,.json"
              onChange={(event) => void onFile(event)}
            />
          </label>
          {jsonError !== null && (
            <p role="alert" className="mt-1 text-sm text-danger-700">
              {jsonError}
            </p>
          )}
          {save.error && <ErrorAlert error={save.error} />}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button
              loading={save.isPending}
              disabled={text.trim() === ""}
              onClick={() => {
                const style = parsed();
                if (style !== undefined) save.mutate(style, { onSuccess: () => setDraft(null) });
              }}
            >
              Guardar el estilo
            </Button>
            <p role="status" className="text-sm text-success-800">
              {save.isSuccess && "Guardado."}
            </p>
          </div>
          {(save.data?.cardStyle.warnings ?? current.data?.warnings ?? []).map((warning) => (
            <Alert
              key={`${warning.theme}-${warning.what}-${warning.background}`}
              tone="warning"
              className="mt-2"
            >
              Contraste bajo en {warning.theme}: {warning.what} {warning.text} sobre{" "}
              {warning.background}
            </Alert>
          ))}
        </div>
        <div>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Tema">
              <Select value={theme} onChange={(event) => setTheme(Number(event.target.value))}>
                {(themes.length > 0 ? themes : [{ name: "Tema 1" }]).map((item, index) => (
                  <option key={item.name} value={index}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Composición">
              <Select
                value={composition}
                onChange={(event) => setComposition(event.target.value as CardComposition)}
              >
                {CARD_COMPOSITIONS.map((value) => (
                  <option key={value} value={value}>
                    {COMPOSITION_TEXT[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Proporción">
              <Select
                value={format}
                onChange={(event) => setFormat(event.target.value as PostImageFormat)}
              >
                {POST_IMAGE_FORMATS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button
            variant="secondary"
            className="mt-2"
            loading={preview.isPending}
            disabled={text.trim() === ""}
            onClick={showPreview}
          >
            Ver una lámina de muestra
          </Button>
          {preview.error && <ErrorAlert error={preview.error} />}
          {imageUrl !== undefined && (
            <img
              src={imageUrl}
              alt="Lámina de muestra con el estilo"
              className="mt-3 w-full max-w-sm rounded-xl border border-line-soft"
            />
          )}
        </div>
      </div>
    </section>
  );
}
