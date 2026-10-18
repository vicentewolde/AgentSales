import {
  acceptInvitation,
  confirmTotpSetup,
  disableTotp,
  login,
  loginWithTotp,
  logout,
  type OpenedSession,
  startTotpSetup,
  totpStatus,
} from "@agentsales/core";
import { type Context, Hono } from "hono";
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
  loginTotpBodySchema,
  type MeResponse,
  type TotpConfirmResponse,
  type TotpRequiredResponse,
  type TotpSetupResponse,
  type TotpStatusResponse,
  totpCodeBodySchema,
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
  /** La sesión abierta: a la CLI en el cuerpo; al panel, en la cookie. */
  const sessionResponse = (c: Context, opened: OpenedSession, client: "panel" | "cli") => {
    const user = toUserView(opened.user, now());
    if (client === "cli") {
      const body: LoginResponse = { user, token: opened.token };
      return c.json(body, 200);
    }
    setSessionCookie(c, opened.token, deps.auth.secureCookie);
    const body: LoginResponse = { user };
    return c.json(body, 200);
  };
  // Lo del doble factor no se guarda en ningún caché (la clave y los códigos de recuperación).
  const noStore = (c: Context) => c.header("Cache-Control", "no-store");
  return new Hono<AppEnv>()
    .post("/login", validated("json", loginBodySchema), async (c) => {
      const { email, password, client = "panel" } = c.req.valid("json");
      const result = await login(deps.auth, { email, password, client });
      if (result.kind === "totp_required") {
        // El segundo paso (spec F8 §4.8): el desafío va en el cuerpo, al panel y a la CLI.
        noStore(c);
        const body: TotpRequiredResponse = {
          totpRequired: true,
          challenge: result.challenge,
          expiresAt: result.expiresAt,
        };
        return c.json(body, 200);
      }
      return sessionResponse(c, result, client);
    })
    .post("/login/totp", validated("json", loginTotpBodySchema), async (c) => {
      const { challenge, code, client = "panel" } = c.req.valid("json");
      const opened = await loginWithTotp(deps.auth, { challenge, code, client });
      return sessionResponse(c, opened, client);
    })
    .get("/totp", async (c) => {
      const { user } = requireAuth(c);
      const body: TotpStatusResponse = await totpStatus(deps.auth, { user });
      return c.json(body, 200);
    })
    .post("/totp/setup", async (c) => {
      const { user } = requireAuth(c);
      const setup = await startTotpSetup(deps.auth, { user });
      noStore(c);
      const body: TotpSetupResponse = setup;
      return c.json(body, 200);
    })
    .post("/totp/confirm", validated("json", totpCodeBodySchema), async (c) => {
      const { user, session } = requireAuth(c);
      const { code } = c.req.valid("json");
      const { recoveryCodes } = await confirmTotpSetup(deps.auth, {
        user,
        code,
        keepSessionId: session.id,
      });
      noStore(c);
      const body: TotpConfirmResponse = { recoveryCodes };
      return c.json(body, 200);
    })
    .post("/totp/disable", validated("json", totpCodeBodySchema), async (c) => {
      const { user, session } = requireAuth(c);
      const { code } = c.req.valid("json");
      await disableTotp(deps.auth, { user, code, keepSessionId: session.id });
      return c.body(null, 204);
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
