import type { MediaStorage, Publisher } from "@agentsales/core";
import {
  createMarketplacePublisher,
  type MarketplaceProfile,
  type MarketplacePublisherDeps,
} from "@agentsales/publishers/marketplace";
import { readPictureFrom } from "../portal.js";
import type { MarketplaceWindows } from "./windows.js";

export type WorkerMarketplacePublisherDeps = {
  /** Abre el perfil del corredor (en el worker, con ventana; los tests, sin ella y sin red). */
  openProfile(brokerId: string): Promise<MarketplaceProfile>;
  /** Las fotos fijadas en la publicación (`pi_4x3`) se leen de R2. */
  storage: Pick<MediaStorage, "get">;
  /** `<workspace>/tmp/marketplace` (`marketplaceTmpRootOf`). */
  tmpRoot: string;
  /** El registro de ventanas del worker (spec F5 §4.5). */
  windows: Pick<MarketplaceWindows, "hold" | "closeForAccount">;
  /** El ritmo y los topes (los tests: sin pausas y con topes cortos). */
  tuning?: Pick<MarketplacePublisherDeps, "fill" | "formWaitMs" | "profileBusyWaitMs" | "maxMs">;
};

/**
 * El publisher de Marketplace del worker (spec F5 §4.4, F5-T10): las fotos desde R2, el perfil del
 * corredor y el registro de ventanas, que cierra antes la ventana vieja de la cuenta y recibe la del
 * formulario listo (`hold`; la activa el job si el intento termina en `awaiting_manual_confirm`).
 */
export function createWorkerMarketplacePublisher(deps: WorkerMarketplacePublisherDeps): Publisher {
  return createMarketplacePublisher({
    openProfile: deps.openProfile,
    readPhoto: readPictureFrom(deps.storage),
    tmpRoot: deps.tmpRoot,
    closeAccountWindows: (accountId) => deps.windows.closeForAccount(accountId),
    onHandoff: (ref, window) => deps.windows.hold(ref, window),
    ...deps.tuning,
  });
}
