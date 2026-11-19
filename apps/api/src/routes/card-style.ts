import {
  type BrokerRepository,
  type CardStylePreviewer,
  type CardStyleRepository,
  getCardStyle,
  previewCardStyle,
  saveCardStyle,
} from "@agentsales/core";
import { Hono } from "hono";
import { type AppEnv, requireAuth } from "../auth.js";
import {
  type CardStyleResponse,
  cardStyleBodySchema,
  cardStylePreviewBodySchema,
  idParamSchema,
} from "../contracts/index.js";
import { validated } from "../validation.js";

export type CardStyleRoutesDeps = {
  brokers: Pick<BrokerRepository, "findById">;
  cardStyles: CardStyleRepository;
  /** Dibuja la lámina de muestra (`@agentsales/media/cards`; en las pruebas, un doble). */
  cardStylePreview: CardStylePreviewer;
};

/**
 * El estilo de las imágenes de la marca (spec F9.7 B4, ADR-0043), bajo `/brokers/:id`: leer
 * (`broker.view`), guardar (`brand.edit`) y una lámina de muestra en PNG (`broker.view`).
 */
export function cardStyleRoutes(deps: CardStyleRoutesDeps) {
  return new Hono<AppEnv>()
    .get("/:id/card-style", validated("param", idParamSchema), async (c) => {
      const cardStyle = await getCardStyle(deps, requireAuth(c).user, c.req.valid("param").id);
      const body: CardStyleResponse = { cardStyle };
      return c.json(body, 200);
    })
    .put(
      "/:id/card-style",
      validated("param", idParamSchema),
      validated("json", cardStyleBodySchema),
      async (c) => {
        const cardStyle = await saveCardStyle(
          deps,
          requireAuth(c).user,
          c.req.valid("param").id,
          c.req.valid("json").style,
        );
        const body: CardStyleResponse = { cardStyle };
        return c.json(body, 200);
      },
    )
    .post(
      "/:id/card-style/preview",
      validated("param", idParamSchema),
      validated("json", cardStylePreviewBodySchema),
      async (c) => {
        const png = await previewCardStyle(
          { ...deps, preview: deps.cardStylePreview },
          requireAuth(c).user,
          c.req.valid("param").id,
          c.req.valid("json"),
        );
        return c.body(new Uint8Array(png), 200, {
          "content-type": "image/png",
          "cache-control": "no-store",
        });
      },
    );
}
