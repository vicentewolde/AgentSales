import { marketplaceItemUrl } from "@agentsales/core";
import type { Frame } from "playwright";
import { pathOf } from "./guard.js";
import type { MarketplaceProfile } from "./profile.js";
import { MARKETPLACE_CREATE_PATH, MARKETPLACE_ITEM_PATH } from "./selectors.js";

/** Por qué terminó la espera sin ver el aviso: el operador cerró la ventana o venció el tope. */
export type MarketplaceWindowClosedReason = "closed" | "timeout";

export type MarketplaceWindowWatch = {
  /** El aviso recién publicado (enlace limpio): se llama una sola vez, y después la ventana se cierra. */
  onItemUrl(url: string): void | Promise<void>;
  /** La ventana se cerró sin ver el aviso: se llama una sola vez. */
  onClosed(reason: MarketplaceWindowClosedReason): void | Promise<void>;
};

/**
 * La ventana con el formulario listo, entregada al worker (spec F5 §4.5, ADR-0017). Es lo único que
 * toca Playwright después del llenado, y solo lee la dirección de la pestaña (D5).
 */
export type MarketplaceWindow = {
  /** Empieza a vigilar. Una sola vez por ventana. */
  watch(handlers: MarketplaceWindowWatch, options: { timeoutMs: number }): void;
  /** Si la ventana sigue abierta. */
  isOpen(): boolean;
  /** Cierra la ventana y libera el perfil (sin avisar `onClosed`). Idempotente. */
  close(): Promise<void>;
};

/**
 * Crea la ventana vigilada sobre el perfil con el formulario en su pestaña principal.
 * - **Reconocer el aviso:** solo la pestaña del formulario, y solo la **primera** navegación que
 *   sale del flujo de crear (`/marketplace/create/…`): si va a `/marketplace/item/<id>`, es el aviso
 *   recién publicado (`onItemUrl`); si va a cualquier otro lado, se deja de mirar (el operador pega
 *   el enlace). Otras pestañas y navegaciones posteriores se ignoran: un aviso ajeno que el operador
 *   abra no se confunde con el suyo. Que Facebook lleve a esa ruta después de Publicar es NO
 *   VERIFICADO (nota §4.2).
 * - **Cierre:** si el operador cierra la ventana, `onClosed("closed")`; si vence el tope, la cierra
 *   y `onClosed("timeout")`.
 */
export function createMarketplaceWindow(profile: MarketplaceProfile): MarketplaceWindow {
  let watching = false;
  let done = false;
  let closingOnPurpose = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const finish = () => {
    done = true;
    if (timer !== undefined) clearTimeout(timer);
  };

  const close = async () => {
    closingOnPurpose = true;
    finish();
    await profile.close();
  };

  return {
    watch(handlers, { timeoutMs }) {
      if (watching) throw new Error("La ventana de Marketplace ya se está vigilando");
      watching = true;
      const { page, context } = profile;
      let armed = MARKETPLACE_CREATE_PATH.test(pathOf(page.url()));

      const onNavigated = (frame: Frame) => {
        if (done || !armed || frame !== page.mainFrame()) return;
        const path = pathOf(frame.url());
        if (MARKETPLACE_CREATE_PATH.test(path)) return;
        armed = false;
        const itemId = MARKETPLACE_ITEM_PATH.exec(path)?.[1];
        if (itemId === undefined) return;
        finish();
        void Promise.resolve(handlers.onItemUrl(marketplaceItemUrl(itemId))).finally(() => close());
      };
      page.on("framenavigated", onNavigated);

      const onWindowClosed = () => {
        if (done || closingOnPurpose) return;
        finish();
        void handlers.onClosed("closed");
      };
      page.on("close", onWindowClosed);
      context.on("close", onWindowClosed);
      if (!profile.isOpen()) onWindowClosed();

      timer = setTimeout(() => {
        if (done) return;
        finish();
        closingOnPurpose = true;
        void profile.close().finally(() => handlers.onClosed("timeout"));
      }, timeoutMs);
      timer.unref?.();
    },
    isOpen: () => profile.isOpen(),
    close,
  };
}
