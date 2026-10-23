import type { PostImageRequest, PostImageRun, PostImageSource } from "../post-image.js";

export type NewPostImageRun = {
  postId: string;
  brokerId: string;
  source: PostImageSource;
  request: PostImageRequest;
  createdBy: string | null;
};

/** Lo gastado en imágenes con IA por corredor en un rango de fechas de creación. */
export type BrokerImageSpend = { brokerId: string; costUsd: number; images: number };

/**
 * Los pedidos de imágenes de un post (`post_image_runs`, F9.5-T25). Uno activo (en cola o
 * corriendo) por post: un segundo `create` mientras hay uno es `POST_IMAGE_RUN_ACTIVE`. Las marcas
 * de estado devuelven `false` si el pedido ya no estaba en el estado de partida (otro intento lo
 * cerró).
 */
export interface PostImageRunRepository {
  create(input: NewPostImageRun): Promise<PostImageRun>;
  get(id: string): Promise<PostImageRun | null>;
  /** Los últimos de un post, del más nuevo al más viejo. */
  listByPost(postId: string, limit: number): Promise<PostImageRun[]>;
  /** `queued` o `running` → `running` (un reintento vuelve a entrar). */
  markRunning(id: string): Promise<boolean>;
  /** `running` → `succeeded`, con los medios que quedaron en el post. */
  markSucceeded(id: string, mediaIds: readonly string[]): Promise<boolean>;
  /** `queued` o `running` → `failed`. */
  markFailed(id: string, error: { code: string; message: string }): Promise<boolean>;
  /**
   * Reserva el costo de una imagen con IA **antes** de llamar al proveedor, de forma atómica por
   * marca: suma `costUsd` al pedido solo si lo gastado por su marca en `[from, to)` más `costUsd` no
   * pasa `capUsd` (con dos pedidos a la vez de la misma marca, uno espera al otro). Anota el modelo.
   * `false` si no cabe (no anota nada).
   */
  reserveImageCost(
    id: string,
    reservation: { costUsd: number; model: string; capUsd: number; from: Date; to: Date },
  ): Promise<boolean>;
  /** Devuelve una reserva cuando la llamada falló sin cobrar (un 429 o un bloqueo antes de generar). */
  releaseImageCost(id: string, costUsd: number): Promise<void>;
  /** Los pedidos en `queued` (el worker los reencola al arrancar), del más viejo al más nuevo. */
  listQueued(): Promise<PostImageRun[]>;
  /** Cierra como `failed` los `running` que empezaron antes de `startedBefore`; devuelve sus ids. */
  failAbandoned(startedBefore: Date, error: { code: string; message: string }): Promise<string[]>;
  /** Lo gastado en IA por corredor (uno si viene `brokerId`), por la fecha de creación del pedido. */
  sumImageCost(filter: { from: Date; to: Date; brokerId?: string }): Promise<BrokerImageSpend[]>;
}
