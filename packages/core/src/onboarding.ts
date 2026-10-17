import type { Broker } from "./broker.js";
import type { PlatformAccount } from "./platform-account.js";
import type { User } from "./user.js";

// La lista de alta de un corredor (spec F7 §4.6): qué falta para que publique solo, y quién lo hace.

export const ONBOARDING_STEPS = [
  "brand",
  "logo",
  "whatsapp",
  "user",
  "instagram",
  "mercadolibre",
  "marketplace",
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
 * un usuario activo con su contraseña, Instagram, Mercado Libre y Marketplace (a mano o
 * automático) conectados. Pura: recibe los usuarios y las cuentas **de ese corredor**.
 */
export function onboardingSteps(input: {
  broker: Broker;
  users: readonly Pick<User, "role" | "brokerId" | "hasPassword" | "disabledAt">[];
  accounts: readonly Pick<PlatformAccount, "brokerId" | "platform" | "status">[];
}): OnboardingStep[] {
  const { broker } = input;
  const users = input.users.filter(
    (user) => user.role === "broker" && user.brokerId === broker.id && user.disabledAt === null,
  );
  const connected = (platform: PlatformAccount["platform"]) =>
    input.accounts.some(
      (account) =>
        account.brokerId === broker.id &&
        account.platform === platform &&
        account.status === "connected",
    );
  const invited = users.length > 0;
  return [
    step(
      "brand",
      broker.brandName.trim() !== "" && broker.primaryColor !== "",
      "broker",
      "la marca y sus colores",
    ),
    step("logo", broker.logoMediaId !== null, "broker", "subir el logo"),
    step("whatsapp", broker.whatsapp !== null, "broker", "el WhatsApp (Portal lo exige)"),
    // Invitar es del administrador; elegir la contraseña, del corredor (con el enlace).
    invited
      ? step(
          "user",
          users.some((user) => user.hasPassword),
          "broker",
          "aceptar la invitación y elegir la contraseña",
        )
      : step("user", false, "admin", "invitar a su usuario"),
    step("instagram", connected("instagram"), "admin", "conectar su Instagram"),
    step("mercadolibre", connected("portal_inmobiliario"), "admin", "conectar su Mercado Libre"),
    step(
      "marketplace",
      connected("fb_marketplace"),
      "admin",
      "activar Marketplace (a mano o automático)",
    ),
  ];
}
