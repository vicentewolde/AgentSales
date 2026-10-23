import {
  dailyReadinessResponseSchema,
  postWeekApproveResponseSchema,
  postWeekResponseSchema,
} from "@agentsales/api/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "../api/client.js";
import { useApiClient } from "../api/context.js";
import { accountKeys } from "./accounts.js";
import { calendarKeys } from "./calendar.js";
import { planKeys } from "./plans.js";
import { postKeys } from "./posts.js";
import { trackingKeys } from "./tracking.js";

// Publicar a diario desde una marca (F9.5-T27): la semana por aprobar, «Aprobar la semana» y la
// lista «Lista para publicar a diario». Las reglas son de core; aquí solo se piden y se refrescan.

export const brandWeekKeys = {
  all: ["brand-week"] as const,
  week: (brokerId: string, day: string) => [...brandWeekKeys.all, "week", brokerId, day] as const,
  /** Bajo las cuentas: conectar, desconectar o cambiar el modo de una la vuelve a pedir. */
  readiness: (brokerId: string) => [...accountKeys.all, "daily-readiness", brokerId] as const,
};

/** `GET /brokers/:id/week?day=`: los posts aceptados de la semana con sus textos. */
export function usePostWeek(brokerId: string, day: string, enabled = true) {
  const client = useApiClient();
  return useQuery({
    queryKey: brandWeekKeys.week(brokerId, day),
    enabled,
    queryFn: ({ signal }) =>
      unwrap(
        client.brokers[":id"].week.$get(
          { param: { id: brokerId }, query: { day } },
          { init: { signal } },
        ),
        postWeekResponseSchema,
      ),
  });
}

/** `POST /brokers/:id/week/approve`: aprueba y programa la semana; refresca lo que cambió. */
export function useApprovePostWeek(brokerId: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (day: string) =>
      unwrap(
        client.brokers[":id"].week.approve.$post({ param: { id: brokerId }, json: { day } }),
        postWeekApproveResponseSchema,
      ),
    onSettled: () => {
      for (const queryKey of [
        brandWeekKeys.all,
        planKeys.all,
        postKeys.all,
        calendarKeys.all,
        trackingKeys.all,
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}

/** `GET /brokers/:id/daily-readiness`: la lista para publicar a diario de una marca. */
export function useDailyReadiness(brokerId: string, enabled = true) {
  const client = useApiClient();
  return useQuery({
    queryKey: brandWeekKeys.readiness(brokerId),
    enabled,
    queryFn: async ({ signal }) =>
      (
        await unwrap(
          client.brokers[":id"]["daily-readiness"].$get(
            { param: { id: brokerId } },
            { init: { signal } },
          ),
          dailyReadinessResponseSchema,
        )
      ).readiness,
  });
}
