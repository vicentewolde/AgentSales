import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";
import { runBrandEdit, runBrandShow } from "./brand.js";

// F9-T09 (spec F9 §4.10): `agentsales brand show|edit`, contra la API en proceso.

const BROKER_TOKEN = "token-del-corredor-brand";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const h = harness();
  const agentpey = await h.brokers.create({ ...brokerData("agentpey"), brandName: "AgentPey" });
  const other = await h.brokers.create(brokerData("otra"));
  const cwd = await mkdtemp(join(tmpdir(), "agentsales-cli-brand-"));
  dirs.push(cwd);
  const deps = { ...h.io, client: h.client, cwd };
  /** Un usuario de AgentPey con su sesión de la CLI. */
  const asBroker = () => {
    const user = h.auth.repos.seed.user({
      email: "agentpey@ejemplo.cl",
      name: "AgentPey",
      role: "broker",
      brokerId: agentpey.id,
    });
    h.auth.repos.seed.session({
      userId: user.id,
      tokenHash: h.auth.tokens.hash(BROKER_TOKEN),
      client: "cli",
    });
    return { ...deps, client: h.clientWith(BROKER_TOKEN) };
  };
  return { h, agentpey, other, deps, cwd, asBroker };
}

describe("brand edit y show", () => {
  it("edita idiomas, líneas y tres hechos, y show los muestra legibles (flujo de §6)", async () => {
    const s = await setup();
    await expect(
      runBrandEdit(s.deps, {
        broker: "agentpey",
        languages: "es,en",
        audience: "Corredores independientes",
        pillar: ["producto|Producto|2|Lo que hace AgentSales", "bastidores|Bastidores"],
        fact: ["AgentSales publica en Instagram", "Lo construye una persona"],
        addFact: ["Partió en 2026"],
        avoid: ["promesas de venta"],
        cadence: ["instagram/3/lun,mié,VIE/19:00,10:00", "x/5"],
        hashtags: "agentsales #ConstruirEnPublico",
      }),
    ).resolves.toBe(0);
    const saved = await s.h.editorialProfiles.get(s.agentpey.id);
    expect(saved).toMatchObject({
      languages: ["es", "en"],
      facts: ["AgentSales publica en Instagram", "Lo construye una persona", "Partió en 2026"],
      pillars: [
        { key: "producto", name: "Producto", weight: 2, description: "Lo que hace AgentSales" },
        { key: "bastidores", name: "Bastidores", weight: 1, description: "" },
      ],
      cadence: {
        instagram: { postsPerWeek: 3, days: ["mon", "wed", "fri"], hours: ["10:00", "19:00"] },
        x: { postsPerWeek: 5, days: [], hours: [], languageGapHours: 6 },
      },
      defaultHashtags: ["#agentsales", "#ConstruirEnPublico"],
    });
    expect(s.h.text()).toContain("✓ Perfil editorial guardado");

    await expect(runBrandShow(s.deps, { broker: "agentpey" })).resolves.toBe(0);
    const text = s.h.text();
    expect(text).toContain("Perfil editorial de AgentPey (agentpey)");
    expect(text).toContain("Idiomas: español (principal), inglés");
    expect(text).toContain("  · Producto [producto] · peso 2: Lo que hace AgentSales");
    expect(text).toContain("Hechos que la IA puede afirmar (3):");
    expect(text).toContain("  3. Partió en 2026");
    expect(text).toContain(
      "  · Instagram: 3 por semana · lun, mié, vie · 10:00, 19:00 · 6 h entre idiomas",
    );
    expect(text).toContain(
      "  · X: 5 por semana · cualquier día · cualquier hora · 6 h entre idiomas",
    );
    expect(text).toContain("Hashtags: #agentsales #ConstruirEnPublico");
  });

  it("show sin perfil explica cómo llenarlo; --json da los campos para --file", async () => {
    const s = await setup();
    await expect(runBrandShow(s.deps, { broker: "agentpey" })).resolves.toBe(0);
    expect(s.h.text()).toContain(
      "Todavía no tiene perfil: llénalo con agentsales brand edit --broker agentpey",
    );
    expect(s.h.text()).toContain("(ninguno: la IA no afirmará cifras, clientes ni resultados)");

    s.h.out.length = 0;
    await expect(runBrandShow(s.deps, { broker: "agentpey", json: true })).resolves.toBe(0);
    expect(JSON.parse(s.h.text())).toEqual({
      languages: ["es"],
      audience: null,
      pillars: [],
      facts: [],
      avoid: [],
      cadence: {},
      defaultHashtags: [],
    });
  });

  it("--file carga un JSON; lo que no trae queda como estaba, y las opciones mandan sobre él", async () => {
    const s = await setup();
    await runBrandEdit(s.deps, { broker: "agentpey", fact: ["Un hecho"], hashtags: "uno" });
    const file = join(s.cwd, "perfil.json");
    await writeFile(
      file,
      JSON.stringify({
        languages: ["en"],
        pillars: [{ key: "producto", name: "Producto", description: "", weight: 1 }],
        defaultHashtags: ["#del_archivo"],
      }),
    );
    await expect(
      runBrandEdit(s.deps, { broker: "agentpey", file: "perfil.json", hashtags: "opcion" }),
    ).resolves.toBe(0);
    expect(await s.h.editorialProfiles.get(s.agentpey.id)).toMatchObject({
      languages: ["en"],
      facts: ["Un hecho"],
      pillars: [{ key: "producto" }],
      defaultHashtags: ["#opcion"],
    });
  });

  it("--remove-cadence quita una red y deja las demás", async () => {
    const s = await setup();
    await runBrandEdit(s.deps, { broker: "agentpey", cadence: ["instagram/3", "linkedin/1"] });
    await expect(
      runBrandEdit(s.deps, { broker: "agentpey", removeCadence: ["instagram"] }),
    ).resolves.toBe(0);
    expect(Object.keys((await s.h.editorialProfiles.get(s.agentpey.id))?.cadence ?? {})).toEqual([
      "linkedin",
    ]);
  });
});

describe("errores con qué hacer", () => {
  it("sin nada que cambiar, o con opciones mal escritas, no llama a la API", async () => {
    const s = await setup();
    const before = s.h.requests.length;
    await expect(runBrandEdit(s.deps, { broker: "agentpey" })).resolves.toBe(1);
    expect(s.h.errors()).toContain("NOTHING_TO_CHANGE");
    await expect(
      runBrandEdit(s.deps, { broker: "agentpey", pillar: ["solo-clave"] }),
    ).resolves.toBe(1);
    expect(s.h.errors()).toContain('--pillar "producto|Producto|2|Lo que hace AgentSales"');
    await expect(runBrandEdit(s.deps, { broker: "agentpey", cadence: ["portal/2"] })).resolves.toBe(
      1,
    );
    expect(s.h.errors()).toContain("«portal» no es una red de posts");
    await expect(
      runBrandEdit(s.deps, { broker: "agentpey", cadence: ["instagram/3/lunes,feriado"] }),
    ).resolves.toBe(1);
    expect(s.h.errors()).toContain("«feriado» no es un día");
    await expect(
      runBrandEdit(s.deps, { broker: "agentpey", cadence: ["instagram/tres"] }),
    ).resolves.toBe(1);
    expect(s.h.errors()).toContain('--cadence "instagram/3/lun,mie,vie/10:00,19:00/6"');
    expect(s.h.requests.length).toBe(before);
  });

  it("un archivo que no existe, que no es JSON o que no tiene la forma del perfil", async () => {
    const s = await setup();
    await expect(
      runBrandEdit(s.deps, { broker: "agentpey", file: "no-existe.json" }),
    ).resolves.toBe(1);
    expect(s.h.errors()).toContain("FILE_NOT_READABLE");
    await writeFile(join(s.cwd, "roto.json"), "{ no es json");
    await expect(runBrandEdit(s.deps, { broker: "agentpey", file: "roto.json" })).resolves.toBe(1);
    expect(s.h.errors()).toContain("brand show --json > perfil.json");
    await writeFile(join(s.cwd, "otro.json"), JSON.stringify({ hechos: ["x"], facts: "uno" }));
    await expect(runBrandEdit(s.deps, { broker: "agentpey", file: "otro.json" })).resolves.toBe(1);
    expect(s.h.errors()).toContain("no tiene la forma de un perfil editorial");
    expect(await s.h.editorialProfiles.get(s.agentpey.id)).toBeNull();
  });

  it("lo que la API rechaza dice qué campo corregir y cómo", async () => {
    const s = await setup();
    await expect(
      runBrandEdit(s.deps, { broker: "agentpey", languages: "es,fr", hashtags: "#mal-escrito" }),
    ).resolves.toBe(1);
    const errors = s.h.errors();
    expect(errors).toContain("EDITORIAL_PROFILE_INVALID");
    expect(errors).toContain("Idiomas: «fr» no es un idioma (usa es o en)");
    expect(errors).toContain("Hashtags: «#mal-escrito» no es un hashtag");
    expect(errors).toContain("brand show --json muestra el perfil actual");
  });

  it("el administrador con varias marcas indica cuál; el corredor usa la suya sin --broker", async () => {
    const s = await setup();
    await expect(runBrandShow(s.deps)).resolves.toBe(1);
    expect(s.h.errors()).toContain("Indica de qué marca con --broker <slug>");

    const broker = s.asBroker();
    await expect(runBrandEdit(broker, { addFact: ["Mi hecho"] })).resolves.toBe(0);
    expect((await s.h.editorialProfiles.get(s.agentpey.id))?.facts).toEqual(["Mi hecho"]);
    // La otra marca no existe para él.
    await expect(runBrandShow(broker, { broker: "otra" })).resolves.toBe(1);
    expect(s.h.errors()).toContain("No existe la marca o el corredor otra");
    await expect(runBrandEdit(broker, { broker: "otra", fact: ["x"] })).resolves.toBe(1);
    expect(await s.h.editorialProfiles.get(s.other.id)).toBeNull();
  });
});
