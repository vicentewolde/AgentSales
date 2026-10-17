import {
  type BrokerRepository,
  type ContentRunRepository,
  chileMonthOf,
  monthlySpend,
} from "@agentsales/core";
import { Hono } from "hono";
import type { AppEnv } from "../auth.js";
import { type UsageResponse, usageQuerySchema } from "../contracts/index.js";
import { requestScope } from "../scope.js";
import { validated } from "../validation.js";

export type UsageRoutesDeps = {
  contentRuns: Pick<ContentRunRepository, "sumLlmCost">;
  brokers: Pick<BrokerRepository, "list">;
  now?: () => Date;
};

/**
 * `GET /usage?month=AAAA-MM` (spec F7 §4.7): el gasto de IA estimado del mes de Chile de cada
 * corredor del alcance (el administrador, todos; un corredor, el suyo), con su tope.
 */
export function usageRoutes(deps: UsageRoutesDeps) {
  return new Hono<AppEnv>().get("/", validated("query", usageQuerySchema), async (c) => {
    const month = c.req.valid("query").month ?? chileMonthOf((deps.now ?? (() => new Date()))());
    const brokers = await monthlySpend(deps, { month, scope: requestScope(c) });
    const body: UsageResponse = { month, brokers };
    return c.json(body, 200);
  });
}
