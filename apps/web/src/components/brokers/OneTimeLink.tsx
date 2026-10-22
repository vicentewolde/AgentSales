import type { UserLinkResponse } from "@agentsales/api/contracts";
import { formatChileTime, INVITATION_TTL_MS } from "@agentsales/core";
import { useState } from "react";
import { CopyCommand } from "../accounts/CopyCommand.js";
import { Button } from "../ui/Button.js";
import { buttonClasses } from "../ui/styles.js";
import type { OneTimeLinkKind } from "./one-time-link-store.js";

export type { OneTimeLinkKind } from "./one-time-link-store.js";

export const INVITATION_MAIL_SUBJECT = "Tu acceso a AgentSales";

/**
 * El mensaje que se le manda a la persona (F9.5-T20): el saludo, para qué es el enlace, el enlace
 * y cuándo vence. Es el mismo texto del correo de «Enviar por correo» y el de «Copiar mensaje
 * completo». El nombre va en una sola línea (sin saltos ni espacios de más) y las horas salen del
 * vencimiento de core, no fijas.
 */
export function invitationMessage(link: UserLinkResponse, kind: OneTimeLinkKind): string {
  const intro =
    kind === "invitation"
      ? "Te creé un usuario en AgentSales. Para entrar, abre este enlace y elige tu contraseña:"
      : "Para elegir una contraseña nueva en AgentSales, abre este enlace:";
  const name = link.user.name.replace(/\s+/g, " ").trim();
  const hours = Math.round(INVITATION_TTL_MS / (60 * 60 * 1000));
  return [
    name === "" ? "Hola:" : `Hola ${name}:`,
    "",
    intro,
    "",
    link.invitationUrl,
    "",
    `El enlace sirve una sola vez y vence en ${hours} horas. Si vence, pídeme uno nuevo.`,
  ].join("\n");
}

/**
 * El `mailto:` de «Enviar por correo» (F9.5-T15): al correo del invitado, con el asunto y el mensaje
 * (`invitationMessage`). El enlace va solo en el cuerpo del correo: nunca en la URL de la página ni
 * en los logs. Todo va codificado (`encodeURIComponent`); la arroba del correo queda legible.
 */
export function invitationMailto(link: UserLinkResponse, kind: OneTimeLinkKind): string {
  const body = invitationMessage(link, kind);
  const to = encodeURIComponent(link.user.email).replaceAll("%40", "@");
  return `mailto:${to}?subject=${encodeURIComponent(INVITATION_MAIL_SUBJECT)}&body=${encodeURIComponent(body)}`;
}

/**
 * El enlace de invitación o de restablecer (ADR-0021), con su botón de copiarlo, el de copiar el
 * mensaje completo y el de enviarlo por correo. Se queda a la vista, aunque se recargue la página
 * (la página lo guarda en `sessionStorage`, F9.5-T20), hasta que se oculta con «Listo, ocultarlo»
 * o vence; después no vuelve: para otro, «Restablecer».
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
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(invitationMessage(link, kind));
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <div
      role="status"
      className="mt-3 rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm"
    >
      <p className="font-medium text-warning-800">
        Enlace para {link.user.email}: sirve una sola vez y vence el{" "}
        {formatChileTime(link.expiresAt)}. Cópialo o envíaselo por correo.
      </p>
      <p className="mt-1 text-xs text-warning-800">
        Queda aquí hasta que lo ocultes. Si perdiste el enlace, usa Restablecer.
      </p>
      <CopyCommand command={link.invitationUrl} label="Copiar el enlace" />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" onClick={() => void copyMessage()}>
          Copiar mensaje completo
        </Button>
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
        <span role="status" className="text-xs text-fg-muted">
          {copied === "copied" && "Mensaje copiado"}
          {copied === "failed" && "No se pudo copiar: usa Enviar por correo"}
        </span>
      </div>
    </div>
  );
}
