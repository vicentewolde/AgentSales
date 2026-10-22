import {
  assertAutoPublishAllowed,
  assertLiveAllowed,
  assertLiveConfirmed,
  type Broker,
  type BrokerBrandInput,
  normalizeBrokerBrand,
  normalizeLlmMonthlyCap,
} from "../broker.js";
import { AppError } from "../errors.js";
import { assertCan } from "../permissions.js";
import type { BrokerRepository } from "../ports/broker-repository.js";
import type { User } from "../user.js";

export type UpdateBrokerInput = BrokerBrandInput & {
  /** Solo el administrador (spec F7 §4.6): si es propio, el tope de IA y la publicación automática. */
  operatorOwned?: boolean;
  llmMonthlyCapUsd?: number | null;
  autoPublish?: boolean;
  /**
   * Encender o apagar el modo en vivo de la marca (F9.5-T22, ADR-0036), solo el administrador y solo
   * en un corredor propio. Encender exige `liveConfirm` con el `slug` del corredor.
   */
  liveEnabled?: boolean;
  liveConfirm?: string;
};

const BRAND_KEYS = [
  "name",
  "brandName",
  "primaryColor",
  "secondaryColor",
  "whatsapp",
  "email",
  "instagramHandle",
  "website",
  "tone",
  "fixedHashtags",
] as const satisfies readonly (keyof BrokerBrandInput)[];

/**
 * Edita un corredor (spec F7 §4.6): su marca la cambian el corredor y el administrador
 * (`brand.edit`); si es propio, el tope de IA y la publicación automática, solo el administrador
 * (`broker.settings`, si no `FORBIDDEN` 403, sin cambiar nada). La marca se valida entera antes de
 * escribir (`BROKER_INVALID`). La marca, los ajustes y `autoPublish` se escriben por separado: un
 * fallo de la base entre medio deja lo primero guardado, y repetir el pedido lo completa.
 * Activar `autoPublish` en una marca es `BROKER_IS_BRAND` (409), sin cambiar nada (F9).
 * Encender el modo en vivo (`liveEnabled`, F9.5-T22, ADR-0036) también es del administrador
 * (`broker.settings`), solo en un corredor propio (`LIVE_NOT_ALLOWED` 409) y repitiendo su `slug`
 * (`LIVE_NOT_CONFIRMED` 409); apagarlo no pide confirmación. Si se deja de ser propio, se apaga.
 */
export async function updateBroker(
  deps: {
    brokers: Pick<
      BrokerRepository,
      "findById" | "update" | "setSettings" | "setAutoPublish" | "setLiveEnabled"
    >;
  },
  actor: Pick<User, "role" | "brokerId">,
  id: string,
  input: UpdateBrokerInput,
): Promise<Broker> {
  const brandInput: BrokerBrandInput = {};
  for (const key of BRAND_KEYS) {
    if (input[key] !== undefined) Object.assign(brandInput, { [key]: input[key] });
  }
  // Como en el alta y en la hoja: el secundario vacío toma el primario (el nuevo o el vigente).
  const clearSecondary =
    brandInput.secondaryColor === null || brandInput.secondaryColor?.trim() === "";
  const hasBrand = Object.keys(brandInput).length > 0;
  const hasSettings =
    input.operatorOwned !== undefined ||
    input.llmMonthlyCapUsd !== undefined ||
    input.autoPublish !== undefined ||
    input.liveEnabled !== undefined;
  if (hasBrand) assertCan(actor, "brand.edit", id);
  if (hasSettings) assertCan(actor, "broker.settings", id);
  if (!hasBrand && !hasSettings) {
    throw new AppError("BROKER_INVALID", "No hay nada que cambiar en el corredor");
  }
  const brand = hasBrand
    ? normalizeBrokerBrand(
        clearSecondary ? { ...brandInput, secondaryColor: undefined } : brandInput,
      )
    : {};
  const cap =
    input.llmMonthlyCapUsd === undefined
      ? undefined
      : normalizeLlmMonthlyCap(input.llmMonthlyCapUsd);

  let broker = await deps.brokers.findById(id);
  if (broker === null) {
    throw new AppError("BROKER_NOT_FOUND", `No existe el corredor ${id}`, { details: { id } });
  }
  // Antes de escribir nada: la publicación automática no se activa en una marca (F9, ADR-0029).
  if (input.autoPublish === true) assertAutoPublishAllowed(broker);
  // Lo mismo con el modo en vivo: solo un corredor propio (el que ya lo es o el que se vuelve propio
  // en este mismo pedido) y con el `slug` repetido.
  if (input.liveEnabled === true) {
    assertLiveAllowed({
      slug: broker.slug,
      operatorOwned: input.operatorOwned ?? broker.operatorOwned,
    });
    assertLiveConfirmed(broker, input.liveConfirm);
  }
  if (clearSecondary) brand.secondaryColor = brand.primaryColor ?? broker.primaryColor;
  if (hasBrand) {
    const {
      id: _id,
      logoMediaId: _logo,
      autoPublish: _auto,
      liveEnabled: _live,
      operatorOwned: _own,
      llmMonthlyCapUsd: _cap,
      kind: _kind,
      ...data
    } = broker;
    broker = await deps.brokers.update(id, { ...data, ...brand });
  }
  if (input.operatorOwned !== undefined || cap !== undefined) {
    broker = await deps.brokers.setSettings(id, {
      ...(input.operatorOwned === undefined ? {} : { operatorOwned: input.operatorOwned }),
      ...(cap === undefined ? {} : { llmMonthlyCapUsd: cap }),
    });
  }
  if (input.autoPublish !== undefined) {
    broker = await deps.brokers.setAutoPublish(id, input.autoPublish);
  }
  // Un corredor que deja de ser propio ya no puede estar en vivo: se apaga aunque no se pida.
  const liveEnabled =
    input.operatorOwned === false && broker.liveEnabled ? false : input.liveEnabled;
  if (liveEnabled !== undefined && liveEnabled !== broker.liveEnabled) {
    broker = await deps.brokers.setLiveEnabled(id, liveEnabled);
  }
  return broker;
}
