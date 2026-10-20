// @vitest-environment jsdom
import type { Language, Platform, PublicationStatus } from "@agentsales/core";
import { chileInputValue, formatChileTime, requestContentRun } from "@agentsales/core";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";

// F9-T17 (spec F9 §4.10): el detalle de un post en el panel, contra la API real en proceso: los
// textos por red e idioma (editar con el conteo de la red, aprobar), los medios con avance, pedir
// los textos a la IA, publicar una red, programar, y resolver una publicación dudosa o confirmar
// una que se publica a mano.

afterEach(cleanup);

async function setup() {
  const h = harness();
  const brand = await h.brokers.create(brokerData("vinny"), { kind: "brand" });
  await h.platformAccounts.upsertConnected({
    brokerId: brand.id,
    platform: "discord",
    externalAccountId: "canal-1",
    displayName: "#anuncios",
    tokenExpiresAt: null,
    meta: {},
    credentials: { webhookUrl: "https://discord.com/api/webhooks/123456/token-de-prueba" },
  });
  const post = await h.deps.posts.create({
    brokerId: brand.id,
    topic: "Lo que aprendí esta semana",
    kind: "text",
    status: "draft",
  });
  /** Hace de worker: pide la corrida y la termina con un texto por red e idioma. */
  const draft = async (
    texts: { platform: Platform; language: Language; body?: string }[] = [
      { platform: "discord", language: "es" },
    ],
  ) => {
    const { run } = await requestContentRun(h.deps, { postId: post.id });
    await h.contentRuns.markRunning(run.id);
    await h.contentRuns.markSucceeded(run.id, {
      report: { warnings: [] },
      contents: texts.map((text) => ({
        platform: text.platform,
        language: text.language,
        title: null,
        body: text.body ?? `Texto en ${text.language} para ${text.platform}`,
        hashtags: [],
        llmProvider: "fake",
        llmModel: "fake",
        promptVersion: "social-post-v1",
        rawOutput: null,
      })),
    });
  };
  /** Aprueba el texto de Discord (nace su publicación aprobada) y la mueve por la máquina de estados. */
  const approvedPublication = async (steps: PublicationStatus[]) => {
    await draft();
    const content = (await h.contents.listCurrent({ kind: "post", id: post.id }))[0];
    if (content === undefined) throw new Error("sin texto");
    await h.client.posts[":id"].contents[":platform"][":language"].approve.$post({
      param: { id: post.id, platform: "discord", language: "es" },
    });
    const [publication] = await h.deps.publications.listBySubject({ kind: "post", id: post.id });
    if (publication === undefined) throw new Error("sin publicación");
    await h.deps.postLock.run(post.id, async ({ publications }) => {
      let current = await publications.get(publication.id);
      for (const to of steps) {
        if (current === null) throw new Error("no existe");
        current = await publications.transition(
          publication.id,
          {
            from: current.status,
            to,
            ...(to === "publishing" ? { changes: { dryRun: true } } : {}),
          },
          { actor: "system" },
        );
      }
    });
    return publication;
  };
  const open = async () => {
    h.renderApp(`/contenido/${post.id}`);
    return screen.findByRole("heading", { name: "Lo que aprendí esta semana" });
  };
  return { ...h, brand, post, draft, approvedPublication, open };
}

describe("panel: detalle de un post", () => {
  it("pide los textos a la IA y, con textos editados, ofrece reemplazarlos", async () => {
    const s = await setup();
    await s.open();
    expect(screen.getByText("Todavía no hay textos: pídelos a la IA.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pedir los textos a la IA" }));
    await waitFor(() => expect(s.requests).toContain(`POST /posts/${s.post.id}/draft`));
    expect(await screen.findByText("Textos pedidos: esperando al worker…")).toBeTruthy();
  });

  it("una pestaña por red e idioma; editar muestra el conteo ponderado de X y guarda", async () => {
    const s = await setup();
    await s.draft([
      { platform: "x", language: "es", body: "Hola" },
      { platform: "x", language: "en", body: "Hello" },
      { platform: "discord", language: "es" },
    ]);
    await s.open();
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["X · español", "X · inglés", "Discord · español"]);
    expect(screen.getByText(/^4 \/ 280 caracteres/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    const form = screen.getByRole("form", { name: "Editar el texto de X · español" });
    const text = within(form).getByLabelText("Texto");
    // Un enlace cuenta 23 en X, sea cual sea su largo, y un emoji 2.
    fireEvent.change(text, { target: { value: "Mira https://ejemplo.com/una/ruta/muy/larga 🚀" } });
    expect(within(form).getByText(/^31 \/ 280 caracteres \(conteo de X/)).toBeTruthy();
    expect(within(form).getByText(/Lleva un enlace: en X ese post cuesta US\$0,20/)).toBeTruthy();
    fireEvent.change(text, { target: { value: "a".repeat(281) } });
    expect(within(form).getByText(/281 \/ 280 caracteres.*se pasa por 1/)).toBeTruthy();
    fireEvent.change(text, { target: { value: "Lo nuevo de la semana" } });
    fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(s.requests).toContain(`PATCH /posts/${s.post.id}/contents/x/es`));
    expect(await screen.findByText(/^Texto: editado/)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Discord · español" }));
    expect(screen.getByRole("figure", { name: "Vista previa de Discord · español" })).toBeTruthy();
  });

  it("aprobar abre la publicación; Publicar en una red (simulación) la pone en curso", async () => {
    const s = await setup();
    await s.draft();
    await s.open();
    fireEvent.click(screen.getByRole("button", { name: "Aprobar" }));
    await waitFor(() =>
      expect(s.requests).toContain(`POST /posts/${s.post.id}/contents/discord/es/approve`),
    );
    const publish = await screen.findByRole("button", { name: "Publicar en Discord (simulación)" });
    const list = screen.getByRole("region", { name: "Publicaciones" });
    expect(await within(list).findByText("aprobada")).toBeTruthy();
    fireEvent.click(publish);
    await waitFor(() => expect(s.requests).toContain(`POST /posts/${s.post.id}/publish`));
    expect(await within(list).findByText("publicando")).toBeTruthy();
    expect(screen.getByText(/Discord: 1 publicación\(es\) en curso/)).toBeTruthy();
  });

  it("programar pide la hora de Chile y deja la publicación programada", async () => {
    const s = await setup();
    await s.draft();
    await s.client.posts[":id"].contents[":platform"][":language"].approve.$post({
      param: { id: s.post.id, platform: "discord", language: "es" },
    });
    await s.open();
    fireEvent.click(await screen.findByRole("button", { name: "Programar…" }));
    expect(screen.getByRole("checkbox", { name: "Discord" })).toHaveProperty("checked", true);
    // En 10 días, en punto (programar llega hasta 60 días adelante).
    const at = new Date(Date.now() + 10 * 86_400_000);
    at.setUTCMinutes(0, 0, 0);
    fireEvent.change(screen.getByLabelText("Fecha y hora (Chile)"), {
      target: { value: chileInputValue(at) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Programar" }));
    await waitFor(() => expect(s.requests).toContain(`POST /posts/${s.post.id}/schedule`));
    expect(
      await screen.findByText(`Discord: programado para el ${formatChileTime(at)} (hora de Chile)`),
    ).toBeTruthy();
    const list = screen.getByRole("region", { name: "Publicaciones" });
    expect(await within(list).findByText("programada")).toBeTruthy();
  });

  it("resuelve una publicación con resultado dudoso: «Sí, salió» la deja publicada", async () => {
    const s = await setup();
    const publication = await s.approvedPublication(["publishing", "outcome_unknown"]);
    await s.open();
    const list = screen.getByRole("region", { name: "Publicaciones" });
    expect(within(list).getByText(/No se sabe si salió/)).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "Sí, salió" }));
    await waitFor(() =>
      expect(s.requests).toContain(`POST /publications/${publication.id}/resolve`),
    );
    expect(await within(list).findByText("publicada")).toBeTruthy();
  });

  it("«No salió» la deja fallida, para volver a intentarlo", async () => {
    const s = await setup();
    await s.approvedPublication(["publishing", "outcome_unknown"]);
    await s.open();
    const list = screen.getByRole("region", { name: "Publicaciones" });
    fireEvent.click(within(list).getByRole("button", { name: "No salió" }));
    expect(await within(list).findByRole("button", { name: "Reintentar" })).toBeTruthy();
  });

  it("confirma una publicación a mano con su enlace", async () => {
    const s = await setup();
    const publication = await s.approvedPublication(["publishing", "awaiting_manual_confirm"]);
    await s.open();
    const list = screen.getByRole("region", { name: "Publicaciones" });
    expect(within(list).getByText(/Publícala a mano en Discord/)).toBeTruthy();
    fireEvent.change(within(list).getByLabelText(/Enlace de la publicación/), {
      target: { value: "https://discord.com/channels/1/2/3" },
    });
    fireEvent.click(within(list).getByRole("button", { name: "Lo publiqué" }));
    await waitFor(() =>
      expect(s.requests).toContain(`POST /publications/${publication.id}/confirm`),
    );
    expect(await within(list).findByText("publicada")).toBeTruthy();
  });

  it("sube un medio con avance a R2 y lo muestra procesando hasta que el worker arme sus variantes", async () => {
    const s = await setup();
    await s.open();
    const region = screen.getByRole("region", { name: "Medios" });
    const input = within(region).getByLabelText("Subir fotos o videos");
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], "foto.jpg", {
      type: "image/jpeg",
    });
    fireEvent.change(input, { target: { files: [photo] } });
    expect(await within(region).findByText("Fotos y videos (1)")).toBeTruthy();
    expect(within(region).getByText("procesando…")).toBeTruthy();
    expect(s.transfers).toHaveLength(1);
    expect(s.transfers[0]?.name).toMatch(
      new RegExp(`posts/${s.post.id}/original/[0-9a-f]{64}\\.jpg$`),
    );
    expect(s.requests).toContain(`POST /posts/${s.post.id}/uploads/complete`);
  });

  it("un post archivado no se edita, ni pide textos ni recibe medios", async () => {
    const s = await setup();
    await s.deps.posts.archive(s.post.id);
    await s.open();
    expect(screen.queryByRole("button", { name: "Editar el post" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Pedir los textos a la IA" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByLabelText("Subir fotos o videos").hasAttribute("disabled")).toBe(true);
  });
});
