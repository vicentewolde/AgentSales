import { llmSpendText } from "@agentsales/core";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { BrandForm } from "../components/brokers/BrandForm.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { Button } from "../components/ui/Button.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { useBrokers, useCreateBroker } from "../queries/brokers.js";
import { useUsage } from "../queries/usage.js";
import { useCan, useRole } from "../scope/broker-scope.js";

/**
 * Corredores (spec F7 §4.11, administrador): la lista con su gasto del mes y su tope, y crear uno.
 * El detalle (marca, usuarios, lista de alta) está en `/corredores/:id`.
 */
export function BrokersPage() {
  const role = useRole();
  const allowed = useCan("brokers.create");
  const brokers = useBrokers();
  const usage = useUsage(allowed);
  const create = useCreateBroker();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  // Mientras no se sabe el rol, nada de la vista del administrador.
  if (role === null) return <p className="text-fg-muted">Cargando…</p>;
  if (!allowed) return <p className="text-fg-muted">Esto lo hace el administrador.</p>;
  const spendOf = (id: string) => usage.data?.brokers.find((row) => row.brokerId === id);
  return (
    <div>
      <PageHeader
        title="Corredores"
        description={
          <>
            Cada corredor con su marca, sus usuarios, su gasto de IA del mes (estimado) y su lista
            de alta.
          </>
        }
      />
      {brokers.error && <ErrorAlert error={brokers.error} onRetry={() => void brokers.refetch()} />}
      {brokers.data && (
        <div className="mt-4 overflow-x-auto rounded-xl border border-line bg-surface shadow-xs">
          <table className="ui-table">
            <thead>
              <tr>
                <th>Marca</th>
                <th>Propio</th>
                <th>Gasto de IA del mes</th>
              </tr>
            </thead>
            <tbody>
              {brokers.data.map((broker) => {
                const spend = spendOf(broker.id);
                return (
                  <tr key={broker.id}>
                    <td>
                      <Link
                        to={`/corredores/${broker.id}`}
                        className="font-medium text-brand-700 underline underline-offset-2 hover:text-brand-900"
                      >
                        {broker.brandName}
                      </Link>{" "}
                      <span className="text-fg-subtle">({broker.slug})</span>
                    </td>
                    <td>{broker.operatorOwned ? "Sí" : "No"}</td>
                    <td>
                      {spend === undefined ? "—" : llmSpendText(spend)}
                      {spend?.capReached && (
                        <span className="ml-1 font-medium text-danger-700">tope alcanzado</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <section aria-label="Crear un corredor" className="mt-6">
        {creating ? (
          <>
            <h2 className="text-lg font-semibold">Crear un corredor</h2>
            <BrandForm
              withSlug
              admin
              submitLabel="Crear corredor"
              pending={create.isPending}
              error={create.error}
              onSubmit={({ slug, name, brandName, primaryColor, ...rest }) =>
                create.mutate(
                  {
                    ...rest,
                    slug: slug ?? "",
                    name: name ?? "",
                    brandName: brandName ?? "",
                    primaryColor: primaryColor ?? "",
                  },
                  { onSuccess: ({ broker }) => navigate(`/corredores/${broker.id}`) },
                )
              }
            />
          </>
        ) : (
          <Button onClick={() => setCreating(true)}>Crear un corredor</Button>
        )}
      </section>
    </div>
  );
}
