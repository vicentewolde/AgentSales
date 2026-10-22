import { PLAN_EMPTY_PROFILE_WARNING, planProfileIsEmpty } from "@agentsales/core";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { useEditorialProfile } from "../../queries/posts.js";
import { useRole } from "../../scope/broker-scope.js";
import { Button, ButtonLink } from "../ui/Button.js";
import { Textarea } from "../ui/Field.js";
import { Examples, ProfileForm } from "./EditorialProfileForm.js";
import {
  AUDIENCE_EXAMPLE,
  AVOID_EXAMPLES,
  addAudience,
  addLine,
  type Draft,
  draftOf,
  EMPTY_WIZARD_ANSWERS,
  FACT_EXAMPLES,
  lines,
  PILLAR_EXAMPLES,
  type WizardAnswers,
  wizardDraft,
} from "./editorial-profile-draft.js";

// El perfil vacío antes de pedir un plan (F9.5-T23): sin temas ni hechos, las ideas salen genéricas.
// El aviso lleva a Mi marca y ofrece un asistente de 4 preguntas (qué haces, para quién, de qué temas
// hablas, qué no dices) que **llena** el formulario del perfil para revisarlo: no guarda solo. Los
// ejemplos de cada pregunta son los de Mi marca (F9.5-T17).

/** Una pregunta del asistente: su título, su ayuda, el campo y sus ejemplos. */
function Question({
  id,
  label,
  help,
  value,
  onChange,
  examples,
}: {
  id: string;
  label: string;
  help: ReactNode;
  value: string;
  onChange: (value: string) => void;
  examples: readonly { text: string; used: boolean; onPick: () => void }[];
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
      </label>
      <p id={`${id}-help`} className="mt-0.5 text-xs text-fg-subtle">
        {help}
      </p>
      <Textarea
        id={id}
        aria-describedby={`${id}-help`}
        rows={2}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5"
      />
      <Examples label={`Ejemplos: ${label}`} items={examples} />
    </div>
  );
}

/** Las 4 preguntas; al terminar, entrega las respuestas (`onDone`). */
function WizardQuestions({
  initial,
  onDone,
  onCancel,
}: {
  initial: WizardAnswers;
  onDone: (answers: WizardAnswers) => void;
  onCancel: () => void;
}) {
  const ids = useId();
  const [answers, setAnswers] = useState<WizardAnswers>(initial);
  const set = (key: keyof WizardAnswers, value: string) =>
    setAnswers((current) => ({ ...current, [key]: value }));
  const listExamples = (key: "what" | "topics" | "avoid", items: readonly string[]) =>
    items.map((text) => ({
      text,
      used: lines(answers[key]).includes(text),
      onPick: () => set(key, addLine(answers[key], text)),
    }));
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onDone(answers);
  };
  return (
    <form aria-label="Asistente del perfil" onSubmit={submit} className="mt-3 space-y-4">
      <Question
        id={`${ids}-what`}
        label="¿Qué haces?"
        help={
          <>
            Lo que la IA puede afirmar de ti, una frase por línea. Si son un equipo, dilo («Somos un
            equipo de 4 corredores»): solo así las ideas hablan de «nosotros».
          </>
        }
        value={answers.what}
        onChange={(value) => set("what", value)}
        examples={listExamples("what", FACT_EXAMPLES)}
      />
      <Question
        id={`${ids}-who`}
        label="¿Para quién?"
        help="A quién le hablas: quiénes son, qué buscan y dónde."
        value={answers.who}
        onChange={(value) => set("who", value)}
        examples={[
          {
            text: AUDIENCE_EXAMPLE,
            used: answers.who.includes(AUDIENCE_EXAMPLE),
            onPick: () => set("who", addAudience(answers.who, AUDIENCE_EXAMPLE)),
          },
        ]}
      />
      <Question
        id={`${ids}-topics`}
        label="¿De qué temas hablas?"
        help="Un tema por línea: la IA reparte las ideas entre ellos."
        value={answers.topics}
        onChange={(value) => set("topics", value)}
        examples={listExamples(
          "topics",
          PILLAR_EXAMPLES.map((example) => example.name),
        )}
      />
      <Question
        id={`${ids}-avoid`}
        label="¿Qué no dices?"
        help="Temas, palabras o promesas que la IA no usa, una por línea."
        value={answers.avoid}
        onChange={(value) => set("avoid", value)}
        examples={listExamples("avoid", AVOID_EXAMPLES)}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit">
          Llenar el perfil
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

/**
 * Antes de pedir un plan (F9.5-T23): con el perfil de la marca vacío (sin temas ni hechos), avisa
 * que las ideas saldrán genéricas, con un botón a Mi marca (al administrador, a la ficha de la marca)
 * y el asistente de 4 preguntas. El asistente llena el formulario del perfil con las respuestas y
 * el operador lo revisa y lo guarda ahí mismo. Con el perfil lleno, no muestra nada (salvo el
 * asistente ya abierto, para ver «Perfil guardado.»).
 */
export function EmptyProfileNotice({ brandId }: { brandId: string }) {
  const role = useRole();
  const profile = useEditorialProfile(brandId);
  const [open, setOpen] = useState(false);
  const [answers, setAnswers] = useState<WizardAnswers>(EMPTY_WIZARD_ANSWERS);
  const [review, setReview] = useState<Draft | null>(null);
  const saved = profile.data;
  if (saved === undefined) return null;
  const empty = planProfileIsEmpty(saved);
  if (!empty && !open) return null;
  const close = () => {
    setOpen(false);
    setReview(null);
    setAnswers(EMPTY_WIZARD_ANSWERS);
  };
  return (
    <section
      aria-label="Perfil vacío"
      className="mt-4 rounded-xl border border-warning-200 bg-warning-50 p-4"
    >
      {empty && (
        <>
          <p role="status" className="font-semibold text-warning-800">
            {PLAN_EMPTY_PROFILE_WARNING}.
          </p>
          <p className="mt-1 text-sm text-warning-800">
            La IA solo habla de los temas de tu perfil y solo afirma sus hechos. Responde 4
            preguntas y revisa el perfil antes de pedir el plan.
          </p>
        </>
      )}
      {!open && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setOpen(true)}>
            Responder 4 preguntas
          </Button>
          <ButtonLink size="sm" to={role === "admin" ? `/corredores/${brandId}` : "/mi-marca"}>
            {role === "admin" ? "Ir a la ficha de la marca" : "Ir a Mi marca"}
          </ButtonLink>
        </div>
      )}
      {open && review === null && (
        <WizardQuestions
          initial={answers}
          onCancel={close}
          onDone={(done) => {
            setAnswers(done);
            setReview(wizardDraft(draftOf(saved), done));
          }}
        />
      )}
      {open && review !== null && (
        <div className="mt-3">
          <p className="text-sm text-fg">
            Revisa el perfil y guárdalo: nada se guarda hasta que aprietes «Guardar el perfil». Lo
            que va entre [corchetes] en un ejemplo hay que completarlo.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => setReview(null)}>
              Volver a las preguntas
            </Button>
            <Button variant="secondary" size="sm" onClick={close}>
              Cerrar
            </Button>
          </div>
          <div className="mt-2 rounded-lg border border-line bg-surface p-3">
            <ProfileForm brokerId={brandId} profile={saved} initial={review} />
          </div>
        </div>
      )}
    </section>
  );
}
