import type { UserLinkResponse } from "@agentsales/api/contracts";
import { formatChileTime } from "@agentsales/core";
import { CopyCommand } from "../accounts/CopyCommand.js";

/**
 * El enlace de invitación o de restablecer (ADR-0021): se muestra **una sola vez**, con su botón de
 * copiar; al ocultarlo no vuelve (para otro, "Restablecer").
 */
export function OneTimeLink({ link, onDone }: { link: UserLinkResponse; onDone: () => void }) {
  return (
    <div role="status" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
      <p className="font-medium text-amber-900">
        Enlace para {link.user.email}: se muestra una sola vez. Cópialo y envíaselo por un canal
        privado (vence el {formatChileTime(link.expiresAt)}).
      </p>
      <CopyCommand command={link.invitationUrl} label="Copiar el enlace" />
      <button type="button" onClick={onDone} className="mt-2 text-xs underline">
        Listo, ocultarlo
      </button>
    </div>
  );
}
