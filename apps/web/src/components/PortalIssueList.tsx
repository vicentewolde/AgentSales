import type { PortalReadinessIssueView } from "@agentsales/api/contracts";

/**
 * Qué hacer con lo que le falta al aviso para Portal: la planilla y, solo si falta o no sirve el
 * WhatsApp, la hoja Corredor.
 */
export function portalIssuesHint(issues: readonly PortalReadinessIssueView[]): string {
  const whatsapp = issues.some((issue) => issue.code.startsWith("PORTAL_WHATSAPP"));
  return `Complétalo en la planilla y vuelve a importarla${whatsapp ? "; el WhatsApp es el de la hoja Corredor" : ""}.`;
}

/**
 * Lo que le falta al aviso para Portal (`portalReadiness` o los `issues` de `PORTAL_NOT_READY`, spec
 * F4 §4.11): un motivo por línea con su columna del Excel. Lo usan la pestaña Portal y `ErrorAlert`.
 */
export function PortalIssueList({
  issues,
  className,
}: {
  issues: readonly PortalReadinessIssueView[];
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
