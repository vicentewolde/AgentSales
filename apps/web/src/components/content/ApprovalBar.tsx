import type { ContentView, PublicationView } from "@agentsales/api/contracts";
import { type ListingStatus, PLATFORM_TEXT, PUBLICATION_FORMAT_TEXT } from "@agentsales/core";
import { useApproval } from "../../queries/publications.js";
import { ErrorAlert } from "../ErrorAlert.js";
import { approveBlockedReason, unapproveBlockedReason } from "../publications/publications.js";

const BUTTON =
  "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50";
const PRIMARY =
  "rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-50";

/**
 * Aprobar o quitar la aprobación del texto de un canal (ADR-0014, spec F3 §4.2): la insignia
 * "Aprobado" y el botón, con el motivo si no se puede. Aprobar abre las publicaciones del canal si
 * hay una cuenta conectada; quitar la aprobación descarta las que no salieron.
 */
export function ApprovalBar({
  content,
  listingId,
  listingStatus,
  runActive,
  publications,
}: {
  content: ContentView;
  listingId: string;
  listingStatus: ListingStatus;
  runActive: boolean;
  publications: readonly PublicationView[];
}) {
  const approval = useApproval(listingId);
  const approved = content.status === "approved";
  const blocked = approved
    ? unapproveBlockedReason(content, publications)
    : approveBlockedReason(content, listingStatus, runActive);
  const channel = PLATFORM_TEXT[content.platform];

  return (
    <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {approved && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800">
            Aprobado
          </span>
        )}
        <button
          type="button"
          className={approved ? BUTTON : PRIMARY}
          disabled={approval.isPending || blocked !== null}
          onClick={() => approval.mutate({ contentId: content.id, approve: !approved })}
        >
          {approved ? `Quitar aprobación de ${channel}` : `Aprobar ${channel}`}
        </button>
      </div>
      {blocked !== null && <p className="mt-1 text-xs text-amber-800">{blocked}</p>}
      {approval.data?.skipped.map((skipped) => (
        <p key={skipped.publicationId} className="mt-1 text-xs text-amber-800">
          El {PUBLICATION_FORMAT_TEXT[skipped.format]} ya tiene una publicación activa de un texto
          anterior: retírala o descártala para publicar este.
        </p>
      ))}
      {approval.error && <ErrorAlert error={approval.error} />}
    </div>
  );
}
