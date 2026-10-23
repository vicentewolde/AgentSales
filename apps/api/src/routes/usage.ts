import {
  type BrokerRepository,
  type ContentRunRepository,
  chileMonthOf,
  type ImageAiPricing,
  monthlyImageSpend,
  monthlySpend,
  type PostImageRunRepository,
} from "@agentsales/core";
import { Hono } from "hono";
import type { AppEnv } from "../auth.js";
import { type UsageResponse, usageQuerySchema } from "../contracts/index.js";
import { requestScope } from "../scope.js";
import { validated } from "../validation.js";

export type UsageRoutesDeps = {
  contentRuns: Pick<ContentRunRepository, "sumLlmCost">;
  brokers: Pick<BrokerRepository, "list">;
  /** El gasto en imágenes con IA (F9.5-T25), aparte del de texto, con su precio y su tope. */
  postImageRuns: Pick<PostImageRunRepository, "sumImageCost">;
  imageAiPricing: ImageAiPricing;
  now?: () => Date;
};

/**
 * `GET /usage?month=AAAA-MM` (spec F7 §4.7): el gasto de IA estimado del mes de Chile de cada
 * corredor del alcance (el administrador, todos; un corredor, el suyo), con su tope; y, aparte, el
 * de las imágenes con IA (F9.5-T25), con el tope del servidor.
 */
export function usageRoutes(deps: UsageRoutesDeps) {
  return new Hono<AppEnv>().get("/", validated("query", usageQuerySchema), async (c) => {
    const month = c.req.valid("query").month ?? chileMonthOf((deps.now ?? (() => new Date()))());
    const scope = requestScope(c);
    const brokers = await monthlySpend(deps, { month, scope });
    const images = await monthlyImageSpend(
      { runs: deps.postImageRuns, brokers: deps.brokers },
      { month, scope, pricing: deps.imageAiPricing },
    );
    const body: UsageResponse = { month, brokers, images };
    return c.json(body, 200);
  });
}
