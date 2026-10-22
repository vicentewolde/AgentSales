// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import {
  ALL_SCOPE,
  editorialProfileView,
  type LLMProvider,
  requestContentRun,
  requestPlanRun,
  runPlan,
  samplePlanResponse,
} from "@agentsales/core";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";
import { BROKER_SCOPE_STORAGE_KEY } from "../scope/broker-scope.js";

// F9-T21 (spec F9 §4.9 y §4.10): el plan de ideas en el panel, contra la API real en proceso. El
// "worker" corre el plan con el plan de ejemplo (`fake`): nunca la IA real.

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

/** El proveedor `fake` del worker: el plan de ejemplo armado con el prompt. */
const sampleLlm: LLMProvider = {
  name: "fake",
  async generateStructured(request) {
    return { data: samplePlanResponse(request.prompt), model: "fake" };
  },
};

async function setup() {
  const h = harness();
  const brand = await h.brokers.create(brokerData("agentpey"), { kind: "brand" });
  const other = await h.brokers.create(brokerData("vinny"), { kind: "brand" });
  for (const broker of [brand, other]) {
    await h.deps.editorialProfiles.upsert(broker.id, {
      ...editorialProfileView(broker.id, null),
      pillars: [{ key: "producto", name: "Producto", description: "Lo que hacemos", weight: 1 }],
      cadence: {
        linkedin: { postsPerWeek: 2, days: [], hours: [], languageGapHours: 6 },
        x: { postsPerWeek: 2, days: [], hours: [], languageGapHours: 6 },
      },
    });
  }
  /** Hace de worker: corre los planes en cola con el plan de ejemplo. */
  const work = async () => {
    for (const run of await h.deps.planRuns.listQueued()) {
      await runPlan(
        {
          planRuns: h.deps.planRuns,
          posts: h.deps.posts,
          brokers: h.deps.brokers,
          editorialProfiles: h.deps.editorialProfiles,
          contentRuns: h.deps.contentRuns,
          llm: sampleLlm,
          newId: randomUUID,
        },
        { planRunId: run.id, isLastAttempt: true },
      );
    }
  };
  /** Un plan ya corrido de la marca, con `count` ideas. */
  const planned = async (count = 3) => {
    const { run } = await requestPlanRun(
      h.deps,
      { id: "admin", role: "admin", brokerId: null },
      { brokerId: brand.id, count },
    );
    await work();
    return run;
  };
  const ideas = async () =>
    (await h.deps.posts.list({ brokerId: brand.id }, ALL_SCOPE)).filter(
      (post) => post.source === "ai",
    );
  return { ...h, brand, other, work, planned, ideas };
}

describe("panel: Plan", () => {
  it("el corredor pide un plan, lo sigue mientras la IA propone y ve las ideas por semana", async () => {
    const s = await setup();
    s.signInAsBroker(s.brand.id);
    s.renderApp("/plan");
    expect(await screen.findByRole("heading", { name: "Plan" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Plan" })).toBeTruthy();
    const form = await screen.findByRole("region", { name: "Pedir un plan" });
    expect(await screen.findByText("Esta marca todavía no tiene planes.")).toBeTruthy();
    // Las redes que se ofrecen son las de la marca (las de su cadencia).
    await waitFor(() =>
      expect(
        within(form)
          .getAllByRole("checkbox")
          .map((box) => box.parentElement?.textContent),
      ).toEqual(["X", "LinkedIn"]),
    );
    fireEvent.change(within(form).getByLabelText("Días"), { target: { value: "7" } });
    fireEvent.change(within(form).getByLabelText(/^Cuántas ideas/), { target: { value: "2" } });
    fireEvent.click(within(form).getByRole("checkbox", { name: "LinkedIn" }));
    fireEvent.click(within(form).getByRole("button", { name: "Pedir el plan" }));

    expect(await screen.findByText("Plan en cola…")).toBeTruthy();
    expect(s.requests).toContain("POST /plans");
    const [run] = await s.deps.planRuns.listByBroker(s.brand.id);
    expect(run?.request).toMatchObject({ platforms: ["linkedin"], count: 2, days: 7 });

    await s.work();
    // La página vuelve a mirar sola mientras el plan está en cola.
    const ideas = await s.ideas();
    expect(ideas).toHaveLength(2);
    for (const idea of ideas) {
      expect(
        await screen.findByRole("listitem", { name: idea.topic }, { timeout: 4_000 }),
      ).toBeTruthy();
    }
    expect(
      screen.getAllByRole("heading", { name: /^Semana del \d{2}-\d{2} al/ }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/Una idea no se publica sola/)).toBeTruthy();
    const card = screen.getByRole("listitem", { name: ideas[0]?.topic ?? "" });
    expect(within(card).getByText(/^Por qué:/)).toBeTruthy();
    expect(within(card).getByText(/LinkedIn · tema Producto/)).toBeTruthy();

    // Terminado el plan (y sin textos redactándose), la página deja de volver a mirar.
    const reads = () => s.requests.filter((request) => request === `GET /plans/${run?.id}`).length;
    const before = reads();
    await new Promise((done) => setTimeout(done, 2_500));
    expect(reads()).toBe(before);
  });

  it("aceptar una idea la pasa a borrador y encola sus textos; descartarla pide confirmación", async () => {
    const s = await setup();
    await s.planned(3);
    const [accepted, discarded] = await s.ideas();
    if (accepted === undefined || discarded === undefined) throw new Error("faltan ideas");
    s.signInAsBroker(s.brand.id);
    s.renderApp("/plan");

    const card = await screen.findByRole("listitem", { name: accepted.topic });
    fireEvent.click(within(card).getByRole("button", { name: "Aceptar" }));
    await waitFor(async () => expect((await s.deps.posts.get(accepted.id))?.status).toBe("draft"));
    expect(s.requests).toContain(`POST /posts/${accepted.id}/accept`);
    const run = await s.deps.contentRuns.findActive({ kind: "post", id: accepted.id });
    expect(run?.status).toBe("queued");
    const accepting = await screen.findByRole("listitem", { name: accepted.topic });
    expect(await within(accepting).findByText("La IA está redactando sus textos…")).toBeTruthy();
    expect(within(accepting).getByRole("link", { name: accepted.topic })).toBeTruthy();

    const other = screen.getByRole("listitem", { name: discarded.topic });
    fireEvent.click(within(other).getByRole("button", { name: "Descartar" }));
    expect(within(other).getByText(/No se vuelve a proponer en 60 días/)).toBeTruthy();
    fireEvent.click(within(other).getByRole("button", { name: "Sí, descartar" }));
    await waitFor(async () =>
      expect((await s.deps.posts.get(discarded.id))?.status).toBe("archived"),
    );
  });

  it("editar una idea: el brief, la fecha y las redes", async () => {
    const s = await setup();
    await s.planned(1);
    const [idea] = await s.ideas();
    if (idea === undefined) throw new Error("sin idea");
    s.signInAsBroker(s.brand.id);
    s.renderApp("/plan");
    const card = await screen.findByRole("listitem", { name: idea.topic });
    fireEvent.click(within(card).getByRole("button", { name: "Editar" }));
    const form = within(card).getByRole("form", { name: `Editar «${idea.topic}»` });
    fireEvent.change(within(form).getByLabelText(/^Brief/), {
      target: { value: "Lo que yo sé del tema" },
    });
    fireEvent.change(within(form).getByLabelText("Fecha y hora (Chile)"), {
      target: { value: "2026-11-05T10:00" },
    });
    for (const box of within(form).getAllByRole("checkbox")) {
      if ((box as HTMLInputElement).checked) fireEvent.click(box);
    }
    fireEvent.click(within(form).getByRole("checkbox", { name: "X" }));
    fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));
    await waitFor(async () =>
      expect(await s.deps.posts.get(idea.id)).toMatchObject({
        status: "idea",
        brief: "Lo que yo sé del tema",
        briefOrigin: "operator",
        plannedAt: new Date("2026-11-05T13:00:00Z"),
        platforms: ["x"],
      }),
    );
  });

  it("«Redactar lo aceptado» pide los textos de las ideas aceptadas que quedaron sin ellos", async () => {
    const s = await setup();
    await s.planned(2);
    const [first, second] = await s.ideas();
    if (first === undefined || second === undefined) throw new Error("faltan ideas");
    // Aceptadas, pero sus textos no se pidieron (la cola no estaba al aceptar).
    for (const idea of [first, second]) {
      await s.deps.posts.update(idea.id, { status: "draft" });
    }
    s.renderApp("/plan");
    // El administrador elige la marca en el selector.
    expect(
      await screen.findByText("Elige una marca en el selector de arriba para pedir o ver su plan."),
    ).toBeTruthy();
    cleanup();
    sessionStorage.setItem(BROKER_SCOPE_STORAGE_KEY, "agentpey");
    s.renderApp("/plan");
    expect(await screen.findByText("2 ideas aceptadas quedaron sin textos.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Redactar lo aceptado" }));
    await waitFor(async () => {
      for (const idea of [first, second]) {
        expect(await s.deps.contentRuns.findActive({ kind: "post", id: idea.id })).not.toBeNull();
      }
    });
    expect(s.requests).toContain(`POST /posts/${first.id}/draft`);
    expect(s.requests).toContain(`GET /plans?brokerId=${s.brand.id}`);
    await waitFor(() => expect(screen.queryByText(/quedaron sin textos/)).toBeNull());
  });

  it("un plan que falla muestra el motivo y qué hacer (el tope de IA)", async () => {
    const s = await setup();
    const { run } = await requestPlanRun(
      s.deps,
      { id: "admin", role: "admin", brokerId: null },
      { brokerId: s.brand.id },
    );
    await s.deps.planRuns.markRunning(run.id);
    await s.deps.planRuns.markFailed(run.id, {
      code: "LLM_BUDGET_EXCEEDED",
      message: "La marca llegó a su tope de IA del mes",
    });
    s.signInAsBroker(s.brand.id);
    s.renderApp("/plan");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("El plan falló: La marca llegó a su tope de IA del mes");
    expect(alert.textContent).toContain("agentsales usage");
  });
});

describe("panel: las redes de un post (F9-T21)", () => {
  /** Un post de la marca con un texto por red, ya redactado (la corrida terminada). */
  const postWithTexts = async (
    s: Awaited<ReturnType<typeof setup>>,
    topic: string,
    platforms: ("discord" | "x")[],
    own: ("discord" | "x")[] | null = null,
  ) => {
    const post = await s.deps.posts.create({
      brokerId: s.brand.id,
      topic,
      kind: "text",
      status: "draft",
      platforms: own,
    });
    const { run } = await requestContentRun(s.deps, { postId: post.id });
    await s.contentRuns.markRunning(run.id);
    await s.contentRuns.markSucceeded(run.id, {
      report: { warnings: [] },
      contents: platforms.map((platform) => ({
        platform,
        language: "es" as const,
        title: null,
        body: `Texto para ${platform}`,
        hashtags: [],
        llmProvider: "fake" as const,
        llmModel: "fake",
        promptVersion: "social-post-v2",
        rawOutput: null,
      })),
    });
    return post;
  };

  it("una red quitada con su texto aprobado: no se ofrece publicarla y se dice por qué", async () => {
    const s = await setup();
    await s.platformAccounts.upsertConnected({
      brokerId: s.brand.id,
      platform: "discord",
      externalAccountId: "canal-1",
      displayName: "#anuncios",
      tokenExpiresAt: null,
      meta: {},
      credentials: { webhookUrl: "https://discord.com/api/webhooks/123456/token-de-prueba" },
    });
    const post = await postWithTexts(s, "Un post sin Discord", ["discord", "x"]);
    // Discord aprobado antes de quitarle la red al post (datos de antes de la regla).
    await s.client.posts[":id"].contents[":platform"][":language"].approve.$post({
      param: { id: post.id, platform: "discord", language: "es" },
    });
    await s.deps.posts.update(post.id, { platforms: ["x"] });
    s.renderApp(`/contenido/${post.id}`);
    expect(
      await screen.findByText(/Los textos aprobados son de redes que ya no están en el post/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Publicar en Discord/ })).toBeNull();
    // La pestaña de X, una red del post, sí se aprueba.
    fireEvent.click(screen.getByRole("tab", { name: /^X · español/ }));
    const approve = screen.getByRole("button", { name: "Aprobar" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
  });

  it("aprobar el texto de una red quitada está desactivado, con el motivo", async () => {
    const s = await setup();
    const post = await postWithTexts(s, "Solo X", ["discord"], ["x"]);
    s.renderApp(`/contenido/${post.id}`);
    const approve = (await screen.findByRole("button", { name: "Aprobar" })) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(
      screen.getByText(
        /Discord ya no está entre las redes del post: agrégala con «Editar el post»/,
      ),
    ).toBeTruthy();
  });

  it("el detalle dice qué texto falta de una red agregada y cuál ya no corresponde", async () => {
    const s = await setup();
    const post = await s.deps.posts.create({
      brokerId: s.brand.id,
      topic: "Un post con redes",
      kind: "text",
      status: "draft",
      platforms: ["discord"],
    });
    const { run } = await requestContentRun(s.deps, { postId: post.id });
    await s.contentRuns.markRunning(run.id);
    await s.contentRuns.markSucceeded(run.id, {
      report: { warnings: [] },
      contents: [
        {
          platform: "discord",
          language: "es",
          title: null,
          body: "Texto para Discord",
          hashtags: [],
          llmProvider: "fake",
          llmModel: "fake",
          promptVersion: "social-post-v2",
          rawOutput: null,
        },
      ],
    });
    // El operador le cambia las redes: quita Discord y agrega X.
    await s.deps.posts.update(post.id, { platforms: ["x"] });
    s.renderApp(`/contenido/${post.id}`);
    expect(await screen.findByText(/redes: X/)).toBeTruthy();
    expect(screen.getByText(/Falta el texto de X/)).toBeTruthy();
    expect(screen.getByText(/Los textos de Discord no se publican ni se programan/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Redactar los textos de nuevo" }));
    await waitFor(async () =>
      expect(await s.deps.contentRuns.findActive({ kind: "post", id: post.id })).not.toBeNull(),
    );
  });

  it("quitar una red con una publicación pendiente se rechaza con qué hacer", async () => {
    const s = await setup();
    await s.platformAccounts.upsertConnected({
      brokerId: s.brand.id,
      platform: "discord",
      externalAccountId: "canal-1",
      displayName: "#anuncios",
      tokenExpiresAt: null,
      meta: {},
      credentials: { webhookUrl: "https://discord.com/api/webhooks/123456/token-de-prueba" },
    });
    const post = await s.deps.posts.create({
      brokerId: s.brand.id,
      topic: "Un post aprobado",
      kind: "text",
      status: "draft",
    });
    const { run } = await requestContentRun(s.deps, { postId: post.id });
    await s.contentRuns.markRunning(run.id);
    await s.contentRuns.markSucceeded(run.id, {
      report: { warnings: [] },
      contents: [
        {
          platform: "discord",
          language: "es",
          title: null,
          body: "Texto para Discord",
          hashtags: [],
          llmProvider: "fake",
          llmModel: "fake",
          promptVersion: "social-post-v2",
          rawOutput: null,
        },
      ],
    });
    const [content] = await s.contents.listCurrent({ kind: "post", id: post.id });
    s.renderApp(`/contenido/${post.id}`);
    await screen.findByRole("heading", { name: "Un post aprobado" });
    await s.client.posts[":id"].contents[":platform"][":language"].approve.$post({
      param: { id: post.id, platform: "discord", language: content?.language ?? "es" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Editar el post" }));
    const form = screen.getByRole("form", { name: "Editar el post" });
    // Solo las redes de la marca (Discord por su cuenta; X y LinkedIn por su cadencia).
    await waitFor(() =>
      expect(
        within(form)
          .getAllByRole("checkbox")
          .map((box) => box.parentElement?.textContent),
      ).toEqual(["X", "LinkedIn", "Discord"]),
    );
    fireEvent.click(within(form).getByRole("checkbox", { name: "X" }));
    fireEvent.click(within(form).getByRole("button", { name: "Guardar" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toContain("Discord");
    expect(alert.textContent).toContain("Cancélalas en Publicaciones");
    expect((await s.deps.posts.get(post.id))?.platforms).toBeNull();
  });
});
