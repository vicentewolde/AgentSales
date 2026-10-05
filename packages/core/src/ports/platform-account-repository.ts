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

/** Un token nuevo tras refrescarlo; `meta` se mezcla con la guardada (no la reemplaza). */
export type TokenUpdate = {
  credentials: PlatformCredentials;
  tokenExpiresAt: Date | null;
  meta?: Record<string, unknown>;
};

/**
 * Cuentas conectadas (`platform_accounts`, spec F3 §4.6), únicas por corredor, plataforma y cuenta
 * externa. El adaptador cifra las credenciales al guardar y las descifra solo en `getCredentials`:
 * ninguna otra lectura las devuelve. Errores (`AppError`):
 * - un corredor que no existe → `BROKER_NOT_FOUND`;
 * - una cuenta que no existe → `ACCOUNT_NOT_FOUND`;
 * - `getCredentials` de una cuenta sin credenciales (desconectada) → `ACCOUNT_NOT_CONNECTED`;
 * - credenciales que no se pueden descifrar (otra clave, alteradas) → `CREDENTIALS_UNREADABLE`;
 * - una fila que no calza con la entidad → `PLATFORM_ACCOUNT_ROW_INVALID`;
 * - fallo de conexión → `DB_UNAVAILABLE`, reintentable.
 */
export interface PlatformAccountRepository {
  /**
   * Crea la cuenta o, si ya existe (mismo corredor, plataforma y cuenta externa), la actualiza:
   * nombre, vencimiento, `meta` (se reemplaza) y credenciales. Siempre queda en `connected`.
   */
  upsertConnected(account: ConnectedAccount): Promise<PlatformAccount>;
  get(id: string): Promise<PlatformAccount | null>;
  /** Todas, por fecha de creación (las primeras primero). */
  list(): Promise<PlatformAccount[]>;
  /** Las de un corredor, opcionalmente de una plataforma, por fecha de creación. */
  listByBroker(brokerId: string, platform?: Platform): Promise<PlatformAccount[]>;
  /** Las credenciales descifradas: solo para publicar o refrescar, y nunca se loguean. */
  getCredentials(id: string): Promise<PlatformCredentials>;
  /** Guarda el token refrescado y su vencimiento, y mezcla `meta`. No cambia el estado. */
  updateToken(id: string, update: TokenUpdate): Promise<PlatformAccount>;
  /** Cambia el estado (por ejemplo, `expired` ante un token vencido). No toca las credenciales. */
  markStatus(id: string, status: PlatformAccountStatus): Promise<PlatformAccount>;
  /** Pasa a `revoked` y borra las credenciales. La fila queda: la referencian sus publicaciones. */
  disconnect(id: string): Promise<PlatformAccount>;
}
