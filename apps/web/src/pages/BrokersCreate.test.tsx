// @vitest-environment jsdom
import type { BrokerSheetDraft } from "@agentsales/core";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";

// F9.5-T16: crear un corredor con lo esencial a la vista, las opciones avanzadas plegadas y la
// opción de llenar el formulario desde una planilla (sin guardar nada hasta crear).

afterEach(cleanup);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const DRAFT: BrokerSheetDraft = {
  name: "Persona de la Planilla",
  brandName: "Ñuñoa Casas",
  primaryColor: "#1F3A5F",
  secondaryColor: null,
  whatsapp: "+56 9 0000 0000",
  email: "contacto@example.cl",
  instagramHandle: "nunoa.casas",
  website: null,
  tone: "Cercano",
  fixedHashtags: ["#uno", "#dos"],
  logoFile: "logo.png",
  warnings: ["Campo desconocido en la hoja Corredor: «Otra»"],
};

async function openForm() {
  fireEvent.click(await screen.findByRole("button", { name: "Crear un corredor" }));
  return screen.getByRole("form", { name: "Crear un corredor" });
}

const fieldValue = (form: HTMLElement, label: string) =>
  (within(form).getByLabelText(label) as HTMLInputElement).value;

const pickFile = (name = "planilla.xlsx") =>
  fireEvent.change(screen.getByLabelText("Llenar desde una planilla"), {
    target: { files: [new File([new Uint8Array([0x50, 0x4b])], name)] },
  });

describe("Crear un corredor (F9.5-T16)", () => {
  it("con solo nombre y marca: el identificador se arma solo y los colores van por defecto", async () => {
    const h = harness();
    h.renderApp("/corredores");
    const form = await openForm();

    // Lo avanzado está plegado: a la vista, solo el nombre, la marca y el identificador.
    const advanced = within(form).getByText("Opciones avanzadas").closest("details");
    expect(advanced?.open).toBe(false);
    fireEvent.change(within(form).getByLabelText("Nombre"), { target: { value: "Óscar Pérez" } });
    fireEvent.change(within(form).getByLabelText("Nombre de la marca"), {
      target: { value: "Óscar & Cía. Propiedades" },
    });
    expect(fieldValue(form, "Identificador")).toBe("oscar-cia-propiedades");
    fireEvent.click(within(form).getByRole("button", { name: "Crear corredor" }));

    expect(await screen.findByRole("heading", { name: /Óscar & Cía\. Propiedades/ })).toBeTruthy();
    const created = await h.brokers.findBySlug("oscar-cia-propiedades");
    expect(created).toMatchObject({
      name: "Óscar Pérez",
      brandName: "Óscar & Cía. Propiedades",
      primaryColor: "#233B78",
      secondaryColor: "#C96F24",
      operatorOwned: false,
      llmMonthlyCapUsd: null,
      kind: "broker",
    });
  });

  it("las opciones avanzadas: colores, contacto, tope, propio, marca y un identificador a mano", async () => {
    const h = harness();
    h.renderApp("/corredores");
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Nombre"), { target: { value: "Vinny" } });
    fireEvent.change(within(form).getByLabelText("Nombre de la marca"), {
      target: { value: "Vinny Contenido" },
    });
    fireEvent.change(within(form).getByLabelText("Identificador"), { target: { value: "vinny" } });
    // Cambiar la marca después ya no pisa el identificador escrito a mano.
    fireEvent.change(within(form).getByLabelText("Nombre de la marca"), {
      target: { value: "Vinny" },
    });
    expect(fieldValue(form, "Identificador")).toBe("vinny");

    fireEvent.click(within(form).getByText("Opciones avanzadas"));
    fireEvent.change(within(form).getByLabelText("Color primario"), {
      target: { value: "#aabbcc" },
    });
    fireEvent.change(within(form).getByLabelText("WhatsApp"), {
      target: { value: "+56 9 1111 2222" },
    });
    fireEvent.change(within(form).getByLabelText("Hashtags fijos"), {
      target: { value: "#uno dos" },
    });
    fireEvent.change(within(form).getByLabelText(/Tope de IA/), { target: { value: "12,50" } });
    fireEvent.click(within(form).getByLabelText(/Corredor propio/));
    fireEvent.click(within(form).getByLabelText(/Es una marca/));
    fireEvent.click(within(form).getByRole("button", { name: "Crear corredor" }));

    expect(await screen.findByRole("heading", { name: /Vinny/ })).toBeTruthy();
    expect(await h.brokers.findBySlug("vinny")).toMatchObject({
      primaryColor: "#AABBCC",
      secondaryColor: "#C96F24",
      whatsapp: "+56 9 1111 2222",
      fixedHashtags: ["#uno", "#dos"],
      llmMonthlyCapUsd: 12.5,
      operatorOwned: true,
      kind: "brand",
    });
  });

  it("el identificador vacío vuelve a seguir a la marca; uno ya usado queda marcado", async () => {
    const h = harness();
    await h.brokers.create(brokerData("ocupado"));
    h.renderApp("/corredores");
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Nombre"), { target: { value: "Ana" } });
    fireEvent.change(within(form).getByLabelText("Identificador"), { target: { value: "a-mano" } });
    fireEvent.change(within(form).getByLabelText("Identificador"), { target: { value: "" } });
    fireEvent.change(within(form).getByLabelText("Nombre de la marca"), {
      target: { value: "Ocupado" },
    });
    expect(fieldValue(form, "Identificador")).toBe("ocupado");
    fireEvent.click(within(form).getByRole("button", { name: "Crear corredor" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Ya existe el corredor");
    expect(within(form).getByLabelText("Identificador").getAttribute("aria-invalid")).toBe("true");
  });

  it("un tope mal escrito no se manda y abre las opciones avanzadas", async () => {
    const h = harness();
    h.renderApp("/corredores");
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Nombre"), { target: { value: "Ana" } });
    fireEvent.change(within(form).getByLabelText("Nombre de la marca"), {
      target: { value: "Ana" },
    });
    fireEvent.click(within(form).getByText("Opciones avanzadas"));
    fireEvent.change(within(form).getByLabelText(/Tope de IA/), { target: { value: "diez" } });
    fireEvent.click(within(form).getByText("Opciones avanzadas"));
    fireEvent.click(within(form).getByRole("button", { name: "Crear corredor" }));

    expect(await within(form).findByText(/Escribe un monto en dólares/)).toBeTruthy();
    expect(within(form).getByText("Opciones avanzadas").closest("details")?.open).toBe(true);
    expect(h.requests.filter((request) => request === "POST /brokers")).toEqual([]);
  });

  it("desde una planilla: llena el formulario sin guardar, y se crea al apretar el botón", async () => {
    let sent: FormData | undefined;
    const h = harness({
      // jsdom no le pasa un archivo de verdad a la API: la lectura la prueban los tests de la API.
      intercept: (method, path, init) => {
        if (method !== "POST" || path !== "/brokers/parse-template") return undefined;
        sent = init?.body as FormData;
        return json({ draft: DRAFT });
      },
    });
    h.renderApp("/corredores");
    const form = await openForm();
    pickFile();

    expect(await screen.findByText("Datos de planilla.xlsx listos")).toBeTruthy();
    expect(sent?.get("file")).toBeInstanceOf(File);
    expect(screen.getByText(/El logo \(logo\.png\) se sube después/)).toBeTruthy();
    expect(screen.getByText("Campo desconocido en la hoja Corredor: «Otra»")).toBeTruthy();
    expect(fieldValue(form, "Nombre")).toBe("Persona de la Planilla");
    expect(fieldValue(form, "Nombre de la marca")).toBe("Ñuñoa Casas");
    expect(fieldValue(form, "Identificador")).toBe("nunoa-casas");
    // Trae datos avanzados: quedan abiertos para revisarlos; el secundario vacío toma el primario.
    expect(within(form).getByText("Opciones avanzadas").closest("details")?.open).toBe(true);
    expect(fieldValue(form, "Color primario")).toBe("#1F3A5F");
    expect(fieldValue(form, "Color secundario")).toBe("#1F3A5F");
    expect(fieldValue(form, "Instagram")).toBe("nunoa.casas");
    expect(fieldValue(form, "Hashtags fijos")).toBe("#uno #dos");
    // Nada se guardó todavía.
    expect(await h.brokers.findBySlug("nunoa-casas")).toBeNull();
    expect(h.requests).not.toContain("POST /brokers");

    fireEvent.change(within(form).getByLabelText("Sitio web"), {
      target: { value: "nunoa.example.cl" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Crear corredor" }));
    expect(await screen.findByRole("heading", { name: /Ñuñoa Casas/ })).toBeTruthy();
    expect(await h.brokers.findBySlug("nunoa-casas")).toMatchObject({
      name: "Persona de la Planilla",
      primaryColor: "#1F3A5F",
      secondaryColor: "#1F3A5F",
      email: "contacto@example.cl",
      website: "nunoa.example.cl",
      fixedHashtags: ["#uno", "#dos"],
    });
  });

  it("una planilla de más de 3 MB no se sube: el panel lo dice antes", async () => {
    const h = harness();
    h.renderApp("/corredores");
    await openForm();
    fireEvent.change(screen.getByLabelText("Llenar desde una planilla"), {
      target: { files: [new File([new Uint8Array(3 * 1024 * 1024 + 1)], "grande.xlsx")] },
    });

    expect((await screen.findByRole("alert")).textContent).toContain("pesa más de 3 MB");
    expect(h.requests).not.toContain("POST /brokers/parse-template");
  });

  it("una planilla con un valor que no sirve: el error claro y el campo marcado", async () => {
    const h = harness({
      intercept: (method, path) =>
        method === "POST" && path === "/brokers/parse-template"
          ? json(
              {
                error: {
                  code: "BROKER_INVALID",
                  message:
                    "La hoja Corredor tiene valores que no sirven: Color primario: «azul» no es un color HEX (#RRGGBB)",
                  issues: [
                    {
                      code: "BROKER_FIELD_INVALID",
                      field: "primaryColor",
                      message: "Color primario: «azul» no es un color HEX (#RRGGBB)",
                    },
                  ],
                },
              },
              400,
            )
          : undefined,
    });
    h.renderApp("/corredores");
    const form = await openForm();
    pickFile();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("«azul» no es un color HEX");
    expect(alert.textContent).not.toContain("Portal");
    expect(within(form).getByLabelText("Color primario").getAttribute("aria-invalid")).toBe("true");
    expect(fieldValue(form, "Nombre")).toBe("");
    await waitFor(() => expect(screen.queryByText(/listos$/)).toBeNull());
  });
});
