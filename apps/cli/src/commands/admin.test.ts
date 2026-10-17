import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness, newListing } from "../../test/harness.js";
import { runConnect } from "./accounts.js";
import {
  runBrokerCreate,
  runBrokerEdit,
  runBrokerLogo,
  runBrokerShow,
  runBrokerTemplate,
} from "./brokers.js";
import { runUsage } from "./usage.js";
import {
  deliverLink,
  runUsersInvite,
  runUsersList,
  runUsersReset,
  runUsersToggle,
} from "./users.js";

// F7-T16 (spec F7 §4.10): usuarios, corredores, gasto y Marketplace a mano, contra la API en
// proceso. El enlace de invitación va al portapapeles (un doble) y nunca a la salida.

const BROKER_TOKEN = "token-del-corredor-de-la-cli";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const h = harness();
  const broker = await h.brokers.create(brokerData("marca"));
  const copied: string[] = [];
  let clipboardWorks = true;
  const copyToClipboard = async (text: string) => {
    if (!clipboardWorks) throw new Error("sin pbcopy");
    copied.push(text);
  };
  const cwd = await mkdtemp(join(tmpdir(), "agentsales-cli-f7-"));
  dirs.push(cwd);
  const deps = {
    ...h.io,
    client: h.client,
    copyToClipboard,
    cwd,
    confirm: async () => true,
  };
  /** Un usuario del corredor con su sesión de la CLI. */
  const asBroker = () => {
    const user = h.auth.repos.seed.user({
      email: "corredor@ejemplo.cl",
      name: "Corredor",
      role: "broker",
      brokerId: broker.id,
    });
    h.auth.repos.seed.session({
      userId: user.id,
      tokenHash: h.auth.tokens.hash(BROKER_TOKEN),
      client: "cli",
    });
    return { ...deps, client: h.clientWith(BROKER_TOKEN) };
  };
  /** Todo lo que la CLI mostró, para ver que el enlace no se filtró. */
  const shown = () => `${h.text()}\n${h.errors()}`;
  return {
    h,
    broker,
    deps,
    copied,
    asBroker,
    shown,
    breakClipboard: () => {
      clipboardWorks = false;
    },
  };
}

describe("users", () => {
  it("invite copia el enlace al portapapeles y nunca lo muestra; list lo ve sin contraseña", async () => {
    const s = await setup();
    await expect(
      runUsersInvite(s.deps, { email: "Nuevo@Ejemplo.cl", name: "Nuevo", broker: "marca" }),
    ).resolves.toBe(0);
    expect(s.copied).toHaveLength(1);
    expect(s.copied[0]).toMatch(/\/invitacion#/);
    expect(s.shown()).not.toContain(s.copied[0] ?? "x");
    expect(s.shown()).not.toContain("/invitacion");
    expect(s.h.text()).toContain("Enlace copiado al portapapeles");

    await expect(runUsersList(s.deps)).resolves.toBe(0);
    expect(s.h.text()).toMatch(
      /nuevo@ejemplo\.cl\s+Nuevo\s+corredor\s+marca\s+todavía sin contraseña/,
    );
  });

  it("reset copia un enlace nuevo; disable y enable cambian el estado", async () => {
    const s = await setup();
    await runUsersInvite(s.deps, { email: "uno@ejemplo.cl", name: "Uno", broker: "marca" });
    await expect(runUsersReset(s.deps, "uno@ejemplo.cl")).resolves.toBe(0);
    expect(s.copied).toHaveLength(2);
    expect(s.copied[1]).not.toBe(s.copied[0]);
    expect(s.shown()).not.toContain("/invitacion");

    await expect(runUsersToggle(s.deps, "uno@ejemplo.cl", "disable")).resolves.toBe(0);
    expect(s.h.text()).toContain("uno@ejemplo.cl: desactivado");
    await expect(runUsersToggle(s.deps, "uno@ejemplo.cl", "enable")).resolves.toBe(0);
    expect(s.h.text()).toContain("uno@ejemplo.cl: activo");
  });

  it("si el portapapeles falla, sale con 1 y tampoco muestra el enlace", async () => {
    const s = await setup();
    s.breakClipboard();
    await expect(
      runUsersInvite(s.deps, { email: "dos@ejemplo.cl", name: "Dos", admin: true }),
    ).resolves.toBe(1);
    expect(s.shown()).not.toContain("/invitacion");
    expect(s.h.errors()).toContain("users reset dos@ejemplo.cl");
  });

  it("sin rol claro o un usuario que no existe: el motivo, sin llamar de más", async () => {
    const s = await setup();
    await expect(runUsersInvite(s.deps, { email: "x@ejemplo.cl", name: "X" })).resolves.toBe(1);
    expect(s.h.errors()).toContain("--broker <slug>");
    await expect(runUsersReset(s.deps, "nadie@ejemplo.cl")).resolves.toBe(1);
    expect(s.h.errors()).toContain("No existe el usuario nadie@ejemplo.cl");
  });

  it("un corredor recibe el mensaje de solo el administrador", async () => {
    const s = await setup();
    const broker = s.asBroker();
    await expect(runUsersList(broker)).resolves.toBe(1);
    expect(s.h.errors()).toContain("administrador");
  });
});

describe("brokers", () => {
  it("create crea con la lista de alta; edit cambia la marca", async () => {
    const s = await setup();
    await expect(
      runBrokerCreate(s.deps, {
        slug: "nueva",
        name: "Persona Nueva",
        brand: "Nueva",
        color: "#aabbcc",
        hashtags: "casas #chile",
        cap: "15",
      }),
    ).resolves.toBe(0);
    const text = s.h.text();
    expect(text).toContain("Corredor creado");
    expect(text).toContain("Nueva (nueva)");
    expect(text).toContain("Tope de IA: US$ 15,00 al mes");
    expect(text).toContain("· Logo: falta subir el logo (lo hace el corredor)");
    expect(text).toContain(
      "· Usuario con contraseña: falta invitar a su usuario (lo hace el administrador)",
    );

    await expect(runBrokerEdit(s.deps, "nueva", { whatsapp: "+56 9 1111 2222" })).resolves.toBe(0);
    expect(s.h.text()).toContain("✓ WhatsApp");
    await expect(runBrokerShow(s.deps, "nueva")).resolves.toBe(0);
  });

  it("errores de la API con su motivo: slug repetido y color inválido", async () => {
    const s = await setup();
    const fields = { name: "X", brand: "X", color: "#000000" };
    await expect(runBrokerCreate(s.deps, { ...fields, slug: "marca" })).resolves.toBe(1);
    expect(s.h.errors()).toContain("BROKER_SLUG_TAKEN");
    await expect(runBrokerEdit(s.deps, "marca", { color: "rojo" })).resolves.toBe(1);
    expect(s.h.errors()).toContain("Color primario");
  });

  it("el corredor edita su marca, pero el tope es del administrador", async () => {
    const s = await setup();
    const broker = s.asBroker();
    await expect(runBrokerEdit(broker, "marca", { brand: "Mía" })).resolves.toBe(0);
    await expect(runBrokerEdit(broker, "marca", { cap: "5" })).resolves.toBe(1);
    expect(s.h.errors()).toContain("administrador");
    await expect(
      runBrokerCreate(broker, { slug: "otra", name: "X", brand: "X", color: "#000000" }),
    ).resolves.toBe(1);
  });

  it("logo sube el archivo y template guarda la planilla (sin pisar una que existe)", async () => {
    const s = await setup();
    await writeFile(join(s.deps.cwd, "logo.png"), Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
    await expect(runBrokerLogo(s.deps, "marca", "logo.png")).resolves.toBe(0);
    expect((await s.h.brokers.findById(s.broker.id))?.logoMediaId).not.toBeNull();
    await expect(runBrokerLogo(s.deps, "marca", "no-existe.png")).resolves.toBe(1);

    await expect(runBrokerTemplate(s.deps, "marca")).resolves.toBe(0);
    const path = join(s.deps.cwd, "planilla-marca.xlsx");
    expect(await readFile(path, "utf8")).toBe("planilla de marca");
    await expect(runBrokerTemplate(s.deps, "marca")).resolves.toBe(1);
    expect(s.h.errors()).toContain("--force");
    await expect(runBrokerTemplate(s.deps, "marca", { force: true })).resolves.toBe(0);
  });
});

describe("usage y Marketplace a mano", () => {
  it("usage muestra el gasto del mes por corredor, con su tope", async () => {
    const s = await setup();
    await expect(runUsage(s.deps, {})).resolves.toBe(0);
    expect(s.h.text()).toContain("estimado");
    expect(s.h.text()).toMatch(/marca\s+US\$ 0,00\s+sin tope\s+0/);
    await expect(runUsage(s.deps, { month: "octubre" })).resolves.toBe(1);
  });

  it("accounts connect marketplace --manual activa la cuenta a mano; --manual no va con --label", async () => {
    const s = await setup();
    const deps = {
      ...s.deps,
      stdinIsTty: () => true,
      readStdin: async () => "",
      openUrl: () => {},
      sleep: async () => {},
      clock: () => 0,
      now: () => new Date(),
    };
    await expect(runConnect(deps, "marketplace", { broker: "marca", manual: true })).resolves.toBe(
      0,
    );
    expect(s.h.text()).toContain("Marketplace a mano activado para marca");
    const [account] = await s.h.platformAccounts.listByBroker(s.broker.id, "fb_marketplace");
    expect(account).toMatchObject({ externalAccountId: "manual", status: "connected" });
    await expect(
      runConnect(deps, "marketplace", { broker: "marca", manual: true, label: "X" }),
    ).resolves.toBe(1);
    await expect(runConnect(deps, "instagram", { broker: "marca", manual: true })).resolves.toBe(1);
  });
});

describe("revisión del lote G", () => {
  it("un enlace que no es de invitación no se copia ni se muestra", async () => {
    const s = await setup();
    const user = {
      id: "u",
      email: "raro@ejemplo.cl",
      name: "Raro",
      role: "broker" as const,
      brokerId: null,
      hasPassword: false,
      disabled: false,
      locked: false,
      lastLoginAt: null,
    };
    for (const invitationUrl of ["", "http://localhost:5173/otra-cosa", "no es un enlace"]) {
      await expect(
        deliverLink(s.deps, { user, invitationUrl, expiresAt: new Date() }),
      ).resolves.toBe(1);
    }
    expect(s.copied).toEqual([]);
    expect(s.h.errors()).toContain("users reset raro@ejemplo.cl");
  });

  it("usage marca el tope alcanzado", async () => {
    const s = await setup();
    await s.h.brokers.setSettings(s.broker.id, { llmMonthlyCapUsd: 0.5 });
    const listing = await s.h.listings.create(newListing(s.broker.id, "P001"));
    const run = await s.h.contentRuns.create({ listingId: listing.id, texts: true });
    await s.h.contentRuns.addLlmUsage(run.id, {
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
    await expect(runUsage(s.deps, {})).resolves.toBe(0);
    expect(s.h.text()).toMatch(/marca\s+US\$ 0,70\s+US\$ 0,50 \(alcanzado\)\s+1/);
  });

  it("--own y --not-own juntos, un logo de más de 5 MB y una carpeta que no existe: el motivo", async () => {
    const s = await setup();
    await expect(runBrokerEdit(s.deps, "marca", { own: true, notOwn: true })).resolves.toBe(1);
    expect(s.h.errors()).toContain("--own y --not-own no van juntos");
    await writeFile(join(s.deps.cwd, "grande.png"), new Uint8Array(6 * 1024 * 1024));
    await expect(runBrokerLogo(s.deps, "marca", "grande.png")).resolves.toBe(1);
    expect(s.h.errors()).toContain("LOGO_TOO_LARGE");
    await expect(
      runBrokerTemplate(s.deps, "marca", { out: "no-existe/planilla.xlsx" }),
    ).resolves.toBe(1);
    expect(s.h.errors()).toContain("FILE_NOT_WRITABLE");
  });
});
