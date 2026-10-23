import type { DailyReadinessResponse, ReadinessItemView } from "@agentsales/api/contracts";
import { PLATFORM_TEXT } from "@agentsales/core";
import { useId } from "react";
import { Link } from "react-router";
import { useDailyReadiness } from "../../queries/brand-week.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Badge } from "../ui/Badge.js";
import { CopyCommand } from "./CopyCommand.js";

type Readiness = DailyReadinessResponse["readiness"];

/** El estado de un ítem en palabras (el color solo acompaña). */
const STATE: Readonly<
  Record<
    ReadinessItemView["state"],
    { text: string; tone: "success" | "danger" | "warning" | "muted" }
  >
> = {
  ok: { text: "Listo", tone: "success" },
  missing: { text: "Falta", tone: "danger" },
  operator: { text: "Lo marca el operador", tone: "warning" },
  info: { text: "Para saber", tone: "muted" },
};

function Item({ item, here }: { item: ReadinessItemView; here: string }) {
  const state = STATE[item.state];
  return (
    <li className="py-2 text-sm first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-fg">{item.label}</span>
        <Badge tone={state.tone}>{state.text}</Badge>
      </div>
      <p className="mt-0.5 text-fg-muted">{item.detail}</p>
      {item.fix !== null && (
        <div className="mt-1">
          <p className="text-fg">
            {item.fix.text}
            {item.fix.page !== undefined && item.fix.page !== here && (
              <>
                {" "}
                <Link to={item.fix.page} className="font-medium underline underline-offset-2">
                  Ir
                </Link>
              </>
            )}
          </p>
          {item.fix.command !== undefined && (
            <CopyCommand command={item.fix.command} label={`Copiar el comando: ${item.label}`} />
          )}
        </div>
      )}
    </li>
  );
}

/** La lista ya leída: lo de la marca y un grupo por red. */
export function DailyReadinessView({
  readiness,
  here = "/cuentas",
}: {
  readiness: Readiness;
  /** La página donde se muestra: un paso que lleva a ella no lleva enlace. */
  here?: string;
}) {
  const summary = readiness.ready
    ? "Lista: sus posts aprobados y programados salen solos cada día."
    : readiness.pending === 1
      ? "Falta 1 cosa para publicar a diario."
      : `Faltan ${readiness.pending} cosas para publicar a diario.`;
  return (
    <div>
      <p role="status" className={readiness.ready ? "text-success-800" : "text-warning-800"}>
        {summary}
      </p>
      <h4 className="mt-3 text-sm font-semibold text-fg">La marca</h4>
      <ul className="mt-1 divide-y divide-line">
        {readiness.brand.map((item) => (
          <Item key={item.key} item={item} here={here} />
        ))}
      </ul>
      {readiness.networks.map((network) => (
        <div key={network.platform} className="mt-3">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
            {PLATFORM_TEXT[network.platform]}
            <Badge tone={network.ready ? "success" : "warning"}>
              {network.ready ? "Lista" : "Con pendientes"}
            </Badge>
          </h4>
          <ul className="mt-1 divide-y divide-line">
            {network.items.map((item) => (
              <Item key={item.key} item={item} here={here} />
            ))}
          </ul>
        </div>
      ))}
      <p className="mt-3 text-xs text-fg-subtle">
        Nada de esta lista se cambia solo: el modo en vivo, el horario del worker y las pruebas de
        entrada los decide y hace el operador.
      </p>
    </div>
  );
}

/**
 * «Lista para publicar a diario» de una marca (F9.5-T27), en Cuentas: por red, la cuenta, la prueba
 * de entrada y lo propio de la red; y de la marca, su modo, el worker con horario y el tope de IA.
 * Cada ítem dice qué falta y cómo resolverlo. Plegada al empezar, con el resumen a la vista.
 */
export function DailyReadiness({ brokerId }: { brokerId: string }) {
  const headingId = useId();
  const readiness = useDailyReadiness(brokerId);
  return (
    <section
      aria-labelledby={headingId}
      className="mt-3 rounded-xl border border-line bg-surface p-4 shadow-xs"
    >
      <details>
        <summary className="cursor-pointer">
          <h3 id={headingId} className="inline text-sm font-semibold text-fg">
            Lista para publicar a diario
          </h3>
          {readiness.data !== undefined && (
            <span className="ml-2 text-sm text-fg-muted">
              {readiness.data.ready ? "lista" : `${readiness.data.pending} pendiente(s)`}
            </span>
          )}
        </summary>
        <div className="mt-3">
          {readiness.error && (
            <ErrorAlert error={readiness.error} onRetry={() => void readiness.refetch()} />
          )}
          {readiness.isPending && <p className="text-sm text-fg-muted">Revisando…</p>}
          {readiness.data !== undefined && <DailyReadinessView readiness={readiness.data} />}
        </div>
      </details>
    </section>
  );
}
