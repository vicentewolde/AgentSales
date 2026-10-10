import { marketplaceProfileActionPending } from "../marketplace/limits.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { JobQueue } from "../ports/job-queue.js";
import { requireBroker } from "./connect-account.js";

export type RequestMarketplaceLoginDeps = {
  brokers: Pick<BrokerRepository, "findBySlug">;
  queue: JobQueue;
  now?: () => Date;
};

/**
 * Pide iniciar sesión en Facebook para Marketplace (spec F5 §4.2, ADR-0017;
 * `POST /accounts/marketplace/login`): encola `marketplace.profile` con `action: "login"` y la hora
 * del pedido (`requestedAt`), con la que el worker sabe si la cuenta se desconectó después, y la
 * CLI y el panel, cuándo llegó el resultado (`marketplaceLoginOutcome`). El worker abre la ventana
 * de Chromium en cualquier modo: no publica (punto 7 del ADR). Errores: `BROKER_NOT_FOUND` y
 * `MARKETPLACE_PROFILE_ACTION_PENDING` (409) si ya hay otra acción del perfil en cola.
 */
export async function requestMarketplaceLogin(
  deps: RequestMarketplaceLoginDeps,
  { broker: slug, label }: { broker: string; label?: string },
): Promise<{ brokerId: string; requestedAt: Date }> {
  const broker = await requireBroker(deps.brokers, slug);
  const requestedAt = (deps.now ?? (() => new Date()))();
  const trimmed = label?.trim();
  const queued = await deps.queue.enqueue(
    "marketplace.profile",
    {
      brokerId: broker.id,
      action: "login",
      requestedAt: requestedAt.toISOString(),
      ...(trimmed === undefined || trimmed === "" ? {} : { label: trimmed }),
    },
    { singletonKey: broker.id },
  );
  if (queued === null) throw marketplaceProfileActionPending(broker.id);
  return { brokerId: broker.id, requestedAt };
}
