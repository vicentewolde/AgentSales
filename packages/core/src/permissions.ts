import { type AccessScope, ALL_SCOPE, brokerScope } from "./access.js";
import { AppError } from "./errors.js";
import type { User } from "./user.js";

// Lo que puede hacer cada rol (spec F7 §4.5, D2): el corredor hace casi todo con lo suyo; el
// administrador, todo.

export const PERMISSIONS = [
  /** Ver, cargar, preparar, editar textos, aprobar, publicar, programar y cambiar propiedades. */
  "listings.manage",
  /**
   * Los posts de su marca (F9, ADR-0029): crear, editar, subir medios, pedir textos, aprobar,
   * programar, publicar y archivar. El dueño de un post es su corredor o marca.
   */
  "posts.manage",
  /** "Lo publiqué" o "No lo publiqué" en Marketplace. */
  "marketplace.confirm",
  /** Editar la marca, subir el logo y bajar la planilla. */
  "brand.edit",
  /** Ver las cuentas, el gasto de IA y la lista de alta del corredor. */
  "broker.view",
  /** Conectar, renovar y desconectar cuentas; activar Marketplace a mano. */
  "accounts.manage",
  /**
   * Conectar **su propia** cuenta de Instagram con el inicio de sesión de Instagram (el botón de
   * Cuentas, ADR-0028). No renueva ni desconecta: eso sigue siendo de `accounts.manage`.
   */
  "instagram.connect",
  /**
   * F9-T16 (spec F9 §4.7): conectar **su propia** cuenta de X con OAuth y PKCE. Renovar, desconectar
   * y fijar el tope de gasto siguen siendo de `accounts.manage`.
   */
  "x.connect",
  /**
   * Conectar **su propio** perfil de LinkedIn con el OAuth (el botón de Cuentas, como
   * `instagram.connect`; spec F9 §4.7, F9-T15). Renovar, desconectar y cambiar el modo siguen
   * siendo de `accounts.manage`.
   */
  "linkedin.connect",
  /**
   * Conectar **su propia** cuenta de TikTok con Login Kit (spec F9 §4.7, F9-T26), como
   * `instagram.connect`: renovar y desconectar siguen siendo de `accounts.manage`.
   */
  "tiktok.connect",
  /** Publicación automática, tope de IA y "corredor propio". */
  "broker.settings",
  "brokers.create",
  /** Crear, restablecer, desactivar y reactivar usuarios. */
  "users.manage",
  /** `/health` con detalle. */
  "system.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Lo que un usuario de corredor puede hacer, siempre con lo suyo. */
const BROKER_PERMISSIONS: ReadonlySet<Permission> = new Set([
  "listings.manage",
  "posts.manage",
  "marketplace.confirm",
  "brand.edit",
  "broker.view",
  "instagram.connect",
  // F9-T16: su propia cuenta de X.
  "x.connect",
  "linkedin.connect",
  // F9-T26: el corredor o la marca conecta su TikTok.
  "tiktok.connect",
]);

type Actor = Pick<User, "role" | "brokerId">;

/**
 * Si el usuario puede hacer `permission` sobre un recurso de `brokerId`. El administrador puede
 * todo; el corredor, solo lo de `BROKER_PERMISSIONS` y solo con su corredor. Sin `brokerId`, un
 * corredor no puede nada: las rutas de listas pasan el corredor del alcance, nunca lo omiten.
 */
export function can(user: Actor, permission: Permission, brokerId?: string | null): boolean {
  if (user.role === "admin") return true;
  return (
    BROKER_PERMISSIONS.has(permission) &&
    user.brokerId !== null &&
    brokerId !== undefined &&
    brokerId === user.brokerId
  );
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
