# X (antes Twitter): API v2 para publicar posts

Nota verificada el 2026-10-19 para planificar F9 (gestor de contenido de redes sociales del operador: cuenta personal de Vinny y marca AgentPey; más adelante, terceros). Solo se leyó documentación pública; no se hizo ninguna llamada a la API ni se usó ninguna cuenta.

Convención: **DOC** = documentación oficial de X (docs.x.com); **SNIPPET** = dato que aparece en un resultado de búsqueda de una página oficial que no se pudo leer (devcommunity.x.com y help.x.com dieron 403; developer.x.com y x.com dieron 402); **PISTA** = blog o foro de terceros, nunca fuente final; **INFERENCIA** = deducido; **NO VERIFICADO** = falta prueba real. Todo lo marcado NO VERIFICADO se prueba con la cuenta del operador (sección 8).

Aviso de método: las páginas se leyeron con una herramienta que extrae y resume el texto, no en el navegador. Las cifras coinciden entre varias páginas, pero las citas literales cortas pueden tener paráfrasis. Antes de codificar algo crítico (tabla de errores, precios), abrir la página y confirmar. **Los precios y las reglas de X cambiaron cinco veces entre febrero y octubre de 2026** (sección 9): nada de lo de esta nota debe quedar fijo en el código.

## 0. Qué hace hoy AgentSales (F9-T16, 2026-10-20)

> **S4 pendiente y obligatoria antes de publicar de verdad.** X se construyó contra simulaciones (msw), por decisión del operador (2026-10-20). Antes de cualquier publicación real en X, el operador hace la prueba **S4** (spec F9 §4.8) con su cuenta y un *spending limit* bajo en la consola: crear un post, ver el saldo descontado, un reply a uno mismo, el rechazo por texto repetido (403, su cuerpo y su ventana) y si un 4xx cobra. Si algo no calza, se ajusta el código antes de publicar. Hasta entonces, X queda en `dry-run` como todo lo demás.

**Conectar (OAuth 2.0 con PKCE, cliente confidencial).**
- `.env`: `X_CLIENT_ID` y `X_CLIENT_SECRET` (el par OAuth 2.0 de la app "Web App" de console.x.com, con permisos de lectura y escritura) y, opcional, `X_REDIRECT_URI`. Sin valor, es `<PUBLIC_URL>/api/oauth/x/callback` en el servidor y `http://127.0.0.1:8787/api/oauth/x/callback` en el Mac (X pide `127.0.0.1`, no `localhost`, §3.1). Esa dirección se registra igual en la app de X.
- `pnpm -s cli accounts connect x --broker <slug>` imprime y abre el inicio (`/api/oauth/x/start?broker=<slug>`, en el host de la dirección de retorno). El inicio pide la sesión del panel **en ese mismo host**: en el Mac, entra al panel por `http://127.0.0.1:5173` (no `localhost`) antes de abrir el enlace. El administrador conecta cualquier marca; un corredor, la suya (permiso `x.connect`).
- El `state` va en la URL firmado con la plataforma y la marca, y es de un solo uso (`oauth_states_used`). El verificador de PKCE va **solo** en una cookie firmada (`__Host-agentsales_oauth_x` con HTTPS), amarrada al nonce de ese `state`: nunca en la URL ni en la base. La vuelta canjea el código (vale 30 s) con el verificador, exige `tweet.write`, `media.write` y `offline.access`, lee `GET /2/users/me` y guarda `{ accessToken, refreshToken }` cifrados; la `meta` lleva el usuario, los permisos y el vencimiento del access token (sin secretos). Reconectar el mismo usuario conserva su tope de gasto.

**Renovar el token.** El access token vive unas 2 h. Al publicar, `ensureRotatingAccessToken` lo renueva si le quedan 30 min o menos, dentro del candado de credenciales; el job diario `tokens.refresh` usa **la misma función**, así un intento y el lote nunca usan el mismo refresh token a la vez. El cliente (`createXAuth`) pone su propio tope de 10 s, supone que el refresh token rota (si X no devuelve uno nuevo, se conserva el anterior) y **solo `invalid_grant`** deja la cuenta vencida; la red, un 5xx, un 429 o el par de la app (`invalid_client`) no la tocan.

**Publicar** (`packages/publishers/src/x`): texto con hasta 4 imágenes (`ig_4x5`, JPEG/PNG/WebP/GIF de hasta 5 MB) o 1 video (el reducido `x_video` de F9-T10, de 0,5 s a 20 min). Antes de marcar "enviando": pide el token y sube los medios desde R2 (imágenes de una vez; el video por partes: INIT, APPEND de 4 MB, FINALIZE y el estado hasta `succeeded`), y guarda sus ids en el progreso (`xMedia`, al lado de `send` y `manual`) para reutilizarlos en un reintento si no vencen en la próxima hora. Después, **una** llamada a `POST /2/tweets` con `sendOnce`:

| Respuesta de X | Qué hace AgentSales |
|---|---|
| 201 | `published` con el id del post y `https://x.com/<usuario>/status/<id>` |
| 402 (sin créditos o tope de la consola) | No enviado: `failed` con `X_PAYMENT_REQUIRED` y el consejo de recargar créditos |
| 429 | No enviado: `X_RATE_LIMITED` con la espera hasta `x-rate-limit-reset`; core la reprograma (hasta 3 veces seguidas) |
| 401 | Pide otro token (`rejectedToken`) y repite **una** vez; si no se puede renovar, no enviado (`X_AUTH_INVALID`) |
| 403 por texto repetido ("duplicate", NO VERIFICADO hasta S4) | **Dudoso**: `outcome_unknown`, nunca "no enviado" (pudo haber salido); el operador dice si salió |
| Otro 403 u otro 4xx | No enviado: `X_FORBIDDEN` o `X_REQUEST_REJECTED` |
| 5xx, corte, tope de tiempo o un 2xx sin el id | Dudoso: `outcome_unknown`, sin reenviar |

Confirmar o resolver a mano acepta el enlace del post (`x.com` o `twitter.com`, `/<usuario>/status/<id>` o `/i/status/<id>`); el lector (`parseXPostUrl`, en core y sin red) deja como `external_id` el id del post, el mismo que guarda el publisher. En `dry-run` no se escribe nada en X: la revisión deja en la bitácora el costo estimado que tendría.

**Enlaces y costo.** Un enlace en X necesita la **marca explícita del operador en el post** (`posts.x_link_allowed`; `PATCH /api/posts/:id` con `{ "xLinkAllowed": true }`): no basta con que el enlace esté en el brief. Sin la marca, la IA no recibe enlaces para X, la revisión da `LINK_NOT_ALLOWED` (no se aprueba) y, si la marca se quita después de aprobar, el intento falla con `X_LINK_NOT_ALLOWED` sin llamar a X. Cada publicación anota su costo estimado en `publications.cost_usd`: US$0,015, o US$0,20 si el texto lleva un enlace (también en `dry-run`, como referencia).

**Tope de gasto.** Cada cuenta tiene `spendLimitUsd` en su `meta` (por defecto **US$10 al mes**, P2): `pnpm -s cli accounts spend-limit <id> <dólares>` (solo el administrador; `POST /api/accounts/:id/spend-limit`). Antes de llamar a X, el intento en `live` suma el `cost_usd` del mes de Chile de la cuenta (las publicaciones en vivo publicando, publicadas, pausadas, retiradas o dudosas; nunca las fallidas, hasta que S4 diga si un 4xx cobra) más el de este post: si pasa el tope, la publicación queda `failed` con `X_SPEND_LIMIT_REACHED` y la causa, sin llamar a la red. El tope duro sigue siendo el de la consola de X.

**Lo que queda para S4 (y después):** el esquema exacto de la autenticación del cliente, si el refresh token rota y la forma del error con uno usado; el texto y la ventana del 403 por texto repetido; si un 4xx o la subida de medios cobran; si la URL de un medio cuenta como enlace; si 720×1280 pasa el máximo de 1280×1024; y el reply a uno mismo (sin hilos en F9). `social:smoke --platform x` no se construyó: S4 se hace a mano, como S5.

## 1. Resumen

- **Mecanismo:** X API v2, `POST https://api.x.com/2/tweets` con un token de usuario (OAuth 2.0 con PKCE, o OAuth 1.0a). No hay SDK obligatorio; basta HTTP. Los medios se suben aparte (`/2/media/upload…`) y se adjuntan por `media_ids`. Madurez media; riesgo **medio-alto** por cambios frecuentes de precio y de política, y por las reglas contra la automatización.
- **Se puede publicar desde un servidor por API oficial: sí.** Texto, hasta 4 imágenes, 1 GIF o 1 video por post, hilos (con la reserva de abajo) y borrado.
- **Costo (DOC):** solo existe **pago por uso con créditos prepagados**, sin suscripción. Crear un post cuesta **US$0,015**; **un post que contiene una URL cuesta US$0,20** (13 veces más, vigente desde el 2026-04-20). No hay tope mensual de escritura documentado; sí un "spending limit" configurable en la consola.
- **Hilos (punto crítico):** desde el 2026-02-23 las respuestas por API en planes self-serve solo se permiten si el autor del post original "invocó" a la cuenta (la mencionó o citó). La doc **no dice** si responderse a uno mismo está exento. **NO VERIFICADO**; hay que probarlo antes de diseñar hilos (sección 4.2).
- **Programar:** la API no tiene programación nativa; el esquema de `POST /2/tweets` no tiene ningún campo de fecha. La programa AgentSales (sección 4.7).
- **Duplicados:** X rechaza texto repetido (sección 7.3). La doc oficial consultada no lo documenta; solo hay PISTAS de terceros.
- **IA:** el Developer Guidelines exige **aprobación previa de X para respuestas (replies) generadas por IA**. Para posts originales con IA no hay regla explícita, pero el encabezado de esa sección es ambiguo (sección 9).
- **Terceros:** cada usuario autoriza nuestra app por OAuth. No se encontró un proceso formal de App Review como el de Meta, pero X "revisa cada uso propuesto", el caso de uso es vinculante, y los planes self-serve están descritos para "aplicaciones con usuarios finales limitados"; más allá se exige Enterprise (sección 11).
- **Pendiente fuera de este archivo:** `docs/03-plataformas.md` no cubre X (esta nota es la primera verificación) y falta agregar la fila de X en `docs/integraciones/README.md`; no se tocaron porque la tarea limitó la escritura a este archivo.

## 2. Requisitos de cuenta y app

| Requisito | Dato | Fuente |
|---|---|---|
| Cuenta de desarrollador | Se crea en `console.x.com` iniciando sesión con una cuenta de X, aceptando el Developer Agreement y la Developer Policy y describiendo el uso previsto | DOC (getting-access) |
| App | "New App" en la consola: nombre, descripción y caso de uso. Genera API Key y Secret, Bearer Token, Access Token y Secret (para actuar como la propia cuenta, OAuth 1.0a) y Client ID y Secret (OAuth 2.0). **Las credenciales se muestran una sola vez**; si se pierden, se regeneran e invalidan las anteriores | DOC |
| Tipo de cliente OAuth 2.0 | Confidencial (con Client Secret): "Web App" y "Automated App or Bot". Público (solo PKCE): "Native App" y "Single Page App". AgentSales (servidor) = **confidencial** | DOC (developer-apps) |
| Permisos de la app | Solo lectura; "Read and write" (publicar y borrar posts, sin DMs); "Read, write and DMs". Para publicar hace falta "Read and write". Si el ajuste también rige para OAuth 2.0 (donde mandan los scopes): NO VERIFICADO | DOC (descritos para OAuth 1.0a) |
| Scopes OAuth 2.0 para publicar | `tweet.write`, `tweet.read`, `users.read`, `offline.access` (refresco) y `media.write` (subir medios) | DOC |
| Plan | **Pago por uso** (créditos prepagados): "No subscriptions—pay only for what you use" | DOC (pricing, about-x-api) |
| Apps por caso de uso | No se pueden registrar varias apps para un mismo caso de uso; se permiten **hasta 3** (desarrollo, staging y producción) y las de desarrollo y staging no se usan en producción | DOC (policy) |
| Revisión o aprobación | La doc de acceso no describe un proceso de aprobación de la app. La Developer Policy dice "We review all proposed uses of the X developer platform" y que la descripción del caso de uso "is binding on you". Plazo y criterio: NO VERIFICADO | DOC + NO VERIFICADO |
| Costos de la cuenta | Sin cuota de alta. Se pagan los créditos (sección 2.1) | DOC |

### 2.1 Planes y precios vigentes (consulta del 2026-10-19)

**Pago por uso (DOC, página de precios; sin fecha en la página, que avisa "Prices are subject to change" y remite a la consola):**

| Operación (por solicitud) | Precio | Nota |
|---|---|---|
| Post: Create | **US$0,015** | |
| Post: Create (with URL) | **US$0,200** | La página no define qué cuenta como URL (NO VERIFICADO si cuenta la URL de un medio o de una tarjeta; una URL en el texto, sí por inferencia) |
| Post: Create (summoned) | US$0,010 | Respuesta a quien mencionó o citó a la cuenta. No aplica a hilos propios (PISTA) |
| Media Metadata (alt text) | US$0,005 | `POST /2/media/metadata` |
| Interaction: Delete | US$0,010 | La página **no tiene** una fila "Post: Delete". Qué fila cobra el borrado de un post: NO VERIFICADO (candidatas: "Interaction: Delete" 0,010 o "Content: Manage" 0,005) |
| Content: Manage | US$0,005 | Sin descripción |
| Lecturas: Posts | US$0,005 por post devuelto | |
| Lecturas propias ("Owned Reads") | **US$0,001 por recurso** | Endpoints `/2/users/{id}/…` cuando `id` es el usuario autenticado **y ese usuario es dueño de la app**: posts propios, menciones, likes, marcadores, seguidores, etc. Las métricas no se mencionan |
| Lecturas: User | US$0,010 | |

- **Subida de medios (`/2/media/upload…`):** no tiene fila de precio en la tabla. Si se cobra: NO VERIFICADO. PISTA: un hilo del foro dice que `append` "no se cobra" aunque falle con 402 en saldo cero.
- **Créditos:** se compran por adelantado y se descuentan con el uso. No hay mínimo mensual. Con saldo negativo "API requests will be blocked until you add credits". Compra mínima, expiración de lo comprado y reembolso: no figuran (NO VERIFICADO).
- **Spending limit (DOC):** se configura por ciclo de facturación en la consola; al alcanzarlo, las solicitudes se bloquean hasta el ciclo siguiente. También hay alertas antes de llegar a los umbrales.
- **Créditos gratis (DOC, changelog 2026-10-02):** US$20 por guardar la primera tarjeta elegible y un abono único de hasta US$50 que iguala la primera recarga automática; una cuenta nueva con ambos recibe US$70. Se gastan antes que los comprados y **caducan a los 3 meses**.
- **Lecturas repetidas:** los recursos se deduplican en una ventana de un día UTC (se cobra una vez), "garantía blanda".
- **Tope de lecturas:** 3 millones de lecturas de posts por ciclo en pago por uso; más requiere Enterprise (sin precio publicado). Irrelevante para este uso.
- **Costo de respuestas fallidas:** una lectura de la página dijo "las respuestas fallidas no se cobran" y otra no encontró esa frase. NO VERIFICADO; confirmar mirando el saldo tras un 4xx provocado a propósito.
- **Planes antiguos:**
  - DOC (changelog 2026-02-06): al lanzar el pago por uso, Basic y Pro "siguen disponibles"; los usuarios activos del plan Free antiguo recibieron un cupón de US$10; las apps de utilidad pública mantienen acceso gratis escalado.
  - SNIPPET (anuncios de @XDevelopers y de devcommunity, páginas no leídas): Basic se migra automáticamente a pago por uso **después del 2026-06-01** (crédito inicial de US$200, recarga automática, tope de gasto de US$400 por ciclo); Pro, **después del 2026-09-01** (US$5.000 y tope de US$10.000). Estas cifras no pasaron por una página oficial leída: NO VERIFICADO.
  - La Developer Policy todavía nombra "planes Free, Basic y Pro"; el texto parece rezagado respecto de la página de precios. No hay plan "gratis" para publicar en lo consultado. Un plan Free con escritura (en el pasado, 500 posts al mes): NO VERIFICADO que exista hoy; no contar con él.
- **Límites de escritura mensuales:** la doc **no publica** un tope de posts por mes para pago por uso (solo el gasto). Las PISTAS de terceros de "17 al día" o "500 al mes" corresponden al plan Free antiguo y no se confirman.

### 2.2 Costo mensual estimado (INFERENCIA con las tarifas de arriba)

| Escenario | Cálculo | Mensual |
|---|---|---|
| 2 posts al día por cuenta, 2 cuentas (120 posts), sin enlaces en el texto | 120 × 0,015 | US$1,80 |
| Igual, todos con enlace | 120 × 0,20 | US$24 |
| Hilo de 5 posts, 1 por día, sin enlaces | 30 × 5 × 0,015 | US$2,25 |
| Métricas de los últimos posts propios, una lectura al día de 30 posts | 30 × 0,001 (si aplica "Owned Reads") | menos de US$1 por cuenta |

La palanca de costo es el enlace: **un solo post con URL cuesta lo mismo que 13 sin ella.** Decisión del operador (sección 12).

## 3. Autenticación

### 3.1 OAuth 2.0 Authorization Code con PKCE (DOC)

- **Autorización:** `GET https://x.com/i/oauth2/authorize` con `response_type=code`, `client_id`, `redirect_uri`, `scope` (separados por espacio), `state`, `code_challenge` y `code_challenge_method` (`S256` o `plain`; usar `S256`).
- **Canje y refresco:** `POST https://api.x.com/2/oauth2/token`. Cuerpo `application/x-www-form-urlencoded`: `code`, `grant_type=authorization_code`, `redirect_uri`, `code_verifier` (y `client_id` si el cliente es público). Para refrescar: `grant_type=refresh_token` y el `refresh_token`.
- **Cliente confidencial:** "You don't need client id for confidential clients with a valid Authorization Header". La página no nombra el esquema; el estándar es `Authorization: Basic base64(client_id:client_secret)`. NO VERIFICADO el esquema exacto.
- **El código dura 30 segundos** desde que la app lo recibe: hay que canjearlo de inmediato (DOC). Mucho más corto que los 1 h de Instagram.
- **Access token:** 2 horas por defecto (DOC).
- **Refresh token:** se emite **solo** si se pide `offline.access` (DOC). **La doc no indica su duración ni si rota.** PISTA (blog de terceros, no oficial): cada refresco devuelve un refresh token nuevo e invalida el anterior (un solo uso), y uno sin usar durante meses caduca. **Diseñar suponiendo rotación:** guardar el par nuevo en la misma transacción que consume el viejo, serializar los refrescos por cuenta (bloqueo o `SELECT … FOR UPDATE`) y no reintentar un refresco con el token viejo. Si la sesión cae (`invalid_request` o similar), marcar la cuenta `needs_reconnect`. La duración real del refresh token y la forma exacta del error: NO VERIFICADO.
- **Scopes (DOC):** `tweet.write` (publicar), `tweet.read`, `users.read`, `offline.access` ("Stay connected to your account until you revoke access"), `media.write` (subir medios). Pedir exactamente: `tweet.read tweet.write users.read media.write offline.access`. No pedir `follows.*`, `like.*` ni `dm.*`: no se usan (y seguir, dar like y citar por API fueron retirados de los planes self-serve el 2026-04-16).
- **Redirect URI (DOC, developer-apps):** coincidencia **exacta** (incluida la barra final), **máximo 10 por app**, `https://` en producción. Para desarrollo local, la doc dice "use `http://127.0.0.1` (not `localhost`)". Entonces: registrar `http://127.0.0.1:8787/oauth/x/callback` para local y `https://<dominio>/oauth/x/callback` para producción (ambos en la misma app). Si el panel acepta otros esquemas y puertos: NO VERIFICADO (se ve al guardar). Un URI no aprobado devuelve error `415 Callback URL not approved for this client application`. Diferencia con Instagram: aquí la doc sí da una vía documentada para local.
- **Identificar la cuenta:** `GET /2/users/me` (`users.read`) devuelve `id` y `username`. Guardar el `id` como `external_id` y el `username` para armar la URL del post. Costo de esa lectura: NO VERIFICADO (la fila "User: Read" es US$0,010).

### 3.2 OAuth 1.0a (DOC)

- Un post se puede hacer con OAuth 1.0a o con OAuth 2.0 PKCE (la página de autenticación dice "only OAuth 1.0a or OAuth 2.0 Authorization Code Flow with PKCE is required to issue requests on behalf of users"). El Bearer Token (solo app) **no** sirve para publicar.
- Los tokens de usuario de OAuth 1.0a **no expiran** (DOC: "do not expire but can be revoked by the user at any time"). La consola entrega "Access Token y Secret" para actuar como la **propia cuenta dueña de la app** sin flujo de autorización.
- Requiere firmar cada solicitud (HMAC-SHA1); no es trivial sin una librería, y la regla del proyecto limita las dependencias al stack. La media v2 acepta el esquema `UserToken` (OAuth 1.0a) según el esquema OpenAPI, pero la guía de subida por partes solo muestra Bearer de OAuth 2.0.
- **Migración (DOC, changelog 2026-09-21):** se puede canjear el token de OAuth 1.0a de un usuario por uno de OAuth 2.0 (con refresh token y `offline.access`) en `POST /2/oauth2/token`, sin nueva pantalla de consentimiento.
- **Recomendación:** OAuth 2.0 PKCE con cliente confidencial para **las dos cuentas** del operador (la personal y AgentPey: solo la dueña de la app podría usar la clave de la consola) y para terceros, con un único flujo.

### 3.3 Consentimiento (DOC, Developer Policy)

"A person authenticating into your service does not by itself constitute consent". Antes de publicar en nombre de alguien hay que **mostrar exactamente lo que se publicará** y obtener permiso. El flujo de aprobación de AgentSales ya cubre esto; la pantalla de conexión debe decir qué hará el sistema.

## 4. Operaciones

Host `https://api.x.com`. Todas con `Authorization: Bearer <token de usuario OAuth 2.0>`.

### 4.1 Crear un post (DOC)

`POST /2/tweets` con JSON. Respuesta **201**: `{"data":{"id":"…","text":"…","edit_history_post_ids":["…"]}}`.

| Campo | Notas |
|---|---|
| `text` | String; por defecto `''`. Obligatorio salvo que se envíe `media`. El esquema no declara longitud máxima (sección 5.4) |
| `media` | `{ "media_ids": [1 a 4 ids], "tagged_user_ids": [hasta 10] }`. Los otros subcampos (`description`, `title`, `call_to_actions`, `embeddable`, `preview_media_id`) son para video/Amplify y no se usan |
| `reply` | `{ "in_reply_to_tweet_id": "…" }` (ver 4.2). `auto_populate_reply_metadata` se acepta pero **se descarta** |
| `reply_settings` | Enum: `following`, `mentionedUsers`, `subscribers`, `verified`. Quién puede responder. Por defecto, todos (INFERENCIA) |
| `made_with_ai` | Booleano: "indica que el Post contiene medios generados con IA". Está en el esquema; no aparece en el changelog ni hay página que explique sus efectos (NO VERIFICADO). Ver sección 9 |
| `paid_partnership` | Booleano; etiqueta de promoción pagada |
| `quote_tweet_id` | **Requiere Enterprise**; no disponible en pago por uso |
| `poll`, `geo`, `card_uri`, `community_id`, `nullcast`, `for_super_followers_only`, `share_with_followers`, `direct_message_deep_link`, `edit_options` | Existen en el esquema; no se usan |

- **Máximo 1 cashtag por post** en cuentas self-serve (DOC).
- **Mensajes 403 documentados:** video más largo de lo que permite la cuenta ("This user is not allowed to post a video longer than 20 minutes."). Los 400 y 429 no tienen mensajes en la especificación.
- **URL del post:** `https://x.com/<username>/status/<id>` (INFERENCIA; la API devuelve solo el `id`; `https://x.com/i/status/<id>` también suele resolver: NO VERIFICADO).
- **Etiquetar o mencionar a otros:** las menciones por programa están restringidas (changelog 2026-02-23: "restrictions on mentioning or quoting users programmatically"). **La plantilla no debe mencionar cuentas ajenas.**

### 4.2 Hilos (reply a sí mismo)

- Mecánica (DOC): el primer post se crea normal; los siguientes llevan `reply.in_reply_to_tweet_id = <id del post anterior>`. La introducción de la API dice que las apps pueden "create threads", pero no explica cómo.
- **Restricción vigente (DOC, changelog 2026-02-23 y página de gestión de posts):** "Replies via the API are only permitted if the replying account has been explicitly summoned by the original post's author" (mención o cita). Se aplica a los planes self-serve (pago por uso); Enterprise queda fuera. Los posts que no son respuestas no cambian.
- **¿Una respuesta a un post propio cuenta como "invocada"? La doc no lo dice.** Ninguna de las dos páginas habla de hilos propios. PISTAS contradictorias: blogs de terceros afirman que las respuestas a los propios posts "no están cubiertas" por la restricción (Hypefury seguiría funcionando con sus respuestas propias); otros dicen que no encontraron confirmación. **NO VERIFICADO. Es la prueba nº 1 de la sección 8**, antes de construir un solo hilo.
- **Plan B si la API rechaza los hilos propios (403):** (a) publicar un solo post largo (solo si la cuenta tiene X Premium, ver 5.4); (b) publicar el contenido como un post con imágenes con texto; (c) dejar el hilo como tarea manual (el sistema redacta y avisa al operador, como ya se hace en Marketplace); (d) Enterprise (descartado por costo).
- Un hilo de N posts son N solicitudes de US$0,015 (más US$0,20 por cada uno con URL) y cada eslabón necesita el `id` del anterior: publicar en orden, guardar el `id` de cada uno y, si falla a la mitad, retomar desde el siguiente (sección 7.4).

### 4.3 Borrar (DOC)

`DELETE /2/tweets/{id}` con `tweet.write`, `tweet.read` y `users.read`. Solo posts del usuario autenticado. Respuesta 200 `{"data":{"deleted":true}}`. Límite de 50 solicitudes por usuario cada 15 min. Costo: NO VERIFICADO (la tabla de la sección 2.1 no tiene una fila "Post: Delete"). Los eslabones de un hilo se borran de a uno.

### 4.4 Editar

El esquema de creación tiene `edit_options.previous_post_id`, pero ninguna página consultada explica el uso, los plazos ni los requisitos (la edición en X está limitada por tiempo y número de ediciones en la app; con la API: NO VERIFICADO). **Tratar "editar" como borrar y republicar**, y avisar de que se pierden métricas y respuestas. Igual que con Instagram, "pausar" y "cerrar" no existen: cerrar = borrar o dejar el post.

### 4.5 Consultar el estado

`GET /2/tweets/{id}` (cuesta US$0,005 por post leído; 450 por 15 min por app y 900 por usuario). Un 404 indica borrado. La publicación en X es **síncrona**: el 201 ya trae el `id`; no hay contenedor ni estado intermedio (a diferencia de Instagram). Solo los medios tienen procesamiento asíncrono (sección 5.1).

### 4.6 Métricas del post publicado (DOC, página de métricas)

| Grupo | Campos | Autenticación | Alcance |
|---|---|---|---|
| `public_metrics` | `like_count`, `reply_count`, `retweet_count`, `quote_count`, `bookmark_count`, `impression_count` | Cualquiera, incluido Bearer de la app | Cualquier post |
| `non_public_metrics` | `url_link_clicks`, `user_profile_clicks`, `engagements` (el ejemplo también trae `impression_count`) | Contexto de usuario | Solo posts propios de **los últimos 30 días** |
| `organic_metrics` | `impression_count`, `like_count`, `reply_count`, `retweet_count`, `url_link_clicks`, `user_profile_clicks` | Contexto de usuario | Solo posts propios, 30 días |
| `promoted_metrics` | Sin detalle | Contexto de usuario | Solo posts promocionados |

- Se piden con `tweet.fields=public_metrics,non_public_metrics,organic_metrics` en `GET /2/tweets/{id}`, `GET /2/tweets?ids=…` o `GET /2/users/{id}/tweets`.
- **Costo:** leer un post cuesta US$0,005 ("Posts: Read"). Las lecturas de los propios posts por `/2/users/{id}/tweets` entrarían en "Owned Reads" (US$0,001 por recurso) **solo si el usuario autenticado es dueño de la app**: sirve para las cuentas del operador, **no** para terceros, que pagarían US$0,005. Si los campos de métricas se cobran aparte: NO VERIFICADO. Medirlo mirando el saldo antes y después de una lectura.
- La deduplicación de 24 h UTC hace que pedir dos veces el mismo post en el día se cobre una vez.
- Ritmo sugerido (INFERENCIA): una lectura a las 24 h y otra a los 7 días de cada post, no un sondeo continuo.

### 4.7 Programar

- **No hay programación nativa en la API de publicación.** El esquema de `POST /2/tweets` (`additionalProperties: false`) no tiene ningún campo de fecha, y ninguna página de la guía menciona la programación (DOC por ausencia). PISTAS de terceros coinciden: la programación existe en la Ads API (`scheduled_at`, requiere cuenta de anuncios) y en la web de X, no en la API v2 de posts.
- **Conclusión:** AgentSales programa con su propia cola (pg-boss), como ya hace para Instagram y Portal. El post se crea en el instante del job y el 201 es la confirmación.
- La programación propia no está prohibida por lo leído (las reglas piden evitar el spam y lo duplicado, no el horario). La regla oficial de automatización (help.x.com) no se pudo leer (403): ver la sección 9.

## 5. Medios

**No exige URL pública:** los bytes se envían a X desde el worker (a diferencia de Instagram). El worker descarga el objeto desde R2 y lo sube. Sin problemas de URL prefirmada.

### 5.1 Subida (DOC, API v2)

| Paso | Método y URL | Detalle |
|---|---|---|
| Subida simple | `POST /2/media/upload` | Cuerpo `multipart/form-data` (bytes) o `application/json` (base64). Campos: `media` (obligatorio), `media_category` (obligatorio), `additional_owners` (opcional). Pensada para imágenes y archivos pequeños. Respuesta: `data.id`, `data.media_key`, `data.expires_after_secs`, `data.size`, `data.processing_info` |
| 1. INIT (por partes) | `POST /2/media/upload/initialize` | JSON: `media_type` (ej. `video/mp4`), `total_bytes`, `media_category`. Devuelve `id` |
| 2. APPEND | `POST /2/media/upload/{id}/append` | `multipart`: `segment_index` (desde 0) y `media` (el fragmento). **Cada fragmento ≤ 5 MB** (la guía; el máximo del servidor es 8 MB; los ejemplos usan 4 MB) |
| 3. FINALIZE | `POST /2/media/upload/{id}/finalize` | Puede devolver `processing_info` |
| 4. STATUS | `GET /2/media/upload?command=STATUS&media_id={id}` | Estados `pending`, `in_progress`, `succeeded`, `failed`; `check_after_secs` dice cuánto esperar. Sin `processing_info`, el medio ya está listo |

- **Video: siempre por partes** ("For video or large media uploads, you must…"). Imágenes y GIF: la subida simple o por partes. Un GIF grande con `media_category=tweet_gif` por partes se procesa de forma asíncrona.
- **No usar `command=INIT|APPEND|FINALIZE` en `POST /2/media/upload`:** es el protocolo anterior (la guía lo advierte). La v1.1 sigue disponible para algunos endpoints de medios, pero está heredada.
- Scope `media.write`. `media_category`: `tweet_image`, `tweet_gif`, `tweet_video` (y `amplify_video`, `dm_*`, `subtitles`, que no se usan). Si se omite, se deduce del tipo.
- `expires_after_secs`: los ejemplos muestran `86400` (24 h). INFERENCIA: usar el medio dentro de ese plazo; subirlo justo antes de publicar.
- **Éxito de subida no garantiza que el medio se pueda adjuntar:** la duración y el tamaño de un video se validan al crear el post y dan 403 si exceden lo que permite la cuenta.
- **Alt text:** `POST /2/media/metadata` con `{"id":"…","metadata":{"alt_text":{"text":"…"}}}`, máximo **1.000 caracteres** y scope `media.write`; cuesta US$0,005. Se usa para accesibilidad (las fotos de propiedades ya tienen descripciones en el sistema).

### 5.2 Imágenes y GIF (DOC)

| Requisito | Valor |
|---|---|
| Formatos | JPG, PNG, GIF, WEBP |
| Peso | **≤ 5 MB** |
| Cantidad | Hasta **4** imágenes por post. No se mezclan imágenes, GIF y video: 4 fotos, o 1 GIF, o 1 video |
| GIF animado | ≤ 15 MB, ≤ 1280×1080, ≤ 350 cuadros, ≤ 300 millones de píxeles (ancho × alto × cuadros). La doc avisa que un GIF puede fallar al crear el post aunque cumpla el peso |
| Proporción de imagen | No figura en la guía de medios de la API. El recorte de la vista previa en el timeline: NO VERIFICADO |

- El carrusel de Instagram (hasta 10 slides de 1080×1350, 4:5) **no cabe tal cual**: X acepta 4 imágenes por post. Hay que elegir cuáles (por ejemplo la portada y las 3 mejores) o repartir en hilo. Decisión del spec de F9.
- Un JPEG de 1080×1350 ronda los 200 a 500 KB (INFERENCIA), muy por debajo de 5 MB.

### 5.3 Video (DOC, guía de buenas prácticas)

| Requisito | Valor |
|---|---|
| Códec | **H.264 High Profile** (recomendado); audio **AAC LC**, mono o estéreo |
| Cuadros por segundo | **≤ 60**; recomendados 30 o 60 |
| Dimensiones | Entre 32×32 y **1280×1024**; recomendadas 1280×720, 720×1280, 720×720 |
| Proporción | Entre **1:3 y 3:1**; recomendadas 16:9 o 1:1 |
| Bitrate | Mínimo recomendado 5.000 kb/s de video y 128 kb/s de audio (recomendación, no requisito) |
| Otros | YUV 4:2:0, barrido progresivo, sin GOP abierto |
| Duración | **Mínimo 0,5 s**. Máximo **20 min** (cuenta normal) o **125 min** (X Premium o verificada) |
| Peso | **8 GB** (cuenta normal) o **16 GB** (Premium o verificada) |

- Los límites de duración y peso siguen el estado Premium de **la cuenta que publica**, no el plan de API (DOC, changelog 2026-09-01). Una cuenta normal que excede la duración recibe 403.
- **Contenedor (MP4 o MOV):** lo dice una copia de terceros de la guía (PISTA); la página oficial leída no nombra el contenedor. Usar MP4.
- **Nuestro reel (`REEL_SPEC`: H.264, yuv420p, 30 fps, AAC estéreo 48 kHz, 128 kb/s, GOP cerrado, 1080×1920) cumple casi todo, pero sus dimensiones podrían exceder el máximo de 1280×1024 de la tabla.** La doc es ambigua (las recomendadas 720×1280 también superan 1024 de alto, lo que sugiere que el máximo se aplica en cualquier orientación a 1280 en el lado largo). 1080×1920 tiene el lado largo de 1920: **NO VERIFICADO**. Plan: recodificar a 720×1280 para X (una variante `x_video` en `media.process`) y comprobar con una subida real (sección 8). **Hecho en F9-T10:** la variante `x_video` de los videos de un post (job `post.media`, `X_VIDEO_SPEC` en `packages/media/src/pipeline.ts`) cabe en 1280×720, 720×1280 o 720×720 sin ampliar, H.264 High 4:2:0 a 30 fps con GOP cerrado, AAC si hay audio y **con la duración completa del original** (no se corta: los máximos de duración y de medidas de X siguen **NO VERIFICADOS** hasta la subida real; el chequeo de la duración contra el límite de la cuenta lo hace T16 al publicar).
- El video corto de un aviso inmobiliario y el reel de marca caben en estos límites con holgura; los 140 s y 512 MB que citan algunas copias de terceros corresponden a mensajes directos o a reglas viejas, no a posts.

### 5.4 Caracteres (DOC y PISTAS)

- **280 caracteres por post** (DOC, "Counting characters"). Cómo cuentan: **toda URL pesa 23** (se acorta con `t.co`, sea cual sea su largo real); **cada emoji pesa 2**; los caracteres CJK pesan 2 (máximo 140); las menciones que X agrega solas al inicio de una respuesta no cuentan, las escritas a mano sí. Las letras con tilde del español pesan 1 (INFERENCIA de las reglas de ponderación de X; la página resumida no las nombra).
- **Cuentas Premium:** el esquema de `POST /2/tweets` no declara un máximo de `text`, y la página de conteo no menciona Premium. PISTAS de terceros (Publer, Ayrshare, Metricool) dan **25.000 caracteres** para cuentas Premium y que a una cuenta sin Premium se le recorta o rechaza; otra nota de 2024 hablaba de 4.000. **NO VERIFICADO oficialmente.** Qué responde la API a un texto largo desde una cuenta normal: NO VERIFICADO. Regla segura: validar **280 ponderados** en código antes de enviar, y tratar el post largo como opción solo si el operador tiene Premium, tras probarlo.
- Se debe implementar el conteo ponderado propio (sin sumar la librería oficial `twitter-text`, por la regla de dependencias). Un test con casos de URL, emoji y tilde.

## 6. Límites

### 6.1 Tasa (DOC, página de rate limits)

| Endpoint | Por usuario | Por app |
|---|---|---|
| `POST /2/tweets` | **100 por 15 min** | **10.000 por 24 h** |
| `DELETE /2/tweets/:id` | 50 por 15 min | no aplica |
| `POST /2/media/upload` | 500 por 15 min | 50.000 por 24 h |
| `POST /2/media/upload/initialize`, `…/append`, `…/finalize` | 1.875 por 15 min cada uno | 180.000 por 24 h cada uno |
| `POST /2/media/metadata` | 500 por 15 min | 50.000 por 24 h |
| `GET /2/tweets/:id` | 900 por 15 min | 450 por 15 min |
| `GET /2/users/:id/tweets` | 900 por 15 min | 10.000 por 15 min |

- **Para este uso los topes de tasa son irrelevantes** (unos pocos posts al día); el freno real es el dinero (sección 2). Los límites de la app (10.000 por 24 h) importarían con muchos terceros: 10.000 posts al día entre todos.
- **Cabeceras (DOC):** `x-rate-limit-limit`, `x-rate-limit-remaining` y `x-rate-limit-reset` (marca de tiempo Unix en que se reinicia la ventana). Los rate limits y la facturación son independientes.
- **Límites mensuales de escritura:** no documentados (sección 2.1). Se controla con el *spending limit*.
- **Premium:** el tamaño y la duración del video dependen de la cuenta, no del plan (5.3).

## 7. Errores comunes

### 7.1 Códigos HTTP (DOC, "Response codes and errors")

El cuerpo de error trae `type`, `title` y `detail` (formato `application/problem+json`); algunos endpoints devuelven `code` y `message`.

| HTTP | Significado | Reintento |
|---|---|---|
| 400 | JSON inválido o parámetros faltantes | **No**: corregir la solicitud |
| 401 | Credenciales inválidas o ausentes (token vencido, revocado o de app) | **No** tal cual: refrescar el token una vez; si falla, `needs_reconnect` |
| 402 | **Créditos agotados** o facturación: cuerpo típico `{"title":"Payment Required","type":"https://api.x.com/2/problems/credits-depleted","detail":"credits depleted","status":402}` (PISTAS de foros de X; la página de errores consultada **no lista el 402**). Hay reportes de 402 con saldo positivo | **No hasta recargar**; avisar al operador. NO VERIFICADO el texto exacto |
| 403 | Autenticado sin permiso: app solo lectura, falta `tweet.write`, video demasiado largo, respuesta no permitida (4.2), **texto duplicado** (7.3) | **No** (salvo el duplicado: ver 7.3) |
| 404 | El post no existe o se borró | No |
| 409 | Solo en *filtered stream* | No aplica |
| 415 | `Callback URL not approved for this client application` (en el flujo OAuth) | No |
| 429 | Límite de tasa **o tope de uso** | **Sí, con espera**: leer `x-rate-limit-reset` y esperar hasta ahí; backoff exponencial |
| 500, 502, 503, 504 | Error de X o servicio saturado | **Sí**, con backoff (pero ver 7.4 antes de reintentar un `POST`) |

- **429 (DOC, página de rate limits):** la respuesta lleva el código de error `88` ("Rate limit exceeded"). Pasos: leer `x-rate-limit-reset`, esperar hasta ese momento y usar backoff exponencial; el ejemplo de la página espera al menos 60 s. La página de códigos agrega que el 429 también cubre el "tope de uso". Que el *spending limit* alcanzado devuelva 429 o 402: NO VERIFICADO.
- Tipos de `Problem` listados en el esquema (DOC): `resource-not-found`, `invalid-request`, `not-authorized-for-resource`, `not-authorized-for-field`, `field-unauthorized`, `disallowed-resource`, `internal-error`, entre otros. La doc no asigna cada uno a un HTTP ni dice cuáles son reintentables más allá de la tabla de arriba (la lista de reintentos sale de la propia tabla y de la lógica de cada error: INFERENCIA).

### 7.2 Política de espera propuesta (INFERENCIA, la fija el spec)

Igual que `IG_RATE_LIMITED` en Instagram: el 429 reprograma la publicación para después de `x-rate-limit-reset` sin gastar reintentos; el 402 y el *spending limit* generan un aviso al operador y detienen las publicaciones de X (no tiene sentido reintentar); el 401 y el 403 son errores de cuenta o contenido y no se reintentan.

### 7.3 Contenido duplicado

- La doc oficial consultada **no documenta** el rechazo por texto repetido: la página de errores solo menciona `duplicate-rules`, que es del *filtered stream*.
- PISTAS (Ayrshare, OpenTweet, bundle.social): X compara el texto con los posts recientes de la cuenta y responde **403** (con un `detail` de tipo "You are not allowed to create a Tweet with duplicate content"; la v1.1 usaba el código 187). Se habla de una ventana de hasta unas 12 horas, de coincidencias casi idénticas y no solo exactas, y de que no hay ventana documentada. **El texto exacto y la ventana: NO VERIFICADO.**
- **Causa más común en la práctica (PISTA):** un reintento tras un timeout de un `POST` que en realidad sí se publicó: el segundo intento recibe 403 por duplicado.
- No usar caracteres invisibles ni variaciones artificiales para "esquivar" la detección: la política prohíbe el contenido idéntico o sustancialmente similar y los intentos de evadir controles de la plataforma (DOC, Developer Policy y Automation rules). Variar el texto de verdad (cada aviso o pieza ya tiene el suyo) y no repetir el mismo mensaje.

### 7.4 Idempotencia al publicar

- **No hay clave de idempotencia documentada** en `POST /2/tweets`.
- Regla propuesta (INFERENCIA, mismo patrón que Instagram): marcar la publicación `publishing` en la base **antes** del `POST`; si la respuesta se corta (timeout o 5xx), **no reenviar a ciegas**: consultar los últimos posts propios (`GET /2/users/{id}/tweets?max_results=5`, US$0,001 por post si aplica "Owned Reads") y comparar el texto; si aparece, guardar su `id` y su enlace. Un 403 por duplicado justo tras un corte se interpreta como "ya salió" y se confirma con la misma lectura.
- En un hilo, guardar el `id` de cada eslabón apenas se crea; retomar siempre desde el primero sin `id`.
- Los medios subidos y no usados caducan solos (24 h, 5.1); reintentar una subida con un `id` nuevo no deja basura permanente.

## 8. Cómo probar sin riesgo

- **No existe un sandbox de publicación en X.** La consola trae un *Playground*, un servidor MCP y los XDK de Python y TypeScript (DOC, changelog 2026-02-06), pero publican de verdad con la cuenta autorizada. Las llamadas cuestan créditos reales.
- **Tests de F9:** msw o fakes con los cuerpos de la sección 4; ningún test llama a X (regla del proyecto).
- **`dry-run` primero:** el publisher arma el cuerpo, valida los 280 ponderados y los medios, y registra lo que enviaría sin llamar a X.
- **Acotar el gasto:** crear la app con créditos mínimos y un *spending limit* bajo (por ejemplo US$5) antes de cualquier prueba; con los créditos gratis de la sección 2.1 las primeras pruebas pueden salir a costo cero.
- **Cuenta de prueba:** una cuenta protegida de X, propia del operador, sirve para ver los posts sin exponerlos; X permite varias cuentas si no se usan para contenido duplicado (Automation rules, SNIPPET). Crearla es un trámite del operador. Alternativa: publicar en la cuenta real y borrar al terminar. El campo `nullcast` ("no aparece en la línea de tiempo pública") podría ocultar un post de prueba, pero está pensado para anuncios: NO VERIFICADO sin cuenta de anuncios.
- **Después de cada prueba:** mirar el saldo y la página de uso de la consola para comprobar lo que se cobró.

### Lista de pruebas (orden de menor a mayor riesgo; todas pendientes)

1. **Redirect URI:** guardar `http://127.0.0.1:8787/oauth/x/callback` y `https://<dominio>/oauth/x/callback` en la app; ver si el panel los acepta y si la pantalla de autorización de X no falla. Intentar también `http://localhost` solo para documentar el rechazo.
2. **Flujo OAuth completo** con la cuenta del operador: forma de la respuesta del canje (`access_token`, `refresh_token`, `expires_in`, `scope`), esquema de la autenticación del cliente confidencial, y `GET /2/users/me`.
3. **Refresco:** confirmar si el refresh token **rota** y la forma del error con un token ya usado; duración real del refresh token.
4. **Un post de texto sin enlace** (`tweet.write`), con la cuenta del operador, y su borrado: comprobar el 201, el `id`, la URL, el cobro de US$0,015 y **qué fila cobra el borrado**.
5. **Un post con URL:** confirmar el cobro de US$0,20, y si el enlace del texto es lo único que cuenta (probar luego imagen sin enlace).
6. **Hilo de 2 posts** (`reply.in_reply_to_tweet_id` al post propio): ¿403 por "no invocada" o pasa? Es la decisión de diseño más importante.
7. **Repetir el mismo texto** (tras borrar el primero) para ver el 403 por duplicado, su cuerpo y la ventana.
8. **Imagen de 4:5, 1080×1350:** subida simple, `media.write`, `media_id` en un post, y si la vista previa recorta; ver si `media/upload` se cobra.
9. **Video del reel (1080×1920, y la variante 720×1280):** subida por partes, `processing_info`, y si la dimensión mayor a 1280×1024 se rechaza.
10. **Texto de 281 a 300 caracteres** desde una cuenta sin Premium: qué responde la API.
11. **Métricas:** `public_metrics` y `non_public_metrics` a los pocos minutos y a las 24 h; costo de la lectura (con "Owned Reads").
12. **Cabeceras de tasa:** registrar `x-rate-limit-*` (solo nombres y valores, sin tokens) en una llamada real.
13. **Saldo cero:** con el *spending limit* mínimo, ver el HTTP y el cuerpo al agotarse (402 o 429).

## 9. Riesgos y términos de uso relevantes

- **Developer Agreement (DOC, "Last Updated: April 27, 2026").** Puntos útiles: X puede suspender el acceso "immediately without notice" por incumplir el acuerdo o por falta de pago; no responde por los daños de la suspensión; los precios pueden cambiar y los cambios rigen desde el período siguiente; los pagos no se reembolsan; prohíbe usar la API o el contenido de X para entrenar o ajustar un modelo de base (excepto Grok); remite a las Automation Rules para las acciones automatizadas.
- **Developer Policy (DOC, sin fecha; "may be changed from time to time without notice"):**
  - Antes de publicar en nombre de una persona: mostrar exactamente lo que se publicará, qué información geográfica se agrega y dónde se publicará (3.3).
  - Prohíbe las acciones masivas, agresivas o spam, y publicar contenido idéntico o muy similar desde varias cuentas.
  - Si se opera una cuenta bot, debe indicar qué es y quién es responsable, y "never mislead or confuse people about whether your account is or is not a bot".
  - Hay que publicar una política de privacidad antes del registro de usuarios (qué datos, cómo se usan y comparten, cómo contactar).
  - Si se guarda contenido de X fuera de la plataforma, hay que mantenerlo al día y borrarlo en 24 h si lo piden o X lo retira. No pedir ni guardar contraseñas de X. Terminado el acceso a la API, borrar los datos de X en 10 días hábiles.
  - No superar ni eludir los límites de tasa.
- **Developer Guidelines (DOC, `docs.x.com/developer-guidelines`):**
  - Actividades prohibidas: spam y manipulación, bots engañosos ("impersonating humans, hiding bot identity, misleading links/redirects"), granjas de cuentas, abuso de límites y **automatización fuera de la API** (scraping y automatización del navegador), cuya sanción es la **suspensión permanente**. **No usar Playwright en X ni siquiera como plan B** (distinto de Marketplace, donde no hay API).
  - Sanciones: "app suspension, API access revocation, or permanent account bans".
  - Cuentas automatizadas: deben activar la etiqueta de perfil **"Automated"**; la descripción del perfil debería decir que es un bot y quién lo opera. Para la cuenta personal del operador y AgentPey, programar posts propios con una herramienta ¿exige la etiqueta? La doc habla de "bots" y de cuentas automatizadas; no distingue las cuentas de una persona que programa sus posts. **NO VERIFICADO; decisión del operador (sección 12).**
- **Contenido con IA (DOC, misma página, sección "AI-Generated Content & Replies"):** "Requires prior approval from X before deployment"; "Deploying AI-generated replies without approval is a violation, even if the content itself is helpful"; ni con aprobación se puede suplantar a humanos. Todas las frases de ejemplo hablan de **respuestas**. El título de la sección ("Content & Replies") deja en duda si la aprobación previa alcanza a los posts originales: **la lectura más directa es que no, pero NO VERIFICADO**. El Developer Agreement y la Policy no tienen sección específica sobre IA. Como los textos de AgentSales se generan con IA y el operador los aprueba antes de publicar (revisión humana), el riesgo parece bajo para posts originales; no automatizar respuestas con IA. Consultar a X por el formulario de Policy Support es una decisión del operador. `made_with_ai` marca medios generados con IA (no texto): usarlo en posts con imágenes o video generados con IA.
- **Automation rules (help.x.com):** la página dio 403 y no se leyó. SNIPPET de la búsqueda sobre las páginas oficiales: se prohíben las publicaciones duplicadas o sustancialmente similares en una cuenta o entre varias que se operan; se puede automatizar varias cuentas para usos relacionados pero no duplicados; las acciones automatizadas sobre la cuenta de otro requieren su consentimiento expreso; los enlaces engañosos están prohibidos en posts o DMs automatizados. **NO VERIFICADO** hasta leer la página con el navegador integrado (como `doc-mercadolibre-con-navegador`); pendiente del operador o de otra pasada.
- **Entrenamiento de modelos:** el Developer Agreement prohíbe usar contenido de X para entrenar o ajustar modelos. Pasar las métricas propias a un LLM para sugerir mejoras no es entrenar (INFERENCIA); evitar guardar contenido ajeno de X y no usarlo como ejemplo de estilo en prompts.
- **Reglas de respuesta y menciones (changelog 2026-02-23):** el sistema no debe generar respuestas ni menciones a cuentas ajenas por programa.
- **Volatilidad de precios y reglas (DOC y SNIPPET):** pago por uso lanzado el 2026-02-06; restricción de respuestas 2026-02-23; precio por post y por URL subido el 2026-04-16 (vigente desde el 2026-04-20); retiro de Basic (después del 2026-06-01, SNIPPET) y de Pro (después del 2026-09-01, SNIPPET); límites por tipo de cuenta 2026-09-01; créditos gratis 2026-10-02. Poner los precios, límites y el conteo de caracteres en **un solo archivo de configuración** de la plataforma, igual que con Instagram, y revisar el changelog cada vez que se planifique una fase.
- **Secretos:** `client_secret`, access y refresh tokens solo en servidor y cifrados; nunca en logs.

## 10. Fuentes (consultadas el 2026-10-19)

Oficiales de X (docs.x.com), leídas con la herramienta de extracción:

- Precios (pago por uso, tabla de operaciones, spending limit, deduplicación): https://docs.x.com/x-api/getting-started/pricing
- Acceso y modelo de cobro: https://docs.x.com/x-api/getting-started/about-x-api y https://docs.x.com/x-api/getting-started/getting-access
- Changelog (2026-02-06, 02-23, 04-16, 09-01, 09-21, 10-02): https://docs.x.com/changelog (se leyeron los primeros 100.000 de 117.586 caracteres)
- Límites de tasa: https://docs.x.com/x-api/fundamentals/rate-limits
- Códigos de respuesta y errores: https://docs.x.com/x-api/fundamentals/response-codes-and-errors
- Tope de posts y gasto: https://docs.x.com/x-api/fundamentals/post-cap
- Crear post (esquema `CreatePostsRequest`): https://docs.x.com/x-api/posts/create-post
- Gestión de posts (hilos, respuestas invocadas, cashtags): https://docs.x.com/x-api/posts/manage-tweets/introduction y https://docs.x.com/x-api/posts/manage-tweets/integrate.md
- Borrar post: https://docs.x.com/x-api/posts/delete-post
- Conteo de caracteres: https://docs.x.com/fundamentals/counting-characters.md
- Métricas: https://docs.x.com/x-api/fundamentals/metrics
- OAuth 2.0 con PKCE: https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code, https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code.md y https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token.md
- Autenticación general y OAuth 1.0a: https://docs.x.com/fundamentals/authentication/overview.md, https://docs.x.com/fundamentals/authentication/oauth-2-0/application-only.md y https://docs.x.com/fundamentals/authentication/oauth-1-0a/obtaining-user-access-tokens.md
- Apps, callback URLs, permisos y tipos de cliente: https://docs.x.com/fundamentals/developer-apps.md
- Medios: https://docs.x.com/x-api/media/introduction (y `.md`), https://docs.x.com/x-api/media/upload-media, https://docs.x.com/x-api/media/quickstart/media-upload-chunked, https://docs.x.com/x-api/media/quickstart/best-practices.md y https://docs.x.com/x-api/media/metadata-create
- Términos: https://docs.x.com/developer-terms/agreement, https://docs.x.com/developer-terms/policy, https://docs.x.com/developer-terms/restricted-use-cases y https://docs.x.com/developer-guidelines

No se pudieron leer (bloqueo 402 o 403 de la herramienta de extracción): https://help.x.com/rules-and-policies/x-automation (Automation rules), https://developer.x.com/en/developer-terms/automation-rules, https://devcommunity.x.com/t/announcing-the-x-api-pay-per-use-pricing-pilot/250253, https://devcommunity.x.com/t/important-update-legacy-x-api-basic-plans-are-moving-to-pay-per-use-ppu/266305, https://devcommunity.x.com/t/important-update-legacy-x-api-pro-plans-are-moving-to-pay-per-use-ppu/273255 y https://x.com/XDevelopers/status/2057572111020134462. Sus datos solo aparecen como SNIPPET de resultados de búsqueda.

Pistas no oficiales (nunca como fuente final):

- Rechazo por texto duplicado: https://www.ayrshare.com/solutions/x-twitter-api-error-403-duplicate-post-how-to-fix-it/ y https://opentweet.io/answers/x-api-403-forbidden-posting (2026-10-19)
- Rotación del refresh token (un solo uso): https://opentweet.io/how-to/fix-x-oauth-refresh-token-expired (2026-10-19)
- Respuestas propias no cubiertas por la restricción de respuestas: https://fireply.ai/blog/x-api-reply-restriction-2026 y https://opentweet.io/how-to/fix-x-api-reply-restriction (2026-10-19)
- Posts largos de 25.000 caracteres con Premium: https://publer.com/docs/posting/create-posts/content-types/platform-specific-formats/twitter-x-long-form-posts (2026-10-19)
- Sin programación nativa en la API v2: https://changelog.zernio.com/blog/schedule-twitter-posts-via-api (2026-10-19)
- Error 402 de créditos agotados: https://devcommunity.x.com/t/credits-depleted-even-though-they-are-filled-up/263753 y https://devcommunity.x.com/t/billing-issue-cannot-post-credits-depleted/278347 (2026-10-19, solo los títulos y extractos de la búsqueda)
- Resumen de precios de terceros (coinciden en US$0,015 y US$0,20 y difieren en el tope de lecturas): https://www.upload-post.com/x-api-pricing/ y https://opentweet.io/x-api-pricing (2026-10-19)
- Especificación de video en una copia de la guía oficial (contenedor MP4 o MOV): https://www.ayrshare.com/docs/media-guidelines/x_twitter.md (2026-10-19)

## 11. Si más adelante se ofrece a terceros

- **Modelo técnico:** una sola app nuestra; cada tercero conecta su cuenta con el mismo flujo OAuth 2.0 (confidencial, `offline.access`). Los redirect URIs son los de nuestro dominio (máximo 10 por app), no uno por tercero. No se usan las credenciales de otros (DOC, Policy: no se pueden usar "API keys or other access credentials owned by others"; con OAuth no hay credenciales ajenas, solo tokens de autorización).
- **Revisión o aprobación de la app:** en lo leído **no hay un App Review formal como el de Meta** para publicar en nombre de otros: la doc de acceso no describe uno. Pero:
  - X "revisa todos los usos propuestos" y la descripción del caso de uso es **vinculante**; un cambio sustancial de uso requiere aprobación previa. Describir bien el caso de uso desde el inicio, y **actualizar la descripción cuando se pase de cuentas propias a terceros**.
  - Los planes Free, Basic y Pro están descritos (en la Policy, aún con esos nombres) para "hobbyists, commercial prototyping, early-stage X product integrations" y "supporting applications with limited end-users"; "beyond this scope, then you must apply (or already subscribe to) an Enterprise plan". No hay un número de usuarios fijo. La Policy agrega que si los inicios de sesión con "Sign in with X" superan "greatly" los niveles normales, X puede exigir Enterprise tras un aviso por escrito. **Un servicio para muchos corredores o creadores es exactamente el caso en que X puede pedir Enterprise** (sin precio publicado; SNIPPET de terceros habla de unos US$42.000 al mes, no confirmado).
  - **"White label" no está permitido** sin notificar y obtener aprobación separada (DOC, Policy y casos restringidos): la marca visible debe ser la de AgentSales (o AgentPey), no la del tercero.
  - Registrar una app por tercero está prohibido ("multiple applications for a single use case").
- **Quién paga:** el costo de cada llamada se carga a los créditos del dueño de la app (INFERENCIA, por los hilos del foro sobre 402 asociados a la cuenta de la app). Hay que cobrar a los terceros por publicación; las "Owned Reads" de US$0,001 **no** les aplican (solo cuando el usuario es dueño de la app): sus lecturas de métricas cuestan US$0,005. Un único *spending limit* y un único saldo para todos obliga a controlar el gasto por tercero en nuestro lado.
- **Tasa por tercero:** los 100 posts por 15 min son por usuario, por lo que un tercero no consume el cupo de otro; el tope de la app es 10.000 posts al día.
- **Datos:** política de privacidad pública, consentimiento previo al publicar, borrado de los datos de X al desconectar (24 h si lo piden; 10 días hábiles al terminar el acceso), y mostrar a cada usuario exactamente lo que se publicará (ya es nuestro flujo de aprobación).
- **Reglas que pesan más con terceros:** la etiqueta "Automated" (cada cuenta de tercero que publica por una app, ¿cuenta como cuenta automatizada?: NO VERIFICADO), el aviso de que no se pueden publicar contenidos idénticos en varias cuentas (una plantilla igual para varios corredores se vuelve riesgo de spam y de duplicados) y la restricción de respuestas.

## 12. Riesgos y recomendación

**Riesgos**

1. **Costo del enlace:** un post con URL cuesta US$0,20 contra US$0,015. Con enlaces en todos los posts, el costo se multiplica por 13.
2. **Hilos:** la restricción de respuestas puede bloquear el reply a uno mismo; no hay confirmación oficial.
3. **Política cambiante:** cinco cambios de precio o de regla en ocho meses; las migraciones de Basic y Pro y el límite de Enterprise para terceros pueden cambiar el modelo de negocio.
4. **Suspensión:** sin aviso previo ("immediately without notice") por automatización excesiva, duplicados, o por tratar la cuenta como bot sin la etiqueta. La cuenta personal del operador es la que se juega.
5. **Texto duplicado y tokens rotatorios:** dos fallas silenciosas típicas (reintentos que duplican; refresh token de un solo uso que se pierde en una carrera).
6. **Lo no verificado pesa:** refresh token (duración y rotación), caracteres para Premium, dimensiones del video, cobro de la subida de medios y del borrado.

**Recomendación**

- **Viable para F9 con las cuentas propias del operador**, con OAuth 2.0 PKCE confidencial, créditos prepagados con un *spending limit* bajo (US$5 a 10 al mes alcanza para decenas de posts sin enlace) y la programación en AgentSales.
- **Diseño sin enlaces en el texto** por defecto (el enlace va en la biografía, o en una imagen); si el operador quiere enlaces, que sea una decisión consciente por post.
- **Sin hilos hasta la prueba 6** de la sección 8; el plan B (tarea manual o post único) debe estar previsto en el spec.
- **No automatizar respuestas ni menciones**; revisión humana siempre antes de publicar (ya existe); `made_with_ai` en medios generados.
- **No usar automatización del navegador en X** (suspensión permanente según la doc).
- **Terceros: aplazar la decisión** hasta ver si X acepta el caso de uso en el plan de pago por uso; contar con que podrían pedir Enterprise. Antes de ofrecerlo, escribir el caso de uso a X y leer las Automation rules con el navegador.
