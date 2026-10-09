import {
  AppError,
  isAppError,
  isMercadoLibreRejectedAfterRefresh,
  type PlatformContext,
  type PortalSellerContact,
  type PublishedRef,
  type Publisher,
  portalProgressSchema,
  type RemoteStatus,
} from "@agentsales/core";
import type { MercadoLibreCallOptions } from "./http.js";
import type { MercadoLibreItem, MercadoLibreItems, MercadoLibreWritableStatus } from "./items.js";
import { type MercadoLibreTokenContext, withMercadoLibreToken } from "./token.js";

/** El estado de un ítem como lo guarda core (`remote_state`, sin `checkedAt`, que pone core). */
export function remoteStatusOf(item: MercadoLibreItem): RemoteStatus {
  return {
    status: item.status,
    subStatus: item.subStatus,
    stopTime: item.stopTime,
    expirationTime: item.expirationTime,
  };
}

/**
 * La etiqueta de un ítem pausado por moderación (doc "Moderaciones con pausado": se buscan con
 * `tags=moderation_penalty&status=paused`). Que venga en `tags` del ítem es INFERENCIA de esa
 * búsqueda; lo confirma la demo en `live`.
 */
export const MERCADOLIBRE_MODERATION_TAG = "moderation_penalty";

/**
 * Las moderaciones que nombra la doc, con texto propio (el de Mercado Libre no se guarda). Otra
 * cualquiera se muestra con su código.
 */
const MODERATION_MESSAGES: Record<string, string> = {
  ABANDONED_ITEM_REX_DEN:
    "Mercado Libre la pausó porque la reportaron como no disponible: si se vendió o arrendó, ciérrala; si no, reactívala",
  PAUSED_PREVENTION_PRICE:
    "Mercado Libre la pausó por un cambio inusual de precio: revisa el precio antes de reactivarla",
  ABANDONED_ITEM_PERFORMANCE_WARNING:
    "Mercado Libre la pausó por llevar mucho tiempo sin resultados: revisa que esté al día antes de reactivarla",
  PICTURE_DOWNLOAD_PENDING: "Mercado Libre no pudo cargar las fotos",
};

/** El motivo de la pausa, con el código de la moderación y un texto propio (`remote_state.reason`). */
function moderationReason(name: string | null): NonNullable<RemoteStatus["reason"]> {
  const code = name ?? "unknown";
  const known = name === null ? undefined : MODERATION_MESSAGES[name];
  return {
    code,
    message: known ?? `Mercado Libre la pausó por moderación (${code})`,
  };
}

/**
 * Pausar, reactivar, cerrar y leer el estado de un ítem publicado (spec F4 §4.8 y §4.9): lo que
 * implementa el publisher de Portal (que delega aquí) y lo que compone la API (T19) sin las fotos ni
 * el catálogo. La API pasa un cliente con el tope de 10 s (`MERCADOLIBRE_API_TIMEOUT_MS`).
 */
export type PortalOperations = Required<
  Pick<Publisher, "pause" | "resume" | "close" | "getStatus">
>;

export type PortalOperationsOptions = {
  items: Pick<MercadoLibreItems, "get" | "setStatus" | "getLastModeration">;
};

/** Un progreso que no sirve para cambiar el estado: no se llama a Mercado Libre. */
const progressUnusable = (reason: "missing_contact" | "other_item" | "unreadable") =>
  new AppError(
    "PORTAL_PROGRESS_UNUSABLE",
    reason === "other_item"
      ? "Lo guardado de esta publicación es de otro aviso de Mercado Libre: revísala en Mercado Libre y cámbiala a mano"
      : "No está guardado el contacto con que se creó el aviso en Mercado Libre: cámbialo a mano en Mercado Libre",
    { details: { reason } },
  );

/**
 * El `seller_contact` enviado al crear el ítem (spec F4 §4.5): Mercado Libre lo exige completo en
 * cada escritura, y se usa el guardado (no el actual del corredor) para que un cambio de WhatsApp
 * no impida cerrar. El progreso tiene que ser del mismo ítem.
 */
function sellerContactOf(ref: PublishedRef): PortalSellerContact {
  const parsed = portalProgressSchema.safeParse(ref.progress);
  if (!parsed.success)
    throw progressUnusable(ref.progress == null ? "missing_contact" : "unreadable");
  const { itemId, sellerContact } = parsed.data;
  if (itemId !== undefined && itemId !== ref.externalId) throw progressUnusable("other_item");
  if (sellerContact === undefined) throw progressUnusable("missing_contact");
  return sellerContact;
}

/**
 * Las operaciones sobre un ítem de Portal (spec F4 §4.8):
 * - `pause` (`paused`), `resume` (`active`) y `close` (`closed`, **irreversible**) mandan el estado
 *   con el `seller_contact` del progreso y devuelven el estado del ítem que respondió Mercado Libre;
 *   sin contacto guardado, o con el progreso de otro ítem, `PORTAL_PROGRESS_UNUSABLE` sin llamar.
 * - `getStatus` lee el ítem y, si está pausado por moderación, el motivo (`reason`). El motivo es
 *   secundario: si leerlo falla, el estado vuelve sin él, salvo un token rechazado otra vez o un
 *   corte (esos suben: la cuenta queda vencida o el worker se apaga).
 * Un 401 se refresca una vez con `rejectedToken` en cada llamada (`withMercadoLibreToken`).
 */
export function createPortalOperations(options: PortalOperationsOptions): PortalOperations {
  const { items } = options;

  const call = <T>(
    ctx: PlatformContext,
    run: (token: string, callOptions: MercadoLibreCallOptions) => Promise<T>,
  ) => {
    const tokenCtx: MercadoLibreTokenContext = {
      accessToken: ctx.accessToken,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    };
    return withMercadoLibreToken(tokenCtx, (token, signal) =>
      run(token, signal === undefined ? {} : { signal }),
    );
  };

  const setStatus = async (
    ref: PublishedRef,
    ctx: PlatformContext,
    status: MercadoLibreWritableStatus,
  ): Promise<RemoteStatus> => {
    const contact = sellerContactOf(ref);
    const item = await call(ctx, (token, callOptions) =>
      items.setStatus(token, ref.externalId, status, contact, callOptions),
    );
    return remoteStatusOf(item);
  };

  return {
    pause: (ref, ctx) => setStatus(ref, ctx, "paused"),
    resume: (ref, ctx) => setStatus(ref, ctx, "active"),
    close: (ref, ctx) => setStatus(ref, ctx, "closed"),

    async getStatus(ref, ctx) {
      const item = await call(ctx, (token, callOptions) =>
        items.get(token, ref.externalId, callOptions),
      );
      const status = remoteStatusOf(item);
      if (item.status !== "paused" || !item.tags.includes(MERCADOLIBRE_MODERATION_TAG)) {
        return status;
      }
      try {
        const moderation = await call(ctx, (token, callOptions) =>
          items.getLastModeration(token, ref.externalId, callOptions),
        );
        return moderation === null
          ? status
          : { ...status, reason: moderationReason(moderation.name) };
      } catch (error) {
        if (isMercadoLibreRejectedAfterRefresh(error)) throw error;
        if (isAppError(error) && error.code === "ML_ABORTED") throw error;
        return status;
      }
    },
  };
}
