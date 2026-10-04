import type { ContentEditBody, ContentView } from "@agentsales/api/contracts";
import { CONTENT_STATUS_TEXT, PLATFORM_TEXT } from "@agentsales/core";
import { type ReactNode, useId, useState } from "react";
import { ApiError } from "../../api/client.js";
import { useEditContent } from "../../queries/content.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Checks } from "./Checks.js";
import { type Counter, captionCounter, parseHashtags, titleCounter } from "./editor.js";

const FIELD =
  "mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none";

/** `123 / 2200`, en rojo y con lo que sobra si se pasa (la revisión lo marcará como error). */
function CounterText({ counter, id }: { counter: Counter; id: string }) {
  return (
    <p
      id={id}
      className={`mt-1 text-xs ${counter.over ? "font-semibold text-red-700" : "text-slate-500"}`}
    >
      {counter.length} / {counter.max} caracteres
      {counter.over ? ` · se pasa por ${counter.length - counter.max}` : ""}
    </p>
  );
}

/** Lo que la API puede responder al guardar, en lenguaje del operador. */
function SaveError({ error, onReload }: { error: Error; onReload: () => void }) {
  if (error instanceof ApiError && error.code === "CONTENT_NOT_CURRENT") {
    return (
      <div role="alert" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
        <p className="font-semibold text-amber-900">Este texto ya no es el vigente</p>
        <p className="mt-1 text-amber-900">
          Una preparación nueva lo reemplazó mientras lo editabas. Recarga el contenido y vuelve a
          editar el texto nuevo.
        </p>
        <button
          type="button"
          onClick={onReload}
          className="mt-2 rounded-md bg-amber-700 px-3 py-1.5 font-medium text-white"
        >
          Recargar el contenido
        </button>
      </div>
    );
  }
  if (error instanceof ApiError && error.code === "CONTENT_RUN_ACTIVE") {
    return (
      <div role="alert" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
        <p className="font-semibold text-amber-900">
          No se guardó: se están regenerando los textos
        </p>
        <p className="mt-1 text-amber-900">
          Espera a que termine la preparación; después podrás editar el texto nuevo.
        </p>
      </div>
    );
  }
  return <ErrorAlert error={error} />;
}

/** El formulario de edición de un texto. */
function Editor({
  content,
  listingId,
  lockReason,
  onClose,
  onReload,
}: {
  content: ContentView;
  listingId: string;
  lockReason: string | null;
  onClose: () => void;
  onReload: () => void;
}) {
  const ids = useId();
  const instagram = content.platform === "instagram";
  const [title, setTitle] = useState(content.title ?? "");
  const [body, setBody] = useState(content.body);
  const [hashtags, setHashtags] = useState(content.hashtags.join(" "));
  const save = useEditContent(listingId);

  const parsedTags = parseHashtags(hashtags);
  const counter = instagram ? captionCounter(body, parsedTags) : titleCounter(title);
  const edit: ContentEditBody = instagram
    ? { body, hashtags: parsedTags }
    : { title: title.trim(), body };
  const changed = instagram
    ? body !== content.body || parsedTags.join(" ") !== content.hashtags.join(" ")
    : title.trim() !== (content.title ?? "") || body !== content.body;
  const blank = body.trim() === "" || (!instagram && title.trim() === "");

  return (
    <form
      aria-label={`Editar el texto de ${PLATFORM_TEXT[content.platform]}`}
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate({ id: content.id, edit }, { onSuccess: onClose });
      }}
      className="space-y-3"
    >
      {!instagram && (
        <label className="block text-sm font-medium text-slate-700">
          Título
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            aria-describedby={`${ids}-counter`}
            className={FIELD}
          />
        </label>
      )}
      <label className="block text-sm font-medium text-slate-700">
        {instagram ? "Texto" : "Descripción"}
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={instagram ? 10 : 14}
          {...(instagram ? { "aria-describedby": `${ids}-counter` } : {})}
          className={FIELD}
        />
      </label>
      {instagram && (
        <div>
          <label className="block text-sm font-medium text-slate-700">
            Hashtags
            <input
              value={hashtags}
              onChange={(event) => setHashtags(event.target.value)}
              placeholder="#nunoa #departamento"
              aria-describedby={`${ids}-tags`}
              className={FIELD}
            />
          </label>
          <p id={`${ids}-tags`} className="mt-1 text-xs text-slate-500">
            Separados por espacios. Se guardan sin tildes ni mayúsculas.
          </p>
        </div>
      )}
      <CounterText counter={counter} id={`${ids}-counter`} />
      {blank && (
        <p className="text-xs text-red-700">
          {instagram
            ? "El texto no puede quedar vacío."
            : "El título y la descripción no pueden quedar vacíos."}
        </p>
      )}
      {lockReason !== null && (
        <p role="alert" className="text-sm text-amber-800">
          {lockReason} Tu edición queda aquí hasta que termine.
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={save.isPending || !changed || blank || lockReason !== null}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {save.isPending ? "Guardando…" : "Guardar"}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={save.isPending}
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 disabled:opacity-50"
        >
          Cancelar
        </button>
      </div>
      {save.error && (
        <SaveError
          error={save.error}
          onReload={() => {
            onClose();
            onReload();
          }}
        />
      )}
    </form>
  );
}

/**
 * Un texto de un canal: la vista (que arma quien lo usa) con su estado, su revisión y "Editar", o
 * el formulario de edición. `lockReason` bloquea la edición mientras se regeneran los textos.
 */
export function EditableText({
  content,
  listingId,
  lockReason,
  onReload,
  children,
}: {
  content: ContentView;
  listingId: string;
  lockReason: string | null;
  onReload: () => void;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <Editor
        content={content}
        listingId={listingId}
        lockReason={lockReason}
        onClose={() => setEditing(false)}
        onReload={onReload}
      />
    );
  }
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-500">
          Texto: {CONTENT_STATUS_TEXT[content.status]}
          {content.status === "edited" ? "" : ` · ${content.promptVersion}`}
        </p>
        <button
          type="button"
          onClick={() => setEditing(true)}
          disabled={lockReason !== null}
          className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50"
        >
          Editar
        </button>
      </div>
      {lockReason !== null && <p className="mt-1 text-xs text-amber-800">{lockReason}</p>}
      {children}
      <Checks content={content} />
    </>
  );
}
