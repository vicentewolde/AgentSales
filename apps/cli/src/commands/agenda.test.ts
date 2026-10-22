import type { AgendaResponse, TrackingResponse } from "@agentsales/api/contracts";
import { describe, expect, it } from "vitest";
import { createColors } from "../colors.js";
import { agendaCommands, renderAgenda } from "./agenda.js";
import { renderTrackingPosts } from "./tracking.js";

// F9-T08 (spec F9 §4.2, §4.6 y §4.7): la agenda con posts y las clases nuevas, y los posts en el
// seguimiento, en la terminal.

type Item = AgendaResponse["items"][number];
const c = createColors(false);

const item = (extra: Partial<Item>): Item => ({
  kind: "upcoming",
  action: "none",
  listingId: null,
  postId: "post-1",
  externalRef: null,
  title: "Lo que aprendí esta semana",
  accountId: null,
  brokerSlug: null,
  platform: "linkedin",
  format: "post",
  publicationId: "pub-1",
  at: new Date("2026-10-21T13:00:00.000Z"),
  dryRun: true,
  code: null,
  advice: null,
  daysLeft: null,
  expired: false,
  stale: false,
  ...extra,
});

describe("agenda con posts", () => {
  it("un post va con su tema como título y el comando para verlo", () => {
    const upcoming = item({});
    expect(agendaCommands(upcoming)).toEqual([
      "agentsales post show post-1",
      "agentsales unschedule pub-1",
    ]);
    const text = renderAgenda([upcoming], c);
    expect(text).toContain("Lo que aprendí esta semana (post) · LinkedIn post");
    expect(text).toContain("→ agentsales post show post-1");
  });

  it("outcome_unknown: los dos comandos para resolverla, con el código", () => {
    const unknown = item({
      kind: "outcome_unknown",
      action: "resolve",
      platform: "discord",
      code: "OUTCOME_UNKNOWN",
      advice: "Revisa la red",
    });
    expect(agendaCommands(unknown)).toEqual([
      "agentsales post show post-1",
      "agentsales publications resolve pub-1 --published",
      "agentsales publications resolve pub-1 --not-published",
    ]);
    const text = renderAgenda([unknown], c);
    expect(text).toContain("No se sabe si salieron (1)");
    expect(text).toContain("OUTCOME_UNKNOWN: Revisa la red");
    // Una de un aviso también se resuelve por el id de la publicación.
    expect(agendaCommands({ ...unknown, postId: null, listingId: "l1" })).toEqual([
      "agentsales publications resolve pub-1 --published",
      "agentsales publications resolve pub-1 --not-published",
    ]);
  });

  it("un LinkedIn a mano listo: tarea a mano con ver el texto, confirmar con el enlace o decir que no salió", () => {
    const manual = item({ kind: "manual_task", action: "confirm" });
    expect(agendaCommands(manual)).toEqual([
      "agentsales post show post-1",
      "pbpaste | agentsales publications confirm pub-1 --url-stdin",
      "agentsales publications not-published pub-1",
    ]);
    expect(renderAgenda([manual], c)).toContain("Tareas a mano (1)");
  });

  it("un token de LinkedIn por vencer: la cuenta, los días y el comando para reconectar", () => {
    const token = item({
      kind: "token_expiring",
      action: "reconnect",
      postId: null,
      title: "Vinny en LinkedIn",
      accountId: "acc-1",
      brokerSlug: "vinny",
      format: null,
      publicationId: null,
      dryRun: null,
      daysLeft: 7,
    });
    expect(agendaCommands(token)).toEqual(["agentsales accounts connect linkedin --broker vinny"]);
    const text = renderAgenda([token], c);
    expect(text).toContain("Cuentas por reconectar (1)");
    expect(text).toContain("Vinny en LinkedIn · LinkedIn · vence en 7 días");
    expect(renderAgenda([{ ...token, expired: true }], c)).toContain("venció");
  });

  it("posts y avisos van en la misma clase, en el orden que trae la API", () => {
    const listing = item({ postId: null, listingId: "l1", externalRef: "P1", title: "P1" });
    const text = renderAgenda([item({}), listing], c);
    expect(text).toContain("Próximas (7 días) (2)");
    expect(text.indexOf("Lo que aprendí")).toBeLessThan(text.indexOf("P1 ·"));
  });
});

describe("tracking con posts", () => {
  it("una fila por post con su tema, su estado y una columna por red", () => {
    const base = {
      format: "post" as const,
      dryRun: true,
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
    const posts: TrackingResponse["posts"] = [
      {
        post: {
          id: "post-1",
          brokerId: "b",
          topic: "Bastidores",
          status: "ready",
          kind: "text",
          plannedAt: null,
        },
        cells: {
          instagram: [],
          x: [{ ...base, id: "a", language: "es", status: "published" }],
          linkedin: [
            { ...base, id: "b", language: "es", status: "awaiting_manual_confirm" },
            { ...base, id: "c", language: "en", status: "scheduled" },
          ],
          discord: [],
          tiktok: [],
        },
      },
    ];
    const text = renderTrackingPosts(posts, c);
    expect(text).toContain("Post");
    expect(text).toContain("LinkedIn");
    expect(text).toContain("Bastidores");
    expect(text).toContain("listo");
    expect(text).toContain("post publicada");
    expect(text).toContain("post [en] programada");
  });
});
