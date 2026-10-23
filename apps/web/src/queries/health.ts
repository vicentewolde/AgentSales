import { effectivePublishMode, healthReportSchema, type PublishMode } from "@agentsales/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";
import { brokerKeys, fetchBrokerList } from "./brokers.js";

/** Cada sondeo despierta Neon (ADR-0007): 30 s, solo en la página Estado y con la pestaña visible. */
export const HEALTH_REFETCH_MS = 30_000;

export const healthKeys = { all: ["health"] as const };

/**
 * `/health` compartido por el banner y la página Estado (misma `queryKey`). Solo quien pasa
 * `poll` sondea; el resto se actualiza al montar y al volver a la pestaña.
 */
export function useHealth({ poll = false }: { poll?: boolean } = {}) {
  const client = useApiClient();
  return useQuery({
    queryKey: healthKeys.all,
    queryFn: ({ signal }) =>
      unwrap(client.health.$get(undefined, { init: { signal } }), healthReportSchema),
    refetchInterval: poll ? HEALTH_REFETCH_MS : false,
    refetchIntervalInBackground: false,
  });
}

/**
 * El corredor o la marca del sujeto que se está mirando (una propiedad o un post, F9.5-T22): lo
 * ponen las páginas de un solo sujeto. Con él, `useFreshPublishMode` da el modo de esa marca.
 */
export const SubjectBrokerContext = createContext<string | undefined>(undefined);

/**
 * Pide `/health` de nuevo (sin caché) y devuelve el modo con que se publicaría ahora (D11): lo usa
 * el panel justo antes de publicar, para no confiar en un modo leído al abrir la página. Desde
 * F9.5-T22 (ADR-0036), dentro de un `SubjectBrokerContext` relee también la marca y da su modo
 * efectivo; sin marca, o si no se pudo leer, el del servidor (pregunta de más, nunca de menos).
 */
export function useFreshPublishMode() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const brokerId = useContext(SubjectBrokerContext);
  return async (): Promise<PublishMode> => {
    const server = (
      await queryClient.fetchQuery({
        queryKey: healthKeys.all,
        queryFn: ({ signal }) =>
          unwrap(client.health.$get(undefined, { init: { signal } }), healthReportSchema),
        staleTime: 0,
      })
    ).publishMode;
    if (brokerId === undefined) return server;
    const brokers = await queryClient
      .fetchQuery({
        queryKey: brokerKeys.all,
        queryFn: ({ signal }) => fetchBrokerList(client, signal),
        staleTime: 0,
      })
      .catch(() => undefined);
    const broker = brokers?.find((item) => item.id === brokerId);
    return broker === undefined ? server : effectivePublishMode(server, broker);
  };
}
