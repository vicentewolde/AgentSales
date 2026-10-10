import type { ReadinessIssueView } from "@agentsales/api/contracts";

/**
 * Qué hacer con lo que le falta al aviso para Portal: la planilla y, solo si falta o no sirve el
 * WhatsApp, la hoja Corredor.
 */
export function portalIssuesHint(issues: readonly ReadinessIssueView[]): string {
  const whatsapp = issues.some((issue) => issue.code.startsWith("PORTAL_WHATSAPP"));
  return `Complétalo en la planilla y vuelve a importarla${whatsapp ? "; el WhatsApp es el de la hoja Corredor" : ""}.`;
}

/**
 * Qué hacer con lo que le falta al aviso para Marketplace (spec F5 §4.6): la planilla, las fotos
 * (Preparar contenido) y, si el precio está en UF sin token, `BCCH_API_TOKEN`.
 */
export function marketplaceIssuesHint(issues: readonly ReadinessIssueView[]): string {
  const parts = [];
  if (issues.some((issue) => issue.field !== null))
    parts.push("complétalo en la planilla y vuelve a importarla");
  if (issues.some((issue) => issue.code === "MARKETPLACE_PHOTOS_MISSING")) {
    parts.push("prepara el contenido para tener las fotos");
  }
  if (issues.some((issue) => issue.code === "UF_SOURCE_NOT_CONFIGURED")) {
    parts.push("anota BCCH_API_TOKEN en el .env y reinicia pnpm dev");
  }
  const text = parts.join("; ");
  return text === "" ? "" : `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/**
 * Lo que le falta al aviso para un canal (`portalReadiness`, `marketplaceReadiness` o los `issues`
 * de `PORTAL_NOT_READY` y `MARKETPLACE_NOT_READY`, spec F4 §4.11 y F5 §4.10): un motivo por línea
 * con su columna del Excel. Lo usan las pestañas Portal y Marketplace y `ErrorAlert`.
 */
export function PortalIssueList({
  issues,
  className,
}: {
  issues: readonly ReadinessIssueView[];
  className: string;
}) {
  return (
    <ul className={`mt-1 list-disc pl-5 text-sm ${className}`}>
      {issues.map((issue) => (
        <li key={`${issue.code}-${issue.field ?? ""}-${issue.message}`}>
          {issue.message}
          {issue.field !== null && <span className="opacity-80"> ({issue.field})</span>}
        </li>
      ))}
    </ul>
  );
}
