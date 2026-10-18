import { AppError } from "../../errors.js";
import type { SecretTokens, TotpProvider } from "../../ports/auth.js";
import type { SecretBox } from "../../ports/secret-box.js";
import type { SessionRepository, UserRepository } from "../../ports/user-repository.js";
import type { User } from "../../user.js";

// El doble factor con una app de códigos (spec F8 §4.8, ADR-0026): activar, confirmar,
// desactivar y revisar el código del segundo paso. Opcional por usuario, recomendado para el
// administrador. La clave nunca sale en logs ni errores; los códigos de recuperación se muestran una
// sola vez y se guardan como hash.

/** Cuántos códigos de recuperación se entregan al activar. */
export const RECOVERY_CODE_COUNT = 10;
/** El nombre que muestra la app del teléfono. */
export const TOTP_ISSUER = "AgentSales";

export type TotpDeps = {
  users: UserRepository;
  sessions: Pick<SessionRepository, "deleteForUserExcept">;
  totp: TotpProvider;
  /** `SecretBox` con la clave del propósito `totp` (no la de las credenciales). */
  totpBox: SecretBox;
  /** El hash de los códigos de recuperación (`SecretTokens.hash`, SHA-256: tienen 80 bits). */
  tokens: Pick<SecretTokens, "hash">;
  now?: () => Date;
};

/** La AAD del cifrado: la clave de un usuario no se abre como la de otro. */
const aadOf = (userId: string) => `totp:${userId}`;

/**
 * El enlace `otpauth://` (Key Uri Format de Google): se abre en la app del teléfono o se copia la
 * clave a mano. Sin código QR (pediría una dependencia, D15).
 */
export function otpauthUrl(email: string, secret: string): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${email}`);
  const params = `secret=${secret}&issuer=${encodeURIComponent(TOTP_ISSUER)}&algorithm=SHA1&digits=6&period=30`;
  return `otpauth://totp/${label}?${params}`;
}

/** Un código de recuperación como se guarda: sin guiones ni espacios, en mayúsculas. */
export const normalizeRecoveryCode = (code: string): string =>
  code.toUpperCase().replace(/[^A-Z2-7]/g, "");

const codeInvalid = () =>
  new AppError(
    "TOTP_CODE_INVALID",
    "El código no es correcto o ya se usó: prueba con el siguiente",
  );

/** Abre la clave guardada; si no se puede (cambió `APP_ENCRYPTION_KEY`), un error sin la clave. */
function openSecret(deps: Pick<TotpDeps, "totpBox">, userId: string, sealed: string): string {
  try {
    return deps.totpBox.decrypt(sealed, aadOf(userId));
  } catch {
    // Sin la causa: el error del cifrado no aporta y nada de la clave debe llegar al log.
    throw new AppError(
      "TOTP_UNREADABLE",
      "No se pudo leer la clave del doble factor: pide al administrador que restablezca tu acceso",
    );
  }
}

/** Empieza a activar: una clave nueva (reemplaza otra a medio activar) y su enlace. */
export async function startTotpSetup(
  deps: Pick<TotpDeps, "users" | "totp" | "totpBox">,
  input: { user: User },
): Promise<{ secret: string; otpauthUrl: string }> {
  if (input.user.totpEnabledAt !== null) {
    throw new AppError(
      "TOTP_ALREADY_ENABLED",
      "Ya tienes el doble factor activo: desactívalo antes de cambiar la app",
    );
  }
  const secret = deps.totp.generateSecret();
  await deps.users.startTotp(input.user.id, deps.totpBox.encrypt(secret, aadOf(input.user.id)));
  return { secret, otpauthUrl: otpauthUrl(input.user.email, secret) };
}

/**
 * Confirma con un código de la app: activa el doble factor, entrega los códigos de recuperación
 * (una sola vez) y cierra las demás sesiones del usuario (deja `keepSessionId`).
 */
export async function confirmTotpSetup(
  deps: TotpDeps,
  input: { user: User; code: string; keepSessionId: string },
): Promise<{ recoveryCodes: string[] }> {
  const now = deps.now?.() ?? new Date();
  const stored = await deps.users.findTotp(input.user.id);
  if (stored?.enabledAt != null) {
    throw new AppError("TOTP_ALREADY_ENABLED", "Ya tienes el doble factor activo");
  }
  if (stored?.secretEncrypted == null) {
    throw new AppError("TOTP_NOT_STARTED", "Primero pide la clave para la app (Activar)");
  }
  const secret = openSecret(deps, input.user.id, stored.secretEncrypted);
  const step = deps.totp.matchStep(secret, input.code.trim(), now);
  if (step === null) throw codeInvalid();
  const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    deps.totp.generateRecoveryCode(),
  );
  await deps.users.enableTotp(input.user.id, {
    at: now,
    step,
    recoveryCodeHashes: recoveryCodes.map((code) => deps.tokens.hash(normalizeRecoveryCode(code))),
  });
  await deps.sessions.deleteForUserExcept(input.user.id, input.keepSessionId);
  return { recoveryCodes };
}

/**
 * Revisa el código del segundo paso: 6 dígitos de la app (un paso no se usa dos veces) o un código
 * de recuperación (sirve una vez). `false` si no sirve; no anota fallos (eso es de quien llama).
 */
export async function verifySecondFactor(
  deps: Pick<TotpDeps, "users" | "totp" | "totpBox" | "tokens">,
  input: { userId: string; code: string; now: Date },
): Promise<boolean> {
  const code = input.code.trim();
  if (/^\d{6}$/.test(code)) {
    const stored = await deps.users.findTotp(input.userId);
    if (stored?.enabledAt == null || stored.secretEncrypted === null) return false;
    const secret = openSecret(deps, input.userId, stored.secretEncrypted);
    const step = deps.totp.matchStep(secret, code, input.now);
    if (step === null || (stored.lastStep !== null && step <= stored.lastStep)) return false;
    // Condicional: dos pedidos a la vez con el mismo código, solo uno gana.
    return deps.users.advanceTotpStep(input.userId, step);
  }
  const recovery = normalizeRecoveryCode(code);
  if (recovery.length !== 16) return false;
  return deps.users.consumeRecoveryCode(input.userId, deps.tokens.hash(recovery), input.now);
}

/**
 * Desactiva el doble factor, con un código (de la app o de recuperación), y cierra las demás
 * sesiones. `TOTP_NOT_ENABLED` si no estaba activo.
 */
export async function disableTotp(
  deps: TotpDeps,
  input: { user: User; code: string; keepSessionId: string },
): Promise<User> {
  if (input.user.totpEnabledAt === null) {
    throw new AppError("TOTP_NOT_ENABLED", "No tienes el doble factor activo");
  }
  const now = deps.now?.() ?? new Date();
  if (!(await verifySecondFactor(deps, { userId: input.user.id, code: input.code, now }))) {
    throw codeInvalid();
  }
  const user = await deps.users.clearTotp(input.user.id);
  await deps.sessions.deleteForUserExcept(input.user.id, input.keepSessionId);
  return user;
}

/** Si el doble factor está activo y cuántos códigos de recuperación quedan. */
export async function totpStatus(
  deps: Pick<TotpDeps, "users">,
  input: { user: User },
): Promise<{ enabled: boolean; recoveryCodesLeft: number }> {
  const enabled = input.user.totpEnabledAt !== null;
  return {
    enabled,
    recoveryCodesLeft: enabled ? await deps.users.countRecoveryCodes(input.user.id) : 0,
  };
}
