import type { PlanDetailResponse, PlanIdeaView, PlanRunView } from "@agentsales/api/contracts";
import {
  chileInputValue,
  formatChileTime,
  groupByPlanWeek,
  ideaNeedsDraft,
  isAppError,
  isTerminalContentRun,
  PLAN_DEFAULT_DAYS,
  PLAN_MAX_DAYS,
  PLAN_MAX_IDEAS,
  PLAN_RUN_STATUS_TEXT,
  PLATFORM_TEXT,
  POST_PLATFORMS,
  type PostPlatform,
  parseChileTime,
  planWeekText,
} from "@agentsales/core";
import { type FormEvent, useId, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { useBrandPlatforms } from "../components/posts/brand-platforms.js";
import { POST_KIND_LABEL, PostStatusBadge } from "../components/posts/labels.js";
import { Button } from "../components/ui/Button.js";
import { Input, Select, Textarea } from "../components/ui/Field.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { useMe } from "../queries/auth.js";
import {
  useAcceptIdea,
  useDiscardIdea,
  useDraftAccepted,
  usePlan,
  usePlans,
  useRequestPlan,
  useUpdateIdea,
} from "../queries/plans.js";
import { useEditorialProfile } from "../queries/posts.js";
import { useRole } from "../scope/broker-scope.js";
import { useScopedBrokerId } from "./PostsPage.js";

/**
 * La marca del plan: la elegida en el selector del administrador (sin ella, ninguna: un plan es
 * de una marca) o la del usuario corredor.
 */
function usePlanBrandId(): string | undefined {
  const role = useRole();
  const me = useMe();
  const scoped = useScopedBrokerId();
  if (role === "admin") return scoped;
  return me.data?.brokerId ?? undefined;
}

const networksText = (platforms: readonly PostPlatform[] | null) =>
  platforms === null
    ? "todas las redes de la marca"
    : platforms.map((platform) => PLATFORM_TEXT[platform]).join(", ");

/** Las casillas de las redes (sin marcar ninguna: todas las de la marca). */
function NetworkChoices({
  name,
  options,
  checked,
  legend,
}: {
  name: string;
  options: readonly PostPlatform[];
  checked: readonly PostPlatform[];
  legend: string;
}) {
  return (
    <fieldset className="text-sm text-slate-700">
      <legend className="font-medium">{legend}</legend>
      <div className="mt-1 flex flex-wrap gap-3">
        {options.map((platform) => (
          <label key={platform} className="flex items-center gap-1">
            <input
              type="checkbox"
              name={name}
              value={platform}
              defaultChecked={checked.includes(platform)}
            />
            {PLATFORM_TEXT[platform]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const checkedNetworks = (form: FormData, name: string): PostPlatform[] =>
  form
    .getAll(name)
    .map(String)
    .flatMap((value) => POST_PLATFORMS.filter((platform) => platform === value));

/** Pedir un plan: días, redes y cuántas ideas. */
function RequestPlan({
  brandId,
  onRequested,
}: {
  brandId: string;
  onRequested: (planId: string, reused: boolean) => void;
}) {
  const ids = useId();
  const role = useRole();
  const request = useRequestPlan();
  const options = useBrandPlatforms(brandId);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const platforms = checkedNetworks(form, "platforms");
    request.mutate(
      {
        ...(role === "admin" ? { brokerId: brandId } : {}),
        days: Number(text("days") || PLAN_DEFAULT_DAYS),
        ...(platforms.length === 0 ? {} : { platforms }),
        ...(text("count") === "" ? {} : { count: Number(text("count")) }),
      },
      { onSuccess: ({ plan, reused }) => onRequested(plan.id, reused) },
    );
  };
  return (
    <section
      aria-label="Pedir un plan"
      className="mt-4 rounded-xl border border-line bg-surface p-4 shadow-xs"
    >
      <h2 className="text-lg font-semibold">Pedir un plan</h2>
      <p className="mt-1 text-sm text-fg-muted">
        La IA propone ideas con fecha desde mañana, con el perfil editorial de la marca. Cada plan
        gasta IA de la marca, aunque descartes todo.
      </p>
      <form onSubmit={submit} className="mt-3 grid gap-3 md:grid-cols-2">
        <label htmlFor={`${ids}-days`} className="block text-sm font-medium text-slate-700">
          Días
          <Input
            id={`${ids}-days`}
            name="days"
            type="number"
            min={1}
            max={PLAN_MAX_DAYS}
            defaultValue={PLAN_DEFAULT_DAYS}
            className="mt-1"
          />
        </label>
        <label htmlFor={`${ids}-count`} className="block text-sm font-medium text-slate-700">
          Cuántas ideas (vacío: según la cadencia)
          <Input
            id={`${ids}-count`}
            name="count"
            type="number"
            min={1}
            max={PLAN_MAX_IDEAS}
            className="mt-1"
          />
        </label>
        <div className="md:col-span-2">
          <NetworkChoices
            name="platforms"
            options={options}
            checked={[]}
            legend="Redes (sin marcar ninguna: todas las de la marca)"
          />
        </div>
        <div className="md:col-span-2">
          <Button size="sm" type="submit" disabled={request.isPending}>
            {request.isPending ? "Pidiendo…" : "Pedir el plan"}
          </Button>
        </div>
      </form>
      {request.error && <ErrorAlert error={request.error} />}
    </section>
  );
}

/** El estado del plan en palabras, con su error y qué hacer si falló. */
function PlanStatus({ plan }: { plan: PlanRunView }) {
  if (plan.status === "failed") {
    return (
      <div role="alert" className="mt-3 rounded-lg border border-danger-200 bg-danger-50 p-4">
        <p className="font-semibold text-danger-800">
          El plan falló{plan.error === null ? "" : `: ${plan.error.message}`}
        </p>
        {plan.errorAdvice !== null && (
          <p className="mt-1 text-sm text-danger-700">{plan.errorAdvice}</p>
        )}
      </div>
    );
  }
  if (plan.status === "succeeded") return null;
  return (
    <p role="status" className="mt-3 text-sm text-slate-700">
      {plan.status === "queued"
        ? "Plan en cola: esperando al worker…"
        : "La IA está proponiendo ideas…"}
    </p>
  );
}

/** Editar una idea antes de aceptarla: el brief, la fecha y hora (Chile) y las redes. */
function IdeaEditForm({
  idea,
  planId,
  networks,
  onClose,
}: {
  idea: PlanIdeaView;
  planId: string;
  networks: readonly PostPlatform[];
  onClose: () => void;
}) {
  const ids = useId();
  const update = useUpdateIdea(planId);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    let plannedAt: Date | null = null;
    if (text("plannedAt") !== "") {
      try {
        plannedAt = parseChileTime(text("plannedAt"));
      } catch (error) {
        setProblem(isAppError(error) ? error.message : String(error));
        return;
      }
    }
    const platforms = checkedNetworks(form, "platforms");
    setProblem(null);
    update.mutate(
      {
        postId: idea.id,
        body: {
          // El brief solo se manda si cambió: editarlo lo deja como del operador (fuente de hechos).
          ...(text("brief") === (idea.brief ?? "") ? {} : { brief: text("brief") || null }),
          plannedAt,
          platforms: platforms.length === 0 ? null : platforms,
        },
      },
      { onSuccess: onClose },
    );
  };
  // Las redes de la idea y las de la marca, sin repetir.
  const options = POST_PLATFORMS.filter(
    (platform) => networks.includes(platform) || (idea.platforms ?? []).includes(platform),
  );
  return (
    <form aria-label={`Editar «${idea.topic}»`} onSubmit={submit} className="mt-3 grid gap-3">
      <label htmlFor={`${ids}-brief`} className="block text-sm font-medium text-slate-700">
        Brief (lo que tú sabes; la IA puede afirmar lo que escribas aquí)
        <Textarea
          id={`${ids}-brief`}
          name="brief"
          rows={3}
          defaultValue={idea.brief ?? ""}
          className="mt-1"
        />
      </label>
      <label htmlFor={`${ids}-planned`} className="block text-sm font-medium text-slate-700">
        Fecha y hora (Chile)
        <Input
          id={`${ids}-planned`}
          name="plannedAt"
          type="datetime-local"
          defaultValue={idea.plannedAt === null ? "" : chileInputValue(idea.plannedAt)}
          className="mt-1"
        />
      </label>
      <NetworkChoices
        name="platforms"
        options={options}
        checked={idea.platforms ?? []}
        legend="Redes (sin marcar ninguna: todas las de la marca)"
      />
      <div className="flex gap-2">
        <Button size="sm" type="submit" disabled={update.isPending}>
          {update.isPending ? "Guardando…" : "Guardar"}
        </Button>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cancelar
        </Button>
      </div>
      {problem !== null && (
        <p role="alert" className="text-sm text-danger-700">
          {problem}
        </p>
      )}
      {update.error && <ErrorAlert error={update.error} />}
    </form>
  );
}

/** En qué van los textos de una idea aceptada. */
function textsState(idea: PlanIdeaView): string {
  const run = idea.latestRun;
  if (run !== null && !isTerminalContentRun(run.status)) return "La IA está redactando sus textos…";
  if (idea.texts > 0) return `${idea.texts} texto(s): revísalos, apruébalos y prográmalos`;
  if (run?.status === "failed") {
    return `La redacción falló${run.error === null ? "" : `: ${run.error.message}`}`;
  }
  return "Sin textos todavía";
}

/** Una idea: tema, línea, redes sugeridas, fecha y hora, el porqué y lo que se hace con ella. */
function IdeaCard({
  idea,
  planId,
  pillarName,
  networks,
}: {
  idea: PlanIdeaView;
  planId: string;
  pillarName: string | null;
  networks: readonly PostPlatform[];
}) {
  const accept = useAcceptIdea(planId);
  const discard = useDiscardIdea(planId);
  const [editing, setEditing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const busy = accept.isPending || discard.isPending;
  const archived = idea.status === "archived";
  return (
    <li
      aria-label={idea.topic}
      className={`rounded-xl border border-line bg-surface p-3 ${archived ? "opacity-60" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-slate-700">
          {idea.plannedAt === null ? "sin fecha" : formatChileTime(idea.plannedAt)}
        </span>
        {idea.status === "idea" ? (
          <span className="font-semibold">{idea.topic}</span>
        ) : (
          <Link
            to={`/contenido/${idea.id}`}
            className="font-semibold text-fg underline-offset-2 hover:text-brand-700 hover:underline"
          >
            {idea.topic}
          </Link>
        )}
        <PostStatusBadge status={idea.status} />
      </div>
      <p className="mt-1 text-sm text-fg-muted">
        {POST_KIND_LABEL[idea.kind]} · {networksText(idea.platforms)}
        {pillarName !== null && ` · línea ${pillarName}`}
      </p>
      {idea.rationale !== null && (
        <p className="mt-1 text-sm text-fg">
          <span className="font-medium">Por qué: </span>
          {idea.rationale}
        </p>
      )}
      {idea.brief !== null && (
        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
          <span className="font-medium">Brief: </span>
          {idea.brief}
        </p>
      )}
      {idea.notes.map((note) => (
        <p key={note} className="mt-1 text-xs text-fg-subtle">
          Sin esa red: {note}
        </p>
      ))}
      {(idea.status === "draft" || idea.status === "ready") && (
        <p role="status" className="mt-1 text-sm text-slate-700">
          {textsState(idea)}
        </p>
      )}
      {idea.status === "idea" && !editing && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy} onClick={() => accept.mutate(idea.id)}>
            {accept.isPending ? "Aceptando…" : "Aceptar"}
          </Button>
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(true)}>
            Editar
          </Button>
          {confirmDiscard ? (
            <span className="flex flex-wrap items-center gap-2 text-sm">
              ¿Descartarla? No se vuelve a proponer en 60 días.
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={() =>
                  discard.mutate(idea.id, { onSettled: () => setConfirmDiscard(false) })
                }
              >
                Sí, descartar
              </Button>
              <Button variant="link" onClick={() => setConfirmDiscard(false)}>
                Cancelar
              </Button>
            </span>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmDiscard(true)}
            >
              Descartar
            </Button>
          )}
        </div>
      )}
      {editing && (
        <IdeaEditForm
          idea={idea}
          planId={planId}
          networks={networks}
          onClose={() => setEditing(false)}
        />
      )}
      {accept.error && <ErrorAlert error={accept.error} />}
      {discard.error && <ErrorAlert error={discard.error} />}
    </li>
  );
}

/** Las ideas aceptadas que quedaron sin textos ni corrida en curso (las pide "Redactar lo aceptado"). */
export const acceptedWithoutTexts = (ideas: readonly PlanIdeaView[]) =>
  ideas.filter(ideaNeedsDraft);

/** "Redactar lo aceptado": pide los textos de las aceptadas que quedaron sin ellos. */
function DraftAccepted({ planId, ideas }: { planId: string; ideas: readonly PlanIdeaView[] }) {
  const draft = useDraftAccepted(planId);
  const pending = acceptedWithoutTexts(ideas);
  if (pending.length === 0 && (draft.data?.length ?? 0) === 0) return null;
  return (
    <div className="mt-3 rounded-md border border-warning-200 bg-warning-50 p-3 text-sm">
      {pending.length > 0 && (
        <>
          <p className="text-warning-800">
            {pending.length === 1
              ? "Una idea aceptada quedó sin textos."
              : `${pending.length} ideas aceptadas quedaron sin textos.`}
          </p>
          <Button
            size="sm"
            className="mt-2"
            disabled={draft.isPending}
            onClick={() => draft.mutate(pending.map((idea) => idea.id))}
          >
            {draft.isPending ? "Pidiendo…" : "Redactar lo aceptado"}
          </Button>
        </>
      )}
      {draft.data?.map(({ postId, error }) => (
        <ErrorAlert
          key={postId}
          error={error}
          hint={`«${ideas.find((idea) => idea.id === postId)?.topic ?? postId}» no se pudo redactar.`}
        />
      ))}
    </div>
  );
}

/** El plan elegido: su estado y, si terminó, las ideas por semana y lo que se descartó. */
function PlanView({ detail, brandId }: { detail: PlanDetailResponse; brandId: string }) {
  const { plan, report, ideas } = detail;
  const profile = useEditorialProfile(brandId);
  const networks = useBrandPlatforms(brandId);
  const pillarName = (key: string | null) =>
    key === null ? null : (profile.data?.pillars.find((pillar) => pillar.key === key)?.name ?? key);
  return (
    <section aria-label="El plan" className="mt-4">
      <p className="text-sm text-fg-muted">
        Del {plan.firstDay} al {plan.lastDay} · {networksText(plan.platforms)} ·{" "}
        {PLAN_RUN_STATUS_TEXT[plan.status]}
      </p>
      <PlanStatus plan={plan} />
      {plan.status === "succeeded" && (
        <>
          <p className="mt-3 rounded-md border border-info-200 bg-info-50 p-3 text-sm text-info-800">
            Una idea no se publica sola: al aceptarla, la IA redacta sus textos; después tú los
            revisas, apruebas y programas en Contenido.
          </p>
          <DraftAccepted planId={plan.id} ideas={ideas} />
          {ideas.length === 0 && (
            <p className="mt-3 text-fg-muted">
              La IA no dejó ideas válidas: mira lo descartado abajo y pide otro plan.
            </p>
          )}
          {groupByPlanWeek(ideas).map((group) => (
            <div key={group.week ?? "sin-fecha"} className="mt-4">
              <h3 className="font-semibold">
                {group.week === null ? "Sin fecha" : planWeekText(group.week)}
              </h3>
              <ul
                aria-label={group.week === null ? "Sin fecha" : planWeekText(group.week)}
                className="mt-2 space-y-2"
              >
                {group.items.map((idea) => (
                  <IdeaCard
                    key={idea.id}
                    idea={idea}
                    planId={plan.id}
                    pillarName={pillarName(idea.pillar)}
                    networks={networks}
                  />
                ))}
              </ul>
            </div>
          ))}
          {report !== null && report.discarded.length > 0 && (
            <details className="mt-4 text-sm text-slate-700">
              <summary>Descartadas por las revisiones ({report.discarded.length})</summary>
              <ul className="mt-2 list-disc pl-5">
                {report.discarded.map((item, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: el reporte no cambia
                  <li key={index}>
                    {item.topic === "" ? "(sin tema)" : item.topic}: {item.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {(report?.warnings ?? []).map((warning) => (
            <p key={warning} className="mt-2 text-sm text-warning-800">
              ⚠ {warning}
            </p>
          ))}
        </>
      )}
    </section>
  );
}

/**
 * Plan (spec F9 §4.9 y §4.10, F9-T21): pedir un plan de ideas para la marca, seguirlo mientras la IA
 * propone, y aceptar, editar, mover o descartar sus ideas por semana. Funciona igual con el
 * selector del administrador (una marca a la vez).
 */
export function PlanPage() {
  const role = useRole();
  const brandId = usePlanBrandId();
  const [params, setParams] = useSearchParams();
  const [reusedNote, setReusedNote] = useState(false);
  const plans = usePlans(
    role === "admin" ? brandId : undefined,
    role !== null && brandId !== undefined,
  );
  // El de la dirección si es de esta marca (el selector pudo cambiar de marca); si no, el último.
  const fromUrl = params.get("plan");
  const selectedId =
    fromUrl !== null && plans.data?.some((item) => item.id === fromUrl)
      ? fromUrl
      : plans.data?.[0]?.id;
  const plan = usePlan(selectedId);
  const pickerId = useId();
  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("plan", id);
    setParams(next, { replace: true });
  };
  return (
    <div>
      <PageHeader
        title="Plan"
        description={
          <>
            La IA propone ideas con fecha; tú decides cuáles aceptar. Nada se publica sin que lo
            apruebes y lo programes.
          </>
        }
      />
      {role === "admin" && brandId === undefined && (
        <p className="mt-4 text-slate-700">
          Elige una marca en el selector de arriba para pedir o ver su plan.
        </p>
      )}
      {brandId !== undefined && (
        <>
          <RequestPlan
            brandId={brandId}
            onRequested={(id, reused) => {
              setReusedNote(reused);
              select(id);
            }}
          />
          {reusedNote && (
            <p role="status" className="mt-2 text-sm text-warning-800">
              La marca ya tenía un plan en curso: te muestro ese.
            </p>
          )}
          {plans.error && <ErrorAlert error={plans.error} onRetry={() => void plans.refetch()} />}
          {plans.data !== undefined && plans.data.length === 0 && (
            <p className="mt-4 text-fg-muted">Esta marca todavía no tiene planes.</p>
          )}
          {plans.data !== undefined && plans.data.length > 1 && (
            <div className="mt-4 flex flex-col gap-1">
              <label htmlFor={pickerId} className="text-xs font-medium text-fg-muted">
                Plan
              </label>
              <Select
                width="auto"
                id={pickerId}
                value={selectedId ?? ""}
                onChange={(event) => select(event.target.value)}
                className="w-fit"
              >
                {plans.data.map((item) => (
                  <option key={item.id} value={item.id}>
                    Del {item.firstDay} al {item.lastDay} ({PLAN_RUN_STATUS_TEXT[item.status]})
                  </option>
                ))}
              </Select>
            </div>
          )}
          {plan.error && <ErrorAlert error={plan.error} onRetry={() => void plan.refetch()} />}
          {plan.data !== undefined && <PlanView detail={plan.data} brandId={brandId} />}
        </>
      )}
    </div>
  );
}
