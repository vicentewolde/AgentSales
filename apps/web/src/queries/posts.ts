import {
  type ContentEditBody,
  type ContentView,
  type CreatePostBody,
  contentApproveResponseSchema,
  contentEditResponseSchema,
  contentRunRequestResponseSchema,
  contentUnapproveResponseSchema,
  type EditorialProfileBody,
  editorialProfileResponseSchema,
  type PostDetailResponse,
  type PostScheduleResponse,
  postDetailResponseSchema,
  postListResponseSchema,
  postPublishResponseSchema,
  postResponseSchema,
  postScheduleResponseSchema,
  publicationConfirmResponseSchema,
  publicationPublishResponseSchema,
  publicationResponseSchema,
  type UpdatePostBody,
} from "@agentsales/api/contracts";
import {
  isTerminalContentRun,
  type Language,
  type PostPlatform,
  type PostStatus,
  RUN_WAIT,
} from "@agentsales/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";
import type { OutcomeAction } from "../components/publications/OutcomeBox.js";
import { trackingKeys } from "./tracking.js";

// Contenido de marca en el panel (spec F9 §4.10, F9-T17): los posts, sus textos por red e idioma,
// sus medios, publicar y programar, resolver una publicación dudosa o confirmar una a mano, y el
// perfil editorial de la marca. Todo por la API (las reglas son de core).

export const postKeys = {
  all: ["posts"] as const,
  lists: () => [...postKeys.all, "list"] as const,
  list: (filters: { brokerId?: string | undefined; status?: PostStatus | undefined }) =>
    [...postKeys.lists(), filters] as const,
  detail: (id: string) => [...postKeys.all, "detail", id] as const,
  profile: (brokerId: string) => [...postKeys.all, "profile", brokerId] as const,
};

/** Las URLs firmadas del detalle duran lo que el resto del panel: se vuelve a pedir a los 5 min. */
const POST_STALE_MS = 5 * 60 * 1000;

/** `GET /posts`: los del alcance (el corredor o marca elegido) y, si se pide, de un estado. */
export function usePosts(filters: { brokerId?: string | undefined; status?: PostStatus }) {
  const client = useApiClient();
  return useQuery({
    queryKey: postKeys.list(filters),
    queryFn: async ({ signal }) =>
      (
        await unwrap(
          client.posts.$get(
            {
              query: {
                ...(filters.brokerId === undefined ? {} : { brokerId: filters.brokerId }),
                ...(filters.status === undefined ? {} : { status: filters.status }),
              },
            },
            { init: { signal } },
          ),
          postListResponseSchema,
        )
      ).posts,
  });
}

/**
 * Lo que sigue en curso en un post y vale volver a mirar: una corrida de textos en cola o
 * corriendo, una publicación publicándose, un medio sin sus variantes ("procesando…") o archivos
 * grandes que el worker todavía revisa (`uploadsInReview`, F9-T17: lo cuenta la API, así que se ve
 * igual al recargar y se apaga si el archivo resultó duplicado o se perdió).
 */
export function postInProgress(detail: PostDetailResponse): boolean {
  const run = detail.latestRun;
  if (run !== null && !isTerminalContentRun(run.status)) return true;
  if (detail.publications.some((publication) => publication.status === "publishing")) return true;
  if (detail.uploadsInReview > 0) return true;
  return detail.media.some((item) => mediaProcessing(item));
}

/** Un medio al que le faltan sus variantes: el worker las está armando (`post.media`). */
export const mediaProcessing = (item: PostDetailResponse["media"][number]) =>
  item.kind === "image"
    ? !item.variants.includes("thumb") || !item.variants.includes("ig_4x5")
    : !item.variants.includes("thumb") || !item.variants.includes("x_video");

/** Cada cuánto se vuelve a mirar un post con algo en curso (como una corrida: `RUN_WAIT`). */
export const POST_POLL_MS = RUN_WAIT.pollMs;

/**
 * `GET /posts/:id`: el post, sus medios, sus textos con su revisión, la última corrida y sus
 * publicaciones. Mientras algo sigue en curso (`postInProgress`) se vuelve a pedir cada 2 s, hasta
 * el tope de `RUN_WAIT` (2 h): así algo atascado no mantiene Neon despierto con la pestaña abierta.
 */
export function usePost(id: string) {
  const client = useApiClient();
  const since = useRef<number | null>(null);
  return useQuery({
    queryKey: postKeys.detail(id),
    queryFn: ({ signal }) =>
      unwrap(
        client.posts[":id"].$get({ param: { id } }, { init: { signal } }),
        postDetailResponseSchema,
      ),
    staleTime: POST_STALE_MS,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data === undefined || !postInProgress(data)) {
        since.current = null;
        return false;
      }
      since.current ??= Date.now();
      return Date.now() - since.current < RUN_WAIT.maxWaitMs ? POST_POLL_MS : false;
    },
    refetchIntervalInBackground: false,
  });
}

/** Lo que cambia con un post: su detalle, las listas y el seguimiento (que muestra posts). */
function useRefreshPost(id: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: postKeys.detail(id) });
    void queryClient.invalidateQueries({ queryKey: postKeys.lists() });
    void queryClient.invalidateQueries({ queryKey: trackingKeys.all });
  };
}

/** `POST /posts`: un post manual en borrador. */
export function useCreatePost() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreatePostBody) =>
      (await unwrap(client.posts.$post({ json: body }), postResponseSchema)).post,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: postKeys.lists() });
      void queryClient.invalidateQueries({ queryKey: trackingKeys.all });
    },
  });
}

/** `PATCH /posts/:id`: tema, brief, tipo, línea o fecha planeada. */
export function useUpdatePost(id: string) {
  const client = useApiClient();
  const refresh = useRefreshPost(id);
  return useMutation({
    mutationFn: async (body: UpdatePostBody) =>
      (await unwrap(client.posts[":id"].$patch({ param: { id }, json: body }), postResponseSchema))
        .post,
    onSettled: refresh,
  });
}

/** `POST /posts/:id/archive`. */
export function useArchivePost(id: string) {
  const client = useApiClient();
  const refresh = useRefreshPost(id);
  return useMutation({
    mutationFn: async () =>
      (await unwrap(client.posts[":id"].archive.$post({ param: { id } }), postResponseSchema)).post,
    onSettled: refresh,
  });
}

/** `POST /posts/:id/draft`: pide los textos a la IA (con `replaceEdits`, también los editados). */
export function useRequestPostDraft(id: string) {
  const client = useApiClient();
  const refresh = useRefreshPost(id);
  return useMutation({
    mutationFn: (replaceEdits: boolean) =>
      unwrap(
        client.posts[":id"].draft.$post({
          param: { id },
          json: replaceEdits ? { replaceEdits: true } : {},
        }),
        contentRunRequestResponseSchema,
      ),
    onSettled: refresh,
  });
}

type ContentTarget = { platform: PostPlatform; language: Language };

/**
 * `PATCH /posts/:id/contents/:platform/:language`: guarda una edición. La respuesta trae el texto con
 * su revisión nueva (el panel no revisa por su cuenta: necesita el perfil de la marca), que
 * reemplaza al de la caché.
 */
export function useEditPostContent(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ platform, language, edit }: ContentTarget & { edit: ContentEditBody }) =>
      (
        await unwrap(
          client.posts[":id"].contents[":platform"][":language"].$patch({
            param: { id, platform, language },
            json: edit,
          }),
          contentEditResponseSchema,
        )
      ).content,
    onSuccess: (saved: ContentView) => {
      const key = postKeys.detail(id);
      queryClient.setQueryData<PostDetailResponse>(
        key,
        (current) =>
          current && {
            ...current,
            contents: current.contents.map((item) => (item.id === saved.id ? saved : item)),
          },
        // Conserva la hora de la carga: las URLs firmadas del detalle son de entonces.
        { updatedAt: queryClient.getQueryState(key)?.dataUpdatedAt },
      );
    },
  });
}

/** `POST …/approve` o `…/unapprove` del texto de una red e idioma. */
export function usePostApproval(id: string) {
  const client = useApiClient();
  const refresh = useRefreshPost(id);
  return useMutation({
    mutationFn: async ({ platform, language, approve }: ContentTarget & { approve: boolean }) => {
      const param = { id, platform, language };
      const route = client.posts[":id"].contents[":platform"][":language"];
      if (approve) {
        await unwrap(route.approve.$post({ param }), contentApproveResponseSchema);
      } else {
        await unwrap(route.unapprove.$post({ param }), contentUnapproveResponseSchema);
      }
    },
    onSettled: refresh,
  });
}

/** `POST /posts/:id/publish`: una red del post (todos sus idiomas); el modo lo pone la API. */
export function usePublishPost(id: string) {
  const client = useApiClient();
  const refresh = useRefreshPost(id);
  return useMutation({
    mutationFn: (platform: PostPlatform) =>
      unwrap(
        client.posts[":id"].publish.$post({ param: { id }, json: { platform } }),
        postPublishResponseSchema,
      ),
    onSettled: refresh,
  });
}

/** `POST /posts/:id/schedule`: las redes elegidas a una hora (ISO con zona, leída en hora de Chile). */
export function useSchedulePost(id: string) {
  const client = useApiClient();
  const refresh = useRefreshPost(id);
  return useMutation({
    mutationFn: (body: { platforms?: PostPlatform[]; at: string }): Promise<PostScheduleResponse> =>
      unwrap(
        client.posts[":id"].schedule.$post({ param: { id }, json: body }),
        postScheduleResponseSchema,
      ),
    onSettled: refresh,
  });
}

/**
 * Lo que se hace con una publicación de un post: reintentar una fallida, descartarla o
 * desprogramarla; decir si salió una con resultado dudoso (`resolve`, ADR-0029 punto 8) y
 * confirmar (con su enlace; LinkedIn también `withoutUrl`) o no una que se publica a mano
 * (LinkedIn, TikTok): estas últimas son las de `OutcomeBox`.
 */
export type PostPublicationAction =
  | { kind: "publish"; id: string }
  | { kind: "cancel"; id: string }
  | { kind: "unschedule"; id: string }
  | OutcomeAction;

export function usePostPublicationAction(postId: string) {
  const client = useApiClient();
  const refresh = useRefreshPost(postId);
  return useMutation({
    mutationFn: async (action: PostPublicationAction): Promise<void> => {
      const param = { id: action.id };
      const route = client.publications[":id"];
      switch (action.kind) {
        case "publish":
          await unwrap(route.publish.$post({ param }), publicationPublishResponseSchema);
          return;
        case "cancel":
          await unwrap(route.cancel.$post({ param }), publicationResponseSchema);
          return;
        case "unschedule":
          await unwrap(route.unschedule.$post({ param }), publicationResponseSchema);
          return;
        case "resolve":
          await unwrap(
            route.resolve.$post({
              param,
              json: {
                outcome: action.outcome,
                ...(action.url === undefined ? {} : { url: action.url }),
              },
            }),
            publicationConfirmResponseSchema,
          );
          return;
        case "confirm":
          await unwrap(
            route.confirm.$post({
              param,
              json:
                action.url !== undefined
                  ? { url: action.url }
                  : action.withoutUrl === true
                    ? { withoutUrl: true }
                    : {},
            }),
            publicationConfirmResponseSchema,
          );
          return;
        case "not-published":
          await unwrap(route["not-published"].$post({ param }), publicationResponseSchema);
          return;
      }
    },
    onSettled: refresh,
  });
}

/** `GET /brokers/:id/editorial-profile`: el guardado o, si no tiene, el vacío por defecto. */
export function useEditorialProfile(brokerId: string | undefined) {
  const client = useApiClient();
  return useQuery({
    queryKey: postKeys.profile(brokerId ?? ""),
    enabled: brokerId !== undefined,
    queryFn: async ({ signal }) =>
      (
        await unwrap(
          client.brokers[":id"]["editorial-profile"].$get(
            { param: { id: brokerId ?? "" } },
            { init: { signal } },
          ),
          editorialProfileResponseSchema,
        )
      ).profile,
  });
}

/** `PUT /brokers/:id/editorial-profile`: el perfil completo (lo revisa core, con errores por campo). */
export function useSaveEditorialProfile(brokerId: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: EditorialProfileBody) =>
      (
        await unwrap(
          client.brokers[":id"]["editorial-profile"].$put({ param: { id: brokerId }, json: body }),
          editorialProfileResponseSchema,
        )
      ).profile,
    onSuccess: (profile) => {
      queryClient.setQueryData(postKeys.profile(brokerId), profile);
    },
  });
}
