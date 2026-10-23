// @vitest-environment jsdom
import { chileDateOf, parseChileTime, postSubject } from "@agentsales/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerData, harness } from "../../../test/harness.js";
import { ApiClientContext } from "../../api/context.js";
import { ApproveWeek, weekTextState } from "./ApproveWeek.js";

// F9.5-T27: «Aprobar la semana» en Plan, la lista «Lista para publicar a diario» en Cuentas y el
// asistente de LinkedIn a mano, contra la API real en proceso. Nada se publica en el momento.

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

/** Un día de la semana que viene (hora de Chile). */
const DAY = chileDateOf(new Date(Date.now() + 8 * 86_400_000));

async function setup(options: { live?: boolean } = {}) {
  const h = harness(options.live === true ? { deps: { publishMode: "live" } } : {});
  const brand = await h.brokers.create(
    { ...brokerData("agentpey"), brandName: "AgentPey" },
    { kind: "brand" },
  );
  // ADR-0036: en vivo solo una marca propia y encendida.
  if (options.live === true) {
    await h.brokers.setSettings(brand.id, { operatorOwned: true });
    await h.brokers.setLiveEnabled(brand.id, true);
  }
  await h.platformAccounts.upsertConnected({
    brokerId: brand.id,
    platform: "linkedin",
    externalAccountId: "perfil-1",
    displayName: "Vinny",
    tokenExpiresAt: null,
    meta: { mode: "manual" },
    credentials: { accessToken: "token-de-prueba" },
  });
  /** Una idea del plan ya aceptada, con su texto de LinkedIn (y el de X, si se pide). */
  const accepted = async (topic: string, texts: ("linkedin" | "x")[] = ["linkedin"]) => {
    const post = await h.deps.posts.create({
      brokerId: brand.id,
      topic,
      kind: "text",
      status: "draft",
      source: "ai",
      plannedAt: parseChileTime(`${DAY} 10:00`),
    });
    const run = await h.contentRuns.create({ postId: post.id, texts: true });
    await h.contentRuns.markRunning(run.id);
    await h.contentRuns.markSucceeded(run.id, {
      report: { warnings: [] },
      contents: texts.map((platform) => ({
        platform,
        language: "es",
        title: null,
        body: `Lo que aprendí construyendo, para ${platform}`,
        hashtags: ["#agentpey"],
        llmProvider: "fake",
        llmModel: "fake",
        promptVersion: "social-v1",
        rawOutput: null,
      })),
    });
    return post;
  };
  /** «Aprobar la semana» solo, con la API en proceso. */
  const renderWeek = () =>
    render(
      <ApiClientContext.Provider value={h.client}>
        <QueryClientProvider client={h.queryClient}>
          <MemoryRouter>
            <ApproveWeek brandId={brand.id} week={DAY} />
          </MemoryRouter>
        </QueryClientProvider>
      </ApiClientContext.Provider>,
    );
  return { ...h, brand, accepted, renderWeek };
}

describe("panel: Aprobar la semana", () => {
  it("muestra los textos de la semana, aprueba y programa cada post a su fecha y dice lo que no pudo", async () => {
    const s = await setup();
    const post = await s.accepted("Lo que aprendí", ["linkedin", "x"]);
    s.renderWeek();
    fireEvent.click(screen.getByRole("button", { name: "Aprobar la semana…" }));
    const panel = await screen.findByRole("region", { name: /^Aprobar la semana del/ });
    const list = await within(panel).findByRole("list", { name: "Posts de la semana" });
    expect(within(list).getByRole("link", { name: "Lo que aprendí" })).toBeTruthy();
    expect(within(list).getByText(/LinkedIn va a mano/)).toBeTruthy();
    expect(within(list).getAllByText("por aprobar")).toHaveLength(2);

    fireEvent.click(within(panel).getByRole("button", { name: "Aprobar y programar la semana" }));
    const result = await within(panel).findByRole("status", {
      name: "Resultado de aprobar la semana",
    });
    expect(within(result).getByText(/LinkedIn: programado para el/)).toBeTruthy();
    expect(within(result).getByText(/X: Sin cuenta conectada/)).toBeTruthy();
    expect(within(result).getByRole("link", { name: "Ir a Cuentas" })).toBeTruthy();
    expect(s.requests).toContain(`POST /brokers/${s.brand.id}/week/approve`);
    const publications = await s.deps.publications.listBySubject(postSubject(post.id));
    expect(publications.map((p) => [p.platform, p.status, p.dryRun])).toEqual([
      ["linkedin", "scheduled", true],
    ]);
  });
});

describe("panel: Aprobar la semana, foco y en vivo", () => {
  it("al abrir, el foco va a la región; Escape la cierra y el foco vuelve al botón", async () => {
    const s = await setup();
    await s.accepted("Lo que aprendí");
    s.renderWeek();
    const opener = screen.getByRole("button", { name: "Aprobar la semana…" });
    fireEvent.click(opener);
    const panel = await screen.findByRole("region", { name: /^Aprobar la semana del/ });
    expect(document.activeElement).toBe(panel);
    fireEvent.keyDown(panel, { key: "Escape" });
    const again = await screen.findByRole("button", { name: "Aprobar la semana…" });
    expect(screen.queryByRole("region", { name: /^Aprobar la semana del/ })).toBeNull();
    expect(document.activeElement).toBe(again);
  });

  it("con la marca en vivo, pide confirmar antes de programar; al confirmar, programa en vivo", async () => {
    const s = await setup({ live: true });
    const post = await s.accepted("En vivo");
    s.renderWeek();
    fireEvent.click(screen.getByRole("button", { name: "Aprobar la semana…" }));
    const panel = await screen.findByRole("region", { name: /^Aprobar la semana del/ });
    await within(panel).findByRole("link", { name: "En vivo" });
    fireEvent.click(within(panel).getByRole("button", { name: "Aprobar y programar la semana" }));
    expect(
      await within(panel).findByText(/a su hora, cada post se publica de verdad/),
    ).toBeTruthy();
    expect(s.requests).not.toContain(`POST /brokers/${s.brand.id}/week/approve`);
    fireEvent.click(within(panel).getByRole("button", { name: "Sí, programar en vivo" }));
    await within(panel).findByRole("status", { name: "Resultado de aprobar la semana" });
    const publications = await s.deps.publications.listBySubject(postSubject(post.id));
    expect(publications.map((p) => [p.status, p.dryRun])).toEqual([["scheduled", false]]);
  });
});

describe("weekTextState", () => {
  it("dice si el texto se aprueba, si tiene errores o si le faltan los medios", () => {
    expect(weekTextState({ status: "draft", checks: [] })).toEqual({
      text: "por aprobar",
      tone: "neutral",
    });
    expect(weekTextState({ status: "approved", checks: [] }).text).toBe("aprobado");
    expect(
      weekTextState({
        status: "approved",
        checks: [{ code: "MEDIA_REQUIREMENT", severity: "warning", message: "Falta la imagen" }],
      }).text,
    ).toBe("falta la imagen o el video");
    expect(
      weekTextState({
        status: "draft",
        checks: [{ code: "MEDIA_REQUIREMENT", severity: "error", message: "Muy largo" }],
      }),
    ).toEqual({ text: "1 error: no se aprueba", tone: "danger" });
  });
});

describe("panel: Lista para publicar a diario", () => {
  it("en Cuentas, cada marca dice qué le falta y cómo resolverlo", async () => {
    const s = await setup();
    s.renderApp("/cuentas");
    const section = await screen.findByRole("region", { name: "Lista para publicar a diario" });
    fireEvent.click(within(section).getByText("Lista para publicar a diario"));
    await waitFor(() => expect(within(section).getByText("La marca")).toBeTruthy());
    expect(within(section).getByText("Modo de la marca")).toBeTruthy();
    expect(within(section).getByText(/el servidor está en simulación/)).toBeTruthy();
    expect(within(section).getByText("Conectada: Vinny.")).toBeTruthy();
    expect(within(section).getByText(/Copiar texto y abrir LinkedIn/)).toBeTruthy();
    expect(s.requests).toContain(`GET /brokers/${s.brand.id}/daily-readiness`);
  });
});
