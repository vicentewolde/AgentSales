import {
  type PostImageBody,
  type PostImageOptionsResponse,
  postImageCardsRemovedResponseSchema,
  postImageOptionsResponseSchema,
  postImageRunResponseSchema,
  postImageStockResponseSchema,
} from "@agentsales/api/contracts";
import { RUN_WAIT } from "@agentsales/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";
import { postKeys } from "./posts.js";

// Conseguir imágenes para un post (F9.5-T25, ADR-0038): las fuentes y los pedidos, buscar en la
// biblioteca y pedir. El worker las consigue (`post.image`) y quedan como medios del post.

export const postImageKeys = {
  options: (postId: string) => [...postKeys.detail(postId), "images"] as const,
};

/** Si el último pedido sigue en cola o consiguiéndose. */
export const imageRunActive = (options: PostImageOptionsResponse | undefined): boolean => {
  const latest = options?.runs[0];
  return latest !== undefined && (latest.status === "queued" || latest.status === "running");
};

/**
 * `GET /posts/:id/images`: las fuentes (y lo que falta), lo propuesto y los últimos pedidos.
 * Mientras el último sigue en curso, se vuelve a pedir cada 2 s (como una corrida).
 */
export function usePostImageOptions(postId: string, enabled: boolean) {
  const client = useApiClient();
  return useQuery({
    queryKey: postImageKeys.options(postId),
    enabled,
    queryFn: ({ signal }) =>
      unwrap(
        client.posts[":id"].images.$get({ param: { id: postId } }, { init: { signal } }),
        postImageOptionsResponseSchema,
      ),
    refetchInterval: (query) => (imageRunActive(query.state.data) ? RUN_WAIT.pollMs : false),
    refetchIntervalInBackground: false,
  });
}

/** `GET /posts/:id/images/stock`: busca en la biblioteca (sin personas, salvo que se pida). */
export function useStockSearch(postId: string) {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (input: { query: string; withPeople: boolean }) =>
      (
        await unwrap(
          client.posts[":id"].images.stock.$get({
            param: { id: postId },
            query: { q: input.query, ...(input.withPeople ? { people: "1" } : {}) },
          }),
          postImageStockResponseSchema,
        )
      ).photos,
  });
}

/**
 * `DELETE /posts/:id/images/cards`: quita las tarjetas de pedidos anteriores del post (nunca una
 * foto o un video que el usuario subió). El detalle del post trae los medios que quedan.
 */
export function useRemovePostCards(postId: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      unwrap(
        client.posts[":id"].images.cards.$delete({ param: { id: postId } }),
        postImageCardsRemovedResponseSchema,
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: postImageKeys.options(postId) });
      void queryClient.invalidateQueries({ queryKey: postKeys.detail(postId), exact: true });
    },
  });
}

/** `POST /posts/:id/images`: pide tarjetas, una foto de la biblioteca o una imagen con IA. */
export function useRequestPostImage(postId: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: PostImageBody) =>
      (
        await unwrap(
          client.posts[":id"].images.$post({ param: { id: postId }, json: body }),
          postImageRunResponseSchema,
        )
      ).run,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: postImageKeys.options(postId) });
    },
  });
}
