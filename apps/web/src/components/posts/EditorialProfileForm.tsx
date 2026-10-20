import type { EditorialProfileBody, EditorialProfileJson } from "@agentsales/api/contracts";
import {
  EDITORIAL_WEEKDAY_TEXT,
  EDITORIAL_WEEKDAYS,
  type EditorialWeekday,
  LANGUAGE_TEXT,
  LANGUAGES,
  type Language,
  PLATFORM_TEXT,
  POST_PLATFORMS,
  type PostPlatform,
} from "@agentsales/core";
import { type FormEvent, useId, useState } from "react";
import { ApiError } from "../../api/client.js";
import { useEditorialProfile, useSaveEditorialProfile } from "../../queries/posts.js";
import { ErrorAlert } from "../ErrorAlert.js";

// El perfil editorial de una marca (spec F9 §4.3, F9-T09): lo único que la IA usa para escribir sus
// posts. Lo revisa core al guardar (`EDITORIAL_PROFILE_INVALID`) y cada problema llega con su campo
// (`pillars[1].key`, `cadence.x.hours`): el formulario lo muestra junto a ese campo.

const FIELD = "mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm";
const SMALL = "rounded-md border border-slate-300 bg-white px-2 py-1 text-sm";
const SECONDARY =
  "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50";

type PillarRow = { key: string; name: string; description: string; weight: string };
type CadenceRow = {
  on: boolean;
  postsPerWeek: string;
  days: EditorialWeekday[];
  hours: string;
  languageGapHours: string;
};

/** Lo que se edita: listas como texto (una por línea) y números como texto, hasta guardar. */
type Draft = {
  primary: Language;
  second: Language | "";
  audience: string;
  pillars: PillarRow[];
  facts: string;
  avoid: string;
  cadence: Record<PostPlatform, CadenceRow>;
  hashtags: string;
};

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

function draftOf(profile: EditorialProfileJson): Draft {
  const [primary = "es", second] = profile.languages;
  const cadence = Object.fromEntries(
    POST_PLATFORMS.map((platform) => {
      const entry = profile.cadence[platform];
      return [
        platform,
        {
          on: entry !== undefined,
          postsPerWeek: String(entry?.postsPerWeek ?? 1),
          days: [...(entry?.days ?? [])],
          hours: (entry?.hours ?? []).join(", "),
          languageGapHours: String(entry?.languageGapHours ?? 6),
        },
      ];
    }),
  ) as Record<PostPlatform, CadenceRow>;
  return {
    primary,
    second: second ?? "",
    audience: profile.audience ?? "",
    pillars: profile.pillars.map((pillar) => ({
      key: pillar.key,
      name: pillar.name,
      description: pillar.description,
      weight: String(pillar.weight),
    })),
    facts: profile.facts.join("\n"),
    avoid: profile.avoid.join("\n"),
    cadence,
    hashtags: profile.defaultHashtags.join(" "),
  };
}

type Issue = { field: string; message: string };

/**
 * El cuerpo de `PUT /brokers/:id/editorial-profile` (core normaliza y valida) y, aparte, los números
 * mal escritos: esos no se pueden mandar (JSON no tiene `NaN`), así que se marcan aquí, con el mismo
 * campo y la misma forma de mensaje que usa la API.
 */
export function profileBody(draft: Draft): { body: EditorialProfileBody; issues: Issue[] } {
  const issues: Issue[] = [];
  const numberOf = (text: string, field: string, label: string) => {
    const value = Number(text.trim().replace(",", "."));
    if (text.trim() === "" || !Number.isFinite(value)) {
      issues.push({ field, message: `${label}: «${text.trim()}» no es un número` });
      return 0;
    }
    return value;
  };
  const body: EditorialProfileBody = {
    languages: [draft.primary, ...(draft.second === "" ? [] : [draft.second])],
    audience: draft.audience.trim() === "" ? null : draft.audience,
    pillars: draft.pillars.map((pillar, index) => ({
      key: pillar.key,
      name: pillar.name,
      description: pillar.description,
      weight: numberOf(pillar.weight, `pillars[${index}].weight`, "Líneas de contenido: el peso"),
    })),
    facts: lines(draft.facts),
    avoid: lines(draft.avoid),
    cadence: Object.fromEntries(
      POST_PLATFORMS.filter((platform) => draft.cadence[platform].on).map((platform) => {
        const row = draft.cadence[platform];
        return [
          platform,
          {
            postsPerWeek: numberOf(
              row.postsPerWeek,
              `cadence.${platform}.postsPerWeek`,
              `Cadencia: en ${PLATFORM_TEXT[platform]}, los posts por semana`,
            ),
            days: row.days,
            hours: row.hours
              .split(/[\s,]+/)
              .map((hour) => hour.trim())
              .filter((hour) => hour !== ""),
            languageGapHours: numberOf(
              row.languageGapHours,
              `cadence.${platform}.languageGapHours`,
              `Cadencia: en ${PLATFORM_TEXT[platform]}, las horas entre idiomas`,
            ),
          },
        ];
      }),
    ),
    defaultHashtags: draft.hashtags.split(/[\s,]+/).filter((tag) => tag.trim() !== ""),
  };
  return { body, issues };
}

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
    <ul className="mt-1 text-xs text-red-700">
      {mine.map((issue, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: dos mensajes iguales pueden repetirse.
        <li key={index}>{issue.message}</li>
      ))}
    </ul>
  );
}

/** El formulario, ya con el perfil cargado (se monta de nuevo si cambia de marca). */
function ProfileForm({ brokerId, profile }: { brokerId: string; profile: EditorialProfileJson }) {
  const ids = useId();
  const save = useSaveEditorialProfile(brokerId);
  const [draft, setDraft] = useState<Draft>(() => draftOf(profile));
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
    save.mutate(body);
  };
  const otherIssues = issues.filter(
    (issue) =>
      !["languages", "audience", "pillars", "facts", "avoid", "cadence", "defaultHashtags"].some(
        (field) => issue.field === field || issue.field.startsWith(field),
      ),
  );

  return (
    <form aria-label="Perfil editorial" className="mt-2 space-y-5" onSubmit={submit}>
      <fieldset>
        <legend className="text-sm font-medium text-slate-700">Idiomas</legend>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
          <label htmlFor={`${ids}-primary`}>Principal</label>
          <select
            id={`${ids}-primary`}
            value={draft.primary}
            onChange={(event) => set("primary", event.target.value as Language)}
            className={SMALL}
          >
            {LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {LANGUAGE_TEXT[language]}
              </option>
            ))}
          </select>
          <label htmlFor={`${ids}-second`}>Segundo idioma</label>
          <select
            id={`${ids}-second`}
            value={draft.second}
            onChange={(event) => set("second", event.target.value as Language | "")}
            className={SMALL}
          >
            <option value="">ninguno</option>
            {LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {LANGUAGE_TEXT[language]}
              </option>
            ))}
          </select>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Con dos idiomas, cada red tiene un texto por idioma, que se publican por separado (y la IA
          cuesta el doble).
        </p>
        <FieldErrors issues={issues} prefix="languages" />
      </fieldset>

      <div>
        <label className="block text-sm font-medium text-slate-700">
          Público
          <textarea
            value={draft.audience}
            onChange={(event) => set("audience", event.target.value)}
            rows={2}
            placeholder="A quién le habla la marca, en una o dos frases"
            className={FIELD}
          />
        </label>
        <FieldErrors issues={issues} prefix="audience" />
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-slate-700">Líneas de contenido</legend>
        <p className="text-xs text-slate-500">
          La clave va en minúsculas y con guiones (la usa cada post); el peso reparte las ideas del
          plan.
        </p>
        <ul className="mt-2 space-y-2">
          {draft.pillars.map((pillar, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: las filas no tienen otro id hasta guardar.
              key={index}
              aria-label={`Línea ${index + 1}`}
              className="grid gap-2 rounded-md border border-slate-200 bg-white p-2 sm:grid-cols-[8rem_1fr_5rem_auto]"
            >
              <input
                aria-label={`Clave de la línea ${index + 1}`}
                value={pillar.key}
                onChange={(event) => setPillar(index, { key: event.target.value })}
                placeholder="bastidores"
                className={SMALL}
              />
              <input
                aria-label={`Nombre de la línea ${index + 1}`}
                value={pillar.name}
                onChange={(event) => setPillar(index, { name: event.target.value })}
                placeholder="Bastidores"
                className={SMALL}
              />
              <input
                aria-label={`Peso de la línea ${index + 1}`}
                value={pillar.weight}
                inputMode="numeric"
                onChange={(event) => setPillar(index, { weight: event.target.value })}
                className={SMALL}
              />
              <button
                type="button"
                className="text-sm underline"
                onClick={() =>
                  set(
                    "pillars",
                    draft.pillars.filter((_, at) => at !== index),
                  )
                }
              >
                Quitar
              </button>
              <textarea
                aria-label={`Descripción de la línea ${index + 1}`}
                value={pillar.description}
                onChange={(event) => setPillar(index, { description: event.target.value })}
                rows={1}
                placeholder="De qué trata"
                className={`${SMALL} sm:col-span-4`}
              />
              <div className="sm:col-span-4">
                <FieldErrors issues={issues} prefix={`pillars[${index}]`} />
              </div>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={`${SECONDARY} mt-2`}
          onClick={() =>
            set("pillars", [...draft.pillars, { key: "", name: "", description: "", weight: "1" }])
          }
        >
          Agregar una línea
        </button>
        <FieldErrors issues={issues} prefix="pillars" exact />
      </fieldset>

      <div>
        <label className="block text-sm font-medium text-slate-700">
          Hechos que la IA puede afirmar (uno por línea)
          <textarea
            value={draft.facts}
            onChange={(event) => set("facts", event.target.value)}
            rows={5}
            className={FIELD}
          />
        </label>
        <p className="mt-1 text-xs text-slate-500">
          Lo que no esté aquí (ni en el brief que escribas) no se afirma: cifras, nombres y enlaces.
        </p>
        <FieldErrors issues={issues} prefix="facts" />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700">
          Cosas que evitar (una por línea)
          <textarea
            value={draft.avoid}
            onChange={(event) => set("avoid", event.target.value)}
            rows={3}
            className={FIELD}
          />
        </label>
        <FieldErrors issues={issues} prefix="avoid" />
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-slate-700">
          Cadencia por red (hora de Chile)
        </legend>
        <ul className="mt-2 space-y-2">
          {POST_PLATFORMS.map((platform) => {
            const row = draft.cadence[platform];
            const name = PLATFORM_TEXT[platform];
            return (
              <li
                key={platform}
                aria-label={`Cadencia de ${name}`}
                className="rounded-md border border-slate-200 bg-white p-2 text-sm"
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
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-1">
                      Posts por semana
                      <input
                        value={row.postsPerWeek}
                        inputMode="numeric"
                        onChange={(event) =>
                          setCadence(platform, { postsPerWeek: event.target.value })
                        }
                        className={`${SMALL} w-16`}
                      />
                    </label>
                    <span className="flex flex-wrap items-center gap-1">
                      Días:
                      {EDITORIAL_WEEKDAYS.map((day) => (
                        <label key={day} className="flex items-center gap-0.5">
                          <input
                            type="checkbox"
                            aria-label={`${name}: ${EDITORIAL_WEEKDAY_TEXT[day]}`}
                            checked={row.days.includes(day)}
                            onChange={(event) =>
                              setCadence(platform, {
                                days: event.target.checked
                                  ? [...row.days, day]
                                  : row.days.filter((item) => item !== day),
                              })
                            }
                          />
                          {EDITORIAL_WEEKDAY_TEXT[day]}
                        </label>
                      ))}
                    </span>
                    <label className="flex items-center gap-1">
                      Horas
                      <input
                        value={row.hours}
                        onChange={(event) => setCadence(platform, { hours: event.target.value })}
                        placeholder="09:00, 18:30"
                        className={`${SMALL} w-32`}
                      />
                    </label>
                    {draft.second !== "" && (
                      <label className="flex items-center gap-1">
                        Horas entre idiomas
                        <input
                          value={row.languageGapHours}
                          inputMode="numeric"
                          onChange={(event) =>
                            setCadence(platform, { languageGapHours: event.target.value })
                          }
                          className={`${SMALL} w-16`}
                        />
                      </label>
                    )}
                  </div>
                )}
                <FieldErrors issues={issues} prefix={`cadence.${platform}`} />
              </li>
            );
          })}
        </ul>
        <FieldErrors issues={issues} prefix="cadence" exact />
      </fieldset>

      <div>
        <label className="block text-sm font-medium text-slate-700">
          Hashtags de la marca
          <input
            value={draft.hashtags}
            onChange={(event) => set("hashtags", event.target.value)}
            placeholder="#agentpey #ventas"
            className={FIELD}
          />
        </label>
        <p className="mt-1 text-xs text-slate-500">Se suman a los hashtags fijos de la marca.</p>
        <FieldErrors issues={issues} prefix="defaultHashtags" />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={save.isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {save.isPending ? "Guardando…" : "Guardar el perfil"}
        </button>
        <p role="status" className="text-sm text-green-800">
          {save.isSuccess && "Perfil guardado."}
        </p>
      </div>
      {issues.length > 0 && (
        <p role="alert" className="text-sm font-semibold text-red-800">
          El perfil no se guardó: corrige lo marcado en rojo.
        </p>
      )}
      {otherIssues.length > 0 && (
        <ul className="text-sm text-red-700">
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
 * La sección Perfil editorial (Mi marca y la página de cada corredor): idiomas, público, líneas,
 * hechos, cosas que evitar, cadencia por red y hashtags.
 */
export function EditorialProfileSection({ brokerId }: { brokerId: string }) {
  const profile = useEditorialProfile(brokerId);
  return (
    <section aria-label="Perfil editorial" className="mt-6">
      <h2 className="text-lg font-semibold">Perfil editorial</h2>
      <p className="text-sm text-slate-600">
        Lo único que usa la IA para escribir los posts de la marca. Nunca ve tus notas internas.
      </p>
      {profile.error && <ErrorAlert error={profile.error} onRetry={() => void profile.refetch()} />}
      {profile.data === undefined ? (
        !profile.error && <p className="mt-2 text-sm text-slate-600">Cargando…</p>
      ) : (
        <ProfileForm key={brokerId} brokerId={brokerId} profile={profile.data} />
      )}
    </section>
  );
}
