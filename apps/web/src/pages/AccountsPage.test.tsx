// @vitest-environment jsdom
import { fakeInstagramAuth } from "@agentsales/api/testing";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";

afterEach(cleanup);

const DAY = 24 * 60 * 60 * 1000;
const TOKEN = "IGAA-token-del-panel-0123456789";

/** Un corredor con su cuenta de Instagram, conectada con el token del panel o por OAuth. */
async function withAccount(
  options: {
    oauth?: boolean;
    status?: "connected" | "expired" | "error";
    expiresInDays?: number;
    estimated?: boolean;
    slug?: string;
  } = {},
) {
  const h = harness({
    deps: {
      instagram: {
        auth: fakeInstagramAuth(),
        oauthConfigured: true,
        secureCookie: options.oauth ?? false,
      },
    },
  });
  const broker = await h.brokers.create(brokerData(options.slug ?? "marca"));
  const estimated = options.estimated ?? true;
  const account = await h.platformAccounts.upsertConnected({
    brokerId: broker.id,
    platform: "instagram",
    externalAccountId: "17841400000000001",
    displayName: "@corredora",
    tokenExpiresAt: new Date(Date.now() + (options.expiresInDays ?? 59) * DAY),
    meta: {
      accountType: "BUSINESS",
      permissions: estimated
        ? null
        : ["instagram_business_basic", "instagram_business_content_publish"],
      connectedAt: new Date(Date.now() - DAY).toISOString(),
      tokenRefreshedAt: estimated ? null : new Date(Date.now() - DAY).toISOString(),
      tokenExpiryEstimated: estimated,
    },
    credentials: { accessToken: TOKEN },
  });
  if (options.status !== undefined && options.status !== "connected") {
    await h.platformAccounts.changeStatus(account.id, "connected", options.status);
  }
  return { ...h, broker, account };
}

const card = () => screen.findByRole("article", { name: "Cuenta @corredora" });

describe("panel: Cuentas", () => {
  it("conectada: estado, vencimiento estimado, permisos desconocidos y Desconectar; sin token", async () => {
    const { renderApp } = await withAccount();
    renderApp("/cuentas");

    const account = await card();
    expect(within(account).getByText("conectada")).toBeTruthy();
    expect(account.textContent).toContain("(estimado)");
    expect(account.textContent).toContain(
      "Desconocidos (se conectó con el token del panel de Meta)",
    );
    expect(account.textContent).toContain("Todavía no (se renueva sola a las 24 h de conectarla)");
    expect(account.textContent).not.toContain("vence en");
    expect(within(account).getByRole("button", { name: "Desconectar" })).toBeTruthy();
    // Con una cuenta conectada no se ofrece conectar otra.
    expect(screen.queryByText("Conectar Instagram")).toBeNull();
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(within(screen.getByRole("navigation")).getByText("Cuentas")).toBeTruthy();
  });

  it("por vencer (10 días o menos) avisa en ámbar con los días que quedan", async () => {
    const { renderApp } = await withAccount({ expiresInDays: 4, estimated: false });
    renderApp("/cuentas");

    const account = await card();
    expect(account.textContent).toContain("vence en 4 días");
    expect(account.textContent).toContain("instagram_business_content_publish");
  });

  it("vencida: lo dice y ofrece reconectar con el comando de la CLI", async () => {
    const { renderApp } = await withAccount({ status: "expired" });
    renderApp("/cuentas");

    const account = await card();
    expect(within(account).getByText("vencida")).toBeTruthy();
    expect(account.textContent).toContain("El acceso venció: reconecta la cuenta");
    expect(screen.getByText("Reconectar Instagram")).toBeTruthy();
    expect(
      screen.getByText(
        "pbpaste | pnpm -s cli accounts connect instagram --broker marca --token-stdin",
      ),
    ).toBeTruthy();
  });

  it("sin cuenta: lo dice y muestra cómo conectar (en F3, el comando; con https, el botón)", async () => {
    for (const oauth of [false, true]) {
      const h = harness({
        deps: {
          instagram: { auth: fakeInstagramAuth(), oauthConfigured: true, secureCookie: oauth },
        },
      });
      await h.brokers.create(brokerData("sin-cuenta"));
      h.renderApp("/cuentas");

      const section = await screen.findByRole("region", { name: "Corredor sin-cuenta" });
      expect(within(section).getByText("Sin cuenta de Instagram.")).toBeTruthy();
      if (oauth) {
        const link = within(section).getByRole("link", { name: "Conectar Instagram" });
        expect(link.getAttribute("href")).toBe(
          "http://localhost:8787/oauth/instagram/start?broker=sin-cuenta",
        );
      } else {
        expect(within(section).queryByRole("link")).toBeNull();
        expect(section.textContent).toContain("--broker sin-cuenta --token-stdin");
      }
      cleanup();
    }
  });

  it("vuelta del OAuth con error: el motivo legible, y Cerrar lo quita", async () => {
    const { renderApp } = await withAccount();
    renderApp("/cuentas?error=OAUTH_DENIED");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Rechazaste los permisos en Instagram");
    fireEvent.click(within(alert).getByRole("button", { name: "Cerrar" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("vuelta del OAuth: un error de Instagram, uno desconocido y uno manipulado", async () => {
    for (const [code, text] of [
      ["IG_PERMISSION_DENIED", "No diste el permiso de publicar"],
      ["IG_NUEVO_CODIGO", "No se pudo conectar Instagram (IG_NUEVO_CODIGO)."],
      ["<script>alert(1)</script>", "No se pudo conectar Instagram."],
    ] as const) {
      const { renderApp } = await withAccount();
      renderApp(`/cuentas?error=${encodeURIComponent(code)}`);

      expect((await screen.findByRole("alert")).textContent).toContain(text);
      expect(document.body.innerHTML).not.toContain("<script>");
      cleanup();
    }
  });

  it("vuelta del OAuth conectada: lo confirma", async () => {
    const { renderApp } = await withAccount();
    renderApp("/cuentas?conectada=instagram");

    const message = await screen.findByText("Cuenta de Instagram conectada.");
    expect(message.closest("[role=status]")).not.toBeNull();
  });

  it("Desconectar pide confirmación y deja la cuenta desconectada", async () => {
    const { renderApp, platformAccounts, account, requests } = await withAccount();
    renderApp("/cuentas");

    fireEvent.click(within(await card()).getByRole("button", { name: "Desconectar" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(requests.some((request) => request.includes("/disconnect"))).toBe(false);

    fireEvent.click(within(await card()).getByRole("button", { name: "Desconectar" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí, desconectar" }));

    expect(await within(await card()).findByText("desconectada")).toBeTruthy();
    await screen.findByText("Reconectar Instagram");
    expect((await platformAccounts.get(account.id))?.status).toBe("revoked");
    expect(requests).toContain(`POST /accounts/${account.id}/disconnect`);
  });

  it("si la API no responde, lo dice con Reintentar", async () => {
    const h = harness({
      intercept: (_method, path) => {
        if (path === "/accounts") throw new Error("red caída");
        return undefined;
      },
    });
    h.renderApp("/cuentas");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("La API no responde");
    expect(within(alert).getByRole("button", { name: "Reintentar" })).toBeTruthy();
  });
});
