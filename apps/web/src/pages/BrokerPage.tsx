import type { UserLinkResponse } from "@agentsales/api/contracts";
import { userStateText } from "@agentsales/core";
import { type FormEvent, useId, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { BrandForm } from "../components/brokers/BrandForm.js";
import { LogoAndTemplate } from "../components/brokers/LogoAndTemplate.js";
import { OnboardingList } from "../components/brokers/OnboardingList.js";
import { OneTimeLink } from "../components/brokers/OneTimeLink.js";
import { SpendLine } from "../components/brokers/SpendLine.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { EditorialProfileSection } from "../components/posts/EditorialProfileForm.js";
import { useBrokerDetail, useUpdateBroker } from "../queries/brokers.js";
import { useUsage } from "../queries/usage.js";
import { useInviteUser, useResetUser, useSetUserDisabled, useUsers } from "../queries/users.js";
import { useCan, useRole } from "../scope/broker-scope.js";

const fieldClass = "mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm";

/** Los usuarios del corredor: invitar, restablecer, desactivar y reactivar (el enlace, una vez). */
function BrokerUsers({ brokerId }: { brokerId: string }) {
  const users = useUsers();
  const invite = useInviteUser();
  const reset = useResetUser();
  const toggle = useSetUserDisabled();
  const [link, setLink] = useState<UserLinkResponse | null>(null);
  const [confirmingDisable, setConfirmingDisable] = useState<string | null>(null);
  const stopConfirming = () => setConfirmingDisable(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const mine = (users.data ?? []).filter((user) => user.brokerId === brokerId);
  // Un solo error a la vista: el de la última acción.
  const startAction = () => {
    invite.reset();
    reset.reset();
    toggle.reset();
  };
  /** El enlace pasa al estado de la página y sale de la mutación (no queda en la caché). */
  const showLink = (created: UserLinkResponse, mutation: { reset: () => void }) => {
    setLink(created);
    mutation.reset();
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    startAction();
    invite.mutate(
      {
        email: String(form.get("email") ?? ""),
        name: String(form.get("name") ?? ""),
        role: "broker",
        brokerId,
      },
      {
        onSuccess: (created) => {
          showLink(created, invite);
          formElement.reset();
        },
      },
    );
  };
  const error = invite.error ?? reset.error ?? toggle.error ?? users.error;
  return (
    <section aria-label="Usuarios" className="mt-6">
      <h2 className="text-lg font-semibold">Usuarios</h2>
      {link !== null && (
        <OneTimeLink
          link={link}
          onDone={() => {
            setLink(null);
            emailInput.current?.focus();
          }}
        />
      )}
      {mine.length === 0 && users.data && (
        <p className="mt-1 text-sm text-slate-600">Todavía no tiene usuario.</p>
      )}
      <ul className="mt-2 space-y-2 text-sm">
        {mine.map((user) => (
          <li key={user.id} className="flex flex-wrap items-center gap-2">
            <span>
              {user.name} · {user.email} · {userStateText(user)}
            </span>
            <button
              type="button"
              disabled={reset.isPending}
              aria-label={`Restablecer a ${user.email}`}
              onClick={() => {
                startAction();
                reset.mutate(user.id, { onSuccess: (created) => showLink(created, reset) });
              }}
              className="underline"
            >
              Restablecer
            </button>
            {confirmingDisable === user.id ? (
              <span role="alert" className="flex flex-wrap items-center gap-2">
                ¿Desactivar a {user.email}? Se cierran sus sesiones.
                <button
                  type="button"
                  disabled={toggle.isPending}
                  onClick={() => {
                    startAction();
                    toggle.mutate(
                      { id: user.id, disabled: true },
                      { onSettled: () => setConfirmingDisable(null) },
                    );
                  }}
                  className="rounded-md bg-red-700 px-2 py-1 font-medium text-white"
                >
                  Sí, desactivar
                </button>
                {/* biome-ignore lint/a11y/noAutofocus: el foco va a la opción segura al abrir la confirmación */}
                <button type="button" autoFocus onClick={stopConfirming} className="underline">
                  Cancelar
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={toggle.isPending}
                aria-label={`${user.disabled ? "Reactivar" : "Desactivar"} a ${user.email}`}
                onClick={() => {
                  if (!user.disabled) {
                    setConfirmingDisable(user.id);
                    return;
                  }
                  startAction();
                  toggle.mutate({ id: user.id, disabled: false });
                }}
                className="underline"
              >
                {user.disabled ? "Reactivar" : "Desactivar"}
              </button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={`${id}-email`} className="text-sm font-medium">
            Correo
          </label>
          <input
            ref={emailInput}
            id={`${id}-email`}
            name="email"
            type="email"
            required
            className={fieldClass}
          />
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
  const admin = useCan("users.manage");
  const detail = useBrokerDetail(id, admin);
  const update = useUpdateBroker(id);
  const usage = useUsage(admin);
  // Mientras no se sabe el rol, nada de la vista del administrador (ni sus pedidos).
  if (role === null) return <p className="text-slate-600">Cargando…</p>;
  if (!admin) return <p className="text-slate-600">Esto lo hace el administrador.</p>;
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
      <OnboardingList steps={onboarding} kind={broker.kind} />
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
        <p role="status" className="mt-2 text-sm text-green-800">
          {update.isSuccess && "Guardado."}
        </p>
      </section>
      <LogoAndTemplate broker={broker} />
      <EditorialProfileSection brokerId={broker.id} />
      <BrokerUsers key={broker.id} brokerId={broker.id} />
    </div>
  );
}
