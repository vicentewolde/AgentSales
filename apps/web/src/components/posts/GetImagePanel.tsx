import type {
  PostImageOptionsResponse,
  PostImageRunView,
  PostJson,
  StockPhotoView,
} from "@agentsales/api/contracts";
import { formatUsd, POST_IMAGE_FORMATS, type PostImageFormat } from "@agentsales/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import {
  imageRunActive,
  usePostImageOptions,
  useRemovePostCards,
  useRequestPostImage,
  useStockSearch,
} from "../../queries/post-images.js";
import { postKeys } from "../../queries/posts.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Button } from "../ui/Button.js";
import { Field, Input, Select, Textarea } from "../ui/Field.js";
import { GET_IMAGE_ANCHOR } from "./media-anchor.js";

type Tab = "card" | "stock" | "ai";

const TABS: readonly { key: Tab; label: string }[] = [
  { key: "card", label: "Tarjetas de la marca" },
  { key: "stock", label: "Biblioteca (Pixabay)" },
  { key: "ai", label: "Crear con IA" },
];

/** La pestaña a la que lleva una tecla (flechas, Inicio y Fin; WAI-ARIA), o `null`. */
function nextTab(current: Tab, key: string): Tab | null {
  const index = TABS.findIndex((item) => item.key === current);
  const last = TABS.length - 1;
  const target =
    key === "ArrowRight"
      ? index === last
        ? 0
        : index + 1
      : key === "ArrowLeft"
        ? index === 0
          ? last
          : index - 1
        : key === "Home"
          ? 0
          : key === "End"
            ? last
            : null;
  return target === null ? null : (TABS[target]?.key ?? null);
}

const FORMAT_TEXT: Readonly<Record<PostImageFormat, string>> = {
  "4:5": "Vertical 4:5 (1080 × 1350, Instagram)",
  "9:16": "Vertical 9:16 (1080 × 1920, reel e historia)",
};

const SOURCE_TEXT = { card: "Tarjetas", stock: "Biblioteca", ai: "IA" } as const;

/** Lo que falta en el servidor para una fuente, en simple. */
function Missing({ what, variable }: { what: string; variable: string | null }) {
  return (
    <p className="text-sm text-warning-800">
      {what} no está disponible: falta {variable ?? "su clave"} en el servidor (la configura el
      administrador; ver la guía del operador). Mientras tanto, usa las tarjetas de la marca.
    </p>
  );
}

function FormatSelect({
  value,
  onChange,
}: {
  value: PostImageFormat;
  onChange: (format: PostImageFormat) => void;
}) {
  return (
    <Field label="Proporción">
      <Select
        width="auto"
        value={value}
        onChange={(event) =>
          onChange(POST_IMAGE_FORMATS.find((f) => f === event.target.value) ?? "4:5")
        }
      >
        {POST_IMAGE_FORMATS.map((format) => (
          <option key={format} value={format}>
            {FORMAT_TEXT[format]}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** El estado del último pedido: en curso, listo o el motivo de la falla. */
function RunStatus({ run }: { run: PostImageRunView | undefined }) {
  if (run === undefined) return null;
  if (run.status === "queued" || run.status === "running") {
    return (
      <p role="status" className="text-sm text-fg-muted">
        Consiguiendo la imagen ({SOURCE_TEXT[run.source]})…
      </p>
    );
  }
  if (run.status === "failed") {
    return (
      <p role="status" className="text-sm text-danger-700">
        No se consiguió: {run.error?.message ?? "falló"}
      </p>
    );
  }
  const count = run.mediaIds.length;
  return (
    <p role="status" className="text-sm text-success-800">
      Listo: {count === 1 ? "1 imagen quedó" : `${count} medios quedaron`} en el post (
      {SOURCE_TEXT[run.source]}
      {run.costUsd === null ? "" : `, ${formatUsd(run.costUsd)}`}). Revísalos arriba.
    </p>
  );
}

function StockTab({
  postId,
  options,
  busy,
  onPick,
}: {
  postId: string;
  options: PostImageOptionsResponse;
  busy: boolean;
  onPick: (photo: StockPhotoView, query: string) => void;
}) {
  const [query, setQuery] = useState(options.suggestions.query);
  const [withPeople, setWithPeople] = useState(false);
  const search = useStockSearch(postId);
  if (!options.sources.stock.available) {
    return <Missing what="La biblioteca de fotos" variable={options.sources.stock.missing} />;
  }
  return (
    <div className="space-y-3">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          search.mutate({ query, withPeople });
        }}
      >
        <Field label="Buscar" className="min-w-0 flex-1">
          <Input value={query} maxLength={100} onChange={(e) => setQuery(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={!withPeople}
            onChange={(event) => setWithPeople(!event.target.checked)}
          />
          Sin personas
        </label>
        <Button type="submit" variant="secondary" loading={search.isPending}>
          Buscar
        </Button>
      </form>
      {search.error !== null && <ErrorAlert error={search.error} />}
      {search.data !== undefined && (
        <p role="status" className="text-sm text-fg-muted">
          {search.data.length === 0
            ? "No hay fotos para esa búsqueda: prueba otras palabras."
            : search.data.length === 1
              ? "1 foto: tócala para usarla."
              : `${search.data.length} fotos: toca la que quieras usar.`}
        </p>
      )}
      {search.data !== undefined && search.data.length > 0 && (
        <ul
          aria-label="Resultados de la biblioteca"
          className="grid grid-cols-3 gap-2 sm:grid-cols-4"
        >
          {search.data.map((photo) => (
            <li key={photo.id}>
              <button
                type="button"
                disabled={busy}
                onClick={() => onPick(photo, query.trim())}
                className="block w-full overflow-hidden rounded-lg border border-line hover:ring-2 hover:ring-brand-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
                aria-label={`Usar la foto ${photo.tags.slice(0, 3).join(", ")} de ${photo.author}`}
              >
                <img
                  src={photo.previewUrl}
                  alt=""
                  className="aspect-[4/5] w-full object-cover"
                  referrerPolicy="no-referrer"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-fg-subtle">
        La foto elegida se guarda en AgentSales antes de usarla (licencia de Pixabay, sin crédito
        obligatorio).
      </p>
    </div>
  );
}

/**
 * «Conseguir imagen» de un post (F9.5-T25, ADR-0038): tres pestañas, en este orden: tarjetas de la
 * marca (siempre), la biblioteca de Pixabay y crear con IA (estas dos, solo con su clave en el
 * servidor; si falta, dicen cuál). Lo conseguido entra como un medio más del post y pasa por la
 * vista previa y la aprobación. Un post de video hace el video de las tarjetas.
 */
export function GetImagePanel({
  post,
  lockReason,
}: {
  post: Pick<PostJson, "id" | "kind">;
  lockReason: string | null;
}) {
  const ids = useId();
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("card");
  const [format, setFormat] = useState<PostImageFormat>("4:5");
  const [prompt, setPrompt] = useState<string | null>(null);
  const options = usePostImageOptions(post.id, open);
  const request = useRequestPostImage(post.id);
  const remove = useRemovePostCards(post.id);
  // Por defecto se quitan las tarjetas anteriores: lo normal es rehacerlas, no sumarlas.
  const [replace, setReplace] = useState(true);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const queryClient = useQueryClient();
  const latest = options.data?.runs[0];
  const wasActive = useRef(false);
  const active = imageRunActive(options.data);
  // Cuando el pedido termina bien, el detalle del post trae los medios nuevos.
  useEffect(() => {
    if (wasActive.current && !active) {
      void queryClient.invalidateQueries({ queryKey: postKeys.detail(post.id), exact: true });
    }
    wasActive.current = active;
  }, [active, post.id, queryClient]);
  if (post.kind === "text" || lockReason !== null) return null;

  const video = post.kind === "video";
  const busy = request.isPending || active;
  if (!open) {
    return (
      <div id={GET_IMAGE_ANCHOR} className="mt-4 border-t border-line pt-4">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Conseguir imagen
        </Button>
        <p className="mt-1.5 text-xs text-fg-subtle">
          {video
            ? "Un video con las tarjetas de la marca y el texto del post, sin costo."
            : "Tarjetas con el texto del post y tu marca (sin costo), una foto de la biblioteca o una imagen con IA."}
        </p>
      </div>
    );
  }
  const data = options.data;
  const existing = data?.cards?.existing ?? 0;
  return (
    <section
      id={GET_IMAGE_ANCHOR}
      aria-label="Conseguir imagen"
      className="mt-4 space-y-3 border-t border-line pt-4"
    >
      <div
        role="tablist"
        aria-label="De dónde sale la imagen"
        className="flex flex-wrap gap-1 rounded-lg bg-sand p-1"
        onKeyDown={(event) => {
          const next = nextTab(tab, event.key);
          if (next === null) return;
          event.preventDefault();
          setTab(next);
          tabRefs.current.get(next)?.focus();
        }}
      >
        {TABS.map((item) => (
          <button
            key={item.key}
            ref={(element) => {
              if (element === null) tabRefs.current.delete(item.key);
              else tabRefs.current.set(item.key, element);
            }}
            type="button"
            role="tab"
            id={`${ids}-${item.key}`}
            aria-selected={tab === item.key}
            aria-controls={`${ids}-panel`}
            tabIndex={tab === item.key ? 0 : -1}
            onClick={() => setTab(item.key)}
            className={`rounded-md px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
              tab === item.key
                ? "bg-surface font-semibold text-fg shadow-xs ring-1 ring-line"
                : "font-medium text-fg-muted hover:text-fg"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${ids}-panel`}
        aria-labelledby={`${ids}-${tab}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA pide que el panel de una pestaña se pueda enfocar (patrón Tabs).
        tabIndex={0}
        className="space-y-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        {data === undefined ? (
          options.error !== null ? (
            <ErrorAlert error={options.error} />
          ) : (
            <p className="text-sm text-fg-muted">Cargando…</p>
          )
        ) : tab === "card" ? (
          <div className="space-y-3">
            <p className="text-sm text-fg-muted">
              {video
                ? "Une en un video la portada (el tema), un punto del texto por tarjeta y el cierre con tu marca, con la música del post. Sin costo."
                : post.kind === "carousel"
                  ? "Una portada con el tema, una tarjeta por punto del texto y un cierre con tu marca, sobre tus colores y tu logo. Sin costo."
                  : "Una tarjeta con el tema del post sobre tus colores y tu logo. Sin costo."}
            </p>
            {data.cards !== null && (
              <p role="status" className="text-sm font-medium text-fg">
                {data.cards.count === null ? data.cards.message : `Saldrán ${data.cards.message}`}
              </p>
            )}
            {existing > 0 && (
              <div className="space-y-2 rounded-md bg-warning-50 p-3 text-sm text-warning-800">
                <p>
                  {video
                    ? "Este post ya tiene un video de tarjetas de un pedido anterior."
                    : existing === 1
                      ? "Este post ya tiene 1 tarjeta de un pedido anterior."
                      : `Este post ya tiene ${existing} tarjetas de pedidos anteriores.`}{" "}
                  Si no las quitas, las nuevas se suman; si las quitas, se reemplazan cuando las
                  nuevas estén listas (si algo falla, se quedan las que tenías). Solo se quitan las
                  tarjetas: lo que subiste tú, las fotos de la biblioteca y las imágenes con IA no
                  se tocan (salvo que una foto tuya sea idéntica a una tarjeta).
                </p>
                <label className="flex items-center gap-2 text-fg">
                  <input
                    type="checkbox"
                    checked={replace}
                    onChange={(event) => setReplace(event.target.checked)}
                  />
                  Quitar las tarjetas anteriores
                </label>
              </div>
            )}
            {!video && <FormatSelect value={format} onChange={setFormat} />}
            <div className="flex flex-wrap gap-2">
              <Button
                loading={busy}
                onClick={() =>
                  request.mutate({
                    source: "card",
                    format: video ? "9:16" : format,
                    ...(existing > 0 && replace ? { replaceCards: true } : {}),
                  })
                }
              >
                {video ? "Hacer video de las tarjetas" : "Hacer tarjetas"}
              </Button>
              {existing > 0 && !confirmRemove && (
                <Button variant="secondary" disabled={busy} onClick={() => setConfirmRemove(true)}>
                  Solo quitar las tarjetas anteriores
                </Button>
              )}
            </div>
            {existing > 0 && confirmRemove && (
              <div
                role="alertdialog"
                aria-label="Confirmar quitar las tarjetas"
                className="space-y-2 rounded-md bg-danger-50 p-3 text-sm text-danger-800"
              >
                <p>
                  ¿Quitar las tarjetas anteriores del post sin hacer otras? No se puede deshacer.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    loading={remove.isPending}
                    onClick={() =>
                      remove.mutate(undefined, { onSettled: () => setConfirmRemove(false) })
                    }
                  >
                    Sí, quitarlas
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={remove.isPending}
                    onClick={() => setConfirmRemove(false)}
                  >
                    Cancelar
                  </Button>
                </div>
              </div>
            )}
            {remove.data !== undefined && remove.data.leftover > 0 && (
              <p role="status" className="text-sm text-warning-800">
                Se quitaron las tarjetas, pero {remove.data.leftover} archivo(s) no se pudieron
                borrar del almacenamiento. No afectan al post.
              </p>
            )}
            {remove.error !== null && <ErrorAlert error={remove.error} />}
          </div>
        ) : video ? (
          <p className="text-sm text-fg-muted">
            Un post de video usa el video de las tarjetas o un video que subas.
          </p>
        ) : tab === "stock" ? (
          <StockTab
            postId={post.id}
            options={data}
            busy={busy}
            onPick={(photo, query) =>
              request.mutate({ source: "stock", photoId: photo.id, query, format })
            }
          />
        ) : !data.sources.ai.available ? (
          <Missing what="Crear con IA" variable={data.sources.ai.missing} />
        ) : (
          <div className="space-y-3">
            <Field
              label="Indicación para la IA"
              hint="La propone el post; cámbiala si quieres. La imagen sale sin texto ni personas reconocibles."
            >
              <Textarea
                rows={3}
                maxLength={1000}
                value={prompt ?? data.suggestions.prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </Field>
            <FormatSelect value={format} onChange={setFormat} />
            <p
              className={`text-sm ${data.sources.ai.capReached ? "text-danger-700" : "text-fg-muted"}`}
            >
              {data.sources.ai.capReached
                ? "Llegaste al tope de imágenes con IA de este mes."
                : `${formatUsd(data.sources.ai.priceUsd ?? 0)} por imagen · llevas ${formatUsd(data.sources.ai.spentUsd)} de ${formatUsd(data.sources.ai.capUsd ?? 0)} este mes.`}
            </p>
            <p className="text-xs text-fg-subtle">
              El modelo y el precio por imagen son los de la configuración y están sin verificar
              hasta la prueba del operador: el gasto es una estimación.
            </p>
            <Button
              loading={busy}
              disabled={
                data.sources.ai.capReached || (prompt ?? data.suggestions.prompt).trim().length < 3
              }
              onClick={() =>
                request.mutate({
                  source: "ai",
                  prompt: (prompt ?? data.suggestions.prompt).trim(),
                  format,
                })
              }
            >
              Crear imagen
            </Button>
          </div>
        )}
      </div>
      <RunStatus run={latest} />
      {request.error !== null && <ErrorAlert error={request.error} />}
    </section>
  );
}
