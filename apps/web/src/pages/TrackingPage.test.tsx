// @vitest-environment jsdom
import type { AgendaResponse } from "@agentsales/api/contracts";
import { AGENDA_KIND_TEXT } from "@agentsales/core";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { publicationSetup } from "../../test/harness.js";
import { Agenda, TrackingMatrix } from "./TrackingPage.js";

// F6-T13 (spec F6 §4.8 a §4.10): Seguimiento, las acciones de la propiedad y `auto_publish` en el
// panel, sobre la API en proceso.

afterEach(cleanup);

const HOUR = 60 * 60 * 1000;

type Item = AgendaResponse["items"][number];
const item = (extra: Partial<Item>): Item => ({
  kind: "upcoming",
  action: "none",
  listingId: "l1",
  postId: null,
  externalRef: "P1",
  title: "P1",
  accountId: null,
  brokerSlug: null,
  platform: "instagram",
  format: "post",
  publicationId: "p1",
  at: new Date("2026-10-19T13:00:00.000Z"),
  dryRun: true,
  modeFixed: true,
  mediaCount: 3,
  code: null,
  advice: null,
  daysLeft: null,
  expired: false,
  stale: false,
  ...extra,
});

describe("la agenda", () => {
  it("muestra las clases en su orden, con el consejo y el respaldo", () => {
    render(
      <MemoryRouter>
        <Agenda
          items={[
            item({ kind: "failed", action: "retry", code: "IG_AUTH_INVALID", advice: "Reconecta" }),
            item({ kind: "overdue", action: "publish", publicationId: "p2" }),
            item({
              kind: "backup",
              action: "backup",
              listingId: null,
              externalRef: null,
              title: null,
              platform: null,
              format: null,
              publicationId: null,
              at: null,
              dryRun: null,
              stale: true,
            }),
            item({ kind: "upcoming", publicationId: "p3" }),
          ]}
        />
      </MemoryRouter>,
    );

    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual([
      `${AGENDA_KIND_TEXT.overdue} (1)`,
      `${AGENDA_KIND_TEXT.failed} (1)`,
      `${AGENDA_KIND_TEXT.upcoming} (1)`,
      `${AGENDA_KIND_TEXT.backup} (1)`,
    ]);
    const failed = screen.getByRole("region", { name: AGENDA_KIND_TEXT.failed });
    // F9.5-T02: el consejo dice qué hacer; el código va aparte, como dato secundario.
    expect(failed.textContent).toContain("Reconecta");
    expect(failed.textContent).toContain("código IG_AUTH_INVALID");
    const backup = screen.getByRole("region", { name: AGENDA_KIND_TEXT.backup });
    expect(backup.textContent).toContain("nunca");
    expect(backup.textContent).toContain("más de 48 h");
  });

  it("un post va con su tema y enlaza a su página de Contenido (F9-T17); lo nuevo de F9 dice qué hacer", () => {
    render(
      <MemoryRouter>
        <Agenda
          items={[
            item({
              kind: "outcome_unknown",
              action: "resolve",
              listingId: null,
              postId: "post-1",
              externalRef: null,
              title: "Bastidores",
              platform: "discord",
            }),
            item({
              kind: "token_expiring",
              action: "reconnect",
              listingId: null,
              externalRef: null,
              title: "Vinny en LinkedIn",
              accountId: "acc-1",
              platform: "linkedin",
              format: null,
              publicationId: null,
              dryRun: null,
              daysLeft: 3,
            }),
          ]}
        />
      </MemoryRouter>,
    );

    const unknown = screen.getByRole("region", { name: AGENDA_KIND_TEXT.outcome_unknown });
    expect(unknown.textContent).toContain("Bastidores (post)");
    expect(unknown.textContent).toContain("di si salió o no");
    expect(within(unknown).getByRole("link").getAttribute("href")).toBe("/contenido/post-1");
    const token = screen.getByRole("region", { name: AGENDA_KIND_TEXT.token_expiring });
    expect(token.textContent).toContain("Vinny en LinkedIn");
    expect(token.textContent).toContain("vence en 3 días");
    expect(token.textContent).toContain("Vuelve a conectar");
  });
});

describe("la página Seguimiento", () => {
  it("muestra la agenda y la matriz, con enlace al detalle", async () => {
    const s = await publicationSetup();
    const listing = await s.t.listings.get(s.t.listingId);
    await s.t.publications.transition(
      s.t.byFormat("post")?.id ?? "",
      {
        from: "approved",
        to: "scheduled",
        changes: { dryRun: true, scheduledAt: new Date(Date.now() + 5 * HOUR) },
      },
      { actor: "operator" },
    );
    s.renderApp("/seguimiento");

    const upcoming = await screen.findByRole("region", { name: AGENDA_KIND_TEXT.upcoming });
    expect(upcoming.textContent).toContain(listing?.externalRef ?? "");
    const table = await screen.findByRole("table");
    const row = within(table).getByRole("row", { name: new RegExp(listing?.externalRef ?? "") });
    expect(row.textContent).toContain("programada");
    expect(
      within(row)
        .getByRole("link", { name: listing?.externalRef ?? "" })
        .getAttribute("href"),
    ).toBe(`/propiedades/${s.t.listingId}`);
  });
});

describe("la matriz", () => {
  it("cada celda con su estado: programada atrasada, tarea a mano, por vencer y error", () => {
    const base = {
      id: "p",
      format: "post" as const,
      language: "es" as const,
      status: "published" as const,
      dryRun: true,
      modeFixed: true,
      mediaCount: 3,
      externalUrl: null,
      scheduledAt: null,
      schedule: null,
      expiry: null,
      lastError: null,
      errorAdvice: null,
      manualTask: false,
      publishedAt: null,
      updatedAt: new Date(),
    };
    render(
      <MemoryRouter>
        <TrackingMatrix
          rows={[
            {
              listing: {
                id: "l1",
                brokerId: "b",
                externalRef: "P1",
                status: "closed",
                closeReason: "sold",
                operation: "sale",
                propertyType: null,
                comuna: null,
              },
              coverUrl: null,
              cells: {
                instagram: [
                  { ...base, id: "a", dryRun: false, manualTask: true },
                  {
                    ...base,
                    id: "b",
                    format: "reel",
                    mediaCount: 1,
                    status: "scheduled",
                    scheduledAt: new Date("2026-10-01T13:00:00.000Z"),
                    schedule: "overdue",
                  },
                ],
                portal_inmobiliario: [
                  {
                    ...base,
                    id: "c",
                    externalUrl: "javascript:alert(1)",
                    expiry: { stopTime: new Date(), daysLeft: 3, soon: true, expired: false },
                  },
                ],
                fb_marketplace: [
                  {
                    ...base,
                    id: "d",
                    status: "failed",
                    // Fallida que no empezó en vivo: su modo es el del sistema (D4 de F9.5).
                    modeFixed: false,
                    lastError: {
                      code: "MARKETPLACE_X",
                      message: "Facebook cerró la ventana",
                      retriable: false,
                    },
                  },
                ],
              },
            },
          ]}
        />
      </MemoryRouter>,
    );

    const row = screen.getByRole("row", { name: /P1/ });
    expect(row.textContent).toContain("vendida");
    expect(row.textContent).toContain("tarea a mano");
    expect(row.textContent).toContain("atrasada");
    expect(row.textContent).toContain("vence en 3 d");
    // F9.5-T02: el motivo legible y, aparte, el código.
    expect(row.textContent).toContain("Facebook cerró la ventana");
    expect(row.textContent).toContain("(código: MARKETPLACE_X)");
    // Un enlace que no es `https` no se vuelve enlace.
    expect(within(row).queryByRole("link", { name: "Ver" })).toBeNull();
  });
});

describe("el banner con auto_publish en vivo", () => {
  it("si no se pudo saber, también lo dice", async () => {
    const s = await publicationSetup({
      publishMode: "live",
      intercept: (method, path) =>
        method === "GET" && path === "/health"
          ? Response.json({
              status: "degraded",
              publishMode: "live",
              version: "x",
              checks: {
                db: { ok: false, latencyMs: 1, error: "sin base" },
                storage: { ok: true, latencyMs: 1 },
                queue: { ok: true, latencyMs: 1 },
              },
              autoPublishBrokers: null,
            })
          : undefined,
    });
    s.renderApp("/");
    expect(
      await screen.findByText(/No se pudo saber si algún corredor tiene publicación automática/),
    ).toBeTruthy();
  });
});
