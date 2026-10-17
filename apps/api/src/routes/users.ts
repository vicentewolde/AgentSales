import { type IssuedLink, inviteUser, resetUserAccess, setUserDisabled } from "@agentsales/core";
import { Hono } from "hono";
import { type AppEnv, type AuthDeps, requireAuth } from "../auth.js";
import {
  createUserBodySchema,
  idParamSchema,
  type UserLinkResponse,
  type UserResponse,
  type UsersResponse,
} from "../contracts/index.js";
import { toUserView } from "../user-view.js";
import { validated } from "../validation.js";

/**
 * `/users` (spec F7 §4.2 y §4.13, solo el administrador): crear con su enlace de invitación,
 * restablecer, desactivar y reactivar. El enlace lleva el token en el fragmento (`#`): no llega a
 * los logs del servidor del panel. Se entrega una sola vez, en la respuesta.
 */
export function userRoutes(deps: { auth: AuthDeps; panelUrl: string }) {
  const now = () => deps.auth.now?.() ?? new Date();
  const linkBody = (link: IssuedLink): UserLinkResponse => ({
    user: toUserView(link.user, now()),
    invitationUrl: `${deps.panelUrl}/invitacion#${link.token}`,
    expiresAt: link.expiresAt,
  });
  return new Hono<AppEnv>()
    .get("/", async (c) => {
      const at = now();
      const body: UsersResponse = {
        users: (await deps.auth.users.list()).map((user) => toUserView(user, at)),
      };
      return c.json(body, 200);
    })
    .post("/", validated("json", createUserBodySchema), async (c) => {
      const { user: actor } = requireAuth(c);
      const input = c.req.valid("json");
      const link = await inviteUser(deps.auth, {
        actor,
        email: input.email,
        name: input.name,
        role: input.role,
        brokerId: input.brokerId ?? null,
      });
      return c.json(linkBody(link), 201);
    })
    .post("/:id/reset", validated("param", idParamSchema), async (c) => {
      const { user: actor } = requireAuth(c);
      const link = await resetUserAccess(deps.auth, { actor, userId: c.req.valid("param").id });
      return c.json(linkBody(link), 200);
    })
    .post("/:id/disable", validated("param", idParamSchema), async (c) => {
      const { user: actor } = requireAuth(c);
      const user = await setUserDisabled(deps.auth, {
        actor,
        userId: c.req.valid("param").id,
        disabled: true,
      });
      const body: UserResponse = { user: toUserView(user, now()) };
      return c.json(body, 200);
    })
    .post("/:id/enable", validated("param", idParamSchema), async (c) => {
      const { user: actor } = requireAuth(c);
      const user = await setUserDisabled(deps.auth, {
        actor,
        userId: c.req.valid("param").id,
        disabled: false,
      });
      const body: UserResponse = { user: toUserView(user, now()) };
      return c.json(body, 200);
    });
}
