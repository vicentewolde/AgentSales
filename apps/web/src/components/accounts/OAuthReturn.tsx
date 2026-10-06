import { useSearchParams } from "react-router";
import { oauthErrorText } from "./accounts.js";

/**
 * El mensaje con que vuelve el OAuth (spec F3 §4.6): `?conectada=instagram` o `?error=<código>`, con
 * Cerrar (que limpia la URL). Otro valor de `conectada` no dice nada.
 */
export function OAuthReturn() {
  const [params, setParams] = useSearchParams();
  const connected = params.get("conectada") === "instagram";
  const error = params.get("error");
  if (!connected && error === null) return null;
  const close = () => setParams({}, { replace: true });
  const ok = error === null;
  return (
    <div
      role={ok ? "status" : "alert"}
      className={`mt-4 flex items-start justify-between gap-4 rounded-lg border p-4 ${
        ok ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"
      }`}
    >
      <p className={ok ? "text-emerald-800" : "text-red-800"}>
        {ok ? "Cuenta de Instagram conectada." : oauthErrorText(error)}
      </p>
      <button type="button" onClick={close} className="text-sm underline">
        Cerrar
      </button>
    </div>
  );
}
