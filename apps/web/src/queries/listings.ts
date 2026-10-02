import {
  type ListingDetailResponse,
  type ListingQuery,
  type ListingStatusBody,
  listingDetailResponseSchema,
  listingListResponseSchema,
  listingStatusResponseSchema,
} from "@agentsales/api/contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";

/**
 * Las portadas y la galería traen URLs firmadas que vencen en `SIGNED_URL_TTL_SECONDS` (1 h). Los
 * datos se consideran frescos 5 min y se descartan a los 15 sin uso: siempre bien antes de que
 * venzan, así una imagen guardada en caché no queda rota.
 */
export const LISTINGS_STALE_MS = 5 * 60 * 1000;
export const LISTINGS_GC_MS = 15 * 60 * 1000;

export const listingKeys = {
  all: ["listings"] as const,
  lists: () => [...listingKeys.all, "list"] as const,
  list: (filters: ListingQuery) => [...listingKeys.lists(), filters] as const,
  detail: (id: string) => [...listingKeys.all, "detail", id] as const,
};

/** `GET /listings` con los filtros de la URL (exactos). */
export function useListings(filters: ListingQuery) {
  const client = useApiClient();
  return useQuery({
    queryKey: listingKeys.list(filters),
    queryFn: async ({ signal }) =>
      (
        await unwrap(
          client.listings.$get({ query: filters }, { init: { signal } }),
          listingListResponseSchema,
        )
      ).listings,
    // Al cambiar un filtro se siguen viendo los resultados anteriores hasta que llegan los nuevos.
    placeholderData: keepPreviousData,
    staleTime: LISTINGS_STALE_MS,
    gcTime: LISTINGS_GC_MS,
  });
}

/** `GET /listings/:id`: el aviso, sus medios en orden y las etiquetas de sus atributos. */
export function useListing(id: string) {
  const client = useApiClient();
  return useQuery({
    queryKey: listingKeys.detail(id),
    queryFn: ({ signal }) =>
      unwrap(
        client.listings[":id"].$get({ param: { id } }, { init: { signal } }),
        listingDetailResponseSchema,
      ),
    staleTime: LISTINGS_STALE_MS,
    gcTime: LISTINGS_GC_MS,
  });
}

/**
 * `PATCH /listings/:id/status`. Al responder, el detalle toma el aviso nuevo (sin volver a pedir
 * las URLs) y las listas se invalidan, porque el estado es un filtro.
 */
export function useChangeListingStatus(id: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (status: ListingStatusBody["status"]) =>
      (
        await unwrap(
          client.listings[":id"].status.$patch({ param: { id }, json: { status } }),
          listingStatusResponseSchema,
        )
      ).listing,
    onSuccess: async (listing) => {
      // Conserva la hora de la carga original: las URLs de la galería son de entonces, y no deben
      // parecer recién pedidas (vencen a la hora).
      const key = listingKeys.detail(id);
      queryClient.setQueryData<ListingDetailResponse>(
        key,
        (current) => (current ? { ...current, listing } : current),
        { updatedAt: queryClient.getQueryState(key)?.dataUpdatedAt },
      );
      await queryClient.invalidateQueries({ queryKey: listingKeys.lists() });
    },
  });
}
