import type { LeadView } from "@agentsales/api/contracts";
import {
  LEAD_STATUS_TEXT,
  LEAD_STATUSES,
  LEAD_TRANSITIONS,
  type LeadStatus,
} from "@agentsales/core";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { Alert } from "../components/ui/Alert.js";
import { Button } from "../components/ui/Button.js";
import { Select } from "../components/ui/Field.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { useMe } from "../queries/auth.js";
import {
  useChangeLeadStatus,
  useEraseLead,
  useLeads,
  useLeadsCsv,
  useRotateWebhookSecret,
} from "../queries/leads.js";
import { useRole } from "../scope/broker-scope.js";
import { useScopedBrokerId } from "./PostsPage.js";

// Leads (F10-T06, ADR-0033): las personas que escribieron por un anuncio o por ManyChat, de qué
// propiedad vienen y en qué va cada una. Tienen datos personales de terceros: solo los ve quien
// puede `leads.manage` sobre el corredor, y borrar deja la atribución y quita los datos.

const dayText = (date: Date) =>
  date.toLocaleString("es-CL", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Santiago",
  });

const oneOf = (value: string | null): LeadStatus | undefined =>
  LEAD_STATUSES.find((status) => status === value);

function LeadRow({ lead }: { lead: LeadView }) {
  const change = useChangeLeadStatus();
  const erase = useEraseLead();
  const [confirming, setConfirming] = useState(false);
  const next = LEAD_TRANSITIONS[lead.status];
  const erased = lead.erasedAt !== null;
  return (
    <li className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold text-fg">
          {lead.name ?? (erased ? "Datos borrados" : "Sin nombre")}
        </p>
        <span className="rounded-full bg-sand px-2.5 py-0.5 text-xs font-medium text-fg-muted">
          {LEAD_STATUS_TEXT[lead.status]}
        </span>
      </div>
      <p className="mt-1 text-sm text-fg-muted">
        {[lead.phone, lead.email].filter((v) => v !== null).join(" · ") || "—"}
      </p>
      <p className="mt-1 text-xs text-fg-subtle">
        Recibido {dayText(lead.createdAt)} · {lead.source}
        {lead.campaign !== null && ` · campaña ${lead.campaign}`}
        {lead.listingId !== null && (
          <>
            {" · "}
            <Link
              to={`/propiedades/${lead.listingId}`}
              className="underline underline-offset-2 hover:text-fg"
            >
              ver la propiedad
            </Link>
          </>
        )}
      </p>
      {!erased && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {next.map((status) => (
            <Button
              key={status}
              size="sm"
              variant="secondary"
              loading={change.isPending && change.variables?.status === status}
              onClick={() => change.mutate({ id: lead.id, status })}
            >
              Pasar a {LEAD_STATUS_TEXT[status]}
            </Button>
          ))}
          {confirming ? (
            <span className="flex items-center gap-2 text-sm">
              ¿Borrar sus datos? No se deshace.
              <Button
                size="sm"
                variant="danger"
                loading={erase.isPending}
                onClick={() => erase.mutate(lead.id, { onSuccess: () => setConfirming(false) })}
              >
                Sí, borrar
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                No
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
              Borrar datos
            </Button>
          )}
        </div>
      )}
      {change.error && <ErrorAlert error={change.error} />}
      {erase.error && <ErrorAlert error={erase.error} />}
    </li>
  );
}

/** Conectar ManyChat: el secreto del webhook se muestra una sola vez. */
function WebhookSetup({ brokerId }: { brokerId: string }) {
  const rotate = useRotateWebhookSecret(brokerId);
  const [asking, setAsking] = useState(false);
  const result = rotate.data;
  return (
    <section className="mt-8 rounded-lg border border-line p-4">
      <h2 className="font-semibold text-fg">Conectar ManyChat</h2>
      <p className="mt-1 text-sm text-fg-muted">
        En el flujo de ManyChat agrega un «External Request» (plan Pro) que envíe cada contacto a
        AgentSales con este secreto. Si lo generas de nuevo, el anterior deja de servir.
      </p>
      {result === undefined ? (
        asking ? (
          <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            ¿Generar un secreto nuevo?
            <Button size="sm" loading={rotate.isPending} onClick={() => rotate.mutate()}>
              Sí, generar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
              No
            </Button>
          </p>
        ) : (
          <Button className="mt-3" variant="secondary" onClick={() => setAsking(true)}>
            Generar secreto
          </Button>
        )
      ) : (
        <Alert tone="warning" className="mt-3" title="Cópialo ahora: no se vuelve a mostrar">
          <p className="break-all font-mono text-sm" data-testid="webhook-secret">
            {result.secret}
          </p>
          <p className="mt-2 text-sm">
            Dirección: <code>{`${window.location.origin}${result.path}`}</code> (método POST,
            cabecera <code>x-agentsales-secret</code>)
          </p>
        </Alert>
      )}
      {rotate.error && <ErrorAlert error={rotate.error} />}
    </section>
  );
}

export function LeadsPage() {
  const role = useRole();
  const me = useMe();
  const scoped = useScopedBrokerId();
  const brokerId = role === "admin" ? scoped : (me.data?.brokerId ?? undefined);
  const [params, setParams] = useSearchParams();
  const status = oneOf(params.get("estado"));
  const leads = useLeads(brokerId, status);
  const csv = useLeadsCsv(brokerId);
  const download = () =>
    csv.mutate(undefined, {
      onSuccess: (text) => {
        const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = "leads.csv";
        link.click();
        URL.revokeObjectURL(url);
      },
    });
  return (
    <div>
      <PageHeader
        title="Leads"
        description="Las personas que escribieron por un anuncio o por ManyChat: de qué propiedad vienen y en qué va cada una."
        actions={
          brokerId === undefined ? undefined : (
            <Button variant="secondary" loading={csv.isPending} onClick={download}>
              Exportar CSV
            </Button>
          )
        }
      />
      {brokerId === undefined ? (
        <p className="text-fg-muted">Elige un corredor arriba para ver sus leads.</p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor="lead-status" className="text-xs font-medium text-fg-muted">
              Estado
            </label>
            <Select
              id="lead-status"
              width="auto"
              className="w-fit"
              value={status ?? ""}
              onChange={(event) => {
                const next = new URLSearchParams(params);
                if (event.target.value === "") next.delete("estado");
                else next.set("estado", event.target.value);
                setParams(next, { replace: true });
              }}
            >
              <option value="">Todos</option>
              {LEAD_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {LEAD_STATUS_TEXT[value]}
                </option>
              ))}
            </Select>
          </div>
          {csv.error && <ErrorAlert error={csv.error} />}
          {leads.error && <ErrorAlert error={leads.error} onRetry={() => void leads.refetch()} />}
          {leads.data === undefined && !leads.error && (
            <p className="mt-4 text-fg-muted">Cargando…</p>
          )}
          {leads.data !== undefined &&
            (leads.data.length === 0 ? (
              <p className="mt-4 text-fg-muted">
                No hay leads {status ? "en ese estado" : "todavía"}.
              </p>
            ) : (
              <ul aria-label="Leads" className="mt-4 space-y-2">
                {leads.data.map((lead) => (
                  <LeadRow key={lead.id} lead={lead} />
                ))}
              </ul>
            ))}
          <WebhookSetup brokerId={brokerId} />
        </>
      )}
    </div>
  );
}
