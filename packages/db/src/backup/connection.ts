/**
 * La conexión de `pg_dump` por variables de entorno del proceso (spec F6 §4.11): nunca en los
 * argumentos (se verían en `ps`) ni en el log. TLS con verificación del certificado
 * (`verify-full`) y los certificados del sistema (`PGSSLROOTCERT=system`, que libpq 16 o más
 * necesita), salvo una base local que pide `sslmode=disable`. Neon recomienda volcar por la conexión
 * directa: un host con `-pooler` se cambia por el directo (nota `neon-backup.md` §3).
 */
export function pgEnvFromUrl(databaseUrl: string): Record<string, string> {
  const url = new URL(databaseUrl);
  const host = url.hostname.replace(/^([^.]+)-pooler\./, "$1.");
  const sslmode = url.searchParams.get("sslmode");
  const channelBinding = url.searchParams.get("channel_binding");
  return {
    PGHOST: host,
    ...(url.port === "" ? {} : { PGPORT: url.port }),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
    ...(sslmode === "disable"
      ? { PGSSLMODE: "disable" }
      : { PGSSLMODE: "verify-full", PGSSLROOTCERT: "system" }),
    ...(channelBinding === null ? {} : { PGCHANNELBINDING: channelBinding }),
  };
}

/**
 * El entorno de los procesos hijos: solo lo que necesitan (el `PATH`, el `HOME` y el idioma), nunca
 * el del proceso entero (trae `DATABASE_URL` y los demás secretos de `.env`).
 */
export function childEnv(
  extra: Record<string, string>,
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "LANG", "TMPDIR"]) {
    const value = source[name];
    if (value !== undefined) base[name] = value;
  }
  return { ...base, ...extra };
}
