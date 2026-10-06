# Spec F3 · Aprobación + Instagram

- **Estado:** Aprobado (2026-10-04, aprobación permanente del operador)
- **Rama base:** `main`
- **Tag al cerrar:** `v0.3.0`
- **Referencias:** `docs/06-roadmap.md#f3--aprobación--instagram`, ADR-0005, ADR-0011, ADR-0012, ADR-0014 (nuevo), `docs/01-arquitectura.md`, `docs/02-modelo-datos.md`, `docs/03-plataformas.md`, `docs/04-formato-publicaciones.md`, `docs/integraciones/instagram.md` (completada el 2026-10-04)

## 1. Objetivo
El operador conecta su cuenta de Instagram, aprueba el texto de una propiedad ya preparada y la publica en Instagram al instante: el carrusel y, si la propiedad tiene video, el reel. El sistema guarda el enlace de cada publicación y su historial. Todo se prueba primero en `dry-run`, que registra lo que se habría enviado sin llamar a Instagram, y solo pasa a `live` con la instrucción del operador en el chat.

## 2. Alcance
- **Aprobación del texto de cada canal** (`contents.status = approved`), desde el panel y la CLI, y quitar la aprobación (rechazar).
- **Publicaciones** que nacen aprobadas desde el texto aprobado, una por formato (carrusel y reel), con su texto y sus medios fijos, su máquina de estados y su bitácora (`publication_events`).
- Un **candado por aviso** que ordena pedir textos, editar, aprobar y publicar, y cierra la ventana de edición que quedó de F2.
- **Cuentas conectadas** (`platform_accounts`) con tokens cifrados (AES-256-GCM con clave derivada por HKDF-SHA256 desde `APP_ENCRYPTION_KEY`: paga la deuda de F0).
- **Instagram Login (OAuth)** desde el panel, canje por token largo, y **refresco** de tokens.
- `packages/publishers` con el **publisher de Instagram**: carrusel (o imagen suelta), reel, sondeo del contenedor, cuota, enlace y errores clasificados.
- **`PUBLISH_MODE=dry-run`:** el decorador que valida y registra lo que se habría enviado, sin llamar a Instagram.
- Job `publication.publish` en el worker, con reintentos que nunca publican dos veces.
- API, CLI y panel: cuentas, aprobar, publicar, descartar, marcar como retirada y ver el historial.
- `pnpm ig:smoke`: crea un contenedor sin publicarlo, para comprobar que Meta descarga las URLs de R2 (lo corre el operador).

## 3. Fuera de alcance
- Portal Inmobiliario (F4) y Marketplace (F5). Sus textos sí se pueden aprobar en F3, pero no hay cuentas ni publicaciones de esos canales.
- Programar publicaciones, sincronizar estados, reintentos con espera larga por límites y `auto_publish` (F6).
- Borrar una publicación de Instagram por la API: con Instagram Login no está permitido (nota §4.8). Se borra a mano y se marca como retirada.
- Editar un caption ya publicado (la API no lo permite; nota §4.7).
- Conectar cuentas de terceros: App Review, acceso avanzado y verificación del negocio (F7).
- Subida reanudable del reel (`rupload`): plan B si Meta no acepta la URL firmada del reel (nota §4.5).
- Editar textos desde la CLI: se editan en el panel (F2-T15); la CLI aprueba, quita la aprobación y publica (D9).
- Redefinir los cambios manuales del aviso (`LISTING_MANUAL_TRANSITIONS`: pausar, archivar o cerrar un aviso `active`) y que `changeListingStatus` orqueste sus publicaciones: pasa a F6, junto con "cerrar despublica todo". En F3, un aviso `paused` o `archived` con publicaciones aprobadas no publica (`LISTING_NOT_READY`) y ellas esperan hasta que vuelva a `ready` o se descarten.

## 4. Diseño

### 4.1 Componentes
| Componente | Cambio |
|---|---|
| `packages/core` | Formatos y estados de publicación (ADR-0014), entidades `PlatformAccount` y `Publication`, puertos `PlatformAccountRepository`, `PublicationRepository`, `ListingLock`, `Publisher` e `InstagramAuth`; casos de uso de aprobación, publicación, cuentas y refresco; decorador `withDryRun`; dobles en `@agentsales/core/testing` |
| `packages/config` | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` e `INSTAGRAM_REDIRECT_URI` (reemplazan a `META_*`); `createSecretBox` (HKDF-SHA256 + AES-256-GCM, implementa el puerto `SecretBox` de core) y `createStateSigner` (HMAC-SHA256 del `state` del OAuth) |
| `packages/db` | Migración `0006`; repositorios de cuentas y publicaciones; `createListingLock` |
| `packages/publishers` (nuevo) | `instagram/`: cliente de la Graph API, OAuth, publisher, constantes de la plataforma y clasificación de errores |
| `apps/worker` | Jobs `publication.publish` y `tokens.refresh` (al arrancar y una vez al día), `pnpm ig:smoke` |
| `apps/api` | Rutas del OAuth (`/oauth/instagram/start` y `/callback`; la única llamada síncrona a una plataforma desde la API, ADR-0014), cuentas, aprobación y publicaciones |
| `apps/cli` | `approve`, `publish`, `publications`, `accounts` |
| `apps/web` | Página **Cuentas**; aprobar y publicar en la sección Contenido del aviso |

### 4.2 Aprobación y nacimiento de las publicaciones (ADR-0014)
- **Lo que se aprueba es el texto vigente de un canal** (`contents`), que es lo que el operador revisa. `approveContent` lo deja en `approved` si:
  - es el vigente de su canal (`CONTENT_NOT_CURRENT`, 409);
  - el aviso no tiene una corrida activa (`CONTENT_RUN_ACTIVE`, 409; también una de solo imágenes, que reemplaza los medios);
  - la revisión editorial no tiene errores (`CONTENT_HAS_ERRORS`, 409; las advertencias no bloquean);
  - el aviso está en `ready`, `active` o `paused` (`canPrepareContent`, `LISTING_NOT_READY`).
- **Las publicaciones nacen aprobadas** (`approved`), del texto aprobado y de las cuentas conectadas del corredor en ese canal:
  - **al aprobar**, si la cuenta ya está conectada;
  - **al publicar**, si la cuenta se conectó después (el mismo `openPublications`).
  - Una por **formato**: Instagram da `post` (carrusel; con un solo elemento, imagen suelta) y, si el aviso tiene reel, `reel`. Portal y Marketplace darán `post`.
  - Un formato que ya tiene una publicación activa en esa cuenta (por ejemplo, una `published` de un texto anterior, también de `dry-run`) no abre otra: se salta y se informa (`skipped`, con el id de la activa). Para publicar el texto nuevo, primero se retira o se descarta la anterior. Así el único parcial nunca salta dentro del candado, donde un error de la base anularía la aprobación entera.
  - Al nacer se fijan `content_id` y `media_ids` (`composeCarousel` o `composeReel` en ese momento). Sin medios para el formato (`post` sin fotos procesadas) es `CONTENT_NOT_READY` (409).
- **Quitar la aprobación** (`unapproveContent`, "rechazar" en el roadmap) deja el texto en `edited` (protege lo revisado de una regeneración sin aviso) y cancela las publicaciones de ese texto que aún no salieron y que la máquina deja descartar (`approved`, `scheduled`, `failed` y `awaiting_manual_confirm` → `cancelled`). Con una en `publishing`, `PUBLICATION_IN_PROGRESS` (409). Las publicadas no cambian. Cancelar una `awaiting_manual_confirm` (el clic final de Marketplace) se revisa en F5.
- **Textos nuevos después de aprobar:** necesitan una aprobación nueva, y no pueden pisar lo aprobado:
  - Mientras el aviso tenga una publicación **pendiente** (`approved`, `scheduled`, `publishing`, `failed` o `awaiting_manual_confirm`: `PENDING_PUBLICATION_STATUSES`), no se puede pedir una corrida (`PUBLICATION_PENDING`, 409): ni de textos ni de imágenes, que reemplazan los medios fijados. Se publica o se descarta primero.
  - Con publicaciones ya `published`, se puede volver a preparar. Un texto `approved` cuenta como editado: regenerarlo exige `replaceEdits` (`CONTENT_EDITED`). Los textos nuevos nacen en `draft`, y la publicación hecha sigue apuntando a su texto, que ya no es el vigente.
- **Editar:** un texto con una publicación activa (pendiente o `published`) no se edita (`CONTENT_LOCKED`, 409): es el registro de lo que se aprobó o se publicó. Uno aprobado sin publicaciones activas sí, y vuelve a `edited` (pierde la aprobación).
- **Candado por aviso (`ListingLock`):** pedir una corrida, editar, aprobar, quitar la aprobación, abrir publicaciones y pasarlas a `publishing` corren dentro de `lock.run(listingId, fn)`. En Postgres es una transacción que bloquea la fila del aviso (`FOR NO KEY UPDATE`, como `MediaRepository.arrange`) y entrega a `fn` repositorios de esa transacción (`create*Repository(tx)`; las transacciones internas de `arrange`, `upsertDerivative` y `markSucceeded` pasan a ser savepoints); el doble en memoria serializa por aviso. Las reglas siguen en core; el candado solo hace que la revisión y la escritura sean una sola cosa. Reglas:
  - `fn` recibe **solo** repositorios de la transacción (es una regla, no algo que el tipo impida: `fn` podría usar un repositorio que tenga a mano por fuera): un repositorio atado a la conexión general se quedaría esperando la fila bloqueada (y en PGlite, que tiene una sola conexión, siempre).
  - Dentro de `fn` no hay cola, R2 ni llamadas externas. **Se encola después** de que `lock.run` termina, con los ids que devuelve `fn`: pg-boss usa otra conexión, y un job encolado antes de confirmar vería la fila vieja y terminaría sin hacer nada.
  - Un error de la base dentro de `fn` no se recupera: anula la transacción. Con el candado, la carrera que hoy cubre `CONTENT_RUN_CONFLICT` → `findActive` no ocurre, porque la revisión y el `create` van juntos.
- Esto **cierra la ventana de edición de F2** (spec F2, §8): un pedido de textos y una edición ya no pueden cruzarse. La aprobación la habría vuelto más grave (una corrida podía reemplazar los medios de una publicación aprobada).

### 4.3 Publicaciones
- **Estados que usa F3** (máquina de estados en core, ADR-0014): `approved` → `publishing` → `published` o `failed`; `failed` → `publishing` (reintento manual); `approved` o `failed` → `cancelled` (descartar); `published` → `unpublished` (marcar como retirada). `draft` y `pending_approval` se quitan (la revisión es del texto); `scheduled`, `paused` y `awaiting_manual_confirm` quedan para F4 a F6.
- **Cada transición** guarda la fila y su evento (`status_changed`, con `actor` `operator`, `cli` o `system`) en una sola transacción, y es condicional (`from` → `to`): si otro cambio llegó antes, `INVALID_TRANSITION`.
- **Publicar** (`publishListing`, por aviso y canal): con el aviso en `ready` o `active` (`LISTING_NOT_READY`), abre las publicaciones que falten (§4.2), pasa las `approved` y `failed` del canal a `publishing` (sube `attempts` y fija `dry_run` con el `PUBLISH_MODE` de la API en ese momento) y, ya fuera del candado, encola `publication.publish` por cada una. Sin texto aprobado, `CONTENT_NOT_APPROVED`; sin cuenta conectada, `ACCOUNT_NOT_CONNECTED`. Las que ya están en `publishing` se reencolan (idempotente: arregla un job perdido o una cola caída a mitad de camino); sin nada que iniciar ni reencolar (todas `published`), `NOTHING_TO_PUBLISH` (409). Una `failed` que ya empezó en `live` (tiene progreso) no se reintenta en `dry-run` (`PUBLISH_MODE_LOCKED`, 409). También se puede publicar una sola (`POST /publications/:id/publish`); sobre una que ya está en `publishing`, la reencola (un corte en el último intento la dejaba sin job), como `requestContentRun`. Un reintento desde `failed` conserva `progress`.
- **El modo lo decide la publicación, no el worker:** el handler usa `withDryRun` si `publication.dryRun` es `true`, aunque el worker esté en `live`. Si es `false` y el worker está en `dry-run`, la deja en `failed` con `PUBLISH_MODE_MISMATCH` (no reintentable). Así un cambio de `PUBLISH_MODE` entre la API y el worker nunca publica de verdad algo pedido como simulación.
- **Descartar** (`cancelPublication`): `approved` o `failed` → `cancelled`. El texto sigue aprobado.
- **Marcar como retirada** (`retirePublication`): `published` → `unpublished`. En `live`, el operador confirma que la borró a mano en Instagram (el panel y la CLI lo piden); en `dry-run` no hay nada que borrar.
- **Estado del aviso:** cada publicación que queda `published` en `live` intenta pasar el aviso de `ready` a `active` (T11: después de guardar `published`, con el cambio condicional; así una retirada y una publicación cruzadas terminan bien); al retirar la última publicación `live` publicada, vuelve a `ready`. Las de `dry-run` no cambian el aviso. Los dos cambios son del sistema (no de la tabla manual) y condicionales, con `ListingRepository.changeStatus(id, from, to)`: si el aviso ya cambió, no se toca.
- **Bitácora:** cada intento deja un único evento `publish_attempt` con el modo, el número de intento, el resultado y lo que se envió (en `dry-run`, lo que se habría enviado; `publishAttemptRecord`, T07): formato, caption completo, medios (rutas de R2, tipo, tamaño y medidas) y la cuenta (`@usuario`). Va en los dos modos, porque después de publicada una corrida nueva puede reemplazar los medios (ADR-0014). Nunca URLs firmadas ni tokens.

### 4.4 Job `publication.publish`
- **Cola:** `exclusive` por `singletonKey = publicationId`, 2 reintentos con backoff desde 60 s, expira a los 15 min (el sondeo de un reel dura hasta 5 min). Reemplaza la política objetivo de `01-arquitectura.md` (3 reintentos y ~5 min). Datos: `{ publicationId }`. Al arrancar, el worker reencola **todas** las publicaciones en `publishing` (idempotente por `singletonKey`), como las corridas en cola.
- **Handler** (`publishPublication`, core): recarga la publicación y sigue solo si está en `publishing` (si no, termina sin hacer nada: idempotente). Carga la cuenta (`connected` o `ACCOUNT_NOT_CONNECTED`, no reintentable) y sus credenciales, arma el `PublishInput` (`buildPublishInput`: caption con `instagramCaption`, medios de `media_ids` con URLs firmadas recién creadas por 1 h) y llama al publisher, envuelto en `withDryRun` según `publication.dryRun` (§4.3). En `live`, `checkPublishInput` corre antes de `publish` (plataforma, formato y requisitos, antes de crear contenedores); en `dry-run` la corre `withDryRun`. Las credenciales se descifran en los dos modos (un `CREDENTIALS_UNREADABLE` también detiene una simulación). El paso del aviso a `active` lo decide `publication.dryRun`, no `result.simulated` (los dos coinciden; un test lo comprueba).
- **Progreso sin duplicar (`publications.progress`):** el publisher guarda los ids de los contenedores **antes** de `media_publish` (`saveProgress`). Un reintento empieza por el progreso guardado:
  - contenedor `FINISHED` → `media_publish` de ese mismo contenedor;
  - `PUBLISHED` → busca el medio entre los 10 últimos de la cuenta (del mismo formato, porque el carrusel y el reel llevan el mismo caption; mismo caption, publicado desde 2 min antes del inicio del intento) y lo da por publicado; si no lo encuentra, `failed` con `IG_PUBLISH_OUTCOME_UNKNOWN` (no reintentable). Reintentar desde `failed` volvería al mismo punto, así que el mensaje dice qué hacer: si no salió, descartarla y volver a publicar; si salió, borrarla a mano antes de volver a publicar;
  - `IN_PROGRESS` → espera lo que le queda de sus 5 min; si ya los gastó (un contenedor trabado), se rehace con contenedores nuevos (uno en proceso no está publicado);
  - `EXPIRED` o `ERROR` → contenedores nuevos;
  - `media_publish` nunca se llama dos veces sobre el mismo contenedor sin consultar antes su estado. Además, el progreso guarda la hora del pedido (`publishRequestedAt`) justo antes de `media_publish`: si un corte deja la respuesta sin leer, el reintento espera 1 min, vuelve a mirar el contenedor y busca el medio antes de pedirlo otra vez (queda una ventana si Meta tarda más; nota §8);
  - todo el intento tiene un tope de 12 min (`INSTAGRAM_ATTEMPT_MAX_MS`), bajo el vencimiento del job (15 min), así un intento no se cruza con su reintento.
- **Resultado:** `published` con `external_id` (id del medio), `external_url` (`permalink`) y `published_at`; o `failed` con `last_error { code, message, retriable }` legible. Un error reintentable deja la publicación en `publishing` y relanza (pg-boss reintenta); en el último intento, `failed`. Un 190 (token vencido o inválido) también deja la cuenta en `expired`. **Si la plataforma publicó y lo que falla es guardar `published`**, el medio ya salió: la publicación sigue en `publishing` y el error es `PUBLISH_RESULT_NOT_SAVED` (reintentable); el reintento lo reconoce por el progreso y lo guarda sin publicar de nuevo. La bitácora y el paso del aviso a `active` van después y no cortan el intento (si fallan, se avisa al worker; un nuevo paso del job sobre una `published` en `live` vuelve a intentar subir el aviso).
- **Apagado:** como `content.prepare`, el `signal` corta el sondeo; la publicación queda en `publishing` y el reintento la retoma desde el progreso.
- **Logs:** solo `publicationId`, el código del error y conteos; nunca tokens, URLs firmadas ni el caption.

### 4.5 Publisher de Instagram (`packages/publishers/instagram`)
- **Contrato** (core, ADR-0014; reemplaza el borrador de `01-arquitectura.md`):
  ```ts
  interface Publisher {
    readonly platform: Platform;
    readonly formats: readonly PublicationFormat[];
    validate(input: PublishInput): PublishValidation;          // { ok: true } | { ok: false, issues }
    publish(input: PublishInput, ctx: PublishContext): Promise<PublishResult>;
  }
  type PublishContext = {
    account: PlatformAccount;
    credentials: PlatformCredentials;                          // ya descifradas, solo en memoria
    progress: unknown | null;                                   // lo guardado por un intento anterior
    saveProgress(progress: unknown): Promise<void>;
    signal?: AbortSignalLike;
  };
  type PublishResult = { externalId: string; externalUrl: string | null; simulated: boolean };
  ```
  `unpublish` y `getStatus` se suman cuando un canal los use (F4 y F6).
- **Graph API:** host `graph.instagram.com`, versión fija en `INSTAGRAM_GRAPH_VERSION` (`v25.0`), token en la cabecera `Authorization: Bearer` (nunca en la URL), salvo el canje por el token largo y el refresco, que Meta documenta solo con parámetros en la URL (nota §3.3 y §3.4): esa URL nunca va a un error ni a un log, y `redactText` oculta `access_token` y `client_secret` si se registrara; parsers tolerantes a la envoltura `data: [ ]`. Las constantes de la plataforma (2 a 10 ítems, 30 hashtags, 20 menciones, 8 MB, ritmo de sondeo) viven en un solo archivo, y el largo del caption reutiliza `INSTAGRAM_CAPTION_MAX_LENGTH` de core.
- **`validate`:** carrusel de 1 a 10 imágenes JPEG (con 1, imagen suelta) de menos de 8 MB y proporción de 4:5 a 1,91:1, caption dentro de los topes (largo, 30 hashtags y 20 menciones), reel MP4 de 3 a 90 s (tope de producto de F2, dentro de los 3 s a 15 min de Meta; el margen de 0,5 s es técnico, por las centésimas del MP4, y no cambia D7). El publisher la vuelve a correr (`checkPublishInput`) al empezar `publish`. Es una función pura (`validateInstagramInput`): la usa `withDryRun` sin construir el cliente de la API, que el publisher recibe de forma perezosa.
- **`post`:** un contenedor por imagen (`is_carousel_item=true`), el del carrusel con `children` y `caption`, sondeo hasta `FINISHED`, `media_publish` y `permalink` (del carrusel, no de los hijos).
- **`reel`:** contenedor `REELS` con `video_url`, `caption`, `thumb_offset=1000` (el cuadro del segundo 1, con el texto del reel) y `share_to_feed=true`; sondeo, `media_publish` y `permalink`. Sin `cover_url`: la portada del carrusel es 4:5 y Meta recortaría el centro 9:16 (nota §5). `media_ids` del reel es solo el reel.
- **Sondeo:** una consulta al empezar (las imágenes suelen estar listas), y después a los 5, 10, 20 y 30 s y cada 60 s; la última, justo a los 5 min (nota §11.8). Si no termina, `IG_CONTAINER_TIMEOUT` (reintentable: el reintento espera lo que le quede al contenedor y, si ya gastó sus 5 min, arma contenedores nuevos). Si `media_publish` dice que el medio aún no está listo, se vuelve a sondear, hasta 3 pedidos.
- **Cuota:** antes de crear contenedores consulta `content_publishing_limit` y compara `quota_usage` con `config.quota_total` (no se fija 50 ni 100); sin cupo, `IG_PUBLISH_LIMIT` (no reintentable en F3). Si el endpoint no responde con Instagram Login (rechazo, permiso o forma), o responde sin total, se sigue y se anota (`onNote`, con el `publicationId`; T12 lo registra).
- **Errores** (nota §7, por subcódigo y después por código), como `AppError`:
  | Código | Casos | Reintentable |
  |---|---|---|
  | `IG_AUTH_INVALID` | 190, 102 (o un HTTP 401 sin código) | No (la cuenta pasa a `expired`) |
  | `IG_PERMISSION_DENIED` | 10, 200 a 299 (o un HTTP 403 sin código) | No |
  | `IG_MEDIA_REJECTED` | 2207004, 05, 09, 10, 23, 26, 28, 35 a 37, 40, 57 | No |
  | `IG_ACCOUNT_RESTRICTED` | 2207050, 2207051 | No |
  | `IG_PUBLISH_LIMIT` | 9, 2207042 | No |
  | `IG_RATE_LIMITED` | 4, 17, 80002, 613 (o un HTTP 429 sin código) | No en F3 (el mensaje dice cuándo reintentar; la espera automática es de F6) |
  | `IG_MEDIA_FETCH_FAILED` | 2207003, 2207052 | Sí (URLs nuevas) |
  | `IG_UNAVAILABLE` | 5xx, red, 1, 2, 2207001, 2207032, 2207053, 2207006, 2207020 | Sí (contenedores nuevos) |
  | `IG_CONTAINER_TIMEOUT` | sondeo agotado | Sí |
  | `IG_PUBLISH_OUTCOME_UNKNOWN` | contenedor publicado sin medio encontrado | No |
  2207008 y 2207027 no son errores: se sigue sondeando (el cliente los entrega como `IG_MEDIA_NOT_READY`, reintentable, y el publisher sigue esperando; nunca llegan a `last_error`). Los mensajes son en español y sin datos del aviso. Además (T08): lo que no calza con la tabla es `IG_REQUEST_REJECTED` (no reintentable, con el código de Meta); sin red o pasados 30 s, `IG_UNAVAILABLE` (reintentable); un corte por la señal, `IG_ABORTED` (reintentable); y una respuesta con otra forma, `IG_UNEXPECTED_RESPONSE` (no reintentable). Ningún error lleva el token, la URL ni el mensaje de Meta. Un estado de contenedor que Meta agregue y no conozcamos llega como `UNKNOWN` y se sigue sondeando (si no cambia, `IG_CONTAINER_TIMEOUT`).
- **No se envía `is_ai_generated`** (D6): las fotos y el video son reales; la IA solo redacta frases del caption.

### 4.6 Cuentas, OAuth y tokens
- **Variables:** `INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET` son el par **de Instagram** (App Dashboard > Instagram > API setup with Instagram login > Business login settings), no el de Settings > Basic (nota §2.1). `INSTAGRAM_REDIRECT_URI` (por defecto `http://localhost:8787/oauth/instagram/callback`; el host debe ser el mismo del enlace de inicio, porque la cookie distingue `localhost` de `127.0.0.1`). Reemplazan a `META_*` (D5). `doctor` avisa si faltan.
- **Conectar (panel → API):**
  1. El botón Conectar del panel abre directo (el `broker` se valida con zod y debe existir, `BROKER_NOT_FOUND`) `http://localhost:8787/oauth/instagram/start?broker=<slug>` (no por el proxy `/api` de Vite). La API arma el `state` (nonce aleatorio, corredor y vencimiento de 10 min, firmado con HMAC), lo deja en una cookie `HttpOnly`, `SameSite=Lax`, `Path=/oauth`, y redirige a `instagram.com/oauth/authorize` con los scopes `instagram_business_basic,instagram_business_content_publish`.
  2. `GET /oauth/instagram/callback` compara el `state` con la cookie (`OAUTH_STATE_INVALID`), quita el `#_` del código, lo canjea por el token corto y luego por el largo, lee `/me?fields=user_id,username,account_type`, exige `instagram_business_content_publish` entre los permisos (`IG_PERMISSION_DENIED`) y guarda la cuenta (`connectAccount`). Redirige a la URL absoluta del panel (`http://localhost:<WEB_PORT>/cuentas?conectada=instagram` o `?error=<código>`), sin datos de la cuenta en la URL.
  - Si el operador rechaza en Instagram (`error=access_denied`), vuelve al panel con `?error=OAUTH_DENIED`. Es solo un código de la redirección para el panel, no un `AppError` (no va en `errors.ts`).
- **Meta no acepta `http://localhost`** (probado el 2026-10-05, nota §3.6). En F3 la cuenta se conecta con `agentsales accounts connect instagram --broker <slug> --token-stdin`, que recibe por la entrada estándar el token largo del botón **Generate token** (`POST /accounts/connect-token`) y sigue igual desde `/me` (D4). El OAuth de arriba se implementa y se prueba con msw (lo necesita F7, con HTTPS), pero el panel muestra el botón Conectar solo si `INSTAGRAM_REDIRECT_URI` es `https://`; si no, muestra el comando de la CLI. No se agregan túneles ni HTTPS local en F3.
- **Guardado (`platform_accounts`):** `external_account_id` = `user_id` de `/me`, `display_name` = `@username`, `status = connected`, `token_expires_at`, `meta` con `accountType`, los permisos, `connectedAt` y `tokenRefreshedAt`.
- **Con el token del panel** (`connect-token`, D4) no hay canje: no se conocen los permisos ni el vencimiento real (revisión del `arquitecto` en T08). Se guarda `meta.permissions: null` (desconocidos; nunca `[]`, que se leería como "ninguno"), `meta.tokenRefreshedAt: null` y un `token_expires_at` estimado a 60 días desde la conexión (`meta.tokenExpiryEstimated: true`). El permiso de publicar se exige solo cuando se conoce (`INSTAGRAM_PUBLISH_SCOPE`, en core): un token sin él falla al publicar con `IG_PERMISSION_DENIED`, que pide reconectar. No se sondea con `content_publishing_limit` (con Instagram Login está sin verificar, nota §6). El refresco (T14) trata `tokenRefreshedAt: null` como "refrescar en cuanto pasen 24 h desde `connectedAt`", y así obtiene el vencimiento real. `credentials_encrypted` guarda `{ accessToken }` cifrado. Reconectar la misma cuenta actualiza la fila. `meta` de Instagram tiene su esquema en core (`instagramAccountMetaSchema`, T13), porque el refresco (T14) lee `tokenRefreshedAt`.
- **Una cuenta conectada por corredor y plataforma:** conectar otra cuenta externa de Instagram en el mismo corredor desconecta la anterior (`revoked`); sus publicaciones pendientes quedan con `ACCOUNT_NOT_CONNECTED` hasta descartarlas o reconectarla. Lo hace `connectAccount` (T13), dentro de una transacción; la base no lo impone. Así aprobar y publicar (T05, T10) siempre tienen una sola cuenta del canal.
- **Cambios de estado condicionales:** `updateToken` solo escribe si la cuenta sigue `connected` (un refresco que se cruza con una desconexión no la revive), y `changeStatus(id, from, to)` solo cambia desde el estado esperado. El intento de publicación (T11) revisa que la cuenta esté `connected` antes de pedir las credenciales: una `expired` todavía las devuelve.
- **Cifrado (puerto `SecretBox` en core; `createSecretBox` en `packages/config`, que lo inyectan las apps en el repositorio de cuentas, porque los paquetes no importan config):**
  - Clave de 32 bytes con HKDF-SHA256 desde `APP_ENCRYPTION_KEY` (sal fija `agentsales/hkdf/v1`), con `info` por propósito (`agentsales/credentials/v1`; el `state` del OAuth usa otra: `agentsales/oauth-state/v1`).
  - AES-256-GCM con IV aleatorio de 12 bytes; formato `v1.<iv>.<cifrado>.<tag>` en base64url.
  - AAD = `platform:broker_id:external_account_id`: un cifrado copiado a otra fila (también la misma cuenta externa en otro corredor) no se descifra.
  - Un texto alterado, otra clave u otra AAD dan `CREDENTIALS_UNREADABLE` (no reintentable; la cuenta queda en `error` y hay que reconectarla).
  - Core nunca ve el cifrado: el repositorio cifra al guardar y descifra solo en `getCredentials(id)`.
- **Refresco (`refreshAccountTokens`):** refresca los tokens con más de 24 h desde el último refresco y menos de 30 días de vigencia. Corre al arrancar el worker y una vez al día mientras corre (`schedule` de pg-boss, job `tokens.refresh`, como en ADR-0005: cron, 3 reintentos con backoff, ~5 min). Un token vencido pasa la cuenta a `expired` sin llamar a Instagram; un 190 al refrescar, también. El panel muestra el vencimiento y avisa con 10 días de anticipación. Como el worker solo corre con `pnpm dev`, una cuenta sin uso por 60 días vence y se reconecta.
- **Refresco a pedido:** `POST /accounts/:id/refresh` (CLI `accounts refresh <id> [--force]`) corre el mismo caso de uso para una cuenta, de forma síncrona (el operador espera el resultado; seguimiento de ADR-0014, punto 9); `force` salta solo el tope de 30 días, nunca el mínimo de 24 h.
- **Desconectar:** `revoked` y borra `credentials_encrypted`. La cuenta no se borra (sus publicaciones la referencian).
- **Logs:** `redactText` (`packages/core/src/redact.ts`) ya oculta `access_token`, `client_secret` y `signature` en URLs. Se suma `code` **solo como parámetro** (`?code=`, `&code=`, `#code=` o al inicio de un formulario; no `status code=500` en un mensaje, ni la clave `code` de los objetos del log, que son los códigos de error), los secretos de los cuerpos de formulario (`a=b&c=d` sin `?`) y los valores sensibles de un JSON (`"access_token": "…"`, la respuesta de un canje). Tests que revisan que ningún log, error ni respuesta lleve el token, el secret ni el código.

### 4.7 Datos (migración `0006`, ADR-0014)
- `publications.format`: enum `publication_format` (`post`, `reel`; `PUBLICATION_FORMATS`), `NOT NULL`.
- `publications.progress`: `jsonb null`. Lo que el publisher ya creó en la plataforma (Instagram: `{ containerId, childIds, attemptStartedAt }`), validado con un esquema por plataforma en core.
- Único parcial `publications_one_active_per_format`: `(listing_id, platform_account_id, format)` con `status NOT IN ('unpublished', 'cancelled')`, en lugar de `publications_one_active_per_account`.
- `publication_status` sin `draft` ni `pending_approval` (se recrea el tipo). El SQL se ajusta a mano, porque el índice parcial compara `status` con valores del tipo y el cambio de tipo que genera drizzle-kit fallaría al reconstruirlo. Orden:
  1. `DO … RAISE EXCEPTION` si `publications` tiene filas (en Neon está vacía: ADR-0012);
  2. `DROP INDEX publications_one_active_per_account`;
  3. la columna a `text`, `DROP TYPE` y el tipo nuevo;
  4. la columna de vuelta al tipo con `USING`;
  5. `format`, `progress` y el índice nuevo por formato.
  El snapshot de drizzle queda igual al esquema (`pnpm db:generate` no genera nada después). Se aplica en PGlite (tests); antes del merge se prueba en Neon dentro de una transacción que se deshace (`BEGIN … ROLLBACK`), y se aplica en Neon justo después del merge.
- Índices `(listing_id)` en `publications` y `(publication_id, created_at)` en `publication_events`.
- `platform_accounts` no cambia: `meta` guarda lo nuevo.

### 4.8 Contratos (API, ADR-0011)
| Método y ruta | Qué hace |
|---|---|
| `GET /oauth/instagram/start?broker=` y `GET /oauth/instagram/callback` | Conexión (§4.6); responden con redirecciones |
| `GET /accounts` | Cuentas por corredor: plataforma, `@usuario`, estado, vencimiento. Nunca credenciales |
| `POST /accounts/:id/disconnect` y `POST /accounts/:id/refresh` `{ force? }` | `revoked`; refresco a pedido (§4.6) |
| `POST /accounts/connect-token` `{ broker, platform: "instagram", token }` | La conexión de F3, porque Meta no acepta `http://localhost` (D4): conecta con el token del panel, validado con zod y detrás del `hostGuard`; el token nunca vuelve en la respuesta ni va al log |
| `POST /contents/:id/approve` y `POST /contents/:id/unapprove` | Aprobar y quitar la aprobación (§4.2); responden con el texto, su revisión y las publicaciones del canal |
| `GET /listings/:id/publications` | Publicaciones del aviso con su estado, enlace, error y medios (miniaturas firmadas) |
| `POST /listings/:id/publish` `{ platform }` | Publicar el canal (§4.3) |
| `POST /publications/:id/publish`, `/cancel` y `/retire` | Publicar o reintentar una, descartarla y marcarla como retirada (`retire` exige `{ removedByHand: true }` si es `live`) |
| `GET /publications/:id/events` | Bitácora, sin secretos |

Códigos nuevos con su HTTP en `apps/api/src/errors.ts`: `CONTENT_HAS_ERRORS`, `CONTENT_NOT_READY`, `CONTENT_LOCKED`, `CONTENT_NOT_APPROVED`, `PUBLICATION_PENDING`, `PUBLICATION_IN_PROGRESS`, `PUBLICATION_CONFLICT`, `NOTHING_TO_PUBLISH` y `ACCOUNT_NOT_CONNECTED` (409); `PUBLICATION_NOT_FOUND` y `ACCOUNT_NOT_FOUND` (404); `OAUTH_STATE_INVALID` (400); `REMOVAL_NOT_CONFIRMED` y `PUBLISH_MODE_LOCKED` (409, T10); `CREDENTIALS_UNREADABLE` (500); `PUBLISH_MODE_MISMATCH`, `PUBLISH_INPUT_INVALID`, `PUBLICATION_MEDIA_MISSING`, `PUBLICATION_CONTENT_MISMATCH` (T07), `PUBLISHER_NOT_CONFIGURED`, `CONTENT_NOT_FOUND` e `INTERNAL_ERROR` (T11) solo viajan dentro de `last_error` (`PUBLISH_ABORTED` y `PUBLISH_RESULT_NOT_SAVED` son reintentables y nunca llegan ahí) (también `CONTENT_NOT_APPROVED`, cuando sale de un intento). Los `IG_*` viajan en `last_error` al publicar, pero conectar y refrescar a pedido (T13 y T14) los devuelven en la respuesta: `IG_UNAVAILABLE` es 503 e `IG_RATE_LIMITED` 429 por las reglas que ya existen, y T13 agrega `IG_AUTH_INVALID`, `IG_PERMISSION_DENIED` e `IG_REQUEST_REJECTED` (400) e `IG_UNEXPECTED_RESPONSE` (502).

### 4.9 CLI y panel
- **CLI:**
  - `agentsales approve <id_propiedad> [--platform instagram|portal|marketplace]`: sin `--platform`, aprueba los canales con texto vigente sin errores e informa cada uno; `--undo` quita la aprobación.
  - `agentsales publish <id_propiedad> [--platform instagram] [--no-wait] [--yes]`: en `live` pide confirmación (salvo `--yes`); espera hasta `published` o `failed` con el sondeo de F2 (`waitForRun` generalizado) y muestra el enlace.
  - `agentsales publications [<id_propiedad>]`: estado, formato, modo y enlace; `--events` para la bitácora. `publications cancel <id>` y `publications retire <id> [--yes]` (en `live`, confirma que se borró a mano).
  - `agentsales accounts`, `agentsales accounts connect instagram --broker <slug>` (imprime la URL de conexión y la abre en el navegador) y `accounts refresh <id> [--force]`.
- **Panel:**
  - Página **Cuentas** (`/cuentas`): por corredor, la cuenta de Instagram con su estado y vencimiento, y Desconectar. Conectar y Reconectar: el botón del OAuth si `INSTAGRAM_REDIRECT_URI` es `https://`; si no (F3 en local), el comando `accounts connect instagram --token-stdin` para copiar (D4).
  - Sección Contenido del aviso: en cada pestaña, la insignia "Aprobado" y los botones Aprobar o Quitar aprobación (con los motivos si no se puede). En Instagram, las publicaciones (carrusel y reel) con su estado, modo (`dry-run` o en vivo), enlace, error legible y los botones Publicar, Reintentar, Descartar y Marcar como retirada (con confirmación). Sondea mientras hay una en `publishing`, con `usePolledRun`; el tope de espera se cuenta desde que pasó a `publishing` (`updatedAt`), no desde que nació, porque una publicación puede llevar días aprobada.
  - Con publicaciones pendientes, el botón Preparar contenido queda desactivado con el motivo (`PUBLICATION_PENDING`).
  - El banner de `PUBLISH_MODE` ya existe; en `live`, el botón Publicar pide confirmación.

### 4.10 Decisiones (el operador dejó aprobación permanente: se aplican las recomendaciones y se le informan)
- **D1 · Se aprueba el texto, no la publicación (ADR-0014).** El texto es lo que el operador revisa; Instagram da dos publicaciones (carrusel y reel) que se aprobarían dos veces con el mismo texto, y un texto de Portal se puede aprobar antes de que exista su cuenta (F4). La publicación nace aprobada y fija lo aprobado. Se quitan `draft` y `pending_approval` de las publicaciones, que quedaban sin uso.
- **D2 · Carrusel y reel son dos publicaciones** (`format`): cada una con su estado, su enlace y sus reintentos, sin repetir la otra. El glosario pasa a "publicación (aviso × cuenta × formato)".
- **D3 · Lo aprobado no cambia:** sin corridas mientras haya publicaciones pendientes, sin editar textos con publicaciones activas, y candado por aviso (cierra la ventana de F2).
- **D4 · En F3, la cuenta se conecta con el token del panel de Meta** (Generate token) por la entrada estándar de la CLI: Meta rechazó `http://localhost` como dirección de retorno (probado el 2026-10-05, nota §3.6). El OAuth queda implementado y probado con msw para F7 (con HTTPS). Sin túneles ni HTTPS local.
- **D5 · `INSTAGRAM_*` en vez de `META_*`:** la nota muestra que la app tiene dos pares y el de Settings > Basic falla. El operador renombra las variables en su `.env` (T02).
- **D6 · Sin `is_ai_generated`:** las fotos y el video son reales; la IA solo redacta frases que el operador aprueba.
- **D7 · Tope del reel de 3 a 90 s** (el de F2): política de producto dentro de los límites de Meta (3 s a 15 min).
- **D8 · Sin `DELETE` en F3:** la API con Instagram Login no lo permite; "Marcar como retirada" con confirmación de que se borró a mano.
- **D9 · La CLI no edita textos:** el editor del panel cubre la edición (F2-T15); la CLI aprueba, quita la aprobación y publica.
- **D10 · Límites de llamadas sin espera automática en F3:** con un operador y pocas publicaciones no se espera alcanzarlos; `IG_RATE_LIMITED` deja `failed` con el aviso de cuándo reintentar. La espera automática es de F6.
- **D11 · El modo lo decide la publicación** (`dry_run`, fijado por la API al pasar a `publishing`): un worker en `live` simula lo pedido en `dry-run`, y uno en `dry-run` no publica lo pedido en `live` (`PUBLISH_MODE_MISMATCH`). Revisión del `arquitecto`.
- **D12 · Portada del reel:** el cuadro del segundo 1 (`thumb_offset`), que muestra el texto del reel, en vez de la portada 4:5 del carrusel. Cambia `docs/04-formato-publicaciones.md`.

### 4.11 Dependencias nuevas
Ninguna. El cliente de Instagram usa `fetch` de Node; el cifrado, `node:crypto`; los tests, `msw` (ya está en el stack).

## 5. Tareas

### F3-T01 · Esquema de publicaciones (migración `0006`)
- **Depende de:** —
- **Archivos:** `packages/core/src/{enums.ts,publication-state.ts,labels.ts}`, `packages/core/src/publication.ts` (nuevo), `packages/db/src/schema.ts`, `packages/db/drizzle/0006_*.sql`, `docs/02-modelo-datos.md` (`apps/web/src/labels.ts` no cambió: las apps no usaban los estados quitados; `docs/01-arquitectura.md` quedó al día con el spec)
- **Descripción:** `PUBLICATION_FORMATS`; estados sin `draft` ni `pending_approval`; `INITIAL_PUBLICATION_STATUSES = ["approved"]` y `PENDING_PUBLICATION_STATUSES`; entidades `Publication` y `PublicationEvent` con esquema zod y el esquema de `progress` de Instagram; migración con el SQL ajustado a mano (§4.7); etiquetas de la web y de core sin los estados quitados.
- **Hecho cuando:**
  - [x] Tests de la máquina de estados (todas las transiciones, válidas e inválidas) y de los conjuntos de estados
  - [x] La migración se aplica en PGlite, recrea el tipo y el único parcial por formato (test con dos activas del mismo formato y una de otro), y `pnpm db:generate` no genera nada después
  - [x] La migración falla con filas en `publications` (test)
  - [x] Probada en Neon dentro de `BEGIN … ROLLBACK` (2026-10-05: tipo recreado e índices nuevos, sin dejar cambios); `publications` con 0 filas
  - [x] Aplicada en Neon justo después del merge (`pnpm db:migrate`, 2026-10-05)
  - [x] Docs 01 y 02 al día

### F3-T02 · Cifrado, firma y variables de Instagram
- **Depende de:** —
- **Archivos:** `packages/config/src/{crypto.ts,env.ts}`, `packages/core/src/redact.ts`, `apps/cli/src/commands/doctor/*`, `.env.example`, `docs/07-checklist-cuentas.md`
- **Descripción:** `SecretBox`, `createSecretBox(APP_ENCRYPTION_KEY)` y `createStateSigner` (§4.6); `INSTAGRAM_*` en lugar de `META_*`; `doctor` avisa si faltan; `redactText` con `code` en URLs y cuerpos de formulario.
- **Hecho cuando:**
  - [x] Ida y vuelta; un byte cambiado, otra clave u otra AAD dan `CREDENTIALS_UNREADABLE`; dos cifrados del mismo texto difieren (IV); vector fijo de HKDF (también contra un HKDF escrito a mano)
  - [x] El `state` firmado vence y no se acepta alterado
  - [x] Tests del redactor (el `code` de una URL se oculta; la clave `code` de un objeto del log, no)
  - [x] Tests del entorno y de `doctor` con las variables nuevas
  - [x] Operador: renombra las variables en `.env` y confirma el par según la nota §2.1 (2026-10-05)

### F3-T03 · Cuentas conectadas: puerto y repositorio
- **Depende de:** T02
- **Archivos:** `packages/core/src/{platform-account.ts,ports/platform-account-repository.ts,ports/secret-box.ts}`, `packages/core/src/testing/*`, `packages/db/src/repositories/platform-accounts.ts`, `docs/01-arquitectura.md`, `docs/02-modelo-datos.md`
- **Descripción:** `upsertConnected` (por corredor, plataforma y cuenta externa), `get`, `listByBroker`, `list`, `getCredentials`, `updateToken` (condicional), `changeStatus` (condicional), `disconnect`. Cifra con el `SecretBox` inyectado y la entidad nunca lleva credenciales.
- **Hecho cuando:**
  - [x] Mismos fixtures para PGlite y el doble en memoria
  - [x] La columna guarda el cifrado (test que lee la fila cruda y no encuentra el token)
  - [x] Reconectar actualiza la fila; desconectar borra las credenciales

### F3-T04 · Publicaciones: repositorio, bitácora y candado por aviso
- **Depende de:** T01
- **Archivos:** `packages/core/src/ports/{publication-repository.ts,listing-lock.ts}`, `packages/core/src/testing/*`, `packages/db/src/repositories/{publications.ts,media.ts,content-runs.ts,contents.ts,listings.ts}`, `packages/db/src/listing-lock.ts`
- **Descripción:** `create` (nace con su evento), `transition` (condicional, con su evento y los campos del cambio: `attempts`, `dry_run`, `external_*`, `last_error`), `saveProgress`, `get`, `listByListing`, `listByStatus`, `listEvents`, `addEvent`. `createListingLock(db, { secretBox })` (§4.2), cuyo `fn` solo recibe repositorios de la transacción.
- **Hecho cuando:**
  - [x] Una transición desde un estado que ya cambió da `INVALID_TRANSITION` sin escribir
  - [x] Fila y evento se escriben juntos o ninguno (rollback probado en PGlite)
  - [x] Una segunda activa del mismo formato da `PUBLICATION_CONFLICT`
  - [x] Una fila que no calza (también un `progress` que no calza con su plataforma) es `PUBLICATION_ROW_INVALID`; `saveProgress` valida con `PUBLICATION_PROGRESS_SCHEMAS` antes de escribir (no reintentable), y el contrato de repositorios de `01-arquitectura.md` lo dice
  - [x] Dentro del candado de Postgres, `arrange`, `upsertDerivative` y `markSucceeded` funcionan como savepoints (PGlite); rollback si `fn` falla, y fila y evento juntos o ninguno (un trigger que hace fallar el evento)
  - [x] El candado en memoria serializa dos `run` del mismo aviso (test)

### F3-T05 · Aprobación en core
- **Depende de:** T03, T04
- **Archivos:** `packages/core/src/use-cases/{approve-content.ts,unapprove-content.ts,open-publications.ts}`, `packages/core/src/content/locked-content.ts` (lo que comparten aprobar, quitar la aprobación y editar). Sin cambios en `ContentRepository`: con el candado, `update` basta para cambiar el estado del texto
- **Descripción:** aprobar, quitar la aprobación y abrir publicaciones (§4.2), dentro de `ListingLock`. Lo que no está en `LockedRepositories` (los campos configurables que pide la revisión editorial) se lee **antes** de `run`.
- **Hecho cuando:**
  - [x] Aprobar con cuenta conectada crea `post` y `reel` (con video) con `content_id` y `media_ids` fijos; sin cuenta, solo aprueba
  - [x] Aprobar un texto nuevo con una publicación `published` del mismo formato salta ese formato y lo informa (el texto queda aprobado)
  - [x] Cada rechazo de §4.2 con su código (no vigente, corrida activa, errores, sin medios, aviso no listo)
  - [x] Quitar la aprobación cancela las pendientes y deja `edited`; con una en `publishing`, `PUBLICATION_IN_PROGRESS`

### F3-T06 · Lo aprobado no cambia: edición y corridas con el candado
- **Depende de:** T05
- **Archivos:** `packages/core/src/use-cases/{edit-content.ts,request-content-run.ts}` (consultan las publicaciones del aviso), sus tests, `apps/api/src/{app.ts,server.ts,testing/index.ts,errors.ts}` (componen el candado y los 409), y los textos de la confirmación al regenerar en el panel y la CLI. El worker no cambia: no pide corridas ni edita
- **Descripción:** las reglas nuevas de `editContent` y `requestContentRun` (§4.2) dentro de `ListingLock`, encolando después del candado.
- **Hecho cuando:**
  - [x] Corrida pedida con publicación pendiente: `PUBLICATION_PENDING`; con un texto aprobado: `CONTENT_EDITED` salvo `replaceEdits`
  - [x] Editar un texto con publicación activa: `CONTENT_LOCKED`; uno aprobado sin publicaciones vuelve a `edited`
  - [x] Test de la ventana de F2: un pedido de textos y una edición concurrentes con el candado en memoria; el job se encola solo después de confirmar
  - [x] Spec F2 §8 y docs 01 al día (la ventana se cerró)

### F3-T07 · Puerto `Publisher` y `dry-run`
- **Depende de:** T01
- **Archivos:** `packages/core/src/ports/publisher.ts`, `packages/core/src/publish/{dry-run.ts,input.ts}`, `packages/core/src/testing/fake-publisher.ts`, sus tests y `docs/01-arquitectura.md` (contrato)
- **Descripción:** contrato (§4.5), `buildPublishInput` (caption y medios desde `media_ids`), `withDryRun` (valida y devuelve un resultado simulado `dry-run:<publicationId>`), `publishAttemptRecord` (lo que se envió o se habría enviado, para la bitácora), publisher falso configurable para los tests.
- **Hecho cuando:**
  - [x] `withDryRun` nunca llama a `publish` del publisher envuelto (test con uno que falla si se le llama)
  - [x] Un `PublishInput` inválido no se "publica" en `dry-run`: devuelve los motivos
  - [x] El registro de `dry-run` no lleva URLs firmadas ni tokens

### F3-T08 · Instagram: cliente de la API y OAuth
- **Depende de:** T02
- **Archivos:** `packages/publishers/` (nuevo: `package.json`, `src/instagram/{graph.ts,auth.ts,errors.ts,constants.ts}`, `test/instagram-server.ts`), `packages/core/src/ports/instagram-auth.ts`, `docs/05-convenciones.md`, `biome.json` y `tsconfig.json` (el paquete nuevo)
- **Descripción:** cliente de `graph.instagram.com` (cabecera `Bearer`, versión fija, parsers tolerantes, `AbortSignal`), clasificación de errores (§4.5), y el puerto `InstagramAuth` de core: `authorizeUrl`, `exchangeCode` (corto → largo), `refresh`, `me`.
- **Hecho cuando:**
  - [x] Tests con msw de cada llamada, con y sin la envoltura `data`
  - [x] Cada fila de la tabla de errores de §4.5 con su código y si se reintenta
  - [x] El `#_` del código se quita; el secret y los tokens nunca aparecen en errores ni logs (test)

### F3-T09 · Instagram: publisher
- **Depende de:** T07, T08
- **Archivos:** `packages/publishers/src/instagram/{publisher.ts,validate.ts}`
- **Descripción:** `validateInstagramInput`, carrusel o imagen suelta, reel, sondeo, cuota, `permalink`, progreso y retoma (§4.4 y §4.5), sobre el cliente de T08. Notas de la revisión de T08: `IG_MEDIA_NOT_READY` (también de `media_publish`) y un estado `UNKNOWN` se atrapan y se sigue sondeando; un `IG_REQUEST_REJECTED` de `publishingLimit` es "sin consultar la cuota" (se anota y se sigue), y los demás errores se propagan; un `media_publish` que no terminó (`IG_UNAVAILABLE`, `IG_ABORTED` o `IG_UNEXPECTED_RESPONSE`) se resuelve siempre por el progreso guardado, nunca creando contenedores nuevos a ciegas.
- **Hecho cuando:**
  - [x] msw: carrusel de 3, imagen suelta, reel con sondeo `IN_PROGRESS` → `FINISHED` y `thumb_offset`
  - [x] Retoma: contenedor `FINISHED` publica sin crear otro; `PUBLISHED` busca el medio; `EXPIRED` rehace; nunca dos `media_publish` sobre el mismo contenedor
  - [x] Sondeo agotado (`IG_CONTAINER_TIMEOUT`), cuota agotada (`IG_PUBLISH_LIMIT`) y corte con `signal`, con relojes falsos

### F3-T10 · Publicar, descartar y retirar en core
- **Depende de:** T05, T07
- **Archivos:** `packages/core/src/use-cases/{publish-listing.ts,start-publication.ts,publication-start.ts,cancel-publication.ts,retire-publication.ts}`, `packages/core/src/jobs.ts`
- **Descripción:** §4.3 sin el intento: publicar el canal o una (con reencolado de una en `publishing`), `dry_run` con el modo de la API, encolar después del candado, descartar, retirar y el estado del aviso al retirar.
- **Hecho cuando:**
  - [x] Publicar abre las que faltan y pasa `approved` y `failed` a `publishing` con su evento; el job se encola después de confirmar
  - [x] Cada rechazo con su código (sin aprobar, sin cuenta, aviso no listo, `NOTHING_TO_PUBLISH`)
  - [x] Retirar en `live` exige la confirmación; retirar la última publicada en `live` devuelve el aviso a `ready`

### F3-T11 · Intento de publicación en core
- **Depende de:** T10
- **Archivos:** `packages/core/src/use-cases/publish-publication.ts`
- **Descripción:** el handler de §4.4 (sin el worker): carga, modo por `publication.dryRun` (`PUBLISH_MODE_MISMATCH`), URLs firmadas, `checkPublishInput` en `live`, progreso, errores, cuenta `expired` ante 190 y el aviso a `active`. Un único `publish_attempt` por intento, al final, con `publishAttemptRecord` en los dos modos. Un corte por la señal (`IG_ABORTED`, apagado del worker) deja la publicación en `publishing` aunque sea el último intento, como `prepareContent` (revisión de T09). El aviso sube a `active` después de guardar `published`, en cada una en `live` (revisión de T10). El evento `publish_attempt` lleva `attempt` (= `attempts`, los pedidos) y `retry` (el reintento de la cola), con el esquema `publishAttemptPayloadSchema` de core.
- **Hecho cuando:**
  - [x] Con el publisher falso: `published` con enlace; error reintentable sigue en `publishing` y en el último intento `failed`; no reintentable `failed`
  - [x] Un job sobre una publicación que no está en `publishing` no hace nada
  - [x] `dry_run = true` con el worker en `live` simula; `dry_run = false` con el worker en `dry-run` da `PUBLISH_MODE_MISMATCH`
  - [x] `dry-run` registra lo que se habría enviado y no cambia el aviso; `live` lo pasa a `active`

### F3-T12 · Job `publication.publish`
- **Depende de:** T09, T11
- **Archivos:** `apps/worker/src/jobs/publication-publish.ts`, `apps/worker/src/worker.ts` (composición de repositorios, `SecretBox` y publishers)
- **Descripción:** cola (§4.4, `exclusive` desde que se crea: la política no se cambia después), publisher de Instagram con el cliente perezoso, `signal` de apagado y reencolado de todas las `publishing` al arrancar. Las notas del publisher (`onNote`, con `publicationId` y sin datos del aviso) y los avisos del intento (`onWarning`: paso y código) van al log; el tope del intento (12 min) queda bajo el vencimiento del job (15 min). Notas de la revisión de T11: `JobContext` suma `retryCount` (hoy solo trae `isLastAttempt`); `publishers.instagram` se registra en los dos modos (una publicación `dry_run` también lo necesita, y el test de "no construye el cliente" corre con el worker en `live`); `errorLogFields` registra solo `code` y `retriable` (la causa de `INTERNAL_ERROR` puede traer datos); un error no reintentable ya dejó la publicación en `failed` (se registra y se cierra el job); el reencolado de las `publishing` va después de `createQueue` (es lo que recupera un `PUBLISH_ABORTED` en el último intento). Seguimiento en ADR-0005 al cerrar.
- **Hecho cuando:**
  - [x] Tests del handler con dobles; política de la cola
  - [x] Una publicación en `dry-run` no construye el cliente de Instagram (test)
  - [x] Logs sin tokens, URLs firmadas ni caption (test)

### F3-T13 · Conectar Instagram
- **Depende de:** T03, T08
- **Archivos:** `packages/core/src/use-cases/{connect-account.ts,disconnect-account.ts}`, `apps/api/src/routes/{oauth.ts,accounts.ts}`, `apps/api/src/contracts/index.ts`, `apps/api/src/app.ts` y `server.ts` (composición, con el mismo `SecretBox` que el candado; en los dobles, el candado recibe el mismo repositorio de cuentas que la app)
- **Descripción:** §4.6 completo: inicio y vuelta del OAuth, `GET /accounts`, desconectar. Como Meta no acepta `http://localhost` (D4), también `connectAccount` desde un token y `POST /accounts/connect-token` (T16 lo expone con `--token-stdin`), con permisos y vencimiento desconocidos (§4.6) y el HTTP de los `IG_*` (§4.8).
- **Hecho cuando:**
  - [x] Callback con `state` correcto guarda la cuenta cifrada; con otro, sin cookie o vencido, `OAUTH_STATE_INVALID` sin llamar a Instagram
  - [x] Rechazo del usuario y falta del permiso de publicar vuelven al panel con su código, a la URL absoluta del panel
  - [x] Las rutas pasan el `hostGuard` con `localhost:8787` y nada de la respuesta lleva tokens
  - [x] Operador: probó la URI en el panel de Meta (nota §3.6): rechazada el 2026-10-05, así que T13 incluye `POST /accounts/connect-token`

### F3-T14 · Refresco de tokens
- **Depende de:** T13
- **Archivos:** `packages/core/src/use-cases/refresh-account-tokens.ts`, `packages/core/src/jobs.ts`, `apps/worker/src/jobs/tokens-refresh.ts`, `apps/worker/src/worker.ts`
- **Descripción:** §4.6 (refresco): job `tokens.refresh` al arrancar y una vez al día, y el refresco a pedido de una cuenta (`force`, síncrono). Una cuenta conectada con el token del panel (`tokenRefreshedAt: null`) se refresca en cuanto pasan 24 h desde `connectedAt`. Notas de la revisión de T12: la cola `tokens.refresh` se crea `exclusive` con un `singletonKey` fijo (el arranque y el cron no se pisan; la política no se cambia después); `WorkerBoss` y `registry.ts` suman `schedule`; si faltan `INSTAGRAM_APP_ID` o `INSTAGRAM_APP_SECRET`, el worker avisa en el log y no refresca, sin dejar de publicar; reutiliza el `platformAccounts` (con su `SecretBox`) que el worker ya compone.
- **Hecho cuando:**
  - [ ] Ventana de refresco (menos de 24 h, entre 24 h y 30 días restantes, vencido) con reloj falso
  - [ ] 190 al refrescar deja la cuenta en `expired`; un error de red no la cambia
  - [ ] El refresco guarda el token nuevo cifrado y el vencimiento

### F3-T15 · API de aprobación y publicaciones
- **Depende de:** T06, T10, T13
- **Archivos:** `apps/api/src/routes/{content.ts,publications.ts,listings.ts}`, `apps/api/src/contracts/index.ts`, `apps/api/src/errors.ts`, `apps/api/src/app.ts`
- **Descripción:** rutas de §4.8 sobre los casos de uso, con la composición de los repositorios nuevos y el candado. Notas de la revisión de T10: `dryRun` sale del `PUBLISH_MODE` de la API, nunca del cuerpo; los códigos de T10 van a `CONFLICTS` (409) en `apps/api/src/errors.ts`; las respuestas quitan `progress` y muestran `requeued`, `stranded` y `listingBackToReady`.
- **Hecho cuando:**
  - [ ] Tests de cada ruta con sus errores y su HTTP
  - [ ] Ninguna respuesta lleva credenciales, URLs firmadas de publicación ni `progress`

### F3-T16 · CLI
- **Depende de:** T15
- **Archivos:** `apps/cli/src/commands/{approve.ts,publish.ts,publications.ts,accounts.ts}`, `apps/cli/src/commands/wait-run.ts`
- **Descripción:** §4.9 (CLI): `approve`, `publish`, `publications` (con `cancel` y `retire`) y `accounts` (con `connect` y `refresh`), y `accounts connect instagram --token-stdin` si T13 lo sumó.
- **Hecho cuando:**
  - [ ] Tests de cada comando con la API simulada; `publish` sale con 1 si queda `failed`
  - [ ] `publish` y `publications retire` en `live` piden confirmación (o `--yes`)
  - [ ] `CLAUDE.md` (Comandos) con los comandos nuevos

### F3-T17 · Panel: Cuentas
- **Depende de:** T13
- **Archivos:** `apps/web/src/pages/AccountsPage.tsx`, `apps/web/src/queries/accounts.ts`, `apps/web/src/routes.tsx`, `apps/web/src/layout/Layout.tsx`
- **Descripción:** §4.9 (Cuentas), con el mensaje de vuelta del OAuth y el enlace directo a la API.
- **Hecho cuando:**
  - [ ] Tests de la página: conectada, vencida, por vencer, sin cuenta y error de vuelta

### F3-T18 · Panel: aprobar y publicar
- **Depende de:** T15
- **Archivos:** `apps/web/src/components/content/*`, `apps/web/src/components/publications/*`, `apps/web/src/queries/{publications.ts,run-poll.ts}`
- **Descripción:** §4.9 (sección Contenido).
- **Hecho cuando:**
  - [ ] Tests: aprobar y quitar la aprobación, publicar, sondeo hasta `published` con enlace, `failed` con su error, descartar y retirar con confirmación
  - [ ] `PolledRun` y `pollStop` (`run-poll.ts`) se generalizan con el inicio de la espera (`startedAt`: `createdAt` para corridas y cargas, `updatedAt` para publicaciones), con test de una aprobada hace días
  - [ ] El editor y el botón Preparar quedan bloqueados con su motivo cuando corresponde

### F3-T19 · `pnpm ig:smoke`
- **Depende de:** T09, T13
- **Archivos:** `apps/worker/src/scripts/ig-smoke.ts`, `package.json`
- **Descripción:** con la cuenta conectada, crea **un** contenedor de imagen desde una URL firmada de R2 de un render de muestra, sondea hasta `FINISHED` o error e imprime el resultado; **nunca** llama a `media_publish`. Comprueba que Meta descarga las URLs firmadas antes de la prueba en `live`. Lo corre el operador.
- **Hecho cuando:**
  - [ ] Test con msw que verifica que nunca se llama a `media_publish`
  - [ ] Salida con el estado del contenedor y el código si falla, sin tokens
  - [ ] `CLAUDE.md` (Comandos) con `pnpm ig:smoke`

### F3-T20 · Cierre de fase
- **Depende de:** todas
- **Descripción:** `/fase-cerrar 3`.
- **Hecho cuando:**
  - [ ] Demos del plan (§7), con la prueba en `live` autorizada por el operador en el chat
  - [ ] `docs/integraciones/instagram.md` con los resultados de la prueba real (los NO VERIFICADO que se resolvieron)
  - [ ] Criterios de §6 con evidencia; auditoría docs-código del `arquitecto`
  - [ ] `CHANGELOG.md` `[0.3.0]`, spec cerrado, `docs/ESTADO.md` apuntando a F4
  - [ ] Tag `v0.3.0` desde `main`, con permiso del operador

Orden: T01 y T02 primero (independientes). T03 después de T02; T04 después de T01. T05 cuando estén T03 y T04, y T06 después. T07 después de T01; T08 después de T02; T09 cuando estén T07 y T08. T10 cuando estén T05 y T07, y T11 después; T12 cuando estén T09 y T11. T13 cuando estén T03 y T08, y T14 después. T15 cuando estén T06, T10 y T13; luego T16, T17 (que solo necesita T13) y T18. T19 cuando estén T09 y T13. Al final, T20.

## 6. Criterios de aceptación de la fase
- [ ] Una propiedad de muestra aprobada aparece publicada en la cuenta de Instagram del operador (carrusel y reel), y el sistema guarda el enlace de cada una (roadmap).
- [ ] En `dry-run`, publicar registra lo que se habría enviado y no llama a Instagram (test y demo).
- [ ] Un texto aprobado no cambia hasta publicarse o descartarse; un texto nuevo pide una aprobación nueva.
- [ ] Los tokens se guardan cifrados y no aparecen en logs, errores ni respuestas; el refresco funciona (tests y demo).
- [ ] Un reintento nunca publica dos veces la misma publicación (tests de retoma).
- [ ] Aprobar, quitar la aprobación y publicar funcionan desde el panel y la CLI.
- [ ] Ningún test llama a Instagram, Mercado Libre, Facebook ni Anthropic; `pnpm check` en verde.

## 7. Plan de demo
1. **Sin publicar nada:** el operador confirma el par `INSTAGRAM_*` y la URI en el panel de Meta (nota §2.1 y §3.6).
2. Conectar la cuenta con el token del panel de Meta (`accounts connect instagram --token-stdin`, D4). Ver `@usuario`, estado y vencimiento en la CLI y en **Cuentas**.
3. **`dry-run`:** aprobar P002 en el panel, publicar y ver las dos publicaciones (carrusel y reel) en `published` con la marca de simulación y lo que se habría enviado. Intentar preparar de nuevo y ver `PUBLICATION_PENDING` antes de publicar; intentar editar el caption aprobado y ver `CONTENT_LOCKED`. Marcar las simulaciones como retiradas.
4. CLI: `approve P001`, `publish P001` (en `dry-run`), `publications P001 --events`.
5. `pnpm ig:smoke` (operador): Meta descarga una URL firmada de R2 sin publicar nada.
6. **`live`, solo con la instrucción del operador en el chat:** `PUBLISH_MODE=live` (en la API **y** en el worker: "worker listo" muestra su modo), publicar P002 (carrusel y reel), abrir los enlaces guardados, borrar las dos publicaciones a mano en Instagram, marcarlas como retiradas y volver a `PUBLISH_MODE=dry-run`. Si una publicación en `live` quedara en `publishing` (un corte), arrancar el worker en `live`: en `dry-run` quedaría `failed` con `PUBLISH_MODE_MISMATCH` y habría que reintentarla en `live`.
7. Refresco: un token recién conectado tiene 60 días y no entra en la ventana (menos de 30 días), así que la demo usa `pnpm -s cli accounts refresh <id> --force` (refresca si tiene más de 24 h, sin mirar la vigencia) y muestra el vencimiento nuevo. La ventana normal la cubren los tests con reloj falso.

## 8. Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| Publicar dos veces por un reintento | Progreso guardado antes de `media_publish`, retoma que consulta el contenedor, `exclusive` por publicación y `IG_PUBLISH_OUTCOME_UNKNOWN` sin reintento automático |
| Meta no acepta la URL firmada de R2 (query larga, `HEAD` o descarga lenta) | `pnpm ig:smoke` antes de `live`; URLs nuevas en cada intento; plan B: prefijo público con dominio propio y vida de 24 h, o subida reanudable para el reel (nota §4.5 y §5) |
| El panel de Meta no acepta `http://localhost` (confirmado) | Token del panel por la entrada estándar (D4); el OAuth se prueba de verdad en F7, con HTTPS |
| El par de variables equivocado (Settings > Basic) | `INSTAGRAM_*` (D5) y la verificación del operador en T02 |
| Un token en un log o en la base sin cifrar | Cifrado en el repositorio, cabecera `Bearer` (no la URL), redactor ampliado y tests que buscan el token en logs, errores y filas |
| Un job encolado antes de confirmar el cambio no encuentra la publicación o la corrida | Se encola después del candado, con test (revisión del `arquitecto`) |
| `PUBLISH_MODE` distinto en la API y el worker | El modo lo decide la publicación (D11) |
| Pérdida de `APP_ENCRYPTION_KEY` | Las credenciales no se leen (`CREDENTIALS_UNREADABLE`) y se reconecta la cuenta; no hay más datos cifrados |
| El token vence porque el worker no corre | Refresco al arrancar, aviso a 10 días en el panel y reconexión simple |
| Lo aprobado cambia por una corrida o una edición | D3: bloqueos y candado por aviso, con tests de concurrencia en memoria (PGlite tiene una sola conexión) |
| La documentación de Meta se contradice (cuota 50 o 100) | Se lee `quota_total`; constantes en un archivo; la nota se corrige con la prueba real |
| Publicar en `live` sin querer | `PUBLISH_MODE=dry-run` por defecto, confirmación en el panel y la CLI en `live`, y la prueba en `live` solo con la instrucción del operador |
| La publicación de prueba queda en la cuenta | Se borra a mano en la demo y se marca como retirada; queda en el plan de demo |

## 9. Preguntas abiertas
Resueltas con la recomendación del spec, por la aprobación permanente del operador (§4.10):
- [x] ¿Cuándo nacen las publicaciones? Al aprobar (con cuenta) o al publicar (D1).
- [x] ¿Qué pasa con textos nuevos después de aprobar? Piden una aprobación nueva; mientras haya publicaciones pendientes no se regenera (D3).
- [x] ¿Tope del reel? 3 a 90 s (D7). ¿`is_ai_generated`? No (D6). ¿`DELETE`? No (D8). ¿Renombrar `META_*`? Sí (D5).
- [x] ¿Cómo conectar en local si Meta no acepta `http://localhost`? Token del panel (D4). Meta la rechazó el 2026-10-05.

Pendientes del operador (no bloquean el inicio):
- [x] Renombrar las variables en `.env` y confirmar el par de Instagram (2026-10-05, nota §2.1).
- [x] Probar la URI `http://localhost:8787/oauth/instagram/callback` en el panel de Meta: rechazada el 2026-10-05 (nota §3.6, D4).

## 10. Registro de cambios del spec
| Fecha | Cambio |
|---|---|
| 2026-10-04 | Borrador inicial (`/fase-plan 3`), con la nota `docs/integraciones/instagram.md` completada (OAuth, publicación, borrado, límites y errores) |
| 2026-10-04 | Revisión del subagente `arquitecto`: se encola después del candado (un job encolado antes de confirmar no veía el cambio); el modo lo decide `publication.dryRun` (`PUBLISH_MODE_MISMATCH`, D11); SQL de la migración `0006` ajustado a mano por el índice parcial; reglas del candado (solo repositorios de la transacción, nada externo adentro); `LISTING_NOT_READY`, `PUBLICATION_CONFLICT`, job `tokens.refresh` y política de `publication.publish`; `validateInstagramInput` pura y cliente perezoso; reel sin `cover_url`, con `thumb_offset` (D12); `INSTAGRAM_CAPTION_MAX_LENGTH` reutilizado; redactor en core y sin ocultar la clave `code` de los logs; OAuth con URL absoluta del panel y enlace directo a la API; sondeo del panel desde `updatedAt`; reencolar las `publishing` al arrancar y al pedirlo; `SecretBox` en config; T05 y T09 partidas (20 tareas) y composición en las apps |
| 2026-10-04 | Spec **aprobado** (aprobación permanente del operador): decisiones D1–D12 con la recomendación del spec. ADR-0014 aceptado; seguimientos en ADR-0005 y ADR-0012; `01-arquitectura.md` (flujos, máquina de estados, contrato `Publisher` y colas), `04-formato-publicaciones.md` (portada del reel), `06-roadmap.md`, `CLAUDE.md` (glosario) y `docs/ESTADO.md` actualizados |
| 2026-10-04 | Revisión del PR (#52) con `revisor` y `arquitecto`: aprobar un texto nuevo salta el formato que ya tiene una publicación activa (sin chocar con el único dentro del candado) y `NOTHING_TO_PUBLISH`; cambios del aviso del sistema y condicionales, y la tabla manual del aviso pasa a F6 (§3); archivos de repositorios en T04 a T06; `publications cancel` y `retire`, confirmación de `publish` en `live` y `accounts refresh --force` (la demo del refresco); `POST /accounts/connect-token` para el plan del token; `broker` validado; `OAUTH_DENIED` no es un `AppError`; `startedAt` en el sondeo del panel; `CLAUDE.md` con los comandos nuevos; nota en `02-modelo-datos.md` hasta T01 y límites de `03-plataformas.md` alineados con D10 |
| 2026-10-05 | Meta rechazó `http://localhost` como dirección de retorno (probado en el panel del operador): en F3 la cuenta se conecta con el token de Generate token (D4, §4.6, T13, T17 y demo 2); el OAuth se implementa y prueba con msw para F7. Se agregaron a la app los permisos `instagram_business_basic` e `instagram_business_content_publish`, que faltaban |
| 2026-10-05 | Desde F3-T01: la migración `0006` se prueba en Neon dentro de `BEGIN … ROLLBACK` antes del merge y se aplica justo después (con `publications` vacía, verificado), no en una rama de Neon, que el proyecto no tiene cómo crear; textos de estados y formatos (`PUBLICATION_STATUS_TEXT`, `PUBLICATION_FORMAT_TEXT`) y tuplas de la bitácora (`PUBLICATION_EVENT_TYPES`, `PUBLICATION_ACTORS`) en core |
| 2026-10-05 | Desde F3-T02: `deriveKey` con sal fija (`agentsales/hkdf/v1`) y `KEY_PURPOSES`; el `state` lleva nonce y vencimiento en base64url (`<datos>.<firma>`); `loadEnv` rechaza las variables `META_*` con su nombre nuevo (en vez de ignorarlas) y valida `INSTAGRAM_REDIRECT_URI` como URL http(s); `doctor` avisa (sin error) si falta el par de Instagram |
| 2026-10-05 | Desde F3-T03: la entidad `PlatformAccount` lleva `hasCredentials` (sin las credenciales); `getCredentials` de una cuenta desconectada es `ACCOUNT_NOT_CONNECTED`, y un cifrado válido con otra forma es `CREDENTIALS_UNREADABLE`; el puerto `SecretBox` pasa a core (Biome no deja que `packages/db` importe `@agentsales/config`, ni siquiera un tipo) y `createSecretBox` lo implementa; `updateToken` mezcla `meta` en la base y no cambia el estado; `markStatus` y `disconnect` devuelven la cuenta; un corredor que no existe es `BROKER_NOT_FOUND` (la FK) |
| 2026-10-05 | Revisión de F3-T03 (#56): `markStatus` pasa a `changeStatus(id, from, to)` condicional y `updateToken` solo escribe con la cuenta `connected` (un refresco no revive una cuenta desconectada); la AAD lleva el corredor (`platform:broker_id:external_account_id`); credenciales vacías son `CREDENTIALS_INVALID` y `meta` se guarda como JSON en los dos repositorios (`normalizeAccountMeta`); una cuenta conectada por corredor y plataforma (T13 desconecta la anterior); esquema de `meta` de Instagram en T13; el doble en memoria puede simular un cifrado ilegible (`corruptCredentials`) |
| 2026-10-05 | Desde F3-T04: `saveProgress` fuera de `publishing` es `PUBLICATION_NOT_PUBLISHING`, y un `payload` de evento que no es objeto, `PUBLICATION_EVENT_INVALID`; `LockedRepositories` suma `brokers` (T05 arma el carrusel con la marca); `created_at` de publicaciones y eventos con `clock_timestamp()` para el orden dentro del candado; el candado en memoria no deshace nada (el rollback se prueba en PGlite) |
| 2026-10-05 | Revisión de F3-T04 (#57): la publicación nace en `dry_run = true` (sin pasarlo) y pasar a `publishing` exige fijar el modo (`PUBLICATION_MODE_REQUIRED`); una FK inexistente al crear es `PUBLICATION_REFERENCE_INVALID`; los dos adaptadores revisan los datos antes que el estado; `updated_at` con `clock_timestamp()`; fila y evento juntos o ninguno probado con un trigger que hace fallar el evento; savepoints de `arrange`, `upsertDerivative` y `markSucceeded` dentro del candado; T05 lee los campos configurables antes del candado |
| 2026-10-05 | Desde F3-T05: `openPublications` solo usa cuentas `connected`; aprobar un texto ya aprobado es idempotente (abre lo que falte); quitar la aprobación de un texto que no está aprobado es `CONTENT_NOT_APPROVED`, y cancela también las `scheduled` y `awaiting_manual_confirm` de ese texto (todo lo que la máquina deja descartar); `ContentCheckDeps.fieldDefinitions` pide solo `list` |
| 2026-10-05 | Revisión de F3-T05 (#58): todas las revisiones (también el plan de publicaciones: `planPublications`) van antes de la primera escritura, así un rechazo no deja nada a medias aunque el candado en memoria no deshaga; aprobar y quitar la aprobación devuelven además `publications` (todas las del canal, leídas en el candado) y `skipped` informa solo formatos ocupados por **otro** texto; `beforeContentLock` y `lockedCurrentContent` en `content/locked-content.ts` (los usará `editContent` en T06); un aviso que no existe es `LISTING_NOT_FOUND` en los dos; tests que fallan si `fn` usa algo de fuera del candado |
| 2026-10-05 | Desde F3-T06: `requestContentRun` ya no tiene el camino `CONTENT_RUN_CONFLICT` → `findActive` (con el candado no hay carrera); `CONTENT_LOCKED` y `PUBLICATION_PENDING` son 409 en la API desde esta tarea, porque ya salen por `PATCH /contents/:id` y `POST /listings/:id/content-runs`; la API compone `createListingLock` (con el `SecretBox`) y sus dobles el de memoria con los mismos repositorios; el worker no cambia (no pide corridas ni edita) |
| 2026-10-05 | Revisión de F3-T06 (#59): el test de la ventana de F2 fuerza los dos órdenes (con una puerta dentro del candado) y comprueba que sin candado la edición se pierde; `CONTENT_LOCKED` dice qué hacer según la publicación (pendiente o publicada); la confirmación de regenerar en el panel y la CLI cubre los textos aprobados; la CLI explica `PUBLICATION_PENDING`; un solo `SecretBox` en `server.ts` para el candado y (T13) las cuentas; test de que el candado de `testDeps` usa los repositorios de la app |
| 2026-10-05 | Desde F3-T07: `PublishInput` lleva `publicationId`, `title` (siempre `null` en Instagram) y medios con su ruta de R2, URL firmada, tipo, tamaño, medidas y duración (`buildPublishInput`, que antes de firmar revisa el texto: `PUBLICATION_CONTENT_MISMATCH`, `CONTENT_NOT_APPROVED`, y los medios: `PUBLICATION_MEDIA_MISSING`); `checkPublishInput` revisa plataforma, formato y `validate` y da `PUBLISH_INPUT_INVALID` con los motivos (un rechazo sin motivos también); `withDryRun` valida y simula; publisher falso `createFakePublisher` |
| 2026-10-05 | Revisión de F3-T07 (#60): lo enviado se registra en **cada** intento, también en `live` (`publishAttemptRecord`, como pide ADR-0014), en un único `publish_attempt` al final (§4.3 y T11), y `withDryRun` ya no tiene `onRecord`; `checkPublishInput` en `live` antes de `publish`, credenciales descifradas en los dos modos y el aviso a `active` por `publication.dryRun` (§4.4) |
| 2026-10-05 | Desde F3-T08: el cliente de la Graph API trae todas las llamadas que usará T09 (`me`, contenedores, estado, `media_publish`, medio, últimos medios y cupo), con tope de 30 s por llamada; el canje del token largo y el refresco mandan el token y el secret en la URL, como los documenta Meta (las demás llamadas usan `Bearer`; se prueba en la demo, nota §8), y esa URL nunca sale en un error; un 400 del canje del código (vencido o usado) es `IG_AUTH_INVALID`; códigos nuevos `IG_MEDIA_NOT_READY`, `IG_REQUEST_REJECTED`, `IG_ABORTED` e `IG_UNEXPECTED_RESPONSE` (§4.5) |
| 2026-10-05 | Revisión de F3-T08 (con `revisor` y `arquitecto`): la excepción del token en la URL queda en §4.5; HTTP 401, 403 y 429 sin código de Meta se clasifican como 190, 10 y 4; un estado de contenedor desconocido es `UNKNOWN` (se sigue sondeando); un token que no cabe en una cabecera es `IG_AUTH_INVALID` sin llamar; `INSTAGRAM_PUBLISH_SCOPE` pasa a core; con el token del panel, permisos y vencimiento desconocidos (`null`, vencimiento estimado y refresco a las 24 h, §4.6); el refresco a pedido es síncrono (seguimiento de ADR-0014); HTTP de los `IG_*` que llegan a la API (§4.8); notas para T09 |
| 2026-10-05 | Desde F3-T09: `validateInstagramInput` revisa también la proporción (4:5 a 1,91:1, como el error 2207009) y da 0,5 s de margen al tope de 90 s del reel (el MP4 dura unas centésimas más); el carrusel sondea los hijos hasta `FINISHED` antes de crear el padre (nota §11.7), y el progreso se guarda al crear el contenedor que se publica, antes de sondearlo; al retomar uno en proceso se espera antes de volver a consultar; un medio ya publicado se busca entre los 10 últimos con el mismo caption y desde 2 min antes del intento; si falla leer el `permalink` después de publicar, queda publicada sin enlace (no se repite); el cupo que no responde se informa con `onNote` (el worker lo registra) |
| 2026-10-05 | Revisión de F3-T09 (#62, `revisor` y `arquitecto`): el medio ya publicado se reconoce también por formato (`media_type` y `media_product_type`, el carrusel y el reel llevan el mismo caption); tope de 12 min por intento y hasta 3 pedidos de `media_publish` si el medio no está listo; la última consulta del sondeo es a los 5 min justos; un contenedor en proceso que ya gastó sus 5 min se rehace; `publishRequestedAt` en el progreso (antes de `media_publish`) para reconocer un pedido sin respuesta; el publisher corre `checkPublishInput`; un progreso ilegible es `IG_PUBLISH_OUTCOME_UNKNOWN` (no se adivina) y su mensaje dice qué hacer; el cupo que responde con un permiso o sin total también se anota, y la nota lleva el `publicationId`; notas para T11 (corte en el último intento) y T12 |
| 2026-10-05 | Desde F3-T10: `publishListing` (el canal) y `startPublication` (una) en `publish-listing.ts`, con `enqueuePublication` (`singletonKey`) y el job `publication.publish` en `jobs.ts`; publicar también rechaza con una corrida activa (`CONTENT_RUN_ACTIVE`, puede reemplazar los medios), solo mueve las de cuentas conectadas (si las pendientes son de una desconectada, `ACCOUNT_NOT_CONNECTED`) y borra el `last_error` anterior al pasar a `publishing` (conserva `progress`); publicar una ya publicada es `NOTHING_TO_PUBLISH`, y una descartada o retirada `INVALID_TRANSITION`; descartar y retirar también corren en el candado; retirar en `live` sin la confirmación es `REMOVAL_NOT_CONFIRMED` (409); si la cola falla, quedan en `publishing` y se informa `QUEUE_UNAVAILABLE` (el worker las reencola al arrancar) |
| 2026-10-05 | Revisión de F3-T10 (#63, `revisor` y `arquitecto`): publicar el canal reencola las que ya están en `publishing` (`requeued`) y `NOTHING_TO_PUBLISH` queda para cuando no hay nada que iniciar ni reencolar (con su mensaje propio si un formato está ocupado por un texto anterior); las pendientes de una cuenta desconectada se informan (`stranded`); una fallida que empezó en `live` no se reintenta en `dry-run` (`PUBLISH_MODE_LOCKED`); se encolan todas aunque una falle, con las que quedaron sin job en `details.publicationIds`; `startPublication` en su archivo (`start-publication.ts`) y revisa también la corrida y su texto; piezas comunes en `publication-start.ts`; el aviso sube a `active` en cada publicada en `live` (T11); `attempts` documentado |
| 2026-10-05 | Desde F3-T11: `publishPublication` (`use-cases/publish-publication.ts`) recibe los publishers por plataforma y el `PUBLISH_MODE` del worker (`workerMode`); sin publisher para la plataforma, `PUBLISHER_NOT_CONFIGURED` (no reintentable); un error que no es `AppError`, `INTERNAL_ERROR` sin su mensaje; un corte por la señal, `PUBLISH_ABORTED` (reintentable) sin tocar nada; un texto que no existe, `CONTENT_NOT_FOUND`. El evento `publish_attempt` lleva `{ mode, attempt, retry, result: published | retry | failed, error?, sent? }` y se escribe antes del cambio de estado; `last_error` y la bitácora quitan rutas y pasan por el redactor. El escenario de pruebas de publicación pasa a `@agentsales/core/testing` (`createPublicationScenario`) |
| 2026-10-05 | Revisión de F3-T11 (#64, `revisor` y `arquitecto`): guardar `published` va aparte de publicar: si falla, `PUBLISH_RESULT_NOT_SAVED` (reintentable) y la publicación sigue en `publishing`, sin marcarse `failed`; la bitácora y el paso a `active` no cortan el intento (`onWarning`), y un paso del job sobre una `published` en `live` vuelve a intentar el `active`; si marcar `failed` falla porque la base no responde, se relanza reintentable; `publishAttemptPayloadSchema` y `publishAttemptRecordSchema` en core; `scrubMessage` en `redact.ts` (lo comparten la corrida de contenido y el intento) con rutas entre comillas, relativas y `.env`; notas para T12 |
| 2026-10-06 | Desde F3-T12: el job `publication.publish` en `apps/worker/src/jobs/publication-publish.ts` (cola `exclusive`, 2 reintentos desde 60 s, 15 min); `JobContext.retryCount`; el worker compone publicaciones, cuentas (con el `SecretBox`), textos y el publisher de Instagram en los dos modos, y reencola las `publishing` después de crear las colas; los ids del doble de publicaciones tienen forma de uuid (los datos del job lo exigen); seguimiento en ADR-0005 |
| 2026-10-06 | Revisión de F3-T12 (#65, `revisor` y `arquitecto`): test del apagado en el último intento (queda en `publishing` y el arranque la reencola); "worker listo" registra el `publishMode`; el log distingue una publicación simulada; `instagramNoteLogger`; sección del job en la arquitectura (reencolar reinicia `retry`, el modo del worker al reencolar, lo que espera al próximo arranque); nota del modo en el paso 6 de la demo; notas para T14 (política de `tokens.refresh`, `schedule`, sin `INSTAGRAM_*`) |
| 2026-10-06 | Desde F3-T13: `upsertConnected(account, { revokeOthers })` desconecta en la misma transacción las demás cuentas del corredor en la plataforma (el puerto cambia; contrato probado en los dos repositorios); `connectAccount` recibe el corredor por su slug y un `grant` (`oauth_code` o `token`); el OAuth siempre vuelve al panel con un código (`OAUTH_DENIED`, `OAUTH_STATE_INVALID`, `OAUTH_CODE_MISSING`, `INSTAGRAM_NOT_CONFIGURED`, `BROKER_NOT_FOUND` o el de Instagram), también desde `start`; la cookie va `Secure` si la URI de retorno es `https`; `connect-token` exige un token de 20 a 4096 caracteres sin espacios; un `POST` sin cuerpo va con `Content-Type: application/json` (el CSRF); `IG_AUTH_INVALID`, `IG_PERMISSION_DENIED` e `IG_REQUEST_REJECTED` son 400 e `IG_UNEXPECTED_RESPONSE` 502; el doble de cuentas acepta `nextId` |
