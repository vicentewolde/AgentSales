# ADR-0021 · Autenticación propia: contraseñas con `scrypt`, sesiones en la base e invitaciones por enlace

- **Estado:** Aceptado
- **Fecha:** 2026-10-16

## Contexto
- Hasta F6 la API no tiene autenticación: escucha en `127.0.0.1`, `hostGuard` solo acepta `localhost` y el CSRF de Hono revisa formularios y multipart (`apps/api/src/security.ts`). El actor de la bitácora sale de la cabecera `X-AgentSales-Client`, que cualquier proceso local puede mandar.
- F7 (spec F7, D1 y D2, respuestas del operador) suma usuarios: el operador como administrador y uno o más usuarios por corredor, que ven solo lo suyo. Todo sigue en el Mac del operador; F8 lo lleva a internet.
- El stack no tiene una librería de autenticación, y las dependencias nuevas requieren justificación. No hay correo saliente.
- Lucia, la referencia habitual en TypeScript para sesiones propias, está descontinuada. Un proveedor externo (Clerk, Auth0) exige internet, otra cuenta y entregar los usuarios a un tercero.

## Decisión
1. **Usuarios** con rol `admin` (sin corredor) o `broker` (con `broker_id`), en la tabla `users`.
2. **Contraseñas con `scrypt` de `node:crypto`**, sal propia por hash y comparación en tiempo constante; mínimo 12 caracteres. Vive en `packages/config` detrás del puerto `PasswordHasher` de core, como `SecretBox`. Los tokens aleatorios y su SHA-256 van por el puerto `SecretTokens`.
3. **Sesiones en la base** (`sessions`): un token aleatorio de 32 bytes del que se guarda solo el hash; vence a los 30 días o tras 7 sin uso. El panel la recibe en una cookie `HttpOnly`, `SameSite=Strict` (y `Secure` con HTTPS); la CLI, en el cuerpo, y la manda como `Authorization: Bearer`. Con cookie, toda escritura exige `Origin` del panel.
4. **Entrar:** un solo error para correo o contraseña equivocados (con un hash calculado igual si el correo no existe) y bloqueo de 15 min tras 10 fallos seguidos.
5. **Invitaciones por enlace:** el administrador crea el usuario y recibe una vez un enlace con el token en el fragmento (`#`), que vence a las 72 h y sirve una vez; el usuario elige su contraseña. Restablecer genera otro enlace y cierra todas las sesiones. Sin correo saliente: el operador copia el enlace.
6. **El primer administrador** lo crea o restablece `pnpm auth:admin`, que habla directo con la base y deja el enlace en el portapapeles.
7. Si la base no responde, la API responde 503, nunca 401 (no se pierde la sesión por un corte).

## Consecuencias
- Sin dependencias nuevas ni un tercero que conozca a los usuarios; todo se prueba con PGlite y dobles.
- El proyecto carga con la responsabilidad de la seguridad del login (hash, bloqueo, cookies, CSRF): se acota con tests y con F8, que lo endurece para internet.
- La CLI y Claude necesitan una sesión del operador (`agentsales login`), guardada en `~/.agentsales/cli-session.json` (`0600`), que Claude no lee.
- Sin recuperación de contraseña por correo: depende del operador.

## Alternativas descartadas
- **Clerk, Auth0 u otro proveedor externo:** exige internet y otra cuenta, y entrega los usuarios a un tercero, para un sistema que en F7 corre en local.
- **Lucia:** descontinuada.
- **Better Auth u otra librería:** dependencia nueva grande para lo que `node:crypto` y dos tablas resuelven.
- **Tokens firmados sin estado (JWT):** no se pueden revocar al desactivar o restablecer sin una lista en la base, que es justo una tabla de sesiones.
- **Un usuario por corredor compartido:** no dice quién hizo qué en la bitácora.
- **`argon2`:** mejor que `scrypt` en papel, pero necesita un módulo nativo; `scrypt` viene con Node y es aceptable con los parámetros adecuados.

## Seguimiento
- 2026-10-17 (revisión del lote A, PR #130), riesgos aceptados y precisiones:
  - **`AUTH_LOCKED` revela que un correo existe** (solo uno real llega a bloquearse): se acepta porque el bloqueo protege la contraseña, que importa más en un sistema local; la rama bloqueada hace el mismo trabajo de hash. Intentos en paralelo antes del bloqueo cuentan todos. F8 suma límites por IP.
  - **Restablecer no anula la contraseña anterior** hasta que se usa el enlace: así nadie queda fuera por un enlace que no llegó. Si la contraseña se filtró, el operador además desactiva al usuario hasta que elija otra.
  - **Invitar y aceptar no son una transacción:** si una escritura falla a mitad, la salida es restablecer (un enlace nuevo).
  - La contraseña se normaliza a NFC antes del hash, y un hash guardado con parámetros que piden más de 128 MB no se intenta. Dos enlaces generados a la vez para el mismo usuario se reintentan una vez (`INVITATION_CONFLICT` si vuelven a chocar).
- 2026-10-17 (lote C, PR #132): **el usuario de la bitácora va por ambiente.** El canal (`actor`) sigue pasando por cada caso de uso como siempre; la persona no: `authenticate` corre cada pedido con su usuario en el puerto `RequestContext` (`AsyncLocalStorage`, compuesto en `server.ts`) y el candado de la API (`withEventUser`) lo pone en cada evento. La invariante que lo cierra: toda escritura de la API pasa por el candado (`AppDeps.publications` es de solo lectura). Así core no lleva el usuario por 25 casos de uso; el worker escribe sin usuario.

