import {
  AppError,
  assertCan,
  type Broker,
  type BrokerPurgeRepository,
  type BrokerRepository,
  brokerSheetDraft,
  createBroker,
  type EditorialProfileRepository,
  effectivePublishMode,
  type LogoNormalizer,
  MAX_BROKER_TEMPLATE_BYTES,
  MAX_LOGO_BYTES,
  type MediaRepository,
  type MediaStorage,
  onboardingSteps,
  type PlatformAccountRepository,
  type PublishMode,
  purgeBroker,
  purgeBrokerSummary,
  type RawBrokerSheet,
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
  type BrokerPurgeResponse,
  type BrokerPurgeSummaryResponse,
  type BrokerResponse,
  type BrokerTemplateDraftResponse,
  type BrokerView,
  brokerCreateBodySchema,
  brokerDeleteBodySchema,
  brokerLogoFormSchema,
  brokerPatchBodySchema,
  brokerTemplateFormSchema,
  idParamSchema,
  XLSX_CONTENT_TYPE,
} from "../contracts/index.js";
import type { AppLogger } from "../logger.js";
import { requestScope } from "../scope.js";
import { validated } from "../validation.js";

export type BrokerRoutesDeps = {
  brokers: BrokerRepository;
  /** El modo del servidor (`PUBLISH_MODE`): con la marca da el `effectiveMode` de cada corredor. */
  publishMode: PublishMode;
  media: Pick<MediaRepository, "findByStoragePath" | "create">;
  /** Subir el logo y, al borrar un corredor (F9.5-T14), recorrer sus prefijos y borrar sus archivos. */
  storage: Pick<MediaStorage, "put" | "list" | "delete">;
  /** Borrar un corredor y todo lo suyo en una transacción (F9.5-T14, ADR-0035). */
  brokerPurge: BrokerPurgeRepository;
  logger: Pick<AppLogger, "warn" | "info">;
  platformAccounts: Pick<PlatformAccountRepository, "listByBroker">;
  /** El perfil editorial: la lista de alta de una marca lo mira (spec F9 §4.3; decide core). */
  editorialProfiles: Pick<EditorialProfileRepository, "get">;
  auth: { users: Pick<UserRepository, "list"> };
  /** El logo con sharp (`@agentsales/media/logo`, lo compone `server.ts`). */
  logos: LogoNormalizer;
  sha256Bytes: (bytes: Uint8Array) => string;
  /** La planilla del corredor (`writeBrokerTemplate` con la plantilla oficial). */
  brokerTemplate: (broker: Broker) => Promise<Uint8Array>;
  /** La hoja Corredor de una planilla (`readBrokerWorkbook`; F9.5-T16, crear desde una planilla). */
  readBrokerTemplate: (bytes: Uint8Array) => Promise<RawBrokerSheet>;
};

/** Margen del multipart (encabezados y el nombre del archivo) sobre el tope del logo. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * `/brokers` (spec F7 §4.6): la lista (con el alcance), crear (administrador), el detalle y editar
 * (el corredor, su marca; el administrador, además, si es propio, el tope de IA y `autoPublish`,
 * spec F6 §4.10), el logo y la planilla. Lo de otro corredor no existe: `ownedBy` en `app.ts`.
 */
export function brokerRoutes(deps: BrokerRoutesDeps) {
  /** El corredor con el modo con que publicaría hoy (ADR-0036). */
  const viewOf = (broker: Broker): BrokerView => ({
    ...broker,
    effectiveMode: effectivePublishMode(deps.publishMode, broker),
  });
  /** El corredor con su lista de alta: sus usuarios, sus cuentas y su perfil editorial (una fila). */
  const detail = async (broker: Broker): Promise<BrokerDetailResponse> => {
    const [users, accounts, editorialProfile] = await Promise.all([
      deps.auth.users.list({ brokerId: broker.id }),
      deps.platformAccounts.listByBroker(broker.id),
      deps.editorialProfiles.get(broker.id),
    ]);
    return {
      broker: viewOf(broker),
      onboarding: onboardingSteps({ broker, users, accounts, editorialProfile }),
    };
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

  return (
    new Hono<AppEnv>()
      .get("/", async (c) => {
        // Un corredor ve solo el suyo (spec F7 §4.4); el administrador, todos.
        const body: BrokerListResponse = {
          brokers: (await deps.brokers.list(requestScope(c))).map(viewOf),
        };
        return c.json(body, 200);
      })
      .post("/", validated("json", brokerCreateBodySchema), async (c) => {
        const broker = await createBroker(deps, requireAuth(c).user, c.req.valid("json"));
        return c.json(await detail(broker), 201);
      })
      // F9.5-T16: la hoja Corredor de una planilla → los datos para llenar el formulario de crear.
      // Solo lee: no crea el corredor ni guarda el archivo.
      .post(
        "/parse-template",
        // El permiso antes de leer el archivo (además de `access.ts`).
        async (c, next) => {
          assertCan(requireAuth(c).user, "brokers.create");
          await next();
        },
        // Un tope propio, más bajo que el de una carga: exceljs corre aquí, dentro de la API, y
        // carga el libro entero (el descomprimido lo corta `readBrokerWorkbook`, a 8 MB). El
        // multipart se lee completo en memoria: el tope va antes de leerlo (413).
        bodyLimit({
          maxSize: MAX_BROKER_TEMPLATE_BYTES + MULTIPART_OVERHEAD_BYTES,
          onError: () => {
            throw new AppError(
              "REQUEST_TOO_LARGE",
              `La planilla pasa de ${MAX_BROKER_TEMPLATE_BYTES / 1024 / 1024} MB`,
            );
          },
        }),
        validated("form", brokerTemplateFormSchema),
        async (c) => {
          const bytes = new Uint8Array(await c.req.valid("form").file.arrayBuffer());
          const body: BrokerTemplateDraftResponse = {
            draft: brokerSheetDraft(await deps.readBrokerTemplate(bytes)),
          };
          return c.json(body, 200);
        },
      )
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
          const body: BrokerResponse = { broker: viewOf(broker) };
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
      })
      // F9.5-T14 (ADR-0035), solo el administrador (`access.ts` y `brokers.delete` en core): lo que
      // se borraría, y borrar con el `slug` repetido. No borra nada en las redes.
      .get("/:id/purge-summary", validated("param", idParamSchema), async (c) => {
        const body: BrokerPurgeSummaryResponse = await purgeBrokerSummary(
          deps,
          requireAuth(c).user,
          c.req.valid("param").id,
        );
        return c.json(body, 200);
      })
      .delete(
        "/:id",
        validated("param", idParamSchema),
        validated("json", brokerDeleteBodySchema),
        async (c) => {
          const { id } = c.req.valid("param");
          const result = await purgeBroker(
            {
              ...deps,
              // Lo que R2 no borró queda en el log con su clave (nunca una URL), para reintentarlo.
              onStorageFailure: (failure) =>
                deps.logger.warn(
                  { brokerId: id, ...failure },
                  "R2 no borró un archivo del corredor borrado",
                ),
            },
            requireAuth(c).user,
            { brokerId: id, confirm: c.req.valid("json").confirm },
          );
          deps.logger.info(
            {
              brokerId: id,
              slug: result.broker.slug,
              deleted: result.deleted,
              storageDeleted: result.storage.deleted,
              storagePending: result.storage.pendingCount,
            },
            "corredor borrado",
          );
          const body: BrokerPurgeResponse = result;
          return c.json(body, 200);
        },
      )
  );
}
