import { createLogger } from "@agentsales/config";
import { AppError, type Publication } from "@agentsales/core";
import { createInMemoryPublicationRepository } from "@agentsales/core/testing";
import type { MarketplaceWindow, MarketplaceWindowWatch } from "@agentsales/publishers/marketplace";
import { describe, expect, it, vi } from "vitest";
import { createMarketplaceWindows, markWindowClosed, sweepClosedWindows } from "./windows.js";

const NOW = new Date("2026-10-10T15:00:00Z");
const logger = createLogger({ level: "silent" });

/** Una ventana doble: guarda los avisos para dispararlos a mano. */
function fakeWindow() {
  let handlers: MarketplaceWindowWatch | undefined;
  let open = true;
  const window: MarketplaceWindow & { closes: number } = {
    closes: 0,
    watch(h) {
      handlers = h;
    },
    isOpen: () => open,
    async close() {
      open = false;
      window.closes += 1;
    },
  };
  return {
    window,
    item: (url: string) => handlers?.onItemUrl(url),
    closed: async (reason: "closed" | "timeout") => {
      open = false;
      await handlers?.onClosed(reason);
    },
    error: (error: unknown) => handlers?.onError?.(error),
    watching: () => handlers !== undefined,
  };
}

/** Una publicación de Marketplace esperando el clic final, en su intento 1. */
async function waiting() {
  const publications = createInMemoryPublicationRepository();
  const created = await publications.create(
    {
      listingId: "aviso-1",
      platformAccountId: "cuenta-1",
      platform: "fb_marketplace",
      format: "post",
      contentId: "texto-1",
      mediaIds: [],
      listingSourceHash: "h",
    },
    { actor: "operator" },
  );
  await publications.transition(
    created.id,
    { from: "approved", to: "publishing", changes: { dryRun: false, incrementAttempts: true } },
    { actor: "operator" },
  );
  const publication = await publications.transition(
    created.id,
    {
      from: "publishing",
      to: "awaiting_manual_confirm",
      changes: {
        progress: {
          attempt: 1,
          simulated: false,
          formReadyAt: NOW.toISOString(),
          photos: 2,
          priceClp: 650_000,
        },
      },
    },
    { actor: "system" },
  );
  return { publications, publication };
}

function registry(
  publications: ReturnType<typeof createInMemoryPublicationRepository>,
  confirm: (id: string, url: string) => Promise<unknown> = async () => undefined,
) {
  return createMarketplaceWindows({
    publications,
    confirm,
    timeoutMs: 30 * 60_000,
    pollMs: 20,
    now: () => NOW,
    logger,
  });
}

const ref = (publication: Publication) => ({
  publicationId: publication.id,
  brokerId: "corredor-1",
  accountId: publication.platformAccountId,
});

describe("ventanas de Marketplace del worker (spec F5 §4.5)", () => {
  it("solo vigila al activarse en awaiting_manual_confirm, y confirma el aviso que vio", async () => {
    const { publications, publication } = await waiting();
    const confirmed: string[] = [];
    const windows = registry(publications, async (_id, url) => confirmed.push(url));
    const fake = fakeWindow();

    await windows.hold(ref(publication), fake.window);
    expect(fake.watching()).toBe(false);
    await expect(windows.activate(publication.id)).resolves.toBe(true);
    expect(fake.watching()).toBe(true);

    await fake.item("https://www.facebook.com/marketplace/item/1/");
    expect(confirmed).toEqual(["https://www.facebook.com/marketplace/item/1/"]);
    expect(windows.size()).toBe(0);
  });

  it("si la publicación ya no espera, activar cierra la ventana pendiente", async () => {
    const { publications, publication } = await waiting();
    await publications.transition(
      publication.id,
      { from: "awaiting_manual_confirm", to: "failed" },
      { actor: "operator" },
    );
    const windows = registry(publications);
    const fake = fakeWindow();
    await windows.hold(ref(publication), fake.window);

    await expect(windows.activate(publication.id)).resolves.toBe(false);
    expect(fake.window.closes).toBe(1);
  });

  it("al cerrarse (o vencer el tope) anota windowClosedAt del mismo intento sin cambiar el estado", async () => {
    const { publications, publication } = await waiting();
    const windows = registry(publications);
    const fake = fakeWindow();
    await windows.hold(ref(publication), fake.window);
    await windows.activate(publication.id);

    await fake.closed("timeout");

    const current = await publications.get(publication.id);
    expect(current?.status).toBe("awaiting_manual_confirm");
    expect(current?.progress).toMatchObject({ windowClosedAt: NOW.toISOString() });
  });

  it("una marca de otro intento no pisa el progreso nuevo", async () => {
    const { publications, publication } = await waiting();

    await expect(markWindowClosed(publications, publication.id, 2, NOW)).resolves.toBe(false);
    expect((await publications.get(publication.id))?.progress).not.toHaveProperty("windowClosedAt");
  });

  it("si el operador pega el enlace o dice que no lo publicó, la relectura cierra la ventana", async () => {
    const { publications, publication } = await waiting();
    const windows = registry(publications);
    const fake = fakeWindow();
    await windows.hold(ref(publication), fake.window);
    await windows.activate(publication.id);

    await publications.transition(
      publication.id,
      { from: "awaiting_manual_confirm", to: "failed" },
      { actor: "operator" },
    );

    await vi.waitFor(() => expect(fake.window.closes).toBe(1));
    expect(windows.size()).toBe(0);
  });

  it("un error al registrar el aviso no tumba nada; INVALID_TRANSITION ni se avisa", async () => {
    const { publications, publication } = await waiting();
    const windows = registry(publications);
    const fake = fakeWindow();
    await windows.hold(ref(publication), fake.window);
    await windows.activate(publication.id);

    expect(() => fake.error(new AppError("INVALID_TRANSITION", "ya confirmada"))).not.toThrow();
    expect(() => fake.error(new AppError("DB_UNAVAILABLE", "sin base"))).not.toThrow();
  });

  it("descartar cierra la pendiente; cerrar por cuenta o corredor las cierra todas las suyas", async () => {
    const { publications, publication } = await waiting();
    const windows = registry(publications);
    const one = fakeWindow();
    const two = fakeWindow();
    await windows.hold(ref(publication), one.window);
    await windows.discard(publication.id);
    expect(one.window.closes).toBe(1);

    await windows.hold(ref(publication), two.window);
    await windows.closeForBroker("corredor-1");
    expect(two.window.closes).toBe(1);
    expect(windows.size()).toBe(0);
  });

  it("al apagar anota windowClosedAt y cierra; al arrancar marca las que quedaron sin ventana", async () => {
    const { publications, publication } = await waiting();
    const windows = registry(publications);
    const fake = fakeWindow();
    await windows.hold(ref(publication), fake.window);
    await windows.activate(publication.id);

    await windows.closeAll();

    expect(fake.window.closes).toBe(1);
    expect((await publications.get(publication.id))?.progress).toMatchObject({
      windowClosedAt: NOW.toISOString(),
    });

    const other = await waiting();
    await expect(sweepClosedWindows(other.publications, NOW)).resolves.toBe(1);
    await expect(sweepClosedWindows(other.publications, NOW)).resolves.toBe(0);
  });
});
