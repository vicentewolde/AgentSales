import { accountOwnedBy } from "./accounts/owner.js";
import type { Broker } from "./broker.js";
import type { EditorialProfile } from "./editorial-profile.js";
import { type BrokerKind, isPostPlatform, POST_PLATFORMS } from "./enums.js";
import { PLATFORM_TEXT } from "./labels.js";
import type { PlatformAccount } from "./platform-account.js";
import type { User } from "./user.js";

// La lista de alta de un corredor (spec F7 §4.6): qué falta para que publique solo, y quién lo hace.
// Una marca (`kind = brand`, spec F9 §4.3) tiene la suya: solo publica posts.

export const ONBOARDING_STEPS = [
  "brand",
  "logo",
  "whatsapp",
  "editorial",
  "user",
  "instagram",
  "mercadolibre",
  "marketplace",
  "networks",
] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEPS)[number];

/** Quién hace un paso que falta: el corredor (Mi marca) o el administrador. */
export type OnboardingOwner = "broker" | "admin";

export type OnboardingStep = {
  key: OnboardingStepKey;
  done: boolean;
  /** Quién lo hace si falta (`null` si está hecho). */
  owner: OnboardingOwner | null;
  /** Qué falta, en una línea (`null` si está hecho). */
  pending: string | null;
};

const step = (
  key: OnboardingStepKey,
  done: boolean,
  owner: OnboardingOwner,
  pending: string,
): OnboardingStep =>
  done ? { key, done, owner: null, pending: null } : { key, done, owner, pending };

/**
 * Los pasos del alta de un corredor, en orden: marca y colores, logo, WhatsApp (Portal lo exige),
 * un usuario activo con su contraseña (no hace falta en uno propio del operador), Instagram (lo
 * conecta el propio corredor, ADR-0028), Mercado Libre y Marketplace (a mano o automático)
 * conectados. Pura: recibe los usuarios, las cuentas y el perfil editorial **de ese corredor**.
 *
 * Una marca (`kind = brand`) solo publica posts (spec F9 §4.3, ADR-0029): no tiene WhatsApp,
 * Mercado Libre ni Marketplace (son de los avisos) ni logo (lo usan solo la portada y la ficha de
 * un aviso). Sus pasos son marca, perfil editorial (al menos una línea de contenido y un hecho:
 * sin hechos la IA no puede afirmar nada), usuario y al menos una red de los posts conectada
 * (`POST_PLATFORMS`; la conecta la marca, salvo Discord, que es del administrador: ADR-0022).
 * `editorialProfile` solo cuenta en una marca (`null` o ausente: no tiene). Los pasos salen de un
 * `switch` exhaustivo sobre `kind`: un `kind` nuevo no compila hasta decidir los suyos.
 */
export function onboardingSteps(input: {
  broker: Broker;
  users: readonly Pick<User, "role" | "brokerId" | "hasPassword" | "disabledAt">[];
  accounts: readonly Pick<PlatformAccount, "brokerId" | "platform" | "status">[];
  editorialProfile?: Pick<EditorialProfile, "pillars" | "facts"> | null;
}): OnboardingStep[] {
  const { broker } = input;
  const users = input.users.filter(
    (user) => user.role === "broker" && user.brokerId === broker.id && user.disabledAt === null,
  );
  const isConnected = (account: Pick<PlatformAccount, "brokerId" | "status">) =>
    accountOwnedBy(account, broker.id) && account.status === "connected";
  const connected = (platform: PlatformAccount["platform"]) =>
    input.accounts.some((account) => isConnected(account) && account.platform === platform);
  const invited = users.length > 0;
  const brandStep = step(
    "brand",
    broker.brandName.trim() !== "" && broker.primaryColor !== "",
    "broker",
    "la marca y sus colores",
  );
  // Invitar es del administrador; elegir la contraseña, del corredor (con el enlace). Un
  // corredor propio lo maneja el operador con su usuario: no necesita uno.
  const userStep = broker.operatorOwned
    ? step("user", true, "admin", "")
    : invited
      ? step(
          "user",
          users.some((user) => user.hasPassword),
          "broker",
          "aceptar la invitación y elegir la contraseña",
        )
      : step("user", false, "admin", "invitar a su usuario");
  const kind: BrokerKind = broker.kind;
  switch (kind) {
    case "broker":
      return [
        brandStep,
        step("logo", broker.logoMediaId !== null, "broker", "subir el logo"),
        step("whatsapp", broker.whatsapp !== null, "broker", "el WhatsApp (Portal lo exige)"),
        userStep,
        step("instagram", connected("instagram"), "broker", "conectar su Instagram (en Cuentas)"),
        step(
          "mercadolibre",
          connected("portal_inmobiliario"),
          "admin",
          "conectar su Mercado Libre",
        ),
        step(
          "marketplace",
          connected("fb_marketplace"),
          "admin",
          "activar Marketplace (a mano o automático)",
        ),
      ];
    case "brand": {
      const profile = input.editorialProfile ?? null;
      const selfConnected = POST_PLATFORMS.filter((platform) => platform !== "discord");
      return [
        brandStep,
        step(
          "editorial",
          profile !== null && profile.pillars.length > 0 && profile.facts.length > 0,
          "broker",
          "el perfil editorial (al menos una línea de contenido y un hecho)",
        ),
        userStep,
        step(
          "networks",
          input.accounts.some(
            (account) => isConnected(account) && isPostPlatform(account.platform),
          ),
          "broker",
          `conectar al menos una red de los posts en Cuentas (${selfConnected.map((platform) => PLATFORM_TEXT[platform]).join(", ")}; Discord lo conecta el administrador)`,
        ),
      ];
    }
    default:
      return kind satisfies never;
  }
}
