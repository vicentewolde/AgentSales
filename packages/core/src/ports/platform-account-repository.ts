import type { Platform, PlatformAccountStatus } from "../enums.js";
import type { PlatformAccount, PlatformCredentials } from "../platform-account.js";

/** Una cuenta recién conectada (OAuth o token del panel), con sus credenciales en claro. */
export type ConnectedAccount = {
  brokerId: string;
  platform: Platform;
  externalAccountId: string;
  displayName: string;
  tokenExpiresAt: Date | null;
  meta: Record<string, unknown>;
  credentials: PlatformCredentials;
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
 * - `getCredentials` de una cuenta sin credenciales (desconectada) → `ACCOUNT_NOT_CONNECTED`;
 * - credenciales que no se pueden descifrar (otra clave, alteradas) → `CREDENTIALS_UNREADABLE`;
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
}
