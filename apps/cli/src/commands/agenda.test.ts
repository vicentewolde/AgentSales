import type { AgendaResponse, TrackingResponse } from "@agentsales/api/contracts";
import { describe, expect, it } from "vitest";
import { createColors } from "../colors.js";
import { agendaCommands, renderAgenda, START_WORKER_COMMANDS } from "./agenda.js";
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
  modeFixed: true,
  mediaCount: 1,
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

  it("una aprobada sin publicar no dice simulación (su modo es el del servidor, D4 de F9.5)", () => {
    const waiting = item({ kind: "approved_waiting", action: "publish", modeFixed: false });
    expect(renderAgenda([waiting], c)).not.toContain("simulación");
    // Una programada sí tiene su modo fijado.
    expect(renderAgenda([item({})], c)).toContain("simulación");
  });

  it("un post de Instagram con una sola foto es una imagen; con varias, un carrusel (F9.5-T02)", () => {
    const one = item({ platform: "instagram", mediaCount: 1 });
    expect(renderAgenda([one], c)).toContain("Instagram imagen");
    expect(renderAgenda([{ ...one, mediaCount: 3 }], c)).toContain("Instagram carrusel");
  });

  it("posts y avisos van en la misma clase, en el orden que trae la API", () => {
    const listing = item({ postId: null, listingId: "l1", externalRef: "P1", title: "P1" });
    const text = renderAgenda([item({}), listing], c);
    expect(text).toContain("Próximas (7 días) (2)");
    expect(text.indexOf("Lo que aprendí")).toBeLessThan(text.indexOf("P1 ·"));
  });
});

describe("agenda con el worker apagado (F9.5-T24)", () => {
  // 2026-10-22 12:00 en Chile: la próxima revisión del horario es a las 12:50.
  const NOW = new Date("2026-10-22T15:00:00.000Z");
  const off = item({ kind: "worker_off", action: "wait_worker" });

  it("con horario: dice que el worker está apagado, la próxima revisión y cómo encenderlo ya", () => {
    const text = renderAgenda([off], c, NOW);
    expect(text).toContain(
      "El worker está apagado y hay algo por vencer (1) · sale cuando se encienda, en la próxima revisión: 2026-10-22 12:50",
    );
    expect(text).toContain(
      "→ en el servidor: GitHub → Actions → «Encender el worker» → Run workflow",
    );
    expect(text).toContain("→ en el Mac: pnpm dev");
  });

  it("sin horario no promete la revisión: el worker debe estar encendido", () => {
    const text = renderAgenda([{ ...off, action: "start_worker" }], c, NOW);
    expect(text).toContain(
      "El worker está apagado y hay algo por vencer (1) · sin horario: el worker debe estar encendido",
    );
    expect(text).not.toContain("próxima revisión");
    expect(text).toContain("→ en el Mac: pnpm dev");
  });

  it("en un post, además, verlo; en un aviso, solo encenderlo", () => {
    expect(agendaCommands(off)).toEqual(["agentsales post show post-1", ...START_WORKER_COMMANDS]);
    expect(agendaCommands({ ...off, postId: null, listingId: "l1" })).toEqual([
      ...START_WORKER_COMMANDS,
    ]);
  });

  it("va antes que lo demás", () => {
    const text = renderAgenda([item({}), off], c, NOW);
    expect(text.indexOf("El worker está apagado")).toBeLessThan(text.indexOf("Próximas"));
  });
});

describe("tracking con posts", () => {
  it("una fila por post con su tema, su estado y una columna por red", () => {
    const base = {
      format: "post" as const,
      dryRun: true,
      modeFixed: true,
      mediaCount: 1,
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
