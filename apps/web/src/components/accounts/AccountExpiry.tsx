import type { PlatformAccountView } from "@agentsales/api/contracts";
import { accountDateText, expiryState } from "./accounts.js";

/** Vencimiento con su aviso: vencido en rojo; con 10 días o menos, en ámbar. */
export function AccountExpiry({ account, now }: { account: PlatformAccountView; now: Date }) {
  if (account.tokenExpiresAt === null) return <span>Sin fecha</span>;
  const text = `${accountDateText(account.tokenExpiresAt)}${account.tokenExpiryEstimated ? " (estimado)" : ""}`;
  const state = expiryState(account, now);
  if (state.kind === "expired") {
    return <span className="font-semibold text-red-700">{text} · venció: reconéctala</span>;
  }
  if (state.kind === "soon") {
    return (
      <span className="font-semibold text-amber-700">
        {text} · vence en {state.days} {state.days === 1 ? "día" : "días"}
      </span>
    );
  }
  return <span>{text}</span>;
}
