import {
  ALL_SCOPE,
  confirmManualPublication,
  type PublishWarning,
  publishPublication,
} from "@agentsales/core";
import { createPostPublicationScenario, POST_SCENARIO_TOKEN } from "@agentsales/core/testing";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { usePlatformServer } from "../../test/msw-server.js";
import { createTikTokAuth } from "./auth.js";
import { createTikTokPublisher, type TikTokPublishNote } from "./publisher.js";

// F9-T26: el intento completo (`publishPublication` de core) con el publisher real de TikTok, su
// renovación de token (`ensureRotatingAccessToken`) y TikTok simulado con msw: el borrador llega a
// la bandeja, la publicación queda `awaiting_manual_confirm` y el operador la confirma con el
// enlace del video. Ningún token ni URL de subida queda guardado.

const API = "https://open.tiktokapis.com";
const UPLOAD = "https://open-upload.tiktokapis.com/upload/?upload_id=subida-secreta";
const NOW = new Date("2026-10-20T12:00:00Z");

const { server, recorded } = usePlatformServer();

function fakeTikTok() {
  server.use(
    http.post(`${API}/v2/oauth/token/`, () =>
      HttpResponse.json({
        access_token: "act.renovado",
        refresh_token: "rft.rotado",
        open_id: "cuenta-tiktok",
        expires_in: 86400,
        refresh_expires_in: 31536000,
        scope: "user.info.basic,video.upload",
      }),
    ),
    http.post(`${API}/v2/post/publish/inbox/video/init/`, () =>
      HttpResponse.json({
        data: { publish_id: "v_inbox_file~v2.999", upload_url: UPLOAD },
        error: { code: "ok" },
      }),
    ),
    http.put(
      "https://open-upload.tiktokapis.com/upload/",
      () => new HttpResponse(null, { status: 201 }),
    ),
    http.post(`${API}/v2/post/publish/status/fetch/`, () =>
      HttpResponse.json({ data: { status: "SEND_TO_USER_INBOX" }, error: { code: "ok" } }),
    ),
  );
}

async function setup({ accessTokenExpiresAt }: { accessTokenExpiresAt: Date }) {
  const t = await createPostPublicationScenario({
    kind: "video",
    images: 0,
    video: true,
    texts: [{ platform: "tiktok", language: "es" }],
    accounts: [
      {
        platform: "tiktok",
        meta: { openId: "cuenta-tiktok", accessTokenExpiresAt: accessTokenExpiresAt.toISOString() },
      },
    ],
  });
  const warnings: PublishWarning[] = [];
  const notes: TikTokPublishNote[] = [];
  const tiktok = createTikTokPublisher({
    // Los medios del escenario viven en memoria: el trozo se arma aquí, del largo pedido.
    readChunk: async (_item, range) => new Uint8Array(range.last - range.first + 1),
    sleep: async () => {},
    pollDelaysMs: [0],
    onNote: (note) => notes.push(note),
  });
  const auth = createTikTokAuth({
    clientKey: "clave",
    clientSecret: "secreto-app",
    redirectUri: "https://agentsales.test/api/oauth/tiktok/callback",
    now: () => NOW,
  });
  const deps = {
    ...t.publishDeps({ tiktok }, { tokenRefreshers: { tiktok: auth }, now: () => NOW }),
    onWarning: (w: PublishWarning) => warnings.push(w),
  };
  const everything = async (id: string) =>
    JSON.stringify({
      publication: t.current(id),
      events: await t.publications.listEvents(id),
      warnings,
      notes,
    });
  return { t, deps, everything };
}

describe("publicar un post en TikTok (el intento completo)", () => {
  it("renueva el token que venció, sube el borrador y deja la publicación esperando el enlace", async () => {
    fakeTikTok();
    const { t, deps, everything } = await setup({ accessTokenExpiresAt: NOW });
    const publication = await t.toPublishing(t.publicationOf("tiktok"));

    const result = await publishPublication(deps, {
      publicationId: publication.id,
      isLastAttempt: false,
    });

    expect(result).toMatchObject({
      outcome: "awaiting_manual_confirm",
      publication: { status: "awaiting_manual_confirm", externalId: null },
    });
    // El token se renovó una vez (el par rotó) y el init usó el nuevo.
    const requests = await recorded();
    expect(requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      "POST /v2/oauth/token/",
      "POST /v2/post/publish/inbox/video/init/",
      "PUT /upload/",
      "POST /v2/post/publish/status/fetch/",
    ]);
    expect(requests[1]?.authorization).toBe("Bearer act.renovado");
    const [account] = await t.platformAccounts.list(ALL_SCOPE);
    expect(account && t.platformAccounts.storedCredentials(account.id)).toEqual({
      accessToken: "act.renovado",
      refreshToken: "rft.rotado",
    });

    // El operador lo publica en la app y pega el enlace del video.
    const confirmed = await confirmManualPublication(t.subjectDeps, {
      publicationId: publication.id,
      url: "https://www.tiktok.com/@agentpey/video/7430000000000000001?is_from_webapp=1",
      actor: "operator",
    });
    expect(confirmed.publication).toMatchObject({
      status: "published",
      externalId: "7430000000000000001",
      externalUrl: "https://www.tiktok.com/@agentpey/video/7430000000000000001",
    });
    const text = await everything(publication.id);
    expect(text).not.toMatch(/act\.|rft\.|subida-secreta|secreto-app/);
    expect(text).not.toContain(POST_SCENARIO_TOKEN);
  });

  it("con 5 envíos pendientes en la bandeja, la publicación se reprograma (waitMinutes), sin dejarla dudosa", async () => {
    fakeTikTok();
    server.use(
      http.post(`${API}/v2/post/publish/inbox/video/init/`, () =>
        HttpResponse.json(
          { data: {}, error: { code: "spam_risk_too_many_pending_share", message: "x" } },
          { status: 403 },
        ),
      ),
    );
    const { t, deps } = await setup({ accessTokenExpiresAt: new Date(NOW.getTime() + 86400000) });
    const publication = await t.toPublishing(t.publicationOf("tiktok"));

    const result = await publishPublication(deps, {
      publicationId: publication.id,
      isLastAttempt: false,
    });

    expect(result).toMatchObject({
      outcome: "rescheduled",
      publication: { status: "scheduled", lastError: { code: "TIKTOK_PENDING_LIMIT" } },
    });
    expect(t.current(publication.id)?.progress).toBeNull();
  });

  it("en dry-run no llama a TikTok: queda esperando la confirmación, simulado", async () => {
    fakeTikTok();
    const { t, deps } = await setup({ accessTokenExpiresAt: new Date(NOW.getTime() + 86400000) });
    const publication = await t.toPublishing(t.publicationOf("tiktok"), { dryRun: true });

    const result = await publishPublication(deps, {
      publicationId: publication.id,
      isLastAttempt: false,
    });

    expect(result).toMatchObject({
      outcome: "awaiting_manual_confirm",
      publication: { status: "awaiting_manual_confirm", progress: { manual: { simulated: true } } },
    });
    expect(await recorded()).toEqual([]);
  });
});
