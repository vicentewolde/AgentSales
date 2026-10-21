import type { AbortSignalLike } from "../abort.js";

/** Lo que Discord dice de un webhook («Get Webhook with Token»): nada secreto. */
export type DiscordWebhookInfo = {
  /** El id del webhook (el `external_account_id` de la cuenta). */
  id: string;
  /** El nombre que le puso el dueño del servidor (lo que ve el operador). */
  name: string;
  /** El servidor y el canal: `null` si Discord no los informó (NO VERIFICADO, `discord.md` §8). */
  guildId: string | null;
  channelId: string | null;
};

/**
 * Leer un webhook de Discord sin publicar (spec F9 §4.6, F9-T14; `discord.md` §4.2): lo implementa
 * `createDiscordWebhooks` de `@agentsales/publishers`. Solo lee (vale en `dry-run`, ADR-0016). Los
 * errores son `AppError` `DISCORD_*` (`DISCORD_WEBHOOK_NOT_FOUND` si se borró,
 * `DISCORD_WEBHOOK_INVALID` si el token no sirve) y **nunca** llevan la URL del webhook.
 */
export interface DiscordWebhooks {
  get(webhookUrl: string, options?: { signal?: AbortSignalLike }): Promise<DiscordWebhookInfo>;
}
