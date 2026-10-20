import { describe, expect, it } from "vitest";
import { socialCaption } from "../content/assemble.js";
import { AppError } from "../errors.js";
import { requiresManualConfirm } from "../marketplace/limits.js";
import { isManualAccount } from "../platform-account.js";
import { checkPublicationProgress } from "../publication.js";
import {
  isOutcomeUnknown,
  OUTCOME_UNKNOWN,
  OUTCOME_UNKNOWN_CODES,
  sendOnce,
  socialProgressSchema,
} from "./outcome.js";
import { discordMessageUrl, parseDiscordMessageUrl, parsePublishedUrl } from "./published-url.js";

// F9-T06 (ADR-0029 puntos 8 y 9): el "enviando" del resultado dudoso, el enlace que pega el
// operador, el texto por red y la cuenta a mano.

const NOW = new Date("2026-10-20T15:00:00Z");

/** Un contexto en memoria: el progreso que guarda `sendOnce`, como lo haría el repositorio. */
function context(
  initial: unknown = null,
  { failSave }: { failSave?: (p: unknown) => boolean } = {},
) {
  const saved: unknown[] = [];
  const ctx = {
    progress: initial,
    async saveProgress(progress: unknown) {
      if (failSave?.(progress) === true)
        throw new AppError("DB_UNAVAILABLE", "x", { retriable: true });
      saved.push(progress);
    },
  };
  return { ctx, saved };
}

const RESULT = { externalId: "msg-1", externalUrl: "https://example.test/1" };

describe("sendOnce", () => {
  it("guarda «enviando» antes de la llamada y el resultado después", async () => {
    const { ctx, saved } = context();
    const order: string[] = [];
    const result = await sendOnce(ctx, {
      now: () => NOW,
      send: async () => {
        order.push(`envía con ${saved.length} guardado`);
        return RESULT;
      },
    });
    expect(result).toEqual(RESULT);
    expect(order).toEqual(["envía con 1 guardado"]);
    expect(saved).toEqual([
      { send: { startedAt: NOW.toISOString() } },
      { send: { startedAt: NOW.toISOString(), result: RESULT } },
    ]);
  });

  it("con «enviando» sin resultado no llama: OUTCOME_UNKNOWN no reintentable", async () => {
    const { ctx } = context({ send: { startedAt: NOW.toISOString() } });
    let calls = 0;
    const error = await sendOnce(ctx, {
      send: async () => {
        calls += 1;
        return RESULT;
      },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: OUTCOME_UNKNOWN,
      retriable: false,
      details: { reason: "interrupted" },
    });
    expect(calls).toBe(0);
  });

  it("con el resultado guardado lo devuelve sin llamar", async () => {
    const { ctx } = context({ send: { startedAt: NOW.toISOString(), result: RESULT } });
    await expect(
      sendOnce(ctx, {
        send: async () => {
          throw new Error("no debía llamar");
        },
      }),
    ).resolves.toEqual(RESULT);
  });

  it("un progreso que no se lee (no es un objeto, o su «enviando» no calza) es dudoso, sin llamar", async () => {
    for (const progress of ["texto", [1], { send: { startedAt: "ayer" } }]) {
      const { ctx } = context(progress);
      await expect(sendOnce(ctx, { send: async () => RESULT })).rejects.toMatchObject({
        code: OUTCOME_UNKNOWN,
        details: { reason: "progress_unreadable" },
      });
    }
  });

  it("un progreso sin la clave send cuenta como «aún no se envió»: envía una vez y conserva lo del publisher", async () => {
    const { ctx, saved } = context({ uploaded: ["media-1"] });
    let calls = 0;
    await expect(
      sendOnce(ctx, {
        now: () => NOW,
        send: async () => {
          calls += 1;
          return RESULT;
        },
      }),
    ).resolves.toEqual(RESULT);
    expect(calls).toBe(1);
    expect(saved).toEqual([
      { uploaded: ["media-1"], send: { startedAt: NOW.toISOString() } },
      { uploaded: ["media-1"], send: { startedAt: NOW.toISOString(), result: RESULT } },
    ]);
  });

  it("suma «enviando» al progreso vigente (lo guardado en este intento) y no arrastra un traspaso a mano", async () => {
    const { ctx, saved } = context({
      manual: { attempt: 1, simulated: false, readyAt: NOW.toISOString(), media: 1 },
    });
    await sendOnce(ctx, {
      now: () => NOW,
      progress: { uploaded: ["media-1", "media-2"], manual: { attempt: 1 } },
      send: async () => RESULT,
    });
    expect(saved[0]).toEqual({
      uploaded: ["media-1", "media-2"],
      send: { startedAt: NOW.toISOString() },
    });
  });

  it("un error que prueba que no salió quita el «enviando» y deja lo del publisher", async () => {
    const limited = new AppError("X_RATE_LIMITED", "espera", { retriable: true });
    const { ctx, saved } = context({ uploaded: ["media-1"] });
    await expect(
      sendOnce(ctx, {
        notSent: (error) => error === limited,
        send: async () => {
          throw limited;
        },
      }),
    ).rejects.toBe(limited);
    expect(saved.at(-1)).toEqual({ uploaded: ["media-1"] });
  });

  it("si no se puede guardar «enviando», el error sube y no se llama", async () => {
    const { ctx } = context(null, { failSave: () => true });
    let calls = 0;
    await expect(
      sendOnce(ctx, {
        send: async () => {
          calls += 1;
          return RESULT;
        },
      }),
    ).rejects.toMatchObject({ code: "DB_UNAVAILABLE" });
    expect(calls).toBe(0);
  });

  it("un error sin certeza es OUTCOME_UNKNOWN con la causa; uno que prueba que no salió borra el «enviando» y sube tal cual", async () => {
    const cut = new Error("se cortó");
    const first = context();
    const unknown = await sendOnce(first.ctx, {
      send: async () => {
        throw cut;
      },
    }).catch((e: unknown) => e);
    expect(unknown).toMatchObject({ code: OUTCOME_UNKNOWN, details: { reason: "send_failed" } });
    expect((unknown as Error).cause).toBe(cut);

    const limited = new AppError("X_RATE_LIMITED", "espera", { retriable: true });
    const second = context();
    await expect(
      sendOnce(second.ctx, {
        notSent: (error) => error === limited,
        send: async () => {
          throw limited;
        },
      }),
    ).rejects.toBe(limited);
    expect(second.saved.at(-1)).toBeNull();
  });

  it("si guardar el resultado falla, lo devuelve igual (el intento lo da por publicado)", async () => {
    const { ctx } = context(null, {
      failSave: (progress) => JSON.stringify(progress).includes("result"),
    });
    await expect(sendOnce(ctx, { send: async () => RESULT })).resolves.toEqual(RESULT);
  });

  it("el progreso de las redes de marca calza con lo que guarda y con el traspaso a mano", () => {
    for (const platform of ["x", "linkedin", "discord", "tiktok"] as const) {
      expect(() =>
        checkPublicationProgress(platform, { send: { startedAt: NOW.toISOString() } }),
      ).not.toThrow();
      expect(() =>
        checkPublicationProgress(platform, {
          manual: { attempt: 1, simulated: true, readyAt: NOW.toISOString(), media: 0 },
        }),
      ).not.toThrow();
      // Lo del publisher se guarda al lado del «enviando» sin perderse.
      expect(
        checkPublicationProgress(platform, {
          uploaded: ["media-1"],
          send: { startedAt: NOW.toISOString() },
        }),
      ).toEqual({ uploaded: ["media-1"], send: { startedAt: NOW.toISOString() } });
      expect(() => checkPublicationProgress(platform, "texto")).toThrow();
      expect(() => checkPublicationProgress(platform, { send: { startedAt: "ayer" } })).toThrow();
    }
    expect(socialProgressSchema.safeParse({ send: {} }).success).toBe(false);
  });

  it("solo OUTCOME_UNKNOWN cuenta como dudoso (IG_PUBLISH_OUTCOME_UNKNOWN sigue en failed hasta T12)", () => {
    expect([...OUTCOME_UNKNOWN_CODES]).toEqual([OUTCOME_UNKNOWN]);
    expect(isOutcomeUnknown(new AppError(OUTCOME_UNKNOWN))).toBe(true);
    expect(isOutcomeUnknown(new AppError("IG_PUBLISH_OUTCOME_UNKNOWN"))).toBe(false);
    expect(isOutcomeUnknown(new Error(OUTCOME_UNKNOWN))).toBe(false);
  });
});

describe("parsePublishedUrl", () => {
  it("Marketplace: el número del aviso y su enlace limpio", () => {
    expect(
      parsePublishedUrl("fb_marketplace", "https://www.facebook.com/marketplace/item/123/?ref=x"),
    ).toEqual({ externalId: "123", url: "https://www.facebook.com/marketplace/item/123/" });
  });

  it("las demás: el enlace https sin la consulta ni el fragmento", () => {
    // Instagram no tiene lector propio (X, LinkedIn y Discord sí, cada uno con su prueba).
    expect(parsePublishedUrl("instagram", "  https://www.instagram.com/p/AbC1/?igsh=1#c ")).toEqual(
      {
        externalId: "https://www.instagram.com/p/AbC1/",
        url: "https://www.instagram.com/p/AbC1/",
      },
    );
  });

  it("LinkedIn: el URN del post (el formato que guarda el publisher) y su enlace limpio", () => {
    expect(
      parsePublishedUrl(
        "linkedin",
        "  https://www.linkedin.com/feed/update/urn:li:share:9/?utm=1#c ",
      ),
    ).toEqual({
      externalId: "urn:li:share:9",
      url: "https://www.linkedin.com/feed/update/urn:li:share:9/",
    });
  });

  it("Discord: el id del mensaje (el mismo que guarda el publisher) y su enlace limpio", () => {
    const clean = "https://discord.com/channels/111/222/333";
    for (const pasted of [
      clean,
      ` ${clean}/ `,
      "https://ptb.discord.com/channels/111/222/333?x=1",
      "https://discordapp.com/channels/111/222/333#a",
      "https://canary.discord.com/channels/111/222/333",
    ]) {
      expect(parsePublishedUrl("discord", pasted)).toEqual({ externalId: "333", url: clean });
    }
    expect(parseDiscordMessageUrl(clean)).toEqual({
      guildId: "111",
      channelId: "222",
      messageId: "333",
      url: clean,
    });
    expect(discordMessageUrl("111", "222", "333")).toBe(clean);
  });

  it("Discord: otro enlace (un canal, un webhook, otro host) es PUBLISHED_URL_INVALID, sin repetirlo", () => {
    for (const value of [
      "https://discord.com/channels/111/222",
      "https://discord.com/channels/@me/222/333",
      "https://discord.com/api/webhooks/1/token-secreto",
      "https://discord.evil.com/channels/111/222/333",
      "http://discord.com/channels/111/222/333",
    ]) {
      const error = (() => {
        try {
          parsePublishedUrl("discord", value);
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error, value).toMatchObject({
        code: "PUBLISHED_URL_INVALID",
        details: { platform: "discord" },
      });
      expect((error as Error).message).not.toContain(value);
    }
  });

  it("rechaza lo que no es un enlace https limpio, sin repetirlo", () => {
    for (const value of [
      "http://x.com/a",
      "https://usuario:clave@x.com/a",
      "https://x.com:8443/a",
      "javascript:alert(1)",
      "https://localhost/a",
      "x.com/a",
      `https://x.com/${"a".repeat(500)}`,
    ]) {
      const error = (() => {
        try {
          parsePublishedUrl("x", value);
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toMatchObject({ code: "PUBLISHED_URL_INVALID" });
      expect((error as Error).message).not.toContain(value);
    }
  });
});

describe("socialCaption", () => {
  const text = { body: "Cuerpo", hashtags: ["#a", "#b"] };
  it("pone los hashtags dentro del texto en las redes que no los separan", () => {
    for (const platform of ["instagram", "linkedin", "x", "tiktok"] as const) {
      expect(socialCaption(platform, text)).toBe("Cuerpo\n\n#a #b");
    }
    expect(socialCaption("linkedin", { body: "Cuerpo", hashtags: [] })).toBe("Cuerpo");
  });

  it("deja solo el cuerpo en Discord, Portal y Marketplace", () => {
    for (const platform of ["discord", "portal_inmobiliario", "fb_marketplace"] as const) {
      expect(socialCaption(platform, text)).toBe("Cuerpo");
    }
  });
});

describe("cuenta a mano", () => {
  it("isManualAccount: Instagram y Portal nunca son a mano, aunque su meta lo diga", () => {
    expect(isManualAccount({ platform: "instagram", meta: { mode: "manual" } })).toBe(false);
    expect(isManualAccount({ platform: "portal_inmobiliario", meta: { mode: "manual" } })).toBe(
      false,
    );
    for (const platform of ["linkedin", "x", "discord", "tiktok"] as const) {
      expect(isManualAccount({ platform, meta: { mode: "manual" } })).toBe(true);
    }
  });

  it("isManualAccount: meta.mode = manual en las redes de marca; en Marketplace, la cuenta a mano de F7", () => {
    expect(isManualAccount({ platform: "linkedin", meta: { mode: "manual" } })).toBe(true);
    expect(isManualAccount({ platform: "linkedin", meta: { mode: "api" } })).toBe(false);
    expect(isManualAccount({ platform: "instagram", meta: {} })).toBe(false);
    expect(
      isManualAccount({
        platform: "fb_marketplace",
        meta: { mode: "manual", connectedAt: NOW.toISOString() },
      }),
    ).toBe(true);
    expect(
      isManualAccount({ platform: "fb_marketplace", meta: {}, externalAccountId: "manual" }),
    ).toBe(true);
  });

  it("requiresManualConfirm: por plataforma (Marketplace) y, con la cuenta, también por cuenta", () => {
    expect(requiresManualConfirm("fb_marketplace")).toBe(true);
    expect(requiresManualConfirm("linkedin")).toBe(false);
    expect(
      requiresManualConfirm("linkedin", { platform: "linkedin", meta: { mode: "manual" } }),
    ).toBe(true);
    expect(requiresManualConfirm("x", { platform: "x", meta: {} })).toBe(false);
  });
});
