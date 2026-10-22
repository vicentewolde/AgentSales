import type { UserLinkResponse } from "@agentsales/api/contracts";
import { userStateText } from "@agentsales/core";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { BrandForm } from "../components/brokers/BrandForm.js";
import { LogoAndTemplate } from "../components/brokers/LogoAndTemplate.js";
import { OnboardingList } from "../components/brokers/OnboardingList.js";
import { OneTimeLink, type OneTimeLinkKind } from "../components/brokers/OneTimeLink.js";
import {
  clearOneTimeLink,
  loadOneTimeLink,
  saveOneTimeLink,
} from "../components/brokers/one-time-link-store.js";
import { SpendLine } from "../components/brokers/SpendLine.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { EditorialProfileSection } from "../components/posts/EditorialProfileForm.js";
import { Button } from "../components/ui/Button.js";
import { Input } from "../components/ui/Field.js";
import { PageHeader } from "../components/ui/PageHeader.js";
import { useBrokerDetail, useUpdateBroker } from "../queries/brokers.js";
import { useUsage } from "../queries/usage.js";
import { useInviteUser, useResetUser, useSetUserDisabled, useUsers } from "../queries/users.js";
import { useCan, useRole } from "../scope/broker-scope.js";

/**
 * Los usuarios del corredor: invitar, restablecer, desactivar y reactivar. El enlace que se genera
 * se queda a la vista, aunque se recargue la página, hasta que se oculta o vence (F9.5-T20): vive
 * solo en el estado de la página y en `sessionStorage` de esta pestaña.
 */
function BrokerUsers({ brokerId }: { brokerId: string }) {
  const users = useUsers();
  const invite = useInviteUser();
  const reset = useResetUser();
  const toggle = useSetUserDisabled();
  const [link, setLink] = useState<{ link: UserLinkResponse; kind: OneTimeLinkKind } | null>(() =>
    loadOneTimeLink(brokerId),
  );
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
  // Al vencer, el enlace se oculta y se borra. Un temporizador no puede pasar de ~24 días; el
  // vencimiento real es de horas.
  const expiresAt = link?.link.expiresAt.getTime();
  useEffect(() => {
    if (expiresAt === undefined) return;
    const hide = () => {
      clearOneTimeLink(brokerId);
      setLink(null);
    };
    const wait = expiresAt - Date.now();
    if (wait <= 0) {
      hide();
      return;
    }
    const timer = setTimeout(hide, Math.min(wait, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [brokerId, expiresAt]);
  /** El enlace pasa al estado de la página y sale de la mutación (no queda en la caché). */
  const showLink = (
    created: UserLinkResponse,
    kind: OneTimeLinkKind,
    mutation: { reset: () => void },
  ) => {
    setLink({ link: created, kind });
    saveOneTimeLink(brokerId, { link: created, kind });
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
          showLink(created, "invitation", invite);
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
          link={link.link}
          kind={link.kind}
          onDone={() => {
            clearOneTimeLink(brokerId);
            setLink(null);
            emailInput.current?.focus();
          }}
        />
      )}
      {mine.length === 0 && users.data && (
        <p className="mt-1 text-sm text-fg-muted">Todavía no tiene usuario.</p>
      )}
      <ul className="mt-2 space-y-2 text-sm">
        {mine.map((user) => (
          <li key={user.id} className="flex flex-wrap items-center gap-2">
            <span>
              {user.name} · {user.email} · {userStateText(user)}
            </span>
            <Button
              variant="link"
              disabled={reset.isPending}
              aria-label={`Restablecer a ${user.email}`}
              onClick={() => {
                startAction();
                reset.mutate(user.id, {
                  onSuccess: (created) => showLink(created, "reset", reset),
                });
              }}
            >
              Restablecer
            </Button>
            {confirmingDisable === user.id ? (
              <span role="alert" className="flex flex-wrap items-center gap-2">
                ¿Desactivar a {user.email}? Se cierran sus sesiones.
                <Button
                  variant="danger"
                  size="sm"
                  disabled={toggle.isPending}
                  onClick={() => {
                    startAction();
                    toggle.mutate(
                      { id: user.id, disabled: true },
                      { onSettled: () => setConfirmingDisable(null) },
                    );
                  }}
                >
                  Sí, desactivar
                </Button>
                <Button variant="link" autoFocus onClick={stopConfirming}>
                  Cancelar
                </Button>
              </span>
            ) : (
              <Button
                variant="link"
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
              >
                {user.disabled ? "Reactivar" : "Desactivar"}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={submit} className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={`${id}-email`} className="text-sm font-medium">
            Correo
          </label>
          <Input
            ref={emailInput}
            id={`${id}-email`}
            name="email"
            type="email"
            required
            className="mt-1"
          />
        </div>
        <div>
          <label htmlFor={`${id}-name`} className="text-sm font-medium">
            Nombre
          </label>
          <Input id={`${id}-name`} name="name" required className="mt-1" />
        </div>
        <div className="self-end">
          <Button type="submit" disabled={invite.isPending}>
            {invite.isPending ? "Invitando…" : "Invitar"}
          </Button>
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
  if (role === null) return <p className="text-fg-muted">Cargando…</p>;
  if (!admin) return <p className="text-fg-muted">Esto lo hace el administrador.</p>;
  if (detail.error)
    return <ErrorAlert error={detail.error} onRetry={() => void detail.refetch()} />;
  if (detail.data === undefined) return <p className="text-fg-muted">Cargando…</p>;
  const { broker, onboarding } = detail.data;
  return (
    <div>
      <p className="mb-2">
        <Link to="/corredores" className="text-sm font-medium text-fg-muted hover:text-fg">
          ← Corredores
        </Link>
      </p>
      <PageHeader
        title={
          <>
            {broker.brandName}{" "}
            <span className="text-base font-normal text-fg-subtle">({broker.slug})</span>
          </>
        }
      />
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
        <p role="status" className="mt-2 text-sm text-success-800">
          {update.isSuccess && "Guardado."}
        </p>
      </section>
      <LogoAndTemplate broker={broker} />
      <EditorialProfileSection brokerId={broker.id} />
      <BrokerUsers key={broker.id} brokerId={broker.id} />
    </div>
  );
}
