// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PostThumb } from "./PostThumb.js";
import {
  isStale,
  POST_PROGRESS_LABEL,
  PostProgressBadge,
  postProgress,
  type TrackingPostRow,
} from "./progress.js";

afterEach(cleanup);

type Pub = TrackingPostRow["cells"]["x"][number];
const pub = (status: Pub["status"], extra: Partial<Pub> = {}): Pub => ({
  id: crypto.randomUUID(),
  format: "post",
  language: "en",
  status,
  dryRun: true,
  modeFixed: true,
  mediaCount: null,
  externalUrl: null,
  scheduledAt: null,
  schedule: null,
  expiry: null,
  lastError: null,
  errorAdvice: null,
  manualTask: false,
  publishedAt: null,
  updatedAt: new Date(),
  ...extra,
});
const row = (x: Pub[], instagram: Pub[] = []): TrackingPostRow => ({
  post: {
    id: "p",
    brokerId: "b",
    topic: "t",
    status: "ready",
    kind: "image",
    plannedAt: null,
  },
  cells: { instagram, x, linkedin: [], discord: [], tiktok: [] },
});

describe("postProgress: en qué va un post", () => {
  it("sin publicaciones, o solo canceladas, no hay nada", () => {
    expect(postProgress(undefined).state).toBe("none");
    expect(postProgress(row([pub("cancelled")])).state).toBe("none");
  });

  it("publicado solo si todo lo que se pidió salió; si falta algo, en parte", () => {
    expect(postProgress(row([pub("published")], [pub("published")])).state).toBe("published");
    expect(postProgress(row([pub("published")], [pub("approved")])).state).toBe("partial");
  });

  it("programado, atrasado, a mano, fallido y aprobado sin hora", () => {
    const at = new Date("2026-11-12T15:00:00Z");
    expect(
      postProgress(row([pub("scheduled", { scheduledAt: at, schedule: "upcoming" })])),
    ).toEqual({
      state: "scheduled",
      nextAt: at,
    });
    expect(
      postProgress(row([pub("scheduled", { scheduledAt: at, schedule: "overdue" })])).state,
    ).toBe("overdue");
    expect(postProgress(row([pub("awaiting_manual_confirm")])).state).toBe("waiting");
    expect(postProgress(row([pub("outcome_unknown")])).state).toBe("failed");
    expect(postProgress(row([pub("approved")])).state).toBe("approved");
  });
});

describe("isStale: una fecha pasada sin que el post saliera", () => {
  const now = new Date("2026-11-11T12:00:00Z");
  const past = new Date("2026-11-10T12:00:00Z");
  const future = new Date("2026-11-12T12:00:00Z");
  it("es alerta si pasó y no salió, ni está programado, ni te toca a mano", () => {
    expect(isStale(past, { state: "none", nextAt: null }, now)).toBe(true);
    expect(isStale(past, { state: "overdue", nextAt: null }, now)).toBe(true);
    expect(isStale(past, { state: "failed", nextAt: null }, now)).toBe(true);
  });
  it("no lo es si salió, si espera tu clic, si falta a futuro o si no tiene fecha", () => {
    expect(isStale(past, { state: "published", nextAt: null }, now)).toBe(false);
    expect(isStale(past, { state: "waiting", nextAt: null }, now)).toBe(false);
    expect(isStale(future, { state: "none", nextAt: null }, now)).toBe(false);
    expect(isStale(null, { state: "none", nextAt: null }, now)).toBe(false);
  });
});

describe("la insignia y la miniatura", () => {
  it("la insignia dice el estado con palabras", () => {
    render(<PostProgressBadge progress={{ state: "overdue", nextAt: null }} />);
    expect(screen.getByText(POST_PROGRESS_LABEL.overdue)).toBeTruthy();
  });

  it("la miniatura es un bloque con ancho fijo: si fuera en línea, la imagen saldría a su tamaño real", () => {
    const { container } = render(
      <PostThumb cover={{ url: "https://x.test/a.jpg", kind: "image", count: 1 }} />,
    );
    const box = container.firstElementChild as HTMLElement;
    expect(box.className).toContain("block");
    expect(box.className).toContain("w-20");
  });
});
