// @vitest-environment jsdom
import {
  fakeInstagramAuth,
  fakeMercadoLibreAuth,
  TEST_ML_REDIRECT_URI,
} from "@agentsales/api/testing";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerData, type HarnessOptions, harness } from "../../test/harness.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const DAY = 24 * 60 * 60 * 1000;
const TOKEN = "IGAA-token-del-panel-0123456789";
/** Distinto del que escribiría alguien a mano: el enlace tiene que venir de la API. */
const START_URL = "https://agentsales.test/oauth/instagram/start";

const deps = (oauth: boolean): HarnessOptions["deps"] => ({
  instagram: { auth: fakeInstagramAuth(), oauthConfigured: true, secureCookie: oauth },
  instagramStartUrl: START_URL,
});

/** Un corredor con su cuenta de Instagram, conectada con el token del panel o por OAuth. */
async function withAccount(
  options: {
    oauth?: boolean;
    status?: "connected" | "expired" | "error";
    expiresInDays?: number;
    estimated?: boolean;
    intercept?: HarnessOptions["intercept"];
  } = {},
) {
  const h = harness({
    deps: deps(options.oauth ?? false),
    ...(options.intercept === undefined ? {} : { intercept: options.intercept }),
  });
  const broker = await h.brokers.create(brokerData("marca"));
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
/** El aviso de la vuelta del OAuth: el que tiene Cerrar (no un error de la API). */
const oauthResult = async () => {
  const alerts = await screen.findAllByRole("alert");
  const found = alerts.find((alert) => within(alert).queryByRole("button", { name: "Cerrar" }));
  if (found === undefined) throw new Error("no está el aviso de la conexión");
  return found;
};

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
    // Conectada y lejos de vencer: no se ofrece conectar ni reconectar.
    expect(screen.queryByText(/Conectar Instagram|Reconectar Instagram/)).toBeNull();
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(within(screen.getByRole("navigation")).getByText("Cuentas")).toBeTruthy();
  });

  it("por vencer (10 días o menos): aviso en ámbar con los días, y Reconectar", async () => {
    const { renderApp } = await withAccount({ expiresInDays: 4, estimated: false });
    renderApp("/cuentas");

    const account = await card();
    expect(account.textContent).toContain("vence en 4 días");
    expect(account.textContent).toContain("instagram_business_content_publish");
    expect(screen.getByText("Reconectar Instagram")).toBeTruthy();
  });

  it("vencida: lo dice y ofrece reconectar con el comando de la CLI, en orden", async () => {
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
    const steps = screen.getAllByRole("listitem").map((item) => item.textContent ?? "");
    expect(steps.findIndex((step) => step.startsWith("Copia este comando"))).toBeLessThan(
      steps.findIndex((step) => step.includes("Generate token")),
    );
  });

  it.each([
    [false, "el comando para copiar"],
    [true, "el enlace de la API"],
  ])("sin cuenta (oauth %s): lo dice y muestra %s", async (oauth) => {
    const h = harness({ deps: deps(oauth) });
    await h.brokers.create(brokerData("sin-cuenta"));
    h.renderApp("/cuentas");

    const section = await screen.findByRole("region", { name: /sin-cuenta/ });
    expect(within(section).getByText("Sin cuenta de Instagram.")).toBeTruthy();
    if (oauth) {
      const link = within(section).getByRole("link", {
        name: "Conectar Instagram de Marca sin-cuenta",
      });
      expect(link.getAttribute("href")).toBe(`${START_URL}?broker=sin-cuenta`);
    } else {
      expect(within(section).queryByRole("link")).toBeNull();
      expect(section.textContent).toContain("--broker sin-cuenta --token-stdin");
    }
  });

  it("Copiar avisa si copió o si no pudo", async () => {
    for (const [writeText, text] of [
      [vi.fn(async () => {}), "Copiado"],
      [
        vi.fn(async () => {
          throw new Error("sin permiso");
        }),
        "No se pudo copiar: selecciónalo a mano",
      ],
    ] as const) {
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      const { renderApp } = await withAccount({ status: "expired" });
      renderApp("/cuentas");

      fireEvent.click(await screen.findByRole("button", { name: "Copiar el comando de marca" }));
      expect(await screen.findByText(text)).toBeTruthy();
      expect(writeText).toHaveBeenCalledWith(
        "pbpaste | pnpm -s cli accounts connect instagram --broker marca --token-stdin",
      );
      cleanup();
    }
  });

  it("vuelta del OAuth con error: el motivo legible, y Cerrar lo quita", async () => {
    const { renderApp } = await withAccount();
    renderApp("/cuentas?error=OAUTH_DENIED");

    const alert = await oauthResult();
    expect(alert.textContent).toContain("Rechazaste los permisos en Instagram");
    fireEvent.click(within(alert).getByRole("button", { name: "Cerrar" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["IG_PERMISSION_DENIED", "No diste el permiso de publicar"],
    ["IG_NUEVO_CODIGO", "No se pudo conectar Instagram (IG_NUEVO_CODIGO)."],
    ["<script>alert(1)</script>", "No se pudo conectar Instagram."],
  ])("vuelta del OAuth con %s", async (code, text) => {
    const { renderApp } = await withAccount();
    renderApp(`/cuentas?error=${encodeURIComponent(code)}`);

    expect((await oauthResult()).textContent).toContain(text);
    expect(document.body.innerHTML).not.toContain("<script>");
  });

  it("vuelta del OAuth conectada: lo confirma; otro valor de conectada no dice nada", async () => {
    const { renderApp } = await withAccount();
    renderApp("/cuentas?conectada=instagram");
    const message = await screen.findByText("Cuenta de Instagram conectada.");
    expect(message.closest("[role=status]")).not.toBeNull();
    cleanup();

    const other = await withAccount();
    other.renderApp("/cuentas?conectada=otra");
    await card();
    expect(screen.queryByText("Cuenta de Instagram conectada.")).toBeNull();
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

  it("si Desconectar falla, lo dice en la tarjeta y la cuenta sigue conectada", async () => {
    const { renderApp, platformAccounts, account } = await withAccount({
      intercept: (method, path) => {
        if (method === "POST" && path.endsWith("/disconnect")) throw new Error("red caída");
        return undefined;
      },
    });
    renderApp("/cuentas");

    fireEvent.click(within(await card()).getByRole("button", { name: "Desconectar" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí, desconectar" }));

    const alert = await within(await card()).findByRole("alert");
    expect(alert.textContent).toContain("La API no responde");
    expect(within(await card()).getByRole("button", { name: "Desconectar" })).toBeTruthy();
    expect((await platformAccounts.get(account.id))?.status).toBe("connected");
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

  describe("Mercado Libre (F4-T21)", () => {
    const ML_PASTE =
      "pbpaste | pnpm -s cli accounts connect mercadolibre --broker marca --url-stdin";
    const ML_TOKENS = { accessToken: "APP_USR-acceso-0123", refreshToken: "TG-renovar-0123" };

    async function withMercadoLibre(
      options: { status?: "connected" | "expired"; configured?: boolean; account?: boolean } = {},
    ) {
      const h = harness({
        deps: {
          ...deps(false),
          mercadoLibre: {
            auth: fakeMercadoLibreAuth(),
            configured: options.configured ?? true,
            redirectUri: TEST_ML_REDIRECT_URI,
          },
        },
      });
      const broker = await h.brokers.create(brokerData("marca"));
      if (options.account === false) return { ...h, broker };
      const account = await h.platformAccounts.upsertConnected({
        brokerId: broker.id,
        platform: "portal_inmobiliario",
        externalAccountId: "8035443",
        displayName: "VICENTEWOLDE",
        tokenExpiresAt: new Date(Date.now() + 180 * DAY),
        meta: {
          userId: "8035443",
          nickname: "VICENTEWOLDE",
          siteId: "MLC",
          userType: "normal",
          scopes: ["offline_access", "read", "write"],
          testUser: false,
          connectedAt: new Date(Date.now() - DAY).toISOString(),
          tokenRefreshedAt: null,
          accessTokenExpiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
          tokenExpiryEstimated: true,
        },
        credentials: ML_TOKENS,
      });
      if (options.status === "expired") {
        await h.platformAccounts.changeStatus(account.id, "connected", "expired");
      }
      return { ...h, broker, account };
    }

    const mlChannel = async () => {
      const section = await screen.findByRole("region", { name: /marca/ });
      const heading = within(section).getByRole("heading", {
        name: "Mercado Libre (Portal Inmobiliario)",
      });
      const channel = heading.parentElement;
      if (channel === null) throw new Error("falta el bloque de Mercado Libre");
      return channel;
    };

    it("conectada: el nickname tal cual, vencimiento estimado, tipo y permisos; sin pasos ni tokens", async () => {
      const { renderApp } = await withMercadoLibre();
      renderApp("/cuentas");

      const account = await screen.findByRole("article", { name: "Cuenta VICENTEWOLDE" });
      expect(within(account).getByText("conectada")).toBeTruthy();
      expect(account.textContent).toContain("(estimado)");
      expect(account.textContent).toContain("normal");
      expect(account.textContent).toContain("offline_access, read, write");
      expect(account.textContent).toContain("se renueva sola cada 7 días mientras el worker corre");
      expect(account.textContent).not.toContain("@VICENTEWOLDE");
      expect((await mlChannel()).textContent).not.toContain("Conectar Mercado Libre");
      // Instagram, sin cuenta, sigue ofreciendo conectarse aparte.
      expect(screen.getByText("Sin cuenta de Instagram.")).toBeTruthy();
      expect(document.body.textContent).not.toContain(ML_TOKENS.accessToken);
      expect(document.body.textContent).not.toContain(ML_TOKENS.refreshToken);
    });

    it("sin cuenta: los dos pasos en orden, con la dirección de vuelta y los comandos para copiar", async () => {
      const writeText = vi.fn(async () => {});
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      const { renderApp } = await withMercadoLibre({ account: false });
      renderApp("/cuentas");

      const channel = await mlChannel();
      expect(within(channel).getByText("Sin cuenta de Mercado Libre.")).toBeTruthy();
      expect(within(channel).getByText("Conectar Mercado Libre")).toBeTruthy();
      const steps = within(channel)
        .getAllByRole("listitem")
        .map((item) => item.textContent ?? "");
      expect(steps).toHaveLength(2);
      expect(steps[0]).toContain("pnpm -s cli accounts connect mercadolibre --broker marca");
      expect(steps[1]).toContain(TEST_ML_REDIRECT_URI);
      expect(steps[1]).toContain(ML_PASTE);

      fireEvent.click(
        within(channel).getByRole("button", {
          name: "Copiar el comando que pega la dirección de marca",
        }),
      );
      expect(await within(channel).findByText("Copiado")).toBeTruthy();
      expect(writeText).toHaveBeenCalledWith(ML_PASTE);
    });

    it("vencida: lo dice y ofrece reconectar", async () => {
      const { renderApp } = await withMercadoLibre({ status: "expired" });
      renderApp("/cuentas");

      const account = await screen.findByRole("article", { name: "Cuenta VICENTEWOLDE" });
      expect(within(account).getByText("vencida")).toBeTruthy();
      expect(within(await mlChannel()).getByText("Reconectar Mercado Libre")).toBeTruthy();
    });

    it("sin el par de la app en la API: lo dice en vez de mostrar los pasos", async () => {
      const { renderApp } = await withMercadoLibre({ account: false, configured: false });
      renderApp("/cuentas");

      const channel = await mlChannel();
      expect(channel.textContent).toContain("A la API le faltan ML_APP_ID y ML_CLIENT_SECRET");
      expect(within(channel).queryByRole("listitem")).toBeNull();
      expect(channel.textContent).not.toContain("--url-stdin");
    });
  });
});
