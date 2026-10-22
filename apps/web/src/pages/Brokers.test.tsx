// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerData, harness, newListing } from "../../test/harness.js";

// F7-T17 y T18 (spec F7 §4.11): el alcance del panel (el selector del administrador y lo que el
// corredor no ve), Corredores, Mi marca y el gasto, sobre la API en proceso.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

/** Dos corredores con una propiedad cada uno. */
async function twoBrokers() {
  const h = harness();
  const mine = await h.brokers.create(brokerData("mio"));
  const theirs = await h.brokers.create(brokerData("ajeno"));
  await h.listings.create(newListing(mine.id, "P-MIO"));
  await h.listings.create(newListing(theirs.id, "P-AJENO"));
  return { h, mine, theirs };
}

const menu = () => screen.getByRole("navigation", { name: "Menú principal" });

describe("el alcance (F7-T17)", () => {
  it("el corredor no ve el selector, Corredores ni lo de las cuentas del administrador", async () => {
    const { h, mine } = await twoBrokers();
    await h.platformAccounts.upsertConnected({
      brokerId: mine.id,
      platform: "instagram",
      externalAccountId: "ig-1",
      displayName: "@mio",
      tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
      meta: {},
      credentials: { accessToken: "IGAA-falso" },
    });
    h.signInAsBroker(mine.id);
    h.renderApp("/cuentas");

    expect(await within(menu()).findByRole("link", { name: "Mi marca" })).toBeTruthy();
    expect(within(menu()).queryByRole("link", { name: "Corredores" })).toBeNull();
    expect(screen.queryByLabelText("Ver corredor")).toBeNull();
    expect(await screen.findByRole("article", { name: /@mio/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Desconectar" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /publicación automática/i })).toBeNull();
    expect(screen.queryByText(/Iniciar sesión en Facebook/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Activar Marketplace a mano" })).toBeNull();
  });

  it("el selector del administrador filtra Propiedades, Seguimiento y Cuentas", async () => {
    const { h } = await twoBrokers();
    h.renderApp("/propiedades");

    expect(await screen.findByText(/P-AJENO/)).toBeTruthy();
    expect(screen.getByText(/P-MIO/)).toBeTruthy();
    const selector = (await screen.findByLabelText("Ver corredor")) as HTMLSelectElement;
    await waitFor(() => expect(within(selector).getAllByRole("option")).toHaveLength(3));
    fireEvent.change(selector, { target: { value: "mio" } });

    expect(await screen.findByText(/P-MIO/)).toBeTruthy();
    expect(screen.queryByText(/P-AJENO/)).toBeNull();
    expect(h.requests).toContain("GET /listings?broker=mio");

    fireEvent.click(within(menu()).getByRole("link", { name: "Seguimiento" }));
    await waitFor(() => expect(h.requests).toContain("GET /tracking?broker=mio"));
    expect(h.requests).toContain("GET /agenda?broker=mio");

    fireEvent.click(within(menu()).getByRole("link", { name: "Cuentas" }));
    await waitFor(() => expect(h.requests).toContain("GET /accounts?broker=mio"));
    expect(await screen.findByRole("heading", { name: /Marca mio/ })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Marca ajeno/ })).toBeNull();
  });
});

describe("una marca (F9, ADR-0029)", () => {
  it("el administrador que mira una marca no ve Propiedades, Importar ni las cuentas de avisos", async () => {
    const { h } = await twoBrokers();
    await h.brokers.create(brokerData("vinny"), { kind: "brand" });
    h.renderApp("/cuentas");

    // Con "Todos" se ve todo; la marca muestra solo Instagram.
    expect(await within(menu()).findByRole("link", { name: "Propiedades" })).toBeTruthy();
    const brand = await screen.findByRole("region", { name: /Marca vinny/ });
    expect(within(brand).getByRole("heading", { name: "Instagram" })).toBeTruthy();
    expect(within(brand).queryByRole("heading", { name: /Mercado Libre/ })).toBeNull();
    expect(within(brand).queryByRole("heading", { name: "Facebook Marketplace" })).toBeNull();
    expect(within(brand).queryByRole("checkbox", { name: /publicación automática/i })).toBeNull();
    const broker = screen.getByRole("region", { name: /Marca mio/ });
    expect(within(broker).getByRole("heading", { name: /Mercado Libre/ })).toBeTruthy();

    const selector = (await screen.findByLabelText("Ver corredor")) as HTMLSelectElement;
    await waitFor(() => expect(within(selector).getAllByRole("option")).toHaveLength(4));
    fireEvent.change(selector, { target: { value: "vinny" } });
    await waitFor(() =>
      expect(within(menu()).queryByRole("link", { name: "Propiedades" })).toBeNull(),
    );
    expect(within(menu()).queryByRole("link", { name: "Importar" })).toBeNull();
    expect(within(menu()).getByRole("link", { name: "Seguimiento" })).toBeTruthy();

    // De vuelta a un corredor, vuelve todo; Importar no ofrece la marca.
    fireEvent.change(selector, { target: { value: "mio" } });
    fireEvent.click(await within(menu()).findByRole("link", { name: "Importar" }));
    const target = (await screen.findByLabelText("Corredor")) as HTMLSelectElement;
    await waitFor(() => expect(within(target).getAllByRole("option")).toHaveLength(3));
    expect(within(target).queryByRole("option", { name: /vinny/ })).toBeNull();
  });

  it("el usuario de una marca tampoco ve Propiedades ni Importar", async () => {
    const h = harness();
    const brand = await h.brokers.create(brokerData("vinny"), { kind: "brand" });
    h.signInAsBroker(brand.id);
    h.renderApp("/");

    expect(await within(menu()).findByRole("link", { name: "Mi marca" })).toBeTruthy();
    await waitFor(() =>
      expect(within(menu()).queryByRole("link", { name: "Propiedades" })).toBeNull(),
    );
    expect(within(menu()).queryByRole("link", { name: "Importar" })).toBeNull();
  });
});

describe("Corredores (F7-T18)", () => {
  it("crear un corredor, invitar (el enlace se ve una vez y se copia), restablecer y desactivar", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const h = harness();
    h.renderApp("/corredores");

    fireEvent.click(await screen.findByRole("button", { name: "Crear un corredor" }));
    // F9.5-T16: solo el nombre y la marca (el identificador sale de la marca).
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Persona Nueva" } });
    fireEvent.change(screen.getByLabelText("Nombre de la marca"), { target: { value: "Nueva" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear corredor" }));

    expect(await screen.findByRole("heading", { name: /Nueva/ })).toBeTruthy();
    const alta = screen.getByRole("region", { name: "Lista de alta" });
    expect(alta.textContent).toContain("1 de 7");
    expect(alta.textContent).toContain("invitar a su usuario (lo hace el administrador)");

    const users = screen.getByRole("region", { name: "Usuarios" });
    fireEvent.change(within(users).getByLabelText("Correo"), {
      target: { value: "nuevo@ejemplo.cl" },
    });
    fireEvent.change(within(users).getByLabelText("Nombre"), { target: { value: "Nuevo" } });
    fireEvent.click(within(users).getByRole("button", { name: "Invitar" }));

    const link = await within(users).findByText(/se muestra una sola vez/);
    const box = link.closest("[role=status]") as HTMLElement;
    const shown = within(box).getByText(/\/invitacion#/).textContent ?? "";
    fireEvent.click(within(box).getByRole("button", { name: "Copiar el enlace" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(shown));
    // El enlace no queda en la caché del panel (ni en las mutaciones, ni en las consultas).
    const cached = () =>
      JSON.stringify([
        h.queryClient
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.data),
        h.queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ]);
    expect(cached()).not.toContain("/invitacion#");
    fireEvent.click(within(box).getByRole("button", { name: "Listo, ocultarlo" }));
    expect(within(users).queryByText(/\/invitacion#/)).toBeNull();
    expect(document.activeElement).toBe(within(users).getByLabelText("Correo"));
    expect(await within(users).findByText(/todavía sin contraseña/)).toBeTruthy();

    fireEvent.click(within(users).getByRole("button", { name: "Restablecer a nuevo@ejemplo.cl" }));
    const again = await within(users).findByText(/\/invitacion#/);
    expect(again.textContent).not.toBe(shown);

    fireEvent.click(within(users).getByRole("button", { name: "Desactivar a nuevo@ejemplo.cl" }));
    fireEvent.click(within(users).getByRole("button", { name: "Sí, desactivar" }));
    expect(await within(users).findByText(/desactivado/)).toBeTruthy();
    expect(
      within(users).getByRole("button", { name: "Reactivar a nuevo@ejemplo.cl" }),
    ).toBeTruthy();
  });

  it("el gasto del mes y el tope alcanzado", async () => {
    const h = harness();
    const broker = await h.brokers.create(brokerData("gasta"));
    await h.brokers.setSettings(broker.id, { llmMonthlyCapUsd: 0.5 });
    const listing = await h.listings.create(newListing(broker.id, "P-1"));
    const run = await h.contentRuns.create({ listingId: listing.id, texts: true });
    await h.contentRuns.addLlmUsage(run.id, {
      provider: "anthropic-api",
      model: "claude-sonnet-5-5",
      inputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 1,
      costUsd: 0.7,
      priceTable: "2026-10-16",
      requestId: null,
    });
    h.renderApp("/corredores");
    const row = (await screen.findByRole("link", { name: "Marca gasta" })).closest("tr");
    await waitFor(() => expect(row?.textContent).toContain("US$ 0,70 de US$ 0,50"));
    expect(row?.textContent).toContain("tope alcanzado");

    fireEvent.click(screen.getByRole("link", { name: "Marca gasta" }));
    expect(await screen.findByText(/preparar los textos está frenado/)).toBeTruthy();
  });
});

describe("Mi marca (F7-T18)", () => {
  it("el corredor guarda su marca y sube el logo", async () => {
    const intercepted: string[] = [];
    const h = harness({
      intercept: (method, path) => {
        // jsdom no le pasa un archivo de verdad a la API: la subida la prueban los tests de la API.
        if (method === "POST" && /\/brokers\/[^/]+\/logo$/.test(path)) {
          intercepted.push(path);
          return new Response(
            JSON.stringify({
              broker: { ...createdBroker, logoMediaId: "logo-1", effectiveMode: "dry-run" },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return undefined;
      },
    });
    const createdBroker = await h.brokers.create(brokerData("mio"));
    h.signInAsBroker(createdBroker.id);
    h.renderApp("/mi-marca");

    const brand = await screen.findByRole("region", { name: "Marca" });
    expect(within(brand).queryByLabelText(/Tope de IA/)).toBeNull();
    expect(within(brand).queryByLabelText(/Corredor propio/)).toBeNull();
    fireEvent.change(within(brand).getByLabelText("WhatsApp"), {
      target: { value: "+56 9 1111 2222" },
    });
    fireEvent.click(within(brand).getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Guardado.")).toBeTruthy();
    expect((await h.brokers.findById(createdBroker.id))?.whatsapp).toBe("+56 9 1111 2222");
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Lista de alta" }).textContent).toContain(
        "✓ WhatsApp",
      ),
    );

    fireEvent.change(screen.getByLabelText("Subir logo"), {
      target: {
        files: [new File([new Uint8Array([0x89, 0x50])], "logo.png", { type: "image/png" })],
      },
    });
    expect(await screen.findByText("Logo guardado.")).toBeTruthy();
    expect(intercepted).toEqual([`/brokers/${createdBroker.id}/logo`]);
    expect(
      screen.getByRole("link", { name: "Bajar la planilla de Excel" }).getAttribute("href"),
    ).toBe(`/api/brokers/${createdBroker.id}/template.xlsx`);
  });
});

describe("revisión del lote H", () => {
  it("al cambiar de corredor no se ven, ni un momento, las propiedades del anterior", async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((done) => {
      release = done;
    });
    const h = harness({
      intercept: (method, path) => {
        if (method === "GET" && path.startsWith("/listings?broker=mio")) {
          return slow.then(() => undefined as unknown as Response);
        }
        return undefined;
      },
    });
    const mine = await h.brokers.create(brokerData("mio"));
    const theirs = await h.brokers.create(brokerData("ajeno"));
    await h.listings.create(newListing(mine.id, "P-MIO"));
    await h.listings.create(newListing(theirs.id, "P-AJENO"));
    h.renderApp("/propiedades");
    expect(await screen.findByText(/P-AJENO/)).toBeTruthy();
    const selector = (await screen.findByLabelText("Ver corredor")) as HTMLSelectElement;
    await waitFor(() => expect(within(selector).getAllByRole("option")).toHaveLength(3));
    fireEvent.change(selector, { target: { value: "mio" } });
    // La respuesta del corredor nuevo no llega todavía: la lista anterior ya no está.
    await waitFor(() => expect(screen.queryByText(/P-AJENO/)).toBeNull());
    expect(screen.queryByText(/P-MIO/)).toBeNull();
    release();
  });

  it("un tope mal escrito no se manda (ni queda sin tope)", async () => {
    const h = harness();
    const broker = await h.brokers.create(brokerData("tope"));
    await h.brokers.setSettings(broker.id, { llmMonthlyCapUsd: 10 });
    h.renderApp(`/corredores/${broker.id}`);
    const brand = await screen.findByRole("region", { name: "Marca" });
    const cap = within(brand).getByLabelText(/Tope de IA/);
    fireEvent.change(cap, { target: { value: "diez" } });
    fireEvent.click(within(brand).getByRole("button", { name: "Guardar" }));
    expect(await within(brand).findByText(/Escribe un monto en dólares/)).toBeTruthy();
    expect(cap.getAttribute("aria-invalid")).toBe("true");
    expect(h.requests.filter((request) => request.startsWith("PATCH"))).toEqual([]);
    expect((await h.brokers.findById(broker.id))?.llmMonthlyCapUsd).toBe(10);
  });

  it("Marketplace a mano: activarla para un corredor ajeno; para uno propio con Facebook, pregunta", async () => {
    const h = harness();
    const theirs = await h.brokers.create(brokerData("ajeno"));
    const own = await h.brokers.setSettings((await h.brokers.create(brokerData("propio"))).id, {
      operatorOwned: true,
    });
    await h.platformAccounts.upsertConnected({
      brokerId: own.id,
      platform: "fb_marketplace",
      externalAccountId: "100012345678901",
      displayName: "Facebook de prueba",
      tokenExpiresAt: null,
      meta: {
        userId: "100012345678901",
        connectedAt: "2026-10-09T12:00:00.000Z",
        sessionCheckedAt: "2026-10-09T12:00:00.000Z",
      },
      credentials: null,
    });
    h.renderApp("/cuentas");

    const foreign = await screen.findByRole("region", { name: /Marca ajeno/ });
    expect(within(foreign).queryByText(/Iniciar sesión en Facebook/)).toBeNull();
    fireEvent.click(within(foreign).getByRole("button", { name: "Activar Marketplace a mano" }));
    expect(await within(foreign).findByText("Marketplace a mano activo.")).toBeTruthy();
    const [manual] = await h.platformAccounts.listByBroker(theirs.id, "fb_marketplace");
    expect(manual).toMatchObject({ externalAccountId: "manual", status: "connected" });

    const mineRegion = screen.getByRole("region", { name: /Marca propio/ });
    fireEvent.click(within(mineRegion).getByRole("button", { name: "Activar Marketplace a mano" }));
    const alert = within(mineRegion).getByRole("alert");
    expect(alert.textContent).toContain("se borra su perfil de este Mac");
    fireEvent.click(within(alert).getByRole("button", { name: "Cancelar" }));
    const accounts = await h.platformAccounts.listByBroker(own.id, "fb_marketplace");
    expect(accounts.map((account) => account.externalAccountId)).toEqual(["100012345678901"]);
  });
});
