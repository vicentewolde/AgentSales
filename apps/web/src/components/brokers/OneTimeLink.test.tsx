// @vitest-environment jsdom
import type { UserLinkResponse } from "@agentsales/api/contracts";
import { INVITATION_TTL_MS } from "@agentsales/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invitationMailto, invitationMessage, OneTimeLink } from "./OneTimeLink.js";

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
        `El enlace sirve una sola vez y vence en ${INVITATION_TTL_MS / 3_600_000} horas. Si vence, pídeme uno nuevo.`,
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

  it("hostil: un correo o un nombre con campos de más no agregan destinatarios ni cabeceras", () => {
    const cases: [string, string][] = [
      ["a?cc=x@b.cl", "Ana"],
      ["ana&bcc=x@y.cl", "Ana"],
      ["ana@ejemplo.cl", "Ana\r\nBcc: x@y.cl"],
    ];
    for (const [email, name] of cases) {
      const mailto = invitationMailto(
        { ...link, user: { ...link.user, email, name } },
        "invitation",
      );
      expect(mailto).not.toMatch(/[\r\n]/);
      // `parse` exige que el mailto tenga solo subject y body.
      const mail = parse(mailto);
      expect(mail.to).toBe(email);
      expect(mail.body).not.toMatch(/\r/);
      expect(mail.body.split("\n")[0]).toBe(`Hola ${name.replace(/\s+/g, " ")}:`);
    }
  });

  it("sin nombre, saluda con «Hola:»", () => {
    const mail = parse(invitationMailto({ ...link, user: { ...link.user, name: "  " } }, "reset"));
    expect(mail.body.startsWith("Hola:\n")).toBe(true);
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
    const send = screen.getByRole("link", {
      name: "Enviar por correo: abre tu programa de correo",
    });
    expect(send.textContent).toBe("Enviar por correo");
    expect(send.getAttribute("href")).toBe(invitationMailto(link, "invitation"));
    expect(screen.getByRole("button", { name: "Copiar el enlace" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Listo, ocultarlo" }));
    expect(onDone).toHaveBeenCalledOnce();
    // El enlace no pasa a la dirección de la página.
    expect(window.location.href).not.toContain("token-de-prueba");
  });

  it("dice que se queda hasta ocultarlo y que, si se perdió, se usa Restablecer (F9.5-T20)", () => {
    render(<OneTimeLink link={link} kind="invitation" onDone={() => {}} />);
    const box = screen.getByText(/Si perdiste el enlace, usa Restablecer/);
    expect(box.textContent).toContain("Queda aquí hasta que lo ocultes");
  });

  it("Copiar mensaje completo copia el mismo texto del correo, y avisa si no pudo", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<OneTimeLink link={link} kind="reset" onDone={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Copiar mensaje completo" }));
    expect(await screen.findByText("Mensaje copiado")).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(invitationMessage(link, "reset"));
    // Es el cuerpo del correo, sin el codificado de la URL.
    const mailBody = new URLSearchParams(invitationMailto(link, "reset").split("?")[1]).get("body");
    expect(writeText.mock.calls[0]?.[0]).toBe(mailBody);

    writeText.mockRejectedValueOnce(new Error("sin permiso"));
    fireEvent.click(screen.getByRole("button", { name: "Copiar mensaje completo" }));
    expect(await screen.findByText(/No se pudo copiar: usa Enviar por correo/)).toBeTruthy();
    vi.unstubAllGlobals();
  });
});
