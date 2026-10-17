import { BrandForm } from "../components/brokers/BrandForm.js";
import { LogoAndTemplate } from "../components/brokers/LogoAndTemplate.js";
import { OnboardingList } from "../components/brokers/OnboardingList.js";
import { SpendLine } from "../components/brokers/SpendLine.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { useMe } from "../queries/auth.js";
import { useBrokerDetail, useUpdateBroker } from "../queries/brokers.js";
import { useUsage } from "../queries/usage.js";

/**
 * Mi marca (spec F7 §4.11, el corredor): editar la marca, subir el logo, bajar la planilla, su
 * gasto de IA del mes y su lista de alta. El tope, "propio" y la publicación automática son del
 * administrador: aquí no aparecen.
 */
export function MyBrandPage() {
  const me = useMe();
  const brokerId = me.data?.broker?.id;
  const detail = useBrokerDetail(brokerId);
  const update = useUpdateBroker(brokerId ?? "");
  const usage = useUsage();
  if (me.data !== undefined && brokerId === undefined) {
    return <p className="text-slate-600">Tu usuario no tiene corredor: es del administrador.</p>;
  }
  if (detail.error)
    return <ErrorAlert error={detail.error} onRetry={() => void detail.refetch()} />;
  if (detail.data === undefined) return <p className="text-slate-600">Cargando…</p>;
  const { broker, onboarding } = detail.data;
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Mi marca</h1>
      <SpendLine usage={usage.data} brokerId={broker.id} />
      <OnboardingList steps={onboarding} />
      <section aria-label="Marca" className="mt-6">
        <h2 className="text-lg font-semibold">Marca</h2>
        <BrandForm
          key={`${broker.id}-${broker.brandName}`}
          broker={broker}
          submitLabel="Guardar"
          pending={update.isPending}
          error={update.error}
          onSubmit={(values) => update.mutate(values)}
        />
        <p role="status" className="mt-2 text-sm text-green-800">
          {update.isSuccess && "Guardado."}
        </p>
      </section>
      <LogoAndTemplate broker={broker} />
    </div>
  );
}
