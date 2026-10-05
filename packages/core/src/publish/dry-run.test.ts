import { describe, expect, it } from "vitest";
import type { PlatformAccount } from "../platform-account.js";
import type { PublishContext, Publisher, PublishInput } from "../ports/publisher.js";
import { createFakePublisher } from "../testing/index.js";
import { withDryRun } from "./dry-run.js";
import { publishAttemptRecord } from "./input.js";

const at = new Date("2026-10-05T12:00:00Z");
const TOKEN = "IGAAtoken-secreto-123";
const SIGNATURE = "X-Amz-Signature=firma-secreta";

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

const signedUrl = (path: string) =>
  `https://bucket.r2.cloudflarestorage.com/${path}?X-Amz-Credential=clave&${SIGNATURE}`;

const input: PublishInput = {
  publicationId: "pub-1",
  platform: "instagram",
  format: "post",
  title: null,
  caption: "Departamento luminoso en Ñuñoa.\n\n#nunoa",
  media: ["a", "b"].map((name, index) => {
    const storagePath = `brokers/broker-1/listings/listing-1/processed/ig_4x5/${name}.jpg`;
    return {
      mediaId: `m-${index + 1}`,
      kind: "image" as const,
      mime: "image/jpeg",
      storagePath,
      url: signedUrl(storagePath),
      bytes: 200_000 + index,
      width: 1080,
      height: 1350,
      durationS: null,
    };
  }),
};

/** Contexto de un intento; `saveProgress` falla si se llama (en dry-run no hay nada creado). */
const context = (): PublishContext => ({
  account,
  credentials: { accessToken: TOKEN },
  progress: null,
  async saveProgress() {
    throw new Error("dry-run no debía guardar progreso");
  },
});

/** Un publisher que falla si se le llama a `publish`. */
const untouchable = (): Publisher => ({
  platform: "instagram",
  formats: ["post", "reel"],
  validate: () => ({ ok: true }),
  async publish() {
    throw new Error("dry-run no debía llamar a publish");
  },
});

describe("withDryRun", () => {
  it("nunca llama a publish del envuelto: devuelve un resultado simulado", async () => {
    await expect(withDryRun(untouchable()).publish(input, context())).resolves.toEqual({
      externalId: "dry-run:pub-1",
      externalUrl: null,
      simulated: true,
    });

    const fake = createFakePublisher();
    await withDryRun(fake).publish(input, context());
    expect(fake.published).toEqual([]);
    expect(fake.validated).toHaveLength(1);
  });

  it("conserva la plataforma, los formatos y la validación del envuelto", () => {
    const fake = createFakePublisher({
      platform: "portal_inmobiliario",
      formats: ["post"],
      issues: [{ code: "NO_TITLE", message: "Falta el título" }],
    });
    const publisher = withDryRun(fake);
    expect(publisher.platform).toBe("portal_inmobiliario");
    expect(publisher.formats).toEqual(["post"]);
    expect(publisher.validate(input)).toEqual({
      ok: false,
      issues: [{ code: "NO_TITLE", message: "Falta el título" }],
    });
  });

  it("un input inválido no se publica: PUBLISH_INPUT_INVALID con los motivos", async () => {
    const issues = [{ code: "TOO_MANY_ITEMS", message: "El carrusel tiene más de 10 imágenes" }];
    const fake = createFakePublisher({ issues });
    await expect(withDryRun(fake).publish(input, context())).rejects.toMatchObject({
      code: "PUBLISH_INPUT_INVALID",
      retriable: false,
      details: { publicationId: "pub-1", issues },
    });
    expect(fake.published).toEqual([]);
  });

  it("un formato que la plataforma no publica u otra plataforma tampoco se simulan", async () => {
    const postOnly = createFakePublisher({ formats: ["post"] });
    await expect(
      withDryRun(postOnly).publish({ ...input, format: "reel" }, context()),
    ).rejects.toMatchObject({
      code: "PUBLISH_INPUT_INVALID",
      details: { issues: [expect.objectContaining({ code: "FORMAT_NOT_SUPPORTED" })] },
    });
    const portal = createFakePublisher({ platform: "portal_inmobiliario", formats: ["post"] });
    await expect(withDryRun(portal).publish(input, context())).rejects.toMatchObject({
      code: "PUBLISH_INPUT_INVALID",
      details: { issues: [expect.objectContaining({ code: "PLATFORM_MISMATCH" })] },
    });
  });

  it("ni el resultado ni el registro del intento llevan URLs firmadas ni tokens", async () => {
    const result = await withDryRun(untouchable()).publish(input, context());
    const record = publishAttemptRecord(input, account);
    const written = JSON.stringify({ record, result });
    for (const item of input.media) expect(written).not.toContain(item.url);
    for (const secret of [TOKEN, SIGNATURE, "X-Amz-Credential", "https://", "?"]) {
      expect(written).not.toContain(secret);
    }
    expect(record.media.every((item) => !("url" in item))).toBe(true);
  });
});
