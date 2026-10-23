import type { ContentView, PublicationView } from "@agentsales/api/contracts";
import { type ListingStatus, PLATFORM_TEXT, publicationFormatText } from "@agentsales/core";
import { useApproval } from "../../queries/publications.js";
import { ErrorAlert } from "../ErrorAlert.js";
import {
  approveBlockedReason,
  retireVerb,
  unapproveBlockedReason,
} from "../publications/publications.js";
import { Badge } from "../ui/Badge.js";
import { Button } from "../ui/Button.js";

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
    <div className="mb-3 rounded-lg border border-line bg-canvas p-3">
      <div className="flex flex-wrap items-center gap-2">
        {approved && <Badge tone="success">Aprobado</Badge>}
        <Button
          variant={approved ? "secondary" : "primary"}
          size="sm"
          disabled={approval.isPending || blocked !== null}
          onClick={() => approval.mutate({ contentId: content.id, approve: !approved })}
        >
          {approved ? `Quitar aprobación de ${channel}` : `Aprobar ${channel}`}
        </Button>
      </div>
      {blocked !== null && <p className="mt-1 text-xs text-warning-800">{blocked}</p>}
      {approval.data?.skipped.map((skipped) => (
        <p key={skipped.publicationId} className="mt-1 text-xs text-warning-800">
          El {publicationFormatText(content.platform, skipped.format, null)} ya tiene una
          publicación activa de un texto anterior: {retireVerb(content.platform)} o descártala para
          publicar este.
        </p>
      ))}
      {approval.error && <ErrorAlert error={approval.error} />}
    </div>
  );
}
