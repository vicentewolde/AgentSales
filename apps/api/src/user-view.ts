import type { User } from "@agentsales/core";
import type { UserView } from "./contracts/index.js";

/** Un usuario para el panel o la CLI: sin hashes ni tokens. */
export function toUserView(user: User, now: Date = new Date()): UserView {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    brokerId: user.brokerId,
    hasPassword: user.hasPassword,
    disabled: user.disabledAt !== null,
    locked: user.lockedUntil !== null && user.lockedUntil > now,
    lastLoginAt: user.lastLoginAt,
  };
}
