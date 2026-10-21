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
import { createLinkedInPublisher } from "./publisher.js";

// F9-T15: el intento completo (`publishPublication` de core) con el publisher real de LinkedIn y
// LinkedIn simulado con msw. En modo `manual` (el de por defecto, D5) no sale ninguna petición: la
// publicación queda lista para publicar a mano y se confirma con el enlace.

const API = "https://api.linkedin.com/rest";
const UPLOAD = "https://www.linkedin.com/dms-uploads/sp/subida";
const POST_URN = "urn:li:share:7380000000000000009";

const { server, recorded } = usePlatformServer();

async function setup(mode: "api" | "manual") {
  const t = await createPostPublicationScenario({
    texts: [{ platform: "linkedin", language: "es" }],
    accounts: [
      {
        platform: "linkedin",
        meta: { mode, scopes: null, connectedAt: "2026-10-20T12:00:00.000Z" },
      },
    ],
  });
  const warnings: PublishWarning[] = [];
  const linkedin = createLinkedInPublisher({
    // Los medios del escenario viven en memoria: se leen de ahí, sin red.
    readMedia: async () => new Uint8Array(16).fill(1),
  });
  const deps = {
    ...t.publishDeps({ linkedin }),
    onWarning: (w: PublishWarning) => warnings.push(w),
  };
  const publication = await t.toPublishing(t.publicationOf("linkedin"));
  const everything = async () =>
    JSON.stringify({
      publication: t.current(publication.id),
      events: await t.publications.listEvents(publication.id),
      warnings,
    });
  return { t, deps, publication, everything };
}

describe("publicar un post en LinkedIn (el intento completo)", () => {
  it("modo manual: ninguna llamada a la red; queda lista y la confirmación guarda el URN del enlace", async () => {
    const { t, deps, publication } = await setup("manual");

    const result = await publishPublication(deps, {
      publicationId: publication.id,
      isLastAttempt: false,
    });

    expect(result).toMatchObject({
      outcome: "awaiting_manual_confirm",
      publication: { status: "awaiting_manual_confirm" },
    });
    expect(await recorded()).toEqual([]);

    const url =
      "https://www.linkedin.com/posts/agentpey_hola-activity-7381234567890123456-AbCd?utm_source=share";
    const confirmed = await confirmManualPublication(t.subjectDeps, {
      publicationId: publication.id,
      url,
      actor: "operator",
    });
    expect(confirmed.publication).toMatchObject({
      status: "published",
      externalId: "urn:li:activity:7381234567890123456",
      externalUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7381234567890123456/",
    });
    expect(await recorded()).toEqual([]);
  });

  it("modo api: sube la foto, publica y guarda el URN; el token en ninguna parte", async () => {
    server.use(
      http.post(`${API}/images`, () =>
        HttpResponse.json({ value: { uploadUrl: `${UPLOAD}/1`, image: "urn:li:image:I1" } }),
      ),
      http.put(`${UPLOAD}/*`, () => new HttpResponse(null, { status: 201 })),
      http.post(
        `${API}/posts`,
        () => new HttpResponse(null, { status: 201, headers: { "x-restli-id": POST_URN } }),
      ),
    );
    const { deps, publication, everything } = await setup("api");

    const result = await publishPublication(deps, {
      publicationId: publication.id,
      isLastAttempt: false,
    });

    expect(result).toMatchObject({
      outcome: "published",
      publication: {
        status: "published",
        externalId: POST_URN,
        externalUrl: `https://www.linkedin.com/feed/update/${POST_URN}/`,
      },
    });
    expect(await everything()).not.toContain(POST_SCENARIO_TOKEN);
  });

  it("modo api con el token vencido (401): failed y la cuenta vencida, para reconectar", async () => {
    server.use(http.post(`${API}/images`, () => new HttpResponse(null, { status: 401 })));
    const { t, deps, publication, everything } = await setup("api");

    await publishPublication(deps, { publicationId: publication.id, isLastAttempt: false }).catch(
      () => undefined,
    );

    expect(t.current(publication.id)).toMatchObject({
      status: "failed",
      lastError: { code: "LINKEDIN_AUTH_INVALID", retriable: false },
    });
    const [account] = await t.platformAccounts.list(ALL_SCOPE);
    expect(account?.status).toBe("expired");
    expect(await everything()).not.toContain(POST_SCENARIO_TOKEN);
  });
});
