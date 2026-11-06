import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";
import {
  runLeadsAssign,
  runLeadsErase,
  runLeadsExport,
  runLeadsList,
  runLeadsShow,
  runLeadsStatus,
  runLeadsWebhookSecret,
} from "./leads.js";

// F10-T05: `agentsales leads …` contra la API en proceso. Los leads tienen datos personales:
// borrar pregunta antes y exportar no pisa un archivo.

const CONSENT = { given: true as const, text: "Acepto", at: new Date("2026-11-06T12:00:00Z") };

async function setup(confirmAnswer = true) {
  const h = harness();
  const broker = await h.brokers.create(brokerData("oficina"));
  const lead = async (externalId: string, name: string) =>
    (
      await h.leads.create({
        brokerId: broker.id,
        source: "manychat",
        externalId,
        listingId: null,
        adId: "ad-1",
        campaign: "camp",
        name,
        phone: "+56911112222",
        email: null,
        consent: CONSENT,
      })
    ).lead;
  const questions: string[] = [];
  const deps = {
    ...h.io,
    client: h.client,
    cwd: await mkdtemp(join(tmpdir(), "leads-")),
    confirm: async (question: string) => {
      questions.push(question);
      return confirmAnswer;
    },
  };
  return { h, broker, lead, deps, questions };
}

describe("agentsales leads", () => {
  it("list muestra los leads y avisa cuando no hay", async () => {
    const s = await setup();
    expect(await runLeadsList(s.deps, { broker: "oficina" })).toBe(0);
    expect(s.h.text()).toContain("No hay leads");
    await s.lead("a", "Ana Pérez");
    expect(await runLeadsList(s.deps, { broker: "oficina" })).toBe(0);
    expect(s.h.text()).toContain("Ana Pérez");
    expect(s.h.text()).toContain("+56911112222");
  });

  it("list filtra por estado y rechaza uno desconocido", async () => {
    const s = await setup();
    await s.lead("a", "Ana Pérez");
    await runLeadsList(s.deps, { broker: "oficina", status: "won" });
    expect(s.h.text()).toContain("No hay leads");
    expect(await runLeadsList(s.deps, { broker: "oficina", status: "raro" })).toBe(1);
    expect(s.h.errors()).toContain("LEAD_STATUS_INVALID");
  });

  it("show y status aceptan el comienzo del id que muestra la lista", async () => {
    const s = await setup();
    const lead = await s.lead("a", "Ana Pérez");
    const prefix = lead.id.slice(0, 8);
    expect(await runLeadsShow(s.deps, prefix, { broker: "oficina" })).toBe(0);
    expect(s.h.text()).toContain("Ana Pérez");
    expect(s.h.text()).toContain("«Acepto»");
    expect(await runLeadsStatus(s.deps, prefix, "contacted", { broker: "oficina" })).toBe(0);
    expect((await s.h.leads.get(lead.id))?.status).toBe("contacted");
  });

  it("status explica una transición que no se puede", async () => {
    const s = await setup();
    const lead = await s.lead("a", "Ana");
    expect(await runLeadsStatus(s.deps, lead.id, "won")).toBe(1);
    expect(s.h.errors()).toContain("LEAD_TRANSITION_INVALID");
    expect((await s.h.leads.get(lead.id))?.status).toBe("new");
  });

  it("un comienzo de id que no calza o es muy corto falla con un mensaje", async () => {
    const s = await setup();
    await s.lead("a", "Ana");
    expect(await runLeadsShow(s.deps, "ffffffff", { broker: "oficina" })).toBe(1);
    expect(s.h.errors()).toContain("LEAD_NOT_FOUND");
    expect(await runLeadsShow(s.deps, "xyz", { broker: "oficina" })).toBe(1);
    expect(s.h.errors()).toContain("LEAD_ID_INVALID");
  });

  it("assign pide un usuario del corredor y acepta «ninguno»", async () => {
    const s = await setup();
    const lead = await s.lead("a", "Ana");
    const user = s.h.auth.repos.seed.user({
      email: "agente@ejemplo.cl",
      name: "Agente",
      role: "broker",
      brokerId: s.broker.id,
    });
    expect(await runLeadsAssign(s.deps, lead.id, user.id)).toBe(0);
    expect((await s.h.leads.get(lead.id))?.assignedTo).toBe(user.id);
    expect(await runLeadsAssign(s.deps, lead.id, "ninguno")).toBe(0);
    expect((await s.h.leads.get(lead.id))?.assignedTo).toBeNull();
    expect(await runLeadsAssign(s.deps, lead.id, "no-es-uuid")).toBe(1);
  });

  it("erase pregunta antes y, si se niega, no borra", async () => {
    const s = await setup(false);
    const lead = await s.lead("a", "Ana");
    expect(await runLeadsErase(s.deps, lead.id)).toBe(1);
    expect(s.questions[0]).toContain("No se deshace");
    expect((await s.h.leads.get(lead.id))?.name).toBe("Ana");
  });

  it("erase con --yes borra los datos personales y deja la atribución", async () => {
    const s = await setup(false);
    const lead = await s.lead("a", "Ana");
    expect(await runLeadsErase(s.deps, lead.id, { yes: true })).toBe(0);
    const after = await s.h.leads.get(lead.id);
    expect(after).toMatchObject({ name: null, phone: null, adId: "ad-1" });
    expect(after?.erasedAt).not.toBeNull();
  });

  it("export guarda el CSV y no pisa un archivo sin --force", async () => {
    const s = await setup();
    await s.lead("a", "=1+1");
    expect(await runLeadsExport(s.deps, { broker: "oficina", out: "leads.csv" })).toBe(0);
    const text = await readFile(join(s.deps.cwd, "leads.csv"), "utf8");
    expect(text).toContain("'=1+1");
    expect(s.h.text()).toContain("datos personales");
    await writeFile(join(s.deps.cwd, "otro.csv"), "viejo");
    expect(await runLeadsExport(s.deps, { broker: "oficina", out: "otro.csv" })).toBe(1);
    expect(s.h.errors()).toContain("FILE_EXISTS");
    expect(await readFile(join(s.deps.cwd, "otro.csv"), "utf8")).toBe("viejo");
    expect(await runLeadsExport(s.deps, { broker: "oficina", out: "otro.csv", force: true })).toBe(
      0,
    );
  });

  it("webhook-secret pregunta, muestra el secreto una vez y dice cómo usarlo", async () => {
    const s = await setup(false);
    expect(await runLeadsWebhookSecret(s.deps, { broker: "oficina" })).toBe(1);
    expect(s.h.text()).toContain("No se cambió nada");
    expect(await runLeadsWebhookSecret(s.deps, { broker: "oficina", yes: true })).toBe(0);
    expect(s.h.text()).toContain("no se vuelve a mostrar");
    expect(s.h.text()).toContain(`/webhooks/manychat/${s.broker.id}`);
    expect(s.h.text()).toContain("x-agentsales-secret");
  });
});
