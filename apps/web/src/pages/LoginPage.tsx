import { type FormEvent, useId, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { ApiError } from "../api/client.js";
import { ErrorAlert } from "../components/ErrorAlert.js";
import { Button } from "../components/ui/Button.js";
import { Input } from "../components/ui/Field.js";
import { LogoMark } from "../components/ui/icons.js";
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
      <p role="alert" className="text-sm text-danger-700">
        {error.message.replace(/^[A-Z_]+: /, "")}
      </p>
    ) : (
      <ErrorAlert error={error} />
    ));

  if (challenge !== null) {
    return (
      <AuthShell title="Entrar">
        <form onSubmit={submitCode} className="space-y-4">
          <p className="text-sm text-fg-muted">
            Tienes el doble factor activo: escribe el código de 6 dígitos de tu app de claves, o uno
            de tus códigos de recuperación.
          </p>
          <div>
            <label htmlFor={codeId} className="block text-sm font-medium text-slate-700">
              Código
            </label>
            <Input
              id={codeId}
              autoComplete="one-time-code"
              required
              value={totpCode}
              onChange={(event) => setTotpCode(event.target.value)}
              className="mt-1"
            />
          </div>
          {errorView}
          <Button type="submit" disabled={loginTotp.isPending} className="w-full">
            {loginTotp.isPending ? "Revisando…" : "Verificar"}
          </Button>
          <Button
            variant="link"
            onClick={() => {
              setChallenge(null);
              loginTotp.reset();
            }}
            className="w-full text-xs"
          >
            Volver a la contraseña
          </Button>
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
          <Input
            id={emailId}
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1"
          />
        </div>
        <div>
          <label htmlFor={passwordId} className="block text-sm font-medium text-slate-700">
            Contraseña
          </label>
          <Input
            id={passwordId}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1"
          />
        </div>
        {errorView}
        <Button type="submit" disabled={login.isPending} className="w-full">
          {login.isPending ? "Entrando…" : "Entrar"}
        </Button>
        <p className="text-xs text-fg-subtle">
          ¿Olvidaste tu contraseña? Pídele al administrador un enlace nuevo.
        </p>
      </form>
    </AuthShell>
  );
}

/**
 * Las páginas públicas (F8-T18): HTML estático en `public/legal`, fuera de la app de React (el
 * revisor de Meta no corre JavaScript), así que se enlazan con `<a>` y no con el router.
 */
const LEGAL_LINKS = [
  { href: "/legal/terminos.html", label: "Términos de uso" },
  { href: "/legal/privacidad.html", label: "Privacidad" },
  { href: "/legal/eliminacion-de-datos.html", label: "Borrar tus datos" },
] as const;

/** El marco de las páginas sin sesión (entrar e invitación): sin menú ni banner. */
export function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas px-4">
      <section className="w-full max-w-sm rounded-xl border border-line bg-surface p-6 shadow-xs">
        <p className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <LogoMark className="size-8" />
          AgentSales
        </p>
        <h1 className="mt-5 mb-4 text-xl font-semibold">{title}</h1>
        {children}
      </section>
      <nav aria-label="Páginas legales" className="flex flex-wrap justify-center gap-4 text-sm">
        {LEGAL_LINKS.map(({ href, label }) => (
          <a
            key={href}
            href={href}
            className="text-fg-muted underline-offset-2 hover:text-fg hover:underline"
          >
            {label}
          </a>
        ))}
      </nav>
    </main>
  );
}
