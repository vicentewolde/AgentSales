import { useHealth } from "../health.js";

/** Banner permanente con el `PUBLISH_MODE` de la API en ejecución (fuente de verdad). */
export function PublishModeBanner() {
  const { data, isPending, isError } = useHealth();

  if (data?.publishMode === "live") {
    return (
      <div role="status" className="bg-red-600 px-4 py-2 text-center text-sm font-bold text-white">
        PUBLISH_MODE: LIVE — las publicaciones son reales
      </div>
    );
  }
  if (data?.publishMode === "dry-run") {
    return (
      <div
        role="status"
        className="bg-emerald-600 px-4 py-2 text-center text-sm font-medium text-white"
      >
        PUBLISH_MODE: dry-run — no se publica nada
      </div>
    );
  }
  return (
    <div
      role="status"
      className="bg-slate-500 px-4 py-2 text-center text-sm font-medium text-white"
    >
      {isPending && !isError
        ? "Consultando PUBLISH_MODE…"
        : "PUBLISH_MODE desconocido: la API no responde"}
    </div>
  );
}
