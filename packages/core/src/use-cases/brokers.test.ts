import { describe, expect, it } from "vitest";
import { type BrokerData, normalizeBrokerBrand } from "../broker.js";
import { AppError } from "../errors.js";
import { onboardingSteps } from "../onboarding.js";
import type { LogoNormalizer } from "../ports/logo-normalizer.js";
import {
  contentBrokerFixture,
  createInMemoryBrokerRepository,
  createInMemoryMediaRepository,
  createInMemoryMediaStorage,
} from "../testing/index.js";
import { createBroker } from "./create-broker.js";
import { MAX_LOGO_BYTES, setBrokerLogo } from "./set-broker-logo.js";
import { updateBroker } from "./update-broker.js";

// F7-T13 y T14 (spec F7 §4.6): crear y editar corredores, la lista de alta y el logo.

const ADMIN = { role: "admin" as const, brokerId: null };
const brokerUser = (brokerId: string) => ({ role: "broker" as const, brokerId });

const base: BrokerData = {
  slug: "nueva-marca",
  name: "Persona Inventada",
  brandName: "Nueva Marca",
  primaryColor: "#112233",
  secondaryColor: "#445566",
  whatsapp: null,
  email: null,
  instagramHandle: null,
  website: null,
  tone: null,
  fixedHashtags: [],
};

describe("normalizeBrokerBrand", () => {
  it("con las reglas de la hoja: colores en mayúsculas, Instagram sin @, hashtags con # y sin repetidos", () => {
    expect(
      normalizeBrokerBrand({
        brandName: "  Mi Marca ",
        primaryColor: "#a1b2c3",
        instagramHandle: "@@mimarca",
        fixedHashtags: ["casas", "#casas", "#chile, deptos"],
        email: "",
        website: " ",
      }),
    ).toEqual({
      brandName: "Mi Marca",
      primaryColor: "#A1B2C3",
      instagramHandle: "mimarca",
      fixedHashtags: ["#casas", "#chile", "#deptos"],
      email: null,
      website: null,
    });
  });

  it("colores inválidos, correo inválido y nombre vacío: BROKER_INVALID con cada uno", () => {
    try {
      normalizeBrokerBrand({
        name: " ",
        primaryColor: "rojo",
        secondaryColor: "#12345",
        email: "no-es-correo",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "BROKER_INVALID" });
      const issues = ((error as AppError).details?.issues ?? []) as { field: string }[];
      const fields = issues.map((issue) => issue.field);
      expect(fields).toEqual(["name", "primaryColor", "secondaryColor", "email"]);
    }
  });
});

describe("createBroker", () => {
  it("crea con la marca normalizada; el secundario vacío toma el primario; propio y tope opcionales", async () => {
    const brokers = createInMemoryBrokerRepository();
    const created = await createBroker({ brokers }, ADMIN, {
      slug: "otra",
      name: "Otra",
      brandName: "Otra",
      primaryColor: "#abcdef",
      operatorOwned: true,
      llmMonthlyCapUsd: 12.345,
    });
    expect(created).toMatchObject({
      slug: "otra",
      primaryColor: "#ABCDEF",
      secondaryColor: "#ABCDEF",
      operatorOwned: true,
      llmMonthlyCapUsd: 12.35,
      autoPublish: false,
    });
    const plain = await createBroker({ brokers }, ADMIN, { ...base });
    expect(plain).toMatchObject({ operatorOwned: false, llmMonthlyCapUsd: null });
  });

  it("un slug repetido es BROKER_SLUG_TAKEN, también si otra alta gana la carrera", async () => {
    const brokers = createInMemoryBrokerRepository();
    await createBroker({ brokers }, ADMIN, base);
    await expect(createBroker({ brokers }, ADMIN, base)).rejects.toMatchObject({
      code: "BROKER_SLUG_TAKEN",
    });
    const racing = {
      ...brokers,
      findBySlug: async () => null,
      create: async () => {
        throw new AppError("BROKER_CONFLICT", "ya existe", { retriable: true });
      },
    };
    await expect(createBroker({ brokers: racing }, ADMIN, base)).rejects.toMatchObject({
      code: "BROKER_SLUG_TAKEN",
    });
  });

  it("slug inválido, colores inválidos o tope fuera de rango no crean nada", async () => {
    const brokers = createInMemoryBrokerRepository();
    for (const input of [
      { ...base, slug: "Con Espacios" },
      { ...base, primaryColor: "azul" },
      { ...base, llmMonthlyCapUsd: -1 },
    ]) {
      await expect(createBroker({ brokers }, ADMIN, input)).rejects.toMatchObject({
        code: expect.stringMatching(/^BROKER_(INVALID|SETTINGS_INVALID)$/),
      });
    }
    expect(brokers.all()).toHaveLength(0);
  });
});

describe("updateBroker", () => {
  async function setup() {
    const brokers = createInMemoryBrokerRepository();
    const broker = await createBroker({ brokers }, ADMIN, base);
    return { brokers, broker };
  }

  it("el corredor edita su marca y conserva el resto", async () => {
    const { brokers, broker } = await setup();
    const updated = await updateBroker({ brokers }, brokerUser(broker.id), broker.id, {
      brandName: "Marca Nueva",
      whatsapp: "+56 9 1111 2222",
    });
    expect(updated).toMatchObject({
      slug: "nueva-marca",
      brandName: "Marca Nueva",
      whatsapp: "+56 9 1111 2222",
      primaryColor: "#112233",
    });
  });

  it.each([
    [{ operatorOwned: true }],
    [{ llmMonthlyCapUsd: 5 }],
    [{ autoPublish: true }],
    [{ brandName: "Mía", autoPublish: true }],
  ])("el corredor no puede tocar %o: FORBIDDEN, sin cambiar nada", async (input) => {
    const { brokers, broker } = await setup();
    await expect(
      updateBroker({ brokers }, brokerUser(broker.id), broker.id, input),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await brokers.findById(broker.id)).toEqual(broker);
  });

  it("un corredor no edita a otro (FORBIDDEN); el administrador cambia todo", async () => {
    const { brokers, broker } = await setup();
    await expect(
      updateBroker({ brokers }, brokerUser("otro"), broker.id, { brandName: "X" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const updated = await updateBroker({ brokers }, ADMIN, broker.id, {
      brandName: "Admin",
      operatorOwned: true,
      llmMonthlyCapUsd: null,
      autoPublish: true,
    });
    expect(updated).toMatchObject({
      brandName: "Admin",
      operatorOwned: true,
      llmMonthlyCapUsd: null,
      autoPublish: true,
    });
  });

  it("sin cambios o con colores inválidos: BROKER_INVALID; uno que no existe: BROKER_NOT_FOUND", async () => {
    const { brokers, broker } = await setup();
    await expect(updateBroker({ brokers }, ADMIN, broker.id, {})).rejects.toMatchObject({
      code: "BROKER_INVALID",
    });
    await expect(
      updateBroker({ brokers }, ADMIN, broker.id, { primaryColor: "#zzzzzz" }),
    ).rejects.toMatchObject({ code: "BROKER_INVALID" });
    await expect(
      updateBroker({ brokers }, ADMIN, "no-existe", { brandName: "X" }),
    ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND" });
  });
});

describe("onboardingSteps", () => {
  const broker = contentBrokerFixture({ logoMediaId: null, whatsapp: null });
  const user = {
    role: "broker" as const,
    brokerId: broker.id,
    hasPassword: false,
    disabledAt: null,
  };
  const account = (platform: "instagram" | "portal_inmobiliario" | "fb_marketplace") => ({
    brokerId: broker.id,
    platform,
    status: "connected" as const,
  });
  const state = (steps: ReturnType<typeof onboardingSteps>) =>
    Object.fromEntries(steps.map((step) => [step.key, step.done ? "✓" : step.owner]));

  it("un corredor recién creado: la marca hecha, lo demás pendiente con quién lo hace", () => {
    const steps = onboardingSteps({ broker, users: [], accounts: [] });
    expect(state(steps)).toEqual({
      brand: "✓",
      logo: "broker",
      whatsapp: "broker",
      user: "admin",
      instagram: "admin",
      mercadolibre: "admin",
      marketplace: "admin",
    });
    expect(steps.find((step) => step.key === "whatsapp")?.pending).toContain("Portal");
  });

  it("cada paso se completa con lo suyo; uno desactivado, de otro corredor o desconectado no cuenta", () => {
    expect(state(onboardingSteps({ broker, users: [user], accounts: [] })).user).toBe("broker");
    const done = onboardingSteps({
      broker: { ...broker, logoMediaId: "logo", whatsapp: "+56 9 1" },
      users: [{ ...user, hasPassword: true }],
      accounts: [account("instagram"), account("portal_inmobiliario"), account("fb_marketplace")],
    });
    expect(done.every((step) => step.done && step.owner === null && step.pending === null)).toBe(
      true,
    );
    const others = onboardingSteps({
      broker,
      users: [
        { ...user, hasPassword: true, disabledAt: new Date() },
        { ...user, hasPassword: true, brokerId: "otro" },
      ],
      accounts: [
        { ...account("instagram"), status: "expired" as const },
        { ...account("portal_inmobiliario"), brokerId: "otro" },
      ],
    });
    expect(state(others)).toMatchObject({
      user: "admin",
      instagram: "admin",
      mercadolibre: "admin",
    });
  });
});

describe("setBrokerLogo", () => {
  const png = Uint8Array.from([137, 80, 78, 71]);
  const logos: LogoNormalizer = {
    async normalize(input) {
      if (input[0] === 60) throw new AppError("LOGO_INVALID", "El logo debe ser PNG, JPEG o WebP");
      return { bytes: png, width: 10, height: 10 };
    },
  };
  async function setup() {
    const media = createInMemoryMediaRepository();
    const brokers = createInMemoryBrokerRepository([], { media });
    const broker = await createBroker({ brokers }, ADMIN, base);
    const storage = createInMemoryMediaStorage();
    const deps = { brokers, media, storage, logos, sha256Bytes: () => "sha-logo" };
    return { deps, broker, storage, media, brokers };
  }

  it("lo guarda en R2 como PNG y en el corredor; el mismo logo otra vez no se resube", async () => {
    const t = await setup();
    const updated = await setBrokerLogo(t.deps, ADMIN, { brokerId: t.broker.id, bytes: png });
    const path = `brokers/${t.broker.id}/brand/sha-logo.png`;
    expect(t.storage.objects.get(path)?.contentType).toBe("image/png");
    expect(updated.logoMediaId).not.toBeNull();
    expect((await t.brokers.findById(t.broker.id))?.logoMediaId).toBe(updated.logoMediaId);
    expect(await t.media.findByStoragePath(path)).toMatchObject({
      listingId: null,
      brokerId: t.broker.id,
      mime: "image/png",
    });

    await setBrokerLogo(t.deps, ADMIN, { brokerId: t.broker.id, bytes: png });
    expect(t.storage.uploads).toEqual([path]);
  });

  it("un SVG es LOGO_INVALID y uno de 6 MB, REQUEST_TOO_LARGE, sin subir nada", async () => {
    const t = await setup();
    const svg = Uint8Array.from("<svg xmlns='http://www.w3.org/2000/svg'/>", (char) =>
      char.charCodeAt(0),
    );
    await expect(
      setBrokerLogo(t.deps, ADMIN, { brokerId: t.broker.id, bytes: svg }),
    ).rejects.toMatchObject({ code: "LOGO_INVALID" });
    await expect(
      setBrokerLogo(t.deps, ADMIN, {
        brokerId: t.broker.id,
        bytes: new Uint8Array(6 * 1024 * 1024),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_TOO_LARGE" });
    expect(MAX_LOGO_BYTES).toBe(5 * 1024 * 1024);
    expect(t.storage.uploads).toEqual([]);
    expect((await t.brokers.findById(t.broker.id))?.logoMediaId).toBeNull();
  });
});

describe("revisión del lote E", () => {
  it("dos subidas del mismo logo a la vez: la segunda usa el medio de la primera", async () => {
    const media = createInMemoryMediaRepository();
    const brokers = createInMemoryBrokerRepository([], { media });
    const broker = await createBroker({ brokers }, ADMIN, base);
    const storage = createInMemoryMediaStorage();
    const logos: LogoNormalizer = {
      normalize: async () => ({ bytes: Uint8Array.from([137, 80]), width: 1, height: 1 }),
    };
    // La otra subida registra el medio justo después de que esta lo buscó.
    let raced = false;
    const racing = {
      ...media,
      findByStoragePath: async (path: string) => {
        if (!raced) {
          raced = true;
          return null;
        }
        return media.findByStoragePath(path);
      },
      create: async (data: Parameters<typeof media.create>[0]) => {
        await media.create(data);
        throw new AppError("MEDIA_CONFLICT", "ya existe", { retriable: true });
      },
    };
    const updated = await setBrokerLogo(
      { brokers, media: racing, storage, logos, sha256Bytes: () => "sha" },
      ADMIN,
      { brokerId: broker.id, bytes: Uint8Array.from([137]) },
    );
    expect(updated.logoMediaId).toBe(
      (await media.findByStoragePath(`brokers/${broker.id}/brand/sha.png`))?.id,
    );
  });

  it("el secundario vacío o null en la edición toma el primario", async () => {
    const brokers = createInMemoryBrokerRepository();
    const broker = await createBroker({ brokers }, ADMIN, base);
    for (const secondaryColor of ["", null]) {
      const updated = await updateBroker({ brokers }, ADMIN, broker.id, { secondaryColor });
      expect(updated.secondaryColor).toBe("#112233");
    }
    const both = await updateBroker({ brokers }, ADMIN, broker.id, {
      primaryColor: "#abcdef",
      secondaryColor: "",
    });
    expect(both).toMatchObject({ primaryColor: "#ABCDEF", secondaryColor: "#ABCDEF" });
  });

  it("caracteres de control en la marca: BROKER_INVALID (Postgres no los acepta)", () => {
    expect(() => normalizeBrokerBrand({ brandName: "Marca\u0000" })).toThrow(
      expect.objectContaining({ code: "BROKER_INVALID" }),
    );
    expect(() => normalizeBrokerBrand({ fixedHashtags: ["#ok", "mal\nhash"] })).toThrow(
      expect.objectContaining({ code: "BROKER_INVALID" }),
    );
  });

  it("crear es del administrador y el logo, de su corredor: si no, FORBIDDEN (core)", async () => {
    const brokers = createInMemoryBrokerRepository();
    await expect(createBroker({ brokers }, brokerUser("x"), base)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const broker = await createBroker({ brokers }, ADMIN, base);
    const media = createInMemoryMediaRepository();
    const deps = {
      brokers,
      media,
      storage: createInMemoryMediaStorage(),
      logos: { normalize: async () => ({ bytes: Uint8Array.from([1]), width: 1, height: 1 }) },
      sha256Bytes: () => "sha",
    };
    await expect(
      setBrokerLogo(deps, brokerUser("otro"), { brokerId: broker.id, bytes: Uint8Array.from([1]) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      setBrokerLogo(deps, brokerUser(broker.id), {
        brokerId: broker.id,
        bytes: Uint8Array.from([1]),
      }),
    ).resolves.toMatchObject({ id: broker.id });
  });

  it("los motivos van por campo, con su etiqueta en español", () => {
    try {
      normalizeBrokerBrand({ primaryColor: "rojo" });
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).details?.issues).toEqual([
        {
          code: "BROKER_FIELD_INVALID",
          field: "primaryColor",
          message: "Color primario: «rojo» no es un color HEX (#RRGGBB)",
        },
      ]);
      expect((error as AppError).message).toContain("Color primario");
    }
  });

  it("un corredor propio no necesita usuario en la lista de alta", () => {
    const own = contentBrokerFixture({ operatorOwned: true });
    const step = onboardingSteps({ broker: own, users: [], accounts: [] }).find(
      (candidate) => candidate.key === "user",
    );
    expect(step).toMatchObject({ done: true, owner: null });
  });
});
