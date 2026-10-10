import { rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  AppError,
  type BrokerRepository,
  connectMarketplaceAccount,
  isAppError,
  type PlatformAccountRepository,
  recordMarketplaceLoginError,
} from "@agentsales/core";
import {
  FACEBOOK_HOME_URL,
  isMarketplaceProfileInUse,
  MARKETPLACE_ERRORS,
  type MarketplaceProfile,
  marketplaceProfileDir,
  marketplaceProfileLockPath,
  waitForSession,
} from "@agentsales/publishers/marketplace";
import type { MarketplaceWindows } from "../marketplace/windows.js";
import { defineJob, type Job, type QueuePolicy } from "./define.js";

/** Cuánto espera el login a que el operador inicie sesión (spec F5 §4.2). */
export const MARKETPLACE_LOGIN_WAIT_MS = 10 * 60_000;
/** Cuánto espera el login a que se libere un perfil tomado (una ventana de publicar). */
export const MARKETPLACE_PROFILE_BUSY_WAIT_MS = 30_000;

/**
 * Política de `marketplace.profile` (spec F5 §4.11): `exclusive` por corredor (`singletonKey =
 * brokerId`: iniciar sesión y olvidar el perfil nunca se cruzan), sin reintentos (el operador lo
 * pide de nuevo) y expira a los 15 min (la espera del login es de 10).
 */
export const MARKETPLACE_PROFILE_QUEUE: QueuePolicy = {
  policy: "exclusive",
  retryLimit: 0,
  retryDelay: 0,
  retryBackoff: false,
  expireInSeconds: 15 * 60,
};

export type MarketplaceProfileJobDeps = {
  /** `BROWSER_PROFILES_DIR` ya resuelta (`resolveBrowserProfilesDir`), absoluta. */
  profilesRoot: string;
  /** Abre el perfil del corredor con ventana (los tests, con un doble). */
  openProfile(brokerId: string): Promise<MarketplaceProfile>;
  windows: Pick<MarketplaceWindows, "closeForBroker">;
  brokers: Pick<BrokerRepository, "findById">;
  platformAccounts: Pick<
    PlatformAccountRepository,
    "upsertConnected" | "listByBroker" | "mergeMeta"
  >;
  signal: AbortSignal;
  now?: () => Date;
  loginWaitMs?: number;
  busyWaitMs?: number;
  pollMs?: number;
};

const codeOf = (error: unknown) => (isAppError(error) ? error.code : "INTERNAL_ERROR");

/** Abre el perfil; si está tomado, reintenta hasta `busyWaitMs` (una ventana de publicar se cierra). */
async function openWhenFree(deps: MarketplaceProfileJobDeps, brokerId: string) {
  const deadline = Date.now() + (deps.busyWaitMs ?? MARKETPLACE_PROFILE_BUSY_WAIT_MS);
  for (;;) {
    try {
      return await deps.openProfile(brokerId);
    } catch (error) {
      if (
        !(isAppError(error) && error.code === "MARKETPLACE_PROFILE_BUSY") ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((done) => setTimeout(done, deps.pollMs ?? 2_000));
    }
  }
}

/** La carpeta del perfil, solo si queda dentro de la raíz de los perfiles (nunca borra otra cosa). */
function profileDirInside(root: string, brokerId: string): string {
  const dir = resolve(marketplaceProfileDir(root, brokerId));
  const rel = relative(resolve(root), dir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new AppError("MARKETPLACE_PROFILE_PATH_INVALID", "La carpeta del perfil no es válida");
  }
  return dir;
}

/**
 * Job `marketplace.profile` (spec F5 §4.2 y §4.11, ADR-0017):
 * - `login`: abre la ventana del perfil en Facebook y espera hasta 10 min a que el operador inicie
 *   sesión **a mano** (el sistema no escribe ni hace clic). Con la sesión, conecta la cuenta
 *   (`connectMarketplaceAccount`) y cierra la ventana. Si falla (tope, perfil tomado, ventana
 *   cerrada, Chromium), anota el código en la cuenta (`lastLoginError`), si existe, y termina.
 * - `forget`: cierra las ventanas del corredor y borra la carpeta del perfil y su candado (solo
 *   dentro de `BROWSER_PROFILES_DIR`; idempotente). Si otro proceso tiene el perfil abierto
 *   (`fb:smoke`), `MARKETPLACE_PROFILE_BUSY` sin borrar nada.
 * No mira `PUBLISH_MODE`: no publica (ADR-0017 punto 7). El registro solo lleva ids y códigos.
 */
export function marketplaceProfileJob(deps: MarketplaceProfileJobDeps): Job {
  return defineJob({
    name: "marketplace.profile",
    queue: MARKETPLACE_PROFILE_QUEUE,
    errorLogFields: (error) => ({ code: codeOf(error) }),
    handler: async (data, { logger }) => {
      if (data.action === "forget") {
        await deps.windows.closeForBroker(data.brokerId);
        const dir = profileDirInside(deps.profilesRoot, data.brokerId);
        if (await isMarketplaceProfileInUse(dir)) throw MARKETPLACE_ERRORS.profileBusy();
        await rm(dir, { recursive: true, force: true });
        await rm(marketplaceProfileLockPath(dir), { force: true });
        logger.info("perfil de Marketplace borrado");
        return;
      }
      let profile: MarketplaceProfile | undefined;
      try {
        profile = await openWhenFree(deps, data.brokerId);
        await profile.page.goto(FACEBOOK_HOME_URL).catch(() => undefined);
        logger.info("ventana de Facebook abierta: el operador inicia sesión a mano");
        const userId = await waitForSession(profile, {
          timeoutMs: deps.loginWaitMs ?? MARKETPLACE_LOGIN_WAIT_MS,
          signal: deps.signal,
          ...(deps.pollMs === undefined ? {} : { pollMs: deps.pollMs }),
        });
        const account = await connectMarketplaceAccount(
          {
            brokers: deps.brokers,
            platformAccounts: deps.platformAccounts,
            ...(deps.now ? { now: deps.now } : {}),
          },
          {
            brokerId: data.brokerId,
            userId,
            ...(data.label === undefined ? {} : { label: data.label }),
          },
        );
        logger.info({ accountId: account.id }, "cuenta de Marketplace conectada");
      } catch (error) {
        logger.warn({ code: codeOf(error) }, "no se pudo conectar la cuenta de Marketplace");
        await recordMarketplaceLoginError(
          { platformAccounts: deps.platformAccounts, ...(deps.now ? { now: deps.now } : {}) },
          { brokerId: data.brokerId, code: codeOf(error) },
        ).catch(() => null);
      } finally {
        await profile?.close();
      }
    },
  });
}
