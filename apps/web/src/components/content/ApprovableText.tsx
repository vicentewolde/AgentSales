import type { ContentView, ListingPublicationView } from "@agentsales/api/contracts";
import type { ListingStatus, PublishMode } from "@agentsales/core";
import type { ReactNode } from "react";
import { editBlockedReason } from "../publications/publications.js";
import { ApprovalBar } from "./ApprovalBar.js";
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
   * El precio del aviso como está en la planilla (`UF 5.800`), para el plan B de Marketplace cuando
   * ningún intento lo convirtió a pesos (el panel no consulta la UF; spec F5 §4.12).
   */
  listingPrice: string | null;
};

/** El texto con su aprobación y su edición (bloqueada si tiene publicaciones activas). */
export function ApprovableText({
  content,
  edit,
  children,
}: {
  content: ContentView;
  edit: EditContext;
  children: ReactNode;
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
      >
        {children}
      </EditableText>
    </>
  );
}
