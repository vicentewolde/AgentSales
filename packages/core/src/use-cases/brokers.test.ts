import { describe, expect, it } from "vitest";
import {
  assertAutoPublishAllowed,
  assertBrokerHoldsListings,
  autoPublishAllowed,
  type BrokerData,
  brokerHoldsListings,
  normalizeBrokerBrand,
  parseUsdAmount,
} from "../broker.js";
import { AppError } from "../errors.js";
import {
  llmSpendText,
  ONBOARDING_STEP_TEXT,
  onboardingOwnerText,
  onboardingStepText,
  userStateText,
} from "../labels.js";
import { ONBOARDING_STEPS, onboardingSteps } from "../onboarding.js";
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
      // ADR-0028: el corredor conecta su propio Instagram.
      instagram: "broker",
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
      instagram: "broker",
      mercadolibre: "admin",
    });
  });

  it("una cuenta conectada de otro corredor no marca el paso (accountOwnedBy, F9.5-T12)", () => {
    const steps = onboardingSteps({
      broker,
      users: [],
      accounts: [
        { ...account("instagram"), brokerId: "otro" },
        { ...account("portal_inmobiliario"), brokerId: "otro" },
        { ...account("fb_marketplace"), brokerId: "otro" },
      ],
    });
    expect(state(steps)).toMatchObject({
      instagram: "broker",
      mercadolibre: "admin",
      marketplace: "admin",
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

describe("revisión del lote H", () => {
  it("parseUsdAmount: montos escritos a mano; vacío es sin tope; lo demás, BROKER_SETTINGS_INVALID", () => {
    expect(parseUsdAmount("20")).toBe(20);
    expect(parseUsdAmount("12,50")).toBe(12.5);
    expect(parseUsdAmount("12.50")).toBe(12.5);
    expect(parseUsdAmount("1.000,50")).toBe(1000.5);
    expect(parseUsdAmount(" US$ 20 ")).toBe(20);
    expect(parseUsdAmount("  ")).toBeNull();
    for (const text of ["diez", "5 usd", "-3", "1,2,3", "NaN"]) {
      expect(() => parseUsdAmount(text)).toThrow(
        expect.objectContaining({ code: "BROKER_SETTINGS_INVALID" }),
      );
    }
  });

  it("los textos compartidos: el estado de un usuario y el gasto con su tope", () => {
    const user = { disabled: false, locked: false, hasPassword: true };
    expect(userStateText(user)).toBe("activo");
    expect(userStateText({ ...user, hasPassword: false })).toBe("todavía sin contraseña");
    expect(userStateText({ ...user, locked: true })).toBe("bloqueado por intentos fallidos");
    expect(userStateText({ ...user, disabled: true, locked: true })).toBe("desactivado");
    expect(llmSpendText({ spentUsd: 0.7, capUsd: 0.5 })).toBe("US$ 0,70 de US$ 0,50");
    expect(llmSpendText({ spentUsd: 0, capUsd: null })).toBe("US$ 0,00 (sin tope)");
    expect(Object.keys(ONBOARDING_STEP_TEXT)).toHaveLength(ONBOARDING_STEPS.length);
  });
});

describe("marcas (F9, ADR-0029)", () => {
  it("createBroker crea un corredor por defecto o una marca con kind; kind no decide permisos", async () => {
    const brokers = createInMemoryBrokerRepository();
    const plain = await createBroker({ brokers }, ADMIN, base);
    expect(plain.kind).toBe("broker");
    const brand = await createBroker({ brokers }, ADMIN, {
      ...base,
      slug: "agentpey",
      kind: "brand",
    });
    expect(brand).toMatchObject({ slug: "agentpey", kind: "brand", autoPublish: false });
    // El usuario de una marca edita su marca como cualquier corredor: kind no cambia los permisos.
    await expect(
      updateBroker({ brokers }, brokerUser(brand.id), brand.id, { brandName: "AgentPey" }),
    ).resolves.toMatchObject({ brandName: "AgentPey", kind: "brand" });
    await expect(
      createBroker({ brokers }, brokerUser(brand.id), { ...base, slug: "otra", kind: "brand" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("la publicación automática no se activa en una marca: BROKER_IS_BRAND, sin cambiar nada", async () => {
    const brokers = createInMemoryBrokerRepository();
    const brand = await createBroker({ brokers }, ADMIN, { ...base, kind: "brand" });
    await expect(
      updateBroker({ brokers }, ADMIN, brand.id, { brandName: "Otra", autoPublish: true }),
    ).rejects.toMatchObject({ code: "BROKER_IS_BRAND", retriable: false });
    expect(await brokers.findById(brand.id)).toEqual(brand);
    // Apagarla (ya apagada) sí: no hay nada que proteger.
    await expect(
      updateBroker({ brokers }, ADMIN, brand.id, { autoPublish: false }),
    ).resolves.toMatchObject({ autoPublish: false });
  });

  it("la lista de alta de una marca: sin WhatsApp, logo, Mercado Libre ni Marketplace; con el perfil y una red de los posts", () => {
    const brand = contentBrokerFixture({ kind: "brand", logoMediaId: null, whatsapp: null });
    const state = (steps: ReturnType<typeof onboardingSteps>) =>
      Object.fromEntries(steps.map((step) => [step.key, step.done ? "✓" : step.owner]));
    const fresh = onboardingSteps({ broker: brand, users: [], accounts: [] });
    expect(state(fresh)).toEqual({
      brand: "✓",
      editorial: "broker",
      user: "admin",
      networks: "broker",
    });
    // La marca conecta sus redes (ADR-0022 y ADR-0028), salvo Discord, que es del administrador.
    expect(fresh.find((step) => step.key === "networks")?.pending).toContain(
      "Discord lo conecta el administrador",
    );
    expect(onboardingOwnerText("broker", "brand")).toBe("lo hace la marca");
    expect(onboardingOwnerText("broker", "broker")).toBe("lo hace el corredor");
    expect(onboardingOwnerText("admin", "brand")).toBe("lo hace el administrador");
    expect(onboardingStepText("networks")).toBe("Una red para los posts");
    expect(onboardingStepText("paso-nuevo")).toBe("paso-nuevo");
    // Un corredor con perfil editorial sigue con sus pasos de avisos: el perfil solo cuenta en una marca.
    const withProfile = onboardingSteps({
      broker: contentBrokerFixture(),
      users: [],
      accounts: [],
      editorialProfile: {
        pillars: [{ key: "a", name: "A", description: "", weight: 1 }],
        facts: ["x"],
      },
    });
    expect(withProfile.map((step) => step.key)).toEqual([
      "brand",
      "logo",
      "whatsapp",
      "user",
      "instagram",
      "mercadolibre",
      "marketplace",
    ]);
    // Un perfil sin hechos (o sin líneas) todavía no sirve; Portal y Marketplace no cuentan como red.
    const half = onboardingSteps({
      broker: brand,
      users: [],
      accounts: [
        { brokerId: brand.id, platform: "portal_inmobiliario", status: "connected" },
        { brokerId: brand.id, platform: "fb_marketplace", status: "connected" },
        { brokerId: brand.id, platform: "x", status: "expired" },
        { brokerId: "otra", platform: "discord", status: "connected" },
      ],
      editorialProfile: {
        pillars: [{ key: "a", name: "A", description: "", weight: 1 }],
        facts: [],
      },
    });
    expect(state(half)).toMatchObject({ editorial: "broker", networks: "broker" });
    const done = onboardingSteps({
      broker: { ...brand, operatorOwned: true },
      users: [],
      accounts: [{ brokerId: brand.id, platform: "discord", status: "connected" }],
      editorialProfile: {
        pillars: [{ key: "a", name: "A", description: "", weight: 1 }],
        facts: ["AgentSales publica en Instagram"],
      },
    });
    expect(done.every((step) => step.done && step.owner === null && step.pending === null)).toBe(
      true,
    );
  });

  it("los predicados: un aviso y la publicación automática, solo en un corredor", () => {
    const broker = contentBrokerFixture();
    const brand = contentBrokerFixture({ kind: "brand", slug: "vinny" });
    expect(brokerHoldsListings(broker)).toBe(true);
    expect(brokerHoldsListings(brand)).toBe(false);
    expect(autoPublishAllowed(broker)).toBe(true);
    expect(autoPublishAllowed(brand)).toBe(false);
    expect(() => assertBrokerHoldsListings(broker)).not.toThrow();
    expect(() => assertBrokerHoldsListings(brand)).toThrow(
      expect.objectContaining({
        code: "BROKER_IS_BRAND",
        message: expect.stringContaining("vinny"),
      }),
    );
    expect(() => assertAutoPublishAllowed(brand)).toThrow(
      expect.objectContaining({ code: "BROKER_IS_BRAND" }),
    );
  });
});
