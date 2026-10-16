import { AppError, type BrokerRepository } from "@agentsales/core";
import { Hono } from "hono";
import {
  type BrokerListResponse,
  type BrokerResponse,
  brokerPatchBodySchema,
  idParamSchema,
} from "../contracts/index.js";
import { validated } from "../validation.js";

/**
 * `/brokers`: los corredores, para el selector de Importar (spec F1 §4.4), y desde F6-T10 activar o
 * apagar su `auto_publish` (spec F6 §4.10). La advertencia en vivo la dan quienes llaman (la CLI
 * pregunta siempre; el panel avisa en rojo): `/health` informa los corredores con `auto_publish`.
 */
export function brokerRoutes(deps: { brokers: BrokerRepository }) {
  return new Hono()
    .get("/", async (c) => {
      const body: BrokerListResponse = { brokers: await deps.brokers.list() };
      return c.json(body, 200);
    })
    .patch(
      "/:id",
      validated("param", idParamSchema),
      validated("json", brokerPatchBodySchema),
      async (c) => {
        const { id } = c.req.valid("param");
        if ((await deps.brokers.findById(id)) === null) {
          throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${id}`, {
            details: { brokerId: id },
          });
        }
        const broker = await deps.brokers.setAutoPublish(id, c.req.valid("json").autoPublish);
        const body: BrokerResponse = { broker };
        return c.json(body, 200);
      },
    );
}
