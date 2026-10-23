// @vitest-environment jsdom
import { chileDateOf, parseChileTime, postSubject } from "@agentsales/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { brokerData, harness } from "../../../test/harness.js";
import { ApiClientContext } from "../../api/context.js";
import { ApproveWeek, weekTextState } from "./ApproveWeek.js";
import { LINKEDIN_FEED_URL, LinkedInAssist } from "./LinkedInAssist.js";

// F9.5-T27: «Aprobar la semana» en Plan, la lista «Lista para publicar a diario» en Cuentas y el
// asistente de LinkedIn a mano, contra la API real en proceso. Nada se publica en el momento.

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

/** Un día de la semana que viene (hora de Chile). */
const DAY = chileDateOf(new Date(Date.now() + 8 * 86_400_000));

async function setup() {
  const h = harness();
  const brand = await h.brokers.create(
    { ...brokerData("agentpey"), brandName: "AgentPey" },
    { kind: "brand" },
  );
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
  return { ...h, brand, accepted };
}

describe("panel: Aprobar la semana", () => {
  it("muestra los textos de la semana, aprueba y programa cada post a su fecha y dice lo que no pudo", async () => {
    const s = await setup();
    const post = await s.accepted("Lo que aprendí", ["linkedin", "x"]);
    render(
      <ApiClientContext.Provider value={s.client}>
        <QueryClientProvider client={s.queryClient}>
          <MemoryRouter>
            <ApproveWeek brandId={s.brand.id} week={DAY} />
          </MemoryRouter>
        </QueryClientProvider>
      </ApiClientContext.Provider>,
    );
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

describe("LinkedInAssist", () => {
  it("copia el texto aprobado con sus hashtags y abre LinkedIn con un enlace normal", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<LinkedInAssist content={{ body: "Hola LinkedIn", hashtags: ["#agentpey"] }} />);
    const link = screen.getByRole("link", { name: "Copiar texto y abrir LinkedIn" });
    expect(link.getAttribute("href")).toBe(LINKEDIN_FEED_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    fireEvent.click(link);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Hola LinkedIn\n\n#agentpey"));
    expect(await screen.findByText("Texto copiado: pégalo en LinkedIn")).toBeTruthy();
  });

  it("sin el texto no muestra nada", () => {
    const { container } = render(<LinkedInAssist content={undefined} />);
    expect(container.textContent).toBe("");
  });
});
