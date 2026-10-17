# Spec F7 · Varios corredores

- **Estado:** **Aprobado** el 2026-10-16 (D1 a D7 y D14 a D16 las respondió el operador; el resto, con su aprobación permanente)
- **Rama base:** `main`
- **Tag al cerrar:** `v0.7.0`
- **Referencias:** `docs/06-roadmap.md#f7--varios-corredores` (y `#f8--en-internet`), ADR-0003, ADR-0004, ADR-0005, ADR-0006, ADR-0011, ADR-0014, ADR-0017, ADR-0019, ADR-0021, ADR-0022 y ADR-0023 (nuevos), `docs/01-arquitectura.md` (capas, contratos HTTP, seguridad de la API), `docs/02-modelo-datos.md`, `docs/integraciones/anthropic-api.md` y `docs/integraciones/instagram.md` (ampliadas el 2026-10-16)

## 1. Objetivo
El operador da de alta a un corredor de verdad (su marca, su logo, su planilla de Excel y su usuario), y ese corredor entra al sistema con su correo y su contraseña, ve **solo sus propiedades** y hace casi todo por su cuenta: cargar, preparar, aprobar, publicar, programar y cerrar. La IA de los corredores corre con la API de Anthropic y la clave del operador, con el gasto anotado por corredor y un tope mensual opcional; el operador sigue usando su plan de Claude para sus propios corredores. Todo sigue corriendo en el Mac del operador: llevarlo a internet es la fase siguiente (F8).

## 2. Alcance
- **Usuarios y sesiones** (ADR-0021): el operador es **administrador**; cada corredor tiene uno o más usuarios **de corredor**. Entran con correo y contraseña; la contraseña la elige cada uno desde un enlace de invitación que el operador le pasa. Sesiones en la base, cookie en el panel y token en la CLI. Sin correo saliente: los enlaces los copia el operador.
- **Cada corredor ve solo lo suyo** (ADR-0022): toda consulta de la API pasa por el alcance del usuario; lo de otro corredor responde "no existe" (404). Una tabla de permisos por ruta, revisada por un test, impide que una ruta nueva quede sin clasificar.
- **Lo que hace cada uno (D2, respuesta del operador):** el corredor carga, prepara, edita, aprueba, publica, programa y cierra sus propiedades, edita su marca y ve sus cuentas y su gasto. Solo el operador conecta cuentas de plataformas, activa la publicación automática, crea corredores, crea, restablece o desactiva usuarios, y fija topes.
- **Alta de un corredor:** crear el corredor (marca, colores, WhatsApp, tono, hashtags), subir el logo, invitar a su usuario, bajar **su planilla de Excel** con la hoja Corredor ya llena, y una lista de pasos del alta (qué falta para publicar en cada canal).
- **La IA por API** (seguimiento de ADR-0003, D3 y D4, respuestas del operador): el adaptador `anthropic-api` real; los corredores del operador ("propios") siguen con `LLM_PROVIDER` (su plan) y los demás usan siempre la API con la clave del operador. Cada preparación anota sus tokens y su costo estimado; el gasto del mes se ve por corredor y un **tope mensual opcional** frena la IA al llegar.
- **Marketplace "a mano" para los corredores** (ADR-0023, D5, respuesta del operador): el sistema deja el texto aprobado, el precio y las fotos listos; el corredor publica desde su teléfono o computador y pega el enlace (o marca "No lo publiqué"). El formulario automático en Chromium queda solo para los corredores propios del operador.
- **Instagram de un corredor (D6, respuesta del operador):** para el piloto, el corredor es evaluador (tester) de la app de Meta del operador y, en persona en el Mac del operador, inicia sesión en Generate token; el operador pega el token como hoy (§4.9, D16). La revisión de la app (App Review) queda para F8.
- **La bitácora dice quién:** cada evento hecho por una persona guarda su usuario, y el canal (panel o CLI) sale de la sesión (deuda de F3: se retira `X-AgentSales-Client`).
- **Deuda que se cierra aquí:** el filtro por corredor en el servidor de `/tracking` y `/agenda`, con una sola consulta de textos (`listCurrentMany`) y el `now` de la ruta en `publicationView` (F6); `GET /listings` con una proyección acotada (F1); quién conecta cada corredor y el `state` de Mercado Libre de un solo uso (F3/F4); `/health` con el detalle solo para el administrador (F6).
- API, CLI y panel para todo lo anterior.

## 3. Fuera de alcance
- **Llevar el sistema a internet** (F8): servidor, dominio con HTTPS, `NODE_ENV=production`, el panel servido sin Vite, subidas directas a R2 con URL prefirmada (deuda de F1), quitar `POST /imports/local`, respaldos fuera del Mac, el OAuth de Instagram con HTTPS, App Review de Meta, términos de uso y privacidad, el tope de `tokens.refresh` con muchas cuentas y el inicio del OAuth tras un prefijo (deuda de F3). Hasta entonces el corredor usa el sistema en el Mac del operador o en una demo; F7 deja listo el login y la separación para que F8 solo los exponga.
- **Correo saliente** (invitaciones, recuperar contraseña): el operador copia el enlace y se lo manda por donde quiera; si alguien olvida su contraseña, el operador genera un enlace nuevo.
- **Campos propios por corredor (D7, respuesta del operador):** todos usan los 36 campos de hoy. Antes de abrirlos hay que decidir qué campos ve la IA (deuda "F7, campos propios y la IA", que pasa a después del MVP).
- **Inicio de sesión con Google u otro proveedor externo**, doble factor y políticas de contraseña más allá del largo mínimo (ADR-0021: se evalúan con F8).
- **RLS de Postgres:** la separación vive en la API y los repositorios (ADR-0022); RLS se evalúa en F8 como segunda barrera.
- **Que el corredor conecte sus cuentas:** lo hace el operador (D2). El corredor ve el estado de sus cuentas.
- **Desactivar un corredor entero:** se desactivan sus usuarios; sus propiedades y publicaciones siguen como están.
- **Que el corredor cargue desde la CLI:** `agentsales import` usa `POST /imports/local` (solo administrador, en desarrollo); el corredor carga desde el panel. F8 cambia las subidas a R2.
- **Cobrar a los corredores** (planes, facturación): solo se anota el gasto de IA.
- **Bajar todas las fotos en un zip** para Marketplace a mano: el plan B de F5 abre cada foto para bajarla (un zip necesitaría una dependencia nueva).
- **La deuda de F6 que necesita la prueba en vivo de Portal** (D15 de F4: `relist` y la regla de `pictures`), el `auto_publish` cortado por el apagado y la pausa sin `byListing`: siguen en `docs/ESTADO.md`.

## 4. Diseño

### 4.1 Componentes
| Componente | Cambio |
|---|---|
| `packages/core` | `User`, roles (`admin`, `broker`), `AccessScope` y las reglas de permisos (`can(user, action, brokerId)`); casos de uso `login`, `logout`, `resolveSession`, `inviteUser`, `acceptInvitation`, `resetUserAccess`, `setUserDisabled` y `ensureAdmin` (el primer administrador, sin actor, para `pnpm auth:admin`, T05); `createBroker`, `updateBroker`, `setBrokerLogo`, `onboardingSteps`; el gasto de IA (`llmCostOf`, `monthlySpend`, `assertLlmBudget`) y la tabla de precios; la elección del proveedor por corredor (`llmProviderFor`); puertos `PasswordHasher`, `SecretTokens` (generar un token aleatorio y su SHA-256, inyectado como hoy `OAuthStateSigner`), `UserRepository`, `SessionRepository`, `InvitationRepository`, `OAuthStateRepository`; la regla de Marketplace a mano y del formulario automático solo para corredores propios (ADR-0023); códigos de error nuevos; dobles en `@agentsales/core/testing` |
| `packages/config` | `createPasswordHasher` (`scrypt`) y `createSecretTokens` (`randomBytes` y SHA-256), junto a `createSecretBox` y la firma del `state` que ya existen (la API no importa `node:crypto` en lo que entra en `AppType`) |
| `packages/db` | Migración `0009` (§4.12); repositorios de usuarios, sesiones, invitaciones y `state` usados; los repositorios existentes suman el filtro por corredor (§4.4); `pnpm auth:admin` (script del paquete) |
| `packages/llm` | `anthropic-api` real con `@anthropic-ai/sdk` (salida estructurada con `output_config.format`), sus errores y el uso de tokens |
| `packages/importers` | La planilla de Excel de un corredor (`writeBrokerTemplate`, con exceljs) |
| `apps/worker` | Dos proveedores de IA (el del operador y la API) elegidos por corredor; el tope antes de llamar; el uso anotado por llamada; la carga de un corredor nunca crea corredores; `eval:content` con la API |
| `apps/api` | Middleware de sesión (cookie o `Authorization: Bearer`), `/auth/*`, `/users`, `POST /brokers` y `PATCH /brokers/:id` ampliado, el logo, la planilla, `/usage`; el alcance en todas las rutas; la tabla de permisos por ruta; Origin en toda escritura con cookie; `/health` en dos niveles |
| `apps/cli` | `login`, `logout`, `whoami` y el token en `~/.agentsales/cli-session.json` (el `Bearer` en `api-client.ts`); `users`, `brokers create|edit|logo|template`, `usage`; `accounts connect marketplace --manual`; `listings` con la proyección |
| `apps/web` | Login, invitación, cerrar sesión, selector de corredor para el administrador; páginas **Corredores** (administrador) y **Mi marca** (corredor); el gasto de IA; Marketplace a mano como flujo principal del corredor |

### 4.2 Usuarios, sesiones e invitaciones (ADR-0021)
- **Roles:** `admin` (sin corredor; ve y opera todos) y `broker` (con `broker_id`; solo el suyo). Un corredor puede tener varios usuarios (por ejemplo, su asistente), todos con los mismos permisos.
- **Contraseña:** `scrypt` de `node:crypto` (sin dependencias nuevas), con sal propia, guardada como `scrypt$N$r$p$sal$hash`; mínimo 12 caracteres, máximo 128. Nunca se loguea ni se devuelve.
- **Entrar** (`POST /auth/login`): correo (sin distinguir mayúsculas) y contraseña. Un solo error para todo (`AUTH_INVALID`: no dice si el correo existe; con un correo que no existe igual se calcula un hash, para que el tiempo no lo delate). Tras 10 fallos seguidos, el usuario queda bloqueado 15 min (`AUTH_LOCKED`). Un usuario desactivado no entra.
- **Sesión:** un token aleatorio de 32 bytes (`SecretTokens`); la base guarda solo su SHA-256. Vence a los 30 días o tras 7 días sin uso (`last_seen_at` se actualiza como mucho una vez por minuto). El panel la recibe en la cookie `agentsales_session` (`HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` con HTTPS); la CLI la recibe en el cuerpo (`client: "cli"`) y la manda como `Authorization: Bearer`. Cada login crea una sesión nueva; cerrar sesión la borra; desactivar un usuario borra todas las suyas.
- **Invitación:** el administrador crea el usuario (correo, nombre, rol, corredor) y recibe **una vez** un enlace `<panel>/invitacion#<token>` (en el fragmento: no llega a los logs del servidor). Vence a las 72 h y sirve una vez. Al usarlo, el usuario elige su contraseña y queda con sesión. **Restablecer** genera un enlace nuevo, invalida el anterior, cierra todas las sesiones del usuario y quita su bloqueo. Hay a lo más una invitación vigente por usuario.
- **El primer administrador:** `pnpm auth:admin --email <correo>` (habla directo con la base, como `db:seed`) crea el administrador si no existe y deja su enlace de invitación en el portapapeles, sin imprimirlo. Si ya existe, genera un enlace de restablecer, quita el bloqueo, cierra sus sesiones y lo reactiva si estaba desactivado (así el operador nunca queda fuera).
- **Sin red:** si la base no responde, el login y cualquier ruta con sesión responden 503 `DB_UNAVAILABLE` (nunca 401: no se cierra la sesión por un corte).

### 4.3 La API con sesión
- **Middleware** antes de las rutas: lee la cookie o el `Bearer`, resuelve la sesión y pone el usuario y su alcance en el contexto. Sin sesión válida: 401 `AUTH_REQUIRED`.
- **Tabla de permisos por ruta** (`apps/api/src/access.ts`): cada método y ruta es `public` (`/health`, `/auth/login`, `/auth/invitations/accept` y la vuelta del OAuth de Instagram, `GET /oauth/instagram/callback`, que llega desde Instagram sin la cookie `Strict` y la protegen el `state` y su cookie `Lax`), `session` (cualquier usuario, con el alcance) o `admin` (`GET /oauth/instagram/start`, entre otras). Un test recorre las rutas de la app y falla si alguna no está en la tabla. **Hasta el lote C, las rutas de hoy son `admin`**; el lote C las abre al corredor con su alcance.
- **CSRF:** con cookie, toda escritura exige `Origin` igual al del panel (hoy solo se revisaban formularios y multipart); con `Bearer` no aplica. `hostGuard` sigue igual (F8 lo cambia).
- **`/health`:** sin sesión responde solo `status` y `publishMode`; el administrador ve el detalle de hoy (versión de Postgres, respaldo, `autoPublishBrokers`) más los avisos nuevos (falta `ANTHROPIC_API_KEY` habiendo corredores no propios), que `doctor` muestra. Un corredor ve lo básico. Si la sesión no se puede leer porque la base no responde, `/health` responde lo básico (nunca 503 por eso): `doctor`, `status` y el aviso del modo en el panel siguen funcionando.
- **Quién hizo qué:** `publication_events.user_id` guarda al usuario de la sesión; `actor` sigue diciendo el canal (`operator` = panel, `cli`, `system`) y sale de `sessions.client`. La bitácora muestra el nombre ("por Vinny, en el panel"). `X-AgentSales-Client` se retira (seguimiento de ADR-0011).

### 4.4 Cada corredor ve solo lo suyo (ADR-0022)
- **`AccessScope`** (core): `{ kind: "all" }` para el administrador y `{ kind: "broker", brokerId }` para un corredor.
- **Listas:** los repositorios reciben el alcance y filtran en SQL por `broker_id` (propiedades, cargas, cuentas, corredores, seguimiento y agenda). El administrador puede pedir un corredor con `?broker=<slug>` (es un filtro, no un permiso); un corredor que pide otro corredor recibe 404, como con un `slug` que no existe.
- **Por id:** cada ruta carga el recurso, sube hasta su corredor (contenido → propiedad, publicación → propiedad, corrida → propiedad, carga → `broker_id`, cuenta → `broker_id`, medio → propiedad o corredor) y, si está fuera del alcance, responde 404 con el mismo cuerpo que un id inexistente. Una carga con `broker_id` nulo (del administrador, antes de que el job lea la hoja Corredor) solo la ve el administrador.
- **Escrituras con varios ids** (`POST /schedule` con `listingIds`): si alguno está fuera del alcance, se rechaza todo con 404.
- **La carga de un corredor** (`POST /imports`): la API fija `broker_id` e `input.broker` al crearla (así la ve en cola). El job, si la hoja Corredor trae otro `slug`, falla con `BROKER_MISMATCH` sin tocar nada, y nunca crea un corredor para una carga de corredor; si es el suyo, actualiza su marca como hoy. La carga del administrador sigue igual.
- **Lo que es solo del administrador en las vistas compartidas:** el ítem del respaldo en la agenda y la lista completa de corredores.
- **`GET /listings`** devuelve una proyección acotada (sin notas internas ni dirección exacta); el detalle (`GET /listings/:id`) sigue completo dentro del alcance. Sus consumidores (`agentsales listings` y la página Propiedades) se ajustan en la misma tarea.
- **Tests:** una matriz que, para cada ruta con id, pide el recurso de otro corredor y espera 404, y para cada lista revisa que no aparezca nada ajeno.

### 4.5 Permisos (D2)
| Acción | Administrador | Corredor (lo suyo) |
|---|---|---|
| Ver, cargar, preparar, editar textos, aprobar, publicar, programar, cerrar, pausar, reabrir y archivar propiedades | ✓ | ✓ |
| Confirmar Marketplace ("Lo publiqué" o "No lo publiqué") | ✓ | ✓ |
| Editar su marca, subir su logo, bajar su planilla | ✓ | ✓ |
| Ver sus cuentas, su gasto de IA y su lista de alta | ✓ | ✓ |
| Conectar, renovar y desconectar cuentas; Marketplace a mano | ✓ | — |
| Publicación automática, tope de IA, "corredor propio" | ✓ | — |
| Crear corredores; crear, restablecer, desactivar y reactivar usuarios | ✓ | — |
| `/health` con detalle, `/imports/local` (desarrollo) | ✓ | — |

Lo que un corredor no puede hacer responde 403 `FORBIDDEN` (el recurso es suyo, la acción no). El panel no muestra esos botones.

### 4.6 Alta de un corredor
- **Crear** (`POST /brokers`, administrador): `slug`, nombre, marca, color primario (y secundario), WhatsApp, correo, Instagram, sitio, tono, hashtags fijos, si es **propio** del operador y el tope de IA. Las mismas reglas que la hoja Corredor (`parseBrokerSheet`). Un corredor que nace de la hoja Corredor de una carga queda **no propio** (usa la API de Anthropic): el panel de Corredores y la lista de alta lo muestran, y el operador lo marca propio si es suyo.
- **Editar** (`PATCH /brokers/:id`): el corredor edita su marca (nombre de marca, colores, WhatsApp, correo, Instagram, sitio, tono y hashtags); el administrador, además, `operatorOwned`, `llmMonthlyCapUsd` y `autoPublish` (hoy).
- **Logo** (`POST /brokers/:id/logo`, multipart): PNG, JPEG o WebP de hasta 5 MB (SVG no: puede llevar código). sharp lo normaliza a PNG, se sube a R2 como un medio del corredor y queda en `brokers.logo_media_id` (como la hoja Corredor hoy). Cambiar la marca no rehace lo preparado: el panel sugiere "Preparar de nuevo (solo imágenes)".
- **Su planilla** (`GET /brokers/:id/template.xlsx`): la plantilla de propiedades con los campos de hoy (encabezados, listas de opciones y ejemplos de `data/plantillas/`) y la hoja Corredor llena con sus datos. Al leerla de vuelta sin propiedades no da errores (test de ida y vuelta).
- **Lista de alta** (`onboardingSteps`, pura en core): marca y colores, logo, WhatsApp (Portal lo exige), usuario invitado y con contraseña, Instagram conectado, Mercado Libre conectado y Marketplace (a mano o automático). Cada paso con su estado y, si falta, quién lo hace.

### 4.7 La IA por corredor y su gasto (seguimiento de ADR-0003)
- **El proveedor de cada corredor** (`llmProviderFor`, core): un corredor **propio** (`brokers.operator_owned`) usa `LLM_PROVIDER` (hoy `claude-cli`, el plan del operador); los demás usan siempre `anthropic-api` (los términos del plan no permiten usarlo para terceros, ADR-0003). Con `LLM_PROVIDER=fake`, todos usan `fake` (desarrollo y pruebas). Sin `ANTHROPIC_API_KEY`, preparar los textos de un corredor no propio falla con `LLM_NOT_CONFIGURED` y un mensaje que lo explica; el detalle de `/health` lo avisa y `doctor` lo muestra.
- **`anthropic-api`:** `@anthropic-ai/sdk` con `output_config.format` (JSON Schema sin topes, como la CLI) y `effort: "low"`, el modelo de `ANTHROPIC_MODEL` (por defecto `claude-sonnet-5-5`, D15; `LLM_MODEL` sigue siendo solo de `claude-cli`), el `AbortSignal` y el tope de tiempo de hoy (§4.14). Errores: 401/403 → `LLM_AUTH_REQUIRED`; 429 con `retry-after` → `LLM_RATE_LIMITED` (reintentable, con la espera); el tope de gasto de la cuenta (429 `enforced_spend_limit_reached` o el 400 del límite propio) → `LLM_ACCOUNT_LIMIT` (no reintentable); 5xx, 529 y la conexión → `LLM_UNAVAILABLE` (reintentable); `stop_reason` `refusal` o `max_tokens` → `LLM_INVALID_OUTPUT` (la política de hoy: reintentar una vez). Ningún test llama a la API (msw).
- **Uso:** el puerto devuelve, además, `usage` (entrada sin caché, escritura y lectura de caché, salida, y el `request-id`). Cada corrida de contenido suma en `llm_usage` **cada llamada en cuanto vuelve** (también las que fallan después, como un `LLM_INVALID_OUTPUT` o un reintento del job): `provider`, `model`, los tokens, los `requestId`, `costUsd` estimado con la tabla de precios de core y su fecha. Con `claude-cli` el costo es 0 (plan del operador) y los tokens, si vienen.
- **Gasto del mes:** la suma de `costUsd` de las corridas del corredor (por `listings.broker_id`) **creadas** en el mes calendario de Chile (`monthlySpend`; el índice `content_runs_listing_created_idx` ya sirve). `GET /usage?month=AAAA-MM` lo da por corredor (el corredor ve el suyo). Es una **estimación**: la cifra oficial es la de la consola de Anthropic.
- **Tope mensual (D4):** `brokers.llm_monthly_cap_usd` (nulo = sin tope). Pedir una preparación con textos para un corredor que llegó al tope responde 409 `LLM_BUDGET_EXCEEDED`, y el worker lo vuelve a revisar antes de llamar (otra corrida pudo gastar entre medio): la corrida termina las imágenes y deja los textos sin hacer con ese código. Una sola llamada puede pasarse un poco del tope (se sabe el costo después); se documenta.

### 4.8 Marketplace a mano (D5, ADR-0023)
- **Cuenta a mano:** el administrador la activa para un corredor (`POST /accounts/marketplace/manual`): una `platform_account` de Marketplace con `external_account_id = "manual"`, sin credenciales ni perfil del navegador. `marketplaceAccountMetaSchema` pasa a una unión discriminada por `mode` (`"profile"`, la de F5, o `"manual"`). Se desactiva como cualquier cuenta. ADR-0023 registra el cambio respecto de ADR-0017 (punto 1).
- **El formulario automático solo para corredores propios:** la regla vive en core, así cubre conectar (`accounts connect marketplace`), `marketplace.profile` y `fb:smoke --listing`: para un corredor no propio responde 403 `MARKETPLACE_AUTOMATION_NOT_ALLOWED`; los no propios usan la cuenta a mano.
- **Publicar a mano:** core detecta la cuenta a mano y hace el traspaso **sin publisher** (el worker no llama a ninguno ni abre el navegador): la publicación pasa a `awaiting_manual_confirm` (en simulación y en vivo, con el modo anotado) con la nota "publícalo tú con el texto y las fotos listos". No aplican el límite diario, "un formulario a la vez" (`requireManualCapacity`) ni el candado del perfil: el corredor puede tener varios avisos esperando. El panel muestra el plan B de F5 como flujo principal (copiar título, descripción y precio, abrir cada foto) y "Lo publiqué" (pegar el enlace) o "No lo publiqué".
- **Calendario:** igual que hoy, Marketplace programado es un recordatorio ("te toca").

### 4.9 Instagram de un corredor (D6 y D16)
El operador agrega al corredor como evaluador (Instagram Tester) de su app de Meta y el corredor acepta la invitación en Instagram. Después, **en persona y en el Mac del operador**, el corredor inicia sesión en la ventana de **Generate token** del panel de Meta y el operador pega el token como hoy (`accounts connect instagram --broker <slug> --token-stdin`). Antes de publicar en vivo, `pnpm ig:smoke --broker <slug>` confirma que Meta acepta la cuenta del evaluador (NO VERIFICADO en la doc, §4.14). Pasos en `docs/07-checklist-cuentas.md`. El OAuth y App Review quedan para F8. Con varias cuentas, el refresco diario de tokens sigue igual (la deuda del tope de `tokens.refresh` es de F8).

### 4.10 La CLI con sesión
- `agentsales login --email <correo>` pide la contraseña sin mostrarla (necesita una terminal: lo corre el operador) y guarda el token en `~/.agentsales/cli-session.json` (`0600`, fuera del proyecto). `logout` borra la sesión en la API y el archivo; `whoami` muestra el usuario, el rol y el corredor.
- Todos los comandos mandan el token. Sin sesión o vencida: "Inicia sesión: `agentsales login`" (código de salida 1).
- `users list|invite|reset|disable|enable` (administrador): el enlace va al portapapeles, nunca a la pantalla. `brokers create|edit|logo|template`, `usage [--month]`, `accounts connect marketplace --broker <slug> --manual`.
- Claude usa la sesión que el operador abrió en la CLI y **nunca lee** `~/.agentsales/cli-session.json` (regla nueva en `CLAUDE.md`).

### 4.11 El panel con sesión
- **Login** (`/entrar`) y **invitación** (`/invitacion#…`: elegir contraseña). Cualquier 401 lleva a `/entrar` y vuelve a la página donde estaba. Menú con el usuario y "Cerrar sesión".
- **Administrador:** selector de corredor ("Todos" o uno) que filtra las listas, Seguimiento y Cuentas; página **Corredores** (lista con su alta, crear, editar, usuarios con invitar, restablecer y desactivar —el enlace se muestra una vez, con botón de copiar—, tope de IA, propio y gasto del mes).
- **Corredor:** no ve el selector ni Corredores; ve **Mi marca** (editar la marca, subir el logo, bajar su planilla, su gasto del mes y su lista de alta). Los botones que no puede usar no aparecen (§4.5).
- **Marketplace a mano:** en la pestaña Marketplace, con cuenta a mano, "Publicar" deja el aviso listo y muestra el plan B y la confirmación.

### 4.12 Datos (migración `0009`)
- **Enums nuevos** (valores desde core): `user_role` (`admin`, `broker`), `session_client` (`panel`, `cli`), `invitation_purpose` (`invite`, `reset`).
- **`users`:** `id`, `email` (único, `CHECK (email = lower(email))`), `name`, `role`, `broker_id` (FK, nulo para `admin`; `CHECK` de que `role = 'admin'` si y solo si es nulo), `password_hash` (nulo hasta aceptar la invitación), `failed_logins NOT NULL DEFAULT 0`, `locked_until`, `disabled_at`, `last_login_at`, marcas de tiempo; índice por `broker_id`.
- **`sessions`:** `id`, `token_hash` (único), `user_id` (FK con borrado en cascada, indexado), `client`, `expires_at`, `last_seen_at`, `created_at`. Las vencidas se borran en la vigilancia de cada hora.
- **`invitations`:** `id`, `user_id` (FK con borrado en cascada, indexado), `token_hash` (único), `purpose`, `expires_at`, `used_at`, `created_by`, `created_at`; único parcial por `user_id` con `used_at IS NULL` (una vigente por usuario: la nueva reemplaza a la anterior en la misma transacción).
- **`oauth_states_used`:** `nonce_hash` (PK) y `expires_at`: el `state` de Mercado Libre sirve una vez.
- **`brokers`:** `operator_owned boolean NOT NULL DEFAULT false` (la migración marca `true` los corredores que ya existen: todos son del operador) y `llm_monthly_cap_usd numeric(10,2)` nulo.
- **`content_runs`:** `llm_usage jsonb` nulo (`llmUsageSchema` en core), sumado por llamada (`ContentRunRepository.addLlmUsage`, atómico).
- **`publication_events`:** `user_id` (FK, nulo: lo del sistema y lo anterior a F7).
- Sin seeds nuevos: el administrador lo crea `pnpm auth:admin`.

### 4.13 Contratos (API, ADR-0011)
| Ruta | Quién | Cuerpo | Respuesta |
|---|---|---|---|
| `POST /auth/login` | público | `{ email, password, client? }` | 200 `{ user }` + cookie, o `{ user, token }` con `client: "cli"`; 401 `AUTH_INVALID`, 423 `AUTH_LOCKED` |
| `POST /auth/logout` | público (idempotente: con una sesión vencida igual borra la cookie) | — | 204 |
| `GET /auth/me` | sesión | — | `{ user: { id, email, name, role, broker } }` |
| `POST /auth/invitations/accept` | público | `{ token, password }` | 200 `{ user }` + cookie; 410 `INVITATION_INVALID` (vencida, usada o inexistente) |
| `GET /users` · `POST /users` | admin | `{ email, name, role, brokerId? }` | `{ users }` · 201 `{ user, invitationUrl, expiresAt }` |
| `POST /users/:id/reset` · `/disable` · `/enable` | admin | — | `reset`: `{ user, invitationUrl, expiresAt }`; los otros: `{ user }` |
| `POST /brokers` · `PATCH /brokers/:id` | admin · sesión (§4.6) | campos del corredor | `{ broker, onboarding }` |
| `GET /brokers` · `GET /brokers/:id` | sesión | — | con el alcance; `onboarding` en el detalle |
| `POST /brokers/:id/logo` | sesión | multipart `logo` | `{ broker }`; 415 `LOGO_INVALID`, 413 |
| `GET /brokers/:id/template.xlsx` | sesión | — | el archivo |
| `GET /usage?month=` | sesión | — | `{ month, brokers: [{ brokerId, slug, spentUsd, capUsd, runs }] }` |
| `POST /accounts/marketplace/manual` | admin | `{ broker }` | 201 `{ account }` |

Errores nuevos: `ORIGIN_NOT_ALLOWED` (403), `USER_NOT_ADMIN` (409, `auth:admin` con el correo de un corredor), `LLM_ACCOUNT_LIMIT` (en la corrida), `USER_INVALID` (400), `PASSWORD_TOO_LONG` (400), `BROKER_SETTINGS_INVALID` (400), `USER_NOT_FOUND` (404), `USER_SELF_DISABLE` (409), `INVITATION_CONFLICT` (409, reintentable), `USER_ROW_INVALID` (500), `AUTH_REQUIRED` (401), `AUTH_INVALID` (401), `AUTH_LOCKED` (423), `FORBIDDEN` (403), `INVITATION_INVALID` (410), `PASSWORD_TOO_SHORT` (400), `USER_EMAIL_TAKEN` (409), `BROKER_SLUG_TAKEN` (409), `BROKER_MISMATCH` (409), `LOGO_INVALID` (415), `LLM_BUDGET_EXCEEDED` (409), `MARKETPLACE_AUTOMATION_NOT_ALLOWED` (403), `OAUTH_STATE_USED` (400). Las rutas de hoy no cambian de forma, salvo `GET /listings` (proyección) y `/health` (dos niveles).

### 4.14 Lo que se verificó afuera (2026-10-16)
Notas del subagente `integraciones` (`docs/integraciones/anthropic-api.md` §11 e `instagram.md` §12), sin llamadas con credenciales:
- **SDK:** `@anthropic-ai/sdk` **0.134.0** (0.135.0 salió el 2026-10-15 y queda en el borde de la antigüedad mínima de pnpm; no se agrega excepción). zod 4 es compatible, pero el adaptador no lo necesita: el puerto ya entrega JSON Schema, así que usa `output_config: { format: { type: "json_schema", schema } }`. Se crea con `openTelemetry: false`. TypeScript 7 no está nombrado en la doc: lo prueba `pnpm typecheck` en T11.
- **Modelos y precios (USD por millón de tokens, entrada / salida / lectura de caché):** `claude-sonnet-5-5` 2 / 10 / 0,10 (por defecto, D15); `claude-haiku-5-5` 0,10 / 0,50 / 0,01 hasta 100.000 tokens de prompt y 0,50 / 2,50 sobre eso; `claude-opus-5-5` 4 / 20 / 0,20; `claude-fable-5-1` 10 / 50 / 0,25. Escritura de caché: 1,25 veces la entrada. Un aviso con 10 fotos cuesta cerca de US$ 0,05 con Sonnet 5.5 y 0,003 con Haiku 5.5 (INFERENCIA). Todos aceptan salida estructurada. Sonnet 5.5 no acepta `thinking: disabled`: el adaptador no manda `thinking` y fija `output_config.effort: "low"` (un texto corto; su efecto en la calidad se mide en el cierre).
- **Uso:** `input_tokens`, `output_tokens`, `cache_creation_input_tokens` y `cache_read_input_tokens` (la entrada total es la suma de los tres de entrada) y el `request-id`.
- **Errores:** 429 con `retry-after` es un límite de tasa (reintentable); 429 con `error.details.error_code = "enforced_spend_limit_reached"` (tope del nivel) y 400 "You have reached your specified API usage limits" (el límite que el operador fija en la consola) **no se arreglan esperando**: `LLM_ACCOUNT_LIMIT`, no reintentable, con el mensaje para revisar la consola. 401 también por una clave vencida (las claves de la consola pueden vencer: el checklist pide crearla sin vencimiento o anotar la fecha).
- **Gasto por corredor:** la forma oficial son workspaces (exige una organización en la consola); el operador eligió el registro propio en la base (D14).
- **Instagram:** en modo desarrollo la app sirve a cuentas con rol en ella; que publique en la cuenta de un tercero con rol de evaluador es **NO VERIFICADO** (se prueba con `pnpm ig:smoke` sobre su cuenta). El rol "Instagram Tester" se agrega en Roles de la app y el corredor lo acepta en Instagram (Editar perfil → Apps y sitios web → Invitaciones de evaluador). **Generate token pide iniciar sesión en esa cuenta de Instagram:** el operador no puede sacarlo por el corredor (D16). App Review (video por permiso, política de privacidad, verificación del negocio) es de F8.

### 4.15 Decisiones
Respondidas por el operador el 2026-10-16:
- **D1 · F7 se parte en dos:** F7 deja varios corredores con login y la IA por API, en el Mac del operador (`v0.7.0`); F8 lo lleva a internet (`v1.0.0`). El roadmap se actualiza en este spec.
- **D2 · Permisos:** el corredor hace casi todo con lo suyo; el operador, lo sensible (§4.5).
- **D3 · La clave de la IA es del operador,** con el gasto anotado por corredor; el operador sigue con su plan para sus corredores propios.
- **D4 · Tope mensual de IA opcional** por corredor, sin tope por defecto.
- **D5 · Marketplace a mano para los corredores;** el formulario automático, solo para los propios.
- **D6 · Instagram:** el corredor como evaluador de la app; App Review en F8.
- **D7 · Sin campos propios por corredor** en F7.
- **D14 · El gasto por corredor es un registro propio en la base** (no un workspace de Anthropic por corredor), con una sola clave y el límite de gasto total en la consola.
- **D15 · Modelo por defecto `claude-sonnet-5-5`;** en el cierre se compara `claude-haiku-5-5` con `pnpm eval:content` y, si escribe igual de bien, se cambia con `ANTHROPIC_MODEL`.
- **D16 · Instagram del corredor en persona:** inicia sesión en Generate token en el Mac del operador; el OAuth llega en F8.

Decididas por Claude con la aprobación permanente:
- **D8 · Autenticación propia** con `scrypt`, sesiones en la base y enlaces de invitación (ADR-0021): sin dependencias nuevas ni un servicio externo que conozca a los usuarios; Lucia está descontinuada y un proveedor como Clerk o Auth0 exige internet y otra cuenta.
- **D9 · La separación vive en la API y los repositorios** (ADR-0022), con 404 para lo ajeno y la tabla de permisos revisada por un test; RLS se evalúa en F8.
- **D10 · Los enlaces en el fragmento de la URL y al portapapeles en la CLI:** nunca en logs ni en pantalla.
- **D11 · La cookie con `SameSite=Strict`** más `Origin` en toda escritura; la CLI con `Bearer`.
- **D12 · Lo existente es del operador:** los corredores de hoy quedan como propios y sus eventos sin usuario.
- **D13 · El costo es una estimación** con una tabla de precios fechada en core; manda la consola de Anthropic.
- **D17 · `main` usable en cada lote:** el lote B trae junto con la sesión de la API el login mínimo de la CLI y del panel, y el arnés de pruebas usa por defecto una sesión de administrador.
- **D18 · Marketplace a mano sin publisher** (ADR-0023): es un traspaso de estado en core, no una plataforma nueva ni un publisher que no hace nada.

### 4.16 ADRs
- **Nuevos:** ADR-0021 (autenticación propia: `scrypt`, sesiones en la base, invitaciones, cookie y `Bearer`), ADR-0022 (separación por corredor: alcance en la API y los repositorios, 404 para lo ajeno, la tabla de permisos, las cargas con `broker_id` nulo y la clasificación de `/oauth/*`; RLS evaluado para F8) y ADR-0023 (Marketplace a mano y el formulario automático solo para corredores propios). Registrados con la aprobación del spec (2026-10-16).
- **Seguimientos:** ADR-0003 (proveedor por corredor, `usage` en el puerto, `ANTHROPIC_MODEL`), ADR-0005 (las subidas a R2 y quitar `/imports/local` pasan a F8), ADR-0011 (contratos de autenticación y el retiro de `X-AgentSales-Client`) y ADR-0017 (remite a ADR-0023).

### 4.17 Dependencias nuevas
- **`@anthropic-ai/sdk` 0.134.0** (en `packages/llm`): el SDK oficial que ADR-0003 ya preveía, con la antigüedad mínima de pnpm (§4.14).
- Ninguna más: `scrypt` y los tokens usan `node:crypto`; la planilla, exceljs; el logo, sharp.

## 5. Tareas
Lotes (desde 2026-10-09, una rama y un PR por lote). Cada lote deja `main` usable (D17):
- **A** · datos y core: T01–T03
- **B** · entrar: T04–T07 (API, usuarios, CLI y panel; al terminar, el operador entra y todo lo de hoy funciona con su sesión)
- **C** · cada corredor lo suyo: T08–T10 (abre las rutas al corredor)
- **D** · la IA por API: T11–T12
- **E** · alta de corredores: T13–T14
- **F** · Marketplace a mano: T15
- **G** · CLI: T16
- **H** · panel: T17–T18
- T19: cierre

### F7-T01 · Datos nuevos: usuarios, sesiones, invitaciones y `state` usados
- **Depende de:** —
- **Archivos:** `packages/db/src/schema.ts`, `packages/db/drizzle/0009_*.sql`, `packages/db/src/repositories/users.ts` (los cuatro repositorios), `packages/db/test/users.{contract,test}.ts`, `packages/core/src/{ports/,testing/}`, `docs/02-modelo-datos.md`
- **Descripción:** la migración `0009` completa (§4.12, también las columnas de las tablas de hoy) y los repositorios nuevos con sus contratos y dobles.
- **Hecho cuando:**
  - [x] Tests de contrato (PGlite y dobles): correo único y en minúsculas, el `CHECK` de rol y corredor, la sesión por hash y su borrado en cascada, una invitación vigente por usuario, el `state` usado dos veces, los corredores existentes quedan propios
  - [x] `docs/02-modelo-datos.md` al día

### F7-T02 · Las tablas de hoy: corredores, corridas, eventos y el alcance en SQL
- **Depende de:** T01
- **Archivos:** `packages/db/src/repositories/{brokers,content-runs,publications,listings,import-runs,platform-accounts,contents}.ts`, `packages/core/src/{access.ts,ports/}`, `packages/core/src/testing/`
- **Descripción:** `AccessScope` en core; `BrokerRepository` con `operatorOwned` y `llmMonthlyCapUsd`; `ContentRunRepository.addLlmUsage` (atómico) y la suma del mes por corredor; `publication_events.user_id`; el filtro por alcance en SQL en las listas (propiedades, cargas, cuentas, corredores, seguimiento) y `listCurrentMany` (deuda de F6).
- **Hecho cuando:**
  - [x] Tests de contrato: cada lista con dos corredores devuelve solo lo del alcance; `addLlmUsage` concurrente no pierde una suma; la suma del mes en el borde del mes de Chile; `listCurrentMany` igual a N consultas de una

### F7-T03 · Usuarios, sesiones y permisos (core y config)
- **Depende de:** T01
- **Archivos:** `packages/core/src/{user.ts,permissions.ts,ports/auth.ts,use-cases/auth/{sessions,users}.ts}`, `packages/core/src/testing/auth.ts`, `packages/config/src/{password.ts,secret-tokens.ts}`
- **Descripción:** `User`, roles y `can` (§4.5); los casos de uso de §4.2; `PasswordHasher` (`scrypt`) y `SecretTokens` en config detrás de sus puertos.
- **Hecho cuando:**
  - [x] Tests: entrar bien y mal (el mismo error y un hash calculado con un correo inexistente), el bloqueo a los 10 fallos y su fin, usuario desactivado (y sus sesiones borradas), sesión vencida e inactiva, `last_seen_at` a lo más por minuto, invitación vencida, usada o reemplazada, restablecer cierra las sesiones y quita el bloqueo, contraseña corta, cada fila de §4.5 en `can`
  - [x] `scrypt` con sal distinta por hash y comparación en tiempo constante; ningún secreto en errores ni logs

### F7-T04 · La API con sesión
- **Depende de:** T02, T03
- **Archivos:** `apps/api/src/{access.ts,auth.ts,security.ts,app.ts,errors.ts,user-view.ts}`, `apps/api/src/routes/auth.ts`, `apps/api/src/contracts/index.ts`, `apps/api/src/testing/` (`testDeps` con sesión de administrador por defecto), `docs/01-arquitectura.md` (Seguridad)
- **Descripción:** el middleware (cookie o `Bearer`), `/auth/*`, la tabla de permisos con su test de inventario (las rutas de hoy como `admin`, el OAuth como en §4.3), `Origin` en toda escritura con cookie.
- **Hecho cuando:**
  - [x] Tests: sin sesión 401 en cada ruta `session` y `admin`; un corredor en una `admin` 403; la cookie con sus atributos; el `Bearer`; `Origin` ajeno 403 (con cookie o con `Bearer`: un `Origin` ajeno nunca es de la CLI) y la cookie sin `Origin` 403, mientras el `Bearer` sin `Origin` pasa; el inventario falla con una ruta sin clasificar; la vuelta de Instagram sigue funcionando sin la cookie de sesión; la base caída da 503, no 401
  - [x] Los tests de rutas de hoy pasan con la sesión de administrador del arnés

### F7-T05 · Usuarios, `/health` y el primer administrador
- **Depende de:** T04
- **Archivos:** `apps/api/src/routes/users.ts`, `apps/api/src/app.ts` (`/health`), `packages/core/src/use-cases/auth/users.ts` (`ensureAdmin`), `packages/db/src/{auth-admin.ts,scripts/auth-admin.ts}`, `packages/config/src/clipboard.ts`, `package.json` (`auth:admin`), `CLAUDE.md` (comando)
- **Descripción:** `/users` (crear con su enlace, restablecer, desactivar y reactivar), `/health` en dos niveles y tolerante (§4.3) y `pnpm auth:admin` sobre `ensureAdmin` (core: crea el administrador si no existe o le genera un enlace de restablecer, sin actor).
- **Hecho cuando:**
  - [x] Tests: el enlace se entrega una vez y en el fragmento; `USER_EMAIL_TAKEN`; `/health` sin sesión sin detalle, con la base caída lo básico; `auth:admin` crea o restablece y deja el enlace en el portapapeles (doble) sin imprimirlo

### F7-T06 · CLI: entrar
- **Depende de:** T04
- **Archivos:** `apps/cli/src/{session.ts,api-client.ts,context.ts,output.ts}`, `apps/cli/src/commands/login.ts` (`login`, `logout` y `whoami`), `apps/cli/test/`, `CLAUDE.md` (comandos y la regla de no leer el archivo de sesión)
- **Descripción:** §4.10 en lo mínimo: `login`, `logout`, `whoami`, el archivo de sesión y el `Bearer` en todas las llamadas; el mensaje sin sesión.
- **Hecho cuando:**
  - [x] Tests: `login` guarda el archivo con `0600` fuera del proyecto y sin imprimir el token, `logout` lo borra, sin sesión o vencida el mensaje y el código de salida 1; los comandos de hoy pasan contra la API en proceso con una sesión

### F7-T07 · Panel: entrar e invitación
- **Depende de:** T05
- **Archivos:** `apps/web/src/pages/{LoginPage,InvitationPage}.tsx`, `apps/web/src/{api/client.ts,api/session-events.ts,routes.tsx,layout/Layout.tsx}`, `apps/web/src/queries/auth.ts`, `apps/web/test/harness.tsx`
- **Descripción:** `/entrar`, `/invitacion#…`, cualquier 401 lleva a `/entrar` y vuelve, el menú con el usuario y "Cerrar sesión".
- **Hecho cuando:**
  - [x] Tests: entrar mal y bien, la invitación vencida, un 401 a mitad lleva a entrar y vuelve a la página; los tests de hoy pasan con la sesión de administrador del arnés

### F7-T08 · Cada corredor lo suyo: propiedades, contenido y cargas
- **Depende de:** T07
- **Archivos:** `apps/api/src/routes/{listings,content,imports}.ts`, `apps/api/src/access.ts`, `packages/core/src/use-cases/import-listings.ts`, `apps/worker/src/worker.ts` (la carga), `apps/api/src/contracts/index.ts`, `apps/cli/src/commands/listings.ts`, `apps/web/src/pages/ListingsPage.tsx`
- **Descripción:** §4.4 en propiedades, medios, contenido, corridas y cargas (la API fija el corredor de la carga; el job revisa `BROKER_MISMATCH` y no crea corredores); `GET /listings` con la proyección y sus consumidores; estas rutas pasan a `session`. Al empezar, el `scope` de las listas de los repositorios pasa a **obligatorio** (revisión del lote A): `tsc` señala cada llamada y el worker pasa `ALL_SCOPE`.
- **Hecho cuando:**
  - [ ] La matriz de §4.4 para estas rutas (lo ajeno da 404 con el mismo cuerpo; las listas sin nada ajeno; `?broker` del administrador y el ajeno del corredor)
  - [ ] La carga del corredor se ve en cola; con la hoja de otro `slug` falla sin tocar nada ni crear un corredor; con la suya actualiza la marca
  - [ ] La proyección sin notas internas ni dirección exacta; `agentsales listings` y Propiedades igual que antes

### F7-T09 · Cada corredor lo suyo: publicaciones, programar y seguimiento
- **Depende de:** T08
- **Archivos:** `apps/api/src/routes/{publications,schedule,tracking,publication-views}.ts`, `apps/api/src/access.ts`
- **Descripción:** §4.4 en publicaciones, programar (todo o nada), Seguimiento y agenda (con `listCurrentMany`, el `now` de la ruta en `publicationView` y lo que es solo del administrador). Las consultas de la agenda que hoy no reciben alcance (`listByStatus`, `listDue`) lo suman, filtrando en SQL.
- **Hecho cuando:**
  - [ ] La matriz para estas rutas; programar con un id ajeno rechaza todo; Seguimiento y agenda sin nada ajeno, sin el respaldo para el corredor y con una consulta de textos

### F7-T10 · Cuentas, el `state` y quién hizo qué
- **Depende de:** T09
- **Archivos:** `apps/api/src/routes/{accounts,oauth,brokers}.ts`, `apps/api/src/routes/publication-views.ts` (`actorOf`), `packages/core/src/labels.ts` (la bitácora), `apps/cli/src/commands/publication-view.ts`, `apps/web/src/components/publications/PublicationEvents.tsx`, `docs/01-arquitectura.md` (actor)
- **Descripción:** el corredor ve sus cuentas y su corredor; conectar, renovar y desconectar es del administrador; el `state` de Mercado Libre de un solo uso; `user_id` y el canal desde la sesión en cada evento, y la bitácora con el nombre; se retira `X-AgentSales-Client`.
- **Hecho cuando:**
  - [ ] Tests: el corredor conectando recibe 403; el mismo `state` de Mercado Libre dos veces da `OAUTH_STATE_USED`; un evento desde el panel y otro desde la CLI guardan al usuario y su canal; la bitácora muestra el nombre en la CLI y el panel

### F7-T11 · `anthropic-api` real
- **Depende de:** —
- **Archivos:** `packages/llm/src/{anthropic-api.ts,index.ts}`, `packages/llm/package.json`, `packages/llm/src/scripts/smoke.ts`, `packages/core/src/ports/llm-provider.ts`, `packages/config/src/env.ts` (`ANTHROPIC_MODEL`), `apps/worker/src/scripts/eval-content.ts`, `docs/integraciones/anthropic-api.md`
- **Descripción:** el adaptador (§4.7 y §4.14) y `usage` en el resultado del puerto (también en `claude-cli` si viene); `pnpm llm:smoke --provider anthropic-api` y `pnpm eval:content --provider anthropic-api --model <id>` (los corre el operador: gastan).
- **Hecho cuando:**
  - [ ] Tests con msw: respuesta válida con su uso y `request-id`, 401, 429 con `retry-after`, 429 `enforced_spend_limit_reached`, el 400 del límite propio, 529, corte de conexión, `refusal`, `max_tokens`, el `AbortSignal` y el tope de tiempo; la guardia de vitest impide una llamada real
  - [ ] `pnpm typecheck` con el SDK 0.134.0 y `pnpm-workspace.yaml` sin `minimumReleaseAgeExclude`

### F7-T12 · La IA por corredor y su gasto
- **Depende de:** T02, T04, T11
- **Archivos:** `packages/core/src/{llm-usage.ts,use-cases/prepare-content.ts,use-cases/request-content-run.ts}`, `apps/worker/src/{llm-options.ts,worker.ts,jobs/content-prepare.ts}`, `apps/api/src/routes/{content,usage}.ts`, `apps/api/src/health.ts`
- **Descripción:** `llmProviderFor` y los dos proveedores en el worker; `addLlmUsage` por llamada con el costo de la tabla; `monthlySpend` y el tope (409 al pedir y el worker antes de cada llamada); `GET /usage`; el aviso de la clave faltante en `/health`.
- **Hecho cuando:**
  - [ ] Tests: el propio usa `LLM_PROVIDER` y el no propio la API, `fake` para todos, sin clave falla claro; el costo de cada modelo de la tabla (y los dos tramos de Haiku 5.5); una corrida que falla después de gastar queda anotada; el tope al pedir y en el worker (las imágenes se hacen, los textos no); `/usage` con el alcance

### F7-T13 · Corredores: crear, editar y lista de alta
- **Depende de:** T10
- **Archivos:** `packages/core/src/{broker.ts,onboarding.ts,use-cases/{create-broker,update-broker}.ts}`, `apps/api/src/routes/brokers.ts`
- **Descripción:** §4.6 sin el logo ni la planilla: crear, editar con los campos de cada rol y `onboardingSteps`.
- **Hecho cuando:**
  - [ ] Tests: `slug` repetido, colores inválidos, el corredor no puede tocar `operatorOwned`, `llmMonthlyCapUsd` ni `autoPublish` (403), cada paso de la lista de alta

### F7-T14 · Logo y planilla de Excel de un corredor
- **Depende de:** T13
- **Archivos:** `packages/core/src/use-cases/set-broker-logo.ts`, `packages/importers/src/template-writer.ts`, `apps/api/src/routes/brokers.ts`
- **Descripción:** el logo (sharp, R2, medio) y `writeBrokerTemplate` con `GET /brokers/:id/template.xlsx` (§4.6).
- **Hecho cuando:**
  - [ ] Tests: logo SVG o de 6 MB rechazado, el logo queda en R2 (doble) y en el corredor
  - [ ] Ida y vuelta: la planilla generada, leída con `readListingsWorkbook`, da el corredor y cero errores; con una fila de ejemplo llena, una propiedad válida; encabezados y listas como `data/plantillas/`

### F7-T15 · Marketplace a mano (ADR-0023)
- **Depende de:** T10
- **Archivos:** `packages/core/src/{marketplace.ts,use-cases/publish-publication.ts,use-cases/connect-account.ts}`, `apps/worker/src/{worker.ts,jobs/marketplace-profile.ts}`, `apps/api/src/routes/accounts.ts`, `packages/publishers/src/marketplace/` (solo el `meta` como unión), `docs/adr/0023-*.md`, `docs/02-modelo-datos.md`
- **Descripción:** §4.8: la cuenta a mano, el traspaso en core sin publisher y la regla del formulario automático solo para los propios (conectar, `marketplace.profile` y `fb:smoke --listing`).
- **Hecho cuando:**
  - [ ] Tests: publicar con cuenta a mano llega a `awaiting_manual_confirm` sin llamar a un publisher (en simulación y en vivo), sin límite diario y con varios avisos esperando; confirmar y "No lo publiqué" como en F5; conectar, `marketplace.profile` y `fb:smoke --listing` para un no propio dan `MARKETPLACE_AUTOMATION_NOT_ALLOWED`

### F7-T16 · CLI: usuarios, corredores, gasto y Marketplace a mano
- **Depende de:** T06, T12, T14, T15
- **Archivos:** `apps/cli/src/commands/{users,brokers,usage,accounts}.ts`, `CLAUDE.md`, `README.md`
- **Descripción:** el resto de §4.10.
- **Hecho cuando:**
  - [ ] Tests contra la API en proceso: el enlace de `users invite` y `reset` va al portapapeles (doble) y no a la salida; `brokers create|edit|logo|template`, `usage` y `accounts connect marketplace --manual`; un corredor recibe el mensaje de "solo el administrador"

### F7-T17 · Panel: el alcance
- **Depende de:** T07, T10
- **Archivos:** `apps/web/src/components/BrokerSelector.tsx`, `apps/web/src/{layout/Layout.tsx,queries/auth.ts}`, las páginas que esconden acciones (§4.5)
- **Descripción:** el selector de corredor del administrador y lo que el corredor no ve (§4.11).
- **Hecho cuando:**
  - [ ] Tests: el corredor no ve el selector, Corredores ni los botones de §4.5; el selector filtra Propiedades, Seguimiento y Cuentas

### F7-T18 · Panel: Corredores, Mi marca, gasto y Marketplace a mano
- **Depende de:** T12, T14, T15, T17
- **Archivos:** `apps/web/src/pages/{BrokersPage,BrokerPage,MyBrandPage}.tsx`, `apps/web/src/components/content/MarketplacePanel.tsx`, `apps/web/src/queries/{brokers,users,usage}.ts`, `docs/08-guia-operador.md`, `docs/07-checklist-cuentas.md`
- **Descripción:** §4.11: Corredores (crear, editar, usuarios con el enlace una vez, tope, propio, gasto y lista de alta), Mi marca (marca, logo, planilla, gasto y lista de alta) y Marketplace a mano; la guía del alta de un corredor de punta a punta, los pasos del evaluador de Meta (D16) y los de la clave de Anthropic (sin vencimiento o con la fecha anotada, y el límite de gasto en la consola).
- **Hecho cuando:**
  - [ ] Tests: crear un corredor e invitar (el enlace se ve una vez y se copia), restablecer, desactivar; Mi marca guarda y sube el logo; el gasto y el tope; Marketplace a mano muestra el plan B y confirma

### F7-T19 · Cierre de fase
- **Depende de:** todas
- **Descripción:** `/fase-cerrar 7`: preparar la demo (paso 2 del skill), criterios, demo, la comparación de `claude-haiku-5-5` con `claude-sonnet-5-5` en `pnpm eval:content` (la corre el operador: gasta; D15), auditoría del `arquitecto`, CHANGELOG `[0.7.0]` y tag `v0.7.0` con permiso.

## 6. Criterios de aceptación de la fase
- [ ] El operador crea su usuario con `pnpm auth:admin`, entra al panel y a la CLI, y todo lo de F6 sigue funcionando con su sesión.
- [ ] El operador da de alta un corredor nuevo (marca, logo, WhatsApp), le crea un usuario y el corredor elige su contraseña con el enlace (demo, en otra ventana del navegador).
- [ ] El corredor baja su planilla, la llena, carga dos propiedades, las prepara con la IA por API, aprueba y publica en simulación en Instagram, y publica Marketplace a mano con "No lo publiqué" (demo).
- [ ] El corredor no ve nada de otro corredor: ni en las listas, ni en Seguimiento, ni abriendo el enlace de una propiedad ajena ("no existe"), ni en la CLI (tests de la matriz y demo).
- [ ] El corredor no puede conectar cuentas, activar la publicación automática, crear usuarios ni cambiar su tope (tests y demo: los botones no aparecen y la API responde 403).
- [ ] El gasto de IA del corredor aparece en el panel y en `agentsales usage`; con un tope bajo, preparar los textos se detiene con un mensaje claro (demo).
- [ ] Los corredores propios del operador siguen usando su plan de Claude (`claude-cli`) y el formulario automático de Marketplace (tests).
- [ ] La bitácora dice qué persona hizo cada cosa (demo).
- [ ] Ningún test llama a Instagram, Mercado Libre, Facebook, Anthropic ni al Banco Central, ni ejecuta la CLI de Claude; `pnpm check` y la CI de GitHub en verde.

## 7. Plan de demo
1. **Operador, antes:** crear una clave de la API de Anthropic con un límite de gasto en la consola, ponerla en `.env` (`ANTHROPIC_API_KEY`) y correr `pnpm llm:smoke --provider anthropic-api` (gasta centavos). Opcional para Instagram: agregar como evaluador una segunda cuenta de Instagram suya (pasos en `docs/07-checklist-cuentas.md`).
2. **Operador:** `pnpm auth:admin --email <su correo>`, abrir el enlace del portapapeles, elegir la contraseña; `agentsales login`.
3. **Simulación, panel (Claude con aviso de `pnpm dev`, o el operador):** crear el corredor "Corredor Demo" (no propio), subir un logo, invitar a un usuario; abrir el enlace en una ventana privada y elegir la contraseña.
4. **Como el corredor:** bajar la planilla, cargar dos propiedades (copias de P001 y P002 con fotos), preparar (la IA por API), ver el gasto, aprobar, publicar Instagram en simulación (con la cuenta que el operador conectó a ese corredor) y Marketplace a mano ("No lo publiqué").
5. **Separación:** como el corredor, abrir el enlace de una propiedad de `agentsales-pruebas` ("no existe"); Seguimiento solo con lo suyo; la CLI con su sesión igual.
6. **Tope:** el operador le pone un tope de US$ 0,01; preparar de nuevo se detiene con el mensaje.
7. **Bitácora y usuarios:** la bitácora muestra quién hizo cada cosa; restablecer el usuario del corredor cierra su sesión.
8. Nada en vivo: F7 no cambia cómo se publica de verdad.

## 8. Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| Una ruta queda sin revisar el alcance y un corredor ve lo de otro | Tabla de permisos con test de inventario, la matriz de 404 por ruta, el filtro en SQL en las listas y la revisión del `arquitecto` en cada lote |
| El operador queda fuera (olvida la contraseña, se bloquea) | `pnpm auth:admin` restablece desde la base, sin la API |
| Se filtra un token de sesión o un enlace | Solo hashes en la base, enlaces en el fragmento y al portapapeles, cookie `HttpOnly` y `Strict`, archivo de la CLI `0600` fuera del proyecto; restablecer cierra todas las sesiones |
| Adivinar contraseñas | 12 caracteres mínimo, `scrypt`, bloqueo a los 10 fallos; F8 suma lo necesario para internet |
| El gasto de la API se dispara | Tope mensual por corredor, el límite de gasto de la consola (checklist) y la estimación visible |
| La tabla de precios queda vieja | Fechada en core, la cifra es una estimación y la consola manda |
| Romper lo de F6 al exigir sesión | Los tests de hoy corren con una sesión de administrador; la demo empieza repitiendo lo de F6 |
| Claude ya no puede usar la CLI sin la sesión del operador | El operador abre la sesión una vez; Claude no lee el archivo |
| Meta no deja publicar en la cuenta de un evaluador sin App Review (NO VERIFICADO, §4.14) | `pnpm ig:smoke` sobre su cuenta antes de publicar en vivo; si falla, su Instagram espera a App Review (F8) y la demo usa una segunda cuenta del operador |
| Usar una sola clave de Anthropic para atender a varios clientes choca con los términos comerciales | **Pendiente del operador antes de cobrar o de F8:** revisar los términos comerciales de Anthropic (el subagente no los leyó) |
| El tope de gasto de la cuenta corta la IA de todos | `LLM_ACCOUNT_LIMIT` con un mensaje para revisar la consola, sin reintentos inútiles; el operador ve el gasto por corredor |
| Marketplace a mano se confunde con el automático | Cuenta distinta (`manual`), la regla en core y el panel lo dice en la pestaña |

## 9. Preguntas abiertas
Respondidas por el operador el 2026-10-16:
- [x] D1: ¿cómo partir F7? **En F7 (varios corredores, en el Mac) y F8 (a internet).**
- [x] ¿Quién entra? **El operador y cada corredor.**
- [x] D3: ¿de quién es la clave de la IA? **Del operador, con el gasto por corredor.**
- [x] D6: Meta: **el corredor como evaluador; App Review después.**
- [x] D2: ¿qué hace el corredor? **Casi todo con lo suyo; el operador, lo sensible.**
- [x] D5: Marketplace: **el corredor publica con todo listo.**
- [x] D4: tope de IA: **mensual y opcional.**
- [x] D7: campos propios: **no en F7.**
- [x] D16: Instagram del corredor: **en persona, en el Mac del operador.**
- [x] D14: gasto: **registro propio en la base.**
- [x] D15: modelo: **Sonnet 5.5, y se mide Haiku 5.5 en el cierre.**

## 10. Registro de cambios del spec
| Fecha | Cambio |
|---|---|
| 2026-10-16 | Borrador (`/fase-plan 7`): F7 se parte en "Varios corredores" (esta fase, `v0.7.0`) y "En internet" (F8, `v1.0.0`); respuestas del operador D1 a D7 y D14 a D16; notas de `integraciones` del 2026-10-16 (§4.14) |
| 2026-10-16 | Revisión del `arquitecto` (5 bloqueantes, aplicados): el lote B trae el login de la CLI y del panel junto con la sesión de la API, y el arnés con sesión de administrador (D17); puerto `SecretTokens` para los tokens; la carga del corredor nace con su `broker_id` y el job nunca crea corredores; Marketplace a mano como traspaso en core sin publisher, sin "un formulario a la vez" y con el `meta` como unión (ADR-0023, D18); desactivar un corredor entero sale del alcance. Además: la vuelta del OAuth de Instagram es pública; `/health` tolerante sin base; lo del respaldo y la lista de corredores, solo para el administrador; `?broker` ajeno da 404; el canal sale de `sessions.client` y se retira `X-AgentSales-Client`; el gasto se suma por llamada y cuenta por la fecha de la corrida; restricciones e índices de la migración; `LLM_MODEL` solo para `claude-cli`; `eval:content` con la API; la regla del formulario automático en core; las tareas partidas (19, en 8 lotes) y las rutas de archivos reales |
| 2026-10-16 | **Aprobado** por el operador. ADR-0021, ADR-0022 y ADR-0023 registrados; seguimientos en ADR-0003, ADR-0005, ADR-0011 y ADR-0017; roadmap con F7 y F8 |
| 2026-10-17 | Lote A (F7-T01 a T03, PR #130) y su revisión (`revisor` y `arquitecto`, sin bloqueantes, todo aplicado): el tope de IA se valida y redondea (`normalizeLlmMonthlyCap`, `BROKER_SETTINGS_INVALID`); un corredor sin corredor no puede nada; la rama bloqueada del login hace el mismo trabajo de hash; `scrypt` con NFC y un tope de memoria al leer un hash; usuarios por bytes (`collate "C"`); dos enlaces a la vez se reintentan (`INVITATION_CONFLICT`); pruebas de la carrera al aceptar, del usuario desactivado y del borde del mes. Para los lotes siguientes: `ensureAdmin` en T05, el alcance obligatorio en T08, la agenda con alcance en SQL en T09, los códigos nuevos en §4.13 y que un corredor de la hoja nace no propio (§4.6); riesgos aceptados en el seguimiento de ADR-0021 |
| 2026-10-17 | Lote B (F7-T04 a T07, PR #131) y su revisión (`revisor` y `arquitecto`, sin bloqueantes de diseño, todo aplicado): `POST /auth/logout` pasa a público e idempotente (con una sesión vencida igual borra la cookie); `returnPathOf` rechaza la barra invertida y los caracteres de control; el menú del usuario también en móvil; la CLI distingue Ctrl+C (`LOGIN_CANCELLED`) de "sin terminal", muestra un punto por letra (pedido del operador), un segundo `login` cierra la sesión anterior, `logout` borra la local aunque la API no responda (y lo avisa) y el archivo vuelve a `0600` si alguien lo abrió; la API anota en el log una sesión que no se pudo leer en una ruta pública; la sesión sembrada del arnés del panel es `panel`. Pruebas nuevas: barra final, `HEAD`, mayúsculas, y que el log nunca lleve tokens, cookies ni enlaces. Para los lotes siguientes: cada lote suma sus códigos a `errors.ts` (`BROKER_MISMATCH`, `LLM_BUDGET_EXCEEDED`, `MARKETPLACE_AUTOMATION_NOT_ALLOWED`, `OAUTH_STATE_USED` y `LOGO_INVALID` como 415); en C, un ayudante `withSession` para la sesión de un corredor y un test que cruce `access.ts` con `can`; en F8, `__Host-` en la cookie con HTTPS, un límite por IP para el bloqueo y el inicio del OAuth en el mismo host que el panel |
