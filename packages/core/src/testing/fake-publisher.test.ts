import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import type { PlatformAccount } from "../platform-account.js";
import type { PublishContext, PublishInput } from "../ports/publisher.js";
import { createFakePublisher } from "./fake-publisher.js";

const at = new Date("2026-10-05T12:00:00Z");
const TOKEN = "IGAA-secreto-xyz";
const account: PlatformAccount = {
  id: "account-1",
  brokerId: "broker-1",
  platform: "instagram",
  externalAccountId: "1789",
  displayName: "@corredora",
  status: "connected",
  tokenExpiresAt: null,
  meta: {},
  hasCredentials: true,
  createdAt: at,
  updatedAt: at,
};
const input: PublishInput = {
  publicationId: "pub-1",
  platform: "instagram",
  format: "post",
  title: null,
  caption: "Hola",
  media: [],
};

function context(progress: unknown = null) {
  const saved: unknown[] = [];
  const ctx: PublishContext = {
    account,
    credentials: { accessToken: TOKEN },
    progress,
    async saveProgress(value) {
      saved.push(value);
    },
  };
  return { ctx, saved };
}

describe("createFakePublisher", () => {
  it("sigue los pasos en orden: guarda progreso, lanza o devuelve el resultado", async () => {
    const unavailable = new AppError("IG_UNAVAILABLE", "Instagram no respondió", {
      retriable: true,
    });
    const publisher = createFakePublisher({
      steps: [
        { progress: { containerId: "c-1" }, error: unavailable },
        { result: { externalId: "ig-1", externalUrl: "https://example.test/p/ig-1" } },
      ],
    });
    const first = context();
    await expect(publisher.publish(input, first.ctx)).rejects.toBe(unavailable);
    expect(first.saved).toEqual([{ containerId: "c-1" }]);

    const second = context({ containerId: "c-1" });
    await expect(publisher.publish(input, second.ctx)).resolves.toEqual({
      externalId: "ig-1",
      externalUrl: "https://example.test/p/ig-1",
      simulated: false,
    });
    await expect(publisher.publish(input, context().ctx)).resolves.toMatchObject({
      externalId: "fake-pub-1-3",
      simulated: false,
    });
    expect(publisher.published.map((call) => call.progress)).toEqual([
      null,
      { containerId: "c-1" },
      null,
    ]);
    expect(JSON.stringify(publisher.published)).not.toContain(TOKEN);
  });

  it("validate devuelve los motivos guionados, fijos o según el input", () => {
    const publisher = createFakePublisher({
      issues: (candidate) =>
        candidate.media.length === 0 ? [{ code: "NO_MEDIA", message: "Sin medios" }] : [],
    });
    expect(publisher.validate(input)).toEqual({
      ok: false,
      issues: [{ code: "NO_MEDIA", message: "Sin medios" }],
    });
    expect(createFakePublisher().validate(input)).toEqual({ ok: true });
  });
});

describe("createFakePublisher con preflight y operaciones (F4-T13)", () => {
  const platformCtx = { account, accessToken: async () => "APP_USR-x" };
  const ref = { externalId: "MLC123", progress: { itemId: "MLC123" } };

  it("sin las opciones no tiene preflight ni operaciones, como Instagram", () => {
    const fake = createFakePublisher();
    expect(fake.preflight).toBeUndefined();
    expect(fake.pause).toBeUndefined();
    expect(fake.close).toBeUndefined();
  });

  it("registra las operaciones y devuelve el estado de cada una, o el pedido", async () => {
    const fake = createFakePublisher({ platform: "portal_inmobiliario", operations: {} });
    expect(await fake.pause?.(ref, platformCtx)).toMatchObject({ status: "paused" });
    expect(await fake.resume?.(ref, platformCtx)).toMatchObject({ status: "active" });
    expect(await fake.close?.(ref, platformCtx)).toMatchObject({ status: "closed" });
    expect(await fake.getStatus?.(ref, platformCtx)).toMatchObject({ status: "active" });
    expect(fake.operated.map((call) => call.operation)).toEqual([
      "pause",
      "resume",
      "close",
      "getStatus",
    ]);
    expect(JSON.stringify(fake.operated)).not.toContain("APP_USR");

    const fixed = createFakePublisher({
      operations: {
        status: { status: "under_review", subStatus: ["x"], stopTime: null, expirationTime: null },
      },
    });
    expect(await fixed.pause?.(ref, platformCtx)).toMatchObject({ status: "under_review" });
  });

  it("una operación o un preflight con error lo lanzan", async () => {
    const boom = new AppError("ML_UNAVAILABLE", "no responde", { retriable: true });
    const fake = createFakePublisher({ preflight: boom, operations: { error: boom } });
    await expect(fake.preflight?.(input, platformCtx)).rejects.toBe(boom);
    await expect(fake.close?.(ref, platformCtx)).rejects.toBe(boom);
    expect(fake.preflighted).toHaveLength(1);
  });
});
