import { formatUsd } from "@agentsales/core";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { BrandForm } from "../components/brokers/BrandForm.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { useBrokers, useCreateBroker } from "../queries/brokers.js";
import { useUsage } from "../queries/usage.js";
import { useRole } from "../scope/broker-scope.js";

/**
 * Corredores (spec F7 §4.11, administrador): la lista con su gasto del mes y su tope, y crear uno.
 * El detalle (marca, usuarios, lista de alta) está en `/corredores/:id`.
 */
export function BrokersPage() {
  const role = useRole();
  const brokers = useBrokers();
  const usage = useUsage();
  const create = useCreateBroker();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  if (role === "broker") {
    return <p className="text-slate-600">Esto lo hace el administrador.</p>;
  }
  const spendOf = (id: string) => usage.data?.brokers.find((row) => row.brokerId === id);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Corredores</h1>
      <p className="mt-1 text-slate-600">
        Cada corredor con su marca, sus usuarios, su gasto de IA del mes (estimado) y su lista de
        alta.
      </p>
      {brokers.error && <ErrorAlert error={brokers.error} onRetry={() => void brokers.refetch()} />}
      {brokers.data && (
        <table className="mt-4 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-slate-500">
              <th className="py-2 font-medium">Marca</th>
              <th className="py-2 font-medium">Propio</th>
              <th className="py-2 font-medium">Gasto de IA del mes</th>
            </tr>
          </thead>
          <tbody>
            {brokers.data.map((broker) => {
              const spend = spendOf(broker.id);
              return (
                <tr key={broker.id} className="border-b border-slate-100">
                  <td className="py-2">
                    <Link to={`/corredores/${broker.id}`} className="underline">
                      {broker.brandName}
                    </Link>{" "}
                    <span className="text-slate-500">({broker.slug})</span>
                  </td>
                  <td className="py-2">{broker.operatorOwned ? "Sí" : "No"}</td>
                  <td className="py-2">
                    {spend === undefined
                      ? "—"
                      : `${formatUsd(spend.spentUsd)}${spend.capUsd === null ? " (sin tope)" : ` de ${formatUsd(spend.capUsd)}`}`}
                    {spend?.capReached && (
                      <span className="ml-1 font-medium text-red-700">tope alcanzado</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
          >
            Crear un corredor
          </button>
        )}
      </section>
    </div>
  );
}
