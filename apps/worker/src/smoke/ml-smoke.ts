import {
  type AbortSignalLike,
  AppError,
  accessTokenProvider,
  type Broker,
  isAppError,
  isMercadoLibreRejectedAfterRefresh,
  type Listing,
  type MercadoLibreTokenDeps,
  maskWhatsapp,
  normalizePortalName,
  OPERATIONS,
  type PlatformAccount,
  type PlatformAccountRepository,
  PORTAL_ATTRIBUTE_FIELDS,
  PORTAL_PROPERTY_TYPE_KEYS,
  type PortalAttribute,
  type PortalCategory,
  type PortalNamedRef,
  portalCategoryPath,
  portalPropertyType,
  portalSellerContact,
} from "@agentsales/core";
import {
  describeCause,
  isMercadoLibreLocationId,
  MERCADOLIBRE_COUNTRY_ID,
  MERCADOLIBRE_REAL_ESTATE_CATEGORY_ID,
  type MercadoLibreCause,
  type MercadoLibreItemBody,
  type MercadoLibreItemSearch,
  type MercadoLibreItems,
  type MercadoLibrePackList,
  type MercadoLibrePacks,
  type MercadoLibreTokenContext,
  type MercadoLibreValidation,
  type MercadoLibreValidator,
  mercadoLibreCausesOf,
  type PortalCatalog,
  sellerContactBody,
  withMercadoLibreToken,
} from "@agentsales/publishers";
import { z } from "zod";

// `pnpm ml:smoke` (spec F4-T10): con la cuenta de Mercado Libre conectada, recorre el árbol de
// Inmuebles hasta las hojas (con sus `settings` y obligatorios), baja los estados y ciudades de
// Chile, pregunta a `POST /items/validate` por un aviso armado a mano y sus variantes, mira qué
// estados trae la búsqueda de ítems sin filtro y lee los paquetes de publicación. **Nunca** sube
// fotos, crea ni modifica ítems: `items` solo trae `searchItems` (ni en los tipos ni al ejecutar,
// `smokeItems`) y no recibe el cliente de fotos. Sí escribe en la base: el catálogo (7 días) y, si
// refresca, el par de tokens (con el candado). No imprime tokens ni el WhatsApp del corredor. Un
// 401 que se repite después de refrescar se informa sin marcar la cuenta `expired` (spec F4-T10);
// en cambio, si el refresco mismo es rechazado (`invalid_grant`), `ensureAccessToken` sí la deja
// `expired`, como en cualquier refresco (ADR-0015 punto 4).

/** Título del aviso de prueba (el que sugiere la doc de inmuebles para pruebas, nota §8). */
export const ML_SMOKE_TITLE = "Propiedad de Test por favor no contactar";
/** Una foto que no existe (`.test` nunca resuelve): `validate` no la descarga, o lo dice. */
export const ML_SMOKE_PICTURE = "https://agentsales.test/ml-smoke/foto-1.jpg";
/** Tope de categorías que se recorren (el árbol de Inmuebles tiene decenas): evita un bucle. */
export const ML_SMOKE_MAX_CATEGORIES = 400;
/** Categorías seguidas con error tras las que se deja de recorrer (un 403 se repetiría en todas). */
export const ML_SMOKE_MAX_FAILURES_IN_A_ROW = 3;

/** Lo que el smoke lee: lo justo, para probarlo con dobles. */
export type MlSmokeDeps = {
  accounts: Pick<
    PlatformAccountRepository,
    "list" | "get" | "getCredentials" | "withCredentialsLock" | "changeStatus"
  >;
  brokers: { list(): Promise<Pick<Broker, "id" | "slug" | "name" | "email" | "whatsapp">[]> };
  listings: {
    list(): Promise<Pick<Listing, "id" | "brokerId" | "externalRef" | "region" | "comuna">[]>;
  };
  /** El refresco de Mercado Libre, o `null` sin `ML_APP_ID` y `ML_CLIENT_SECRET`. */
  mercadoLibre: MercadoLibreTokenDeps["mercadoLibre"];
  catalog: Pick<
    PortalCatalog,
    "category" | "leafCategory" | "attributes" | "location" | "locationNode"
  >;
  validator: MercadoLibreValidator;
  /** Solo la búsqueda: el smoke no puede crear ni cambiar un ítem ni por error. */
  items: Pick<MercadoLibreItems, "searchItems">;
  packs: MercadoLibrePacks;
  /** Guarda el informe completo y devuelve dónde quedó. */
  writeReport(report: MlSmokeReport): Promise<string>;
  now(): Date;
  print(line: string): void;
  printError(line: string): void;
};

export type MlSmokeOptions = {
  /** Slug del corredor; hace falta solo si hay cuentas conectadas en más de uno. */
  brokerSlug?: string;
  /** La hoja para `validate` (`MLC…`); por defecto, la de departamentos en venta. */
  categoryId?: string;
  /** Tope del recorrido del árbol (por defecto `ML_SMOKE_MAX_CATEGORIES`). */
  maxCategories?: number;
  signal?: AbortSignalLike;
};

/** Un error de una parte del smoke, sin el token ni datos del aviso. */
export type MlSmokeError = {
  section: string;
  code: string;
  message: string;
  /** `httpStatus`, `error` de Mercado Libre, `reason`, … (sin las causas, que van aparte). */
  details?: Record<string, unknown>;
  causes?: MercadoLibreCause[];
};

type AttributeSummary = Pick<
  PortalAttribute,
  "id" | "name" | "valueType" | "tags" | "required" | "conditionalRequired"
>;

/** Lo que se aprendió de Mercado Libre: va completo al informe (`tmp/ml-smoke/`), fuera de git. */
export type MlSmokeReport = {
  generatedAt: string;
  account: { displayName: string; userType: string | null };
  categories: {
    visited: number;
    truncated: boolean;
    leaves: Array<{
      path: string[];
      id: string;
      settings: PortalCategory["settings"];
      required: AttributeSummary[];
      conditional: AttributeSummary[];
      /** Atributos con `read_only`, `fixed` o `hidden` (los completa la categoría, T11). */
      tagged: AttributeSummary[];
      /** Si `leafCategory(path)` llega a esta misma hoja por los nombres (lo que hará T11). */
      byName: "ok" | string;
    }>;
    /** Categorías sin hijas que no admiten publicar. */
    deadEnds: Array<{ path: string[]; id: string }>;
    /** Tags de los atributos obligatorios y condicionales, con los ids que los traen. */
    requiredTags: Record<string, string[]>;
    /**
     * Donde la tabla de Portal (core, F4-T11) no calza con la hoja real: lo que la tabla pide y la
     * hoja no (`onlyTable`: la tabla quedó más estricta) y lo que la hoja pide y la tabla no
     * (`onlyLeaf`: lo atrapa `buildPortalItem`). `leafId: null` si la hoja no apareció.
     */
    tableCheck: Array<{
      path: string[];
      leafId: string | null;
      onlyTable: string[];
      onlyLeaf: string[];
    }>;
  };
  locations: {
    states: Array<{
      id: string;
      name: string;
      validId: boolean;
      cities: Array<{ id: string; name: string; validId: boolean }>;
    }>;
    listings: Array<{
      externalRef: string;
      region: string | null;
      commune: string | null;
      match: { state: string; city: string; neighborhood: string | null } | null;
      error: string | null;
    }>;
    sampleCity: { id: string; name: string; neighborhoods: PortalNamedRef[] } | null;
  };
  validate: {
    leaf: { id: string; path: string[] } | null;
    missingSamples: string[];
    contact: "broker" | "sample";
    variants: Array<{
      name: string;
      valid: boolean | null;
      errors: MercadoLibreCause[];
      warnings: MercadoLibreCause[];
      issues: Array<{ code: string; message: string }>;
      error: MlSmokeError | null;
    }>;
  };
  search: MercadoLibreItemSearch | null;
  packs: {
    user: MercadoLibrePackList | null;
    /** La cuenta sin paquetes: Mercado Libre responde 404 `not_found` (visto el 2026-10-08). */
    userNotFound: boolean;
    category: MercadoLibrePackList | null;
  };
  errors: MlSmokeError[];
};

/**
 * Errores de `validate` que son un resultado (lo que se busca ver), no un fallo del smoke: sin
 * cupo (402), o un rechazo con o sin causas.
 */
const VALIDATE_RESULTS = new Set(["ML_NO_QUOTA", "ML_ITEM_REJECTED", "ML_REQUEST_REJECTED"]);

/** El tipo de usuario de la `meta` de la cuenta (solo eso; el resto no se usa aquí). */
const userTypeSchema = z.object({
  userType: z.string().optional().catch(undefined),
});

/** Errores que cortan todo el smoke: sin token o sin base, ninguna otra parte puede andar. */
const STOP_CODES = new Set([
  "ML_AUTH_INVALID",
  "ML_ABORTED",
  "ACCOUNT_NOT_FOUND",
  "ACCOUNT_NOT_CONNECTED",
  "ACCOUNT_REFRESH_UNSUPPORTED",
  "ACCOUNT_LOCK_TIMEOUT",
  "MERCADOLIBRE_NOT_CONFIGURED",
  "ML_APP_CREDENTIALS_INVALID",
  "CREDENTIALS_UNREADABLE",
  "CREDENTIALS_INVALID",
  "DB_UNAVAILABLE",
]);

/** Qué hacer ante los errores que tienen arreglo del lado del operador. */
const HINTS: Readonly<Record<string, string>> = {
  ACCOUNT_NOT_CONNECTED:
    "Conecta la cuenta (con pnpm dev): pnpm -s cli accounts connect mercadolibre --broker <slug>",
  MERCADOLIBRE_NOT_CONFIGURED: "Falta ML_APP_ID o ML_CLIENT_SECRET en .env (pnpm -s cli doctor)",
  ML_APP_CREDENTIALS_INVALID:
    "Revisa ML_APP_ID y ML_CLIENT_SECRET en .env (¿se renovó el Client Secret en el DevCenter?)",
  ML_AUTH_INVALID: "El acceso venció o se revocó: reconecta la cuenta",
  ACCOUNT_LOCK_TIMEOUT: "Otro proceso está renovando el acceso: reintenta en unos segundos",
  CREDENTIALS_UNREADABLE:
    "El acceso guardado no se puede leer (¿cambió APP_ENCRYPTION_KEY?): reconecta la cuenta",
  DB_UNAVAILABLE: "Neon puede estar despertando: reintenta en unos segundos",
  ML_UNAVAILABLE: "Mercado Libre no respondió: reintenta en un rato (lo bajado ya quedó guardado)",
  ML_RATE_LIMITED:
    "Mercado Libre limitó las llamadas: espera unos minutos y reintenta (lo bajado ya quedó guardado)",
  ML_PERMISSION_DENIED:
    "Revisa que la app tenga el permiso de publicación y que autorizó la cuenta administradora",
};

/** El 401 repetido: no se marca la cuenta (spec F4-T10); se dice qué revisar. */
const REJECTED_AFTER_REFRESH_HINT =
  "Mercado Libre rechazó el acceso aun después de renovarlo. ml:smoke no marca la cuenta como vencida: revisa pnpm -s cli accounts y, si sigue, reconéctala";

/** Valores de muestra por atributo (nota §4.6): solo para `validate`, nunca se publican. */
const SAMPLE_ATTRIBUTES: Readonly<
  Record<string, { value: number | "si" | "no"; units?: readonly string[] }>
> = {
  BEDROOMS: { value: 2 },
  FULL_BATHROOMS: { value: 1 },
  ROOMS: { value: 3 },
  PARKING_LOTS: { value: 1 },
  WAREHOUSES: { value: 1 },
  COVERED_AREA: { value: 60, units: ["m²", "m2"] },
  TOTAL_AREA: { value: 65, units: ["m²", "m2"] },
  MAINTENANCE_FEE: { value: 80000, units: ["CLP", "$"] },
  FURNISHED: { value: "no" },
  IS_SUITABLE_FOR_PETS: { value: "no" },
};

/** Los que completa la categoría (T11 no los exige ni los envía). */
const CATEGORY_TAGS = ["read_only", "fixed", "hidden"];
/** Tags que no se resumen: ya son las columnas de obligatorio y condicional. */
const REQUIRED_TAGS = new Set(["required", "conditional_required"]);

/** `CMG_SITE` como lo muestra la doc (nota §4.1) y en su forma corta (NO VERIFICADA). */
const CMG_SITE_FULL = {
  id: "CMG_SITE",
  name: "Site de origen",
  value_id: null,
  value_name: "POI",
  value_struct: null,
  attribute_group_id: "OTHERS",
  attribute_group_name: "Otros",
};
const CMG_SITE_SHORT = { id: "CMG_SITE", value_name: "POI" };

/** Corta todo el smoke: lo atrapa `runMlSmoke`. */
class StopSmoke extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
  }
}

/**
 * Solo la búsqueda, también al ejecutar: el objeto que recibe no tiene `create`, `setStatus`,
 * `addDescription` ni `hideAddress`, así que ni un cast deja al smoke crear o cambiar un ítem.
 */
export function smokeItems(items: MercadoLibreItems): MlSmokeDeps["items"] {
  return { searchItems: (...args) => items.searchItems(...args) };
}

const errorOf = (section: string, error: AppError): MlSmokeError => {
  const details: Record<string, unknown> = {};
  for (const key of ["httpStatus", "error", "reason", "call", "kind", "level"] as const) {
    const value = error.details?.[key];
    if (value !== undefined && value !== null) details[key] = value;
  }
  const causes = mercadoLibreCausesOf(error);
  return {
    section,
    code: error.code,
    message: error.message,
    ...(Object.keys(details).length === 0 ? {} : { details }),
    ...(causes.length === 0 ? {} : { causes }),
  };
};

/** Los códigos de Mercado Libre de un error (status, `error` y causas), para la salida. */
function mercadoLibreCodes(error: MlSmokeError): string {
  const details = error.details ?? {};
  const parts: string[] = [];
  if (typeof details.httpStatus === "number") parts.push(`HTTP ${details.httpStatus}`);
  if (typeof details.error === "string") parts.push(`error ${details.error}`);
  const causes = error.causes ?? [];
  if (causes.length > 0) parts.push(`causas ${causes.map(causeLabel).join(", ")}`);
  return parts.length === 0 ? "" : ` (${parts.join("; ")})`;
}

const causeLabel = (cause: MercadoLibreCause) =>
  [cause.code, cause.causeId === null ? null : `#${cause.causeId}`, cause.type]
    .filter((part) => part !== null)
    .join(" ");

const settingsLine = (settings: PortalCategory["settings"]) => {
  const currencies =
    settings.currencies === null
      ? "sin dato"
      : settings.currencies.length === 0
        ? "ninguna"
        : settings.currencies.join(", ");
  return `título ${settings.maxTitleLength ?? "?"} · fotos ${settings.maxPicturesPerItem ?? "?"} · monedas ${currencies}`;
};

const attributeLabel = (attribute: AttributeSummary) => {
  const tags = attribute.tags.filter((tag) => !REQUIRED_TAGS.has(tag));
  return tags.length === 0 ? attribute.id : `${attribute.id}[${tags.join(",")}]`;
};

const summary = (attribute: PortalAttribute): AttributeSummary => ({
  id: attribute.id,
  name: attribute.name,
  valueType: attribute.valueType,
  tags: attribute.tags,
  required: attribute.required,
  conditionalRequired: attribute.conditionalRequired,
});

/** La cuenta de Mercado Libre conectada (del corredor pedido, si hay más de una). */
async function findAccount(deps: MlSmokeDeps, brokerSlug: string | undefined) {
  const connected = (await deps.accounts.list()).filter(
    (account) =>
      account.platform === "portal_inmobiliario" &&
      account.status === "connected" &&
      account.hasCredentials,
  );
  const brokers = await deps.brokers.list();
  let candidates = connected;
  if (brokerSlug !== undefined) {
    const broker = brokers.find((item) => item.slug === brokerSlug);
    if (broker === undefined) {
      throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${brokerSlug}`);
    }
    candidates = connected.filter((account) => account.brokerId === broker.id);
  }
  const [account, ...others] = candidates;
  if (account === undefined) {
    throw new AppError(
      "ACCOUNT_NOT_CONNECTED",
      brokerSlug === undefined
        ? "No hay una cuenta de Mercado Libre conectada"
        : `${brokerSlug} no tiene una cuenta de Mercado Libre conectada`,
    );
  }
  if (others.length > 0) {
    throw new AppError(
      "BROKER_REQUIRED",
      "Hay cuentas de Mercado Libre conectadas en varios corredores: elige uno con --broker <slug>",
    );
  }
  const broker = brokers.find((item) => item.id === account.brokerId);
  return { account, broker, slug: broker?.slug ?? account.brokerId };
}

/** El `seller_contact` del corredor (solo dígitos, nota §4.2), o uno de muestra si no tiene WhatsApp. */
function sellerContact(broker: Pick<Broker, "name" | "email" | "whatsapp"> | undefined) {
  // La misma conversión que usa el ítem de Portal (core, F4-T11).
  const contact = broker === undefined ? null : portalSellerContact(broker);
  if (contact === null) {
    return {
      source: "sample" as const,
      body: { contact: "AgentSales ml:smoke", country_code2: "56", phone2: "900000000" },
    };
  }
  return { source: "broker" as const, body: sellerContactBody(contact) };
}

/** Un atributo de muestra con el valor y la unidad que acepta la hoja. */
function sampleAttribute(attribute: PortalAttribute): Record<string, unknown> | null {
  const sample = SAMPLE_ATTRIBUTES[attribute.id];
  if (sample === undefined) return null;
  if (sample.value === "si" || sample.value === "no") {
    const wanted = sample.value;
    const value = attribute.values.find((option) => normalizePortalName(option.name) === wanted);
    return value === undefined
      ? { id: attribute.id, value_name: wanted === "si" ? "Sí" : "No" }
      : { id: attribute.id, value_id: value.id };
  }
  if (attribute.valueType === "number_unit") {
    const hints = (sample.units ?? []).map((unit) => unit.toLowerCase());
    const unit =
      attribute.allowedUnits.find(
        (option) =>
          hints.includes(option.name.toLowerCase()) || hints.includes(option.id.toLowerCase()),
      )?.name ??
      attribute.defaultUnit ??
      attribute.allowedUnits[0]?.name;
    return {
      id: attribute.id,
      value_name: unit === undefined ? `${sample.value}` : `${sample.value} ${unit}`,
    };
  }
  return { id: attribute.id, value_name: `${sample.value}` };
}

/** La hoja para `validate`: la pedida o la de departamentos en venta (usados o individuales). */
function pickLeaf(leaves: MlSmokeReport["categories"]["leaves"], categoryId: string | undefined) {
  if (categoryId !== undefined) return leaves.find((leaf) => leaf.id === categoryId) ?? null;
  const named = leaves.map((leaf) => ({ leaf, names: leaf.path.map(normalizePortalName) }));
  const apartments = named.filter(({ names }) => names[0]?.startsWith("departamento"));
  const forSale = apartments.filter(({ names }) => names[1] === "venta");
  return (
    forSale.find(({ names }) => /usad|individual/.test(names[2] ?? ""))?.leaf ??
    forSale[0]?.leaf ??
    apartments[0]?.leaf ??
    leaves[0] ??
    null
  );
}

/**
 * Corre el smoke y devuelve el código de salida: 0 si todo se pudo leer (un rechazo de `validate`
 * es un resultado, no un error), 1 si alguna parte falló o si falta algo para empezar. Todo error
 * sale como `✗ CÓDIGO: mensaje`, con una pista si la hay.
 */
export async function runMlSmoke(deps: MlSmokeDeps, options: MlSmokeOptions = {}): Promise<number> {
  const signal = options.signal;
  const report: MlSmokeReport = {
    generatedAt: deps.now().toISOString(),
    account: { displayName: "", userType: null },
    categories: {
      visited: 0,
      truncated: false,
      leaves: [],
      deadEnds: [],
      requiredTags: {},
      tableCheck: [],
    },
    locations: { states: [], listings: [], sampleCity: null },
    validate: { leaf: null, missingSamples: [], contact: "sample", variants: [] },
    search: null,
    packs: { user: null, userNotFound: false, category: null },
    errors: [],
  };
  const failure = (recorded: MlSmokeError) => {
    report.errors.push(recorded);
    deps.printError(`  ✗ ${recorded.code}: ${recorded.message}${mercadoLibreCodes(recorded)}`);
    const hint = HINTS[recorded.code];
    if (hint !== undefined) deps.printError(`    → ${hint}`);
  };
  /** Una parte que puede fallar sin cortar las demás; los errores de token o base cortan todo. */
  const attempt = async <T>(section: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      if (!isAppError(error)) throw error;
      if (STOP_CODES.has(error.code)) throw new StopSmoke(error);
      failure(errorOf(section, error));
      return null;
    }
  };

  let account: PlatformAccount | undefined;
  let stopped: AppError | null = null;
  try {
    const found = await findAccount(deps, options.brokerSlug);
    account = found.account;
    report.account = {
      displayName: account.displayName,
      userType: userTypeSchema.parse(account.meta).userType ?? null,
    };
    deps.print(`Cuenta: ${account.displayName} (${found.slug})`);
    const ctx: MercadoLibreTokenContext = {
      accessToken: accessTokenProvider(
        { platformAccounts: deps.accounts, mercadoLibre: deps.mercadoLibre, now: deps.now },
        account.id,
      ),
      ...(signal === undefined ? {} : { signal }),
    };
    // Antes de recorrer: si el acceso no sirve, se sabe al tiro (y se renueva si está por vencer).
    try {
      await ctx.accessToken(signal === undefined ? {} : { signal });
    } catch (error) {
      if (isAppError(error)) throw new StopSmoke(error);
      throw error;
    }

    await walkCategories(
      deps,
      ctx,
      report,
      attempt,
      options.maxCategories ?? ML_SMOKE_MAX_CATEGORIES,
    );
    await readLocations(deps, ctx, report, attempt, account.brokerId);
    await validateVariants(deps, ctx, report, attempt, failure, {
      broker: found.broker,
      categoryId: options.categoryId,
    });
    await readSearch(deps, ctx, report, attempt, account.externalAccountId);
    await readPacks(deps, ctx, report, attempt, account.externalAccountId);
  } catch (error) {
    if (error instanceof StopSmoke) {
      stopped = error.error;
    } else if (isAppError(error)) {
      stopped = error;
    } else {
      throw error;
    }
  }

  if (stopped !== null) {
    report.errors.push(errorOf("stop", stopped));
    deps.printError(`✗ ${stopped.code}: ${stopped.message}`);
    const hint = isMercadoLibreRejectedAfterRefresh(stopped)
      ? REJECTED_AFTER_REFRESH_HINT
      : HINTS[stopped.code];
    if (hint !== undefined) deps.printError(`  → ${hint}`);
  }
  if (account !== undefined) {
    try {
      const where = await deps.writeReport(report);
      deps.print(`Informe completo: ${where}`);
    } catch (error) {
      deps.printError(
        `✗ No se pudo guardar el informe: ${isAppError(error) ? error.code : "error inesperado"}`,
      );
      return 1;
    }
  }
  if (stopped !== null) return 1;
  if (report.errors.length > 0) {
    deps.printError(`✗ ${report.errors.length} lectura(s) fallaron: revisa los ✗ de arriba`);
    return 1;
  }
  deps.print("✓ Listo. No se creó ni se cambió nada en Mercado Libre");
  return 0;
}

type Attempt = <T>(section: string, run: () => Promise<T>) => Promise<T | null>;

/** Recorre Inmuebles hasta las hojas, con sus obligatorios, y revisa la búsqueda por nombres. */
async function walkCategories(
  deps: MlSmokeDeps,
  ctx: MercadoLibreTokenContext,
  report: MlSmokeReport,
  attempt: Attempt,
  maxCategories: number,
) {
  deps.print(`\nCategorías de Inmuebles (${MERCADOLIBRE_REAL_ESTATE_CATEGORY_ID}):`);
  const stack: Array<{ id: string; path: string[] }> = [
    { id: MERCADOLIBRE_REAL_ESTATE_CATEGORY_ID, path: [] },
  ];
  const tags = new Map<string, Set<string>>();
  const titleLengths = new Set<string>();
  let failedInARow = 0;
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    if (report.categories.visited >= maxCategories) {
      report.categories.truncated = true;
      deps.printError(`  Aviso: se cortó el recorrido en ${maxCategories} categorías`);
      break;
    }
    report.categories.visited += 1;
    const node = await attempt(`category:${next.id}`, () => deps.catalog.category(next.id, ctx));
    if (node === null) {
      // Un 403 o un límite que se repite fallaría igual en cada categoría: no se insiste.
      failedInARow += 1;
      if (failedInARow >= ML_SMOKE_MAX_FAILURES_IN_A_ROW) {
        report.categories.truncated = true;
        deps.printError(
          `  Aviso: se cortó el recorrido después de ${failedInARow} categorías seguidas con error`,
        );
        break;
      }
      continue;
    }
    failedInARow = 0;
    // Al revés, para recorrer en el orden de Mercado Libre.
    for (const child of [...node.childrenCategories].reverse()) {
      stack.push({ id: child.id, path: [...next.path, child.name] });
    }
    if (node.settings.listingAllowed !== true) {
      if (node.childrenCategories.length === 0) {
        report.categories.deadEnds.push({ path: next.path, id: node.id });
      }
      continue;
    }
    deps.print(`  ${next.path.join(" > ")} · ${node.id} · ${settingsLine(node.settings)}`);
    titleLengths.add(`${node.settings.maxTitleLength ?? "?"}`);
    const attributes = await attempt(`attributes:${node.id}`, () =>
      deps.catalog.attributes(node.id, ctx),
    );
    const byName = await deps.catalog.leafCategory(next.path, ctx).then(
      (leaf) => (leaf.id === node.id ? "ok" : `otra hoja (${leaf.id})`),
      (error: unknown) => {
        if (!isAppError(error)) throw error;
        if (STOP_CODES.has(error.code)) throw new StopSmoke(error);
        const reason = error.details?.reason;
        return `${error.code}${typeof reason === "string" ? ` (${reason})` : ""}`;
      },
    );
    if (byName !== "ok") deps.printError(`    ✗ por nombre: ${byName}`);
    const required = (attributes ?? []).filter((attribute) => attribute.required).map(summary);
    const conditional = (attributes ?? [])
      .filter((attribute) => attribute.conditionalRequired && !attribute.required)
      .map(summary);
    const tagged = (attributes ?? [])
      .filter((attribute) => attribute.tags.some((tag) => CATEGORY_TAGS.includes(tag)))
      .map(summary);
    for (const attribute of [...required, ...conditional]) {
      for (const tag of attribute.tags.filter((name) => !REQUIRED_TAGS.has(name))) {
        tags.set(tag, (tags.get(tag) ?? new Set()).add(attribute.id));
      }
    }
    if (attributes !== null) {
      deps.print(`    obligatorios: ${required.map(attributeLabel).join(", ") || "ninguno"}`);
      if (conditional.length > 0) {
        deps.print(`    condicionales: ${conditional.map(attributeLabel).join(", ")}`);
      }
    }
    report.categories.leaves.push({
      path: next.path,
      id: node.id,
      settings: node.settings,
      required,
      conditional,
      tagged,
      byName,
    });
  }
  report.categories.requiredTags = Object.fromEntries(
    [...tags.entries()].map(([tag, ids]) => [tag, [...ids].sort()]),
  );
  deps.print(
    `  ${report.categories.leaves.length} hojas en ${report.categories.visited} categorías; largo del título: ${[...titleLengths].join(", ") || "?"}`,
  );
  checkPortalTable(deps, report);
  const tagLines = Object.entries(report.categories.requiredTags);
  deps.print(
    tagLines.length === 0
      ? "  Tags de los obligatorios: ninguno aparte de required"
      : `  Tags de los obligatorios: ${tagLines.map(([tag, ids]) => `${tag} (${ids.join(", ")})`).join("; ")}`,
  );
}

/**
 * Compara la tabla de obligatorios de Portal (core) con cada hoja que usa AgentSales (por tipo y
 * operación): si Mercado Libre sumó o quitó un obligatorio, se ve aquí y la tabla se pone al día.
 */
function checkPortalTable(deps: MlSmokeDeps, report: MlSmokeReport) {
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length &&
    a.every((name, index) => normalizePortalName(name) === normalizePortalName(b[index] ?? ""));
  for (const typeKey of PORTAL_PROPERTY_TYPE_KEYS) {
    const type = portalPropertyType(typeKey);
    for (const operation of OPERATIONS) {
      const path = portalCategoryPath(typeKey, operation);
      if (type === null || path === null) continue;
      const leaf = report.categories.leaves.find((item) => same(item.path, path));
      const table = PORTAL_ATTRIBUTE_FIELDS.filter((entry) => entry.required(type, operation)).map(
        (entry) => entry.attribute,
      );
      // Lo que completa la categoría (`read_only`, `fixed`, `hidden`) no lo pide la tabla.
      const required = (leaf?.required ?? [])
        .filter((attribute) => !attribute.tags.some((tag) => CATEGORY_TAGS.includes(tag)))
        .map((attribute) => attribute.id);
      const onlyTable = table.filter((id) => !required.includes(id));
      const onlyLeaf = required.filter((id) => !table.includes(id));
      if (leaf !== undefined && onlyTable.length === 0 && onlyLeaf.length === 0) continue;
      report.categories.tableCheck.push({ path, leafId: leaf?.id ?? null, onlyTable, onlyLeaf });
    }
  }
  if (report.categories.tableCheck.length === 0) {
    deps.print("  Tabla de Portal (obligatorios por tipo y operación): calza con las hojas reales");
    return;
  }
  deps.printError(
    "  Tabla de Portal: no calza con las hojas reales (ponla al día en core, portal/fields.ts):",
  );
  for (const diff of report.categories.tableCheck) {
    const parts = [
      diff.leafId === null ? "la hoja no apareció" : null,
      diff.onlyTable.length > 0 ? `la tabla pide de más: ${diff.onlyTable.join(", ")}` : null,
      diff.onlyLeaf.length > 0 ? `Mercado Libre pide además: ${diff.onlyLeaf.join(", ")}` : null,
    ].filter((part) => part !== null);
    deps.printError(`    ${diff.path.join(" > ")}: ${parts.join("; ")}`);
  }
}

/** Estados y ciudades de Chile (con la forma de sus ids) y la ubicación de los avisos del corredor. */
async function readLocations(
  deps: MlSmokeDeps,
  ctx: MercadoLibreTokenContext,
  report: MlSmokeReport,
  attempt: Attempt,
  brokerId: string,
) {
  deps.print(`\nUbicaciones de Chile (${MERCADOLIBRE_COUNTRY_ID}):`);
  const country = await attempt("location:country", () =>
    deps.catalog.locationNode("country", MERCADOLIBRE_COUNTRY_ID, ctx),
  );
  for (const ref of country?.children ?? []) {
    const validId = isMercadoLibreLocationId(ref.id);
    const entry: MlSmokeReport["locations"]["states"][number] = {
      id: ref.id,
      name: ref.name,
      validId,
      cities: [],
    };
    report.locations.states.push(entry);
    if (!validId) {
      deps.printError(`  ✗ ${ref.name}: su id no tiene la forma esperada (no se puede leer)`);
      continue;
    }
    const state = await attempt(`location:${ref.id}`, () =>
      deps.catalog.locationNode("state", ref.id, ctx),
    );
    if (state === null) continue;
    entry.cities = state.children.map((city) => ({
      id: city.id,
      name: city.name,
      validId: isMercadoLibreLocationId(city.id),
    }));
    const invalid = entry.cities.filter((city) => !city.validId);
    deps.print(`  ${ref.name} · ${ref.id} · ${entry.cities.length} ciudades`);
    if (invalid.length > 0) {
      deps.printError(`    ✗ ids con otra forma: ${invalid.map((city) => city.name).join(", ")}`);
    }
  }

  const listings = (await deps.listings.list())
    .filter((listing) => listing.brokerId === brokerId)
    .sort((a, b) => a.externalRef.localeCompare(b.externalRef));
  if (listings.length > 0) deps.print("  Avisos del corredor:");
  for (const listing of listings) {
    const entry: MlSmokeReport["locations"]["listings"][number] = {
      externalRef: listing.externalRef,
      region: listing.region,
      commune: listing.comuna,
      match: null,
      error: null,
    };
    report.locations.listings.push(entry);
    if (listing.region === null || listing.comuna === null) {
      entry.error = "SIN_UBICACION";
      deps.print(`    ${listing.externalRef}: sin región o comuna`);
      continue;
    }
    const place = { region: listing.region, commune: listing.comuna };
    try {
      const match = await deps.catalog.location(place, ctx);
      entry.match = {
        state: match.state.name,
        city: match.city.name,
        neighborhood: match.neighborhood?.name ?? null,
      };
      deps.print(
        `    ${listing.externalRef}: ${place.region} / ${place.commune} → ${match.state.name} / ${match.city.name}${match.neighborhood === null ? "" : ` / ${match.neighborhood.name}`}`,
      );
      if (report.locations.sampleCity === null) {
        const city = await attempt(`location:${match.city.id}`, () =>
          deps.catalog.locationNode("city", match.city.id, ctx),
        );
        if (city !== null) {
          report.locations.sampleCity = {
            id: city.id,
            name: city.name,
            neighborhoods: city.children,
          };
          deps.print(`      ${city.name} tiene ${city.children.length} barrios en Mercado Libre`);
        }
      }
    } catch (error) {
      if (!isAppError(error)) throw error;
      if (STOP_CODES.has(error.code)) throw new StopSmoke(error);
      entry.error = error.code;
      deps.printError(`    ✗ ${listing.externalRef}: ${error.code}: ${error.message}`);
    }
  }
}

/** El cuerpo de prueba (nota §4.1) y sus variantes, preguntadas a `POST /items/validate`. */
async function validateVariants(
  deps: MlSmokeDeps,
  ctx: MercadoLibreTokenContext,
  report: MlSmokeReport,
  attempt: Attempt,
  failure: (error: MlSmokeError) => void,
  options: { broker: Pick<Broker, "name" | "email" | "whatsapp"> | undefined; categoryId?: string },
) {
  deps.print("\nValidar sin publicar (POST /items/validate):");
  const leaf = pickLeaf(report.categories.leaves, options.categoryId);
  if (leaf === null) {
    report.errors.push({
      section: "validate",
      code: "ML_SMOKE_LEAF_NOT_FOUND",
      message:
        options.categoryId === undefined
          ? "No hay hojas para validar"
          : `${options.categoryId} no es una de las hojas recorridas`,
    });
    deps.printError("  ✗ No hay una hoja para armar el aviso de prueba");
    return;
  }
  report.validate.leaf = { id: leaf.id, path: leaf.path };
  deps.print(`  Hoja: ${leaf.path.join(" > ")} (${leaf.id})`);
  const attributes = await attempt("validate:attributes", () =>
    deps.catalog.attributes(leaf.id, ctx),
  );
  if (attributes === null) return;

  const samples = attributes.flatMap((attribute) => {
    const sample = sampleAttribute(attribute);
    return sample === null ? [] : [sample];
  });
  report.validate.missingSamples = attributes
    .filter(
      (attribute) =>
        (attribute.required || attribute.conditionalRequired) &&
        !attribute.tags.some((tag) => CATEGORY_TAGS.includes(tag)) &&
        SAMPLE_ATTRIBUTES[attribute.id] === undefined,
    )
    .map((attribute) => attribute.id);
  if (report.validate.missingSamples.length > 0) {
    deps.print(`  Obligatorios sin valor de muestra: ${report.validate.missingSamples.join(", ")}`);
  }

  const contact = sellerContact(options.broker);
  report.validate.contact = contact.source;
  deps.print(
    contact.source === "broker"
      ? `  Contacto: el del corredor (WhatsApp ${maskWhatsapp(`+${contact.body.country_code2}${contact.body.phone2}`)})`
      : "  Contacto: uno de muestra (el corredor no tiene WhatsApp en su hoja)",
  );

  // Una ubicación real: la del primer aviso que calzó o, si no, el primer estado y ciudad.
  const firstListing = report.locations.listings.find((listing) => listing.match !== null);
  const state =
    report.locations.states.find((item) => item.name === firstListing?.match?.state) ??
    report.locations.states.find((item) => item.cities.length > 0);
  const city =
    state?.cities.find((item) => item.name === firstListing?.match?.city) ?? state?.cities[0];
  if (state === undefined || city === undefined) {
    deps.printError("  Aviso: sin estados ni ciudades; el aviso va sin ubicación");
  }
  const location = {
    address_line: "Calle de Prueba 123",
    country: { id: MERCADOLIBRE_COUNTRY_ID },
    ...(state === undefined ? {} : { state: { id: state.id } }),
    ...(city === undefined ? {} : { city: { id: city.id } }),
  };

  const base: Record<string, unknown> = {
    title: ML_SMOKE_TITLE,
    category_id: leaf.id,
    price: 150_000_000,
    currency_id: "CLP",
    available_quantity: 1,
    buying_mode: "classified",
    listing_type_id: "silver",
    condition: "not_specified",
    channels: ["marketplace"],
    pictures: [{ source: ML_SMOKE_PICTURE }],
    location,
    seller_contact: contact.body,
    attributes: [...samples, CMG_SITE_FULL],
  };
  const maxTitle = leaf.settings.maxTitleLength ?? 60;
  const longTitle = `${ML_SMOKE_TITLE} ${"x".repeat(maxTitle)}`.slice(0, maxTitle + 1);
  const { address_line: _addressLine, ...withoutAddress } = location;
  const variants: Array<[string, MercadoLibreItemBody]> = [
    ["base (CLP, con dirección y CMG_SITE completo)", base],
    ["sin address_line", { ...base, location: withoutAddress }],
    [
      "descripción en el cuerpo",
      { ...base, description: { plain_text: "Aviso de prueba de AgentSales: no publicar." } },
    ],
    ["CMG_SITE corto", { ...base, attributes: [...samples, CMG_SITE_SHORT] }],
    ["sin CMG_SITE", { ...base, attributes: samples }],
    ["CLF (UF con 2 decimales)", { ...base, price: 5800.25, currency_id: "CLF" }],
    [`título de ${maxTitle + 1} caracteres`, { ...base, title: longTitle }],
  ];
  for (const [name, body] of variants) {
    const entry: MlSmokeReport["validate"]["variants"][number] = {
      name,
      valid: null,
      errors: [],
      warnings: [],
      issues: [],
      error: null,
    };
    report.validate.variants.push(entry);
    let result: MercadoLibreValidation;
    try {
      result = await withMercadoLibreToken(ctx, (token, callSignal) =>
        deps.validator.validate(
          token,
          body,
          callSignal === undefined ? {} : { signal: callSignal },
        ),
      );
    } catch (error) {
      if (!isAppError(error)) throw error;
      if (STOP_CODES.has(error.code)) throw new StopSmoke(error);
      entry.error = errorOf(`validate:${name}`, error);
      // Sin cupo, un rechazo sin causas o con ellas: es lo que se busca ver (un resultado). Lo
      // demás (permiso, caída, respuesta rara, un cuerpo que no se armó) no enseña nada: es un
      // error del smoke, con su pista.
      if (VALIDATE_RESULTS.has(error.code)) {
        deps.print(`  ${name}: ✗ ${error.code}${mercadoLibreCodes(entry.error)}`);
      } else {
        deps.print(`  ${name}: ✗ no se pudo validar`);
        failure(entry.error);
      }
      continue;
    }
    entry.valid = result.valid;
    entry.warnings = result.warnings;
    const warnings =
      result.warnings.length === 0
        ? ""
        : `; advertencias: ${result.warnings.map(causeLabel).join(", ")}`;
    if (result.valid) {
      deps.print(`  ${name}: ✓ válido${warnings}`);
      continue;
    }
    entry.errors = result.errors;
    entry.issues = result.issues;
    deps.print(`  ${name}: rechazado: ${result.errors.map(causeLabel).join(", ")}${warnings}`);
    for (const cause of result.errors) deps.print(`    · ${describeCause(cause)}`);
  }
  if (report.validate.variants.some((variant) => variant.error?.code === "ML_NO_QUOTA")) {
    deps.print(
      "  → Sin un paquete silver con cupo, Mercado Libre responde 402 y no revisa el resto del aviso (sí el título): contrátalo antes de la prueba con paquete",
    );
  }
}

/** Qué estados trae la búsqueda de ítems sin `status` (la retoma de T14 depende de esto). */
async function readSearch(
  deps: MlSmokeDeps,
  ctx: MercadoLibreTokenContext,
  report: MlSmokeReport,
  attempt: Attempt,
  userId: string,
) {
  deps.print("\nBúsqueda de ítems del vendedor (sin status, include_filters=true):");
  const search = await attempt("search", () =>
    withMercadoLibreToken(ctx, (token, callSignal) =>
      deps.items.searchItems(
        token,
        userId,
        { includeFilters: true },
        callSignal === undefined ? {} : { signal: callSignal },
      ),
    ),
  );
  if (search === null) return;
  report.search = search;
  deps.print(`  ${search.total ?? search.results.length} ítems`);
  const show = (filters: MercadoLibreItemSearch["filters"]) =>
    filters
      .map(
        (filter) =>
          `${filter.id}: ${filter.values.map((value) => (value.results === null ? value.id : `${value.id} (${value.results})`)).join(", ") || "sin valores"}`,
      )
      .join("; ");
  deps.print(`  Filtros aplicados: ${show(search.filters) || "ninguno"}`);
  const status = search.availableFilters.filter((filter) => filter.id === "status");
  deps.print(`  Estados disponibles: ${show(status) || "sin filtro de estado"}`);
}

/** Paquetes contratados por la cuenta y los que se pueden contratar en Inmuebles (solo lectura). */
async function readPacks(
  deps: MlSmokeDeps,
  ctx: MercadoLibreTokenContext,
  report: MlSmokeReport,
  attempt: Attempt,
  userId: string,
) {
  const call = <T>(run: (token: string, callOptions: { signal?: AbortSignalLike }) => Promise<T>) =>
    withMercadoLibreToken(ctx, (token, callSignal) =>
      run(token, callSignal === undefined ? {} : { signal: callSignal }),
    );
  const line = (pack: MercadoLibrePackList["packs"][number]) => {
    const listings = pack.listings
      .map(
        (listing) =>
          `${listing.listingTypeId ?? "?"}: ${listing.available ?? "?"} disponibles${listing.used === null ? "" : `, ${listing.used} usados`}`,
      )
      .join("; ");
    const parts = [
      pack.description ?? pack.id ?? "(sin nombre)",
      pack.status,
      pack.remainingListings === null ? null : `quedan ${pack.remainingListings}`,
      listings || null,
      pack.price === null
        ? null
        : `precio ${pack.price}${pack.currencyId === null ? "" : ` ${pack.currencyId}`}`,
      pack.duration === null ? null : `${pack.duration} días`,
      pack.dateExpires === null ? null : `vence ${pack.dateExpires}`,
    ].filter((part) => part !== null);
    return `    ${parts.join(" · ")}`;
  };
  const show = (title: string, list: MercadoLibrePackList | null) => {
    if (list === null) return;
    deps.print(
      `  ${title}: ${list.packs.length}${list.container === null ? "" : ` (en "${list.container}")`}`,
    );
    for (const pack of list.packs) deps.print(line(pack));
    if (list.packs.length === 0 && list.fields.length > 0) {
      deps.print(`    campos de la respuesta: ${list.fields.join(", ")}`);
    }
  };

  deps.print("\nPaquetes de publicación:");
  report.packs.user = await attempt("packs:user", async () => {
    try {
      return await call((token, callOptions) => deps.packs.userPacks(token, userId, callOptions));
    } catch (error) {
      // Sin paquetes contratados, Mercado Libre responde 404 `not_found`: es un resultado.
      if (!isAppError(error) || error.details?.httpStatus !== 404) throw error;
      report.packs.userNotFound = true;
      return null;
    }
  });
  if (report.packs.userNotFound) {
    deps.print("  Contratados por la cuenta: ninguno (Mercado Libre respondió 404 not_found)");
  }
  show("Contratados por la cuenta", report.packs.user);
  report.packs.category = await attempt("packs:category", () =>
    call((token, callOptions) =>
      deps.packs.categoryPacks(token, MERCADOLIBRE_REAL_ESTATE_CATEGORY_ID, callOptions),
    ),
  );
  show(
    `Para contratar en Inmuebles (${MERCADOLIBRE_REAL_ESTATE_CATEGORY_ID})`,
    report.packs.category,
  );
}
