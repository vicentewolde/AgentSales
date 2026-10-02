import type { BrokerRepository } from "@agentsales/core";
import { Hono } from "hono";
import type { BrokerListResponse } from "../contracts/index.js";

/** `/brokers`: los corredores, para el selector de Importar (spec F1 §4.4). */
export function brokerRoutes(deps: { brokers: BrokerRepository }) {
  return new Hono().get("/", async (c) => {
    const body: BrokerListResponse = { brokers: await deps.brokers.list() };
    return c.json(body, 200);
  });
}
