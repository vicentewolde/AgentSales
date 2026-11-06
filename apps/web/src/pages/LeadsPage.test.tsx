// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";

// F10-T06: Leads en el panel contra la API real en proceso: cada corredor ve los suyos, cambia su
// estado, borra sus datos (con una pregunta antes) y genera el secreto del webhook.

afterEach(cleanup);

const CONSENT = { given: true as const, text: "Acepto", at: new Date("2026-11-06T12:00:00Z") };

async function setup() {
  const h = harness();
  const mine = await h.brokers.create(brokerData("mio"));
  const theirs = await h.brokers.create(brokerData("ajeno"));
  const lead = (brokerId: string, externalId: string, name: string) =>
    h.deps.leads.create({
      brokerId,
      source: "manychat",
      externalId,
      listingId: null,
      adId: null,
      campaign: "camp-1",
      name,
      phone: "+56911112222",
      email: null,
      consent: CONSENT,
    });
  const own = (await lead(mine.id, "a", "Ana Pérez")).lead;
  await lead(theirs.id, "b", "Luis Ajeno");
  h.signInAsBroker(mine.id);
  return { h, mine, own };
}

describe("Leads", () => {
  it("muestra solo los leads del corredor, con su contacto y su estado", async () => {
    const { h } = await setup();
    h.renderApp("/leads");
    const list = await screen.findByRole("list", { name: "Leads" });
    expect(within(list).getByText("Ana Pérez")).toBeTruthy();
    expect(within(list).getByText("+56911112222")).toBeTruthy();
    expect(screen.queryByText("Luis Ajeno")).toBeNull();
  });

  it("cambia el estado con el botón de la transición", async () => {
    const { h, own } = await setup();
    h.renderApp("/leads");
    fireEvent.click(await screen.findByRole("button", { name: "Pasar a contactado" }));
    await waitFor(async () => expect((await h.deps.leads.get(own.id))?.status).toBe("contacted"));
    expect(await screen.findByRole("button", { name: "Pasar a visita agendada" })).toBeTruthy();
  });

  it("borrar pregunta antes, y al confirmar quita los datos personales", async () => {
    const { h, own } = await setup();
    h.renderApp("/leads");
    fireEvent.click(await screen.findByRole("button", { name: "Borrar datos" }));
    expect((await h.deps.leads.get(own.id))?.name).toBe("Ana Pérez");
    fireEvent.click(screen.getByRole("button", { name: "Sí, borrar" }));
    await waitFor(async () => expect((await h.deps.leads.get(own.id))?.name).toBeNull());
    expect(await screen.findByText("Datos borrados")).toBeTruthy();
  });

  it("filtra por estado", async () => {
    const { h } = await setup();
    h.renderApp("/leads?estado=won");
    expect(await screen.findByText("No hay leads en ese estado.")).toBeTruthy();
  });

  it("genera el secreto del webhook solo después de preguntar y lo muestra una vez", async () => {
    const { h, mine } = await setup();
    h.renderApp("/leads");
    fireEvent.click(await screen.findByRole("button", { name: "Generar secreto" }));
    expect(h.requests.some((r) => r.includes("webhook-secret"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Sí, generar" }));
    const secret = await screen.findByTestId("webhook-secret");
    expect(secret.textContent?.length).toBeGreaterThan(20);
    expect(screen.getByText(new RegExp(`/api/webhooks/manychat/${mine.id}`))).toBeTruthy();
    // El secreto no queda en la caché de consultas.
    expect(
      JSON.stringify(
        h.queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(secret.textContent ?? "x");
  });
});
