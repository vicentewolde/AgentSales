import type { TotpSetupResponse } from "@agentsales/api/contracts";
import { type FormEvent, useId, useState } from "react";
import { ErrorAlert } from "../components/ErrorAlert.js";
import {
  useConfirmTotp,
  useDisableTotp,
  useMe,
  useStartTotp,
  useTotpStatus,
} from "../queries/auth.js";

const INPUT =
  "mt-1 block w-full max-w-xs rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none";
const BUTTON =
  "rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50";

/** La clave en grupos de 4, para copiarla a mano en la app. */
const grouped = (secret: string) => secret.match(/.{1,4}/g)?.join(" ") ?? secret;

/**
 * Mi cuenta (spec F8 §4.8, F8-T16): el doble factor con una app de claves. Activar muestra la clave
 * y el enlace `otpauth://` (sin código QR) y pide un código; después muestra los 10 códigos de
 * recuperación una sola vez. La clave y los códigos viven solo en el estado de la página: las
 * mutaciones que los traen se limpian al recibirlos (no quedan en la caché del panel).
 */
export function AccountPage() {
  const me = useMe();
  const status = useTotpStatus();
  const start = useStartTotp();
  const confirm = useConfirmTotp();
  const disable = useDisableTotp();
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const codeId = useId();
  const disableId = useId();
  const keyId = useId();

  const begin = () => {
    disable.reset();
    start.mutate(undefined, {
      onSuccess: (result) => {
        setSetup(result);
        setCode("");
        start.reset();
      },
    });
  };
  const submitConfirm = (event: FormEvent) => {
    event.preventDefault();
    confirm.mutate(code, {
      onSuccess: (result) => {
        setRecoveryCodes(result.recoveryCodes);
        setSetup(null);
        setCode("");
        confirm.reset();
      },
    });
  };
  const submitDisable = (event: FormEvent) => {
    event.preventDefault();
    disable.mutate(code, { onSuccess: () => setCode("") });
  };
  const copyCodes = async () => {
    if (recoveryCodes === null) return;
    await navigator.clipboard.writeText(recoveryCodes.join("\n"));
    setCopied(true);
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Mi cuenta</h1>
      {me.data !== undefined && (
        <p className="mt-1 text-sm text-slate-600">
          {me.data.name} · {me.data.email}
        </p>
      )}

      <section aria-label="Doble factor" className="mt-6 max-w-2xl">
        <h2 className="text-lg font-semibold">Doble factor</h2>
        <p className="mt-1 text-sm text-slate-600">
          Además de la contraseña, al entrar se pide un código de 6 dígitos de una app de claves en
          tu teléfono (Google Authenticator, 1Password, Authy u otra).
          {me.data?.role === "admin" && " Recomendado para el administrador."}
        </p>

        {recoveryCodes !== null && (
          <div role="status" className="mt-4 rounded-lg border border-green-300 bg-green-50 p-4">
            <p className="font-semibold text-green-900">El doble factor quedó activo.</p>
            <p className="mt-1 text-sm text-green-900">
              Guarda estos códigos de recuperación en tu gestor de claves: cada uno sirve una vez
              para entrar si pierdes el teléfono. Se muestran una sola vez.
            </p>
            <ul className="mt-3 grid grid-cols-2 gap-1 font-mono text-sm">
              {recoveryCodes.map((recovery) => (
                <li key={recovery}>{recovery}</li>
              ))}
            </ul>
            <div className="mt-3 flex gap-3">
              <button type="button" className={BUTTON} onClick={() => void copyCodes()}>
                {copied ? "Copiados" : "Copiar los códigos"}
              </button>
              <button
                type="button"
                className="text-sm text-slate-700 underline"
                onClick={() => {
                  setRecoveryCodes(null);
                  setCopied(false);
                }}
              >
                Ya los guardé, ocultarlos
              </button>
            </div>
          </div>
        )}

        {status.error && <ErrorAlert error={status.error} onRetry={() => void status.refetch()} />}
        {status.data === undefined && !status.error && (
          <p className="mt-3 text-slate-600">Cargando…</p>
        )}

        {status.data?.enabled === true && recoveryCodes === null && (
          <form onSubmit={submitDisable} className="mt-4 space-y-3">
            <p className="text-sm text-slate-700">
              Activo. Te quedan {status.data.recoveryCodesLeft} códigos de recuperación.
            </p>
            <div>
              <label htmlFor={disableId} className="block text-sm font-medium text-slate-700">
                Código para desactivarlo
              </label>
              <input
                id={disableId}
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className={INPUT}
              />
            </div>
            {disable.error && <ErrorAlert error={disable.error} />}
            <button type="submit" disabled={disable.isPending} className={BUTTON}>
              {disable.isPending ? "Desactivando…" : "Desactivar el doble factor"}
            </button>
          </form>
        )}

        {status.data?.enabled === false && setup === null && (
          <div className="mt-4">
            {disable.isSuccess && (
              <p role="status" className="mb-2 text-sm text-slate-700">
                El doble factor quedó desactivado.
              </p>
            )}
            {start.error && <ErrorAlert error={start.error} />}
            <button type="button" disabled={start.isPending} className={BUTTON} onClick={begin}>
              Activar el doble factor
            </button>
          </div>
        )}

        {setup !== null && (
          <form onSubmit={submitConfirm} className="mt-4 space-y-3">
            <ol className="list-decimal space-y-2 pl-5 text-sm text-slate-700">
              <li>
                En el teléfono, abre{" "}
                <a href={setup.otpauthUrl} className="underline">
                  este enlace en tu app de claves
                </a>
                , o agrega una cuenta nueva y escribe esta clave a mano:
                <label htmlFor={keyId} className="sr-only">
                  Clave
                </label>
                <input
                  id={keyId}
                  readOnly
                  value={grouped(setup.secret)}
                  className="mt-1 block w-full max-w-sm rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-base tracking-wider"
                />
              </li>
              <li>Escribe el código de 6 dígitos que muestra la app.</li>
            </ol>
            <div>
              <label htmlFor={codeId} className="block text-sm font-medium text-slate-700">
                Código de la app
              </label>
              <input
                id={codeId}
                autoComplete="one-time-code"
                inputMode="numeric"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className={INPUT}
              />
            </div>
            {confirm.error && <ErrorAlert error={confirm.error} />}
            <div className="flex gap-3">
              <button type="submit" disabled={confirm.isPending} className={BUTTON}>
                {confirm.isPending ? "Revisando…" : "Confirmar"}
              </button>
              <button
                type="button"
                className="text-sm text-slate-700 underline"
                onClick={() => {
                  setSetup(null);
                  confirm.reset();
                }}
              >
                Cancelar
              </button>
            </div>
            <p className="text-xs text-slate-500">
              Al activarlo se cierran tus otras sesiones (también la de la CLI).
            </p>
          </form>
        )}
      </section>
    </div>
  );
}
