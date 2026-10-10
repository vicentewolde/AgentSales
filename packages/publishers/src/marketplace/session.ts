import type { AbortSignalLike } from "@agentsales/core";
import { AppError } from "@agentsales/core";
import { classifyPage } from "./guard.js";
import type { MarketplaceProfile } from "./profile.js";

/**
 * Hay sesión (spec F5 §4.2): la cookie con el id de la cuenta **y** una página de Facebook que no
 * pide iniciar sesión ni una verificación. Las dos, porque cuándo aparece `c_user` (¿antes de
 * terminar la verificación de dos pasos?) es NO VERIFICADO.
 */
export async function hasSession(profile: MarketplaceProfile): Promise<boolean> {
  if ((await profile.sessionUserId()) === null) return false;
  const kind = await classifyPage(profile.page);
  return kind !== "login" && kind !== "verification";
}

export type WaitForSessionOptions = {
  timeoutMs: number;
  /** Cada cuánto mira (por defecto, 2 s). */
  pollMs?: number;
  signal?: AbortSignalLike;
  /** Se llama una vez si la página pide una verificación: la resuelve el operador a mano. */
  onVerification?: () => void;
};

/**
 * Espera a que el operador inicie sesión **a mano** en la ventana (también su 2FA o una
 * verificación): el sistema no escribe nada ni hace clic, solo mira (spec F5 §4.2). Devuelve el id
 * de la cuenta. Errores (no reintentables): la ventana se cerró (`MARKETPLACE_WINDOW_CLOSED`), se
 * cortó (`MARKETPLACE_LOGIN_ABORTED`) o pasó el tope (`MARKETPLACE_LOGIN_TIMEOUT`).
 */
export async function waitForSession(
  profile: MarketplaceProfile,
  options: WaitForSessionOptions,
): Promise<string> {
  const deadline = Date.now() + options.timeoutMs;
  let warned = false;
  for (;;) {
    if (options.signal?.aborted) {
      throw new AppError("MARKETPLACE_LOGIN_ABORTED", "Se cortó la espera del inicio de sesión");
    }
    if (!profile.isOpen() || profile.page.isClosed()) {
      throw new AppError(
        "MARKETPLACE_WINDOW_CLOSED",
        "Se cerró la ventana antes de iniciar sesión en Facebook",
      );
    }
    if (await hasSession(profile).catch(() => false)) {
      const userId = await profile.sessionUserId();
      if (userId !== null) return userId;
    }
    if (
      !warned &&
      options.onVerification !== undefined &&
      (await classifyPage(profile.page).catch(() => null)) === "verification"
    ) {
      warned = true;
      options.onVerification();
    }
    if (Date.now() >= deadline) {
      const minutes = Math.max(1, Math.round(options.timeoutMs / 60_000));
      throw new AppError(
        "MARKETPLACE_LOGIN_TIMEOUT",
        `Pasaron ${minutes} ${minutes === 1 ? "minuto" : "minutos"} sin sesión en Facebook`,
      );
    }
    // Una pausa del reloj de Node, no de la página: si la ventana se cierra, no gira en vacío.
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 2_000));
  }
}
