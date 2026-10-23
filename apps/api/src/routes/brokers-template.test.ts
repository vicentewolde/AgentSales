import { join } from "node:path";
import { findWorkspaceRoot } from "@agentsales/config";
import { ALL_SCOPE, AppError, type Broker, MAX_BROKER_TEMPLATE_BYTES } from "@agentsales/core";
import {
  BROKER_TEMPLATE_PATH,
  readBrokerWorkbook,
  writeBrokerTemplate,
} from "@agentsales/importers";
import { describe, expect, it } from "vitest";
import type { AppDeps } from "../app.js";
import { createApp } from "../app.js";
import { brokerTemplateDraftResponseSchema, errorBodySchema } from "../contracts/index.js";
import { TEST_ADMIN_TOKEN, testAuth, testDeps } from "../testing/index.js";

// F9.5-T16: `POST /brokers/parse-template` lee la hoja Corredor de una planilla para llenar el
// formulario de crear un corredor, sin guardar nada. Con el lector real (`readBrokerWorkbook`).

const ORIGIN = "http://localhost:5173";
const BROKER_TOKEN = "token-del-corredor-planilla";

/** Una planilla con la hoja Corredor llena: la plantilla oficial escrita con estos datos. */
const sheetOf = (overrides: Partial<Broker> = {}) =>
  writeBrokerTemplate(join(findWorkspaceRoot(), BROKER_TEMPLATE_PATH), {
    id: "planilla",
    slug: "planilla",
    name: "Persona Inventada",
    brandName: "Ñuñoa Casas",
    logoMediaId: null,
    primaryColor: "#1F3A5F",
    secondaryColor: "#C96F24",
    whatsapp: "+56 9 0000 0000",
    email: "contacto@example.cl",
    instagramHandle: "nunoa.casas",
    website: null,
    tone: null,
    fixedHashtags: ["#uno", "#dos"],
    autoPublish: false,
    operatorOwned: false,
    liveEnabled: false,
    llmMonthlyCapUsd: null,
    kind: "broker",
    ...overrides,
  });

async function setup(overrides: Partial<AppDeps> = {}) {
  const auth = testAuth();
  const deps = testDeps({ access: { allowedHosts: ["localhost"], allowedOrigins: [ORIGIN] } });
  deps.auth = { ...auth, brokers: deps.brokers };
  deps.readBrokerTemplate = readBrokerWorkbook;
  Object.assign(deps, overrides);
  const app = createApp(deps);
  const mine = await deps.brokers.create({
    slug: "mio",
    name: "Persona mio",
    brandName: "Marca mio",
    primaryColor: "#112233",
    secondaryColor: "#112233",
    whatsapp: null,
    email: null,
    instagramHandle: null,
    website: null,
    tone: null,
    fixedHashtags: [],
  });
  const user = auth.repos.seed.user({
    email: "corredor-planilla@ejemplo.cl",
    name: "Corredor",
    role: "broker",
    brokerId: mine.id,
  });
  auth.repos.seed.session({
    userId: user.id,
    tokenHash: auth.tokens.hash(BROKER_TOKEN),
    client: "panel",
  });
  const upload = (token: string, bytes: Uint8Array, field = "file") => {
    const form = new FormData();
    form.append(field, new File([bytes as Uint8Array<ArrayBuffer>], "planilla.xlsx"));
    return app.request("/brokers/parse-template", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
      body: form,
    });
  };
  return { deps, admin: (bytes: Uint8Array) => upload(TEST_ADMIN_TOKEN, bytes), upload };
}

const errorOf = async (response: Response) => errorBodySchema.parse(await response.json()).error;

describe("POST /brokers/parse-template (F9.5-T16)", () => {
  it("una hoja Corredor válida: devuelve sus datos normalizados y no guarda nada", async () => {
    const s = await setup();
    const before = await s.deps.brokers.list(ALL_SCOPE);

    const response = await s.admin(await sheetOf());

    expect(response.status).toBe(200);
    const { draft } = brokerTemplateDraftResponseSchema.parse(await response.json());
    expect(draft).toMatchObject({
      name: "Persona Inventada",
      brandName: "Ñuñoa Casas",
      primaryColor: "#1F3A5F",
      secondaryColor: "#C96F24",
      whatsapp: "+56 9 0000 0000",
      email: "contacto@example.cl",
      instagramHandle: "nunoa.casas",
      website: null,
      fixedHashtags: ["#uno", "#dos"],
    });
    expect(await s.deps.brokers.list(ALL_SCOPE)).toEqual(before);
    expect(await s.deps.brokers.findBySlug("nunoa-casas")).toBeNull();
  });

  it("un valor que no sirve: 400 BROKER_INVALID con el campo y el motivo", async () => {
    const s = await setup();
    const response = await s.admin(await sheetOf({ primaryColor: "azul", email: "no-es-correo" }));

    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe("BROKER_INVALID");
    expect(error.message).toMatch(/^La hoja Corredor tiene valores que no sirven/);
    expect(error.issues?.map((issue) => issue.field).sort()).toEqual(["email", "primaryColor"]);
  });

  it("sin la hoja Corredor: 400 con el motivo del lector", async () => {
    const s = await setup({
      readBrokerTemplate: async () => {
        throw new AppError("IMPORT_FILE_INVALID", "La planilla no tiene la hoja Corredor");
      },
    });
    const response = await s.admin(await sheetOf());

    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({
      code: "IMPORT_FILE_INVALID",
      message: "La planilla no tiene la hoja Corredor",
    });
  });

  it("lo que no es un Excel: 400 IMPORT_FILE_INVALID; sin archivo: 400", async () => {
    const s = await setup();
    const garbage = await s.admin(new TextEncoder().encode("no soy un excel"));
    expect(garbage.status).toBe(400);
    expect(await errorOf(garbage)).toMatchObject({
      code: "IMPORT_FILE_INVALID",
      message: "El archivo no es un Excel (.xlsx) válido",
    });
    const missing = await s.upload(TEST_ADMIN_TOKEN, new Uint8Array([1]), "otro");
    expect(missing.status).toBe(400);
  });

  it("una planilla de más de 3 MB: 413 sin leerla", async () => {
    let read = false;
    const s = await setup({
      readBrokerTemplate: async () => {
        read = true;
        return {};
      },
    });
    // Sobre el tope más el margen del multipart.
    const response = await s.admin(new Uint8Array(MAX_BROKER_TEMPLATE_BYTES + 128 * 1024));
    expect(response.status).toBe(413);
    expect(await errorOf(response)).toMatchObject({ message: "La planilla pasa de 3 MB" });
    expect(read).toBe(false);
  });

  it("bajo 3 MB pero de más de 8 MB descomprimida: 413 IMPORT_XLSX_TOO_LARGE", async () => {
    const s = await setup();
    // Un tono de 9 MB de una sola letra: el xlsx comprimido pesa unos kB.
    const bytes = await sheetOf({ tone: "a".repeat(9 * 1024 * 1024) });
    expect(bytes.byteLength).toBeLessThan(MAX_BROKER_TEMPLATE_BYTES);

    const response = await s.admin(bytes);

    expect(response.status).toBe(413);
    expect(await errorOf(response)).toMatchObject({
      code: "IMPORT_XLSX_TOO_LARGE",
      message: "El Excel descomprimido pasa de 8 MB",
    });
  });

  it("solo el administrador: un corredor recibe 403 y el archivo no se lee", async () => {
    let read = false;
    const s = await setup({
      readBrokerTemplate: async () => {
        read = true;
        return {};
      },
    });
    const response = await s.upload(BROKER_TOKEN, await sheetOf());
    expect(response.status).toBe(403);
    expect(read).toBe(false);
  });
});
