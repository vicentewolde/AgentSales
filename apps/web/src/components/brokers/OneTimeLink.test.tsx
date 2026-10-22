// @vitest-environment jsdom
import type { UserLinkResponse } from "@agentsales/api/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invitationMailto, OneTimeLink } from "./OneTimeLink.js";

// F9.5-T15: «Enviar por correo» arma un `mailto:` con el correo del invitado, el asunto y un
// mensaje breve con el enlace (que nunca va a la URL de la página).

afterEach(cleanup);

const link: UserLinkResponse = {
  user: {
    id: "u-1",
    email: "ana+corredora@ejemplo.cl",
    name: "Ana Pérez",
    role: "broker",
    brokerId: "b-1",
    hasPassword: false,
    disabled: false,
    locked: false,
    lastLoginAt: null,
    totpEnabled: false,
  },
  invitationUrl: "https://panel.ejemplo.cl/invitacion#token-de-prueba&otra=cosa",
  expiresAt: new Date("2026-10-25T13:00:00Z"),
};

/** Lee el `mailto:` como lo haría el programa de correo. */
function parse(mailto: string) {
  expect(mailto.startsWith("mailto:")).toBe(true);
  const [to = "", query = ""] = mailto.slice("mailto:".length).split("?");
  const params = new URLSearchParams(query);
  // Solo dos parámetros: el enlace no se escapa del cuerpo a otro campo.
  expect([...params.keys()]).toEqual(["subject", "body"]);
  return {
    to: decodeURIComponent(to),
    subject: params.get("subject"),
    body: params.get("body") ?? "",
  };
}

describe("enviar el enlace por correo", () => {
  it("la invitación: al correo del invitado, con el asunto y el enlace en el cuerpo", () => {
    const mail = parse(invitationMailto(link, "invitation"));
    expect(mail.to).toBe("ana+corredora@ejemplo.cl");
    expect(mail.subject).toBe("Tu acceso a AgentSales");
    expect(mail.body).toBe(
      [
        "Hola Ana Pérez:",
        "",
        "Te creé un usuario en AgentSales. Para entrar, abre este enlace y elige tu contraseña:",
        "",
        "https://panel.ejemplo.cl/invitacion#token-de-prueba&otra=cosa",
        "",
        "El enlace sirve una sola vez y vence en 72 horas. Si vence, pídeme uno nuevo.",
      ].join("\n"),
    );
  });

  it("todo va codificado: ni el `+` del correo ni el `&` o el `#` del enlace rompen el mailto", () => {
    const mailto = invitationMailto(link, "invitation");
    expect(mailto.startsWith("mailto:ana%2Bcorredora@ejemplo.cl?subject=")).toBe(true);
    expect(mailto).not.toContain("#");
    expect(mailto).not.toContain(" ");
    expect(mailto).toContain(encodeURIComponent(link.invitationUrl));
  });

  it("restablecer: el mismo asunto y un mensaje de contraseña nueva", () => {
    const mail = parse(invitationMailto(link, "reset"));
    expect(mail.subject).toBe("Tu acceso a AgentSales");
    expect(mail.body).toContain("Para elegir una contraseña nueva en AgentSales");
    expect(mail.body).toContain(link.invitationUrl);
    expect(mail.body).not.toContain("Te creé un usuario");
  });

  it("el botón es un enlace al mailto, junto a copiar y ocultar", () => {
    const onDone = vi.fn();
    render(<OneTimeLink link={link} kind="invitation" onDone={onDone} />);
    const send = screen.getByRole("link", { name: "Enviar por correo" });
    expect(send.getAttribute("href")).toBe(invitationMailto(link, "invitation"));
    expect(screen.getByRole("button", { name: "Copiar el enlace" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Listo, ocultarlo" }));
    expect(onDone).toHaveBeenCalledOnce();
    // El enlace no pasa a la dirección de la página.
    expect(window.location.href).not.toContain("token-de-prueba");
  });
});
