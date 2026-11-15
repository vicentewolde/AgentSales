// @vitest-environment jsdom
import {
  chileInputValue,
  editorialProfileView,
  formatChileDayTime,
  postSourceHashes,
  requestContentRun,
} from "@agentsales/core";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";

// Editar un post se refleja en su detalle (F9.6): la red agregada se redacta sola, quitar una red
// con publicaciones pendientes ofrece cancelarlas, la fecha nueva sugiere mover lo programado, el
// tipo dice qué falta, el tema cambiado ofrece textos nuevos y un texto se rehace solo. Contra la API
// real en proceso; nada llama a la IA ni a una red.

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

type Network = "discord" | "x" | "linkedin";

async function setup() {
  const h = harness();
  const brand = await h.brokers.create(brokerData("agentpey"), { kind: "brand" });
  await h.deps.editorialProfiles.upsert(brand.id, {
    ...editorialProfileView(brand.id, null),
    cadence: {
      linkedin: { postsPerWeek: 2, days: [], hours: [], languageGapHours: 6 },
      x: { postsPerWeek: 2, days: [], hours: [], languageGapHours: 6 },
    },
  });
  await h.platformAccounts.upsertConnected({
    brokerId: brand.id,
    platform: "discord",
    externalAccountId: "canal-1",
    displayName: "#anuncios",
    tokenExpiresAt: null,
    meta: {},
    credentials: { webhookUrl: "https://discord.com/api/webhooks/123456/token-de-prueba" },
  });
  /** Un post de la marca ya redactado (la corrida terminada con un texto por red). */
  const drafted = async (
    topic: string,
    networks: Network[],
    options: { own?: Network[] | null; kind?: "text" | "image" } = {},
  ) => {
    const post = await h.deps.posts.create({
      brokerId: brand.id,
      topic,
      kind: options.kind ?? "text",
      status: "draft",
      platforms: options.own ?? null,
    });
    const { run } = await requestContentRun(h.deps, { postId: post.id });
    await h.contentRuns.markRunning(run.id);
    await h.contentRuns.markSucceeded(run.id, {
      report: { warnings: [], postSource: postSourceHashes({ topic, brief: null }) },
      contents: networks.map((platform) => ({
        platform,
        language: "es" as const,
        title: null,
        body: `Texto para ${platform}`,
        hashtags: [],
        llmProvider: "fake" as const,
        llmModel: "fake",
        promptVersion: "social-post-v4",
        rawOutput: null,
      })),
    });
    return post;
  };
  const approve = (postId: string, platform: Network) =>
    h.client.posts[":id"].contents[":platform"][":language"].approve.$post({
      param: { id: postId, platform, language: "es" },
    });
  return { ...h, brand, drafted, approve };
}

const openEdit = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Editar el post" }));
  return screen.getByRole("form", { name: "Editar el post" });
};

describe("panel: editar un post se refleja en su detalle", () => {
  it("agregar una red a un post redactado la redacta sola: «Redactando el texto de LinkedIn…»", async () => {
    const s = await setup();
    const post = await s.drafted("Una red más", ["discord"], { own: ["discord"] });
    s.renderApp(`/contenido/${post.id}`);
    const form = await openEdit();
    fireEvent.click(await within(form).findByRole("checkbox", { name: "LinkedIn" }));
    fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));

    expect(await screen.findByText(/Redactando el texto de LinkedIn…/)).toBeTruthy();
    const run = await s.contentRuns.findActive({ kind: "post", id: post.id });
    expect(run?.scope).toEqual({
      platforms: ["linkedin"],
      language: null,
      mode: "missing",
      guidance: null,
    });
    // Si la corrida falla, el botón pide solo esa red.
    await s.contentRuns.markFailed(run?.id ?? "", { code: "LLM_TIMEOUT", message: "Se demoró" });
    await s.queryClient.invalidateQueries();
    expect(
      await screen.findByText("No se pudo redactar el texto de LinkedIn: Se demoró"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Redactar solo LinkedIn" }));
    await waitFor(async () =>
      expect(
        (await s.contentRuns.findActive({ kind: "post", id: post.id }))?.scope?.platforms,
      ).toEqual(["linkedin"]),
    );
  });

  it("quitar una red con una publicación pendiente avisa antes de guardar y ofrece cancelarla", async () => {
    const s = await setup();
    const post = await s.drafted("Sin Discord", ["discord", "x"], { own: ["discord", "x"] });
    await s.approve(post.id, "discord");
    const [publication] = await s.deps.publications.listBySubject({ kind: "post", id: post.id });
    s.renderApp(`/contenido/${post.id}`);
    const form = await openEdit();
    fireEvent.click(await within(form).findByRole("checkbox", { name: "Discord" }));

    const notice = await within(form).findByText(/Para quitar Discord del post/);
    const box = notice.parentElement as HTMLElement;
    expect(box.textContent).toContain("Discord · español");
    const save = within(form).getByRole("button", { name: "Guardar" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(within(box).getByRole("button", { name: "Cancelarla" }));
    fireEvent.click(within(box).getByRole("button", { name: "Sí, cancelarlas" }));
    await waitFor(async () =>
      expect((await s.deps.publications.get(publication?.id ?? ""))?.status).toBe("cancelled"),
    );
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(async () => expect((await s.deps.posts.get(post.id))?.platforms).toEqual(["x"]));
    // El texto de Discord no se borra: queda plegado en «Redes quitadas».
    expect(await screen.findByText("Redes quitadas (Discord)")).toBeTruthy();
  });

  it("cambiar la fecha con una publicación programada sugiere moverla, y moverla la reprograma", async () => {
    const s = await setup();
    const post = await s.drafted("Con fecha", ["discord"]);
    await s.approve(post.id, "discord");
    const first = new Date(Date.now() + 3 * 3_600_000);
    first.setUTCSeconds(0, 0);
    await s.client.posts[":id"].schedule.$post({
      param: { id: post.id },
      json: { at: first.toISOString(), platforms: ["discord"] },
    });
    s.renderApp(`/contenido/${post.id}`);
    const form = await openEdit();
    const later = new Date(first.getTime() + 24 * 3_600_000);
    fireEvent.change(within(form).getByLabelText(/Fecha planeada/), {
      target: { value: chileInputValue(later) },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));

    const target = formatChileDayTime(later);
    expect(
      await screen.findByText(
        `Este post tiene 1 publicación programada para el ${formatChileDayTime(first)}: ¿moverla al ${target}?`,
      ),
    ).toBeTruthy();
    // No se movió sola.
    const [publication] = await s.deps.publications.listBySubject({ kind: "post", id: post.id });
    expect(publication?.scheduledAt).toEqual(first);
    fireEvent.click(screen.getByRole("button", { name: `Moverla al ${target}` }));
    await waitFor(async () =>
      expect((await s.deps.publications.get(publication?.id ?? ""))?.scheduledAt).toEqual(later),
    );
  });

  it("el tipo dice arriba qué falta y qué red no sirve", async () => {
    const s = await setup();
    const post = await s.drafted("De imagen", ["discord"], { kind: "image" });
    s.renderApp(`/contenido/${post.id}`);
    const title = await screen.findByText("Post de tipo «imagen»");
    expect(title.parentElement?.textContent).toContain("Falta la imagen: el post es de imagen");
    cleanup();
    await s.deps.posts.update(post.id, { kind: "text", platforms: ["discord", "x"] });
    await s.deps.platformAccounts.upsertConnected({
      brokerId: s.brand.id,
      platform: "instagram",
      externalAccountId: "ig-1",
      displayName: "@agentpey",
      tokenExpiresAt: null,
      meta: {},
      credentials: { accessToken: "token-prueba" },
    });
    await s.deps.posts.update(post.id, { platforms: ["discord", "instagram"] });
    s.queryClient.clear();
    s.renderApp(`/contenido/${post.id}`);
    expect(
      await screen.findByText(/Instagram necesita una imagen o un video: Instagram no sirve/),
    ).toBeTruthy();
  });

  it("cambiar el tema después de redactar ofrece pedir textos nuevos, sin rehacerlos solo", async () => {
    const s = await setup();
    const post = await s.drafted("Tema de antes", ["discord"]);
    await s.deps.posts.update(post.id, { topic: "Tema de ahora" });
    s.renderApp(`/contenido/${post.id}`);
    expect(
      await screen.findByText(
        "Cambiaste el tema después de redactar: ¿pedir textos nuevos a la IA?",
      ),
    ).toBeTruthy();
    expect(await s.contentRuns.findActive({ kind: "post", id: post.id })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dejarlos así" }));
    expect(screen.queryByText(/Cambiaste el tema/)).toBeNull();
  });

  it("rehacer un texto: solo ese, con la indicación, y pide confirmar si estaba aprobado", async () => {
    const s = await setup();
    const post = await s.drafted("Un texto por rehacer", ["discord", "x"]);
    await s.approve(post.id, "discord");
    s.renderApp(`/contenido/${post.id}`);
    fireEvent.click(await screen.findByRole("tab", { name: /^Discord · español/ }));
    fireEvent.click(screen.getByRole("button", { name: "Rehacer este texto" }));
    fireEvent.change(screen.getByLabelText(/¿Qué cambiar\?/), { target: { value: "más corto" } });
    fireEvent.click(screen.getByRole("button", { name: "Rehacer con IA" }));
    expect(
      await screen.findByText(/está aprobado: al rehacerlo pierde la aprobación/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sí, rehacerlo" }));

    await waitFor(async () =>
      expect((await s.contentRuns.findActive({ kind: "post", id: post.id }))?.scope).toEqual({
        platforms: ["discord"],
        language: "es",
        mode: "replace",
        guidance: "más corto",
      }),
    );
    const texts = await s.contents.listCurrent({ kind: "post", id: post.id });
    expect(texts.map((text) => [text.platform, text.status])).toEqual([
      ["x", "draft"],
      ["discord", "edited"],
    ]);
  });
});
