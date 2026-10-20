import {
  type BrokerRepository,
  type EditorialProfileRepository,
  getEditorialProfile,
  saveEditorialProfile,
} from "@agentsales/core";
import { Hono } from "hono";
import { type AppEnv, requireAuth } from "../auth.js";
import {
  type EditorialProfileResponse,
  editorialProfileBodySchema,
  idParamSchema,
} from "../contracts/index.js";
import { validated } from "../validation.js";

export type EditorialProfileRoutesDeps = {
  brokers: Pick<BrokerRepository, "findById">;
  editorialProfiles: EditorialProfileRepository;
};

/**
 * `/brokers/:id/editorial-profile` (spec F9 §4.10, F9-T09): leer (`broker.view`) y reemplazar
 * (`brand.edit`: el administrador o el usuario de ese corredor) el perfil editorial. El corredor es
 * siempre el de la ruta, que `ownedBy` ya verificó en `app.ts` (lo de otro corredor es 404); el
 * cuerpo no lo trae. Sin perfil guardado, `GET` entrega el vacío por defecto (`updatedAt: null`).
 */
export function editorialProfileRoutes(deps: EditorialProfileRoutesDeps) {
  return new Hono<AppEnv>()
    .get("/:id/editorial-profile", validated("param", idParamSchema), async (c) => {
      const profile = await getEditorialProfile(deps, requireAuth(c).user, c.req.valid("param").id);
      const body: EditorialProfileResponse = { profile };
      return c.json(body, 200);
    })
    .put(
      "/:id/editorial-profile",
      validated("param", idParamSchema),
      validated("json", editorialProfileBodySchema),
      async (c) => {
        const profile = await saveEditorialProfile(
          deps,
          requireAuth(c).user,
          c.req.valid("param").id,
          c.req.valid("json"),
        );
        const body: EditorialProfileResponse = { profile };
        return c.json(body, 200);
      },
    );
}
