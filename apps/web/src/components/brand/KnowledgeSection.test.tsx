// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../../test/harness.js";

// F9.7 B1 y B2 (ADR-0043): «Conocimiento» en Mi marca. La voz y los ejemplos se guardan; una
// novedad se agrega y se archiva; un texto largo pide una lectura y las propuestas se aceptan o
// descartan (la IA no corre aquí: la propuesta se siembra como la dejaría el worker).

afterEach(cleanup);

async function setup() {
  const h = harness();
  const brand = await h.brokers.create(brokerData("propia"), { kind: "brand" });
  h.signInAsBroker(brand.id);
  h.renderApp("/mi-marca");
  const section = await screen.findByRole("region", { name: "Conocimiento" });
  await within(section).findByRole("form", { name: "Voz de la marca" });
  return { ...h, brand, section };
}

describe("Conocimiento en Mi marca", () => {
  it("guarda la postura, el tono y un ejemplo favorito", async () => {
    const s = await setup();
    const form = within(s.section).getByRole("form", { name: "Voz de la marca" });
    fireEvent.change(within(form).getByLabelText(/Qué queremos transmitir/), {
      target: { value: "Que los agentes compren con límites" },
    });
    fireEvent.change(within(form).getByLabelText(/Tono y forma de contar/), {
      target: { value: "Relato con escena" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Agregar un ejemplo" }));
    fireEvent.change(within(form).getByLabelText("Ejemplo 1"), {
      target: { value: "Una escena concreta del lunes." },
    });
    fireEvent.click(within(form).getByLabelText("Favorito ★"));
    fireEvent.click(within(form).getByRole("button", { name: "Guardar la voz" }));
    await waitFor(async () =>
      expect(await s.deps.brandKnowledge.get(s.brand.id)).toMatchObject({
        stance: "Que los agentes compren con límites",
        tone: "Relato con escena",
      }),
    );
    expect(await s.deps.brandKnowledge.listExamples(s.brand.id)).toMatchObject([
      { text: "Una escena concreta del lunes.", favorite: true },
    ]);
  });

  it("agrega y archiva una novedad", async () => {
    const s = await setup();
    const form = within(s.section).getByRole("form", { name: "Nueva novedad" });
    fireEvent.change(within(form).getByLabelText(/Proyecto/), {
      target: { value: "AgentPey en Stellar" },
    });
    fireEvent.change(within(form).getByLabelText("Fecha"), { target: { value: "2026-11-10" } });
    fireEvent.change(within(form).getByLabelText("Qué pasó"), {
      target: { value: "Pasó a testnet." },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Agregar la novedad" }));
    const item = await within(s.section).findByText("Pasó a testnet.", { selector: "p" });
    expect(item.closest("li")?.textContent).toContain("2026-11-10 · AgentPey en Stellar");
    fireEvent.click(
      within(item.closest("li") as HTMLElement).getByRole("button", { name: "Archivar" }),
    );
    await waitFor(() =>
      expect(within(s.section).queryByText("Pasó a testnet.", { selector: "p" })).toBeNull(),
    );
  });

  it("leer un texto pide la lectura; una propuesta se acepta con edición", async () => {
    const s = await setup();
    const form = within(s.section).getByRole("form", { name: "Leer un texto" });
    fireEvent.change(within(form).getByLabelText("Texto"), {
      target: { value: "Notas: el piloto partió en Santiago esta semana con un comercio." },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Leer y proponer" }));
    await within(s.section).findByText("La IA está leyendo el texto…");
    // El worker: termina la lectura con una propuesta.
    const [run] = await s.deps.knowledgeProposals.listRuns(s.brand.id);
    await s.deps.knowledgeProposals.markRunning(run?.id ?? "");
    await s.deps.knowledgeProposals.markSucceeded(run?.id ?? "", {
      warnings: [],
      proposals: [
        { kind: "update", text: "Partió el piloto.", project: "Piloto", date: "2026-11-12" },
      ],
    });
    const card = await within(s.section).findByRole(
      "form",
      { name: "Novedad propuesta" },
      { timeout: 4_000 },
    );
    fireEvent.change(within(card).getByLabelText("Texto"), {
      target: { value: "Partió el piloto en Santiago." },
    });
    fireEvent.click(within(card).getByRole("button", { name: "Aceptar" }));
    await waitFor(async () =>
      expect(await s.deps.brandKnowledge.listUpdates(s.brand.id)).toMatchObject([
        { text: "Partió el piloto en Santiago.", project: "Piloto", source: "proposal" },
      ]),
    );
  });
});
