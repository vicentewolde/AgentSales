# ADR-0026 · Login para internet (límites por IP, doble factor, `__Host-` y cabeceras) y sin RLS

- **Estado:** Aceptado
- **Fecha:** 2026-10-18
- **Modifica a:** ADR-0021 (la cookie y el login en dos pasos) y ADR-0022 (punto 7: RLS evaluado y no adoptado)

## Contexto
- ADR-0021 dejó el login propio con `scrypt`, sesiones en la base y bloqueo por usuario (10 fallos, 15 min), pensado para el Mac; su seguimiento pide límites por IP en F8, y el `Secure` de la cookie con HTTPS.
- ADR-0022 dejó la separación por corredor en la API y los repositorios, y RLS para evaluar en F8 como segunda barrera.
- En F8 hay una sola instancia de la API (spec F8 §3), detrás del proxy de Fly, que entrega la IP del cliente en `Fly-Client-IP`.
- No se quieren dependencias nuevas (`CLAUDE.md`, regla 8).

## Decisión
1. **Límites por IP en memoria, en la API** (no es un puerto de core: core no lo usa): entrar y su segundo paso, 10 por minuto y 50 por hora; aceptar invitaciones, 10 por hora; toda la API, 300 por minuto (con sesión, también por usuario). 429 `RATE_LIMITED` con `Retry-After`. La IP sale de `CLIENT_IP_HEADER` (en Fly, `Fly-Client-IP`); sin configurarla, la del socket, y nunca `X-Forwarded-For` sin configurar. El bloqueo por usuario sigue.
2. **Doble factor TOTP opcional** (RFC 6238 con `node:crypto`, sin dependencias ni código QR: la clave y el enlace `otpauth://`), recomendado para el administrador. La clave se cifra con `SecretBox` (propósito `totp`); 10 códigos de recuperación, solo sus hashes; un código usado no sirve otra vez. Entrar es en dos pasos: con el doble factor activo, la contraseña da un desafío de un solo uso (5 min) y `POST /api/auth/login/totp` crea la sesión; sus fallos cuentan para el bloqueo. Restablecer un usuario y `pnpm auth:admin` lo quitan.
3. **Cookies con HTTPS:** `__Host-agentsales_session` (`Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, sin `Domain`) y una cookie de `state` por proveedor de OAuth (`__Host-…_ig` y `__Host-…_ml`, `Lax`). En desarrollo, los nombres de hoy.
4. **Cabeceras de seguridad** con `secureHeaders` de Hono: HSTS, una CSP del panel con el origen de R2 de la configuración, `nosniff`, `Referrer-Policy: same-origin`, `frame-ancestors 'none'`.
5. **Sin RLS:** la separación sigue en la API y los repositorios con la tabla de permisos, la matriz de 404 y el filtro en SQL de F7.

## Consecuencias
- Adivinar contraseñas desde internet choca con dos topes (IP y usuario), y el administrador puede sumar un segundo factor.
- Con más de una instancia de la API, los límites en memoria dejan de ser globales: habría que moverlos a la base o a otro almacén (un ADR nuevo).
- Sin código QR, activar el doble factor pide copiar la clave o abrir el enlace en el teléfono.
- Un error en un repositorio o en la tabla de permisos todavía puede filtrar datos entre corredores sin una segunda barrera en la base; lo cubren las pruebas y la revisión de cada lote.

## Alternativas descartadas
- **RLS de Postgres:** exige fijar el corredor en cada transacción (`SET LOCAL`) y envolver cada consulta de los 15 repositorios y de los jobs, el rol de la conexión de Neon es dueño de las tablas (pasa por encima de RLS salvo `FORCE`), y no protege de un error en la tabla de permisos, que es donde se decide el alcance. Se revisa si llegan muchos corredores o un segundo desarrollador.
- **Límites en la base:** más escrituras por pedido (y Neon despierto) para una sola instancia.
- **Una librería de TOTP y de QR:** dependencias nuevas para lo que `node:crypto` y un enlace resuelven.
- **Doble factor obligatorio para todos:** frena a los corredores del piloto; queda opcional y recomendado para el administrador.
- **Un proveedor externo (Clerk, Auth0):** descartado en ADR-0021 por las mismas razones.
