import type { PublicationStatus } from "../enums.js";
import { AppError } from "../errors.js";
import {
  type InstagramManualMeta,
  instagramHandleSchema,
  manualInstagramAccountId,
  type PlatformAccount,
} from "../platform-account.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { PublicationRepository } from "../ports/publication-repository.js";
import { requireBroker } from "./connect-account.js";

export type ConnectManualInstagramAccountDeps = {
  brokers: Pick<BrokerRepository, "findBySlug">;
  platformAccounts: Pick<PlatformAccountRepository, "upsertConnected" | "listByBroker">;
  /** Para no dejar publicaciones atadas a una cuenta que se desconecta. */
  publications: Pick<PublicationRepository, "listByStatus">;
};

/**
 * Los estados de una publicación que todavía necesitan su cuenta: si la cuenta se desconecta,
 * quedarían atadas a una cuenta que no publica (visto con X el 2026-10-24: `ACCOUNT_NOT_CONNECTED`).
 */
const NEEDS_ACCOUNT: readonly PublicationStatus[] = [
  "approved",
  "scheduled",
  "publishing",
  "awaiting_manual_confirm",
  "paused",
];

/**
 * Activa Instagram **a mano** para una marca (ADR-0041, spec F9.6 D2; `POST /accounts/instagram/manual`,
 * administrador): una cuenta sin credenciales ni llamadas a Meta (`external_account_id =
 * "manual:<usuario>"`, `meta = { mode: "manual", handle }`). AgentSales deja el texto y las imágenes
 * listos a la hora y el operador publica desde la app de Instagram. Reglas:
 * - el corredor va por su `slug` (`BROKER_NOT_FOUND`) y tiene que ser una marca
 *   (`ACCOUNT_MODE_NOT_SUPPORTED`): los avisos de un corredor usan el id del medio;
 * - el usuario se limpia (`@`, mayúsculas) y se revisa (`INSTAGRAM_HANDLE_INVALID`);
 * - otra cuenta de Instagram de la marca queda desconectada en el mismo paso (una conectada por marca
 *   y plataforma), **salvo** que tenga publicaciones que todavía la necesitan: se niega con
 *   `ACCOUNT_HAS_PENDING_PUBLICATIONS` y el id de una, para que se desprogramen o se descarten antes;
 * - activarla otra vez con el mismo usuario actualiza la misma fila.
 */
export async function connectManualInstagramAccount(
  deps: ConnectManualInstagramAccountDeps,
  { broker: slug, handle }: { broker: string; handle: string },
): Promise<PlatformAccount> {
  const broker = await requireBroker(deps.brokers, slug);
  if (broker.kind !== "brand") {
    throw new AppError(
      "ACCOUNT_MODE_NOT_SUPPORTED",
      "Instagram a mano es solo de las marcas: los avisos de un corredor se publican por la API",
      { details: { broker: slug, platform: "instagram" } },
    );
  }
  const parsed = instagramHandleSchema.safeParse(handle);
  if (!parsed.success) {
    throw new AppError(
      "INSTAGRAM_HANDLE_INVALID",
      parsed.error.issues[0]?.message ?? "El usuario de Instagram no es válido",
      { details: { broker: slug } },
    );
  }
  const externalAccountId = manualInstagramAccountId(parsed.data);
  const others = (await deps.platformAccounts.listByBroker(broker.id, "instagram")).filter(
    (account) => account.status === "connected" && account.externalAccountId !== externalAccountId,
  );
  if (others.length > 0) {
    const ids = new Set(others.map((account) => account.id));
    for (const status of NEEDS_ACCOUNT) {
      const pending = (await deps.publications.listByStatus(status)).find((publication) =>
        ids.has(publication.platformAccountId),
      );
      if (pending !== undefined) {
        throw new AppError(
          "ACCOUNT_HAS_PENDING_PUBLICATIONS",
          "La cuenta de Instagram que se reemplaza tiene publicaciones por salir: desprográmalas o descártalas antes",
          { details: { publicationId: pending.id, status } },
        );
      }
    }
  }
  const meta: InstagramManualMeta = { mode: "manual", handle: parsed.data };
  return deps.platformAccounts.upsertConnected(
    {
      brokerId: broker.id,
      platform: "instagram",
      externalAccountId,
      displayName: `@${parsed.data}`,
      tokenExpiresAt: null,
      meta,
      credentials: null,
    },
    { revokeOthers: true },
  );
}
