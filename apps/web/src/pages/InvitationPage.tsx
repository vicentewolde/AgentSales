import { PASSWORD_MIN_LENGTH } from "@agentsales/core";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError } from "../api/client.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { Alert } from "../components/ui/Alert.js";
import { Button } from "../components/ui/Button.js";
import { Field, Input } from "../components/ui/Field.js";
import { useAcceptInvitation, useLogout, useMe } from "../queries/auth.js";
import { AuthShell } from "./LoginPage.js";

const TITLE = "Crea tu usuario en AgentSales";

/**
 * `/invitacion#<token>` (spec F7 §4.2 y §4.11): elegir la contraseña con el enlace que mandó el
 * administrador. El token se lee del fragmento y se quita de la barra de direcciones.
 *
 * La sesión es una cookie por navegador (F9.5-T15): si ya hay una abierta (la del administrador que
 * creó el usuario, por ejemplo), se avisa antes del formulario y solo se cierra al confirmar.
 */
export function InvitationPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const accept = useAcceptInvitation();
  const me = useMe();
  const logout = useLogout();
  // Se confirma cerrar la sesión abierta: desde ahí, el formulario (la consulta ya no cuenta).
  const [sessionClosed, setSessionClosed] = useState(false);
  const [token] = useState(() => location.hash.replace(/^#/, ""));
  const [password, setPassword] = useState("");
  const [repeated, setRepeated] = useState("");
  const [mismatch, setMismatch] = useState<string | null>(null);
  const passwordId = useId();
  const repeatedId = useId();

  useEffect(() => {
    if (location.hash !== "") navigate(location.pathname, { replace: true });
  }, [location.hash, location.pathname, navigate]);

  if (token === "") {
    return (
      <AuthShell title={TITLE}>
        <p role="alert" className="text-sm text-danger-700">
          El enlace está incompleto: ábrelo tal como te llegó, o pide uno nuevo al administrador.
        </p>
      </AuthShell>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password.length < PASSWORD_MIN_LENGTH) {
      return setMismatch(`La contraseña debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres.`);
    }
    if (password !== repeated) return setMismatch("Las dos contraseñas no son iguales.");
    setMismatch(null);
    accept.mutate({ token, password }, { onSuccess: () => navigate("/", { replace: true }) });
  };
  const invalid = accept.error instanceof ApiError && accept.error.code === "INVITATION_INVALID";

  // Al aceptar, la sesión nueva reemplaza la consulta: el aviso ya no corresponde.
  const checkSession = !sessionClosed && accept.isIdle;
  if (checkSession && me.isPending) {
    return (
      <AuthShell title={TITLE}>
        <p role="status" className="text-sm text-fg-muted">
          Cargando…
        </p>
      </AuthShell>
    );
  }
  if (checkSession && me.data !== undefined) {
    const who = me.data.name === "" ? me.data.email : `${me.data.name} (${me.data.email})`;
    const keep =
      me.data.role === "admin" ? "Para seguir como administrador" : "Para seguir con tu sesión";
    return (
      <AuthShell title={TITLE}>
        <div className="space-y-4">
          <Alert tone="warning" role="alert" title="Ya hay una sesión abierta en este navegador">
            Tienes abierta la sesión de {who}. Si sigues, se cierra. {keep}, abre este enlace en una
            ventana privada.
          </Alert>
          {logout.error && <ErrorAlert error={logout.error} />}
          <Button
            className="w-full"
            disabled={logout.isPending}
            onClick={() => logout.mutate(undefined, { onSuccess: () => setSessionClosed(true) })}
          >
            {logout.isPending ? "Cerrando…" : "Seguir y cerrar esa sesión"}
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={TITLE}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-fg-muted">
          Estás creando tu usuario en AgentSales: elige una contraseña de al menos{" "}
          {PASSWORD_MIN_LENGTH} caracteres. Con ella entras al panel y a la CLI. Si ya tenías
          usuario y te mandaron este enlace para restablecerlo, aquí eliges la contraseña nueva.
        </p>
        <Field label="Contraseña" htmlFor={passwordId}>
          <Input
            id={passwordId}
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        <Field label="Repite la contraseña" htmlFor={repeatedId}>
          <Input
            id={repeatedId}
            type="password"
            autoComplete="new-password"
            required
            value={repeated}
            onChange={(event) => setRepeated(event.target.value)}
          />
        </Field>
        {mismatch !== null && (
          <p role="alert" className="text-sm text-danger-700">
            {mismatch}
          </p>
        )}
        {accept.error &&
          (invalid ? (
            <p role="alert" className="text-sm text-danger-700">
              El enlace venció, ya se usó o no es válido: pide uno nuevo al administrador.
            </p>
          ) : (
            <ErrorAlert error={accept.error} />
          ))}
        <Button type="submit" disabled={accept.isPending} className="w-full">
          {accept.isPending ? "Guardando…" : "Guardar y entrar"}
        </Button>
      </form>
    </AuthShell>
  );
}
