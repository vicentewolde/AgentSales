import type { UserLinkResponse, UserView } from "@agentsales/api/contracts";
import { type FormEvent, useId, useState } from "react";
import { Link, useParams } from "react-router";
import { BrandForm } from "../components/brokers/BrandForm.js";
import { LogoAndTemplate } from "../components/brokers/LogoAndTemplate.js";
import { OnboardingList } from "../components/brokers/OnboardingList.js";
import { OneTimeLink } from "../components/brokers/OneTimeLink.js";
import { SpendLine } from "../components/brokers/SpendLine.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { useBrokerDetail, useUpdateBroker } from "../queries/brokers.js";
import { useUsage } from "../queries/usage.js";
import { useInviteUser, useResetUser, useSetUserDisabled, useUsers } from "../queries/users.js";
import { useRole } from "../scope/broker-scope.js";

const fieldClass = "mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm";

function userState(user: UserView): string {
  if (user.disabled) return "desactivado";
  if (user.locked) return "bloqueado por intentos fallidos";
  if (!user.hasPassword) return "todavía sin contraseña";
  return "activo";
}

/** Los usuarios del corredor: invitar, restablecer, desactivar y reactivar (el enlace, una vez). */
function BrokerUsers({ brokerId }: { brokerId: string }) {
  const users = useUsers();
  const invite = useInviteUser();
  const reset = useResetUser();
  const toggle = useSetUserDisabled();
  const [link, setLink] = useState<UserLinkResponse | null>(null);
  const id = useId();
  const mine = (users.data ?? []).filter((user) => user.brokerId === brokerId);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    invite.mutate(
      {
        email: String(form.get("email") ?? ""),
        name: String(form.get("name") ?? ""),
        role: "broker",
        brokerId,
      },
      {
        onSuccess: (created) => {
          setLink(created);
          formElement.reset();
        },
      },
    );
  };
  const error = invite.error ?? reset.error ?? toggle.error ?? users.error;
  return (
    <section aria-label="Usuarios" className="mt-6">
      <h2 className="text-lg font-semibold">Usuarios</h2>
      {link !== null && <OneTimeLink link={link} onDone={() => setLink(null)} />}
      {mine.length === 0 && users.data && (
        <p className="mt-1 text-sm text-slate-600">Todavía no tiene usuario.</p>
      )}
      <ul className="mt-2 space-y-2 text-sm">
        {mine.map((user) => (
          <li key={user.id} className="flex flex-wrap items-center gap-2">
            <span>
              {user.name} · {user.email} · {userState(user)}
            </span>
            <button
              type="button"
              disabled={reset.isPending}
              onClick={() => reset.mutate(user.id, { onSuccess: setLink })}
              className="underline"
            >
              Restablecer
            </button>
            <button
              type="button"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate({ id: user.id, disabled: !user.disabled })}
              className="underline"
            >
              {user.disabled ? "Reactivar" : "Desactivar"}
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={`${id}-email`} className="text-sm font-medium">
            Correo
          </label>
          <input id={`${id}-email`} name="email" type="email" required className={fieldClass} />
        </div>
        <div>
          <label htmlFor={`${id}-name`} className="text-sm font-medium">
            Nombre
          </label>
          <input id={`${id}-name`} name="name" required className={fieldClass} />
        </div>
        <div className="self-end">
          <button
            type="submit"
            disabled={invite.isPending}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {invite.isPending ? "Invitando…" : "Invitar"}
          </button>
        </div>
      </form>
      {error && <ErrorAlert error={error} />}
    </section>
  );
}

/** Un corredor (spec F7 §4.11, administrador): marca, ajustes, logo, planilla, usuarios y alta. */
export function BrokerPage() {
  const { id = "" } = useParams();
  const role = useRole();
  const detail = useBrokerDetail(id);
  const update = useUpdateBroker(id);
  const usage = useUsage();
  if (role === "broker") return <p className="text-slate-600">Esto lo hace el administrador.</p>;
  if (detail.error)
    return <ErrorAlert error={detail.error} onRetry={() => void detail.refetch()} />;
  if (detail.data === undefined) return <p className="text-slate-600">Cargando…</p>;
  const { broker, onboarding } = detail.data;
  return (
    <div>
      <p className="text-sm">
        <Link to="/corredores" className="underline">
          ← Corredores
        </Link>
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        {broker.brandName} <span className="text-base text-slate-500">({broker.slug})</span>
      </h1>
      <SpendLine usage={usage.data} brokerId={broker.id} />
      <OnboardingList steps={onboarding} />
      <section aria-label="Marca" className="mt-6">
        <h2 className="text-lg font-semibold">Marca y ajustes</h2>
        <BrandForm
          key={`${broker.id}-${broker.brandName}`}
          broker={broker}
          admin
          submitLabel="Guardar"
          pending={update.isPending}
          error={update.error}
          onSubmit={(values) => update.mutate(values)}
        />
        {update.isSuccess && <p className="mt-2 text-sm text-green-800">Guardado.</p>}
      </section>
      <LogoAndTemplate broker={broker} />
      <BrokerUsers brokerId={broker.id} />
    </div>
  );
}
