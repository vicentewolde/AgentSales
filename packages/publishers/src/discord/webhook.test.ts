import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { errorText, usePlatformServer } from "../../test/msw-server.js";
import { discordHttpError, isDiscordNotSent } from "./errors.js";
import { createDiscordWebhooks } from "./webhook.js";

// F9-T14: el cliente del webhook (leer sin publicar, para conectar) y la tabla de errores.

const TOKEN = "tokenSecretoDelWebhook-123_abc";
const WEBHOOK_URL = `https://discord.com/api/webhooks/987654321/${TOKEN}`;
const GET = `https://discord.com/api/v10/webhooks/987654321/${TOKEN}`;

const { server, recorded } = usePlatformServer();
const webhooks = createDiscordWebhooks();

describe("createDiscordWebhooks.get", () => {
  it("lee el webhook sin publicar: id, nombre, servidor y canal (v10, GET)", async () => {
    server.use(
      http.get(GET, () =>
        HttpResponse.json({
          id: "987654321",
          type: 1,
          name: "AgentSales",
          guild_id: "111",
          channel_id: "222",
          token: TOKEN,
        }),
      ),
    );
    await expect(webhooks.get(WEBHOOK_URL)).resolves.toEqual({
      id: "987654321",
      name: "AgentSales",
      guildId: "111",
      channelId: "222",
    });
    const [request] = await recorded();
    expect(request?.method).toBe("GET");
  });

  it("sin nombre ni servidor: un nombre por defecto y null", async () => {
    server.use(http.get(GET, () => HttpResponse.json({ id: 987654321, channel_id: "222" })));
    await expect(webhooks.get(WEBHOOK_URL)).resolves.toEqual({
      id: "987654321",
      name: "Webhook 987654321",
      guildId: null,
      channelId: "222",
    });
  });

  it("un webhook borrado (404) o con el token roto (401) da su código, sin la URL", async () => {
    for (const [status, code, expected] of [
      [404, 10015, "DISCORD_WEBHOOK_NOT_FOUND"],
      [401, 50027, "DISCORD_WEBHOOK_INVALID"],
    ] as const) {
      server.use(http.get(GET, () => HttpResponse.json({ message: "x", code }, { status })));
      const error = await webhooks.get(WEBHOOK_URL).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: expected, retriable: false });
      expect(errorText(error)).not.toContain(TOKEN);
    }
  });

  it("una URL que no es de un webhook es CREDENTIALS_INVALID sin llamar", async () => {
    const error = await webhooks
      .get("https://example.com/api/webhooks/1/x")
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "CREDENTIALS_INVALID" });
    expect(await recorded()).toEqual([]);
  });
});

describe("discordHttpError", () => {
  it("clasifica por status y código: lo que prueba que no salió y lo que es dudoso", () => {
    const of = (httpStatus: number, body: unknown = null, retryAfterHeader: string | null = null) =>
      discordHttpError({ httpStatus, body, retryAfterHeader });
    expect(of(429, null, "30")).toMatchObject({
      code: "DISCORD_RATE_LIMITED",
      retriable: true,
      details: { retryAfterS: 30, waitMinutes: 1 },
    });
    expect(of(400, { code: 20028 })).toMatchObject({ code: "DISCORD_RATE_LIMITED" });
    expect(of(400, { code: 50035 })).toMatchObject({
      code: "DISCORD_REQUEST_REJECTED",
      message: "Discord rechazó el mensaje (código 50035)",
    });
    expect(of(400, { code: 50006 }).message).toContain("vacío");
    expect(of(413)).toMatchObject({ code: "DISCORD_FILE_TOO_LARGE" });
    expect(of(404, { code: 10003 })).toMatchObject({ code: "DISCORD_WEBHOOK_NOT_FOUND" });
    for (const status of [400, 401, 403, 404, 413, 429]) {
      expect(isDiscordNotSent(of(status)), String(status)).toBe(true);
    }
    for (const status of [500, 502, 503, 302]) {
      expect(of(status)).toMatchObject({ code: "DISCORD_UNAVAILABLE" });
      expect(isDiscordNotSent(of(status)), String(status)).toBe(false);
    }
  });
});
