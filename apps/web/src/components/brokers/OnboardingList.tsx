import type { OnboardingStepView } from "@agentsales/api/contracts";
import { type BrokerKind, onboardingOwnerText, onboardingStepText } from "@agentsales/core";

/**
 * La lista de alta de un corredor (spec F7 §4.6) o de una marca (F9): cada paso, si está y, si
 * falta, quién lo hace.
 */
export function OnboardingList({
  steps,
  kind,
}: {
  steps: readonly OnboardingStepView[];
  kind: BrokerKind;
}) {
  const done = steps.filter((step) => step.done).length;
  return (
    <section aria-label="Lista de alta" className="mt-4">
      <h2 className="text-lg font-semibold">
        Lista de alta{" "}
        <span className="text-sm font-normal text-slate-500">
          ({done} de {steps.length})
        </span>
      </h2>
      <ul className="mt-2 space-y-1 text-sm">
        {steps.map((step) => (
          <li key={step.key}>
            {step.done ? (
              <span className="text-green-800">✓ {onboardingStepText(step.key)}</span>
            ) : (
              <span className="text-amber-900">
                · {onboardingStepText(step.key)}
                {step.pending && `: falta ${step.pending}`}
                {step.owner && ` (${onboardingOwnerText(step.owner, kind)})`}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
