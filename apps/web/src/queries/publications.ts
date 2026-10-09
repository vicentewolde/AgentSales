import {
  contentApproveResponseSchema,
  contentUnapproveResponseSchema,
  listingPublicationsResponseSchema,
  listingPublishResponseSchema,
  type PublicationView,
  publicationEventsResponseSchema,
  publicationOperationResponseSchema,
  publicationPublishResponseSchema,
  publicationResponseSchema,
  publicationRetireResponseSchema,
  publicationSyncResponseSchema,
  type SkippedPublicationView,
} from "@agentsales/api/contracts";
import type { Platform } from "@agentsales/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";
import { waitStart } from "../components/publications/publications.js";
import { contentKeys } from "./content.js";
import { LISTINGS_GC_MS, LISTINGS_STALE_MS, listingKeys } from "./listings.js";
import { usePolledRun } from "./run-poll.js";

export const publicationKeys = {
  all: ["publications"] as const,
  listing: (listingId: string) => [...publicationKeys.all, "listing", listingId] as const,
  /**
   * Una, en la versión que trajo el listado (`updatedAt`): un reintento hecho desde otra pestaña o la
   * CLI empieza un sondeo nuevo, en vez de quedarse con el resultado anterior (que, terminado, ya no
   * se vuelve a pedir). En esta pestaña lo cubre además la invalidación después de cada acción.
   */
  one: (id: string, version: number) => [...publicationKeys.all, "one", id, version] as const,
  events: (id: string) => [...publicationKeys.all, "events", id] as const,
};

/** Una publicación sigue en curso mientras está en `publishing` (la deja así la API al publicar). */
export const isPublishing = (status: PublicationView["status"]) => status === "publishing";

/**
 * `GET /listings/:id/publications`: las publicaciones del aviso, con miniaturas firmadas (solo las
 * pendientes). Se pide al cargar y después de cada acción; para sondear una, `usePublicationPoll`.
 */
export function useListingPublications(listingId: string) {
  const client = useApiClient();
  return useQuery({
    queryKey: publicationKeys.listing(listingId),
    queryFn: async ({ signal }) =>
      (
        await unwrap(
          client.listings[":id"].publications.$get(
            { param: { id: listingId } },
            { init: { signal } },
          ),
          listingPublicationsResponseSchema,
        )
      ).publications,
    staleTime: LISTINGS_STALE_MS,
    gcTime: LISTINGS_GC_MS,
  });
}

/**
 * Lo que cambia al terminar o al hacer algo con una publicación: el listado del aviso, las bitácoras
 * abiertas y el aviso (que pasa a `active` al publicar en vivo). El texto solo cambia al aprobar o
 * quitar la aprobación (`withContent`). Las consultas de una publicación en curso se renuevan solas
 * (llevan la versión del listado).
 */
function useRefreshAfter(listingId: string, { withContent = false } = {}) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: publicationKeys.listing(listingId) });
    void queryClient.invalidateQueries({ queryKey: [...publicationKeys.all, "events"] });
    void queryClient.invalidateQueries({ queryKey: listingKeys.detail(listingId) });
    void queryClient.invalidateQueries({ queryKey: listingKeys.lists() });
    if (withContent) {
      void queryClient.invalidateQueries({ queryKey: contentKeys.listing(listingId) });
    }
  };
}

/**
 * `GET /publications/:id`, sondeada cada 2 s mientras está en `publishing` (`RUN_WAIT`, como una
 * corrida). El tope de 2 h cuenta desde el más reciente entre `updatedAt` y `requestedAt` (la hora
 * del clic): reencolar una que ya estaba en `publishing` no cambia `updatedAt` (spec F3-T18). Al
 * terminar mientras se mira, vuelve a pedir el listado, el texto y el aviso.
 */
export function usePublicationPoll(
  listingId: string,
  publication: PublicationView,
  requestedAt: Date | null,
) {
  const client = useApiClient();
  const refresh = useRefreshAfter(listingId);
  const polled = usePolledRun<PublicationView>({
    queryKey: publicationKeys.one(publication.id, publication.updatedAt.getTime()),
    enabled: isPublishing(publication.status),
    fetch: async (signal) =>
      (
        await unwrap(
          client.publications[":id"].$get({ param: { id: publication.id } }, { init: { signal } }),
          publicationResponseSchema,
        )
      ).publication,
    isTerminal: (status) => !isPublishing(status),
    startedAt: (current) => waitStart(current.updatedAt, requestedAt),
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` es nuevo en cada render; basta con el cambio de `finishedHere`.
  useEffect(() => {
    if (polled.finishedHere) refresh();
  }, [polled.finishedHere]);
  return polled;
}

/** `GET /publications/:id/events`: la bitácora, solo cuando se abre. */
export function usePublicationEvents(id: string, enabled: boolean) {
  const client = useApiClient();
  return useQuery({
    queryKey: publicationKeys.events(id),
    enabled,
    queryFn: async ({ signal }) =>
      (
        await unwrap(
          client.publications[":id"].events.$get({ param: { id } }, { init: { signal } }),
          publicationEventsResponseSchema,
        )
      ).events,
  });
}

/** `POST /contents/:id/approve` o `/unapprove`. */
export function useApproval(listingId: string) {
  const client = useApiClient();
  const refresh = useRefreshAfter(listingId, { withContent: true });
  return useMutation({
    // Devuelve los formatos que no se abrieron (una publicación activa de un texto anterior).
    mutationFn: async ({
      contentId,
      approve,
    }: {
      contentId: string;
      approve: boolean;
    }): Promise<{ skipped: SkippedPublicationView[] }> => {
      if (!approve) {
        await unwrap(
          client.contents[":id"].unapprove.$post({ param: { id: contentId } }),
          contentUnapproveResponseSchema,
        );
        return { skipped: [] };
      }
      const { skipped } = await unwrap(
        client.contents[":id"].approve.$post({ param: { id: contentId } }),
        contentApproveResponseSchema,
      );
      return { skipped };
    },
    onSettled: refresh,
  });
}

/** `POST /listings/:id/publish`: el canal; el modo lo pone la API (`PUBLISH_MODE`). */
export function usePublishListing(listingId: string) {
  const client = useApiClient();
  const refresh = useRefreshAfter(listingId);
  return useMutation({
    mutationFn: (platform: Platform) =>
      unwrap(
        client.listings[":id"].publish.$post({ param: { id: listingId }, json: { platform } }),
        listingPublishResponseSchema,
      ),
    onSettled: refresh,
  });
}

export type PublicationAction =
  | { kind: "publish"; id: string }
  | { kind: "cancel"; id: string }
  | { kind: "retire"; id: string; removedByHand: boolean }
  // Portal (spec F4 §4.9, desde F4-T22): síncronas en la API; cerrar en vivo va confirmado.
  | { kind: "pause"; id: string }
  | { kind: "resume"; id: string }
  | { kind: "close"; id: string; confirmed: boolean }
  | { kind: "sync"; id: string };

/**
 * Lo que devolvió la acción: `listingBackToReady` al retirar o cerrar la última en vivo; `queued` al
 * pedir la lectura (`false`: ya había una programada).
 */
export type PublicationActionResult = { listingBackToReady?: boolean; queued?: boolean };

/** Publicar o reintentar una, descartarla, marcarla como retirada y, en Portal, operarla. */
export function usePublicationAction(listingId: string) {
  const client = useApiClient();
  const refresh = useRefreshAfter(listingId);
  return useMutation({
    mutationFn: async (action: PublicationAction): Promise<PublicationActionResult> => {
      const param = { id: action.id };
      switch (action.kind) {
        case "publish":
          await unwrap(
            client.publications[":id"].publish.$post({ param }),
            publicationPublishResponseSchema,
          );
          return {};
        case "cancel":
          await unwrap(
            client.publications[":id"].cancel.$post({ param }),
            publicationResponseSchema,
          );
          return {};
        case "retire": {
          const { listingBackToReady } = await unwrap(
            client.publications[":id"].retire.$post({
              param,
              json: action.removedByHand ? { removedByHand: true } : {},
            }),
            publicationRetireResponseSchema,
          );
          return { listingBackToReady };
        }
        case "pause":
          await unwrap(
            client.publications[":id"].pause.$post({ param }),
            publicationOperationResponseSchema,
          );
          return {};
        case "resume":
          await unwrap(
            client.publications[":id"].resume.$post({ param }),
            publicationOperationResponseSchema,
          );
          return {};
        case "close": {
          const { listingBackToReady } = await unwrap(
            client.publications[":id"].close.$post({
              param,
              json: action.confirmed ? { confirmed: true } : {},
            }),
            publicationOperationResponseSchema,
          );
          return { listingBackToReady };
        }
        case "sync": {
          const { queued } = await unwrap(
            client.publications[":id"].sync.$post({ param }),
            publicationSyncResponseSchema,
          );
          return { queued };
        }
      }
    },
    onSettled: refresh,
  });
}

/**
 * Después de pedir la lectura (Actualizar), el worker la hace en unos segundos: quien la pidió vuelve
 * a pedir el listado una vez pasado ese rato (`usePublicationsRefresh`), mientras siga abierto.
 */
export const SYNC_REFRESH_MS = 8_000;

/** Vuelve a pedir lo que cambia con una publicación (el listado, las bitácoras y el aviso). */
export const usePublicationsRefresh = (listingId: string) => useRefreshAfter(listingId);
