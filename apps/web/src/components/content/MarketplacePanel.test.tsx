// @vitest-environment jsdom
import {
  confirmManualPublication,
  publishPublication,
  startPublication,
  type UfValueSource,
} from "@agentsales/core";
import { createFakePublisher } from "@agentsales/core/testing";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicationSetup } from "../../../test/harness.js";

// F5-T13: la pestaña Marketplace en Contenido (spec F5 §4.12), sobre la API en proceso, con un
// publisher falso y una UF falsa (nunca Facebook ni el Banco Central).

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MARKETPLACE = "fb_marketplace";
const PASTED_URL = "https://www.facebook.com/marketplace/item/123456789/?ref=share";
const CLEAN_URL = "https://www.facebook.com/marketplace/item/123456789/";

/** La UF de los tests (inventada): ayer y hoy, en cualquier fecha que se pida. */
const ufSource: UfValueSource = {
  async valuesBetween(from, to) {
    return [
      { date: from, value: "41126.12" },
      { date: to, value: "41130.94" },
    ];
  },
};

async function setup(options: { publishMode?: "dry-run" | "live"; ufConfigured?: boolean } = {}) {
  const mode = options.publishMode ?? "live";
  const bodies: Array<{ path: string; body: unknown }> = [];
  const s = await publicationSetup({
    platform: MARKETPLACE,
    publishMode: mode,
    ...(options.ufConfigured === undefined ? {} : { ufConfigured: options.ufConfigured }),
    intercept: (method, path, init) => {
      if (method === "POST" && typeof init?.body === "string") {
        bodies.push({ path, body: JSON.parse(init.body) });
      }
      return undefined;
    },
  });
  const { t } = s;
  const fake = createFakePublisher({
    platform: MARKETPLACE,
    formats: ["post"],
    manualConfirm: true,
  });
  const only = () => {
    const [publication] = t.publications.all();
    if (publication === undefined) throw new Error("falta la publicación");
    return publication;
  };
  /** Hace de API y worker: el formulario queda listo (`awaiting_manual_confirm`). */
  const awaiting = async () => {
    await startPublication(
      { ...t.deps, marketplace: { dailyLimit: 3, ufConfigured: true } },
      { publicationId: only().id, dryRun: mode !== "live", actor: "operator" },
    );
    await publishPublication(
      {
        publications: t.publications,
        platformAccounts: t.platformAccounts,
        contents: t.contents,
        media: t.media,
        listings: t.listings,
        brokers: t.brokers,
        storage: t.storage,
        publishers: { fb_marketplace: fake },
        workerMode: mode,
        mercadoLibre: null,
        marketplaceDailyLimit: 3,
        uf: ufSource,
      },
      { publicationId: only().id, isLastAttempt: false },
    );
    expect(only().status).toBe("awaiting_manual_confirm");
    return only();
  };
  /** Abre la sección Contenido y la pestaña Marketplace; devuelve su panel. */
  const tab = async () => {
    const section = await s.open();
    fireEvent.click(await within(section).findByRole("tab", { name: /Facebook Marketplace/ }));
    return within(section).getByRole("tabpanel");
  };
  return { ...s, bodies, awaiting, only, tab };
}

const aviso = (panel: HTMLElement) =>
  within(panel).findByRole("article", { name: "Publicación aviso" });

describe("panel: Marketplace en Contenido", () => {
  it("lo que falta se lista en su pestaña y bloquea Publicar", async () => {
    const s = await setup({ ufConfigured: false });
    const panel = await s.tab();

    const missing = within(panel).getByRole("region", { name: "Lo que falta para Marketplace" });
    expect(missing.textContent).toContain("BCCH_API_TOKEN");
    const publish = within(panel).getByRole("button", { name: /Publicar en Facebook Marketplace/ });
    expect((publish as HTMLButtonElement).disabled).toBe(true);
    expect(panel.textContent).toContain("Falta información para Marketplace (arriba)");
  });

  it("en vivo, publicar pide confirmar y dice que tú haces Siguiente y Publicar", async () => {
    const s = await setup();
    const panel = await s.tab();
    expect(
      within(panel).getByText("El aviso tiene lo que pide el formulario de Marketplace."),
    ).toBeTruthy();

    fireEvent.click(
      within(panel).getByRole("button", { name: "Publicar en Facebook Marketplace (en vivo)" }),
    );
    const alert = within(panel).getByRole("alert");
    expect(alert.textContent).toContain("tú haces Siguiente y Publicar");
    fireEvent.click(within(alert).getByRole("button", { name: "Sí, publicar en vivo" }));
    expect(await within(await aviso(panel)).findByText("publicando")).toBeTruthy();
  });

  it("formulario listo: qué hacer, el precio en pesos con la UF y sin Descartar", async () => {
    const s = await setup();
    await s.awaiting();
    const item = await aviso(await s.tab());

    expect(item.textContent).toContain("Formulario listo: revisa la ventana de Chromium y publica");
    expect(item.textContent).toMatch(
      /Precio en el formulario: \$[\d.]+ \(UF del [\d-]+: \$41\.130,94\)/,
    );
    expect(within(item).queryByRole("button", { name: /Descartar/ })).toBeNull();
    expect(item.textContent).toContain("Para descartarla, primero di si la publicaste.");
  });

  it("ventana cerrada: pregunta si lo publicaste", async () => {
    const s = await setup();
    const publication = await s.awaiting();
    await s.t.publications.updateProgress(
      publication.id,
      { from: "awaiting_manual_confirm", attempts: publication.attempts },
      {
        ...(publication.progress as Record<string, unknown>),
        windowClosedAt: new Date().toISOString(),
      },
    );
    const item = await aviso(await s.tab());
    expect(item.textContent).toContain("La ventana se cerró: ¿lo publicaste?");
  });

  it("pegar el enlace: uno inválido se explica y no deja confirmar; uno válido la publica", async () => {
    const s = await setup();
    await s.awaiting();
    const item = await aviso(await s.tab());
    const input = within(item).getByLabelText(/Enlace del aviso publicado/);
    const confirm = () => within(item).getByRole("button", { name: "Lo publiqué" });

    expect((confirm() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "https://www.facebook.com/profile.php?id=1" } });
    expect(within(item).getByText(/No es el enlace de un aviso de Marketplace/)).toBeTruthy();
    expect((confirm() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: PASTED_URL } });
    fireEvent.click(confirm());

    const link = await within(await aviso(await screen.findByRole("tabpanel"))).findByRole("link", {
      name: "Ver en Facebook Marketplace",
    });
    expect(link.getAttribute("href")).toBe(CLEAN_URL);
    expect(s.only()).toMatchObject({ status: "published", externalUrl: CLEAN_URL });
    expect(s.bodies).toContainEqual({
      path: `/publications/${s.only().id}/confirm`,
      body: { url: PASTED_URL },
    });
  });

  it("no lo publiqué: pide confirmar y queda fallida para reintentar o descartar", async () => {
    const s = await setup();
    await s.awaiting();
    const item = await aviso(await s.tab());

    fireEvent.click(within(item).getByRole("button", { name: "No lo publiqué" }));
    fireEvent.click(within(item).getByRole("button", { name: "Cancelar" }));
    expect(s.only().status).toBe("awaiting_manual_confirm");
    fireEvent.click(within(item).getByRole("button", { name: "No lo publiqué" }));
    fireEvent.click(within(item).getByRole("button", { name: "Sí, no lo publiqué" }));

    const failed = await aviso(await screen.findByRole("tabpanel"));
    expect(await within(failed).findByText(/No se publicó: reintenta/)).toBeTruthy();
    expect(within(failed).getByRole("button", { name: "Reintentar el aviso" })).toBeTruthy();
    expect(within(failed).getByRole("button", { name: "Descartar el aviso" })).toBeTruthy();
    expect(s.only().status).toBe("failed");
  });

  it("quitar la aprobación espera mientras hay una publicación esperando el clic", async () => {
    const s = await setup();
    await s.awaiting();
    const panel = await s.tab();
    expect(panel.textContent).toContain("Una publicación espera tu clic final");
    const unapprove = within(panel).getByRole("button", {
      name: "Quitar aprobación de Facebook Marketplace",
    });
    expect((unapprove as HTMLButtonElement).disabled).toBe(true);
  });

  it("con la ventana abierta vuelve a mirar: ve cuando se cierra sin tocar nada", async () => {
    const s = await setup();
    const publication = await s.awaiting();
    const item = await aviso(await s.tab());
    expect(item.textContent).toContain("Formulario listo");

    // El worker anota que la ventana se cerró; el panel lo ve en la próxima relectura (5 s).
    await s.t.publications.updateProgress(
      publication.id,
      { from: "awaiting_manual_confirm", attempts: publication.attempts },
      {
        ...(publication.progress as Record<string, unknown>),
        windowClosedAt: new Date().toISOString(),
      },
    );
    expect(
      await within(await screen.findByRole("tabpanel")).findByText(
        "La ventana se cerró: ¿lo publicaste?",
        {},
        { timeout: 8_000 },
      ),
    ).toBeTruthy();
  }, 12_000);

  it("publicada: el enlace, el precio y Marcar como retirada después de borrarla a mano", async () => {
    const s = await setup();
    const publication = await s.awaiting();
    await confirmManualPublication(
      { lock: s.t.deps.lock, publications: s.t.publications },
      { publicationId: publication.id, url: PASTED_URL, actor: "system" },
    );
    const item = await aviso(await s.tab());
    expect(within(item).getByRole("link", { name: "Ver en Facebook Marketplace" })).toBeTruthy();
    expect(item.textContent).toContain("Precio en el formulario:");

    fireEvent.click(within(item).getByRole("button", { name: "Marcar como retirado el aviso" }));
    const done = within(item).getByRole("button", { name: "Sí, marcar como retirada" });
    expect((done as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(item).getByLabelText(/Ya la borré a mano en Facebook Marketplace/));
    fireEvent.click(done);

    await vi.waitFor(() => expect(s.only().status).toBe("unpublished"));
  });

  it("en simulación: no abre Facebook y se confirma sin enlace", async () => {
    const s = await setup({ publishMode: "dry-run" });
    await s.awaiting();
    const item = await aviso(await s.tab());

    expect(item.textContent).toContain("Simulación: formulario listo sin abrir Facebook");
    expect(within(item).queryByLabelText(/Enlace del aviso/)).toBeNull();
    fireEvent.click(within(item).getByRole("button", { name: "Lo publiqué (simulación)" }));
    await vi.waitFor(() => expect(s.only().status).toBe("published"));
    expect(s.bodies).toContainEqual({ path: `/publications/${s.only().id}/confirm`, body: {} });
  });

  it("plan B: copia el título y la descripción, y el precio sin convertir hasta un intento", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const s = await setup();
    // Como R2: URLs firmadas `https` (el almacenamiento en memoria usa `memory://`).
    s.t.storage.signedReadUrl = async (path) => `https://r2.test/${path}?firma`;
    const panel = await s.tab();
    fireEvent.click(within(panel).getByText("Publicar a mano (plan B)"));

    fireEvent.click(
      within(panel).getByRole("button", { name: "Copiar el título para Marketplace" }),
    );
    expect(await within(panel).findByText("Copiado")).toBeTruthy();
    fireEvent.click(
      within(panel).getByRole("button", { name: "Copiar la descripción para Marketplace" }),
    );
    const content = (await s.t.contents.listCurrent(s.t.listingId)).find(
      (item) => item.platform === MARKETPLACE,
    );
    expect(writeText).toHaveBeenCalledWith(content?.title);
    expect(writeText).toHaveBeenCalledWith(content?.body);
    expect(panel.textContent).toContain("(sin convertir: Marketplace lo pide en pesos)");
    expect(within(panel).getAllByRole("link", { name: /Abrir foto/ }).length).toBeGreaterThan(0);
  });

  it("plan B: con un intento, el precio en pesos con la UF usada", async () => {
    const s = await setup();
    await s.awaiting();
    const panel = await s.tab();
    fireEvent.click(within(panel).getByText("Publicar a mano (plan B)"));
    const planB = within(panel).getByText("Publicar a mano (plan B)").closest("details");
    expect(planB?.textContent).toMatch(/\$[\d.]+ \(UF del [\d-]+: \$41\.130,94\)/);
  });
});
