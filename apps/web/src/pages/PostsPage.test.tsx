// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { UPLOAD_SHA256_UP_TO_BYTES } from "@agentsales/api/contracts";
import { ALL_SCOPE } from "@agentsales/core";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerData, harness } from "../../test/harness.js";
import { postUploadEntry } from "../api/post-upload.js";
import { BROKER_SCOPE_STORAGE_KEY } from "../scope/broker-scope.js";

// F9-T17 (spec F9 §4.10): Contenido en el panel. La lista de posts por marca y estado, crear uno, el
// perfil editorial con los errores por campo de la API, y el sha256 opcional sobre 100 MB.

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

async function setup() {
  const h = harness();
  const vinny = await h.brokers.create(brokerData("vinny"), { kind: "brand" });
  const agentpey = await h.brokers.create(brokerData("agentpey"), { kind: "brand" });
  await h.deps.posts.create({ brokerId: vinny.id, topic: "Bastidores de la semana", kind: "text" });
  await h.deps.posts.create({
    brokerId: vinny.id,
    topic: "Lo que ya no va",
    kind: "image",
    status: "archived",
  });
  await h.deps.posts.create({ brokerId: agentpey.id, topic: "Producto nuevo", kind: "video" });
  return { ...h, vinny, agentpey };
}

const topics = () =>
  within(screen.getByRole("list", { name: "Posts" }))
    .getAllByRole("link")
    .map((link) => link.textContent);

describe("panel: Contenido", () => {
  it("el menú muestra Contenido; el administrador ve los posts de todas las marcas, sin los archivados", async () => {
    const s = await setup();
    s.renderApp("/contenido");
    expect(await screen.findByRole("heading", { name: "Contenido" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Contenido" })).toBeTruthy();
    await screen.findByRole("list", { name: "Posts" });
    expect(topics().sort()).toEqual(["Bastidores de la semana", "Producto nuevo"]);
    // Con "Todos", cada post dice de qué marca es.
    expect(screen.getAllByText("Marca vinny").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "archived" } });
    await waitFor(() => expect(topics()).toEqual(["Lo que ya no va"]));
    expect(s.requests).toContain("GET /posts?status=archived");
  });

  it("con una marca elegida en el selector, solo sus posts (por su id)", async () => {
    const s = await setup();
    sessionStorage.setItem(BROKER_SCOPE_STORAGE_KEY, "agentpey");
    s.renderApp("/contenido");
    await waitFor(() => expect(topics()).toEqual(["Producto nuevo"]));
    expect(s.requests).toContain(`GET /posts?brokerId=${s.agentpey.id}`);
  });

  it("el corredor de una marca ve solo lo suyo y crea un post sin elegir marca", async () => {
    const s = await setup();
    s.signInAsBroker(s.vinny.id);
    s.renderApp("/contenido");
    await waitFor(() => expect(topics()).toEqual(["Bastidores de la semana"]));
    const form = screen.getByRole("region", { name: "Nuevo post" });
    expect(within(form).queryByLabelText("Marca")).toBeNull();
    fireEvent.change(within(form).getByLabelText("Tema"), { target: { value: "Un post nuevo" } });
    fireEvent.change(within(form).getByLabelText(/^Brief/), { target: { value: "Tres ideas" } });
    fireEvent.click(within(form).getByRole("button", { name: "Crear post" }));
    expect(await screen.findByRole("heading", { name: "Un post nuevo" })).toBeTruthy();
    const created = (await s.deps.posts.list({}, ALL_SCOPE)).find(
      (post) => post.topic === "Un post nuevo",
    );
    expect(created).toMatchObject({ brokerId: s.vinny.id, status: "draft", brief: "Tres ideas" });
  });

  it("el administrador con «Todos» elige la marca al crear", async () => {
    const s = await setup();
    s.renderApp("/contenido");
    const form = await screen.findByRole("region", { name: "Nuevo post" });
    await within(form).findByLabelText("Marca");
    fireEvent.change(within(form).getByLabelText("Tema"), { target: { value: "Sin marca" } });
    fireEvent.click(within(form).getByRole("button", { name: "Crear post" }));
    expect(await within(form).findByText("Elige la marca del post.")).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("Marca"), { target: { value: s.agentpey.id } });
    fireEvent.click(within(form).getByRole("button", { name: "Crear post" }));
    expect(await screen.findByRole("heading", { name: "Sin marca" })).toBeTruthy();
  });
});

describe("panel: perfil editorial", () => {
  it("se edita en Mi marca; un error de la API se muestra junto a su campo y después se guarda", async () => {
    const s = await setup();
    s.signInAsBroker(s.vinny.id);
    s.renderApp("/mi-marca");
    const section = await screen.findByRole("region", { name: "Perfil editorial" });
    const form = await within(section).findByRole("form", { name: "Perfil editorial" });
    fireEvent.change(within(form).getByLabelText("Segundo idioma"), { target: { value: "en" } });
    fireEvent.change(within(form).getByLabelText(/^Público/), {
      target: { value: "Corredores independientes" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Agregar un tema" }));
    fireEvent.change(within(form).getByLabelText("Clave interna del tema 1"), {
      target: { value: "Una Clave Mala" },
    });
    fireEvent.change(within(form).getByLabelText("Nombre del tema 1"), {
      target: { value: "Bastidores" },
    });
    fireEvent.change(within(form).getByLabelText("Cuánto del tema 1"), { target: { value: "1" } });
    fireEvent.change(within(form).getByLabelText(/^Hechos/), {
      target: { value: "AgentSales publica en cuatro redes\n\nNació en 2026" },
    });
    fireEvent.click(within(form).getByRole("checkbox", { name: "X" }));
    fireEvent.click(within(form).getByRole("button", { name: "X: lunes" }));
    fireEvent.change(within(form).getByLabelText("Posts por semana"), { target: { value: "30" } });
    fireEvent.click(within(form).getByRole("button", { name: "Guardar el perfil" }));

    const line = within(form).getByRole("listitem", { name: "Tema 1" });
    expect(await within(line).findByText(/la clave «Una Clave Mala» no sirve/)).toBeTruthy();
    const cadence = within(form).getByRole("listitem", { name: "Cadencia de X" });
    expect(
      within(cadence).getByText(/los posts por semana son un número entero de 0 a 21/),
    ).toBeTruthy();
    expect(
      within(form).getByText("El perfil no se guardó: corrige lo marcado en rojo."),
    ).toBeTruthy();

    fireEvent.change(within(form).getByLabelText("Clave interna del tema 1"), {
      target: { value: "bastidores" },
    });
    fireEvent.change(within(form).getByLabelText("Posts por semana"), { target: { value: "1" } });
    fireEvent.change(within(form).getByLabelText("Hora nueva en X"), {
      target: { value: "09:00" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Agregar la hora en X" }));
    fireEvent.click(within(form).getByRole("button", { name: "Guardar el perfil" }));
    expect(await within(form).findByText("Perfil guardado.")).toBeTruthy();
    expect(await s.deps.editorialProfiles.get(s.vinny.id)).toMatchObject({
      languages: ["es", "en"],
      audience: "Corredores independientes",
      pillars: [{ key: "bastidores", name: "Bastidores", weight: 1 }],
      facts: ["AgentSales publica en cuatro redes", "Nació en 2026"],
      cadence: { x: { postsPerWeek: 1, days: ["mon"], hours: ["09:00"] } },
    });
  });

  it("un número mal escrito se marca sin llamar a la API", async () => {
    const s = await setup();
    s.renderApp(`/corredores/${s.agentpey.id}`);
    const form = await screen.findByRole("form", { name: "Perfil editorial" });
    fireEvent.click(within(form).getByRole("checkbox", { name: "Discord" }));
    fireEvent.change(within(form).getByLabelText("Posts por semana"), { target: { value: "dos" } });
    const before = s.requests.length;
    fireEvent.click(within(form).getByRole("button", { name: "Guardar el perfil" }));
    expect(
      await within(form).findByText(/en Discord, los posts por semana: «dos» no es un número/),
    ).toBeTruthy();
    expect(s.requests.slice(before).some((request) => request.startsWith("PUT"))).toBe(false);
  });
});

describe("subida de medios de un post: el sha256 (F9-T17, ADR-0025 punto 2)", () => {
  const nodeHash = async (blob: Blob) =>
    createHash("sha256")
      .update(new Uint8Array(await blob.arrayBuffer()))
      .digest("hex");

  it("hasta 100 MB va con su sha256; sobre eso, sin él y sin leer el archivo", async () => {
    const small = new File([new Uint8Array([1, 2, 3])], "foto.jpg");
    expect(await postUploadEntry(small, nodeHash)).toEqual({
      name: "foto.jpg",
      size: 3,
      sha256: createHash("sha256")
        .update(new Uint8Array([1, 2, 3]))
        .digest("hex"),
    });

    const big = new File([new Uint8Array([1])], "video.mp4");
    Object.defineProperty(big, "size", { value: UPLOAD_SHA256_UP_TO_BYTES + 1 });
    const hash = vi.fn(nodeHash);
    expect(await postUploadEntry(big, hash)).toEqual({
      name: "video.mp4",
      size: UPLOAD_SHA256_UP_TO_BYTES + 1,
    });
    expect(hash).not.toHaveBeenCalled();
  });
});
