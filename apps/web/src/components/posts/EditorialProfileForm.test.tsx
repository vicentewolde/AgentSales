// @vitest-environment jsdom
import type { EditorialProfileJson } from "@agentsales/api/contracts";
import type { EditorialProfileData } from "@agentsales/core";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../../test/harness.js";
import {
  addHour,
  draftOf,
  levelOf,
  pillarKeyOf,
  profileBody,
  weightOf,
} from "./editorial-profile-draft.js";

// F9.5-T17: el perfil editorial se entiende. Cada campo con su ayuda y ejemplos que se insertan,
// los temas con «Poco / Normal / Mucho» y la cadencia con botones de días y chips de horas. Lo que
// se guarda es igual que antes (el contrato de `PUT /brokers/:id/editorial-profile` no cambia).

afterEach(cleanup);

/** Un perfil completo, como lo dejaría la CLI: dos idiomas, un peso fuera de 1–3 y dos redes. */
const FULL: EditorialProfileData = {
  languages: ["es", "en"],
  audience: "Familias que buscan arriendo en Ñuñoa",
  pillars: [
    { key: "propiedades", name: "Propiedades disponibles", description: "Lo nuevo", weight: 3 },
    { key: "consejos", name: "Consejos", description: "", weight: 2 },
    { key: "barrio", name: "El barrio", description: "", weight: 1 },
    { key: "casos", name: "Casos", description: "", weight: 40 },
  ],
  facts: ["Corredor desde 2018", "Trabajo en Ñuñoa"],
  avoid: ["Prometer plusvalía"],
  cadence: {
    instagram: {
      postsPerWeek: 3,
      days: ["mon", "wed", "fri"],
      hours: ["10:00", "19:00"],
      languageGapHours: 6,
    },
    linkedin: { postsPerWeek: 1, days: ["tue"], hours: ["09:00"], languageGapHours: 12 },
  },
  defaultHashtags: ["#propiedades", "#nunoa"],
};

const json = (data: EditorialProfileData): EditorialProfileJson => ({
  ...data,
  brokerId: "b1",
  updatedAt: null,
});

describe("perfil editorial: lo que se guarda (sin pantalla)", () => {
  it("cargar y guardar sin tocar nada manda el mismo perfil (ida y vuelta)", () => {
    const { body, issues } = profileBody(draftOf(json(FULL)));
    expect(issues).toEqual([]);
    expect(body).toEqual(FULL);
  });

  it("el peso: poco = 1, normal = 2, mucho = 3; otro número no es ninguno de los tres", () => {
    expect([weightOf("Poco"), weightOf("Normal"), weightOf("Mucho")]).toEqual([1, 2, 3]);
    expect([levelOf(1), levelOf(2), levelOf(3), levelOf(40), levelOf(0)]).toEqual([
      "Poco",
      "Normal",
      "Mucho",
      null,
      null,
    ]);
  });

  it("la clave de un tema se arma sola desde el nombre si está vacía, sin chocar con otra", () => {
    expect(pillarKeyOf("El barrio: comercio, metro y parques")).toBe(
      "el-barrio-comercio-metro-y-parques",
    );
    expect(pillarKeyOf("Ñuñoa ¡y más!")).toBe("nunoa-y-mas");
    // Hasta 40 caracteres, sin dejar un guion al final.
    expect(pillarKeyOf("Una frase larguísima que pasa de los cuarenta caracteres")).toBe(
      "una-frase-larguisima-que-pasa-de-los-cua",
    );
    expect(pillarKeyOf("Consejos de arriendo para familias dela zona")).toBe(
      "consejos-de-arriendo-para-familias-dela",
    );
    const draft = draftOf(json({ ...FULL, pillars: [] }));
    draft.pillars = [
      { key: "", name: "Casos", description: "", weight: 1 },
      { key: "casos", name: "Otros casos", description: "", weight: 2 },
      { key: "", name: "Casos", description: "", weight: 3 },
    ];
    expect(profileBody(draft).body.pillars.map((pillar) => pillar.key)).toEqual([
      "casos-2",
      "casos",
      "casos-3",
    ]);
    // Una clave escrita en mayúsculas choca igual (core las compara en minúsculas), y con el
    // sufijo la clave no pasa de 40 caracteres.
    const long = "Una frase larguísima que pasa de los cuarenta caracteres";
    draft.pillars = [
      { key: "CASOS", name: "Otros casos", description: "", weight: 1 },
      { key: "", name: "Casos", description: "", weight: 1 },
      { key: pillarKeyOf(long), name: "Otra", description: "", weight: 1 },
      { key: "", name: long, description: "", weight: 1 },
    ];
    const keys = profileBody(draft).body.pillars.map((pillar) => pillar.key);
    expect(keys).toEqual([
      "CASOS",
      "casos-2",
      "una-frase-larguisima-que-pasa-de-los-cua",
      "una-frase-larguisima-que-pasa-de-los-c-2",
    ]);
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(40);
  });

  it("un hecho con algo [entre corchetes] no se manda: hay que completarlo", () => {
    const draft = draftOf(json(FULL));
    draft.facts = "Corredor desde 2018\nCorredor de propiedades en [comuna] desde [año]";
    expect(profileBody(draft).issues).toEqual([
      {
        field: "facts",
        message:
          "Completa lo que está entre corchetes antes de guardar: «Corredor de propiedades en [comuna] desde [año]»",
      },
    ]);
  });

  it("una hora escrita y sin agregar también se guarda, en orden y sin repetir", () => {
    expect(addHour(["10:00", "19:00"], "09:30")).toEqual(["09:30", "10:00", "19:00"]);
    expect(addHour(["10:00"], "10:00")).toEqual(["10:00"]);
    const draft = draftOf(json(FULL));
    draft.cadence.instagram.newHour = "08:15";
    expect(profileBody(draft).body.cadence.instagram?.hours).toEqual(["08:15", "10:00", "19:00"]);
  });
});

async function setup(profile?: EditorialProfileData) {
  const h = harness();
  const brand = await h.brokers.create(brokerData("propia"), { kind: "brand" });
  if (profile !== undefined) await h.deps.editorialProfiles.upsert(brand.id, profile);
  h.signInAsBroker(brand.id);
  h.renderApp("/mi-marca");
  const form = await screen.findByRole("form", { name: "Perfil editorial" });
  return { ...h, brand, form };
}

const saved = async (s: Awaited<ReturnType<typeof setup>>) => {
  const profile = await s.deps.editorialProfiles.get(s.brand.id);
  if (profile === null) throw new Error("sin perfil");
  const { brokerId: _b, createdAt: _c, updatedAt: _u, ...data } = profile;
  return data;
};

describe("perfil editorial en el panel (F9.5-T17)", () => {
  it("guardar sin cambiar nada deja el perfil idéntico, también con un peso de la CLI", async () => {
    const s = await setup(FULL);
    const casos = within(s.form).getByRole("listitem", { name: "Tema 4" });
    expect(
      (within(casos).getByLabelText("Cuánto del tema 4") as HTMLSelectElement).selectedOptions[0]
        ?.textContent,
    ).toBe("Como está (peso 40, de la CLI)");
    expect(
      within(s.form).getByText(
        /Algunos temas tienen un peso puesto con la CLI \(40\); mezclado con Poco\/Normal\/Mucho/,
      ),
    ).toBeTruthy();
    const instagram = within(s.form).getByRole("listitem", { name: "Cadencia de Instagram" });
    expect(
      within(within(instagram).getByRole("list", { name: "Horas de Instagram" }))
        .getAllByRole("listitem")
        .map((chip) => chip.textContent?.replace("×", "")),
    ).toEqual(["10:00", "19:00"]);
    fireEvent.click(within(s.form).getByRole("button", { name: "Guardar el perfil" }));
    expect(await within(s.form).findByText("Perfil guardado.")).toBeTruthy();
    expect(await saved(s)).toEqual(FULL);
  });

  it("cada campo tiene su ayuda y sus ejemplos se insertan con un clic", async () => {
    const s = await setup();
    expect(within(s.form).getByText(/A quién le habla tu marca/)).toBeTruthy();
    expect(within(s.form).getByText(/De qué publica tu marca y cuánto de cada tema/)).toBeTruthy();
    expect(within(s.form).getByText(/La IA solo afirma lo que esté aquí/)).toBeTruthy();
    expect(within(s.form).getByText(/Escribe solo cosas verdaderas y comprobables/)).toBeTruthy();
    expect(within(s.form).getByText(/la IA no debe usar nunca/)).toBeTruthy();
    expect(within(s.form).queryByText("Líneas de contenido")).toBeNull();
    expect(within(s.form).getByText("Temas de la marca")).toBeTruthy();

    // Público.
    const audience = within(s.form).getByLabelText("Público") as HTMLTextAreaElement;
    expect(audience.getAttribute("aria-describedby")).toBeTruthy();
    const audienceExamples = within(s.form).getByRole("group", { name: "Ejemplos de público" });
    fireEvent.click(within(audienceExamples).getByRole("button"));
    expect(audience.value).toBe(
      "Familias y profesionales que buscan arrendar o comprar departamento en Providencia, Ñuñoa y Las Condes, y propietarios que quieren arrendar su propiedad",
    );
    expect((within(audienceExamples).getByRole("button") as HTMLButtonElement).disabled).toBe(true);

    // Temas: cada ejemplo agrega un tema con su peso.
    const pillarExamples = within(s.form).getByRole("group", { name: "Ejemplos de temas" });
    for (const name of [
      "Propiedades disponibles (mucho)",
      "Consejos para arrendar o comprar (normal)",
      "El barrio: comercio, metro y parques (poco)",
      "Casos y cómo trabajo (poco)",
    ]) {
      fireEvent.click(within(pillarExamples).getByRole("button", { name }));
    }
    expect((within(s.form).getByLabelText("Nombre del tema 1") as HTMLInputElement).value).toBe(
      "Propiedades disponibles",
    );
    const weight = within(s.form).getByLabelText("Cuánto del tema 1") as HTMLSelectElement;
    expect(weight.selectedOptions[0]?.textContent).toBe("Mucho");
    expect(
      (
        within(pillarExamples).getByRole("button", {
          name: "Propiedades disponibles (mucho)",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    // Se cambia «cuánto» con la lista: «Poco» guarda 1.
    fireEvent.change(within(s.form).getByLabelText("Cuánto del tema 2"), {
      target: { value: "1" },
    });

    // Hechos: una línea por ejemplo, sin repetir, con lo que hay que completar entre corchetes.
    const facts = within(s.form).getByRole("group", { name: "Ejemplos de hechos" });
    fireEvent.click(
      within(facts).getByRole("button", {
        name: "Corredor de propiedades en [comuna] desde [año]",
      }),
    );
    fireEvent.click(within(facts).getByRole("button", { name: "Trabajo en [comunas]" }));
    const factsField = within(s.form).getByLabelText(/^Hechos/) as HTMLTextAreaElement;
    expect(factsField.value).toBe(
      "Corredor de propiedades en [comuna] desde [año]\nTrabajo en [comunas]",
    );
    const avoid = within(s.form).getByRole("group", { name: "Ejemplos de cosas que evitar" });
    for (const name of [
      "Prometer plusvalía o rentabilidad",
      "Hablar mal de otros corredores",
      "Requisitos sobre niños, nacionalidad o estado civil",
      "Dar la dirección exacta",
    ]) {
      fireEvent.click(within(avoid).getByRole("button", { name }));
    }

    // Sin completar los corchetes, no se guarda ni se llama a la API.
    const before = s.requests.length;
    fireEvent.click(within(s.form).getByRole("button", { name: "Guardar el perfil" }));
    expect(
      await within(s.form).findByText(
        /Completa lo que está entre corchetes antes de guardar: «Trabajo en \[comunas\]»/,
      ),
    ).toBeTruthy();
    expect(s.requests.slice(before).some((request) => request.startsWith("PUT"))).toBe(false);
    expect(await s.deps.editorialProfiles.get(s.brand.id)).toBeNull();

    fireEvent.change(factsField, {
      target: {
        value:
          "Corredor de propiedades en Santiago desde 2018\nTrabajo en Providencia, Ñuñoa y Las Condes",
      },
    });
    fireEvent.click(within(s.form).getByRole("button", { name: "Guardar el perfil" }));
    expect(await within(s.form).findByText("Perfil guardado.")).toBeTruthy();
    expect(await saved(s)).toMatchObject({
      audience:
        "Familias y profesionales que buscan arrendar o comprar departamento en Providencia, Ñuñoa y Las Condes, y propietarios que quieren arrendar su propiedad",
      pillars: [
        { key: "propiedades-disponibles", name: "Propiedades disponibles", weight: 3 },
        { key: "consejos-para-arrendar-o-comprar", weight: 1 },
        { key: "el-barrio-comercio-metro-y-parques", weight: 1 },
        { key: "casos-y-como-trabajo", weight: 1 },
      ],
      facts: [
        "Corredor de propiedades en Santiago desde 2018",
        "Trabajo en Providencia, Ñuñoa y Las Condes",
      ],
      avoid: [
        "Prometer plusvalía o rentabilidad",
        "Hablar mal de otros corredores",
        "Requisitos sobre niños, nacionalidad o estado civil",
        "Dar la dirección exacta",
      ],
    });
  });

  it("la cadencia se arma con botones de días y chips de horas, y se guarda como siempre", async () => {
    const s = await setup(FULL);
    const instagram = within(s.form).getByRole("listitem", { name: "Cadencia de Instagram" });
    const days = within(instagram).getByRole("group", { name: "Días de Instagram" });
    expect(
      within(days)
        .getAllByRole("button")
        .map(
          (day) => `${day.textContent}${day.getAttribute("aria-pressed") === "true" ? "*" : ""}`,
        ),
    ).toEqual(["L*", "M", "M*", "J", "V*", "S", "D"]);
    // Quitar el viernes y sumar el sábado.
    fireEvent.click(within(days).getByRole("button", { name: "Instagram: viernes" }));
    fireEvent.click(within(days).getByRole("button", { name: "Instagram: sábado" }));
    expect(
      within(days).getByRole("button", { name: "Instagram: sábado" }).getAttribute("aria-pressed"),
    ).toBe("true");

    // Quitar las 19:00 con su x y agregar las 13:30 con el campo de hora.
    fireEvent.click(
      within(instagram).getByRole("button", { name: "Quitar las 19:00 de Instagram" }),
    );
    const add = within(instagram).getByRole("button", {
      name: "Agregar la hora en Instagram",
    }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(within(instagram).getByLabelText("Hora nueva en Instagram"), {
      target: { value: "13:30" },
    });
    fireEvent.click(add);
    // La misma hora dos veces queda una.
    fireEvent.change(within(instagram).getByLabelText("Hora nueva en Instagram"), {
      target: { value: "10:00" },
    });
    fireEvent.keyDown(within(instagram).getByLabelText("Hora nueva en Instagram"), {
      key: "Enter",
    });
    expect(
      within(within(instagram).getByRole("list", { name: "Horas de Instagram" }))
        .getAllByRole("listitem")
        .map((chip) => chip.textContent?.replace("×", "")),
    ).toEqual(["10:00", "13:30"]);

    // Con dos idiomas, las horas entre idiomas se explican.
    expect(within(instagram).getByText(/Cada post sale una vez por idioma/)).toBeTruthy();

    // Una red nueva: X, con 2 posts por semana el martes a las 08:00. Sin días ni horas, dice lo
    // que usa el plan.
    fireEvent.click(within(s.form).getByRole("checkbox", { name: "X" }));
    const x = within(s.form).getByRole("listitem", { name: "Cadencia de X" });
    expect(within(x).getByText("Sin días elegidos: el plan usa de lunes a viernes.")).toBeTruthy();
    expect(within(x).getByText("Sin horas elegidas: el plan usa las 10:00.")).toBeTruthy();
    fireEvent.change(within(x).getByLabelText("Posts por semana"), { target: { value: "2" } });
    fireEvent.click(within(x).getByRole("button", { name: "X: martes" }));
    fireEvent.change(within(x).getByLabelText("Hora nueva en X"), { target: { value: "08:00" } });
    fireEvent.click(within(x).getByRole("button", { name: "Agregar la hora en X" }));
    // En LinkedIn, una hora escrita y sin agregar: se guarda y pasa a ser un chip.
    const linkedin = within(s.form).getByRole("listitem", { name: "Cadencia de LinkedIn" });
    fireEvent.change(within(linkedin).getByLabelText("Hora nueva en LinkedIn"), {
      target: { value: "18:00" },
    });

    fireEvent.click(within(s.form).getByRole("button", { name: "Guardar el perfil" }));
    expect(await within(s.form).findByText("Perfil guardado.")).toBeTruthy();
    await waitFor(async () =>
      expect((await saved(s)).cadence).toEqual({
        instagram: {
          postsPerWeek: 3,
          days: ["mon", "wed", "sat"],
          hours: ["10:00", "13:30"],
          languageGapHours: 6,
        },
        linkedin: { ...FULL.cadence.linkedin, hours: ["09:00", "18:00"] },
        x: { postsPerWeek: 2, days: ["tue"], hours: ["08:00"], languageGapHours: 6 },
      }),
    );
    expect(
      (within(linkedin).getByLabelText("Hora nueva en LinkedIn") as HTMLInputElement).value,
    ).toBe("");
    expect(
      within(within(linkedin).getByRole("list", { name: "Horas de LinkedIn" }))
        .getAllByRole("listitem")
        .map((chip) => chip.textContent?.replace("×", "")),
    ).toEqual(["09:00", "18:00"]);
  });

  it("con 8 horas, «Agregar» queda desactivado", async () => {
    const hours = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00"];
    const s = await setup({
      ...FULL,
      cadence: { x: { postsPerWeek: 1, days: [], hours, languageGapHours: 6 } },
    });
    const x = within(s.form).getByRole("listitem", { name: "Cadencia de X" });
    fireEvent.change(within(x).getByLabelText("Hora nueva en X"), { target: { value: "16:00" } });
    expect(
      (within(x).getByRole("button", { name: "Agregar la hora en X" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(within(x).getByText(/Son 8 horas como máximo/)).toBeTruthy();
    fireEvent.click(within(x).getByRole("button", { name: "Quitar las 15:00 de X" }));
    expect(
      (within(x).getByRole("button", { name: "Agregar la hora en X" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("la clave que se armó sola no cambia al renombrar el tema después de guardar", async () => {
    const s = await setup();
    fireEvent.click(within(s.form).getByRole("button", { name: "Agregar un tema" }));
    fireEvent.change(within(s.form).getByLabelText("Nombre del tema 1"), {
      target: { value: "Propiedades disponibles" },
    });
    fireEvent.click(within(s.form).getByRole("button", { name: "Guardar el perfil" }));
    expect(await within(s.form).findByText("Perfil guardado.")).toBeTruthy();
    expect((await saved(s)).pillars).toMatchObject([
      { key: "propiedades-disponibles", name: "Propiedades disponibles" },
    ]);
    await waitFor(() =>
      expect(
        (within(s.form).getByLabelText("Clave interna del tema 1") as HTMLInputElement).value,
      ).toBe("propiedades-disponibles"),
    );

    fireEvent.change(within(s.form).getByLabelText("Nombre del tema 1"), {
      target: { value: "Departamentos en arriendo" },
    });
    fireEvent.click(within(s.form).getByRole("button", { name: "Guardar el perfil" }));
    expect(await within(s.form).findByText("Perfil guardado.")).toBeTruthy();
    await waitFor(async () =>
      expect((await saved(s)).pillars).toMatchObject([
        { key: "propiedades-disponibles", name: "Departamentos en arriendo" },
      ]),
    );
  });
});
