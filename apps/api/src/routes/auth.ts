import { acceptInvitation, login, logout } from "@agentsales/core";
import { Hono } from "hono";
import {
  type AppEnv,
  type AuthDeps,
  clearSessionCookie,
  credentialOf,
  requireAuth,
  setSessionCookie,
} from "../auth.js";
import {
  acceptInvitationBodySchema,
  type LoginResponse,
  loginBodySchema,
  type MeResponse,
} from "../contracts/index.js";
import { toUserView } from "../user-view.js";
import { validated } from "../validation.js";

/**
 * `/auth` (spec F7 §4.2 y §4.13, ADR-0021): entrar, salir, quién soy y aceptar un enlace. El panel
 * recibe la sesión en la cookie (`HttpOnly`, `SameSite=Strict`); la CLI, en el cuerpo
 * (`client: "cli"`), y nunca se escribe en un log.
 */
export function authRoutes(deps: { auth: AuthDeps }) {
  const now = () => deps.auth.now?.() ?? new Date();
  return new Hono<AppEnv>()
    .post("/login", validated("json", loginBodySchema), async (c) => {
      const { email, password, client = "panel" } = c.req.valid("json");
      const opened = await login(deps.auth, { email, password, client });
      const user = toUserView(opened.user, now());
      if (client === "cli") {
        const body: LoginResponse = { user, token: opened.token };
        return c.json(body, 200);
      }
      setSessionCookie(c, opened.token, deps.auth.secureCookie);
      const body: LoginResponse = { user };
      return c.json(body, 200);
    })
    .post("/logout", async (c) => {
      const credential = credentialOf(c);
      if (credential !== null) await logout(deps.auth, credential.token);
      clearSessionCookie(c, deps.auth.secureCookie);
      return c.body(null, 204);
    })
    .get("/me", async (c) => {
      const { user } = requireAuth(c);
      const broker =
        user.brokerId === null ? null : await deps.auth.brokers.findById(user.brokerId);
      const body: MeResponse = {
        user: {
          ...toUserView(user, now()),
          broker:
            broker === null
              ? null
              : { id: broker.id, slug: broker.slug, brandName: broker.brandName },
        },
      };
      return c.json(body, 200);
    })
    .post("/invitations/accept", validated("json", acceptInvitationBodySchema), async (c) => {
      const { token, password } = c.req.valid("json");
      // Se acepta en el panel (el enlace abre `/invitacion`): la sesión va en la cookie.
      const opened = await acceptInvitation(deps.auth, { token, password, client: "panel" });
      setSessionCookie(c, opened.token, deps.auth.secureCookie);
      const body: LoginResponse = { user: toUserView(opened.user, now()) };
      return c.json(body, 200);
    });
}
