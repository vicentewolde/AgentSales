import type { Broker } from "../broker.js";
import {
  type BrandCardStyle,
  type CardComposition,
  type CardFooterParts,
  type CardStyle,
  cardFooterParts,
  cardFooterText,
  lowContrastPairs,
  parseCardStyle,
} from "../card-style.js";
import { AppError } from "../errors.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { CardStyleRepository } from "../ports/card-style-repository.js";
import type { PlatformAccountRepository } from "../ports/platform-account-repository.js";
import type { PostImageFormat } from "../post-image.js";
import type { User } from "../user.js";
import { assertBrandAccess } from "./brand-knowledge.js";

// El estilo de las imágenes de la marca (spec F9.7 B4, ADR-0043): leer (`broker.view`), guardar
// (`brand.edit`, validado con `parseCardStyle`) y una lámina de muestra con un estilo (guardado o
// el que se está editando).

type Actor = Pick<User, "role" | "brokerId">;

/** Un aviso de contraste: un texto de un tema que no llega a 4,5:1 (se guarda igual). */
export type CardStyleWarning = { theme: string; what: string; text: string; background: string };

export type CardStyleView = {
  brokerId: string;
  style: CardStyle | null;
  version: number | null;
  updatedAt: Date | null;
  warnings: CardStyleWarning[];
  /** Lo que lleva el pie de las láminas con estilo (`null`, lo que no está en ninguna parte). */
  footer: CardFooterParts;
};

const warningsOf = (style: CardStyle | null): CardStyleWarning[] =>
  style === null
    ? []
    : style.themes.flatMap((theme) =>
        lowContrastPairs(theme).map((pair) => ({ theme: theme.name, ...pair })),
      );

const viewOf = (
  brokerId: string,
  saved: BrandCardStyle | null,
  footer: CardFooterParts,
): CardStyleView => ({
  brokerId,
  style: saved?.style ?? null,
  version: saved?.version ?? null,
  updatedAt: saved?.updatedAt ?? null,
  warnings: warningsOf(saved?.style ?? null),
  footer,
});

const brokerOf = async (deps: Deps, brokerId: string) => {
  const broker = await deps.brokers.findById(brokerId);
  if (broker === null) throw new AppError("BROKER_NOT_FOUND", "La marca no existe");
  return broker;
};

type Deps = {
  brokers: Pick<BrokerRepository, "findById">;
  cardStyles: Pick<CardStyleRepository, "get" | "save">;
  /** Las cuentas de la marca, para el usuario de Instagram o X del pie. */
  platformAccounts?: Pick<PlatformAccountRepository, "listByBroker">;
};

/** El pie que sale en las láminas con ese estilo (del estilo, de la marca o de sus cuentas). */
async function footerOf(
  deps: Deps,
  broker: Pick<Broker, "id" | "website" | "instagramHandle">,
  style: CardStyle | null,
): Promise<CardFooterParts> {
  return cardFooterParts({
    footer: style?.footer,
    broker,
    accounts: (await deps.platformAccounts?.listByBroker(broker.id)) ?? [],
  });
}

export async function getCardStyle(deps: Deps, actor: Actor, brokerId: string) {
  await assertBrandAccess(deps.brokers, actor, brokerId, "broker.view");
  const saved = await deps.cardStyles.get(brokerId);
  const broker = await brokerOf(deps, brokerId);
  return viewOf(brokerId, saved, await footerOf(deps, broker, saved?.style ?? null));
}

/** Guarda el estilo (`brand.edit`): `CARD_STYLE_INVALID` (400) si no sirve; avisa el contraste. */
export async function saveCardStyle(
  deps: Deps,
  actor: Actor,
  brokerId: string,
  input: unknown,
): Promise<CardStyleView> {
  await assertBrandAccess(deps.brokers, actor, brokerId, "brand.edit");
  const style = parseCardStyle(input);
  const saved = await deps.cardStyles.save(brokerId, style);
  const broker = await brokerOf(deps, brokerId);
  return viewOf(brokerId, saved, await footerOf(deps, broker, style));
}

/** Dibuja una lámina de muestra (lo hace `@agentsales/media`; en las pruebas, un doble). */
export type CardStylePreviewer = (params: {
  style: CardStyle;
  brandName: string;
  detail: string | null;
  theme: number;
  composition: CardComposition;
  format: PostImageFormat;
}) => Promise<Uint8Array>;

/**
 * Una lámina de muestra (`broker.view`): con el estilo que viene (el que se está editando,
 * validado) o, sin él, el guardado. `CARD_STYLE_NOT_FOUND` (404) si no hay ninguno.
 */
export async function previewCardStyle(
  deps: Deps & { preview: CardStylePreviewer },
  actor: Actor,
  brokerId: string,
  input: {
    style?: unknown;
    theme: number;
    composition: CardComposition;
    format: PostImageFormat;
  },
): Promise<Uint8Array> {
  await assertBrandAccess(deps.brokers, actor, brokerId, "broker.view");
  const broker = await deps.brokers.findById(brokerId);
  const style =
    input.style === undefined
      ? ((await deps.cardStyles.get(brokerId))?.style ?? null)
      : parseCardStyle(input.style);
  if (style === null || broker === null) {
    throw new AppError("CARD_STYLE_NOT_FOUND", "La marca todavía no tiene estilo de imágenes");
  }
  // El pie de las láminas del servidor: el del estilo, o el de la marca y sus cuentas.
  const detail = cardFooterText(await footerOf(deps, broker, style));
  return deps.preview({
    style,
    brandName: broker.brandName,
    detail,
    theme: input.theme,
    composition: input.composition,
    format: input.format,
  });
}
