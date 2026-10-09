import {
  AppError,
  normalizePortalName,
  PORTAL_ATTRIBUTE_FIELDS,
  PORTAL_FACING_CODES,
  PORTAL_ISSUE_MESSAGES,
  type PortalAttribute,
  type PortalAttributeField,
  type PortalCategory,
  type PortalLocationMatch,
  type PortalSellerContact,
  type PublishInput,
  type PublishIssue,
  type PublishListing,
  portalCategoryPath,
  portalPetsAnswer,
  portalPrice,
  portalSellerContact,
} from "@agentsales/core";
import type { PortalCatalog, PortalCatalogContext } from "./catalog.js";
import { MERCADOLIBRE_COUNTRY_ID } from "./constants.js";
import { type MercadoLibreItemBody, sellerContactBody } from "./items.js";

/** Lo que `buildPortalItem` necesita del catálogo: la hoja real, sus atributos y la ubicación. */
export type PortalItemCatalog = {
  leaf: PortalCategory;
  attributes: readonly PortalAttribute[];
  location: PortalLocationMatch;
};

/** Una foto del ítem: ya subida (`id`, en `live`) o por URL (`source`, en `preflight`). */
export type PortalPicture = { id: string } | { source: string };

/**
 * El ítem listo para `POST /items` o `POST /items/validate` (spec F4 §4.5): el cuerpo, la
 * descripción (va aparte, con `POST /items/{id}/description`: el camino seguro mientras no se
 * confirme que puede ir en el cuerpo, nota §12.3), el `seller_contact` que se guarda en el progreso
 * y las advertencias que no bloquean (textos propios, sin datos del aviso).
 */
export type PortalItem = {
  body: MercadoLibreItemBody;
  description: string;
  sellerContact: PortalSellerContact;
  notes: string[];
};

export type PortalItemResult =
  | { ok: true; item: PortalItem }
  | { ok: false; issues: PublishIssue[] };

export type PortalItemOptions = {
  pictures: readonly PortalPicture[];
  /** Para la antigüedad (`PROPERTY_AGE`) desde el año de construcción. */
  now?: () => Date;
};

/** Los atributos que completa la categoría: no se exigen ni se envían (salvo `CMG_SITE`). */
const CATEGORY_TAGS = ["read_only", "fixed", "hidden"];
/**
 * `CMG_SITE` como lo muestra la doc (nota §4.1): la marca de Portal Inmobiliario. Viene `hidden` en
 * el catálogo y se envía igual; que Mercado Libre lo acepte así sigue NO VERIFICADO (T23).
 */
const CMG_SITE = {
  id: "CMG_SITE",
  name: "Site de origen",
  value_id: null,
  value_name: "POI",
  value_struct: null,
  attribute_group_id: "OTHERS",
  attribute_group_name: "Otros",
};
/** Unidades de lo que el Excel guarda en m² y en pesos. */
const SQUARE_METERS = "m²";
const PESOS = "CLP";
const AGE_UNIT = "años";

const issue = (code: string, message: string): PublishIssue => ({ code, message });

const byCategory = (attribute: PortalAttribute) =>
  attribute.tags.some((tag) => CATEGORY_TAGS.includes(tag));

/** Un número del Excel (los campos `number` llegan normalizados como número). */
const numberOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** El valor `Sí` o `No` de un atributo de la hoja (con su `value_id`, o por nombre si no vino). */
function yesNo(attribute: PortalAttribute, yes: boolean): Record<string, unknown> {
  const wanted = yes ? "si" : "no";
  const value = attribute.values.find((option) => normalizePortalName(option.name) === wanted);
  return value === undefined
    ? { id: attribute.id, value_name: yes ? "Sí" : "No" }
    : { id: attribute.id, value_id: value.id };
}

const withUnit = (attribute: PortalAttribute, amount: number, unit: string) => ({
  id: attribute.id,
  value_name: `${amount} ${unit}`,
  value_struct: { number: amount, unit },
});

type Mapped =
  | { kind: "value"; value: Record<string, unknown> }
  | { kind: "none" }
  | { kind: "undecided" }
  /** La hoja no acepta la unidad del Excel (m² o CLP): nunca se convierte. */
  | { kind: "unit" };

/** ¿Acepta la hoja esa unidad? Sin unidades informadas, no se sabe y no bloquea. */
const unitAllowed = (attribute: PortalAttribute, unit: string) =>
  attribute.allowedUnits.length === 0 ||
  attribute.allowedUnits.some((option) => option.name === unit || option.id === unit);

/** El atributo de Mercado Libre para un campo del Excel, o `none` si no hay dato que enviar. */
function mapField(
  entry: PortalAttributeField,
  attribute: PortalAttribute,
  raw: unknown,
  now: () => Date,
  notes: string[],
): Mapped {
  switch (entry.kind) {
    case "number": {
      const amount = numberOf(raw);
      return amount === null
        ? { kind: "none" }
        : { kind: "value", value: { id: attribute.id, value_name: `${amount}` } };
    }
    case "area": {
      const amount = numberOf(raw);
      if (amount === null) return { kind: "none" };
      if (!unitAllowed(attribute, SQUARE_METERS)) return { kind: "unit" };
      return { kind: "value", value: withUnit(attribute, amount, SQUARE_METERS) };
    }
    case "fee": {
      const amount = numberOf(raw);
      if (amount === null) return { kind: "none" };
      if (!unitAllowed(attribute, PESOS)) return { kind: "unit" };
      return { kind: "value", value: withUnit(attribute, amount, PESOS) };
    }
    case "yes_no":
      return typeof raw === "boolean"
        ? { kind: "value", value: yesNo(attribute, raw) }
        : { kind: "none" };
    case "pets": {
      const answer = portalPetsAnswer(raw);
      if (answer === "undecided") return { kind: "undecided" };
      return answer === null
        ? { kind: "none" }
        : { kind: "value", value: yesNo(attribute, answer === "si") };
    }
    case "facing": {
      if (typeof raw !== "string") return { kind: "none" };
      const key = normalizePortalName(raw);
      const code = Object.hasOwn(PORTAL_FACING_CODES, key) ? PORTAL_FACING_CODES[key] : undefined;
      const value = attribute.values.find((option) => option.name === code);
      if (value === undefined) {
        notes.push("La orientación no calza con las de Mercado Libre: no se envía");
        return { kind: "none" };
      }
      return { kind: "value", value: { id: attribute.id, value_id: value.id } };
    }
    case "age": {
      const year = numberOf(raw);
      if (year === null) return { kind: "none" };
      const age = now().getUTCFullYear() - year;
      if (age < 0) {
        notes.push("El año de construcción es futuro: la antigüedad no se envía");
        return { kind: "none" };
      }
      return { kind: "value", value: withUnit(attribute, age, attribute.defaultUnit ?? AGE_UNIT) };
    }
  }
}

/**
 * La dirección para `location.address_line`: solo con `show_exact_address = true` (D7), con la
 * unidad si la hay. Con `false`, el ítem va solo con región, comuna y barrio por id.
 */
function addressLine(listing: PublishListing): string | null {
  if (!listing.showExactAddress || listing.address === null) return null;
  const unit = listing.unitNumber?.trim();
  return unit ? `${listing.address.trim()}, ${unit}` : listing.address.trim();
}

/**
 * Arma el ítem de Portal Inmobiliario (spec F4 §4.5) y lo revisa contra la **hoja real**: los
 * obligatorios que no completa la categoría, el largo del título, las fotos y la moneda. Pura dada
 * la hoja, sus atributos y la ubicación (`resolvePortalItemCatalog`). Solo envía lo de la tabla de
 * `portal/fields.ts` y los fijos (`CMG_SITE`, `silver`, `classified`, …): nunca `internal_notes`
 * (no viajan en el input) ni un campo sin mapeo. Lo usan `publish` (en `live`) y `preflight` (en
 * `dry-run`): con `ok: false`, `PUBLISH_INPUT_INVALID` con los motivos.
 */
export function buildPortalItem(
  input: PublishInput,
  catalog: PortalItemCatalog,
  options: PortalItemOptions,
): PortalItemResult {
  const { listing, brokerContact } = input;
  if (listing === undefined || brokerContact === undefined) {
    return {
      ok: false,
      issues: [
        issue("PORTAL_INPUT_INCOMPLETE", "Faltan los datos del aviso o del corredor para Portal"),
      ],
    };
  }
  const now = options.now ?? (() => new Date());
  const { leaf } = catalog;
  const issues: PublishIssue[] = [];
  const notes: string[] = [];

  const title = input.title?.trim() ?? "";
  const maxTitle = leaf.settings.maxTitleLength;
  if (title === "")
    issues.push(issue("PORTAL_TITLE_MISSING", "El aviso no tiene título de Portal"));
  else if (maxTitle !== null && [...title].length > maxTitle) {
    issues.push(
      issue(
        "PORTAL_TITLE_TOO_LONG",
        `El título de Portal pasa de ${maxTitle} caracteres (el máximo de la categoría)`,
      ),
    );
  }

  // La descripción va después de crear el ítem: si fuera demasiado larga, el ítem quedaría vivo
  // con la publicación fallida (§4.8, paso 3). Se revisa aquí, antes de crear.
  const maxDescription = leaf.settings.maxDescriptionLength;
  if (maxDescription !== null && [...input.caption].length > maxDescription) {
    issues.push(
      issue(
        "PORTAL_DESCRIPTION_TOO_LONG",
        `La descripción de Portal pasa de ${maxDescription} caracteres (el máximo de la categoría)`,
      ),
    );
  }

  const maxPictures = leaf.settings.maxPicturesPerItem;
  if (options.pictures.length === 0) {
    issues.push(issue("PORTAL_PICTURES_MISSING", "Mercado Libre exige al menos una foto"));
  } else if (maxPictures !== null && options.pictures.length > maxPictures) {
    issues.push(
      issue("PORTAL_TOO_MANY_PICTURES", `La categoría acepta hasta ${maxPictures} fotos`),
    );
  }

  const price = portalPrice(listing.priceAmount, listing.priceCurrency);
  if (price === null) {
    issues.push(
      issue(
        "PORTAL_PRICE_INVALID",
        "El precio tiene que ser mayor que 0 (y sin decimales si está en pesos)",
      ),
    );
  } else {
    const allowed = leaf.settings.currencies;
    if (allowed !== null && !allowed.includes(price.currency)) {
      issues.push(
        issue(
          "PORTAL_CURRENCY_NOT_ALLOWED",
          "La categoría no acepta la moneda del precio (nunca se convierte)",
        ),
      );
    }
    // El mínimo de la categoría no trae moneda y hay mínimos que no tienen sentido en pesos
    // (nota §12.1): no bloquea; si el precio en pesos queda abajo, se avisa y decide `validate`.
    const minimum = leaf.settings.minimumPrice;
    if (price.currency === "CLP" && minimum !== null && price.price < minimum) {
      notes.push("El precio está bajo el mínimo que informa Mercado Libre para la categoría");
    }
  }

  const sellerContact = portalSellerContact(brokerContact);
  if (sellerContact === null) {
    const blank = brokerContact.whatsapp === null || brokerContact.whatsapp.trim() === "";
    issues.push(
      blank
        ? issue("PORTAL_WHATSAPP_MISSING", PORTAL_ISSUE_MESSAGES.whatsappMissing)
        : issue("PORTAL_WHATSAPP_INVALID", PORTAL_ISSUE_MESSAGES.whatsappInvalid),
    );
  }

  if (listing.showExactAddress && listing.address === null) {
    issues.push(issue("PORTAL_FIELD_MISSING", "Falta la dirección (se muestra en el aviso)"));
  }

  // Atributos: de la tabla, solo los que tiene la hoja y no completa la categoría.
  const leafAttributes = new Map(catalog.attributes.map((attribute) => [attribute.id, attribute]));
  const sent: Record<string, unknown>[] = [];
  const covered = new Set<string>();
  for (const entry of PORTAL_ATTRIBUTE_FIELDS) {
    const attribute = leafAttributes.get(entry.attribute);
    if (attribute === undefined || byCategory(attribute)) continue;
    covered.add(attribute.id);
    const mapped = mapField(entry, attribute, listing.attributes[entry.field], now, notes);
    if (mapped.kind === "value") {
      sent.push(mapped.value);
      continue;
    }
    if (mapped.kind === "unit") {
      const message = `La categoría no acepta ${entry.label} en esa unidad (nunca se convierte)`;
      if (attribute.required) issues.push(issue("PORTAL_UNIT_NOT_ALLOWED", message));
      else notes.push(`${message}: no se envía`);
      continue;
    }
    if (!attribute.required) continue;
    issues.push(
      mapped.kind === "undecided"
        ? issue("PORTAL_PETS_UNDECIDED", PORTAL_ISSUE_MESSAGES.petsUndecided)
        : issue(
            "PORTAL_FIELD_MISSING",
            `Falta ${entry.label}: Mercado Libre la pide en esta categoría`,
          ),
    );
  }
  // Lo que la hoja exige y AgentSales no tiene: no se inventa (D8).
  for (const attribute of catalog.attributes) {
    // `CMG_SITE` va siempre, fijo: aunque la hoja lo marque obligatorio, no falta.
    if (covered.has(attribute.id) || byCategory(attribute) || attribute.id === CMG_SITE.id)
      continue;
    if (attribute.required) {
      issues.push(
        issue(
          "PORTAL_ATTRIBUTE_UNSUPPORTED",
          `Mercado Libre pide «${attribute.name}» (${attribute.id}) en esta categoría y AgentSales no lo tiene`,
        ),
      );
    } else if (attribute.conditionalRequired) {
      notes.push(`Mercado Libre podría pedir «${attribute.name}» (${attribute.id}) según el aviso`);
    }
  }

  if (issues.length > 0 || price === null || sellerContact === null) {
    return { ok: false, issues };
  }

  const address = addressLine(listing);
  const { location } = catalog;
  const body: MercadoLibreItemBody = {
    title,
    category_id: leaf.id,
    price: price.price,
    currency_id: price.currency,
    available_quantity: 1,
    buying_mode: "classified",
    listing_type_id: "silver",
    condition: "not_specified",
    channels: ["marketplace"],
    seller_custom_field: input.publicationId,
    pictures: options.pictures.map((picture) => ({ ...picture })),
    location: {
      ...(address === null ? {} : { address_line: address }),
      country: { id: MERCADOLIBRE_COUNTRY_ID },
      state: { id: location.state.id },
      city: { id: location.city.id },
      ...(location.neighborhood === null ? {} : { neighborhood: { id: location.neighborhood.id } }),
    },
    seller_contact: sellerContactBody(sellerContact),
    attributes: [...sent, CMG_SITE],
  };
  return { ok: true, item: { body, description: input.caption, sellerContact, notes } };
}

/**
 * La hoja, sus atributos y la ubicación de un aviso (con la caché del catálogo, spec F4 §4.4), para
 * `buildPortalItem`. Errores: `PORTAL_TYPE_UNSUPPORTED` (el tipo o la operación no se publican en
 * Portal), `PORTAL_CATEGORY_NOT_FOUND` y `PORTAL_LOCATION_NOT_FOUND` (del catálogo), y los de
 * Mercado Libre (red, token).
 */
export async function resolvePortalItemCatalog(
  listing: PublishListing,
  catalog: Pick<PortalCatalog, "leafCategory" | "attributes" | "location">,
  ctx: PortalCatalogContext,
): Promise<PortalItemCatalog> {
  const path = portalCategoryPath(listing.propertyType, listing.operation);
  if (path === null) {
    throw new AppError(
      "PORTAL_TYPE_UNSUPPORTED",
      "AgentSales no publica este tipo de propiedad u operación en Portal Inmobiliario",
    );
  }
  if (listing.region === null || listing.comuna === null) {
    throw new AppError("PORTAL_LOCATION_NOT_FOUND", "Al aviso le falta la región o la comuna", {
      details: { level: listing.region === null ? "region" : "commune", reason: "missing" },
    });
  }
  const leaf = await catalog.leafCategory(path, ctx);
  const attributes = await catalog.attributes(leaf.id, ctx);
  const location = await catalog.location({ region: listing.region, commune: listing.comuna }, ctx);
  return { leaf, attributes, location };
}
