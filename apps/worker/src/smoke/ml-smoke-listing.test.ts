import { randomUUID } from "node:crypto";
import { isAppError } from "@agentsales/core";
import {
  createInMemoryPlatformCatalogRepository,
  createPublicationScenario,
  PORTAL_SCENARIO_TOKENS,
} from "@agentsales/core/testing";
import {
  createMercadoLibreItems,
  createMercadoLibreValidator,
  type MercadoLibreItems,
} from "@agentsales/publishers";
import { describe, expect, it, vi } from "vitest";
import { captureLogger } from "../../test/content-fixture.js";
import { useMercadoLibreSim } from "../../test/mercadolibre-sim.js";
import { createWorkerPortal } from "../portal.js";
import {
  type MlSmokeListingReport,
  NO_PICTURE_BYTES,
  NO_PICTURES,
  readOnlyItems,
  recordingValidator,
  runMlSmokeListing,
} from "./ml-smoke-listing.js";

// F4-T23: `ml:smoke --listing` con el publisher del worker y Mercado Libre simulado (msw): solo
// lecturas y `POST /items/validate`; nunca sube una foto ni crea o cambia un ítem.

const sim = useMercadoLibreSim();

async function setup(options: { account?: boolean; approve?: boolean } = {}) {
  const t = await createPublicationScenario({
    platform: "portal_inmobiliario",
    nextId: randomUUID,
    account: options.account ?? true,
    approve: options.approve ?? true,
  });
  const recorder = recordingValidator(createMercadoLibreValidator());
  const { logger } = captureLogger();
  const portal = createWorkerPortal({
    catalogRepository: createInMemoryPlatformCatalogRepository(),
    storage: NO_PICTURE_BYTES,
    logger,
    clients: {
      items: readOnlyItems(createMercadoLibreItems()),
      pictures: NO_PICTURES,
      validator: recorder.validator,
    },
  });
  const out: string[] = [];
  const err: string[] = [];
  const reports: MlSmokeListingReport[] = [];
  const listing = await t.listings.get(t.listingId);
  const run = (listingRef = listing?.externalRef ?? "") =>
    runMlSmokeListing(
      {
        accounts: t.platformAccounts,
        brokers: t.brokers,
        listings: t.listings,
        contents: t.contents,
        media: t.media,
        storage: t.storage,
        mercadoLibre: null,
        publisher: portal.publisher,
        sentBodies: () => recorder.sent,
        writeReport: async (report) => {
          reports.push(report);
          return "tmp/ml-smoke/ml-smoke-listing.json";
        },
        now: () => new Date("2026-10-09T12:00:00Z"),
        print: (line) => out.push(line),
        printError: (line) => err.push(line),
      },
      { listingRef },
    );
  const text = () => [...out, ...err].join("\n");
  return { t, run, text, reports, listing };
}

/** Lo que nunca debe aparecer: tokens, el WhatsApp del corredor, URLs firmadas ni la dirección. */
async function expectNoSecrets(s: Awaited<ReturnType<typeof setup>>) {
  const everything = `${s.text()}\n${JSON.stringify(s.reports)}`;
  expect(everything).not.toContain(PORTAL_SCENARIO_TOKENS.accessToken);
  expect(everything).not.toContain("1111");
  expect(everything).not.toContain("Calle Inventada");
  // Las URLs firmadas de las fotos (el almacenamiento en memoria firma con `memory://…?ttl=`).
  expect(everything).not.toMatch(/memory:\/\/|ttl=/);
}

describe("ml:smoke --listing", () => {
  it("arma el aviso real y Mercado Libre lo aceptaría: solo lecturas y validate, sin secretos", async () => {
    sim.use("accept");
    const s = await setup();

    expect(await s.run()).toBe(0);

    expect(s.text()).toContain("✓ Mercado Libre aceptaría el aviso");
    expect(s.text()).toContain("No se creó ni se cambió nada en Mercado Libre");
    expect(await sim.writes()).toEqual([]);
    const requests = await sim.recorded();
    expect(requests.filter((r) => r.path === "/items/validate")).toHaveLength(1);
    const [report] = s.reports;
    expect(report).toMatchObject({ outcome: "accepted", issues: [], pictures: 2 });
    // Lo que se mandó, para revisar con el paquete: sin contacto ni URLs.
    expect(report?.sent[0]).toMatchObject({
      category_id: "MLC1480",
      seller_contact: "(presente, oculto en el informe)",
      pictures: "2 foto(s) por URL firmada",
    });
    await expectNoSecrets(s);
  });

  it("sin cupo (402) no es un acierto: dice que no está verificado y sale con 0", async () => {
    sim.use("no_quota");
    const s = await setup();

    expect(await s.run()).toBe(0);
    expect(s.text()).toContain("! No verificado: la cuenta no tiene un paquete con cupo");
    expect(s.text()).not.toContain("✓ Mercado Libre aceptaría");
    expect(s.reports[0]?.outcome).toBe("unverified");
    expect(await sim.writes()).toEqual([]);
  });

  it("un rechazo lista los motivos y sale con 1", async () => {
    sim.use("reject");
    const s = await setup();

    expect(await s.run()).toBe(1);
    expect(s.text()).toContain("no lo aceptaría");
    expect(s.reports[0]?.outcome).toBe("rejected");
    expect(s.reports[0]?.issues.length).toBeGreaterThan(0);
    expect(await sim.writes()).toEqual([]);
  });

  it("un 402 con causas que bloquean se informa con sus causas y sale con 1", async () => {
    sim.use("quota_blocked");
    const s = await setup();

    expect(await s.run()).toBe(1);
    expect(s.reports[0]?.outcome).toBe("rejected");
    expect(s.reports[0]?.error?.code).toBe("ML_ITEM_REJECTED");
    expect(s.text()).toContain("item.listing_type_id.invalid");
    await expectNoSecrets(s);
  });

  it("una propiedad que no existe, sin cuenta o sin texto de Portal: lo dice sin llamar", async () => {
    sim.use("accept");
    const missing = await setup();
    expect(await missing.run("NO-EXISTE")).toBe(1);
    expect(missing.text()).toContain("LISTING_NOT_FOUND");

    const noAccount = await setup({ account: false });
    expect(await noAccount.run()).toBe(1);
    expect(noAccount.text()).toContain("ACCOUNT_NOT_CONNECTED");
    expect(noAccount.text()).toContain("accounts connect mercadolibre --broker");

    const noText = await setup();
    const current = await noText.t.contents.listCurrent(noText.t.listingId);
    const portal = current.find((item) => item.platform === "portal_inmobiliario");
    if (portal === undefined) throw new Error("falta el texto de Portal");
    vi.spyOn(noText.t.contents, "listCurrent").mockResolvedValue(
      current.filter((item) => item.id !== portal.id),
    );
    expect(await noText.run()).toBe(1);
    expect(noText.text()).toContain("CONTENT_NOT_READY");

    expect(await sim.recorded()).toEqual([]);
    expect(missing.reports).toEqual([]);
  });

  it("las escrituras están bloqueadas también al ejecutar: no llaman a Mercado Libre", async () => {
    const calls: string[] = [];
    const spy = (name: string) => async () => {
      calls.push(name);
      return undefined as never;
    };
    const inner = {
      create: spy("create"),
      setStatus: spy("setStatus"),
      addDescription: spy("addDescription"),
      hideAddress: spy("hideAddress"),
      get: spy("get"),
      getDescription: spy("getDescription"),
      getLastModeration: spy("getLastModeration"),
      findBySellerCustomField: spy("findBySellerCustomField"),
      searchItems: spy("searchItems"),
    } as unknown as MercadoLibreItems;
    const items = readOnlyItems(inner);
    const blocked = async (run: () => Promise<unknown>) => {
      const error = await run().catch((caught: unknown) => caught);
      return isAppError(error) ? error.code : error;
    };
    const body = {} as Parameters<MercadoLibreItems["create"]>[1];

    expect(await blocked(() => items.create("t", body))).toBe("ML_SMOKE_WRITE_BLOCKED");
    expect(
      await blocked(() =>
        items.setStatus("t", "MLC1", "paused", {
          contact: null,
          email: null,
          countryCode2: "56",
          phone2: "900000000",
        }),
      ),
    ).toBe("ML_SMOKE_WRITE_BLOCKED");
    expect(await blocked(() => items.addDescription("t", "MLC1", "x"))).toBe(
      "ML_SMOKE_WRITE_BLOCKED",
    );
    expect(await blocked(() => items.hideAddress("t", "MLC1"))).toBe("ML_SMOKE_WRITE_BLOCKED");
    expect(
      await blocked(() =>
        NO_PICTURES.upload("t", { bytes: new Uint8Array(), mime: "image/jpeg", filename: "1.jpg" }),
      ),
    ).toBe("ML_SMOKE_WRITE_BLOCKED");
    expect(await blocked(() => NO_PICTURE_BYTES.get("a/b.jpg"))).toBe("ML_SMOKE_WRITE_BLOCKED");
    await items.get("t", "MLC1");
    expect(calls).toEqual(["get"]);
  });
});
