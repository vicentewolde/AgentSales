import type { KnowledgeProposalJson } from "@agentsales/api/contracts";
import { BRAND_KNOWLEDGE_LIMITS } from "@agentsales/core";
import { type FormEvent, useState } from "react";
import {
  useAcceptProposal,
  useDiscardProposal,
  useKnowledgeProposals,
  useRequestProposals,
} from "../../queries/brand-knowledge.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { Alert } from "../ui/Alert.js";
import { Button } from "../ui/Button.js";
import { Field, Input, Textarea } from "../ui/Field.js";

// «Actualizar desde un texto largo» (spec F9.7 B2, ADR-0043 punto 2): pegas un texto, la IA propone
// novedades y hechos, y tú aceptas (con edición) o descartas cada uno. Nada entra solo (D2).

const L = BRAND_KNOWLEDGE_LIMITS;

function ProposalCard({
  brokerId,
  proposal,
}: {
  brokerId: string;
  proposal: KnowledgeProposalJson;
}) {
  const accept = useAcceptProposal(brokerId);
  const discard = useDiscardProposal(brokerId);
  const [text, setText] = useState(proposal.text);
  const [project, setProject] = useState(proposal.project ?? "");
  const [date, setDate] = useState(proposal.date ?? "");
  const isUpdate = proposal.kind === "update";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    accept.mutate({
      proposalId: proposal.id,
      json: {
        text,
        ...(isUpdate ? { project, ...(date === "" ? {} : { date }) } : {}),
      },
    });
  };
  return (
    <li className="rounded-xl border border-line-soft p-3">
      <form onSubmit={submit} aria-label={isUpdate ? "Novedad propuesta" : "Hecho propuesto"}>
        <p className="text-xs font-semibold text-fg-muted">
          {isUpdate ? "Novedad propuesta" : "Hecho propuesto (se suma a los hechos del perfil)"}
        </p>
        <Field label="Texto" className="mt-1">
          <Textarea
            rows={2}
            value={text}
            maxLength={L.updateText}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        {isUpdate && (
          <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto]">
            <Field label="Proyecto">
              <Input
                value={project}
                maxLength={L.project}
                onChange={(e) => setProject(e.target.value)}
              />
            </Field>
            <Field label="Fecha" hint={date === "" ? "Sin fecha: queda la de hoy" : undefined}>
              <Input
                type="date"
                width="auto"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
          </div>
        )}
        {(accept.error ?? discard.error) && (
          <ErrorAlert error={(accept.error ?? discard.error) as Error} />
        )}
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="submit" size="sm" loading={accept.isPending}>
            Aceptar
          </Button>
          <Button
            variant="ghost"
            size="sm"
            loading={discard.isPending}
            onClick={() => discard.mutate(proposal.id)}
          >
            Descartar
          </Button>
        </div>
      </form>
    </li>
  );
}

export function KnowledgeProposals({ brokerId }: { brokerId: string }) {
  const proposals = useKnowledgeProposals(brokerId);
  const request = useRequestProposals(brokerId);
  const [text, setText] = useState("");
  const running = proposals.data?.runs.find(
    (run) => run.status === "queued" || run.status === "running",
  );
  const [last] = proposals.data?.runs ?? [];
  const submit = (event: FormEvent) => {
    event.preventDefault();
    request.mutate(text, { onSuccess: () => setText("") });
  };
  return (
    <div className="mt-6">
      <h3 className="text-base font-semibold">Actualizar desde un texto</h3>
      <p className="text-xs text-fg-subtle">
        Pega un informe, notas de una reunión o el README de un proyecto (hasta{" "}
        {L.sourceText.toLocaleString("es-CL")} caracteres). La IA propone novedades y hechos; nada
        entra sin que lo aceptes. Gasta IA de la marca.
      </p>
      <form onSubmit={submit} className="mt-2" aria-label="Leer un texto">
        <Field label="Texto">
          <Textarea
            rows={6}
            maxLength={L.sourceText}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        {request.error && <ErrorAlert error={request.error} />}
        <Button
          type="submit"
          variant="secondary"
          className="mt-2"
          loading={request.isPending}
          disabled={running !== undefined || text.trim().length < 20}
        >
          Leer y proponer
        </Button>
      </form>
      {running !== undefined && (
        <p role="status" className="mt-2 text-sm text-fg-muted">
          La IA está leyendo el texto…
        </p>
      )}
      {last?.status === "failed" && running === undefined && (
        <Alert tone="warning" className="mt-2" role="status">
          La última lectura falló: {last.error?.message ?? "vuelve a intentarlo"}
        </Alert>
      )}
      {last?.status === "succeeded" && last.warnings.length > 0 && (
        <Alert tone="info" className="mt-2">
          {last.warnings.join(" ")}
        </Alert>
      )}
      {proposals.error && <ErrorAlert error={proposals.error} />}
      {(proposals.data?.pending.length ?? 0) > 0 && (
        <>
          <h4 className="mt-4 text-sm font-semibold">Propuestas que esperan tu decisión</h4>
          <ul className="mt-2 space-y-2">
            {proposals.data?.pending.map((proposal) => (
              <ProposalCard key={proposal.id} brokerId={brokerId} proposal={proposal} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
