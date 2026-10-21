import { ALL_SCOPE, type PublishWarning, publishPublication } from "@agentsales/core";
import { createPostPublicationScenario } from "@agentsales/core/testing";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { usePlatformServer } from "../../test/msw-server.js";
import { createDiscordPublisher, type DiscordPublishNote } from "./publisher.js";

// F9-T14: el intento completo (`publishPublication` de core) con el publisher real de Discord y
// Discord simulado con msw: lo que queda en la publicación, la bitácora, los avisos y las notas del
// log nunca lleva la URL del webhook ni su token.

/** El token del webhook del escenario de posts (`createPostPublicationScenario`). */
const TOKEN = "token-webhook-prueba";
const EXECUTE = `https://discord.com/api/v10/webhooks/123456/${TOKEN}`;

const { server } = usePlatformServer();

async function setup() {
  const t = await createPostPublicationScenario({
    accounts: [
      {
        platform: "discord",
        meta: {
          webhookName: "AgentSales",
          guildId: "111",
          channelId: "222",
          connectedAt: "2026-10-20T12:00:00.000Z",
        },
      },
    ],
  });
  const warnings: PublishWarning[] = [];
  const notes: DiscordPublishNote[] = [];
  const discord = createDiscordPublisher({
    // Los medios del escenario viven en memoria (`memory://`): se leen de ahí, sin red.
    download: async (item) => new TextEncoder().encode(`bytes de ${item.mediaId}`),
    sleep: async () => {},
    onNote: (note) => notes.push(note),
  });
  const deps = {
    ...t.publishDeps({ discord }),
    onWarning: (w: PublishWarning) => warnings.push(w),
  };
  const publication = await t.toPublishing(t.publicationOf("discord"));
  /** Todo lo que quedó guardado o se avisó de la publicación, como texto. */
  const everything = async () =>
    JSON.stringify({
      publication: t.current(publication.id),
      events: await t.publications.listEvents(publication.id),
      warnings,
      notes,
    });
  return { t, deps, publication, everything };
}

describe("publicar un post en Discord (el intento completo)", () => {
  it("publicado: id y enlace del mensaje, y la URL del webhook en ninguna parte", async () => {
    let files = 0;
    server.use(
      http.post(EXECUTE, async ({ request }) => {
        const form = await request.formData();
        files = [...form.keys()].filter((key) => key.startsWith("files[")).length;
        return HttpResponse.json({ id: "555", channel_id: "222" });
      }),
    );
    const { deps, publication, everything } = await setup();

    const result = await publishPublication(deps, {
      publicationId: publication.id,
      isLastAttempt: false,
    });

    expect(result).toMatchObject({
      outcome: "published",
      publication: {
        status: "published",
        externalId: "555",
        externalUrl: "https://discord.com/channels/111/222/555",
      },
    });
    expect(files).toBe(1);
    const text = await everything();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("api/webhooks");
  });

  it("un corte al enviar deja outcome_unknown sin reenviar, y la URL en ninguna parte", async () => {
    let calls = 0;
    server.use(
      http.post(EXECUTE, () => {
        calls += 1;
        return HttpResponse.error();
      }),
    );
    const { deps, publication, everything } = await setup();

    const result = await publishPublication(deps, {
      publicationId: publication.id,
      isLastAttempt: false,
    });

    expect(result).toMatchObject({
      outcome: "outcome_unknown",
      publication: { status: "outcome_unknown", lastError: { code: "OUTCOME_UNKNOWN" } },
    });
    expect(calls).toBe(1);
    expect(await everything()).not.toContain(TOKEN);
  });

  it("un webhook borrado (404) deja la publicación failed y la cuenta vencida: no se vuelve a usar", async () => {
    let calls = 0;
    server.use(
      http.post(EXECUTE, () => {
        calls += 1;
        return HttpResponse.json({ message: "Unknown Webhook", code: 10015 }, { status: 404 });
      }),
    );
    const { t, deps, publication, everything } = await setup();

    await publishPublication(deps, { publicationId: publication.id, isLastAttempt: false }).catch(
      () => undefined,
    );

    expect(t.current(publication.id)).toMatchObject({
      status: "failed",
      lastError: { code: "DISCORD_WEBHOOK_NOT_FOUND", retriable: false },
    });
    const [account] = await t.platformAccounts.list(ALL_SCOPE);
    expect(account?.status).toBe("expired");
    expect(calls).toBe(1);
    expect(await everything()).not.toContain(TOKEN);
  });

  it("un 429 largo reprograma la publicación (waitMinutes), sin dejarla dudosa", async () => {
    server.use(
      http.post(EXECUTE, () =>
        HttpResponse.json({ message: "límite", retry_after: 240, global: false }, { status: 429 }),
      ),
    );
    const { deps, publication, everything } = await setup();

    const result = await publishPublication(deps, {
      publicationId: publication.id,
      isLastAttempt: false,
    });

    expect(result).toMatchObject({
      outcome: "rescheduled",
      publication: { status: "scheduled", lastError: { code: "DISCORD_RATE_LIMITED" } },
    });
    expect(await everything()).not.toContain(TOKEN);
  });
});
