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

describe("withDryRun con preflight (F4-T13, ADR-0016)", () => {
  const portalInput: PublishInput = { ...input, platform: "portal_inmobiliario", title: "Depto" };
  const portal = (options: Parameters<typeof createFakePublisher>[0] = {}) =>
    createFakePublisher({
      platform: "portal_inmobiliario",
      formats: ["post"],
      operations: {},
      ...options,
    });

  it("llama a preflight y nunca a publish, pause, resume ni close del envuelto; las advertencias vuelven en notes", async () => {
    const fake = portal({ preflight: { ok: true, notes: ["Mercado Libre sugiere más fotos"] } });
    const wrapped = withDryRun(fake);

    const result = await wrapped.publish(portalInput, context());

    expect(result).toEqual({
      externalId: "dry-run:pub-1",
      externalUrl: null,
      simulated: true,
      notes: ["Mercado Libre sugiere más fotos"],
    });
    expect(fake.preflighted).toHaveLength(1);
    expect(fake.published).toEqual([]);
    expect(fake.operated).toEqual([]);
    expect(wrapped.pause).toBeUndefined();
    expect(wrapped.resume).toBeUndefined();
    expect(wrapped.close).toBeUndefined();
    expect(wrapped.getStatus).toBeUndefined();
    expect(wrapped.preflight).toBeDefined();
  });

  it("sin advertencias no hay notes", async () => {
    const result = await withDryRun(portal({ preflight: { ok: true } })).publish(
      portalInput,
      context(),
    );
    expect(result).not.toHaveProperty("notes");
  });

  it("un rechazo de preflight es PUBLISH_INPUT_INVALID con sus motivos, como en live", async () => {
    const fake = portal({
      preflight: {
        ok: false,
        issues: [{ code: "item.attributes.missing_required", message: "Falta la superficie" }],
      },
    });

    await expect(withDryRun(fake).publish(portalInput, context())).rejects.toMatchObject({
      code: "PUBLISH_INPUT_INVALID",
      retriable: false,
      message: expect.stringContaining("Falta la superficie"),
      details: {
        issues: [{ code: "item.attributes.missing_required", message: "Falta la superficie" }],
      },
    });
    expect(fake.published).toEqual([]);
  });

  it("un rechazo sin motivos sigue siendo un rechazo", async () => {
    const fake = portal({ preflight: { ok: false, issues: [] } });
    await expect(withDryRun(fake).publish(portalInput, context())).rejects.toMatchObject({
      code: "PUBLISH_INPUT_INVALID",
      details: { issues: [{ code: "INPUT_REJECTED" }] },
    });
  });

  it("un input inválido no llega a preflight", async () => {
    const fake = portal({
      preflight: { ok: true },
      issues: [{ code: "TITLE_MISSING", message: "Falta el título" }],
    });
    await expect(withDryRun(fake).publish(portalInput, context())).rejects.toMatchObject({
      code: "PUBLISH_INPUT_INVALID",
    });
    expect(fake.preflighted).toEqual([]);
  });

  it("un error de preflight (la red) sube tal cual, con su retriable", async () => {
    const down = Object.assign(new Error("Mercado Libre no responde"), {
      code: "ML_UNAVAILABLE",
      retriable: true,
    });
    const fake = portal({ preflight: down });
    await expect(withDryRun(fake).publish(portalInput, context())).rejects.toBe(down);
  });

  it("preflight recibe el contexto de la plataforma: el proveedor de token del intento o, sin él, el token guardado", async () => {
    const seen: string[] = [];
    const publisher: Publisher = {
      ...portal(),
      async preflight(_input, ctx) {
        seen.push(await ctx.accessToken());
        return { ok: true };
      },
    };
    await withDryRun(publisher).publish(portalInput, {
      ...context(),
      accessToken: async () => "APP_USR-del-proveedor",
    });
    await withDryRun(publisher).publish(portalInput, context());
    expect(seen).toEqual(["APP_USR-del-proveedor", TOKEN]);
  });
});
