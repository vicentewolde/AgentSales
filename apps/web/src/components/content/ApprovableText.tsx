import type { ContentView, ListingPublicationView } from "@agentsales/api/contracts";
import type { ListingStatus, PublishMode } from "@agentsales/core";
import type { ReactNode } from "react";
import type { PreviewText } from "../preview/preview.js";
import { editBlockedReason } from "../publications/publications.js";
import { ApprovalBar } from "./ApprovalBar.js";
import type { ListingPrice } from "./marketplace.js";
import { EditableText } from "./TextEditor.js";

/**
 * Lo que necesita un texto para poder editarse, aprobarse y publicarse (F3-T18): las publicaciones
 * del aviso, el modo de la API, el estado del aviso y si hay una preparación en curso.
 */
export type EditContext = {
  listingId: string;
  lockReason: string | null;
  onReload: () => void;
  listingStatus: ListingStatus;
  /** Cualquier preparación en curso (también la de solo imágenes): bloquea aprobar y publicar. */
  runActive: boolean;
  publications: readonly ListingPublicationView[];
  publishMode: PublishMode | undefined;
  /**
   * El precio del aviso como está en la planilla, para el plan B de Marketplace cuando
   * ningún intento lo convirtió a pesos (el panel no consulta la UF; spec F5 §4.12).
   */
  listingPrice: ListingPrice | null;
};

/**
 * El texto con su aprobación y su edición (bloqueada si tiene publicaciones activas). La vista
 * previa la arma quien lo usa, con el borrador que avisa `onDraft` mientras se edita.
 */
export function ApprovableText({
  content,
  edit,
  onDraft,
  children,
}: {
  content: ContentView;
  edit: EditContext;
  onDraft?: (draft: PreviewText | null) => void;
  children?: ReactNode;
}) {
  return (
    <>
      <ApprovalBar
        content={content}
        listingId={edit.listingId}
        listingStatus={edit.listingStatus}
        runActive={edit.runActive}
        publications={edit.publications}
      />
      <EditableText
        content={content}
        listingId={edit.listingId}
        lockReason={edit.lockReason ?? editBlockedReason(content, edit.publications)}
        onReload={edit.onReload}
        onDraft={onDraft}
      >
        {children}
      </EditableText>
    </>
  );
}
