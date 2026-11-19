import type { BrandKnowledgeResponse } from "@agentsales/api/contracts";
import { BRAND_KNOWLEDGE_LIMITS } from "@agentsales/core";
import { type FormEvent, useState } from "react";
import {
  useAddKnowledgeUpdate,
  useArchiveKnowledgeUpdate,
  useBrandKnowledge,
  useSaveBrandKnowledge,
} from "../../queries/brand-knowledge.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Button } from "../ui/Button.js";
import { Field, Input, Textarea } from "../ui/Field.js";
import { KnowledgeProposals } from "./KnowledgeProposals.js";

// «Conocimiento» en Mi marca (spec F9.7 B1 y B2, ADR-0043): qué queremos transmitir, el tono y la
// forma de contar, los ejemplos que gustan (guía de forma, nunca de hechos), las novedades de los
// proyectos (fuente de hechos) y «Actualizar desde un texto» (la IA propone; tú decides).

type Knowledge = BrandKnowledgeResponse["knowledge"];
type ExampleRow = { text: string; note: string; favorite: boolean };

const L = BRAND_KNOWLEDGE_LIMITS;

/** Hoy en Chile, `AAAA-MM-DD`. */
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date());

function VoiceForm({ brokerId, knowledge }: { brokerId: string; knowledge: Knowledge }) {
  const save = useSaveBrandKnowledge(brokerId);
  const [stance, setStance] = useState(knowledge.stance ?? "");
  const [tone, setTone] = useState(knowledge.tone ?? "");
  const [examples, setExamples] = useState<ExampleRow[]>(
    knowledge.examples.map((example) => ({
      text: example.text,
      note: example.note ?? "",
      favorite: example.favorite,
    })),
  );
  const change = (index: number, patch: Partial<ExampleRow>) =>
    setExamples((rows) => rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({
      stance: stance.trim() === "" ? null : stance,
      tone: tone.trim() === "" ? null : tone,
      examples: examples.map((row) => ({
        text: row.text,
        note: row.note.trim() === "" ? null : row.note,
        favorite: row.favorite,
      })),
    });
  };
  return (
    <form onSubmit={submit} className="mt-3 space-y-4" aria-label="Voz de la marca">
      <Field
        label="Qué queremos transmitir"
        hint={`La postura de la marca, en tus palabras (hasta ${L.stance.toLocaleString("es-CL")} caracteres). Guía el enfoque; no es un hecho.`}
      >
        <Textarea
          rows={4}
          maxLength={L.stance}
          value={stance}
          onChange={(event) => setStance(event.target.value)}
        />
      </Field>
      <Field
        label="Tono y forma de contar"
        hint="Por ejemplo: «un relato con una escena concreta, nada de post de venta»."
      >
        <Textarea
          rows={3}
          maxLength={L.tone}
          value={tone}
          onChange={(event) => setTone(event.target.value)}
        />
      </Field>
      <fieldset>
        <legend className="text-sm font-semibold">Ejemplos que me gustan</legend>
        <p className="text-xs text-fg-subtle">
          Hasta {L.examples}. La IA copia su forma (cómo abren, el ritmo, cómo cierran), nunca sus
          datos: una cifra o un nombre de un ejemplo no se puede afirmar. Los marcados con ★ van
          primero (la IA ve 3).
        </p>
        <ol className="mt-2 space-y-3">
          {examples.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: filas editables sin id propio
            <li key={index} className="rounded-xl border border-line-soft p-3">
              <Field label={`Ejemplo ${index + 1}`}>
                <Textarea
                  rows={4}
                  maxLength={L.example}
                  value={row.text}
                  onChange={(event) => change(index, { text: event.target.value })}
                />
              </Field>
              <Field label="Por qué me gusta" className="mt-2">
                <Input
                  maxLength={L.exampleNote}
                  value={row.note}
                  onChange={(event) => change(index, { note: event.target.value })}
                />
              </Field>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <label className="inline-flex items-center gap-2 text-sm pointer-coarse:min-h-11">
                  <input
                    type="checkbox"
                    checked={row.favorite}
                    onChange={(event) => change(index, { favorite: event.target.checked })}
                  />
                  Favorito ★
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setExamples((rows) => rows.filter((_, at) => at !== index))}
                >
                  Quitar
                </Button>
              </div>
            </li>
          ))}
        </ol>
        {examples.length < L.examples && (
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() =>
              setExamples((rows) => [...rows, { text: "", note: "", favorite: false }])
            }
          >
            Agregar un ejemplo
          </Button>
        )}
      </fieldset>
      {save.error && <ErrorAlert error={save.error} />}
      <div className="flex items-center gap-3">
        <Button type="submit" loading={save.isPending}>
          Guardar la voz
        </Button>
        <p role="status" className="text-sm text-success-800">
          {save.isSuccess && "Guardado."}
        </p>
      </div>
    </form>
  );
}

function Updates({ brokerId, knowledge }: { brokerId: string; knowledge: Knowledge }) {
  const add = useAddKnowledgeUpdate(brokerId);
  const archive = useArchiveKnowledgeUpdate(brokerId);
  const [project, setProject] = useState("");
  const [date, setDate] = useState(today);
  const [text, setText] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    add.mutate(
      { project, date, text },
      {
        onSuccess: () => {
          setText("");
        },
      },
    );
  };
  return (
    <div className="mt-6">
      <h3 className="text-base font-semibold">Novedades de los proyectos</h3>
      <p className="text-xs text-fg-subtle">
        Son hechos: la IA las puede afirmar. Ve las de los últimos 90 días (hoy,{" "}
        {knowledge.updatesForAi}
        ). Archiva las que ya no son verdad.
      </p>
      {knowledge.updates.length === 0 ? (
        <p className="mt-2 text-sm text-fg-muted">Todavía no hay novedades.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {knowledge.updates.map((update) => (
            <li
              key={update.id}
              className="flex flex-wrap items-start justify-between gap-2 rounded-xl border border-line-soft p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs text-fg-subtle">
                  {`${update.date} · ${update.project}${update.source === "proposal" ? " · propuesta aceptada" : ""}`}
                </p>
                <p className="whitespace-pre-wrap text-sm">{update.text}</p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                loading={archive.isPending && archive.variables === update.id}
                onClick={() => archive.mutate(update.id)}
              >
                Archivar
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={submit}
        className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto]"
        aria-label="Nueva novedad"
      >
        <Field label="Proyecto" hint="Ej.: «AgentPey en Stellar», «Comercios · Start-Up Chile»">
          <Input
            maxLength={L.project}
            value={project}
            onChange={(e) => setProject(e.target.value)}
          />
        </Field>
        <Field label="Fecha">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} width="auto" />
        </Field>
        <Field label="Qué pasó" className="sm:col-span-2">
          <Textarea
            rows={2}
            maxLength={L.updateText}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        {add.error && (
          <div className="sm:col-span-2">
            <ErrorAlert error={add.error} />
          </div>
        )}
        <div>
          <Button type="submit" variant="secondary" loading={add.isPending}>
            Agregar la novedad
          </Button>
        </div>
      </form>
    </div>
  );
}

/** La sección «Conocimiento» de Mi marca. */
export function KnowledgeSection({ brokerId }: { brokerId: string }) {
  const knowledge = useBrandKnowledge(brokerId);
  return (
    <section aria-label="Conocimiento" className="mt-6">
      <h2 className="text-lg font-semibold">Conocimiento</h2>
      <p className="text-sm text-fg-muted">
        Lo que la IA sabe de la marca además del perfil: su voz, ejemplos de forma y las novedades
        de sus proyectos. Lo usa al proponer ideas y al redactar.
      </p>
      {knowledge.error && (
        <ErrorAlert error={knowledge.error} onRetry={() => void knowledge.refetch()} />
      )}
      {knowledge.data === undefined ? (
        !knowledge.error && <p className="mt-2 text-sm text-fg-muted">Cargando…</p>
      ) : (
        <>
          <VoiceForm
            key={`${brokerId}-${knowledge.data.updatedAt?.toISOString() ?? "nuevo"}`}
            brokerId={brokerId}
            knowledge={knowledge.data}
          />
          <Updates brokerId={brokerId} knowledge={knowledge.data} />
          <KnowledgeProposals brokerId={brokerId} />
        </>
      )}
    </section>
  );
}
