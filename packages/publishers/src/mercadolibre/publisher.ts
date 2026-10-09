import {
  type AbortSignalLike,
  checkPublishInput,
  type PortalProgress,
  type PublishContext,
  type Publisher,
  type PublishInput,
  type PublishIssue,
  type PublishMediaItem,
  type PublishResult,
  type PublishValidation,
  platformContextOf,
  portalProgressSchema,
  publishInputInvalid,
  type RemoteStatus,
} from "@agentsales/core";
import type { PortalCatalog } from "./catalog.js";
import {
  describeCause,
  hasMercadoLibreCause,
  itemCreationOutcome,
  MERCADOLIBRE_ERRORS,
  MERCADOLIBRE_PICTURE_ID_CAUSES,
} from "./errors.js";
import type { MercadoLibreCallOptions } from "./http.js";
import { buildPortalItem, type PortalItemCatalog, resolvePortalItemCatalog } from "./item.js";
import type { MercadoLibreItem, MercadoLibreItems } from "./items.js";
import type { MercadoLibrePictures } from "./pictures.js";
import { type MercadoLibreTokenContext, withMercadoLibreToken } from "./token.js";

/** Lo que `validate` revisa sin catálogo (spec F4 §4.5); la hoja real lo afina en `buildPortalItem`. */
export const PORTAL_LIMITS = { titleMaxLength: 60, picturesMax: 30 } as const;

export type PortalPublisherOptions = {
  /** Solo lo que publica: crear, leer, la descripción y la búsqueda para retomar. */
  items: Pick<
    MercadoLibreItems,
    "create" | "get" | "getDescription" | "addDescription" | "findBySellerCustomField"
  >;
  pictures: MercadoLibrePictures;
  catalog: Pick<PortalCatalog, "leafCategory" | "attributes" | "location">;
  /**
   * Los bytes de una foto fijada en la publicación (la variante `pi_4x3`, JPEG): el worker la lee
   * de R2 (T18). Sus errores suben tal cual (uno pasajero, reintentable, retoma desde la foto que
   * faltaba).
   */
  readPicture(media: PublishMediaItem, options: { signal?: AbortSignalLike }): Promise<Uint8Array>;
  now?: () => Date;
};

const issue = (code: string, message: string): PublishIssue => ({ code, message });

/**
 * Requisitos de Portal antes de llamar (spec F4 §4.5), pura: formato `post`, título de 1 a 60
 * caracteres, de 1 a 30 fotos JPEG y el aviso y el contacto del corredor en el input (no se
 * suponen). Los motivos van en español y sin datos del aviso.
 */
export function validatePortalInput(input: PublishInput): PublishValidation {
  const issues: PublishIssue[] = [];
  if (input.listing === undefined || input.brokerContact === undefined) {
    issues.push(
      issue("PORTAL_INPUT_INCOMPLETE", "Faltan los datos del aviso o del corredor para Portal"),
    );
  }
  const title = input.title?.trim() ?? "";
  if (title === "")
    issues.push(issue("PORTAL_TITLE_MISSING", "El aviso no tiene título de Portal"));
  else if ([...title].length > PORTAL_LIMITS.titleMaxLength) {
    issues.push(
      issue(
        "PORTAL_TITLE_TOO_LONG",
        `El título de Portal pasa de ${PORTAL_LIMITS.titleMaxLength} caracteres`,
      ),
    );
  }
  if (input.media.length === 0) {
    issues.push(issue("PORTAL_PICTURES_MISSING", "Mercado Libre exige al menos una foto"));
  } else if (input.media.length > PORTAL_LIMITS.picturesMax) {
    issues.push(
      issue("PORTAL_TOO_MANY_PICTURES", `Portal acepta hasta ${PORTAL_LIMITS.picturesMax} fotos`),
    );
  }
  if (input.media.some((media) => media.kind !== "image" || media.mime !== "image/jpeg")) {
    issues.push(issue("PORTAL_PICTURE_NOT_JPEG", "Las fotos de Portal van en JPEG"));
  }
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/** El estado de un ítem como lo guarda core (`remote_state`, sin `checkedAt`, que pone core). */
export function remoteStatusOf(item: MercadoLibreItem): RemoteStatus {
  return {
    status: item.status,
    subStatus: item.subStatus,
    stopTime: item.stopTime,
    expirationTime: item.expirationTime,
  };
}

/** Las advertencias del ítem creado, con texto propio (nunca el `message` de Mercado Libre). */
const warningNotes = (item: MercadoLibreItem) =>
  item.warnings.map(
    (cause) =>
      `Mercado Libre advirtió: ${describeCause(cause)} (${cause.code ?? `causa ${cause.causeId ?? "sin código"}`})`,
  );

/**
 * El publisher de Portal Inmobiliario (spec F4 §4.8, ADR-0015): sube las fotos, crea el ítem,
 * carga la descripción y devuelve el enlace y el estado del ítem. Guarda el progreso antes de cada
 * paso que crea algo y retoma desde él **sin duplicar**:
 * 1. con `itemId`, no arma ni crea de nuevo: termina la descripción (la lee antes de cargarla) y
 *    lee el ítem;
 * 2. con `createRequestedAt` y sin `itemId` (no se supo si `POST /items` creó el ítem), **nunca**
 *    repite el pedido: lo busca por `seller_custom_field` (sin estado y, si no aparece, con
 *    `not_yet_active` y `paused`); si no hay exactamente uno, `ML_PUBLISH_OUTCOME_UNKNOWN`;
 * 3. si no, arma el ítem con las fotos por URL (revisión local, antes de subir nada), sube las
 *    fotos que falten (guardando cada id), lo arma con los ids y lo crea. Si Mercado Libre dice que
 *    no lo creó (`itemCreationOutcome`), se puede crear de nuevo; ante 508 o 509 (ids de fotos
 *    inválidos), vuelve a subir las fotos una vez.
 * Un 401 se refresca una vez con `rejectedToken` en cada llamada al cliente (`withMercadoLibreToken`);
 * el catálogo tiene su propio reintento, y su `rejected_after_refresh` sube tal cual. El cuerpo
 * lleva URLs firmadas y el WhatsApp: no se registra aquí (lo hace `publishAttemptRecord`).
 */
export function createPortalPublisher(options: PortalPublisherOptions): Publisher {
  const now = options.now ?? (() => new Date());
  const publisher: Publisher = {
    platform: "portal_inmobiliario",
    formats: ["post"],
    validate: validatePortalInput,

    async publish(input: PublishInput, ctx: PublishContext): Promise<PublishResult> {
      checkPublishInput(publisher, input);
      const platform = platformContextOf(ctx);
      const signal = ctx.signal;
      const tokenCtx: MercadoLibreTokenContext = {
        accessToken: platform.accessToken,
        ...(signal === undefined ? {} : { signal }),
      };
      const call = <T>(run: (token: string, callOptions: MercadoLibreCallOptions) => Promise<T>) =>
        withMercadoLibreToken(tokenCtx, (token, callSignal) =>
          run(token, callSignal === undefined ? {} : { signal: callSignal }),
        );

      let progress: PortalProgress = { pictureIds: [] };
      if (ctx.progress !== null && ctx.progress !== undefined) {
        const parsed = portalProgressSchema.safeParse(ctx.progress);
        // Un progreso ilegible podría ser de un ítem ya creado: no se adivina.
        if (!parsed.success) throw MERCADOLIBRE_ERRORS.publishOutcomeUnknown("none");
        progress = parsed.data;
      }
      const save = async (next: PortalProgress) => {
        progress = next;
        await ctx.saveProgress(next);
      };
      const notes: string[] = [];

      /** El ítem que dejó un `POST /items` sin respuesta, buscado por `seller_custom_field`. */
      async function findCreated(): Promise<MercadoLibreItem> {
        const userId = ctx.account.externalAccountId;
        const search = (status?: "not_yet_active" | "paused") =>
          call((token, callOptions) =>
            options.items.findBySellerCustomField(
              token,
              userId,
              input.publicationId,
              status === undefined ? callOptions : { ...callOptions, status },
            ),
          );
        // Una búsqueda que falla por la red se reintenta (solo lee); el error sube tal cual.
        let ids = await search();
        if (ids.length === 0) {
          ids = [...new Set([...(await search("not_yet_active")), ...(await search("paused"))])];
        }
        if (ids.length > 1) throw MERCADOLIBRE_ERRORS.publishOutcomeUnknown("many");
        const [itemId] = ids;
        if (itemId === undefined) throw MERCADOLIBRE_ERRORS.publishOutcomeUnknown("none");
        const item = await call((token, callOptions) =>
          options.items.get(token, itemId, callOptions),
        );
        if (item.sellerCustomField !== input.publicationId) {
          throw MERCADOLIBRE_ERRORS.publishOutcomeUnknown("none");
        }
        return item;
      }

      /** Sube las fotos que falten, en orden, guardando cada id apenas responde. */
      async function uploadMissing() {
        for (let index = progress.pictureIds.length; index < input.media.length; index += 1) {
          const media = input.media[index];
          if (media === undefined) break;
          const bytes = await options.readPicture(media, signal === undefined ? {} : { signal });
          const { id } = await call((token, callOptions) =>
            options.pictures.upload(
              token,
              { bytes, mime: media.mime, filename: `foto-${index + 1}.jpg` },
              callOptions,
            ),
          );
          await save({ ...progress, pictureIds: [...progress.pictureIds, id] });
        }
      }

      /** Arma, sube las fotos y crea el ítem (pasos 1 y 2 de §4.8). */
      async function createItem(catalog: PortalItemCatalog): Promise<MercadoLibreItem> {
        // La revisión local antes de subir nada: con las fotos por URL, la cuenta es la misma.
        const precheck = buildPortalItem(input, catalog, {
          pictures: input.media.map((media) => ({ source: media.url })),
          now,
        });
        if (!precheck.ok) throw publishInputInvalid(input.publicationId, precheck.issues);
        for (;;) {
          await uploadMissing();
          const built = buildPortalItem(input, catalog, {
            pictures: progress.pictureIds.map((id) => ({ id })),
            now,
          });
          if (!built.ok) throw publishInputInvalid(input.publicationId, built.issues);
          await save({
            ...progress,
            sellerContact: built.item.sellerContact,
            createRequestedAt: now().toISOString(),
          });
          try {
            const item = await call((token, callOptions) =>
              options.items.create(token, built.item.body, callOptions),
            );
            await save({ ...progress, itemId: item.id });
            notes.push(...built.item.notes, ...warningNotes(item));
            return item;
          } catch (error) {
            // Pudo crearse: el próximo intento lo busca, nunca repite el pedido a ciegas.
            if (itemCreationOutcome(error) === "unknown") throw error;
            const { createRequestedAt: _notCreated, ...rest } = progress;
            if (
              progress.picturesReuploaded !== true &&
              hasMercadoLibreCause(error, MERCADOLIBRE_PICTURE_ID_CAUSES)
            ) {
              await save({ ...rest, pictureIds: [], picturesReuploaded: true });
              continue;
            }
            await save(rest);
            throw error;
          }
        }
      }

      let created: MercadoLibreItem | null = null;
      if (progress.itemId === undefined) {
        if (progress.createRequestedAt !== undefined) {
          created = await findCreated();
          await save({ ...progress, itemId: created.id });
        } else {
          const { listing } = input;
          // `validate` ya lo exige; esto lo asegura para el tipo.
          if (listing === undefined) {
            throw publishInputInvalid(input.publicationId, validatePortalInputIssues(input));
          }
          const catalog = await resolvePortalItemCatalog(listing, options.catalog, tokenCtx);
          created = await createItem(catalog);
        }
      }
      const itemId = progress.itemId;
      if (itemId === undefined) throw MERCADOLIBRE_ERRORS.publishOutcomeUnknown("none");

      // Paso 3: la descripción, aparte. Antes de cargarla se lee: un POST sobre una que ya existe
      // falla, y un corte justo después de cargarla dejaría la publicación fallida con el ítem vivo.
      if (progress.descriptionDone !== true) {
        const existing = await call((token, callOptions) =>
          options.items.getDescription(token, itemId, callOptions),
        );
        if (existing === null) {
          await call((token, callOptions) =>
            options.items.addDescription(token, itemId, input.caption, callOptions),
          );
        }
        await save({ ...progress, descriptionDone: true });
      }

      const item =
        created ??
        (await call((token, callOptions) => options.items.get(token, itemId, callOptions)));
      return {
        externalId: item.id,
        externalUrl: item.permalink,
        simulated: false,
        ...(notes.length === 0 ? {} : { notes }),
        remote: remoteStatusOf(item),
      };
    },
  };
  return publisher;
}

const validatePortalInputIssues = (input: PublishInput): PublishIssue[] => {
  const validation = validatePortalInput(input);
  return validation.ok ? [] : validation.issues;
};
