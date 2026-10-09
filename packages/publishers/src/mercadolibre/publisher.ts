import {
  type AbortSignalLike,
  checkPublishInput,
  isAppError,
  type PlatformContext,
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
} from "@agentsales/core";
import type { PortalCatalog } from "./catalog.js";
import {
  describeCause,
  hasMercadoLibreCause,
  itemCreationOutcome,
  MERCADOLIBRE_ERRORS,
  MERCADOLIBRE_PICTURE_ID_CAUSES,
  type MercadoLibreCause,
} from "./errors.js";
import type { MercadoLibreCallOptions } from "./http.js";
import {
  buildPortalItem,
  buildPortalItemWithSources,
  type PortalItemCatalog,
  resolvePortalItemCatalog,
} from "./item.js";
import type { MercadoLibreItem, MercadoLibreItems } from "./items.js";
import { createPortalOperations, remoteStatusOf } from "./operations.js";
import type { MercadoLibrePictures } from "./pictures.js";
import { type MercadoLibreTokenContext, withMercadoLibreToken } from "./token.js";
import type { MercadoLibreValidator } from "./validate.js";

/** Lo que `validate` revisa sin catálogo (spec F4 §4.5); la hoja real lo afina en `buildPortalItem`. */
export const PORTAL_LIMITS = { titleMaxLength: 60, picturesMax: 30 } as const;

export type PortalPublisherOptions = {
  /**
   * Lo que publica (crear, leer, la descripción y la búsqueda para retomar) y lo que usan las
   * operaciones (el estado y la última moderación).
   */
  items: Pick<
    MercadoLibreItems,
    | "create"
    | "get"
    | "getDescription"
    | "addDescription"
    | "findBySellerCustomField"
    | "setStatus"
    | "getLastModeration"
  >;
  pictures: MercadoLibrePictures;
  /** `POST /items/validate`: lo usa solo `preflight` (ADR-0016). */
  validator: MercadoLibreValidator;
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

/** El código y el `cause_id` de una causa, como van en una nota: `(código X, causa N)`. */
function causeRef(cause: MercadoLibreCause): string {
  const parts = [
    ...(cause.code === null ? [] : [`código ${cause.code}`]),
    ...(cause.causeId === null ? [] : [`causa ${cause.causeId}`]),
  ];
  return parts.length === 0 ? "sin código" : parts.join(", ");
}

/**
 * Las advertencias de Mercado Libre (al crear el ítem o en `validate`) como notas para la bitácora:
 * un texto propio en español con el código y el `cause_id`, nunca el `message` de Mercado Libre.
 */
export const warningNotes = (warnings: readonly MercadoLibreCause[]) =>
  warnings.map((cause) => `Mercado Libre advirtió: ${describeCause(cause)} (${causeRef(cause)})`);

/**
 * La advertencia de `preflight` sin cupo (D14 del spec F4, seguimiento de ADR-0016): sin un paquete
 * con cupo, `validate` responde 402 y solo revisa el título.
 */
export const PORTAL_NO_QUOTA_NOTE =
  "Mercado Libre no revisó el aviso: la cuenta no tiene un paquete con cupo (ML_NO_QUOTA). La simulación siguió solo con las revisiones de AgentSales";

/** Lo que la simulación no cubre: las fotos van por URL a `validate` y no se suben (spec F4 §4.8). */
export const PORTAL_PICTURES_NOT_CHECKED_NOTE =
  "La simulación no sube las fotos: si Mercado Libre las acepta se sabe al publicar";

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
 *
 * `preflight` (solo lee y valida, ADR-0016; lo llama `withDryRun`) y las operaciones
 * (`createPortalOperations`) completan el contrato de spec F4 §4.8.
 */
export function createPortalPublisher(options: PortalPublisherOptions): Publisher {
  const now = options.now ?? (() => new Date());
  const operations = createPortalOperations({ items: options.items });
  const publisher: Publisher = {
    platform: "portal_inmobiliario",
    formats: ["post"],
    validate: validatePortalInput,
    ...operations,

    /**
     * Lo que diría Mercado Libre del aviso sin publicarlo (spec F4 §4.8, ADR-0016): baja la hoja,
     * sus atributos y la ubicación (`resolvePortalItemCatalog`), arma el ítem con las fotos por su
     * URL firmada (`buildPortalItemWithSources`, la misma revisión que hace `publish` antes de subir
     * las fotos) y lo pasa por `POST /items/validate`. **Nunca** sube fotos, crea ni cambia ítems.
     * - Un motivo propio (el input, la revisión local) o el rechazo de Mercado Libre:
     *   `{ ok: false, issues }` (`withDryRun` lo convierte en `PUBLISH_INPUT_INVALID`).
     * - Sin cupo (`ML_NO_QUOTA`, 402): `{ ok: true, notes }` con la advertencia (D14). Solo aquí:
     *   en `publish` sigue siendo un error.
     * - Los demás errores suben tal cual: los del catálogo (`PORTAL_TYPE_UNSUPPORTED`,
     *   `PORTAL_CATEGORY_NOT_FOUND`, `PORTAL_LOCATION_NOT_FOUND`, no reintentables), la red o un
     *   5xx (reintentables) y un token rechazado otra vez (`rejected_after_refresh`).
     */
    async preflight(input: PublishInput, ctx: PlatformContext): Promise<PublishValidation> {
      const checked = validatePortalInput(input);
      if (!checked.ok) return checked;
      const { listing } = input;
      // `validatePortalInput` ya lo exige (`PORTAL_INPUT_INCOMPLETE`); esto estrecha el tipo.
      if (listing === undefined) return { ok: false, issues: [] };
      const tokenCtx: MercadoLibreTokenContext = {
        accessToken: ctx.accessToken,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      };
      const catalog = await resolvePortalItemCatalog(listing, options.catalog, tokenCtx);
      const built = buildPortalItemWithSources(input, catalog, { now });
      if (!built.ok) return { ok: false, issues: built.issues };
      const notes = [...built.item.notes];
      try {
        const result = await withMercadoLibreToken(tokenCtx, (token, signal) =>
          options.validator.validate(
            token,
            built.item.body,
            signal === undefined ? {} : { signal },
          ),
        );
        if (!result.valid) return { ok: false, issues: result.issues };
        notes.push(...warningNotes(result.warnings));
      } catch (error) {
        if (!isAppError(error) || error.code !== "ML_NO_QUOTA") throw error;
        notes.push(PORTAL_NO_QUOTA_NOTE);
      }
      notes.push(PORTAL_PICTURES_NOT_CHECKED_NOTE);
      return { ok: true, notes };
    },

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
        // Un progreso con más fotos que la publicación no calza: se suben de nuevo, en orden.
        if (progress.pictureIds.length > input.media.length)
          await save({ ...progress, pictureIds: [] });
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
        const precheck = buildPortalItemWithSources(input, catalog, { now });
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
          // `possiblyCreated` solo se marca si un `POST /items` que salió no dice que no se creó:
          // si falla antes (pedir o renovar el token) o Mercado Libre responde que no, se puede
          // crear de nuevo; si no, el próximo intento lo busca y nunca repite el pedido a ciegas.
          let possiblyCreated = false;
          let item: MercadoLibreItem;
          try {
            item = await call(async (token, callOptions) => {
              try {
                return await options.items.create(token, built.item.body, callOptions);
              } catch (error) {
                if (itemCreationOutcome(error) === "unknown") possiblyCreated = true;
                throw error;
              }
            });
          } catch (error) {
            if (possiblyCreated) throw error;
            const { createRequestedAt: _notCreated, ...rest } = progress;
            if (
              progress.picturesReuploaded !== true &&
              hasMercadoLibreCause(error, MERCADOLIBRE_PICTURE_ID_CAUSES)
            ) {
              await save({ ...rest, pictureIds: [], picturesReuploaded: true });
              continue;
            }
            // Si no se puede borrar la hora del pedido, el próximo intento buscará el ítem y dirá
            // que no se sabe (el lado seguro); el error que se ve es el de Mercado Libre.
            await save(rest).catch(() => undefined);
            throw error;
          }
          // Mercado Libre ya creó el ítem: guardar su id fuera del `try` (un fallo al guardar no es
          // un rechazo) y con un segundo intento; si igual falla, el próximo intento lo busca.
          const withItem = { ...progress, itemId: item.id };
          await save(withItem).catch(() => save(withItem));
          notes.push(...built.item.notes, ...warningNotes(item.warnings));
          return item;
        }
      }

      let created: MercadoLibreItem | null = null;
      if (progress.itemId === undefined) {
        if (progress.createRequestedAt !== undefined) {
          // Las advertencias del armado del intento anterior no se repiten: ya quedaron en su bitácora.
          created = await findCreated();
          await save({ ...progress, itemId: created.id });
        } else {
          const { listing } = input;
          // `checkPublishInput` ya lo rechazó (`PORTAL_INPUT_INCOMPLETE`); esto estrecha el tipo.
          if (listing === undefined) throw publishInputInvalid(input.publicationId, []);
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
