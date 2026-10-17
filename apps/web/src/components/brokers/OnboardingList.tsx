import type { OnboardingStepView } from "@agentsales/api/contracts";

const STEP_TEXT: Record<OnboardingStepView["key"], string> = {
  brand: "Marca y colores",
  logo: "Logo",
  whatsapp: "WhatsApp",
  user: "Usuario con contraseña",
  instagram: "Instagram",
  mercadolibre: "Mercado Libre",
  marketplace: "Marketplace",
};

const OWNER_TEXT = { broker: "lo hace el corredor", admin: "lo hace el administrador" } as const;

/** La lista de alta de un corredor (spec F7 §4.6): cada paso, si está y, si falta, quién lo hace. */
export function OnboardingList({ steps }: { steps: readonly OnboardingStepView[] }) {
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
              <span className="text-green-800">✓ {STEP_TEXT[step.key]}</span>
            ) : (
              <span className="text-amber-900">
                · {STEP_TEXT[step.key]}
                {step.pending && `: falta ${step.pending}`}
                {step.owner && ` (${OWNER_TEXT[step.owner]})`}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
