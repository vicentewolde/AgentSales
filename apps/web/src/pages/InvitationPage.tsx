import { PASSWORD_MIN_LENGTH } from "@agentsales/core";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError } from "../api/client.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { Button } from "../components/ui/Button.js";
import { Input } from "../components/ui/Field.js";
import { useAcceptInvitation } from "../queries/auth.js";
import { AuthShell } from "./LoginPage.js";

/**
 * `/invitacion#<token>` (spec F7 §4.2 y §4.11): elegir la contraseña con el enlace que mandó el
 * administrador. El token se lee del fragmento y se quita de la barra de direcciones.
 */
export function InvitationPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const accept = useAcceptInvitation();
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
      <AuthShell title="Elige tu contraseña">
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

  return (
    <AuthShell title="Elige tu contraseña">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-fg-muted">
          Al menos {PASSWORD_MIN_LENGTH} caracteres. Con ella entras al panel y a la CLI.
        </p>
        <div>
          <label htmlFor={passwordId} className="block text-sm font-medium text-slate-700">
            Contraseña
          </label>
          <Input
            id={passwordId}
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1"
          />
        </div>
        <div>
          <label htmlFor={repeatedId} className="block text-sm font-medium text-slate-700">
            Repite la contraseña
          </label>
          <Input
            id={repeatedId}
            type="password"
            autoComplete="new-password"
            required
            value={repeated}
            onChange={(event) => setRepeated(event.target.value)}
            className="mt-1"
          />
        </div>
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
