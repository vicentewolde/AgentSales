import type { AbortSignalLike } from "../abort.js";
import { AppError } from "../errors.js";
import {
  type DiscordAccountMeta,
  discordAccountMetaSchema,
  discordWebhookParts,
  discordWebhookUrlSchema,
  INSTAGRAM_PUBLISH_SCOPE,
  type InstagramAccountMeta,
  instagramAccountMetaSchema,
  type PlatformAccount,
} from "../platform-account.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { DiscordWebhooks } from "../ports/discord-webhooks.js";
import type { InstagramAuth } from "../ports/instagram-auth.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";

/** Vigencia de un token largo de Instagram: se estima cuando no se canjea (token del panel). */
export const INSTAGRAM_TOKEN_DAYS = 60;

export type ConnectAccountDeps = {
  brokers: Pick<BrokerRepository, "findBySlug">;
  platformAccounts: Pick<PlatformAccountRepository, "upsertConnected">;
  /** Instagram Login: el canje del código (OAuth) y `/me`. */
  instagram: Pick<InstagramAuth, "exchangeCode" | "me">;
  now?: () => Date;
};

/**
 * El corredor de una conexión por su slug, o `BROKER_NOT_FOUND` (lo comparten Instagram y Mercado
 * Libre).
 */
export async function requireBroker(brokers: Pick<BrokerRepository, "findBySlug">, slug: string) {
  const broker = await brokers.findBySlug(slug);
  if (broker === null) {
    throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${slug}`, {
      details: { broker: slug },
    });
  }
  return broker;
}

/**
 * Cómo llega el acceso: el código de la vuelta del OAuth, o el token largo del botón Generate token
 * del panel de Meta (spec F3 §4.6 y D4: Meta no acepta `http://localhost`).
 */
export type AccountGrant =
  | { kind: "oauth_code"; code: string }
  | { kind: "token"; accessToken: string };

/**
 * Conecta la cuenta de Instagram de un corredor (spec F3 §4.6):
 * 1. el corredor (`broker`, su slug) tiene que existir (`BROKER_NOT_FOUND`);
 * 2. con el código del OAuth, lo canjea por el token largo y **exige el permiso de publicar**
 *    (`IG_PERMISSION_DENIED` si falta); con el token del panel no hay canje: los permisos quedan
 *    desconocidos (`null`) y el vencimiento se estima a 60 días (`tokenExpiryEstimated`);
 * 3. lee la cuenta (`/me`) y la guarda conectada, con el token cifrado por el repositorio. Otra
 *    cuenta de Instagram del corredor queda desconectada en el mismo paso (una conectada por
 *    corredor y plataforma). Reconectar la misma cuenta actualiza su fila.
 * Los errores de Instagram (`IG_*`) pasan tal cual; ninguno lleva el token ni el código.
 */
export async function connectAccount(
  deps: ConnectAccountDeps,
  {
    broker: slug,
    grant,
    signal,
  }: { broker: string; grant: AccountGrant; signal?: AbortSignalLike },
): Promise<PlatformAccount> {
  const broker = await requireBroker(deps.brokers, slug);
  const now = deps.now ?? (() => new Date());
  const options = signal === undefined ? {} : { signal };

  let accessToken: string;
  let tokenExpiresAt: Date;
  let permissions: string[] | null;
  if (grant.kind === "oauth_code") {
    const exchanged = await deps.instagram.exchangeCode(grant.code, options);
    if (!exchanged.permissions.includes(INSTAGRAM_PUBLISH_SCOPE)) {
      throw new AppError(
        "IG_PERMISSION_DENIED",
        "La cuenta no dio permiso para publicar: vuelve a conectar y acepta todos los permisos",
        { details: { permissions: exchanged.permissions } },
      );
    }
    ({ accessToken, expiresAt: tokenExpiresAt, permissions } = exchanged);
  } else {
    accessToken = grant.accessToken.trim();
    tokenExpiresAt = new Date(now().getTime() + INSTAGRAM_TOKEN_DAYS * 24 * 60 * 60 * 1000);
    permissions = null;
  }

  const profile = await deps.instagram.me(accessToken, options);
  const connectedAt = now().toISOString();
  const meta: InstagramAccountMeta = instagramAccountMetaSchema.parse({
    accountType: profile.accountType,
    permissions,
    connectedAt,
    tokenRefreshedAt: grant.kind === "oauth_code" ? connectedAt : null,
    tokenExpiryEstimated: grant.kind === "token",
  });
  return deps.platformAccounts.upsertConnected(
    {
      brokerId: broker.id,
      platform: "instagram",
      externalAccountId: profile.userId,
      displayName: `@${profile.username}`,
      tokenExpiresAt,
      meta,
      credentials: { accessToken },
    },
    { revokeOthers: true },
  );
}

export type ConnectDiscordAccountDeps = {
  brokers: Pick<BrokerRepository, "findBySlug">;
  platformAccounts: Pick<PlatformAccountRepository, "upsertConnected">;
  /** Lee el webhook sin publicar («Get Webhook with Token»). */
  discord: DiscordWebhooks;
  now?: () => Date;
};

/**
 * Conecta el webhook de un canal de Discord a una marca (spec F9 §4.6 y §4.7, F9-T14):
 * 1. el corredor (`broker`, su slug) tiene que existir (`BROKER_NOT_FOUND`);
 * 2. la URL tiene que ser la de un webhook (`discordWebhookUrlSchema`, de T02), o
 *    `DISCORD_WEBHOOK_URL_INVALID`;
 * 3. la lee en Discord **sin publicar** (`DISCORD_WEBHOOK_NOT_FOUND` si se borró,
 *    `DISCORD_WEBHOOK_INVALID` si el token no sirve; pasan tal cual) y exige que sea el mismo
 *    webhook de la URL;
 * 4. la guarda conectada, con la URL cifrada por el repositorio como credencial (`{ webhookUrl }`),
 *    el id del webhook como cuenta externa y su nombre a la vista. Sin vencimiento: un webhook no
 *    vence (se borra). Un canal por marca: otro webhook de Discord de la marca queda desconectado
 *    en el mismo paso; reconectar el mismo actualiza su fila.
 * Ningún error lleva la URL ni su token.
 */
export async function connectDiscordAccount(
  deps: ConnectDiscordAccountDeps,
  {
    broker: slug,
    webhookUrl: pasted,
    signal,
  }: { broker: string; webhookUrl: string; signal?: AbortSignalLike },
): Promise<PlatformAccount> {
  const broker = await requireBroker(deps.brokers, slug);
  const parsed = discordWebhookUrlSchema.safeParse(pasted.trim());
  if (!parsed.success) {
    throw new AppError(
      "DISCORD_WEBHOOK_URL_INVALID",
      "No es la URL de un webhook de Discord: cópiala en Ajustes del servidor > Integraciones > Webhooks (Copiar URL del webhook)",
    );
  }
  const webhookUrl = parsed.data;
  const { id } = discordWebhookParts(webhookUrl);
  const info = await deps.discord.get(webhookUrl, signal === undefined ? {} : { signal });
  if (info.id !== id) {
    throw new AppError(
      "DISCORD_UNEXPECTED_RESPONSE",
      "Discord respondió con otro webhook: vuelve a intentarlo",
    );
  }
  const now = deps.now ?? (() => new Date());
  const meta: DiscordAccountMeta = discordAccountMetaSchema.parse({
    webhookName: info.name,
    guildId: info.guildId,
    channelId: info.channelId,
    connectedAt: now().toISOString(),
  });
  return deps.platformAccounts.upsertConnected(
    {
      brokerId: broker.id,
      platform: "discord",
      externalAccountId: info.id,
      displayName: info.name,
      tokenExpiresAt: null,
      meta,
      credentials: { webhookUrl },
    },
    { revokeOthers: true },
  );
}
