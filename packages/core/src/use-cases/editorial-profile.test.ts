import { describe, expect, it } from "vitest";
import type { BrokerData } from "../broker.js";
import type { EditorialProfileInput } from "../editorial-profile.js";
import {
  createInMemoryBrokerRepository,
  createInMemoryEditorialProfileRepository,
} from "../testing/index.js";
import { getEditorialProfile, saveEditorialProfile } from "./editorial-profile.js";

// F9-T09 (spec F9 §4.3 y §4.10): leer con `broker.view`, editar con `brand.edit`; lo ajeno no existe.

const ADMIN = { role: "admin" as const, brokerId: null };
const brokerUser = (brokerId: string) => ({ role: "broker" as const, brokerId });

const brokerData = (slug: string): BrokerData => ({
  slug,
  name: `Persona ${slug}`,
  brandName: `Marca ${slug}`,
  primaryColor: "#112233",
  secondaryColor: "#112233",
  whatsapp: null,
  email: null,
  instagramHandle: null,
  website: null,
  tone: null,
  fixedHashtags: [],
});

const input: EditorialProfileInput = {
  languages: ["es"],
  audience: "Quien construye en público",
  pillars: [{ key: "producto", name: "Producto", description: "", weight: 1 }],
  facts: ["AgentSales publica en Instagram"],
  avoid: [],
  cadence: { instagram: { postsPerWeek: 2 } },
  defaultHashtags: ["agentsales"],
};

async function setup() {
  const brokers = createInMemoryBrokerRepository();
  const editorialProfiles = createInMemoryEditorialProfileRepository();
  const mine = await brokers.create(brokerData("mia"));
  const theirs = await brokers.create(brokerData("ajena"));
  return { deps: { brokers, editorialProfiles }, mine, theirs };
}

describe("getEditorialProfile", () => {
  it("sin perfil entrega el vacío por defecto; con perfil, el guardado", async () => {
    const s = await setup();
    const empty = await getEditorialProfile(s.deps, brokerUser(s.mine.id), s.mine.id);
    expect(empty).toMatchObject({
      brokerId: s.mine.id,
      languages: ["es"],
      facts: [],
      updatedAt: null,
    });

    await saveEditorialProfile(s.deps, ADMIN, s.mine.id, input);
    const saved = await getEditorialProfile(s.deps, brokerUser(s.mine.id), s.mine.id);
    expect(saved.facts).toEqual(["AgentSales publica en Instagram"]);
    expect(saved.updatedAt).toBeInstanceOf(Date);
  });

  it("el perfil de otro corredor no existe para un corredor, y uno que no existe tampoco", async () => {
    const s = await setup();
    await saveEditorialProfile(s.deps, ADMIN, s.theirs.id, input);
    await expect(
      getEditorialProfile(s.deps, brokerUser(s.mine.id), s.theirs.id),
    ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND" });
    await expect(
      getEditorialProfile(s.deps, ADMIN, "corredor-que-no-existe"),
    ).rejects.toMatchObject({
      code: "BROKER_NOT_FOUND",
    });
    // El administrador ve el de cualquiera.
    expect((await getEditorialProfile(s.deps, ADMIN, s.theirs.id)).facts).toHaveLength(1);
  });
});

describe("saveEditorialProfile", () => {
  it("el corredor guarda el suyo, normalizado, y reemplaza el anterior entero", async () => {
    const s = await setup();
    const saved = await saveEditorialProfile(s.deps, brokerUser(s.mine.id), s.mine.id, input);
    expect(saved).toMatchObject({
      brokerId: s.mine.id,
      defaultHashtags: ["#agentsales"],
      cadence: { instagram: { postsPerWeek: 2, days: [], hours: [], languageGapHours: 6 } },
    });
    const replaced = await saveEditorialProfile(s.deps, brokerUser(s.mine.id), s.mine.id, {
      ...input,
      facts: [],
      cadence: {},
    });
    expect(replaced).toMatchObject({ facts: [], cadence: {} });
    expect((await s.deps.editorialProfiles.get(s.mine.id))?.facts).toEqual([]);
  });

  it("el de otro corredor es 404 aunque venga inválido, y no cambia nada", async () => {
    const s = await setup();
    await saveEditorialProfile(s.deps, ADMIN, s.theirs.id, input);
    await expect(
      saveEditorialProfile(s.deps, brokerUser(s.mine.id), s.theirs.id, {
        ...input,
        languages: ["fr"],
      }),
    ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND" });
    await expect(
      saveEditorialProfile(s.deps, brokerUser(s.mine.id), s.theirs.id, { ...input, facts: [] }),
    ).rejects.toMatchObject({ code: "BROKER_NOT_FOUND" });
    expect((await s.deps.editorialProfiles.get(s.theirs.id))?.facts).toHaveLength(1);
  });

  it("inválido: EDITORIAL_PROFILE_INVALID con los problemas, sin escribir", async () => {
    const s = await setup();
    await expect(
      saveEditorialProfile(s.deps, ADMIN, s.mine.id, { ...input, languages: [] }),
    ).rejects.toMatchObject({
      code: "EDITORIAL_PROFILE_INVALID",
      details: { issues: [{ field: "languages" }] },
    });
    expect(await s.deps.editorialProfiles.get(s.mine.id)).toBeNull();
  });

  it("un corredor que no existe es BROKER_NOT_FOUND, no un error de la base", async () => {
    const s = await setup();
    await expect(
      saveEditorialProfile(s.deps, ADMIN, "corredor-que-no-existe", input),
    ).rejects.toMatchObject({
      code: "BROKER_NOT_FOUND",
    });
  });
});
