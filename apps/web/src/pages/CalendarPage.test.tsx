// @vitest-environment jsdom
import {
  chileDateOf,
  chileDateStart,
  chileInputValue,
  formatChileTime,
  listingSubject,
  type PublicationRepository,
  type PublishMode,
  postSubject,
  requestContentRun,
} from "@agentsales/core";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { brokerData, harness, newListing } from "../../test/harness.js";
import { dayLabel } from "../components/calendar/calendar.js";

// F9-T18: el calendario del panel contra la API real en proceso: posts y avisos juntos en hora de
// Chile, mover una fecha con el caso de uso de F6 (en vivo, con confirmación) y cada corredor con
// lo suyo.

afterEach(cleanup);

const HOUR = 60 * 60 * 1000;

/** Un post de una marca con su publicación de Discord y un aviso de un corredor con la de Instagram, aprobadas. */
async function setup(options: { publishMode?: PublishMode } = {}) {
  const h = harness({ deps: { publishMode: options.publishMode ?? "dry-run" } });

  const brand = await h.brokers.create(brokerData("vinny"), { kind: "brand" });
  const discord = await h.platformAccounts.upsertConnected({
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
  const { run: postRun } = await requestContentRun(h.deps, { postId: post.id });
  await h.contentRuns.markRunning(postRun.id);
  await h.contentRuns.markSucceeded(postRun.id, {
    report: { warnings: [] },
    contents: [
      {
        platform: "discord",
        language: "es",
        title: null,
        body: "Texto del post",
        hashtags: [],
        llmProvider: "fake",
        llmModel: "fake",
        promptVersion: "social-post-v1",
        rawOutput: null,
      },
    ],
  });
  const [postContent] = await h.contents.listCurrent(postSubject(post.id));
  // Aprobado, como lo deja el operador (reprogramar revisa lo mismo que publicar).
  await h.contents.update(postContent?.id ?? "", { status: "approved" });
  const postPublication = await h.deps.postLock.run(post.id, ({ publications }) =>
    publications.create(
      {
        postId: post.id,
        platformAccountId: discord.id,
        platform: "discord",
        format: "post",
        contentId: postContent?.id ?? "",
        mediaIds: [],
      },
      { actor: "system" },
    ),
  );

  const broker = await h.brokers.create(brokerData("corredor"));
  const instagram = await h.platformAccounts.upsertConnected({
    brokerId: broker.id,
    platform: "instagram",
    externalAccountId: "ig-1",
    displayName: "@corredor",
    tokenExpiresAt: new Date(Date.now() + 30 * 24 * HOUR),
    meta: {},
    credentials: { accessToken: "IGAA-prueba" },
  });
  const listing = await h.listings.create(newListing(broker.id, "P-001"));
  await h.listings.promoteToReady(listing.id);
  const listingRun = await h.contentRuns.create({ listingId: listing.id, texts: true });
  await h.contentRuns.markRunning(listingRun.id);
  await h.contentRuns.markSucceeded(listingRun.id, {
    report: { warnings: [] },
    contents: [
      {
        platform: "instagram",
        title: null,
        body: "Texto del aviso",
        hashtags: [],
        llmProvider: "fake",
        llmModel: "fake",
        promptVersion: "v1",
        rawOutput: null,
      },
    ],
  });
  const [listingContent] = await h.contents.listCurrent(listingSubject(listing.id));
  await h.contents.update(listingContent?.id ?? "", { status: "approved" });
  const listingPublication = await h.deps.lock.run(listing.id, ({ publications }) =>
    publications.create(
      {
        listingId: listing.id,
        platformAccountId: instagram.id,
        platform: "instagram",
        format: "post",
        contentId: listingContent?.id ?? "",
        mediaIds: [],
        listingSourceHash: "hash",
      },
      { actor: "system" },
    ),
  );

  /** La deja programada a esa hora (como si la hubiera programado otro). */
  const schedule = (kind: "post" | "listing", at: Date, dryRun = true) => {
    const id = kind === "post" ? postPublication.id : listingPublication.id;
    const transition = ({
      publications,
    }: {
      publications: Pick<PublicationRepository, "transition">;
    }) =>
      publications.transition(
        id,
        { from: "approved", to: "scheduled", changes: { dryRun, scheduledAt: at } },
        { actor: "operator" },
      );
    return kind === "post"
      ? h.deps.postLock.run(post.id, transition)
      : h.deps.lock.run(listing.id, transition);
  };
  const current = (id: string) => h.deps.publications.get(id);
  /** Abre la semana (o el mes) del día y devuelve la celda del día. */
  const openDay = async (day: string, view: "semana" | "mes" = "semana") => {
    h.renderApp(`/calendario?vista=${view}&dia=${day}`);
    return screen.findByRole("listitem", { name: dayLabel(day) });
  };
  return {
    ...h,
    brand,
    post,
    broker,
    listing,
    postPublication,
    listingPublication,
    schedule,
    current,
    openDay,
  };
}

/** La entrada de una publicación en su día (por su hora, su red y su título). */
const entryIn = (day: HTMLElement, at: Date, platform: string, title: string) =>
  within(day).findByRole("listitem", {
    name: `${formatChileTime(at).slice(11)} ${platform} ${title}`,
  });

describe("panel: calendario", () => {
  it("muestra posts y avisos programados en su día y hora de Chile, con enlace a su página", async () => {
    const s = await setup();
    const at = new Date(Date.now() + 3 * HOUR);
    await s.schedule("post", at);
    await s.schedule("listing", at);

    const day = await s.openDay(chileDateOf(at));

    const post = await entryIn(day, at, "Discord", "Lo que aprendí esta semana");
    expect(within(post).getByRole("link").getAttribute("href")).toBe(`/contenido/${s.post.id}`);
    expect(post.textContent).toContain("programada");
    expect(post.textContent).toContain("simulación");
    const listing = await entryIn(day, at, "Instagram", "P-001");
    expect(within(listing).getByRole("link").getAttribute("href")).toBe(
      `/propiedades/${s.listing.id}`,
    );
    // El administrador mirando "Todos" ve de quién es cada una.
    expect(post.textContent).toContain("vinny");
    expect(listing.textContent).toContain("corredor");
    expect(screen.getByRole("link", { name: "Calendario" })).toBeTruthy();
    // Lo que llegó a su hora y quedó a medio camino se resuelve en Seguimiento.
    const note = screen.getByText(/Lo que falló, espera tu confirmación/);
    expect(within(note).getByRole("link", { name: "Seguimiento" }).getAttribute("href")).toBe(
      "/seguimiento",
    );
  });

  it("mover la fecha reprograma con POST /publications/:id/schedule y la muestra en su nuevo día", async () => {
    const s = await setup();
    const at = new Date(Date.now() + 3 * HOUR);
    await s.schedule("listing", at);
    const day = await s.openDay(chileDateOf(at), "mes");
    const entry = await entryIn(day, at, "Instagram", "P-001");

    fireEvent.click(within(entry).getByRole("button", { name: "Mover" }));
    const panel = screen.getByRole("region", { name: "Mover la fecha" });
    expect(panel.textContent).toContain(formatChileTime(at));
    expect(within(panel).getByText(/Se programa en simulación/)).toBeTruthy();
    const to = new Date(Math.floor((at.getTime() + 26 * HOUR) / 60_000) * 60_000);
    fireEvent.change(within(panel).getByLabelText("Fecha y hora (Chile)"), {
      target: { value: chileInputValue(to) },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Mover" }));

    await waitFor(() =>
      expect(s.requests).toContain(`POST /publications/${s.listingPublication.id}/schedule`),
    );
    expect(
      await screen.findByText(`Quedó programada para el ${formatChileTime(to)} (hora de Chile).`),
    ).toBeTruthy();
    expect(await s.current(s.listingPublication.id)).toMatchObject({
      status: "scheduled",
      scheduledAt: to,
      dryRun: true,
    });
    cleanup();
    expect(await entryIn(await s.openDay(chileDateOf(to)), to, "Instagram", "P-001")).toBeTruthy();
  });

  it("en vivo pide confirmar antes de mover, y queda en vivo", async () => {
    const s = await setup({ publishMode: "live" });
    const at = new Date(Date.now() + 3 * HOUR);
    await s.schedule("post", at, false);
    const day = await s.openDay(chileDateOf(at));
    const entry = await entryIn(day, at, "Discord", "Lo que aprendí esta semana");
    expect(entry.textContent).toContain("en vivo");

    fireEvent.click(within(entry).getByRole("button", { name: "Mover" }));
    const panel = screen.getByRole("region", { name: "Mover la fecha" });
    const to = new Date(Math.floor((at.getTime() + 2 * HOUR) / 60_000) * 60_000);
    fireEvent.change(within(panel).getByLabelText("Fecha y hora (Chile)"), {
      target: { value: chileInputValue(to) },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Mover" }));

    fireEvent.click(await within(panel).findByRole("button", { name: "Sí, programar en vivo" }));
    await waitFor(async () =>
      expect(await s.current(s.postPublication.id)).toMatchObject({
        scheduledAt: to,
        dryRun: false,
      }),
    );
  });

  it("una hora que no existe en Chile por el cambio de horario no se envía", async () => {
    const s = await setup();
    const at = new Date(Date.now() + 3 * HOUR);
    await s.schedule("listing", at);
    const day = await s.openDay(chileDateOf(at));
    fireEvent.click(
      within(await entryIn(day, at, "Instagram", "P-001")).getByRole("button", { name: "Mover" }),
    );
    const panel = screen.getByRole("region", { name: "Mover la fecha" });
    // El 5 de septiembre de 2027 el reloj salta de 00:00 a 01:00.
    fireEvent.change(within(panel).getByLabelText("Fecha y hora (Chile)"), {
      target: { value: "2027-09-05T00:30" },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Mover" }));

    expect((await within(panel).findByRole("alert")).textContent).toContain("no existen en Chile");
    expect(s.requests.some((request) => request.includes("/schedule"))).toBe(false);
  });

  it("lo del día del cambio de hora va en su día, a su hora de Chile", async () => {
    const s = await setup();
    // 01:30 del domingo 6 de septiembre de 2026 (la primera hora de ese día, ya en verano).
    const at = new Date("2026-09-06T04:30:00.000Z");
    await s.schedule("listing", at);

    const day = await s.openDay("2026-09-06");

    const entry = await entryIn(day, at, "Instagram", "P-001");
    expect(entry.textContent).toContain("01:30");
    expect(entry.textContent).toContain("atrasada");
    expect(
      s.requests.some((request) =>
        decodeURIComponent(request).includes(
          `/calendar?from=${chileDateStart("2026-08-31").toISOString()}&to=${chileDateStart("2026-09-07").toISOString()}`,
        ),
      ),
    ).toBe(true);
  });

  it("la vista mensual avanza de mes y pide su rango de semanas completas", async () => {
    const s = await setup();
    s.renderApp("/calendario?vista=mes&dia=2026-10-20");
    expect(await screen.findByRole("heading", { name: "Octubre de 2026" })).toBeTruthy();
    expect(await screen.findByText("Nada programado ni publicado en estas fechas.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Mes siguiente" }));

    expect(await screen.findByRole("heading", { name: "Noviembre de 2026" })).toBeTruthy();
    await waitFor(() =>
      expect(s.requests.map(decodeURIComponent)).toContain(
        `GET /calendar?from=${chileDateStart("2026-10-26").toISOString()}&to=${chileDateStart("2026-12-07").toISOString()}`,
      ),
    );
  });

  it("un corredor ve solo lo suyo", async () => {
    const s = await setup();
    const at = new Date(Date.now() + 3 * HOUR);
    await s.schedule("post", at);
    await s.schedule("listing", at);
    s.signInAsBroker(s.broker.id);

    const day = await s.openDay(chileDateOf(at));

    expect(await entryIn(day, at, "Instagram", "P-001")).toBeTruthy();
    expect(within(day).queryByText("Lo que aprendí esta semana")).toBeNull();
    // Sin el nombre del corredor: todo es suyo.
    expect(day.textContent).not.toContain("vinny");
  });
});
