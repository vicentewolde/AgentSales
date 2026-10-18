import { type FormEvent, useId, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ApiError } from "../api/client.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { useLogin, useLoginTotp } from "../queries/auth.js";

/** Adónde volver tras entrar: solo una ruta del panel (nunca otro sitio ni la misma página). */
export function returnPathOf(value: string | null): string {
  if (value === null || !value.startsWith("/") || value.startsWith("//")) return "/";
  // Una barra invertida o un carácter de control: algunos navegadores los leen como otro sitio.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: se buscan justamente los de control
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return "/";
  if (value.startsWith("/entrar") || value.startsWith("/invitacion")) return "/";
  return value;
}

const INPUT =
  "mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none";

/** Los errores que se muestran tal cual, sin el marco de error de la API. */
const PLAIN_ERRORS = new Set([
  "AUTH_INVALID",
  "AUTH_LOCKED",
  "TOTP_CODE_INVALID",
  "LOGIN_CHALLENGE_INVALID",
  "RATE_LIMITED",
]);

/**
 * `/entrar` (spec F7 §4.11): correo y contraseña; vuelve a la página donde estaba. Con el doble
 * factor (F8-T16), un segundo paso pide el código de la app o uno de recuperación.
 */
export function LoginPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const login = useLogin();
  const loginTotp = useLoginTotp();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // El desafío del segundo paso vive solo en el estado de la página (no en la caché).
  const [challenge, setChallenge] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const emailId = useId();
  const passwordId = useId();
  const codeId = useId();
  const goBack = () => navigate(returnPathOf(params.get("volver")), { replace: true });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    loginTotp.reset();
    login.mutate(
      { email, password },
      {
        onSuccess: (result) => {
          if ("totpRequired" in result) {
            setChallenge(result.challenge);
            setTotpCode("");
            login.reset();
            return;
          }
          goBack();
        },
      },
    );
  };
  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    if (challenge === null) return;
    loginTotp.mutate(
      { challenge, code: totpCode },
      {
        onSuccess: goBack,
        onError: (error) => {
          // El paso venció o se usó: vuelve a la contraseña con el mensaje.
          if (error instanceof ApiError && error.code === "LOGIN_CHALLENGE_INVALID") {
            setChallenge(null);
            setPassword("");
          }
        },
      },
    );
  };
  const error = login.error ?? loginTotp.error;
  const code = error instanceof ApiError ? error.code : undefined;
  const errorView =
    error &&
    (code !== undefined && PLAIN_ERRORS.has(code) ? (
      <p role="alert" className="text-sm text-red-700">
        {error.message.replace(/^[A-Z_]+: /, "")}
      </p>
    ) : (
      <ErrorAlert error={error} />
    ));

  if (challenge !== null) {
    return (
      <AuthShell title="Entrar">
        <form onSubmit={submitCode} className="space-y-4">
          <p className="text-sm text-slate-600">
            Tienes el doble factor activo: escribe el código de 6 dígitos de tu app de claves, o uno
            de tus códigos de recuperación.
          </p>
          <div>
            <label htmlFor={codeId} className="block text-sm font-medium text-slate-700">
              Código
            </label>
            <input
              id={codeId}
              autoComplete="one-time-code"
              required
              value={totpCode}
              onChange={(event) => setTotpCode(event.target.value)}
              className={INPUT}
            />
          </div>
          {errorView}
          <button
            type="submit"
            disabled={loginTotp.isPending}
            className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {loginTotp.isPending ? "Revisando…" : "Verificar"}
          </button>
          <button
            type="button"
            onClick={() => {
              setChallenge(null);
              loginTotp.reset();
            }}
            className="w-full text-xs text-slate-600 underline hover:text-slate-900"
          >
            Volver a la contraseña
          </button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Entrar">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor={emailId} className="block text-sm font-medium text-slate-700">
            Correo
          </label>
          <input
            id={emailId}
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor={passwordId} className="block text-sm font-medium text-slate-700">
            Contraseña
          </label>
          <input
            id={passwordId}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={INPUT}
          />
        </div>
        {errorView}
        <button
          type="submit"
          disabled={login.isPending}
          className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {login.isPending ? "Entrando…" : "Entrar"}
        </button>
        <p className="text-xs text-slate-500">
          ¿Olvidaste tu contraseña? Pídele al administrador un enlace nuevo.
        </p>
      </form>
    </AuthShell>
  );
}

/** El marco de las páginas sin sesión (entrar e invitación): sin menú ni banner. */
export function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <section className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-lg font-semibold tracking-tight">AgentSales</p>
        <h1 className="mt-1 mb-4 text-xl font-semibold">{title}</h1>
        {children}
      </section>
    </main>
  );
}
