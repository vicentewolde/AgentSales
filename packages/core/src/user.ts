import { z } from "zod";

// Usuarios, sesiones e invitaciones (spec F7 §4.2, ADR-0021). La contraseña y los tokens nunca
// viajan en estas entidades: el repositorio guarda solo sus hashes.

/** `admin`: el operador (ve y opera todos los corredores). `broker`: un usuario de un corredor. */
export const USER_ROLES = ["admin", "broker"] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Desde dónde se abrió una sesión: la cookie del panel o el `Bearer` de la CLI. */
export const SESSION_CLIENTS = ["panel", "cli"] as const;
export type SessionClient = (typeof SESSION_CLIENTS)[number];

/** Para qué sirve un enlace: elegir la primera contraseña o restablecerla. */
export const INVITATION_PURPOSES = ["invite", "reset"] as const;
export type InvitationPurpose = (typeof INVITATION_PURPOSES)[number];

/** Usuario (`users`), sin el hash de su contraseña. */
export const userSchema = z.object({
  id: z.string(),
  /** Siempre en minúsculas (`normalizeEmail`). */
  email: z.string(),
  name: z.string(),
  role: z.enum(USER_ROLES),
  /** `null` si y solo si `role` es `admin`. */
  brokerId: z.string().nullable(),
  /** Si ya eligió su contraseña (aceptó la invitación). */
  hasPassword: z.boolean(),
  failedLogins: z.number().int(),
  lockedUntil: z.date().nullable(),
  disabledAt: z.date().nullable(),
  lastLoginAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type User = z.infer<typeof userSchema>;

/** Sesión (`sessions`), sin su token. */
export const sessionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  client: z.enum(SESSION_CLIENTS),
  expiresAt: z.date(),
  lastSeenAt: z.date(),
  createdAt: z.date(),
});
export type Session = z.infer<typeof sessionSchema>;

/** Enlace de invitación o de restablecer (`invitations`), sin su token. */
export const invitationSchema = z.object({
  id: z.string(),
  userId: z.string(),
  purpose: z.enum(INVITATION_PURPOSES),
  expiresAt: z.date(),
  usedAt: z.date().nullable(),
  /** El administrador que lo generó; `null` si lo generó `pnpm auth:admin`. */
  createdBy: z.string().nullable(),
  createdAt: z.date(),
});
export type Invitation = z.infer<typeof invitationSchema>;

/** Largo de una contraseña (spec F7 §4.2). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** El correo como se guarda y se compara: sin espacios alrededor y en minúsculas. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return EMAIL.test(email) && email.length <= 254;
}
