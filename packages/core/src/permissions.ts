import { type AccessScope, ALL_SCOPE, brokerScope } from "./access.js";
import { AppError } from "./errors.js";
import type { User } from "./user.js";

// Lo que puede hacer cada rol (spec F7 §4.5, D2): el corredor hace casi todo con lo suyo; el
// administrador, todo.

export const PERMISSIONS = [
  /** Ver, cargar, preparar, editar textos, aprobar, publicar, programar y cambiar propiedades. */
  "listings.manage",
  /** "Lo publiqué" o "No lo publiqué" en Marketplace. */
  "marketplace.confirm",
  /** Editar la marca, subir el logo y bajar la planilla. */
  "brand.edit",
  /** Ver las cuentas, el gasto de IA y la lista de alta del corredor. */
  "broker.view",
  /** Conectar, renovar y desconectar cuentas; activar Marketplace a mano. */
  "accounts.manage",
  /** Publicación automática, tope de IA y "corredor propio". */
  "broker.settings",
  "brokers.create",
  /** Crear, restablecer, desactivar y reactivar usuarios. */
  "users.manage",
  /** `/health` con detalle y lo que es solo de desarrollo (`/imports/local`). */
  "system.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Lo que un usuario de corredor puede hacer, siempre con lo suyo. */
const BROKER_PERMISSIONS: ReadonlySet<Permission> = new Set([
  "listings.manage",
  "marketplace.confirm",
  "brand.edit",
  "broker.view",
]);

type Actor = Pick<User, "role" | "brokerId">;

/**
 * Si el usuario puede hacer `permission` sobre un recurso de `brokerId`. El administrador puede
 * todo; el corredor, solo lo de `BROKER_PERMISSIONS` y solo con su corredor.
 */
export function can(user: Actor, permission: Permission, brokerId?: string | null): boolean {
  if (user.role === "admin") return true;
  return BROKER_PERMISSIONS.has(permission) && brokerId !== undefined && brokerId === user.brokerId;
}

/** `FORBIDDEN` (403) si no puede: el recurso es suyo, la acción no. */
export function assertCan(user: Actor, permission: Permission, brokerId?: string | null): void {
  if (!can(user, permission, brokerId)) {
    throw new AppError("FORBIDDEN", "Esto lo hace el administrador");
  }
}

/** El alcance de un usuario (ADR-0022). */
export function scopeOf(user: Actor): AccessScope {
  if (user.role === "admin") return ALL_SCOPE;
  // Imposible por el `CHECK` de la base; si pasara, nunca se abre a todo.
  if (user.brokerId === null) throw new AppError("USER_ROW_INVALID", "Un corredor sin corredor");
  return brokerScope(user.brokerId);
}
