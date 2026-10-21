import type { PublicationStatus } from "../enums.js";
import { AppError } from "../errors.js";
import { linksIn, X_LINK_POST_COST_USD, X_POST_COST_USD } from "../social/networks.js";

// El costo de X (spec F9 §4.12, `x.md` §2): pago por uso con créditos prepagados. Lo que se anota
// es una **estimación** (`publications.cost_usd`): el saldo real está en la consola de X, y qué
// cobra exactamente X (si un 4xx cobra, si la URL de un medio cuenta como enlace) lo confirma la
// prueba S4 antes de publicar de verdad.

/**
 * Los estados de una publicación que cuentan para el gasto del mes (`sumCostUsdSince`): las que
 * pudieron cobrar (publicando, publicadas, pausadas, retiradas o con resultado dudoso). Una fallida
 * no cuenta: si X cobra un 4xx lo confirma la prueba S4 (`x.md` §2.1).
 */
export const COST_COUNTED_STATUSES = [
  "publishing",
  "published",
  "paused",
  "unpublished",
  "outcome_unknown",
] as const satisfies readonly PublicationStatus[];

/** Si el texto que se envía a X lleva un enlace (lo que X cobra a US$0,20). */
export const xPostHasLink = (caption: string): boolean => linksIn(caption).length > 0;

/** El costo estimado de un post de X: US$0,015, o US$0,20 si el texto lleva un enlace. */
export const xPostCostUsd = (caption: string): number =>
  xPostHasLink(caption) ? X_LINK_POST_COST_USD : X_POST_COST_USD;

/** Dólares en español de Chile: `US$0,015`, `US$0,20`, `US$10` (con centavos, al menos dos decimales). */
export const formatXUsd = (value: number): string =>
  `US$${value.toLocaleString("es-CL", {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 4,
  })}`;

/**
 * `X_SPEND_LIMIT_REACHED` (no reintentable): con este post, el gasto estimado del mes de la cuenta
 * pasaría su tope. No se llamó a X.
 */
export const xSpendLimitReached = (details: {
  spentUsd: number;
  costUsd: number;
  limitUsd: number;
}) =>
  new AppError(
    "X_SPEND_LIMIT_REACHED",
    `La cuenta de X llegó a su tope de gasto del mes (${formatXUsd(details.limitUsd)}; van ${formatXUsd(details.spentUsd)} y este post costaría ${formatXUsd(details.costUsd)}): sube el tope con accounts spend-limit o espera al mes siguiente`,
    { details },
  );

/**
 * `X_LINK_NOT_ALLOWED` (no reintentable): el texto de X lleva un enlace y el post no tiene la marca
 * del operador (`xLinkAllowed`, F9-T16). No se llamó a X.
 */
export const xLinkNotAllowed = (postId: string | null) =>
  new AppError(
    "X_LINK_NOT_ALLOWED",
    `El texto de X lleva un enlace (cuesta ${formatXUsd(X_LINK_POST_COST_USD)} en vez de ${formatXUsd(X_POST_COST_USD)}) y el post no lo tiene permitido: permítelo en el post («Permitir un enlace en X» en el panel, o post edit --x-link en la CLI) o quita el enlace`,
    { details: { postId } },
  );
