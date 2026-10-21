import type { AbortSignalLike } from "../abort.js";
import { AppError } from "../errors.js";
import {
  LINKEDIN_DEFAULT_MODE,
  LINKEDIN_PUBLISH_SCOPE,
  type LinkedInAccountMeta,
  type LinkedInAccountMode,
  linkedinAccountMetaSchema,
  linkedinMemberIdSchema,
} from "../linkedin.js";
import { MANUAL_MODE_PLATFORMS, type PlatformAccount } from "../platform-account.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { LinkedInAuth } from "../ports/linkedin-auth.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import { requireBroker } from "./connect-account.js";

export type ConnectLinkedInAccountDeps = {
  brokers: Pick<BrokerRepository, "findBySlug">;
  platformAccounts: Pick<PlatformAccountRepository, "upsertConnected" | "listByBroker">;
  /** OAuth de LinkedIn: el canje del código y `/v2/userinfo`. */
  linkedin: Pick<LinkedInAuth, "exchangeCode" | "me">;
  now?: () => Date;
};

/**
 * Conecta el perfil personal de LinkedIn de una marca o corredor con el código de la autorización
 * (spec F9 §4.6 y §4.7, F9-T15). Quien llama ya verificó el `state` (firma, vencimiento,
 * plataforma, marca y un solo uso):
 * 1. el corredor (`broker`, su slug) tiene que existir (`BROKER_NOT_FOUND`);
 * 2. canjea el código de inmediato y, si LinkedIn informó los permisos, **exige** `w_member_social`
 *    (`LINKEDIN_PERMISSION_DENIED`);
 * 3. lee el miembro (`/v2/userinfo`): su `sub` es la cuenta externa (`LINKEDIN_UNEXPECTED_RESPONSE`
 *    si no tiene forma de id);
 * 4. la guarda conectada con el token cifrado por el repositorio (`{ accessToken }`) y
 *    `token_expires_at` a 60 días (lo que dijo el canje): **no se renueva sola**, la agenda avisa 7
 *    días antes (T08) y se reconecta. El modo queda `manual` (D5) salvo que se reconecte el mismo
 *    perfil que el administrador ya había pasado a `api` (y no desconectado): reconectar cada dos
 *    meses no le cambia el modo. Otra cuenta de LinkedIn de la marca queda desconectada.
 * Los errores de LinkedIn (`LINKEDIN_*`) pasan tal cual; ninguno lleva el código ni el token.
 */
export async function connectLinkedInAccount(
  deps: ConnectLinkedInAccountDeps,
  { broker: slug, code, signal }: { broker: string; code: string; signal?: AbortSignalLike },
): Promise<PlatformAccount> {
  const broker = await requireBroker(deps.brokers, slug);
  const now = deps.now ?? (() => new Date());
  const options = signal === undefined ? {} : { signal };

  const exchanged = await deps.linkedin.exchangeCode(code, options);
  if (exchanged.scopes !== null && !exchanged.scopes.includes(LINKEDIN_PUBLISH_SCOPE)) {
    throw new AppError(
      "LINKEDIN_PERMISSION_DENIED",
      "La autorización de LinkedIn no trae el permiso para publicar (w_member_social): revisa que la app tenga el producto Share on LinkedIn y conecta de nuevo",
      { details: { scopes: exchanged.scopes } },
    );
  }
  const member = await deps.linkedin.me(exchanged.accessToken, options);
  if (!linkedinMemberIdSchema.safeParse(member.memberId).success) {
    throw new AppError(
      "LINKEDIN_UNEXPECTED_RESPONSE",
      "LinkedIn respondió algo inesperado al leer el perfil: conecta de nuevo",
      { details: { call: "userinfo", reason: "member_id" } },
    );
  }

  const previous = (await deps.platformAccounts.listByBroker(broker.id, "linkedin")).find(
    (account) => account.externalAccountId === member.memberId && account.status !== "revoked",
  );
  const mode: LinkedInAccountMode =
    previous !== undefined && previous.meta.mode === "api" ? "api" : LINKEDIN_DEFAULT_MODE;
  const meta: LinkedInAccountMeta = linkedinAccountMetaSchema.parse({
    mode,
    scopes: exchanged.scopes,
    connectedAt: now().toISOString(),
  });
  return deps.platformAccounts.upsertConnected(
    {
      brokerId: broker.id,
      platform: "linkedin",
      externalAccountId: member.memberId,
      displayName: member.name.trim() === "" ? `LinkedIn ${member.memberId}` : member.name.trim(),
      tokenExpiresAt: exchanged.expiresAt,
      meta,
      credentials: { accessToken: exchanged.accessToken },
    },
    { revokeOthers: true },
  );
}

export type SetAccountModeDeps = {
  platformAccounts: Pick<PlatformAccountRepository, "get" | "mergeMeta">;
};

/**
 * Cambia el modo de una cuenta de una red de contenido de marca (ADR-0029 punto 9; spec F9 §4.6,
 * D5): `manual` (el intento deja el texto y los medios listos, sin llamar a la red) o `api`. Solo
 * el administrador (la ruta es `admin`). En LinkedIn, pasar a `api` solo debe hacerse **después de S2
 * y S3** (spec F9 §4.8); este caso de uso no lo impide a propósito: la barrera real hoy es
 * `PUBLISH_MODE=dry-run` (en `dry-run` ninguna cuenta escribe en la red, ADR-0016). Errores (no
 * reintentables): `ACCOUNT_NOT_FOUND`, y
 * `ACCOUNT_MODE_NOT_SUPPORTED` si la plataforma no está en `MANUAL_MODE_PLATFORMS` (Instagram,
 * Portal; Marketplace tiene su propio modo a mano, ADR-0023). Devuelve la cuenta y si cambió.
 */
export async function setAccountMode(
  deps: SetAccountModeDeps,
  { accountId, mode }: { accountId: string; mode: LinkedInAccountMode },
): Promise<{ account: PlatformAccount; changed: boolean }> {
  const account = await deps.platformAccounts.get(accountId);
  if (account === null) {
    throw new AppError("ACCOUNT_NOT_FOUND", `No existe la cuenta ${accountId}`, {
      details: { accountId },
    });
  }
  if (!(MANUAL_MODE_PLATFORMS as readonly string[]).includes(account.platform)) {
    throw new AppError(
      "ACCOUNT_MODE_NOT_SUPPORTED",
      "Esta cuenta no tiene modo a mano o por API: solo las redes de contenido de marca (LinkedIn, X, Discord, TikTok)",
      { details: { accountId, platform: account.platform } },
    );
  }
  if (account.meta.mode === mode) return { account, changed: false };
  return { account: await deps.platformAccounts.mergeMeta(accountId, { mode }), changed: true };
}
