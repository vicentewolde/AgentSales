import { OAUTH_PROVIDERS, type OAuthProvider } from "@agentsales/api/contracts";
import { useSearchParams } from "react-router";
import { oauthErrorText, PROVIDER_NAME } from "./accounts.js";

/**
 * El mensaje con que vuelve el OAuth (spec F3 §4.6 y F8-T19): `?conectada=<proveedor>` o
 * `?error=<código>` (con `&proveedor=mercadolibre` desde Mercado Libre; sin él, Instagram), con
 * Cerrar (que limpia la URL). Un `proveedor` desconocido es Instagram; otro valor de `conectada` no dice nada.
 */
export function OAuthReturn() {
  const [params, setParams] = useSearchParams();
  const asked = params.get("proveedor");
  const provider: OAuthProvider = OAUTH_PROVIDERS.find((known) => known === asked) ?? "instagram";
  const connected = params.get("conectada") === provider;
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
        {ok ? `Cuenta de ${PROVIDER_NAME[provider]} conectada.` : oauthErrorText(error, provider)}
      </p>
      <button type="button" onClick={close} className="text-sm underline">
        Cerrar
      </button>
    </div>
  );
}
