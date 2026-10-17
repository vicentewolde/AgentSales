import {
  AppError,
  assertCan,
  type Broker,
  type BrokerRepository,
  createBroker,
  type LogoNormalizer,
  MAX_LOGO_BYTES,
  type MediaRepository,
  type MediaStorage,
  onboardingSteps,
  type PlatformAccountRepository,
  setBrokerLogo,
  type UserRepository,
  updateBroker,
} from "@agentsales/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, requireAuth } from "../auth.js";
import {
  type BrokerDetailResponse,
  type BrokerListResponse,
  type BrokerResponse,
  brokerCreateBodySchema,
  brokerLogoFormSchema,
  brokerPatchBodySchema,
  idParamSchema,
  XLSX_CONTENT_TYPE,
} from "../contracts/index.js";
import { requestScope } from "../scope.js";
import { validated } from "../validation.js";

export type BrokerRoutesDeps = {
  brokers: BrokerRepository;
  media: Pick<MediaRepository, "findByStoragePath" | "create">;
  storage: Pick<MediaStorage, "put">;
  platformAccounts: Pick<PlatformAccountRepository, "listByBroker">;
  auth: { users: Pick<UserRepository, "list"> };
  /** El logo con sharp (`@agentsales/media/logo`, lo compone `server.ts`). */
  logos: LogoNormalizer;
  sha256Bytes: (bytes: Uint8Array) => string;
  /** La planilla del corredor (`writeBrokerTemplate` con la plantilla oficial). */
  brokerTemplate: (broker: Broker) => Promise<Uint8Array>;
};

/** Margen del multipart (encabezados y el nombre del archivo) sobre el tope del logo. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * `/brokers` (spec F7 §4.6): la lista (con el alcance), crear (administrador), el detalle y editar
 * (el corredor, su marca; el administrador, además, si es propio, el tope de IA y `autoPublish`,
 * spec F6 §4.10), el logo y la planilla. Lo de otro corredor no existe: `ownedBy` en `app.ts`.
 */
export function brokerRoutes(deps: BrokerRoutesDeps) {
  /** El corredor con su lista de alta (sus usuarios y sus cuentas). */
  const detail = async (broker: Broker): Promise<BrokerDetailResponse> => {
    const [users, accounts] = await Promise.all([
      deps.auth.users.list({ brokerId: broker.id }),
      deps.platformAccounts.listByBroker(broker.id),
    ]);
    return { broker, onboarding: onboardingSteps({ broker, users, accounts }) };
  };
  const brokerOf = async (id: string): Promise<Broker> => {
    const broker = await deps.brokers.findById(id);
    if (broker === null) {
      throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${id}`, { details: { id } });
    }
    return broker;
  };
  /** Las acciones de la marca exigen `brand.edit` sobre ese corredor. */
  const canEditBrand = (c: Context<AppEnv>, id: string) =>
    assertCan(requireAuth(c).user, "brand.edit", id);

  return new Hono<AppEnv>()
    .get("/", async (c) => {
      // Un corredor ve solo el suyo (spec F7 §4.4); el administrador, todos.
      const body: BrokerListResponse = { brokers: await deps.brokers.list(requestScope(c)) };
      return c.json(body, 200);
    })
    .post("/", validated("json", brokerCreateBodySchema), async (c) => {
      const broker = await createBroker(deps, requireAuth(c).user, c.req.valid("json"));
      return c.json(await detail(broker), 201);
    })
    .get("/:id", validated("param", idParamSchema), async (c) => {
      return c.json(await detail(await brokerOf(c.req.valid("param").id)), 200);
    })
    .patch(
      "/:id",
      validated("param", idParamSchema),
      validated("json", brokerPatchBodySchema),
      async (c) => {
        const broker = await updateBroker(
          deps,
          requireAuth(c).user,
          c.req.valid("param").id,
          c.req.valid("json"),
        );
        return c.json(await detail(broker), 200);
      },
    )
    .post(
      "/:id/logo",
      validated("param", idParamSchema),
      // El permiso antes de leer el archivo.
      async (c, next) => {
        canEditBrand(c, c.req.valid("param").id);
        await next();
      },
      // El multipart se lee completo en memoria: el tope va antes de leerlo (413).
      bodyLimit({
        maxSize: MAX_LOGO_BYTES + MULTIPART_OVERHEAD_BYTES,
        onError: () => {
          throw new AppError("REQUEST_TOO_LARGE", "El logo pasa de 5 MB");
        },
      }),
      validated("form", brokerLogoFormSchema),
      async (c) => {
        const { id } = c.req.valid("param");
        const bytes = new Uint8Array(await c.req.valid("form").logo.arrayBuffer());
        const broker = await setBrokerLogo(deps, requireAuth(c).user, { brokerId: id, bytes });
        const body: BrokerResponse = { broker };
        return c.json(body, 200);
      },
    )
    .get("/:id/template.xlsx", validated("param", idParamSchema), async (c) => {
      const { id } = c.req.valid("param");
      canEditBrand(c, id);
      const broker = await brokerOf(id);
      const bytes = await deps.brokerTemplate(broker);
      // El `slug` ya cumple `isValidSlug` (alta y carga); igual, nada raro llega a la cabecera.
      const name = broker.slug.replace(/[^a-z0-9-]/g, "") || "corredor";
      // `c.body` pide un `Uint8Array<ArrayBuffer>`; el de exceljs lo es (no viene de un SharedArrayBuffer).
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
        "content-type": XLSX_CONTENT_TYPE,
        "content-disposition": `attachment; filename="planilla-${name}.xlsx"`,
        "cache-control": "no-store",
      });
    });
}
