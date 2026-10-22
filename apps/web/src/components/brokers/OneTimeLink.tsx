import type { UserLinkResponse } from "@agentsales/api/contracts";
import { formatChileTime, INVITATION_TTL_MS } from "@agentsales/core";
import { CopyCommand } from "../accounts/CopyCommand.js";
import { Button } from "../ui/Button.js";
import { buttonClasses } from "../ui/styles.js";

/** Si el enlace crea el usuario (invitar) o elige una contraseña nueva (restablecer). */
export type OneTimeLinkKind = "invitation" | "reset";

export const INVITATION_MAIL_SUBJECT = "Tu acceso a AgentSales";

/**
 * El `mailto:` de «Enviar por correo» (F9.5-T15): al correo del invitado, con el asunto y un mensaje
 * breve con el enlace. El enlace va solo en el cuerpo del correo: nunca en la URL de la página ni
 * en los logs. Todo va codificado (`encodeURIComponent`); la arroba del correo queda legible. El
 * nombre va en una sola línea (sin saltos ni espacios de más) y las horas salen del vencimiento de
 * core, no fijas.
 */
export function invitationMailto(link: UserLinkResponse, kind: OneTimeLinkKind): string {
  const intro =
    kind === "invitation"
      ? "Te creé un usuario en AgentSales. Para entrar, abre este enlace y elige tu contraseña:"
      : "Para elegir una contraseña nueva en AgentSales, abre este enlace:";
  const name = link.user.name.replace(/\s+/g, " ").trim();
  const hours = Math.round(INVITATION_TTL_MS / (60 * 60 * 1000));
  const body = [
    name === "" ? "Hola:" : `Hola ${name}:`,
    "",
    intro,
    "",
    link.invitationUrl,
    "",
    `El enlace sirve una sola vez y vence en ${hours} horas. Si vence, pídeme uno nuevo.`,
  ].join("\n");
  const to = encodeURIComponent(link.user.email).replaceAll("%40", "@");
  return `mailto:${to}?subject=${encodeURIComponent(INVITATION_MAIL_SUBJECT)}&body=${encodeURIComponent(body)}`;
}

/**
 * El enlace de invitación o de restablecer (ADR-0021): se muestra **una sola vez**, con su botón de
 * copiar y el de enviarlo por correo; al ocultarlo no vuelve (para otro, "Restablecer").
 */
export function OneTimeLink({
  link,
  kind,
  onDone,
}: {
  link: UserLinkResponse;
  kind: OneTimeLinkKind;
  onDone: () => void;
}) {
  return (
    <div
      role="status"
      className="mt-3 rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm"
    >
      <p className="font-medium text-warning-800">
        Enlace para {link.user.email}: se muestra una sola vez. Cópialo o envíaselo por correo
        (vence el {formatChileTime(link.expiresAt)}).
      </p>
      <CopyCommand command={link.invitationUrl} label="Copiar el enlace" />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <a
          href={invitationMailto(link, kind)}
          aria-label="Enviar por correo: abre tu programa de correo"
          className={buttonClasses("secondary", "sm")}
        >
          Enviar por correo
        </a>
        <Button variant="link" onClick={onDone} className="text-xs">
          Listo, ocultarlo
        </Button>
      </div>
    </div>
  );
}
