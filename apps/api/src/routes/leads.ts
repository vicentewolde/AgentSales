import {
  AppError,
  assertCan,
  changeLeadStatus,
  eraseLead,
  issueLeadWebhookSecret,
  type Lead,
  type LeadRepository,
  type LeadWebhookKeyRepository,
  type LeadWebhookSecretDeps,
  type ListingRepository,
  leadsToCsv,
  manychatPayloadSchema,
  manychatToLead,
  receiveLead,
  type UserRepository,
  verifyLeadWebhookSecret,
} from "@agentsales/core";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { API_PREFIX } from "../access.js";
import { type AppEnv, requireAuth } from "../auth.js";
import {
  idParamSchema,
  type LeadListResponse,
  type LeadResponse,
  type LeadWebhookSecretResponse,
  leadAssignBodySchema,
  leadListQuerySchema,
  leadStatusBodySchema,
} from "../contracts/index.js";
import { errorJson } from "../errors.js";
import { validated } from "../validation.js";

export type LeadRoutesDeps = {
  leads: LeadRepository;
  listings: Pick<ListingRepository, "get">;
  leadWebhookKeys: LeadWebhookKeyRepository;
  /** El azar, el hash y la comparación del secreto (compuestos en `server.ts`: usan `node:crypto`). */
  leadSecrets: Pick<LeadWebhookSecretDeps, "randomSecret" | "hash" | "safeEqual">;
  auth: { users: Pick<UserRepository, "get"> };
  now?: () => Date;
};

/** Un lead sin cambios; las fechas viajan como texto y los contratos las leen de vuelta. */
const view = (lead: Lead): LeadResponse["lead"] => lead;

/**
 * Los leads de un corredor, bajo `/brokers/:id` (el corredor de la ruta, que `ownedBy` ya verificó
 * en `app.ts`: lo de otro corredor es 404). Todo pide `leads.manage` sobre ese corredor.
 */
export function brokerLeadRoutes(deps: LeadRoutesDeps) {
  return (
    new Hono<AppEnv>()
      .get(
        "/:id/leads",
        validated("param", idParamSchema),
        validated("query", leadListQuerySchema),
        async (c) => {
          const brokerId = c.req.valid("param").id;
          assertCan(requireAuth(c).user, "leads.manage", brokerId);
          const { status, listing, limit } = c.req.valid("query");
          const leads = await deps.leads.list(
            {
              brokerId,
              ...(status === undefined ? {} : { status }),
              ...(listing === undefined ? {} : { listingId: listing }),
            },
            limit,
          );
          const body: LeadListResponse = { leads: leads.map(view) };
          return c.json(body, 200);
        },
      )
      // La exportación a planilla: el CSV neutraliza las fórmulas (`leadsToCsv`).
      .get("/:id/leads.csv", validated("param", idParamSchema), async (c) => {
        const brokerId = c.req.valid("param").id;
        assertCan(requireAuth(c).user, "leads.manage", brokerId);
        const leads = await deps.leads.list({ brokerId }, 5000);
        return new Response(leadsToCsv(leads), {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="leads.csv"',
            "cache-control": "no-store",
          },
        });
      })
      // Genera o rota el secreto del webhook. Se muestra una vez; el anterior deja de servir.
      .post("/:id/leads/webhook-secret", validated("param", idParamSchema), async (c) => {
        const brokerId = c.req.valid("param").id;
        assertCan(requireAuth(c).user, "leads.manage", brokerId);
        const { secret } = await issueLeadWebhookSecret(
          { keys: deps.leadWebhookKeys, ...deps.leadSecrets },
          brokerId,
        );
        const body: LeadWebhookSecretResponse = {
          secret,
          path: `${API_PREFIX}/webhooks/manychat/${brokerId}`,
        };
        c.header("cache-control", "no-store");
        return c.json(body, 200);
      })
  );
}

/** Un lead por su id (el dueño ya se verificó con `ownedBy`: lo ajeno es 404). */
export function leadRoutes(deps: LeadRoutesDeps) {
  const load = async (id: string, c: Parameters<typeof requireAuth>[0]): Promise<Lead> => {
    const lead = await deps.leads.get(id);
    if (lead === null) throw new AppError("LEAD_NOT_FOUND", `No existe el lead ${id}`);
    assertCan(requireAuth(c).user, "leads.manage", lead.brokerId);
    return lead;
  };
  return (
    new Hono<AppEnv>()
      .get("/:id", validated("param", idParamSchema), async (c) => {
        const lead = await load(c.req.valid("param").id, c);
        const body: LeadResponse = { lead: view(lead) };
        return c.json(body, 200);
      })
      .post(
        "/:id/status",
        validated("param", idParamSchema),
        validated("json", leadStatusBodySchema),
        async (c) => {
          const lead = await load(c.req.valid("param").id, c);
          const updated = await changeLeadStatus(deps, lead.id, c.req.valid("json").status);
          const body: LeadResponse = { lead: view(updated) };
          return c.json(body, 200);
        },
      )
      .post(
        "/:id/assign",
        validated("param", idParamSchema),
        validated("json", leadAssignBodySchema),
        async (c) => {
          const lead = await load(c.req.valid("param").id, c);
          const { userId } = c.req.valid("json");
          if (userId !== null) {
            // Solo se asigna a alguien del mismo corredor.
            const user = await deps.auth.users.get(userId);
            if (user === null || user.brokerId !== lead.brokerId) {
              throw new AppError("LEAD_ASSIGNEE_INVALID", "Ese usuario no es de este corredor");
            }
          }
          const updated = await deps.leads.assign(lead.id, userId);
          if (updated === null)
            throw new AppError("LEAD_NOT_FOUND", `No existe el lead ${lead.id}`);
          const body: LeadResponse = { lead: view(updated) };
          return c.json(body, 200);
        },
      )
      // Borra nombre, teléfono y correo; la atribución y los conteos quedan (ADR-0033 punto 5).
      .post("/:id/erase", validated("param", idParamSchema), async (c) => {
        const lead = await load(c.req.valid("param").id, c);
        const erased = await eraseLead(deps, lead.id);
        const body: LeadResponse = { lead: view(erased) };
        return c.json(body, 200);
      })
  );
}

/** El cuerpo de ManyChat es un JSON corto: más de esto no es suyo. */
const MAX_WEBHOOK_BODY_BYTES = 16 * 1024;

const tooLarge = bodyLimit({
  maxSize: MAX_WEBHOOK_BODY_BYTES,
  onError: (c) => errorJson(c, 413, "REQUEST_TOO_LARGE", "El pedido es demasiado grande"),
});

/**
 * `POST /webhooks/manychat/:brokerId` (F10-T04, ADR-0033 punto 4): pública, la protege el secreto
 * del corredor (cabecera `x-agentsales-secret`, guardado con hash). Un corredor que no existe, uno
 * sin secreto y un secreto equivocado dan la misma respuesta. Nunca responde ni registra datos
 * personales.
 */
export function leadWebhookRoutes(deps: LeadRoutesDeps) {
  return new Hono<AppEnv>().post("/manychat/:brokerId", tooLarge, async (c) => {
    const brokerId = c.req.param("brokerId");
    const authorized = await verifyLeadWebhookSecret(
      { keys: deps.leadWebhookKeys, ...deps.leadSecrets },
      brokerId,
      c.req.header("x-agentsales-secret"),
    );
    if (!authorized) return errorJson(c, 401, "AUTH_INVALID", "Secreto del webhook inválido");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new AppError("REQUEST_INVALID", "El cuerpo no es un JSON válido");
    }
    const payload = manychatPayloadSchema.safeParse(raw);
    if (!payload.success) {
      throw new AppError("REQUEST_INVALID", "El cuerpo de ManyChat no es válido", {
        details: { fields: [...new Set(payload.error.issues.map((i) => i.path.join(".")))] },
      });
    }
    const { created } = await receiveLead(
      deps,
      manychatToLead(brokerId, payload.data, (deps.now ?? (() => new Date()))()),
    );
    return c.json({ ok: true as const, created }, 200);
  });
}
