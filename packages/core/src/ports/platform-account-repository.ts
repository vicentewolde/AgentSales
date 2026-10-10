import type { Platform, PlatformAccountStatus } from "../enums.js";
import type { PlatformAccount, PlatformCredentials } from "../platform-account.js";

/**
 * Una cuenta recién conectada (OAuth, token del panel o la sesión del perfil), con sus credenciales
 * en claro. `credentials` es `null` solo en Marketplace, cuya sesión vive en el perfil del navegador
 * (ADR-0017, `checkConnectedCredentials`).
 */
export type ConnectedAccount = {
  brokerId: string;
  platform: Platform;
  externalAccountId: string;
  displayName: string;
  tokenExpiresAt: Date | null;
  meta: Record<string, unknown>;
  credentials: PlatformCredentials | null;
};

/**
 * Un token nuevo tras refrescarlo. `meta` se mezcla con la guardada **a un nivel**: cada clave que
 * llega reemplaza a la anterior (una lista, como `permissions`, se reemplaza entera).
 */
export type TokenUpdate = {
  credentials: PlatformCredentials;
  tokenExpiresAt: Date | null;
  meta?: Record<string, unknown>;
};

/**
 * Lo que entrega `withCredentialsLock` dentro del candado (spec F4 §4.3, ADR-0015): la cuenta y sus
 * credenciales **releídas** con la fila bloqueada, `save`, que guarda el par nuevo en la misma
 * transacción (como `updateToken`), y `markProblem`, que la pasa de `connected` a `expired` o
 * `error` también ahí: quien espera el candado ya la ve así y no llama a la plataforma, y una
 * reconexión que esperaba la fila no queda vencida por error. Todo se confirma recién cuando `fn`
 * termina bien: por eso `fn` devuelve el problema y quien llama lanza el error **después**.
 */
export type LockedCredentials = {
  account: PlatformAccount;
  credentials: PlatformCredentials;
  save(update: TokenUpdate): Promise<PlatformAccount>;
  markProblem(to: PlatformAccountProblemStatus): Promise<void>;
};

/** Cuánto espera el candado de credenciales a que otro lo suelte (`lock_timeout`). */
export const CREDENTIALS_LOCK_TIMEOUT_MS = 10_000;

/** Estados a los que una cuenta pasa por un problema; `connected` solo se logra conectando. */
export type PlatformAccountProblemStatus = Extract<PlatformAccountStatus, "expired" | "error">;

/**
 * Cuentas conectadas (`platform_accounts`, spec F3 §4.6), únicas por corredor, plataforma y cuenta
 * externa. El adaptador cifra las credenciales al guardar y las descifra solo en `getCredentials`:
 * ninguna otra lectura las devuelve. `meta` se guarda como JSON (`normalizeAccountMeta`).
 * Errores (`AppError`, ninguno reintentable salvo `DB_UNAVAILABLE`):
 * - un corredor que no existe → `BROKER_NOT_FOUND`;
 * - una cuenta que no existe → `ACCOUNT_NOT_FOUND`;
 * - credenciales vacías o con otra forma al guardar → `CREDENTIALS_INVALID`; `meta` que no es un
 *   objeto → `ACCOUNT_META_INVALID`;
 * - al conectar, sin credenciales fuera de Marketplace → `ACCOUNT_CREDENTIALS_REQUIRED`, y con
 *   credenciales en Marketplace → `ACCOUNT_CREDENTIALS_NOT_ALLOWED` (ADR-0017);
 * - `getCredentials` de una cuenta sin credenciales (desconectada, o de Marketplace) →
 *   `ACCOUNT_NOT_CONNECTED`;
 * - credenciales que no se pueden descifrar (otra clave, alteradas) → `CREDENTIALS_UNREADABLE`;
 * - el candado de credenciales ocupado más de 10 s → `ACCOUNT_LOCK_TIMEOUT`, reintentable;
 * - una fila que no calza con la entidad → `PLATFORM_ACCOUNT_ROW_INVALID`;
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 */
export interface PlatformAccountRepository {
  /**
   * Crea la cuenta o, si ya existe (mismo corredor, plataforma y cuenta externa), la actualiza:
   * nombre, vencimiento, `meta` (se reemplaza) y credenciales, y conserva `createdAt`. Siempre
   * queda en `connected`, también si estaba desconectada o vencida. Con `revokeOthers`, en la misma
   * transacción desconecta (`revoked`, sin credenciales) las demás cuentas del corredor en esa
   * plataforma: una sola conectada por corredor y plataforma (spec F3 §4.6).
   */
  upsertConnected(
    account: ConnectedAccount,
    options?: { revokeOthers?: boolean },
  ): Promise<PlatformAccount>;
  get(id: string): Promise<PlatformAccount | null>;
  /** Todas, por fecha de creación (las primeras primero). */
  list(): Promise<PlatformAccount[]>;
  /** Las de un corredor, opcionalmente de una plataforma, por fecha de creación. */
  listByBroker(brokerId: string, platform?: Platform): Promise<PlatformAccount[]>;
  /**
   * Las credenciales descifradas: solo para publicar o refrescar, y nunca se loguean. Una cuenta
   * `expired` o `error` todavía las devuelve: quien publica revisa el estado aparte.
   */
  getCredentials(id: string): Promise<PlatformCredentials>;
  /**
   * Guarda el token refrescado y su vencimiento, y mezcla `meta`, **solo si la cuenta sigue
   * `connected`**: un refresco que se cruza con una desconexión o un vencimiento no la revive
   * (`ACCOUNT_NOT_CONNECTED`). No cambia el estado.
   */
  updateToken(id: string, update: TokenUpdate): Promise<PlatformAccount>;
  /**
   * Cambio condicional de estado, como `ListingRepository.changeStatus`: solo si la cuenta está en
   * `from`. Devuelve `false` si ya cambió (por ejemplo, se reconectó mientras tanto). No toca las
   * credenciales.
   */
  changeStatus(
    id: string,
    from: PlatformAccountStatus,
    to: PlatformAccountProblemStatus,
  ): Promise<boolean>;
  /** Pasa a `revoked` y borra las credenciales. La fila queda: la referencian sus publicaciones. */
  disconnect(id: string): Promise<PlatformAccount>;
  /**
   * Candado de credenciales (spec F4 §4.3, ADR-0015): una transacción que bloquea la fila de la
   * cuenta con `FOR NO KEY UPDATE` (no choca con la FK de `publications`: aprobar y publicar no
   * esperan) y espera como mucho 10 s a que otro la suelte (`ACCOUNT_LOCK_TIMEOUT`). Relee la cuenta,
   * exige que siga `connected` y con credenciales (`ACCOUNT_NOT_CONNECTED`), las descifra y llama a
   * `fn`. Si `fn` falla, no queda nada guardado. Es la **única** excepción a "nada externo dentro de
   * un candado": `fn` hace **una** llamada de refresco (tope de 10 s) y guarda el par nuevo con
   * `save` antes de terminar. **Nunca** se anida con el `ListingLock` (ni uno dentro del otro).
   * Dos candados de la misma cuenta se esperan; los de cuentas distintas no.
   */
  withCredentialsLock<T>(id: string, fn: (locked: LockedCredentials) => Promise<T>): Promise<T>;
}
