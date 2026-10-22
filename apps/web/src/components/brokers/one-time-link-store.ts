import { type UserLinkResponse, userLinkResponseSchema } from "@agentsales/api/contracts";
import { z } from "zod";

/** Si el enlace crea el usuario (invitar) o elige una contraseña nueva (restablecer). */
export type OneTimeLinkKind = "invitation" | "reset";

export type SavedOneTimeLink = { link: UserLinkResponse; kind: OneTimeLinkKind };

// El enlace de invitación o de restablecer es un secreto (ADR-0021). Para que no desaparezca al
// recargar la página (F9.5-T20) se guarda **solo en `sessionStorage`** de esta pestaña: nunca en
// `localStorage`, en la URL, en la caché de consultas ni en un log. Se borra al ocultarlo («Listo,
// ocultarlo»), al vencer, a las 2 horas de guardado aunque la invitación dure más
// (`ONE_TIME_LINK_KEEP_MS`), al cerrar sesión, cuando la sesión vence o entra otro usuario, cuando
// el invitado ya eligió su contraseña y al cerrar la pestaña. Todo va en `try/catch`: en una
// ventana privada o con los datos del sitio bloqueados el almacenamiento puede fallar, y entonces
// el enlace vive solo mientras la página no se recargue, como antes.

const PREFIX = "agentsales.enlace-unico.";

/** Lo más que un enlace queda guardado en la pestaña, aunque venza después (F9.5-T20). */
export const ONE_TIME_LINK_KEEP_MS = 2 * 60 * 60 * 1000;

const savedSchema = z.object({
  link: userLinkResponseSchema,
  kind: z.enum(["invitation", "reset"]),
  keepUntil: z.coerce.date(),
});

const keyOf = (brokerId: string): string => `${PREFIX}${brokerId}`;

/**
 * Guarda el enlace de un corredor (el último que se generó reemplaza al anterior), hasta que venza
 * o, como mucho, `ONE_TIME_LINK_KEEP_MS` desde ahora.
 */
export function saveOneTimeLink(
  brokerId: string,
  saved: SavedOneTimeLink,
  now: Date = new Date(),
): void {
  const keepUntil = new Date(
    Math.min(saved.link.expiresAt.getTime(), now.getTime() + ONE_TIME_LINK_KEEP_MS),
  );
  try {
    window.sessionStorage.setItem(keyOf(brokerId), JSON.stringify({ ...saved, keepUntil }));
  } catch {
    // Sin almacenamiento: el enlace sigue en el estado de la página.
  }
}

/** Borra el enlace guardado de un corredor. */
export function clearOneTimeLink(brokerId: string): void {
  try {
    window.sessionStorage.removeItem(keyOf(brokerId));
  } catch {
    // Nada que borrar si no hay almacenamiento.
  }
}

/** Borra todos los enlaces guardados (al cerrar sesión). */
export function clearAllOneTimeLinks(): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) window.sessionStorage.removeItem(key);
  } catch {
    // Nada que borrar si no hay almacenamiento.
  }
}

/**
 * El enlace guardado de un corredor, si sigue vigente y dentro de su tiempo guardado: uno vencido,
 * guardado hace más de 2 horas, ilegible o con otra forma se borra y no se devuelve.
 */
export function loadOneTimeLink(brokerId: string, now: Date = new Date()): SavedOneTimeLink | null {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(keyOf(brokerId));
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = savedSchema.safeParse(JSON.parse(raw));
    if (
      parsed.success &&
      parsed.data.link.expiresAt.getTime() > now.getTime() &&
      parsed.data.keepUntil.getTime() > now.getTime()
    ) {
      return { link: parsed.data.link, kind: parsed.data.kind };
    }
  } catch {
    // JSON ilegible: se trata como uno inservible.
  }
  clearOneTimeLink(brokerId);
  return null;
}
