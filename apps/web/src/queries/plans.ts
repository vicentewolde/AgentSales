import {
  contentRunRequestResponseSchema,
  ideaAcceptResponseSchema,
  type PlanDetailResponse,
  type PlanRequestBody,
  planDetailResponseSchema,
  planListResponseSchema,
  planRequestResponseSchema,
  postResponseSchema,
  type UpdatePostBody,
} from "@agentsales/api/contracts";
import { isTerminalContentRun, RUN_WAIT } from "@agentsales/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";
import { postKeys } from "./posts.js";
import { trackingKeys } from "./tracking.js";

// El plan de ideas en el panel (spec F9 §4.9 y §4.10, F9-T21): pedirlo, seguirlo mientras la IA
// propone, y aceptar, editar o descartar sus ideas. Todo por la API (las reglas son de core).

export const planKeys = {
  all: ["plans"] as const,
  list: (brokerId: string | undefined) => [...planKeys.all, "list", brokerId ?? null] as const,
  detail: (id: string) => [...planKeys.all, "detail", id] as const,
};

/** `GET /plans`: los planes de la marca (el administrador la manda; un corredor ve los suyos). */
export function usePlans(brokerId: string | undefined, enabled = true) {
  const client = useApiClient();
  return useQuery({
    queryKey: planKeys.list(brokerId),
    enabled,
    queryFn: async ({ signal }) =>
      (
        await unwrap(
          client.plans.$get(
            { query: brokerId === undefined ? {} : { brokerId } },
            { init: { signal } },
          ),
          planListResponseSchema,
        )
      ).plans,
  });
}

/**
 * Lo que sigue en curso en un plan y vale volver a mirar: el plan en cola o corriendo, o los textos
 * de una idea aceptada que la IA está redactando.
 */
export function planInProgress(detail: PlanDetailResponse): boolean {
  if (detail.plan.status === "queued" || detail.plan.status === "running") return true;
  return detail.ideas.some(
    (idea) => idea.latestRun !== null && !isTerminalContentRun(idea.latestRun.status),
  );
}

/**
 * `GET /plans/:id`: el plan, su reporte y sus ideas. Mientras algo sigue en curso
 * (`planInProgress`) se vuelve a pedir cada 2 s, hasta el tope de `RUN_WAIT` (2 h): así un plan
 * atascado no mantiene Neon despierto con la pestaña abierta.
 */
export function usePlan(id: string | undefined) {
  const client = useApiClient();
  // Desde cuándo se sondea este plan: al elegir otro plan, el tope de 2 h cuenta de nuevo.
  const since = useRef<number | null>(null);
  const polledId = useRef(id);
  if (polledId.current !== id) {
    polledId.current = id;
    since.current = null;
  }
  return useQuery({
    queryKey: planKeys.detail(id ?? ""),
    enabled: id !== undefined,
    queryFn: ({ signal }) =>
      unwrap(
        client.plans[":id"].$get({ param: { id: id ?? "" } }, { init: { signal } }),
        planDetailResponseSchema,
      ),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined || !planInProgress(data)) {
        since.current = null;
        return false;
      }
      since.current ??= Date.now();
      return Date.now() - since.current < RUN_WAIT.maxWaitMs ? RUN_WAIT.pollMs : false;
    },
    refetchIntervalInBackground: false,
  });
}

/** Lo que cambia con una idea: el plan, las listas de posts, su detalle y el seguimiento. */
function useRefreshPlan(planId: string | undefined) {
  const queryClient = useQueryClient();
  return (postId?: string) => {
    if (planId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: planKeys.detail(planId) });
    }
    void queryClient.invalidateQueries({ queryKey: postKeys.lists() });
    if (postId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: postKeys.detail(postId) });
    }
    void queryClient.invalidateQueries({ queryKey: trackingKeys.all });
  };
}

/** `POST /plans`: pide un plan (o devuelve el que la marca ya tiene en curso). */
export function useRequestPlan() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PlanRequestBody) =>
      unwrap(client.plans.$post({ json: body }), planRequestResponseSchema),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: planKeys.all });
    },
  });
}

/** `POST /posts/:id/accept`: la idea pasa a borrador y la IA redacta sus textos. */
export function useAcceptIdea(planId: string | undefined) {
  const client = useApiClient();
  const refresh = useRefreshPlan(planId);
  return useMutation({
    mutationFn: (postId: string) =>
      unwrap(client.posts[":id"].accept.$post({ param: { id: postId } }), ideaAcceptResponseSchema),
    onSettled: (_data, _error, postId) => refresh(postId),
  });
}

/** `POST /posts/:id/discard`: la idea se archiva (no se vuelve a proponer en 60 días). */
export function useDiscardIdea(planId: string | undefined) {
  const client = useApiClient();
  const refresh = useRefreshPlan(planId);
  return useMutation({
    mutationFn: async (postId: string) =>
      (
        await unwrap(
          client.posts[":id"].discard.$post({ param: { id: postId } }),
          postResponseSchema,
        )
      ).post,
    onSettled: (_data, _error, postId) => refresh(postId),
  });
}

/** `PATCH /posts/:id` de una idea: el brief, la fecha o las redes. */
export function useUpdateIdea(planId: string | undefined) {
  const client = useApiClient();
  const refresh = useRefreshPlan(planId);
  return useMutation({
    mutationFn: async ({ postId, body }: { postId: string; body: UpdatePostBody }) =>
      (
        await unwrap(
          client.posts[":id"].$patch({ param: { id: postId }, json: body }),
          postResponseSchema,
        )
      ).post,
    onSettled: (_data, _error, { postId }) => refresh(postId),
  });
}

/**
 * "Redactar lo aceptado": pide los textos (`POST /posts/:id/draft`) de cada idea aceptada que quedó
 * sin textos (por ejemplo, si la cola no estaba al aceptarla), una tras otra. Si una falla, sigue
 * con las demás y devuelve los errores por post.
 */
export function useDraftAccepted(planId: string | undefined) {
  const client = useApiClient();
  const refresh = useRefreshPlan(planId);
  return useMutation({
    mutationFn: async (postIds: readonly string[]) => {
      const failed: { postId: string; error: Error }[] = [];
      for (const postId of postIds) {
        try {
          await unwrap(
            client.posts[":id"].draft.$post({ param: { id: postId }, json: {} }),
            contentRunRequestResponseSchema,
          );
        } catch (error) {
          failed.push({ postId, error: error instanceof Error ? error : new Error(String(error)) });
        }
      }
      return failed;
    },
    onSettled: () => refresh(),
  });
}
