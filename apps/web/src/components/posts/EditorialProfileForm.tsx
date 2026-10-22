import type { EditorialProfileJson } from "@agentsales/api/contracts";
import {
  EDITORIAL_LIMITS,
  EDITORIAL_WEEKDAYS,
  type EditorialWeekday,
  LANGUAGE_TEXT,
  LANGUAGES,
  type Language,
  PLAN_DEFAULT_SLOT,
  PLATFORM_TEXT,
  POST_PLATFORMS,
  type PostPlatform,
} from "@agentsales/core";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { ApiError } from "../../api/client.js";
import { useEditorialProfile, useSaveEditorialProfile } from "../../queries/posts.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Button } from "../ui/Button.js";
import { Input, Select, Textarea } from "../ui/Field.js";
import { cx } from "../ui/styles.js";
import {
  AUDIENCE_EXAMPLE,
  AVOID_EXAMPLES,
  addAudience,
  addHour,
  addLine,
  type CadenceRow,
  cliWeights,
  DEFAULT_WEIGHT,
  type Draft,
  draftOf,
  FACT_EXAMPLES,
  type Issue,
  levelOf,
  lines,
  PILLAR_EXAMPLES,
  type PillarRow,
  pillarKeyOf,
  profileBody,
  WEIGHT_LEVELS,
  weightOf,
} from "./editorial-profile-draft.js";

// El perfil editorial de una marca (spec F9 §4.3, F9-T09): lo único que la IA usa para escribir sus
// posts. Lo revisa core al guardar (`EDITORIAL_PROFILE_INVALID`) y cada problema llega con su campo
// (`pillars[1].key`, `cadence.x.hours`): el formulario lo muestra junto a ese campo. Desde F9.5-T17
// cada campo trae su ayuda y ejemplos de un corredor que se insertan con un clic, los temas se
// pesan con «Poco / Normal / Mucho» y la cadencia se arma con botones de días y chips de horas; lo
// que se guarda es lo mismo de siempre (`editorial-profile-draft.ts`).

/** La letra de cada día en los botones de la cadencia (el nombre completo va en su etiqueta). */
const DAY_LETTER: Readonly<Record<EditorialWeekday, string>> = {
  mon: "L",
  tue: "M",
  wed: "M",
  thu: "J",
  fri: "V",
  sat: "S",
  sun: "D",
};

/** El nombre completo de cada día, para la etiqueta de su botón («Instagram: lunes»). */
const DAY_NAME: Readonly<Record<EditorialWeekday, string>> = {
  mon: "lunes",
  tue: "martes",
  wed: "miércoles",
  thu: "jueves",
  fri: "viernes",
  sat: "sábado",
  sun: "domingo",
};

/** Lo que usa el plan cuando una red no tiene días u horas (core, `PLAN_DEFAULT_SLOT`). */
const DEFAULT_DAYS_TEXT = `${DAY_NAME[PLAN_DEFAULT_SLOT.days[0] ?? "mon"]} a ${DAY_NAME[PLAN_DEFAULT_SLOT.days.at(-1) ?? "fri"]}`;
const DEFAULT_HOURS_TEXT = PLAN_DEFAULT_SLOT.hours.join(", ");

/** Los problemas que devolvió la API, por campo (`issues` de `EDITORIAL_PROFILE_INVALID`). */
function issuesOf(error: Error | null): Issue[] {
  if (!(error instanceof ApiError) || error.code !== "EDITORIAL_PROFILE_INVALID") return [];
  return (error.issues ?? []).map((issue) => ({
    field: issue.field ?? "",
    message: issue.message,
  }));
}

/** Los mensajes de un campo y de lo que cuelga de él (`pillars` incluye `pillars[0].key`). */
function FieldErrors({
  issues,
  prefix,
  exact = false,
}: {
  issues: readonly Issue[];
  prefix: string;
  exact?: boolean;
}) {
  const mine = issues.filter((issue) =>
    exact
      ? issue.field === prefix
      : issue.field === prefix ||
        issue.field.startsWith(`${prefix}[`) ||
        issue.field.startsWith(`${prefix}.`),
  );
  if (mine.length === 0) return null;
  return (
    <ul className="mt-1 text-xs text-danger-700">
      {mine.map((issue, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: dos mensajes iguales pueden repetirse.
        <li key={index}>{issue.message}</li>
      ))}
    </ul>
  );
}

/** La ayuda de un campo, bajo su título. */
function Help({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-0.5 text-xs text-fg-subtle">
      {children}
    </p>
  );
}

/**
 * Ejemplos que se insertan con un clic (F9.5-T17). Uno ya insertado queda desactivado para no
 * repetirlo. Lo usa también el asistente de 4 preguntas del plan (F9.5-T23).
 */
export function Examples({
  label,
  items,
}: {
  label: string;
  items: readonly { text: string; used: boolean; onPick: () => void }[];
}) {
  return (
    <fieldset aria-label={label} className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-xs text-fg-subtle">Ejemplos:</span>
      {items.map((item) => (
        <button
          key={item.text}
          type="button"
          disabled={item.used}
          onClick={item.onPick}
          className="rounded-full border border-dashed border-brand-300 bg-brand-50 px-2.5 py-0.5 text-xs text-brand-800 not-disabled:hover:bg-brand-100 disabled:cursor-default disabled:opacity-50"
        >
          <span aria-hidden="true">+ </span>
          {item.text}
        </button>
      ))}
    </fieldset>
  );
}

/** La cadencia de una red: posts por semana, días como botones y horas como chips. */
function CadenceEditor({
  platform,
  row,
  languages,
  onChange,
}: {
  platform: PostPlatform;
  row: CadenceRow;
  languages: { primary: Language; second: Language | "" };
  onChange: (change: Partial<CadenceRow>) => void;
}) {
  const name = PLATFORM_TEXT[platform];
  const full = row.hours.length >= EDITORIAL_LIMITS.hoursPerPlatform;
  const addPending = () => {
    if (row.newHour.trim() === "" || full) return;
    onChange({ hours: addHour(row.hours, row.newHour), newHour: "" });
  };
  return (
    <div className="mt-2 space-y-3">
      <label className="flex items-center gap-2">
        Posts por semana
        <Input
          width="auto"
          value={row.postsPerWeek}
          inputMode="numeric"
          onChange={(event) => onChange({ postsPerWeek: event.target.value })}
          className="w-16"
        />
      </label>

      <fieldset aria-label={`Días de ${name}`} className="min-w-0">
        <legend className="text-sm">Días que prefieres</legend>
        <div className="mt-1 flex flex-wrap gap-1">
          {EDITORIAL_WEEKDAYS.map((day) => {
            const on = row.days.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={on}
                aria-label={`${name}: ${DAY_NAME[day]}`}
                title={DAY_NAME[day]}
                onClick={() =>
                  onChange({
                    days: on
                      ? row.days.filter((item) => item !== day)
                      : EDITORIAL_WEEKDAYS.filter(
                          (item) => item === day || row.days.includes(item),
                        ),
                  })
                }
                className={cx(
                  "size-8 rounded-full border text-sm font-medium transition-colors",
                  on
                    ? "border-brand-700 bg-brand-700 text-white"
                    : "border-line-strong bg-surface text-fg-muted hover:bg-slate-50",
                )}
              >
                {DAY_LETTER[day]}
              </button>
            );
          })}
        </div>
        {row.days.length === 0 && (
          <Help>Sin días elegidos: el plan usa de {DEFAULT_DAYS_TEXT}.</Help>
        )}
      </fieldset>

      <div>
        <span className="text-sm">Horas que prefieres (hora de Chile)</span>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {row.hours.length === 0 ? (
            <span className="text-xs text-fg-subtle">
              Sin horas elegidas: el plan usa las {DEFAULT_HOURS_TEXT}.
            </span>
          ) : (
            <ul aria-label={`Horas de ${name}`} className="flex flex-wrap gap-1.5">
              {row.hours.map((hour) => (
                <li
                  key={hour}
                  className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pr-1 pl-2.5 text-sm text-slate-800 ring-1 ring-slate-200 ring-inset"
                >
                  {hour}
                  <button
                    type="button"
                    aria-label={`Quitar las ${hour} de ${name}`}
                    onClick={() => onChange({ hours: row.hours.filter((item) => item !== hour) })}
                    className="rounded-full px-1 text-slate-500 hover:bg-slate-200 hover:text-slate-800"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Input
            width="auto"
            type="time"
            aria-label={`Hora nueva en ${name}`}
            value={row.newHour}
            onChange={(event) => onChange({ newHour: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addPending();
              }
            }}
            className="w-32"
          />
          <Button
            variant="secondary"
            size="sm"
            aria-label={`Agregar la hora en ${name}`}
            disabled={row.newHour.trim() === "" || full}
            onClick={addPending}
          >
            Agregar
          </Button>
        </div>
        {full && (
          <Help>
            Son {EDITORIAL_LIMITS.hoursPerPlatform} horas como máximo: quita una para agregar otra.
          </Help>
        )}
      </div>

      {languages.second !== "" && (
        <div>
          <label className="flex items-center gap-2">
            Horas entre idiomas
            <Input
              width="auto"
              value={row.languageGapHours}
              inputMode="numeric"
              onChange={(event) => onChange({ languageGapHours: event.target.value })}
              className="w-16"
            />
          </label>
          <Help>
            Cada post sale una vez por idioma. Son las horas que separan el texto en{" "}
            {LANGUAGE_TEXT[languages.primary]} del texto en {LANGUAGE_TEXT[languages.second]} en{" "}
            {name} (de 1 a 48).
          </Help>
        </div>
      )}
    </div>
  );
}

/**
 * El formulario, ya con el perfil cargado (se monta de nuevo si cambia de marca). Con `initial`,
 * empieza con ese borrador en vez del perfil guardado (el asistente del plan, F9.5-T23): nada se
 * guarda hasta apretar «Guardar el perfil».
 */
export function ProfileForm({
  brokerId,
  profile,
  initial,
}: {
  brokerId: string;
  profile: EditorialProfileJson;
  initial?: Draft;
}) {
  const ids = useId();
  const save = useSaveEditorialProfile(brokerId);
  const [draft, setDraft] = useState<Draft>(() => initial ?? draftOf(profile));
  const [local, setLocal] = useState<Issue[]>([]);
  const issues = local.length > 0 ? local : issuesOf(save.error);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (save.isSuccess) save.reset();
  };
  const setPillar = (index: number, change: Partial<PillarRow>) =>
    set(
      "pillars",
      draft.pillars.map((pillar, at) => (at === index ? { ...pillar, ...change } : pillar)),
    );
  const setCadence = (platform: PostPlatform, change: Partial<CadenceRow>) =>
    set("cadence", { ...draft.cadence, [platform]: { ...draft.cadence[platform], ...change } });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { body, issues: wrong } = profileBody(draft);
    setLocal(wrong);
    if (wrong.length > 0) {
      save.reset();
      return;
    }
    save.mutate(body, {
      // Lo guardado manda: las claves que se armaron solas quedan fijas (los posts y los planes las
      // guardan, y renombrar el tema no debe cambiarlas) y la hora pendiente ya es un chip.
      onSuccess: (saved) =>
        setDraft((current) => ({
          ...current,
          pillars: current.pillars.map((pillar, index) => ({
            ...pillar,
            key: saved.pillars[index]?.key ?? pillar.key,
          })),
          cadence: Object.fromEntries(
            POST_PLATFORMS.map((platform) => {
              const row = current.cadence[platform];
              const entry = saved.cadence[platform];
              return [
                platform,
                entry === undefined ? row : { ...row, hours: [...entry.hours], newHour: "" },
              ];
            }),
          ) as Draft["cadence"],
        })),
    });
  };
  const otherIssues = issues.filter(
    (issue) =>
      !["languages", "audience", "pillars", "facts", "avoid", "cadence", "defaultHashtags"].some(
        (field) => issue.field === field || issue.field.startsWith(field),
      ),
  );
  const oddWeights = cliWeights(draft.pillars);
  const pillarNames = draft.pillars.map((pillar) => pillar.name.trim().toLowerCase());
  const factLines = lines(draft.facts);
  const avoidLines = lines(draft.avoid);

  return (
    <form aria-label="Perfil editorial" className="mt-2 space-y-6" onSubmit={submit}>
      <fieldset>
        <legend className="text-sm font-medium text-fg">Idiomas</legend>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
          <label htmlFor={`${ids}-primary`}>Principal</label>
          <Select
            width="auto"
            id={`${ids}-primary`}
            value={draft.primary}
            onChange={(event) => set("primary", event.target.value as Language)}
          >
            {LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {LANGUAGE_TEXT[language]}
              </option>
            ))}
          </Select>
          <label htmlFor={`${ids}-second`}>Segundo idioma</label>
          <Select
            width="auto"
            id={`${ids}-second`}
            value={draft.second}
            onChange={(event) => set("second", event.target.value as Language | "")}
          >
            <option value="">ninguno</option>
            {LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {LANGUAGE_TEXT[language]}
              </option>
            ))}
          </Select>
        </div>
        <Help>
          Con dos idiomas, cada red tiene un texto por idioma, que se publican por separado (y la IA
          cuesta el doble).
        </Help>
        <FieldErrors issues={issues} prefix="languages" />
      </fieldset>

      <div>
        <label htmlFor={`${ids}-audience`} className="block text-sm font-medium text-fg">
          Público
        </label>
        <Help id={`${ids}-audience-help`}>
          A quién le habla tu marca, en una o dos frases: quiénes son, qué buscan y dónde.
        </Help>
        <Textarea
          id={`${ids}-audience`}
          aria-describedby={`${ids}-audience-help`}
          value={draft.audience}
          onChange={(event) => set("audience", event.target.value)}
          rows={2}
          className="mt-1.5"
        />
        <Examples
          label="Ejemplos de público"
          items={[
            {
              text: AUDIENCE_EXAMPLE,
              used: draft.audience.includes(AUDIENCE_EXAMPLE),
              onPick: () => set("audience", addAudience(draft.audience, AUDIENCE_EXAMPLE)),
            },
          ]}
        />
        <FieldErrors issues={issues} prefix="audience" />
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-fg">Temas de la marca</legend>
        <Help>
          De qué publica tu marca y cuánto de cada tema. Al proponer ideas, la IA reparte según
          «cuánto»: un tema con «Mucho» recibe el triple de ideas que uno con «Poco».
        </Help>
        {oddWeights.length > 0 && (
          <p className="mt-1 text-xs text-warning-800">
            Algunos temas tienen un peso puesto con la CLI ({oddWeights.join(", ")}); mezclado con
            Poco/Normal/Mucho, el reparto no es el que dicen los nombres.
          </p>
        )}
        <ul className="mt-2 space-y-2">
          {draft.pillars.map((pillar, index) => {
            const n = index + 1;
            const level = levelOf(pillar.weight);
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: las filas no tienen otro id hasta guardar.
                key={index}
                aria-label={`Tema ${n}`}
                className="grid gap-2 rounded-lg border border-line bg-surface p-3 sm:grid-cols-[1fr_9rem_auto]"
              >
                <Input
                  aria-label={`Nombre del tema ${n}`}
                  value={pillar.name}
                  onChange={(event) => setPillar(index, { name: event.target.value })}
                  placeholder="Propiedades disponibles"
                />
                <Select
                  aria-label={`Cuánto del tema ${n}`}
                  value={String(pillar.weight)}
                  onChange={(event) => setPillar(index, { weight: Number(event.target.value) })}
                >
                  {WEIGHT_LEVELS.map((item) => (
                    <option key={item.value} value={String(item.value)}>
                      {item.label}
                    </option>
                  ))}
                  {level === null && (
                    <option value={String(pillar.weight)}>
                      Como está (peso {pillar.weight}, de la CLI)
                    </option>
                  )}
                </Select>
                <Button
                  variant="link"
                  className="justify-self-start text-sm"
                  aria-label={`Quitar el tema ${n}`}
                  onClick={() =>
                    set(
                      "pillars",
                      draft.pillars.filter((_, at) => at !== index),
                    )
                  }
                >
                  Quitar
                </Button>
                <Textarea
                  aria-label={`Qué incluye el tema ${n}`}
                  value={pillar.description}
                  onChange={(event) => setPillar(index, { description: event.target.value })}
                  rows={1}
                  placeholder="Qué incluye (opcional)"
                  className="sm:col-span-3"
                />
                <label className="flex flex-wrap items-center gap-2 text-xs text-fg-subtle sm:col-span-3">
                  Clave interna
                  <Input
                    width="auto"
                    aria-label={`Clave interna del tema ${n}`}
                    value={pillar.key}
                    onChange={(event) => setPillar(index, { key: event.target.value })}
                    placeholder={pillarKeyOf(pillar.name) || "se arma sola desde el nombre"}
                    className="w-56 py-1 text-xs"
                  />
                  <span>(la usan los posts; si la dejas vacía, se arma sola desde el nombre)</span>
                </label>
                <div className="sm:col-span-3">
                  <FieldErrors issues={issues} prefix={`pillars[${index}]`} />
                </div>
              </li>
            );
          })}
        </ul>
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={() =>
            set("pillars", [
              ...draft.pillars,
              { key: "", name: "", description: "", weight: DEFAULT_WEIGHT },
            ])
          }
        >
          Agregar un tema
        </Button>
        <Examples
          label="Ejemplos de temas"
          items={PILLAR_EXAMPLES.map((example) => ({
            text: `${example.name} (${example.level.toLowerCase()})`,
            used: pillarNames.includes(example.name.toLowerCase()),
            onPick: () =>
              set("pillars", [
                ...draft.pillars,
                {
                  key: "",
                  name: example.name,
                  description: "",
                  weight: weightOf(example.level),
                },
              ]),
          }))}
        />
        <FieldErrors issues={issues} prefix="pillars" exact />
      </fieldset>

      <div>
        <label htmlFor={`${ids}-facts`} className="block text-sm font-medium text-fg">
          Hechos que la IA puede afirmar (uno por línea)
        </label>
        <Help id={`${ids}-facts-help`}>
          La IA solo afirma lo que esté aquí. Escribe solo cosas verdaderas y comprobables. Los
          ejemplos llegan con [corchetes]: complétalos con tus datos reales (no se guardan sin
          completar).
        </Help>
        <Textarea
          id={`${ids}-facts`}
          aria-describedby={`${ids}-facts-help`}
          value={draft.facts}
          onChange={(event) => set("facts", event.target.value)}
          rows={5}
          className="mt-1.5"
        />
        <Examples
          label="Ejemplos de hechos"
          items={FACT_EXAMPLES.map((example) => ({
            text: example,
            used: factLines.includes(example),
            onPick: () => set("facts", addLine(draft.facts, example)),
          }))}
        />
        <FieldErrors issues={issues} prefix="facts" />
      </div>

      <div>
        <label htmlFor={`${ids}-avoid`} className="block text-sm font-medium text-fg">
          Cosas que evitar (una por línea)
        </label>
        <Help id={`${ids}-avoid-help`}>
          Temas, promesas o palabras que la IA no debe usar nunca en tus posts.
        </Help>
        <Textarea
          id={`${ids}-avoid`}
          aria-describedby={`${ids}-avoid-help`}
          value={draft.avoid}
          onChange={(event) => set("avoid", event.target.value)}
          rows={3}
          className="mt-1.5"
        />
        <Examples
          label="Ejemplos de cosas que evitar"
          items={AVOID_EXAMPLES.map((example) => ({
            text: example,
            used: avoidLines.includes(example),
            onPick: () => set("avoid", addLine(draft.avoid, example)),
          }))}
        />
        <FieldErrors issues={issues} prefix="avoid" />
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-fg">Cadencia por red (hora de Chile)</legend>
        <Help>
          En qué redes publica la marca, cuántos posts por semana y qué días y horas prefieres. El
          plan de ideas los usa para proponer fechas.
        </Help>
        <ul className="mt-2 space-y-2">
          {POST_PLATFORMS.map((platform) => {
            const row = draft.cadence[platform];
            const name = PLATFORM_TEXT[platform];
            return (
              <li
                key={platform}
                aria-label={`Cadencia de ${name}`}
                className="rounded-lg border border-line bg-surface p-3 text-sm"
              >
                <label className="flex items-center gap-2 font-medium">
                  <input
                    type="checkbox"
                    checked={row.on}
                    onChange={(event) => setCadence(platform, { on: event.target.checked })}
                  />
                  {name}
                </label>
                {row.on && (
                  <CadenceEditor
                    platform={platform}
                    row={row}
                    languages={{ primary: draft.primary, second: draft.second }}
                    onChange={(change) => setCadence(platform, change)}
                  />
                )}
                <FieldErrors issues={issues} prefix={`cadence.${platform}`} />
              </li>
            );
          })}
        </ul>
        <FieldErrors issues={issues} prefix="cadence" exact />
      </fieldset>

      <div>
        <label className="block text-sm font-medium text-fg">
          Hashtags de la marca
          <Input
            value={draft.hashtags}
            onChange={(event) => set("hashtags", event.target.value)}
            placeholder="#propiedades #arriendo #providencia"
            className="mt-1"
          />
        </label>
        <Help>Se suman a los hashtags fijos de la marca.</Help>
        <FieldErrors issues={issues} prefix="defaultHashtags" />
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Guardando…" : "Guardar el perfil"}
        </Button>
        <p role="status" className="text-sm text-success-800">
          {save.isSuccess && "Perfil guardado."}
        </p>
      </div>
      {issues.length > 0 && (
        <p role="alert" className="text-sm font-semibold text-danger-800">
          El perfil no se guardó: corrige lo marcado en rojo.
        </p>
      )}
      {otherIssues.length > 0 && (
        <ul className="text-sm text-danger-700">
          {otherIssues.map((issue, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: dos mensajes iguales pueden repetirse.
            <li key={index}>{issue.message}</li>
          ))}
        </ul>
      )}
      {save.error && issues.length === 0 && <ErrorAlert error={save.error} />}
    </form>
  );
}

/**
 * La sección Perfil editorial (Mi marca y la página de cada corredor): idiomas, público, temas,
 * hechos, cosas que evitar, cadencia por red y hashtags.
 */
export function EditorialProfileSection({ brokerId }: { brokerId: string }) {
  const profile = useEditorialProfile(brokerId);
  return (
    <section aria-label="Perfil editorial" className="mt-6">
      <h2 className="text-lg font-semibold">Perfil editorial</h2>
      <p className="text-sm text-fg-muted">
        Lo único que usa la IA para escribir los posts de la marca. Nunca ve tus notas internas.
      </p>
      {profile.error && <ErrorAlert error={profile.error} onRetry={() => void profile.refetch()} />}
      {profile.data === undefined ? (
        !profile.error && <p className="mt-2 text-sm text-fg-muted">Cargando…</p>
      ) : (
        <ProfileForm key={brokerId} brokerId={brokerId} profile={profile.data} />
      )}
    </section>
  );
}
