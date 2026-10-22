import type { ContentEditBody, ContentView } from "@agentsales/api/contracts";
import { CONTENT_STATUS_TEXT, PLATFORM_TEXT } from "@agentsales/core";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../../api/client.js";
import { useEditContent } from "../../queries/content.js";
import { ErrorAlert } from "../ErrorAlert.js";
import type { PreviewText } from "../preview/preview.js";
import { Button } from "../ui/Button.js";
import { Input, Textarea } from "../ui/Field.js";
import { Checks } from "./Checks.js";
import { type Counter, parseHashtags, textCounter } from "./editor.js";

/** `123 / 2200`, en rojo y con lo que sobra si se pasa (la revisión lo marcará como error). */
function CounterText({ counter, id }: { counter: Counter; id: string }) {
  return (
    <p
      id={id}
      className={`mt-1 text-xs ${counter.over ? "font-semibold text-danger-700" : "text-fg-muted"}`}
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
      <div
        role="alert"
        className="mt-3 rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm"
      >
        <p className="font-semibold text-warning-800">Este texto ya no es el vigente</p>
        <p className="mt-1 text-warning-800">
          Una preparación nueva lo reemplazó mientras lo editabas. Recarga el contenido y vuelve a
          editar el texto nuevo.
        </p>
        <Button size="sm" onClick={onReload} className="mt-2">
          Recargar el contenido
        </Button>
      </div>
    );
  }
  if (error instanceof ApiError && error.code === "CONTENT_RUN_ACTIVE") {
    return (
      <div
        role="alert"
        className="mt-3 rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm"
      >
        <p className="font-semibold text-warning-800">
          No se guardó: se están regenerando los textos
        </p>
        <p className="mt-1 text-warning-800">
          Espera a que termine la preparación; después podrás editar el texto nuevo.
        </p>
      </div>
    );
  }
  return <ErrorAlert error={error} />;
}

/**
 * El formulario de edición de un texto. Si el texto cambia mientras se edita (una preparación nueva
 * lo reemplazó), el borrador se conserva y guardar pide decidir: sobre el texto nuevo o descartarlo.
 */
function Editor({
  content,
  listingId,
  lockReason,
  onClose,
  onReload,
  onDraft,
}: {
  content: ContentView;
  listingId: string;
  lockReason: string | null;
  onClose: () => void;
  onReload: () => void;
  onDraft?: ((draft: PreviewText | null) => void) | undefined;
}) {
  const ids = useId();
  const instagram = content.platform === "instagram";
  // El texto sobre el que se empezó a editar: si el vigente cambia, el borrador queda "viejo".
  const [base, setBase] = useState(content);
  const [title, setTitle] = useState(content.title ?? "");
  const [body, setBody] = useState(content.body);
  const [hashtags, setHashtags] = useState(content.hashtags.join(" "));
  const save = useEditContent(listingId);
  const stale = base.id !== content.id;

  // La vista previa sigue al borrador mientras se escribe (F9.5-T07): cada cambio se avisa con el
  // texto como lo guardaría la API, y al cerrar el editor la vista previa vuelve al guardado.
  const draftOf = (next: { title: string; body: string; hashtags: string }): PreviewText => ({
    title: instagram ? null : next.title.trim(),
    body: next.body.trim(),
    hashtags: instagram ? parseHashtags(next.hashtags) : [],
  });
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const firstDraft = useRef(draftOf({ title, body, hashtags }));
  useEffect(() => {
    onDraftRef.current?.(firstDraft.current);
    return () => onDraftRef.current?.(null);
  }, []);
  const change = (next: Partial<{ title: string; body: string; hashtags: string }>) => {
    const merged = { title, body, hashtags, ...next };
    if (next.title !== undefined) setTitle(next.title);
    if (next.body !== undefined) setBody(next.body);
    if (next.hashtags !== undefined) setHashtags(next.hashtags);
    onDraft?.(draftOf(merged));
  };

  const parsedTags = parseHashtags(hashtags);
  const counter = textCounter(content.platform, {
    title: instagram ? null : title.trim(),
    body,
    hashtags: instagram ? parsedTags : [],
  });
  const edit: ContentEditBody = instagram
    ? { body: body.trim(), hashtags: parsedTags }
    : { title: title.trim(), body: body.trim() };
  const changed = instagram
    ? body.trim() !== base.body || parsedTags.join(" ") !== base.hashtags.join(" ")
    : title.trim() !== (base.title ?? "") || body.trim() !== base.body;
  const blank = body.trim() === "" || (!instagram && title.trim() === "");
  const discard = () => {
    setBase(content);
    change({
      title: content.title ?? "",
      body: content.body,
      hashtags: content.hashtags.join(" "),
    });
  };
  const counterId = `${ids}-counter`;
  const blankId = `${ids}-blank`;
  const describedBy = (...extra: string[]) => [counterId, ...extra].join(" ");

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
        <label className="block text-sm font-medium text-fg">
          Título
          <Input
            value={title}
            onChange={(event) => change({ title: event.target.value })}
            aria-describedby={describedBy(blankId)}
            aria-invalid={title.trim() === ""}
            className="mt-1"
          />
        </label>
      )}
      <label className="block text-sm font-medium text-fg">
        {instagram ? "Texto" : "Descripción"}
        <Textarea
          value={body}
          onChange={(event) => change({ body: event.target.value })}
          rows={instagram ? 10 : 14}
          aria-describedby={instagram ? describedBy(blankId) : blankId}
          aria-invalid={body.trim() === ""}
          className="mt-1"
        />
      </label>
      {instagram && (
        <div>
          <label className="block text-sm font-medium text-fg">
            Hashtags
            <Input
              value={hashtags}
              onChange={(event) => change({ hashtags: event.target.value })}
              placeholder="#nunoa #departamento"
              aria-describedby={describedBy(`${ids}-tags`)}
              className="mt-1"
            />
          </label>
          <p id={`${ids}-tags`} className="mt-1 text-xs text-fg-subtle">
            Separados por espacios. Se guardan sin tildes ni mayúsculas.
          </p>
        </div>
      )}
      <CounterText counter={counter} id={counterId} />
      <p id={blankId} className="text-xs text-danger-700">
        {blank
          ? instagram
            ? "El texto no puede quedar vacío."
            : "El título y la descripción no pueden quedar vacíos."
          : ""}
      </p>
      {lockReason !== null && (
        <p role="alert" className="text-sm text-warning-800">
          {lockReason} Tu edición queda aquí hasta que termine.
        </p>
      )}
      {stale && lockReason === null && (
        <div
          role="alert"
          className="rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm"
        >
          <p className="font-semibold text-warning-800">El texto cambió mientras editabas</p>
          <p className="mt-1 text-warning-800">
            Una preparación nueva lo reemplazó. Tu borrador sigue aquí: guárdalo sobre el texto
            nuevo o descártalo para ver el nuevo.
          </p>
          <Button variant="secondary" size="sm" onClick={discard} className="mt-2">
            Descartar mi borrador
          </Button>
        </div>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          type="submit"
          disabled={save.isPending || (!changed && !stale) || blank || lockReason !== null}
        >
          {save.isPending ? "Guardando…" : stale ? "Guardar sobre el texto nuevo" : "Guardar"}
        </Button>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={save.isPending}>
          Cancelar
        </Button>
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
 * Un texto de un canal: su estado, lo que arma quien lo usa (`children`, opcional), su revisión y
 * "Editar", o el formulario de edición. `lockReason` bloquea la edición mientras se regeneran los
 * textos. `onDraft` recibe el borrador mientras se edita (y `null` al cerrar), para la vista previa.
 */
export function EditableText({
  content,
  listingId,
  lockReason,
  onReload,
  onDraft,
  children,
}: {
  content: ContentView;
  listingId: string;
  lockReason: string | null;
  onReload: () => void;
  onDraft?: ((draft: PreviewText | null) => void) | undefined;
  children?: ReactNode;
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
        onDraft={onDraft}
      />
    );
  }
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-fg-subtle">
          Texto: {CONTENT_STATUS_TEXT[content.status]}
          {content.status === "edited" ? "" : ` · ${content.promptVersion}`}
        </p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setEditing(true)}
          disabled={lockReason !== null}
        >
          Editar
        </Button>
      </div>
      {lockReason !== null && <p className="mt-1 text-xs text-warning-800">{lockReason}</p>}
      {children}
      <Checks content={content} />
    </>
  );
}
