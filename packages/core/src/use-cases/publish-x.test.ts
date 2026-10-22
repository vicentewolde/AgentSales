import { describe, expect, it } from "vitest";
import { isAppError } from "../errors.js";
import type { Publication } from "../publication.js";
import { parsePublishedUrl } from "../publish/published-url.js";
import { createPostPublicationScenario, createSendOncePublisher } from "../testing/index.js";
import { X_DEFAULT_SPEND_LIMIT_USD, xSpendLimitOf } from "../x/account.js";
import { xPostCostUsd } from "../x/cost.js";
import { parseXPostUrl, xPostUrl } from "../x/post-url.js";
import { publishPublication } from "./publish-publication.js";
import { setXSpendLimit } from "./x-account.js";

// F9-T16 (spec F9 §4.4 y §4.12): en X, la marca del enlace, el costo estimado (`cost_usd`) y el
// tope de gasto del mes (`spendLimitUsd`) se revisan antes de llamar a la red.

const NOW = new Date("2026-10-20T15:00:00Z");
const LINK_BRIEF = "Contar la novedad. Enlace: https://agentpey.com/redes";
const LINK_BODY = "Ya está la guía: https://agentpey.com/redes";

const caught = (promise: Promise<unknown>) => promise.then(() => null).catch((e: unknown) => e);
const codeOf = async (promise: Promise<unknown>) => {
  const error = await caught(promise);
  return isAppError(error) ? error.code : error;
};

/** Una publicación de X ya publicada en `live` con su costo, para llenar el gasto del mes. */
async function spent(
  t: Awaited<ReturnType<typeof createPostPublicationScenario>>,
  publication: Publication,
  costUsd: number,
) {
  await t.toPublishing(publication);
  await t.publications.setCostUsd(publication.id, costUsd);
  await t.publications.transition(
    publication.id,
    {
      from: "publishing",
      to: "published",
      changes: { externalId: "1", externalUrl: null, publishedAt: NOW },
    },
    { actor: "system", payload: { mode: "live" } },
  );
}

describe("publishPublication en X: costo y tope de gasto", () => {
  it("un post sin enlace anota US$0,015 y publica", async () => {
    const t = await createPostPublicationScenario({ texts: [{ platform: "x", language: "es" }] });
    const x = createSendOncePublisher("x", { now: () => NOW });
    const pub = await t.toPublishing(t.publicationOf("x"));
    const result = await publishPublication(t.publishDeps({ x }, { now: () => NOW }), {
      publicationId: pub.id,
      isLastAttempt: false,
    });
    expect(result.outcome).toBe("published");
    expect(t.current(pub.id)?.costUsd).toBeCloseTo(0.015, 10);
    expect(x.sends).toHaveLength(1);
  });

  it("un post con enlace y la marca del operador anota US$0,20", async () => {
    const t = await createPostPublicationScenario({
      texts: [{ platform: "x", language: "es" }],
      brief: LINK_BRIEF,
      xLinkAllowed: true,
      bodies: { x: LINK_BODY },
    });
    const x = createSendOncePublisher("x", { now: () => NOW });
    const pub = await t.toPublishing(t.publicationOf("x"));
    await publishPublication(t.publishDeps({ x }, { now: () => NOW }), {
      publicationId: pub.id,
      isLastAttempt: false,
    });
    expect(t.current(pub.id)).toMatchObject({ status: "published" });
    expect(t.current(pub.id)?.costUsd).toBeCloseTo(0.2, 10);
  });

  it("un enlace pide la marca explícita: sin ella no se aprueba, y si se quita después no sale", async () => {
    // Sin la marca, el texto con enlace no se aprueba (aunque el enlace esté en el brief).
    const unmarked = await caught(
      createPostPublicationScenario({
        texts: [{ platform: "x", language: "es" }],
        brief: LINK_BRIEF,
        bodies: { x: LINK_BODY },
      }),
    );
    expect(isAppError(unmarked) && unmarked.code).toBe("CONTENT_HAS_ERRORS");
    expect(isAppError(unmarked) && unmarked.details).toMatchObject({
      codes: ["LINK_NOT_ALLOWED"],
    });

    // Aprobado con la marca, y la marca quitada antes de publicar: falla sin llamar a X.
    const t = await createPostPublicationScenario({
      texts: [{ platform: "x", language: "es" }],
      brief: LINK_BRIEF,
      xLinkAllowed: true,
      bodies: { x: LINK_BODY },
    });
    await t.posts.update(t.post.id, { xLinkAllowed: false });
    const x = createSendOncePublisher("x", { now: () => NOW });
    const pub = await t.toPublishing(t.publicationOf("x"));
    const error = await caught(
      publishPublication(t.publishDeps({ x }, { now: () => NOW }), {
        publicationId: pub.id,
        isLastAttempt: false,
      }),
    );
    expect(isAppError(error) && error.code).toBe("X_LINK_NOT_ALLOWED");
    expect((error as Error).message).toContain("US$0,2");
    expect(t.current(pub.id)).toMatchObject({
      status: "failed",
      lastError: { code: "X_LINK_NOT_ALLOWED", retriable: false },
    });
    expect(x.sends).toEqual([]);
  });

  it("pasado el tope del mes, queda failed con la causa y sin llamar a la red", async () => {
    const t = await createPostPublicationScenario({
      texts: [
        { platform: "x", language: "es" },
        { platform: "x", language: "en" },
      ],
    });
    const accountId = t.accounts.get("x") ?? "";
    await setXSpendLimit(t, { accountId, spendLimitUsd: 0.02 });
    await spent(t, t.publicationOf("x", "en"), 0.015);
    const x = createSendOncePublisher("x", { now: () => NOW });
    const pub = await t.toPublishing(t.publicationOf("x", "es"));
    expect(
      await codeOf(
        publishPublication(t.publishDeps({ x }, { now: () => NOW }), {
          publicationId: pub.id,
          isLastAttempt: false,
        }),
      ),
    ).toBe("X_SPEND_LIMIT_REACHED");
    expect(t.current(pub.id)).toMatchObject({
      status: "failed",
      lastError: { code: "X_SPEND_LIMIT_REACHED", retriable: false },
    });
    expect(t.current(pub.id)?.lastError?.message).toContain("tope de gasto");
    expect(x.sends).toEqual([]);
  });

  it("dos publicaciones a la vez de la misma cuenta no pasan las dos el tope (F9.5-T08)", async () => {
    const t = await createPostPublicationScenario({
      texts: [
        { platform: "x", language: "es" },
        { platform: "x", language: "en" },
      ],
    });
    const accountId = t.accounts.get("x") ?? "";
    // Cabe un post de US$0,015, no dos.
    await setXSpendLimit(t, { accountId, spendLimitUsd: 0.02 });
    const x = createSendOncePublisher("x", { now: () => NOW });
    const es = await t.toPublishing(t.publicationOf("x", "es"));
    const en = await t.toPublishing(t.publicationOf("x", "en"));
    const deps = t.publishDeps({ x }, { now: () => NOW });
    const results = await Promise.allSettled([
      publishPublication(deps, { publicationId: es.id, isLastAttempt: false }),
      publishPublication(deps, { publicationId: en.id, isLastAttempt: false }),
    ]);
    const statuses = [t.current(es.id)?.status, t.current(en.id)?.status].sort();
    expect(statuses).toEqual(["failed", "published"]);
    const rejected = results.find((result) => result.status === "rejected");
    expect(isAppError(rejected?.reason) && rejected.reason.code).toBe("X_SPEND_LIMIT_REACHED");
    expect(x.sends).toHaveLength(1);
  });

  it("un reintento de la misma publicación no cuenta su propia reserva dos veces", async () => {
    const t = await createPostPublicationScenario({ texts: [{ platform: "x", language: "es" }] });
    const accountId = t.accounts.get("x") ?? "";
    await setXSpendLimit(t, { accountId, spendLimitUsd: 0.015 });
    const pub = await t.toPublishing(t.publicationOf("x"));
    // Un intento anterior ya reservó su costo y quedó en `publishing` (el reintento de la cola).
    const first = await t.publications.reserveCostUsd(pub.id, accountId, 0.015, {
      limitUsd: 0.015,
      since: new Date("2026-10-01T03:00:00Z"),
    });
    expect(first.costUsd).toBeCloseTo(0.015, 10);
    const x = createSendOncePublisher("x", { now: () => NOW });
    const result = await publishPublication(t.publishDeps({ x }, { now: () => NOW }), {
      publicationId: pub.id,
      isLastAttempt: false,
    });
    expect(result.outcome).toBe("published");
    expect(t.current(pub.id)?.costUsd).toBeCloseTo(0.015, 10);
  });

  it("el tope es del mes de Chile y solo de lo publicado en vivo", async () => {
    const t = await createPostPublicationScenario({
      texts: [
        { platform: "x", language: "es" },
        { platform: "x", language: "en" },
      ],
    });
    const accountId = t.accounts.get("x") ?? "";
    await setXSpendLimit(t, { accountId, spendLimitUsd: 0.02 });
    // Una simulación no cuenta, aunque tenga costo anotado.
    const en = await t.toPublishing(t.publicationOf("x", "en"), { dryRun: true });
    await t.publications.setCostUsd(en.id, 0.015);
    const x = createSendOncePublisher("x", { now: () => NOW });
    const pub = await t.toPublishing(t.publicationOf("x", "es"));
    const result = await publishPublication(t.publishDeps({ x }, { now: () => NOW }), {
      publicationId: pub.id,
      isLastAttempt: false,
    });
    expect(result.outcome).toBe("published");
  });

  it("en dry-run anota el costo de referencia sin mirar el tope", async () => {
    const t = await createPostPublicationScenario({ texts: [{ platform: "x", language: "es" }] });
    await setXSpendLimit(t, { accountId: t.accounts.get("x") ?? "", spendLimitUsd: 0 });
    const x = createSendOncePublisher("x", { now: () => NOW });
    const pub = await t.toPublishing(t.publicationOf("x"), { dryRun: true });
    const result = await publishPublication(t.publishDeps({ x }, { now: () => NOW }), {
      publicationId: pub.id,
      isLastAttempt: false,
    });
    expect(result.outcome).toBe("published");
    expect(t.current(pub.id)?.costUsd).toBeCloseTo(0.015, 10);
    expect(x.sends).toEqual([]);
  });

  it("un post de video publica el video reducido de X (x_video)", async () => {
    const t = await createPostPublicationScenario({
      texts: [{ platform: "x", language: "es" }],
      kind: "video",
      images: 0,
      video: true,
    });
    const pub = t.publicationOf("x");
    const [mediaId] = pub.mediaIds;
    const media = await t.media.listBySubject({ kind: "post", id: t.post.id });
    expect(media.find((item) => item.id === mediaId)?.variant).toBe("x_video");
  });
});

describe("setXSpendLimit", () => {
  it("fija el tope (con 4 decimales) y rechaza lo que no es una cifra válida o no es de X", async () => {
    const t = await createPostPublicationScenario({
      texts: [
        { platform: "x", language: "es" },
        { platform: "discord", language: "es" },
      ],
    });
    const accountId = t.accounts.get("x") ?? "";
    const before = await t.platformAccounts.get(accountId);
    expect(before === null ? null : xSpendLimitOf(before)).toBe(X_DEFAULT_SPEND_LIMIT_USD);
    const updated = await setXSpendLimit(t, { accountId, spendLimitUsd: 2.123456 });
    expect(xSpendLimitOf(updated)).toBe(2.1235);
    expect(await codeOf(setXSpendLimit(t, { accountId, spendLimitUsd: -1 }))).toBe(
      "X_SPEND_LIMIT_INVALID",
    );
    expect(await codeOf(setXSpendLimit(t, { accountId, spendLimitUsd: 5000 }))).toBe(
      "X_SPEND_LIMIT_INVALID",
    );
    expect(
      await codeOf(
        setXSpendLimit(t, { accountId: t.accounts.get("discord") ?? "", spendLimitUsd: 5 }),
      ),
    ).toBe("ACCOUNT_PLATFORM_INVALID");
    expect(await codeOf(setXSpendLimit(t, { accountId: "no-existe", spendLimitUsd: 5 }))).toBe(
      "ACCOUNT_NOT_FOUND",
    );
  });
});

describe("el enlace de un post de X (sin red)", () => {
  it("reconoce x.com y twitter.com y devuelve el id que guarda el publisher", () => {
    expect(parseXPostUrl("https://x.com/agentpey/status/1850000000000000001?s=20")).toEqual({
      postId: "1850000000000000001",
      username: "agentpey",
      url: "https://x.com/agentpey/status/1850000000000000001",
    });
    expect(parseXPostUrl("https://twitter.com/AgentPey/status/42/photo/1").postId).toBe("42");
    expect(parseXPostUrl("https://mobile.x.com/i/web/status/42").url).toBe(
      "https://x.com/i/status/42",
    );
    expect(parsePublishedUrl("x", "https://www.x.com/agentpey/status/42/")).toEqual({
      externalId: "42",
      url: "https://x.com/agentpey/status/42",
    });
    expect(xPostUrl("42", null)).toBe("https://x.com/i/status/42");
  });

  it("cualquier otra cosa es PUBLISHED_URL_INVALID sin repetir lo recibido", () => {
    for (const value of [
      "https://x.com/agentpey",
      "http://x.com/agentpey/status/42",
      "https://evil.com/x.com/agentpey/status/42",
      "https://x.com.evil.com/agentpey/status/42",
    ]) {
      let error: unknown = null;
      try {
        parseXPostUrl(value);
      } catch (caughtError) {
        error = caughtError;
      }
      expect(isAppError(error) && error.code).toBe("PUBLISHED_URL_INVALID");
      expect((error as Error).message).not.toContain(value);
    }
  });

  it("el costo estimado: US$0,015 sin enlace y US$0,20 con uno", () => {
    expect(xPostCostUsd("Hola")).toBe(0.015);
    expect(xPostCostUsd("Mira agentpey.com")).toBe(0.2);
  });
});
