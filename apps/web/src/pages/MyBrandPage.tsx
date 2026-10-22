import { BrandForm } from "../components/brokers/BrandForm.js";
import { LogoAndTemplate } from "../components/brokers/LogoAndTemplate.js";
import { OnboardingList } from "../components/brokers/OnboardingList.js";
import { SpendLine } from "../components/brokers/SpendLine.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { EditorialProfileSection } from "../components/posts/EditorialProfileForm.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { useMe } from "../queries/auth.js";
import { useBrokerDetail, useUpdateBroker } from "../queries/brokers.js";
import { useUsage } from "../queries/usage.js";

/**
 * Mi marca (spec F7 §4.11, el corredor): editar la marca, subir el logo, bajar la planilla, su
 * gasto de IA del mes, su lista de alta y, desde F9-T17, el perfil editorial de sus posts. El tope, "propio" y la publicación automática son del
 * administrador: aquí no aparecen.
 */
export function MyBrandPage() {
  const me = useMe();
  const brokerId = me.data?.broker?.id;
  const detail = useBrokerDetail(brokerId);
  const update = useUpdateBroker(brokerId ?? "");
  const usage = useUsage();
  if (me.data !== undefined && brokerId === undefined) {
    return <p className="text-fg-muted">Tu usuario no tiene corredor: es del administrador.</p>;
  }
  if (detail.error)
    return <ErrorAlert error={detail.error} onRetry={() => void detail.refetch()} />;
  if (detail.data === undefined) return <p className="text-fg-muted">Cargando…</p>;
  const { broker, onboarding } = detail.data;
  return (
    <div>
      <PageHeader title="Mi marca" />
      <SpendLine usage={usage.data} brokerId={broker.id} />
      <OnboardingList steps={onboarding} kind={broker.kind} />
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
        <p role="status" className="mt-2 text-sm text-success-800">
          {update.isSuccess && "Guardado."}
        </p>
      </section>
      <LogoAndTemplate broker={broker} />
      <EditorialProfileSection brokerId={broker.id} />
    </div>
  );
}
