// @vitest-environment jsdom
import { fakeInstagramAuth } from "@agentsales/api/testing";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, type HarnessOptions, harness } from "../../test/harness.js";

// F9.5-T20: la pantalla previa a Conectar Instagram.

afterEach(cleanup);

const START_URL = "https://agentsales.test/oauth/instagram/start";

const deps = (oauth: boolean): HarnessOptions["deps"] => ({
  instagram: { auth: fakeInstagramAuth(), oauthConfigured: true, secureCookie: oauth },
  instagramStartUrl: START_URL,
});

describe("panel: antes de Conectar Instagram (F9.5-T20)", () => {
  it("Conectar Instagram de Cuentas lleva a la pantalla que explica, y su botón sigue el flujo", async () => {
    const h = harness({ deps: deps(true) });
    await h.brokers.create(brokerData("casas"));
    h.renderApp("/cuentas");

    const section = await screen.findByRole("region", { name: /casas/ });
    fireEvent.click(
      within(section).getByRole("link", { name: "Conectar Instagram de Marca casas" }),
    );

    expect((await screen.findByRole("heading", { name: "Conectar Instagram" })).textContent).toBe(
      "Conectar Instagram",
    );
    const text = (await screen.findByText("Qué vas a autorizar")).closest("section")?.textContent;
    expect(text).toContain("publicar en la cuenta");
    expect(text).toContain("leer las métricas básicas");
    expect(text).toContain("nunca ve ni guarda tu contraseña");
    const page = document.body.textContent ?? "";
    expect(page).toContain("de empresa o de creador");
    expect(page).toContain("evaluadoras");
    expect(page).toContain("Instagram, en inglés");

    const next = screen.getByRole("link", { name: "Continuar a Instagram" });
    expect(next.getAttribute("href")).toBe(`${START_URL}?broker=casas`);
    expect(screen.getByRole("link", { name: "Cancelar" }).getAttribute("href")).toBe("/cuentas");
  });

  it("el corredor entra a la pantalla de su propia cuenta", async () => {
    const h = harness({ deps: deps(true) });
    const mine = await h.brokers.create(brokerData("mio"));
    h.signInAsBroker(mine.id);
    h.renderApp("/cuentas/instagram?broker=mio");

    const next = await screen.findByRole("link", { name: "Continuar a Instagram" });
    expect(next.getAttribute("href")).toBe(`${START_URL}?broker=mio`);
  });

  it("un corredor que no existe no ofrece continuar", async () => {
    const h = harness({ deps: deps(true) });
    h.renderApp("/cuentas/instagram?broker=nadie");

    expect(await screen.findByText(/No encontramos ese corredor/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Continuar a Instagram" })).toBeNull();
  });

  it("sin el inicio de sesión de Instagram (sin HTTPS) no ofrece continuar", async () => {
    const h = harness({ deps: deps(false) });
    await h.brokers.create(brokerData("casas"));
    h.renderApp("/cuentas/instagram?broker=casas");

    expect(await screen.findByText(/se conecta de otra forma/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Continuar a Instagram" })).toBeNull();
  });
});
