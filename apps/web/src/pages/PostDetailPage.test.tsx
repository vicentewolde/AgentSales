// @vitest-environment jsdom
import type { Language, Platform, PublicationStatus } from "@agentsales/core";
import { chileInputValue, formatChileTime, requestContentRun } from "@agentsales/core";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness } from "../../test/harness.js";
import { BROKER_SCOPE_STORAGE_KEY } from "../scope/broker-scope.js";

// F9-T17 (spec F9 §4.10): el detalle de un post en el panel, contra la API real en proceso: los
// textos por red e idioma (editar con el conteo de la red, aprobar), los medios con avance, pedir
// los textos a la IA, publicar una red, programar, y resolver una publicación dudosa o confirmar
// una que se publica a mano.

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

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
        promptVersion: "social-post-v2",
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
    expect(await screen.findByText("Textos pedidos: en cola…")).toBeTruthy();
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

  it("la vista previa de la red: la cuenta, el texto como se envía, y sigue al borrador antes de guardar (F9.5-T07)", async () => {
    const s = await setup();
    await s.draft([{ platform: "discord", language: "es", body: "Lo de esta semana" }]);
    await s.open();
    const preview = () => screen.getByRole("figure", { name: "Vista previa de Discord · español" });
    // El nombre del webhook conectado de la marca.
    await waitFor(() => expect(within(preview()).getByText("#anuncios")).toBeTruthy());
    expect(within(preview()).getByText("Lo de esta semana")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    const form = screen.getByRole("form", { name: "Editar el texto de Discord · español" });
    fireEvent.change(within(form).getByLabelText("Texto"), {
      target: { value: "Lo nuevo de la semana" },
    });
    fireEvent.change(within(form).getByLabelText("Hashtags"), { target: { value: "#equipo" } });
    expect(within(preview()).getByText("Lo nuevo de la semana")).toBeTruthy();
    // Discord no lleva hashtags: no se envían.
    expect(preview().textContent).not.toContain("#equipo");
    expect(preview().textContent).toContain("con tu borrador, sin guardar");
    expect(s.requests.filter((request) => request.startsWith("PATCH"))).toEqual([]);

    fireEvent.click(within(form).getByRole("button", { name: "Cancelar" }));
    expect(within(preview()).getByText("Lo de esta semana")).toBeTruthy();
    expect(preview().textContent).not.toContain("sin guardar");
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
    // F9.5-T02: ya no queda nada por publicar, así que no hay botón Publicar (ni Programar).
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Publicar en Discord/ })).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "Programar…" })).toBeNull();
    expect(
      screen.getByText(/Todo lo aprobado ya salió, está saliendo o está programado/),
    ).toBeTruthy();
  });

  it("sin cuenta en la red aprobada no ofrece publicar ni programar: dice el motivo y enlaza a Cuentas", async () => {
    const s = await setup();
    await s.draft([{ platform: "linkedin", language: "es" }]);
    await s.client.posts[":id"].contents[":platform"][":language"].approve.$post({
      param: { id: s.post.id, platform: "linkedin", language: "es" },
    });
    await s.open();
    const section = screen.getByRole("region", { name: "Publicar" });
    const publish = await within(section).findByRole("button", {
      name: "Publicar en LinkedIn (simulación)",
    });
    await waitFor(() => expect(publish).toHaveProperty("disabled", true));
    expect(publish.getAttribute("title")).toBe("Sin cuenta conectada en LinkedIn");
    expect(within(section).getByRole("button", { name: "Programar…" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      within(section).getByText(/Sin cuenta conectada en LinkedIn: conéctala en/),
    ).toBeTruthy();
    expect(within(section).getByRole("link", { name: "Cuentas" }).getAttribute("href")).toBe(
      "/cuentas",
    );
    fireEvent.click(publish);
    expect(s.requests).not.toContain(`POST /posts/${s.post.id}/publish`);
  });

  it("un administrador con otro corredor en el selector ve activas las redes de la marca del post", async () => {
    // F9.5-T12: las cuentas se piden con el alcance de la sesión, no con el corredor del selector,
    // y se eligen las de la marca del post (`accountOwnedBy`).
    const s = await setup();
    await s.brokers.create(brokerData("otro"));
    sessionStorage.setItem(BROKER_SCOPE_STORAGE_KEY, "otro");
    await s.draft([
      { platform: "discord", language: "es" },
      { platform: "linkedin", language: "es" },
    ]);
    for (const platform of ["discord", "linkedin"] as const) {
      await s.client.posts[":id"].contents[":platform"][":language"].approve.$post({
        param: { id: s.post.id, platform, language: "es" },
      });
    }
    await s.open();
    const section = screen.getByRole("region", { name: "Publicar" });
    const discord = await within(section).findByRole("button", {
      name: "Publicar en Discord (simulación)",
    });
    const linkedin = within(section).getByRole("button", {
      name: "Publicar en LinkedIn (simulación)",
    });
    // LinkedIn (la marca no tiene cuenta) queda desactivado: las cuentas ya cargaron.
    await waitFor(() => expect(linkedin).toHaveProperty("disabled", true));
    await waitFor(() => expect(s.requests).toContain("GET /brokers"));
    expect(discord).toHaveProperty("disabled", false);
    expect(within(section).queryByText(/Sin cuenta conectada en Discord/)).toBeNull();
    expect(s.requests).toContain("GET /accounts");
    expect(s.requests.filter((request) => request.startsWith("GET /accounts?"))).toEqual([]);
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

  it("LinkedIn a mano: «Copiar texto y abrir LinkedIn» sale solo cuando espera la confirmación (F9.5-T27)", async () => {
    const s = await setup();
    await s.platformAccounts.upsertConnected({
      brokerId: s.brand.id,
      platform: "linkedin",
      externalAccountId: "perfil-1",
      displayName: "Vinny",
      tokenExpiresAt: null,
      meta: { mode: "manual" },
      credentials: { accessToken: "token-de-prueba" },
    });
    await s.draft([{ platform: "linkedin", language: "es", body: "Texto para LinkedIn" }]);
    await s.client.posts[":id"].contents[":platform"][":language"].approve.$post({
      param: { id: s.post.id, platform: "linkedin", language: "es" },
    });
    const [publication] = await s.deps.publications.listBySubject({ kind: "post", id: s.post.id });
    if (publication === undefined) throw new Error("sin publicación");
    // Aprobada: todavía no hay nada que copiar.
    await s.open();
    const list = screen.getByRole("region", { name: "Publicaciones" });
    expect(within(list).queryByRole("region", { name: "Publicar en LinkedIn a mano" })).toBeNull();
    cleanup();

    await s.deps.postLock.run(s.post.id, async ({ publications }) => {
      await publications.transition(
        publication.id,
        { from: "approved", to: "publishing", changes: { dryRun: true } },
        { actor: "system" },
      );
      await publications.transition(
        publication.id,
        { from: "publishing", to: "awaiting_manual_confirm" },
        { actor: "system" },
      );
    });
    s.queryClient.clear();
    await s.open();
    const waiting = screen.getByRole("region", { name: "Publicaciones" });
    const assist = await within(waiting).findByRole("region", {
      name: "Publicar en LinkedIn a mano",
    });
    expect(
      within(assist)
        .getByRole("link", { name: "Copiar texto y abrir LinkedIn" })
        .getAttribute("href"),
    ).toBe(
      `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent("Texto para LinkedIn")}`,
    );
    // El enlace es opcional: «Ya lo publiqué» confirma sin pedirlo.
    expect(within(waiting).getByLabelText(/Enlace de la publicación \(opcional\)/)).toBeTruthy();
    expect(within(waiting).getByRole("button", { name: "Ya lo publiqué" })).toBeTruthy();
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

  it("un archivo grande que el worker revisa se avisa (también al recargar) y el aviso se va al terminar", async () => {
    const s = await setup();
    const id = "cccccccc-0000-4000-8000-000000000001";
    await s.deps.postLock.run(s.post.id, async ({ postUploads }) => {
      await postUploads.create({
        id,
        postId: s.post.id,
        objectPath: `posts/${s.post.id}/original/${id}.mp4`,
        expectedBytes: 200 * 1024 * 1024,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      await postUploads.markUploaded(id);
    });
    await s.open();
    const region = screen.getByRole("region", { name: "Medios" });
    expect(within(region).getByText(/Un archivo grande se está revisando/)).toBeTruthy();
    // El worker lo resolvió (un duplicado, por ejemplo): el próximo sondeo apaga el aviso.
    await s.deps.postLock.run(s.post.id, ({ postUploads }) => postUploads.markCompleted(id));
    await waitFor(
      () => expect(within(region).queryByText(/Un archivo grande se está revisando/)).toBeNull(),
      { timeout: 4_500 },
    );
  });

  it("«Permitir un enlace en X» avisa el costo, manda el PATCH y deja aprobar el texto con enlace (F9-T16)", async () => {
    const s = await setup();
    const link = "https://agentpey.com/guia";
    // El enlace está en el brief del operador; falta la marca del post.
    await s.client.posts[":id"].$patch({
      param: { id: s.post.id },
      json: { brief: `La guía está en ${link}` },
    });
    await s.draft([{ platform: "x", language: "es", body: `Texto en es para x: ${link}` }]);
    await s.open();
    const control = screen.getByRole("group", { name: "Enlace en X" });
    const box = within(control).getByRole("checkbox", { name: "Permitir un enlace en X" });
    expect(box).toHaveProperty("checked", false);
    expect(
      within(control).getByText(
        /^No permitido\. En X, un post con enlace cuesta US\$0,20 en vez de US\$0,015/,
      ),
    ).toBeTruthy();
    expect(
      within(control).getByText(/El texto de X en español lleva un enlace y el post no lo permite/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Aprobar" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Lleva un enlace y el post no lo permite en X: marca/)).toBeTruthy();

    fireEvent.click(box);
    await waitFor(() => expect(s.requests).toContain(`PATCH /posts/${s.post.id}`));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Aprobar" }).hasAttribute("disabled")).toBe(false),
    );
    expect((await s.deps.posts.get(s.post.id))?.xLinkAllowed).toBe(true);
    expect(within(control).getByText(/^Permitido\./)).toBeTruthy();
    expect(within(control).queryByText(/lleva un enlace y el post no lo permite/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Aprobar" }));
    await waitFor(() =>
      expect(s.requests).toContain(`POST /posts/${s.post.id}/contents/x/es/approve`),
    );
    expect(await screen.findByText(/^Texto: aprobado/)).toBeTruthy();
  });

  it("quitar la marca del enlace en X manda el PATCH con false", async () => {
    const s = await setup();
    await s.deps.posts.update(s.post.id, { xLinkAllowed: true, platforms: ["x"] });
    await s.open();
    // Un post de X sin textos todavía: el control se ve igual.
    const box = await screen.findByRole("checkbox", { name: "Permitir un enlace en X" });
    expect(box).toHaveProperty("checked", true);
    fireEvent.click(box);
    await waitFor(async () =>
      expect((await s.deps.posts.get(s.post.id))?.xLinkAllowed).toBe(false),
    );
    expect(s.requests).toContain(`PATCH /posts/${s.post.id}`);
  });

  it("la música del reel (F9.5-T19): solo con un video; elegirla manda el PATCH y encola post.media", async () => {
    const plain = await setup();
    await plain.open();
    await screen.findByRole("region", { name: "Textos" });
    // Sin video, no se ofrece.
    expect(screen.queryByRole("combobox", { name: "Música del reel" })).toBeNull();
    cleanup();

    const s = await setup();
    await s.deps.posts.update(s.post.id, { kind: "video" });
    await s.media.create({
      listingId: null,
      postId: s.post.id,
      brokerId: s.brand.id,
      kind: "video",
      storagePath: `posts/${s.post.id}/original/${"a".repeat(64)}.mp4`,
      mime: "video/mp4",
      bytes: 1000,
      checksum: "a".repeat(64),
      sortOrder: 0,
      isCover: false,
    });
    await s.open();
    const select = (await screen.findByRole("combobox", {
      name: "Música del reel",
    })) as HTMLSelectElement;
    await screen.findByRole("option", { name: /Up in the Sky · Moderna/ });
    fireEvent.change(select, { target: { value: "up-in-the-sky" } });
    await waitFor(async () =>
      expect((await s.deps.posts.get(s.post.id))?.musicTrackId).toBe("up-in-the-sky"),
    );
    expect(screen.getByText(/los videos del post se rehacen solos/)).toBeTruthy();
    expect(s.requests).toContain(`PATCH /posts/${s.post.id}`);
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

describe("panel: un post sin imágenes (F9.5-T21)", () => {
  it("la pestaña dice «pendiente» y no «!» cuando solo faltan las imágenes, y el texto se aprueba", async () => {
    const s = await setup();
    await s.deps.posts.update(s.post.id, { kind: "image" });
    await s.draft();
    await s.open();
    const tab = screen.getByRole("tab", { name: /^Discord · español/ });
    expect(within(tab).getByText("pendiente")).toBeTruthy();
    expect(tab.textContent).not.toContain("!");
    // El motivo, al pasar el cursor y debajo de las pestañas.
    expect(tab.getAttribute("title")).toMatch(/^Discord · español: Falta la imagen: /);
    const problems = screen.getByRole("list", { name: "Qué falta o qué corregir" });
    expect(
      within(problems).getByText(/^Pendiente · Discord · español: Falta la imagen: /),
    ).toBeTruthy();

    const approve = screen.getByRole("button", { name: "Aprobar" });
    expect(approve.hasAttribute("disabled")).toBe(false);
    fireEvent.click(approve);
    await waitFor(() =>
      expect(s.requests).toContain(`POST /posts/${s.post.id}/contents/discord/es/approve`),
    );
    expect(await screen.findByRole("button", { name: "Quitar la aprobación" })).toBeTruthy();
  });

  /** Un carrusel de X en español e inglés con tarjetas por pedido (cada pedido, de un idioma). */
  async function withCards(languages: { es?: number; en?: number }) {
    const s = await setup();
    await s.deps.posts.update(s.post.id, { kind: "carousel" });
    await s.draft([
      { platform: "x", language: "es", body: "Hola" },
      { platform: "x", language: "en", body: "Hello" },
    ]);
    const cardMedia = (name: string, sortOrder: number) =>
      s.deps.media.create({
        listingId: null,
        postId: s.post.id,
        brokerId: s.brand.id,
        kind: "image",
        storagePath: `posts/${s.post.id}/original/${name}.jpg`,
        mime: "image/jpeg",
        bytes: 10,
        checksum: name.padEnd(64, "0"),
        sortOrder,
        isCover: false,
      });
    const shared = await cardMedia("cierre", 0);
    let order = 1;
    for (const language of ["es", "en"] as const) {
      const count = languages[language];
      if (count === undefined) continue;
      const own = [];
      for (let index = 0; index < count; index += 1) {
        own.push((await cardMedia(`${language}-${index}`, order++)).id);
      }
      const run = await s.deps.postImageRuns.create({
        postId: s.post.id,
        brokerId: s.brand.id,
        source: "card",
        request: { source: "card", format: "4:5", language },
        createdBy: null,
      });
      await s.deps.postImageRuns.markRunning(run.id);
      await s.deps.postImageRuns.markSucceeded(run.id, [...own, shared.id]);
    }
    return s;
  }

  it("las tarjetas de cada idioma: la revisión de cada texto cuenta las suyas, no las de los dos", async () => {
    // 3 + 3 tarjetas y el cierre compartido: 7 en el post, pero 4 por texto (X admite hasta 4).
    const s = await withCards({ es: 3, en: 3 });
    await s.open();
    expect(screen.queryByRole("list", { name: "Qué falta o qué corregir" })).toBeNull();
    for (const name of [/^X · español/, /^X · inglés/]) {
      expect(screen.getByRole("tab", { name }).textContent).not.toContain("!");
    }
    expect(screen.queryByText(/Este texto está en/u)).toBeNull();
  });

  it("un texto sin tarjetas de su idioma lo dice, con qué hacer", async () => {
    const s = await withCards({ es: 2 });
    await s.open();
    // El español tiene las suyas: sin aviso.
    expect(screen.queryByText(/Este texto está en español, pero/u)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /^X · inglés/ }));
    expect(
      await screen.findByText(
        "Este texto está en inglés, pero las tarjetas del post están en español: en «Conseguir imagen» haz las tarjetas en inglés.",
      ),
    ).toBeTruthy();
  });

  it("aprobado el texto, publicar y programar esperan las imágenes: el aviso lleva a subirlas", async () => {
    const s = await setup();
    await s.deps.posts.update(s.post.id, { kind: "image" });
    await s.draft();
    await s.client.posts[":id"].contents[":platform"][":language"].approve.$post({
      param: { id: s.post.id, platform: "discord", language: "es" },
    });
    await s.open();
    const section = screen.getByRole("region", { name: "Publicar" });
    const publish = await within(section).findByRole("button", {
      name: "Publicar en Discord (simulación)",
    });
    await waitFor(() => expect(publish).toHaveProperty("disabled", true));
    expect(publish.getAttribute("title")).toMatch(/^Falta la imagen: /);
    expect(within(section).getByRole("button", { name: "Programar…" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(within(section).getByText(/Falta la imagen: .*Súbela o consíguela/)).toBeTruthy();
    const link = within(section).getByRole("link", { name: "Subir imágenes" });
    expect(link.getAttribute("href")).toBe("#medios-del-post");
    expect(document.getElementById("medios-del-post")).toBeTruthy();
    fireEvent.click(publish);
    expect(s.requests).not.toContain(`POST /posts/${s.post.id}/publish`);
  });

  it("un error de verdad sigue con «!» y el motivo en la pestaña y debajo del texto", async () => {
    const s = await setup();
    await s.draft([{ platform: "discord", language: "es", body: "a".repeat(2100) }]);
    await s.open();
    const tab = screen.getByRole("tab", { name: /^Discord · español/ });
    expect(tab.textContent).toContain("!");
    expect(within(tab).queryByText("pendiente")).toBeNull();
    expect(tab.getAttribute("title")).toMatch(/^Discord · español: El texto tiene 2100 caracteres/);
    const problems = screen.getByRole("list", { name: "Qué falta o qué corregir" });
    expect(
      within(problems).getByText(/^Error · Discord · español: El texto tiene 2100/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Aprobar" }).hasAttribute("disabled")).toBe(true);
  });
});

// LinkedIn a mano al mínimo trabajo (F9.5): el editor con el texto puesto, los medios para bajar,
// «Ya lo publiqué» sin pedir el enlace y la fila «LinkedIn: publica a mano» en «Hoy».
describe("LinkedIn a mano al mínimo trabajo (F9.5)", () => {
  /** Un texto aprobado de LinkedIn y su publicación esperando la confirmación (en vivo o no). */
  async function linkedinWaiting(
    s: Awaited<ReturnType<typeof setup>>,
    dryRun: boolean,
    { photos = 0 }: { photos?: number } = {},
  ) {
    // Un post de imagen con sus fotos ya procesadas (`ig_4x5`), como las dejaría el worker.
    if (photos > 0)
      await s.deps.posts.update(s.post.id, { kind: photos > 1 ? "carousel" : "image" });
    for (let index = 0; index < photos; index += 1) {
      const original = await s.media.create({
        listingId: null,
        postId: s.post.id,
        brokerId: s.brand.id,
        kind: "image",
        storagePath: `posts/${s.post.id}/original/foto-${index}.jpg`,
        mime: "image/jpeg",
        bytes: 10,
        checksum: `sha-foto-${index}`,
        sortOrder: index,
        isCover: false,
      });
      await s.media.upsertDerivative({
        role: "processed",
        variant: "ig_4x5",
        parentMediaId: original.id,
        postId: s.post.id,
        brokerId: s.brand.id,
        kind: "image",
        storagePath: `posts/${s.post.id}/ig_4x5/foto-${index}.jpg`,
        mime: "image/jpeg",
        bytes: 8,
        checksum: `sha-foto-${index}-4x5`,
        width: 1080,
        height: 1350,
        durationS: null,
      });
    }
    await s.platformAccounts.upsertConnected({
      brokerId: s.brand.id,
      platform: "linkedin",
      externalAccountId: "perfil-1",
      displayName: "Vinny",
      tokenExpiresAt: null,
      meta: { mode: "manual" },
      credentials: { accessToken: "token-de-prueba" },
    });
    await s.draft([{ platform: "linkedin", language: "es", body: "Texto para LinkedIn" }]);
    await s.client.posts[":id"].contents[":platform"][":language"].approve.$post({
      param: { id: s.post.id, platform: "linkedin", language: "es" },
    });
    const [publication] = await s.deps.publications.listBySubject({ kind: "post", id: s.post.id });
    if (publication === undefined) throw new Error("sin publicación");
    await s.deps.postLock.run(s.post.id, async ({ publications }) => {
      await publications.transition(
        publication.id,
        { from: "approved", to: "publishing", changes: { dryRun } },
        { actor: "system" },
      );
      await publications.transition(
        publication.id,
        { from: "publishing", to: "awaiting_manual_confirm" },
        { actor: "system" },
      );
    });
    return publication;
  }

  it("«Ya lo publiqué» sin enlace confirma en vivo y queda «Confirmada a mano, sin enlace»", async () => {
    const s = await setup();
    const publication = await linkedinWaiting(s, false);
    await s.open();
    const list = screen.getByRole("region", { name: "Publicaciones" });
    fireEvent.click(await within(list).findByRole("button", { name: "Ya lo publiqué" }));
    await waitFor(() =>
      expect(s.requests).toContain(`POST /publications/${publication.id}/confirm`),
    );
    expect(await within(list).findByText("publicada")).toBeTruthy();
    expect(within(list).getByText(/Confirmada a mano, sin enlace/)).toBeTruthy();
    expect(within(list).queryByRole("link", { name: /Ver en LinkedIn/ })).toBeNull();
    const confirmed = await s.deps.publications.get(publication.id);
    expect(confirmed).toMatchObject({
      status: "published",
      externalUrl: null,
      externalId: null,
    });
  });

  it("con fotos: los medios de la publicación pendiente se firman y se ofrecen para bajar; ya publicada, no", async () => {
    const s = await setup();
    const publication = await linkedinWaiting(s, true, { photos: 2 });
    await s.open();
    const list = screen.getByRole("region", { name: "Publicaciones" });
    const group = await within(list).findByRole("group", { name: "Descargar imágenes" });
    const images = within(group).getAllByRole("img");
    expect(images).toHaveLength(2);
    // La foto procesada que se enviaría, firmada por la API (no una miniatura ni el original).
    expect(images[0]?.getAttribute("src")).toContain(`posts/${s.post.id}/ig_4x5/foto-0.jpg`);
    expect(within(group).getByRole("link", { name: "Descargar imagen 2" })).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "Ya lo publiqué" }));
    await waitFor(() =>
      expect(s.requests).toContain(`POST /publications/${publication.id}/confirm`),
    );
    expect(await within(list).findByText("publicada")).toBeTruthy();
    expect(within(list).queryByRole("group", { name: "Descargar imágenes" })).toBeNull();
  });

  it("con el enlace pegado se guarda el enlace, no «sin enlace»", async () => {
    const s = await setup();
    const publication = await linkedinWaiting(s, false);
    await s.open();
    const list = screen.getByRole("region", { name: "Publicaciones" });
    fireEvent.change(await within(list).findByLabelText(/Enlace de la publicación/), {
      target: { value: "https://www.linkedin.com/feed/update/urn:li:share:7380000000000000000/" },
    });
    fireEvent.click(within(list).getByRole("button", { name: "Ya lo publiqué" }));
    expect(await within(list).findByRole("link", { name: /Ver en LinkedIn/ })).toBeTruthy();
    expect(within(list).queryByText(/Confirmada a mano, sin enlace/)).toBeNull();
    expect((await s.deps.publications.get(publication.id))?.externalId).toBe(
      "urn:li:share:7380000000000000000",
    );
  });

  it("en «Hoy»: la fila «LinkedIn: publica a mano» con el botón de un clic y «Ya lo publiqué», sin entrar al post", async () => {
    const s = await setup();
    const publication = await linkedinWaiting(s, true);
    s.renderApp("/");
    const todo = await screen.findByRole("region", { name: "Te toca" });
    expect(
      await within(todo).findByText("LinkedIn: publica a mano", { selector: "span" }),
    ).toBeTruthy();
    const row = await within(todo).findByRole("region", { name: "LinkedIn: publica a mano" });
    // El modo de la publicación, a la vista.
    expect(within(row).getByText(/simulación/i)).toBeTruthy();
    const open = within(row).getByRole("link", { name: "Copiar texto y abrir LinkedIn" });
    expect(open.getAttribute("href")).toBe(
      `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent("Texto para LinkedIn")}`,
    );
    expect(open.getAttribute("target")).toBe("_blank");
    fireEvent.click(within(row).getByRole("button", { name: "Ya lo publiqué" }));
    await waitFor(() =>
      expect(s.requests).toContain(`POST /publications/${publication.id}/confirm`),
    );
    await waitFor(() =>
      expect(within(todo).queryByRole("region", { name: "LinkedIn: publica a mano" })).toBeNull(),
    );
    expect((await s.deps.publications.get(publication.id))?.status).toBe("published");
  });
});
