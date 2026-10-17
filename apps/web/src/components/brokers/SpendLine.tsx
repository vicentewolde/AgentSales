import type { UsageResponse } from "@agentsales/api/contracts";
import { llmSpendText } from "@agentsales/core";

/** El gasto de IA del mes de un corredor (estimado) y su tope (spec F7 §4.7). */
export function SpendLine({ usage, brokerId }: { usage?: UsageResponse; brokerId: string }) {
  const row = usage?.brokers.find((item) => item.brokerId === brokerId);
  if (usage === undefined || row === undefined) return null;
  return (
    <p className="mt-2 text-sm text-slate-700">
      Gasto de IA de {usage.month}: <strong>{llmSpendText(row)}</strong>
      {row.capReached && (
        <span className="ml-1 font-medium text-red-700">
          · tope alcanzado: preparar los textos está frenado
        </span>
      )}
      <span className="block text-xs text-slate-500">
        Es una estimación: la cifra oficial está en la consola de Anthropic.
      </span>
    </p>
  );
}
