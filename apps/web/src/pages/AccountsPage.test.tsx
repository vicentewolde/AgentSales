// @vitest-environment jsdom
import {
  fakeInstagramAuth,
  fakeMercadoLibreAuth,
  TEST_ML_REDIRECT_URI,
} from "@agentsales/api/testing";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerData, type HarnessOptions, harness } from "../../test/harness.js";
import { goTo } from "../navigation.js";

// La autorización de Mercado Libre abre otra dirección: jsdom no navega.
vi.mock("../navigation.js", () => ({ goTo: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.mocked(goTo).mockClear();
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
    await h.brokers.create(brokerData("sin-cuenta"), { kind: "brand" });
    h.renderApp("/cuentas");

    const section = await screen.findByRole("region", { name: /sin-cuenta/ });
    expect(within(section).getByText("Sin cuenta de Instagram.")).toBeTruthy();
    if (oauth) {
      const link = within(section).getByRole("link", {
        name: "Conectar Instagram de Marca sin-cuenta",
      });
      // Antes de ir a Instagram, la pantalla que explica qué se autoriza (F9.5-T20).
      expect(link.getAttribute("href")).toBe("/cuentas/instagram?broker=sin-cuenta");
    } else {
      // Solo en Instagram: LinkedIn, X y TikTok tienen su propio enlace desde F9-T19.
      const instagram = within(section).getByRole("region", { name: "Instagram" });
      expect(within(instagram).queryByRole("link")).toBeNull();
      expect(instagram.textContent).toContain("--broker sin-cuenta --token-stdin");
    }
  });

  it("el corredor conecta su propio Instagram con el botón (ADR-0028), pero no ve el comando de la CLI", async () => {
    const h = harness({ deps: deps(true) });
    const mine = await h.brokers.create(brokerData("mio"));
    h.signInAsBroker(mine.id);
    h.renderApp("/cuentas");

    const section = await screen.findByRole("region", { name: /mio/ });
    const link = within(section).getByRole("link", { name: "Conectar Instagram de Marca mio" });
    expect(link.getAttribute("href")).toBe("/cuentas/instagram?broker=mio");
    // En Instagram ya no lo pide; Mercado Libre y Facebook siguen siendo del administrador.
    const instagram = within(section).getByRole("region", { name: "Instagram" });
    expect(instagram.textContent).not.toContain("Pídele al administrador");
    expect(section.textContent).toContain("Sin cuenta de Mercado Libre. Pídele al administrador");
    // Lo demás de Cuentas sigue siendo del administrador.
    expect(within(section).queryByRole("button", { name: "Desconectar" })).toBeNull();
    expect(
      within(section).queryByRole("button", { name: "Activar Marketplace a mano" }),
    ).toBeNull();
  });

  it("el corredor sin el inicio de sesión de Instagram (sin HTTPS) no ve el comando: lo pide al administrador", async () => {
    const h = harness({ deps: deps(false) });
    const mine = await h.brokers.create(brokerData("mio"));
    h.signInAsBroker(mine.id);
    h.renderApp("/cuentas");

    const section = await screen.findByRole("region", { name: /mio/ });
    expect(within(section).queryByRole("link", { name: /Conectar Instagram/ })).toBeNull();
    expect(section.textContent).not.toContain("--token-stdin");
    expect(section.textContent).toContain("Pídele al administrador que la conecte.");
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
      options: {
        status?: "connected" | "expired";
        configured?: boolean;
        account?: boolean;
        /** El servidor con su dominio y HTTPS: la vuelta es automática (F8-T19). */
        secureCookie?: boolean;
        intercept?: HarnessOptions["intercept"];
      } = {},
    ) {
      const h = harness({
        ...(options.intercept === undefined ? {} : { intercept: options.intercept }),
        deps: {
          ...deps(false),
          mercadoLibre: {
            auth: fakeMercadoLibreAuth(),
            configured: options.configured ?? true,
            redirectUri: TEST_ML_REDIRECT_URI,
            secureCookie: options.secureCookie ?? false,
          },
        },
      });
      // Un corredor propio: el formulario automático es solo para ellos (F7, ADR-0023).
      const created = await h.brokers.create(brokerData("marca"));
      const broker = await h.brokers.setSettings(created.id, { operatorOwned: true });
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

    const mlChannel = () =>
      screen.findByRole("region", { name: "Mercado Libre (Portal Inmobiliario)" });

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

    it("con la vuelta automática (el servidor con su dominio): un botón en vez de los pasos de la CLI, que abre la autorización (F8-T19)", async () => {
      const bodies: unknown[] = [];
      const { renderApp } = await withMercadoLibre({
        account: false,
        secureCookie: true,
        intercept: (method, path, init) => {
          if (method === "POST" && path.endsWith("/accounts/mercadolibre/authorize-url")) {
            bodies.push(JSON.parse(String(init?.body)));
          }
        },
      });
      renderApp("/cuentas");

      const channel = await mlChannel();
      expect(within(channel).queryByRole("listitem")).toBeNull();
      expect(channel.textContent).not.toContain("--url-stdin");
      fireEvent.click(within(channel).getByRole("button", { name: /Conectar Mercado Libre de/ }));

      await vi.waitFor(() => expect(goTo).toHaveBeenCalledTimes(1));
      expect(bodies).toEqual([{ broker: "marca" }]);
      const url = new URL(vi.mocked(goTo).mock.calls[0]?.[0] ?? "");
      expect(url.origin).toBe("https://auth.mercadolibre.cl");
      expect(url.searchParams.get("state")).toBeTruthy();
    });

    it("con la vuelta automática pero sin el par de la app: lo dice, sin botón", async () => {
      const { renderApp } = await withMercadoLibre({
        account: false,
        configured: false,
        secureCookie: true,
      });
      renderApp("/cuentas");

      const channel = await mlChannel();
      expect(channel.textContent).toContain("A la API le faltan ML_APP_ID y ML_CLIENT_SECRET");
      expect(within(channel).queryByRole("button")).toBeNull();
    });

    it("la vuelta del OAuth de Mercado Libre: lo confirma con su nombre, y los errores hablan de Mercado Libre", async () => {
      const ok = await withMercadoLibre({ account: false });
      ok.renderApp("/cuentas?conectada=mercadolibre&proveedor=mercadolibre");
      expect(await screen.findByText("Cuenta de Mercado Libre conectada.")).toBeTruthy();
      cleanup();

      for (const [error, text] of [
        ["OAUTH_DENIED", "Rechazaste los permisos en Mercado Libre"],
        ["OAUTH_STATE_INVALID", "El enlace de conexión venció"],
        ["ML_AUTH_INVALID", "Mercado Libre no aceptó la conexión"],
        ["ML_PERMISSION_DENIED", "No diste todos los permisos"],
        ["ML_NOT_UN_CODIGO!", "No se pudo conectar Mercado Libre."],
      ] as const) {
        const t = await withMercadoLibre({ account: false });
        t.renderApp(`/cuentas?proveedor=mercadolibre&error=${encodeURIComponent(error)}`);
        expect((await screen.findByRole("alert")).textContent).toContain(text);
        cleanup();
      }

      // Sin proveedor, o con uno desconocido, es la vuelta de Instagram de siempre.
      const odd = await withMercadoLibre({ account: false });
      odd.renderApp("/cuentas?proveedor=otro&error=OAUTH_DENIED");
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Rechazaste los permisos en Instagram",
      );
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

  describe("Facebook Marketplace (F5-T12)", () => {
    /** Un corredor y, si se pide, su cuenta de Marketplace (sin credenciales: la sesión vive en el perfil). */
    async function withMarketplace(
      options: {
        account?: boolean;
        status?: "connected" | "expired";
        lastLoginError?: { code: string; at: string };
        intercept?: HarnessOptions["intercept"];
        /** El ambiente permite el formulario automático (por defecto sí; el servidor, no: F8-T20). */
        automation?: boolean;
      } = {},
    ) {
      const bodies: Array<{ path: string; body: unknown }> = [];
      const h = harness({
        deps: { marketplaceAutomation: options.automation ?? true },
        intercept: (method, path, init) => {
          if (method === "POST" && typeof init?.body === "string") {
            bodies.push({ path, body: JSON.parse(init.body) });
          }
          return options.intercept?.(method, path, init);
        },
      });
      // Un corredor propio: el formulario automático es solo para ellos (F7, ADR-0023).
      const created = await h.brokers.create(brokerData("marca"));
      const broker = await h.brokers.setSettings(created.id, { operatorOwned: true });
      const connect = (meta: Record<string, unknown> = {}) =>
        h.platformAccounts.upsertConnected({
          brokerId: broker.id,
          platform: "fb_marketplace",
          externalAccountId: "100012345678901",
          displayName: "Facebook de prueba",
          tokenExpiresAt: null,
          meta: {
            userId: "100012345678901",
            connectedAt: "2026-10-09T12:00:00.000Z",
            sessionCheckedAt: "2026-10-09T12:00:00.000Z",
            ...meta,
          },
          credentials: null,
        });
      const account =
        options.account === false
          ? null
          : await connect(
              options.lastLoginError === undefined
                ? {}
                : { lastLoginError: options.lastLoginError },
            );
      if (account !== null && options.status === "expired") {
        await h.platformAccounts.changeStatus(account.id, "connected", "expired");
      }
      return { ...h, broker, account, connect, bodies };
    }

    const marketplaceCard = () =>
      screen.findByRole("article", { name: "Cuenta Facebook de prueba" });

    it("en el servidor (F8-T20): ni a un corredor propio se le ofrece abrir Facebook; solo Marketplace a mano", async () => {
      const { renderApp } = await withMarketplace({ account: false, automation: false });
      renderApp("/cuentas");

      expect(await screen.findByText("Sin cuenta de Facebook.")).toBeTruthy();
      const manual = await screen.findByRole("button", { name: "Activar Marketplace a mano" });
      expect(manual).toBeTruthy();
      expect(document.body.textContent).toContain("En el servidor Marketplace se publica a mano");
      expect(screen.queryByRole("button", { name: /Iniciar sesión/ })).toBeNull();
      expect(screen.queryByText(/Chromium/)).toBeNull();
    });

    it("en el servidor, una cuenta de perfil que quedó se pasa a mano sin preguntar por borrar el perfil", async () => {
      const { renderApp, bodies } = await withMarketplace({ automation: false });
      renderApp("/cuentas");

      const card = await marketplaceCard();
      expect(within(card).getByRole("note").textContent).toContain(
        "En el servidor Marketplace se publica a mano",
      );
      expect(screen.queryByRole("button", { name: /Iniciar sesión/ })).toBeNull();
      expect(document.body.textContent).toContain("no se borra ningún archivo");

      fireEvent.click(await screen.findByRole("button", { name: "Activar Marketplace a mano" }));

      // Sin la confirmación de "se borra el perfil de este Mac": no hay perfil en el disco.
      expect(screen.queryByRole("alert")).toBeNull();
      expect(await screen.findByText("Marketplace a mano activo.")).toBeTruthy();
      expect(bodies).toContainEqual({
        path: expect.stringContaining("/accounts/marketplace/manual"),
        body: { broker: "marca" },
      });
    });

    it("en el servidor, desconectar una cuenta de perfil dice que no hay perfil que borrar", async () => {
      const { renderApp } = await withMarketplace({ automation: false });
      renderApp("/cuentas");

      const card = await marketplaceCard();
      fireEvent.click(within(card).getByRole("button", { name: "Desconectar" }));
      expect(card.textContent).toContain("en el servidor no hay un perfil del navegador");
      expect(card.textContent).not.toContain("Se borra el perfil de Chromium");
    });

    it("sin cuenta: Iniciar sesión encola y espera hasta ver la sesión", async () => {
      const { renderApp, connect, requests } = await withMarketplace({ account: false });
      renderApp("/cuentas");

      expect(await screen.findByText("Sin cuenta de Facebook.")).toBeTruthy();
      fireEvent.click(await screen.findByRole("button", { name: "Iniciar sesión en Facebook" }));
      expect(await screen.findByText(/Se abrirá una ventana de Chromium/)).toBeTruthy();
      expect(requests).toContain("POST /accounts/marketplace/login");
      // Mientras espera, otro clic no encola otra ventana.
      const button = screen.getByRole("button", { name: "Iniciar sesión en Facebook" });
      expect((button as HTMLButtonElement).disabled).toBe(true);

      // El worker ve la sesión y conecta la cuenta.
      await connect({ sessionCheckedAt: new Date(Date.now() + 1_000).toISOString() });
      const card = await marketplaceCard();
      expect(within(card).getByText("conectada")).toBeTruthy();
      expect(card.textContent).toContain("Sesión vista");
      // La caja sigue a la vista con el resultado, y ofrece iniciar sesión de nuevo.
      expect(await screen.findByText("Listo: la cuenta quedó conectada.")).toBeTruthy();
      expect(screen.getByText("Iniciar sesión de nuevo en Facebook")).toBeTruthy();
      expect(
        requests.filter((request) => request === "POST /accounts/marketplace/login"),
      ).toHaveLength(1);
    });

    it("si el inicio de sesión falla, muestra el motivo en la caja y en la tarjeta", async () => {
      const { renderApp, platformAccounts, account } = await withMarketplace({ status: "expired" });
      renderApp("/cuentas");

      expect((await marketplaceCard()).textContent).toContain("La sesión de Facebook se cerró");
      fireEvent.click(await screen.findByRole("button", { name: "Iniciar sesión en Facebook" }));
      await screen.findByText(/Se abrirá una ventana de Chromium/);
      await platformAccounts.mergeMeta(account?.id ?? "", {
        lastLoginError: {
          code: "MARKETPLACE_LOGIN_TIMEOUT",
          at: new Date(Date.now() + 1_000).toISOString(),
        },
      });

      // En la caja de iniciar sesión y en la tarjeta de la cuenta.
      const box = (await screen.findByText("Reconectar Marketplace")).closest("div");
      if (box === null) throw new Error("falta la caja");
      expect(
        await within(box).findByText(/Pasaron 10 minutos sin que se iniciara la sesión/),
      ).toBeTruthy();
      expect(
        await within(await marketplaceCard()).findByText(/Pasaron 10 minutos sin que se iniciara/),
      ).toBeTruthy();
      // Terminada la espera, se puede volver a intentar.
      expect(
        (screen.getByRole("button", { name: "Iniciar sesión en Facebook" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });

    it("el último inicio de sesión fallido solo se muestra si es posterior a la sesión vista", async () => {
      const { renderApp } = await withMarketplace({
        lastLoginError: { code: "MARKETPLACE_PROFILE_BUSY", at: "2026-10-08T12:00:00.000Z" },
      });
      renderApp("/cuentas");
      const card = await marketplaceCard();
      expect(card.textContent).not.toContain("ocupado");
      cleanup();

      const later = await withMarketplace({
        lastLoginError: { code: "MARKETPLACE_PROFILE_BUSY", at: "2026-10-10T12:00:00.000Z" },
      });
      later.renderApp("/cuentas");
      expect((await marketplaceCard()).textContent).toContain(
        "El perfil de Facebook estaba ocupado",
      );
    });

    it("con otra acción del perfil en cola lo dice, sin esperar", async () => {
      const { renderApp } = await withMarketplace({
        account: false,
        intercept: (method, path) =>
          method === "POST" && path === "/accounts/marketplace/login"
            ? Response.json(
                {
                  error: {
                    code: "MARKETPLACE_PROFILE_ACTION_PENDING",
                    message: "Ya hay una acción del perfil de Facebook esperando",
                  },
                },
                { status: 409 },
              )
            : undefined,
      });
      renderApp("/cuentas");
      fireEvent.click(await screen.findByRole("button", { name: "Iniciar sesión en Facebook" }));
      expect((await screen.findByRole("alert")).textContent).toContain(
        "Ya hay una acción del perfil de Facebook esperando",
      );
      expect(screen.queryByText(/Se abrirá una ventana de Chromium/)).toBeNull();
    });

    it("Desconectar pide confirmación, dice que borra el perfil y la manda confirmada", async () => {
      const { renderApp, platformAccounts, account, bodies } = await withMarketplace();
      renderApp("/cuentas");

      fireEvent.click(within(await marketplaceCard()).getByRole("button", { name: "Desconectar" }));
      expect(
        screen.getByText(/Se borra el perfil de Chromium con la sesión de Facebook/),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
      expect(bodies).toEqual([]);

      fireEvent.click(within(await marketplaceCard()).getByRole("button", { name: "Desconectar" }));
      fireEvent.click(screen.getByRole("button", { name: "Sí, desconectar" }));
      expect(await within(await marketplaceCard()).findByText("desconectada")).toBeTruthy();
      expect((await platformAccounts.get(account?.id ?? ""))?.status).toBe("revoked");
      expect(bodies).toEqual([
        { path: `/accounts/${account?.id}/disconnect`, body: { confirmed: true } },
      ]);
    });
  });
});

describe("panel: Cuentas de las redes de posts (F9-T19)", () => {
  it("el administrador ve Discord por la CLI y los botones de LinkedIn y X; TikTok sin el par dice qué falta", async () => {
    const h = harness();
    await h.brokers.create(brokerData("sin-cuenta"), { kind: "brand" });
    h.renderApp("/cuentas");

    const section = await screen.findByRole("region", { name: /sin-cuenta/ });
    const discord = within(section).getByRole("region", { name: "Discord" });
    expect(discord.textContent).toContain(
      "pbpaste | pnpm -s cli accounts connect discord --broker sin-cuenta --webhook-stdin",
    );
    // La URL del webhook es secreta: no hay dónde pegarla en el panel.
    expect(within(discord).queryByRole("textbox")).toBeNull();

    const linkedin = within(section).getByRole("link", {
      name: "Conectar LinkedIn de Marca sin-cuenta",
    });
    expect(linkedin.getAttribute("href")).toBe(
      "http://localhost:8787/api/oauth/linkedin/start?broker=sin-cuenta",
    );
    const x = within(section).getByRole("link", { name: "Conectar X de Marca sin-cuenta" });
    expect(x.getAttribute("href")).toBe(
      "http://127.0.0.1:8787/api/oauth/x/start?broker=sin-cuenta",
    );
    // X vuelve a 127.0.0.1: con el panel en otro host, dice dónde abrirlo.
    expect(within(section).getByRole("region", { name: "X" }).textContent).toContain(
      "La conexión empieza en 127.0.0.1",
    );

    const tiktok = within(section).getByRole("region", { name: "TikTok" });
    expect(within(tiktok).queryByRole("link")).toBeNull();
    expect(tiktok.textContent).toContain("TIKTOK_CLIENT_KEY y TIKTOK_CLIENT_SECRET");
  });

  it("el corredor conecta su LinkedIn y su X (sus permisos), pero Discord lo pide al administrador", async () => {
    const h = harness();
    const mine = await h.brokers.create(brokerData("mio"), { kind: "brand" });
    h.signInAsBroker(mine.id);
    h.renderApp("/cuentas");

    const section = await screen.findByRole("region", { name: /mio/ });
    expect(
      within(section).getByRole("link", { name: "Conectar LinkedIn de Marca mio" }),
    ).toBeTruthy();
    expect(within(section).getByRole("link", { name: "Conectar X de Marca mio" })).toBeTruthy();
    const discord = within(section).getByRole("region", { name: "Discord" });
    expect(discord.textContent).toContain("Pídele al administrador que la conecte.");
    expect(discord.textContent).not.toContain("--webhook-stdin");
  });

  it("un corredor de propiedades no ofrece X, TikTok, LinkedIn ni Discord; una marca sí (F9.5-T20)", async () => {
    const h = harness();
    await h.brokers.create(brokerData("casas"));
    await h.brokers.create(brokerData("la-marca"), { kind: "brand" });
    h.renderApp("/cuentas");

    const casas = await screen.findByRole("region", { name: /casas/ });
    for (const name of [
      "Instagram",
      "Mercado Libre (Portal Inmobiliario)",
      "Facebook Marketplace",
    ]) {
      expect(within(casas).getByRole("region", { name }), name).toBeTruthy();
    }
    for (const name of ["Discord", "LinkedIn", "X", "TikTok"]) {
      expect(within(casas).queryByRole("region", { name }), name).toBeNull();
    }
    expect(within(casas).queryByRole("link", { name: /Conectar (LinkedIn|X)/ })).toBeNull();

    const marca = screen.getByRole("region", { name: /la-marca/ });
    for (const name of ["Instagram", "Discord", "LinkedIn", "X", "TikTok"]) {
      expect(within(marca).getByRole("region", { name }), name).toBeTruthy();
    }
    for (const name of ["Mercado Libre (Portal Inmobiliario)", "Facebook Marketplace"]) {
      expect(within(marca).queryByRole("region", { name }), name).toBeNull();
    }
  });

  it("un corredor de propiedades con una cuenta de marca ya conectada la ve para desconectarla, sin ofrecer conectar (F9.5-T20)", async () => {
    const h = harness();
    const broker = await h.brokers.create(brokerData("casas"));
    await h.platformAccounts.upsertConnected({
      brokerId: broker.id,
      platform: "linkedin",
      externalAccountId: "miembro-9",
      displayName: "Perfil de antes",
      tokenExpiresAt: new Date(Date.now() + 50 * DAY),
      meta: { memberId: "miembro-9", scopes: ["w_member_social"], mode: "manual" },
      credentials: { accessToken: "token-linkedin-de-prueba" },
    });
    h.renderApp("/cuentas");

    const section = await screen.findByRole("region", { name: /casas/ });
    const linkedin = within(section).getByRole("region", { name: "LinkedIn" });
    expect(within(linkedin).getByText(/Perfil de antes/)).toBeTruthy();
    expect(within(linkedin).getByRole("button", { name: "Desconectar" })).toBeTruthy();
    expect(within(section).queryByRole("link", { name: /Conectar LinkedIn/ })).toBeNull();
    // Las otras redes de marca, sin cuentas, ni aparecen.
    for (const name of ["Discord", "X", "TikTok"]) {
      expect(within(section).queryByRole("region", { name }), name).toBeNull();
    }
  });

  it("una cuenta de LinkedIn dice que publica a mano; la vuelta de X dice que se conectó", async () => {
    const h = harness();
    const broker = await h.brokers.create(brokerData("marca"));
    await h.platformAccounts.upsertConnected({
      brokerId: broker.id,
      platform: "linkedin",
      externalAccountId: "miembro-123",
      displayName: "Vicente Wolde",
      tokenExpiresAt: new Date(Date.now() + 50 * DAY),
      meta: { memberId: "miembro-123", scopes: ["w_member_social"], mode: "manual" },
      credentials: { accessToken: "token-linkedin-de-prueba" },
    });
    h.renderApp("/cuentas?conectada=x&proveedor=x");

    const message = await screen.findByText("Cuenta de X conectada.");
    expect(message.closest("[role=status]")).not.toBeNull();
    const linkedin = await screen.findByRole("article", { name: "Cuenta Vicente Wolde" });
    expect(linkedin.textContent).toContain("A mano");
    expect(linkedin.textContent).toContain("No se renueva sola");
  });

  it("la vuelta de X sin el par de la app dice qué anotar", async () => {
    const h = harness();
    await h.brokers.create(brokerData("marca"));
    h.renderApp("/cuentas?proveedor=x&error=X_NOT_CONFIGURED");

    expect((await oauthResult()).textContent).toContain("X_CLIENT_ID y X_CLIENT_SECRET");
  });
});
