# LinkedIn (Posts API + OAuth 2.0 de tres patas)

Nota verificada el 2026-10-19 para planificar F9 (gestor de contenido de redes: perfil personal del operador y página de empresa de la marca AgentPey; terceros más adelante). Solo documentación pública; no se hizo ninguna llamada a la API ni se usó ninguna cuenta.

Convención: **DOC** = documentación oficial (learn.microsoft.com/linkedin y páginas legales de linkedin.com); **INFERENCIA** = deducido; **TERCEROS** = blogs o proveedores (solo pista, nunca fuente final); **NO VERIFICADO** = falta prueba real. Lo NO VERIFICADO se prueba con la cuenta del operador (lista consolidada en la sección 8).

Aviso de método: las páginas de `learn.microsoft.com/linkedin` se leyeron con una herramienta que trae el markdown de la página (cifras, nombres de campos y tablas salen tal cual). Las páginas legales (`api-terms-of-use`, `marketing-api-terms`, `user-agreement`, políticas) y la ayuda de LinkedIn salieron **resumidas** por la herramienta: las citas literales de la sección 9 deben confirmarse abriendo la página en el navegador antes de decidir. Las páginas de la doc de marketing se leyeron en la versión `li-lms-2026-10` (la vigente hoy).

## 0. Qué hace hoy AgentSales (F9-T15, 2026-10-20)

<!-- entry-test: S2 pending -->
<!-- entry-test: S3 pending -->
> **S2 y S3 siguen pendientes y son obligatorias antes de publicar de verdad en LinkedIn** (decisión del operador del 2026-10-20, spec F9 §4.8). El código se construyó y se probó **solo contra simulaciones (`msw`)**: ninguna llamada real a LinkedIn. Además, toda cuenta nace en modo **`manual`** (D5): AgentSales no llama a LinkedIn al publicar hasta que el administrador la pase a `api`, y eso se hace solo con S2 y S3 resueltas y anotadas aquí.

- **Consola, ya configurada (2026-10-20 y 21, el operador):**
  - **LinkedIn exige una Página de empresa para crear la app** (lo que §2 dejaba NO VERIFICADO para una app de solo Share on LinkedIn: sí la exige). Se creó la Página "AgentSales" (`linkedin.com/company/agentsales`) y la app "AgentSales" asociada a ella, con la privacidad `https://agentsales.agentpey.com/legal/privacidad`.
  - **La Página verificó la app:** es un paso de la consola; la app queda "verificada" cuando un administrador de la Página la aprueba.
  - Productos activos: *Share on LinkedIn* (Default Tier) y *Sign In with LinkedIn using OpenID Connect*.
  - Direcciones de retorno en Auth: `http://localhost:8787/api/oauth/linkedin/callback` y `https://agentsales.agentpey.com/api/oauth/linkedin/callback`. **LinkedIn aceptó guardar la de `http://localhost`** (§3.3); que el OAuth completo funcione con ella se ve al conectar.
  - El par está en el `.env` del Mac, con `LINKEDIN_REDIRECT_URI` vacía (cuenta como no puesta: sale de `PUBLIC_URL`, o `localhost` en el Mac).
  - **La Página existe solo para tener la app:** AgentSales publica en el **perfil personal** del operador (spec F9, P1) y la cuenta nace a mano. Publicar en la Página seguiría pidiendo Community Management en una app aparte (§2.2).
  - **Falta:** probar la conexión desde el panel (en el Mac, con el panel en `http://localhost:5173`, el host de la vuelta), subir el par a los secretos del servidor, y S2 y S3 antes de pasar la cuenta a `api`.
- **App y variables:** una app en `linkedin.com/developers` con los productos *Share on LinkedIn* y *Sign In with LinkedIn using OpenID Connect* (§2.1). En `.env` (lo anota el operador): `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` y, opcional, `LINKEDIN_REDIRECT_URI` (por defecto `<PUBLIC_URL>/api/oauth/linkedin/callback`, o `http://localhost:<API_PORT>/api/oauth/linkedin/callback` en el Mac; LinkedIn aceptó guardar `http://localhost` en la consola (§0); el OAuth completo se ve al conectar, §3.3). La dirección se registra igual en la pestaña Auth de la app.
- **Conexión (OAuth del perfil personal):** el botón **Conectar LinkedIn** de Cuentas en el panel (F9-T19) o `pnpm -s cli accounts connect linkedin --broker <slug>` abre `GET /api/oauth/linkedin/start?broker=<slug>` en el navegador donde está la sesión del panel (el administrador conecta cualquier marca; un corredor, solo la suya, con el permiso `linkedin.connect`). El inicio firma el `state` con la plataforma y la marca, lo deja en la cookie `__Host-agentsales_oauth_li` (con HTTPS; `HttpOnly`, `Lax`, 10 min) y manda a LinkedIn con `openid profile w_member_social`. La vuelta (`/api/oauth/linkedin/callback`, pública y fuera del CSRF) exige el `state` igual al de la cookie, firmado, vigente, de LinkedIn y **sin usar** (`oauth_states_used`), canjea el código en el servidor, exige `w_member_social` si LinkedIn informa los permisos, lee `/v2/userinfo` (el `sub` es la cuenta externa y el autor `urn:li:person:<sub>`, INFERENCIA de §2.1) y guarda `{ accessToken }` cifrado con `token_expires_at` a 60 días. **No se renueva sola:** la agenda avisa 7 días antes ("token por vencer", F9-T08) y se reconecta igual. Reconectar el mismo perfil conserva el modo que tenía. Termina en Cuentas del panel (`?conectada=linkedin&proveedor=linkedin` o `?error=<código>&proveedor=linkedin`).
- **Modo:** `pnpm -s cli accounts mode <id> manual|api` (solo el administrador; pasar a `api` pregunta antes, `--yes`). **Pasar a `api` solo después de S2 y S3**; el sistema no lo impide: la barrera real hoy es `PUBLISH_MODE=dry-run` (en `dry-run` una cuenta en `api` tampoco escribe en LinkedIn). En `manual`, a la hora programada el reloj deja la publicación en `awaiting_manual_confirm` con el texto y los medios listos, **sin llamar a LinkedIn**; el operador publica en LinkedIn y confirma con el enlace (`publications confirm <id> --url-stdin`) o **sin enlace** (`publications confirm <id> --no-url`, F9.5: el `external_id` queda `manual:<id de la publicación>`, sin `external_url`; sin enlace no se abre el post desde Seguimiento y no se puede borrar por la API). El lector `parseLinkedInPostUrl` (core, sin red) acepta `/feed/update/<urn>/` (la barra de direcciones) y el enlace largo `/posts/…-activity-<número>-…` (a donde redirige el corto `lnkd.in`, que no se acepta) y guarda el URN como `external_id`, el mismo formato que guarda el publisher. Ojo: el enlace copiado trae un URN `activity`, que no es el `share` que crea la API.
- **Publicar en modo `api`** (`packages/publishers/src/linkedin`): `POST https://api.linkedin.com/rest/posts` con `Linkedin-Version: 202610` (vence el 2027-10-15; un test avisa 60 días antes) y `X-Restli-Protocol-Version: 2.0.0`, autor `urn:li:person:<sub>`, `visibility: PUBLIC`, `MAIN_FEED`, `PUBLISHED`. El `commentary` va con los 15 caracteres reservados escapados (`escapeLinkedInText`, de core) y los hashtags escritos como texto (`\#tema`). Texto solo; **imagen** (`/rest/images?action=initializeUpload`, `PUT` de los bytes con `Bearer` a la URL que da LinkedIn) en `content.media`; **varias imágenes** (2 a 20) en `content.multiImage`; **video** MP4 (`/rest/videos?action=initializeUpload`, partes de 4 MiB leídas de R2 con `Range`, `PUT` de cada una, `finalizeUpload` con los `ETag` en orden y la espera de `AVAILABLE` cada 5 s hasta 5 min) en `content.media`. Los bytes solo se suben a URLs `https` de `linkedin.com` (nunca el token a otro host). Los URN subidos quedan en el progreso de la publicación: un reintento los reutiliza.
- **Abrir el editor con el texto puesto (flujo a mano, F9.5): NO VERIFICADO.** El botón «Copiar texto y abrir LinkedIn» abre `https://www.linkedin.com/feed/?shareActive=true&text=<texto codificado con encodeURIComponent>` en otra pestaña (`noopener`; un enlace normal, sin automatizar el navegador) y copia el texto al portapapeles como respaldo. Que `shareActive=true` abra el editor «Crear una publicación» y que `text=` lo rellene (saltos de línea, hashtags, tildes, emojis) lo afirman terceros; **ninguna página oficial de LinkedIn lo documenta** y puede cambiar sin aviso. Con un enlace de más de 1.800 caracteres se abre el editor vacío (`?shareActive=true`) y el texto va solo por el portapapeles. **Prueba del operador, un clic y sin publicar:** con un post esperando confirmación, tocar el botón y mirar (a) si abre el editor, (b) si trae el texto con sus saltos de línea y hashtags, (c) si las tildes y los emojis llegan bien; cerrar el editor sin publicar. Si falla, el flujo sigue sirviendo con el portapapeles. Anotar aquí el resultado y la fecha.
- **Resultado y errores:** se publica una sola vez con `sendOnce` (ADR-0029 punto 8). `external_id` es el URN de `x-restli-id` y `external_url`, `https://www.linkedin.com/feed/update/<urn>/`. Lo que prueba que no salió (un 4xx o no llegar a conectar) quita el "enviando": 401 `LINKEDIN_AUTH_INVALID` (la cuenta queda vencida: reconectar), 403 `LINKEDIN_FORBIDDEN`, 422 y otros 4xx `LINKEDIN_REQUEST_REJECTED`, 400 `FIELD_LENGTH_TOO_LONG` → `LINKEDIN_TEXT_TOO_LONG`, `MEDIA_ASSET_WAITING_UPLOAD` → `LINKEDIN_MEDIA_NOT_READY` (reintentable, conserva lo subido), un medio inválido → `LINKEDIN_MEDIA_REJECTED` (se olvida lo subido), 426 `LINKEDIN_VERSION_DEPRECATED`, 429 `LINKEDIN_RATE_LIMITED` con `waitMinutes` (60 sin `Retry-After`: core reprograma). Un 409 (`LINKEDIN_CONFLICT`: que no salió es NO VERIFICADO, S2), un 5xx, un corte o un 201 sin URN son **dudosos**: `outcome_unknown`, sin reenviar; el operador revisa su perfil y dice si salió.
- **Borrar (F9-T19):** `DELETE /rest/posts/{urn}` con `X-RestLi-Method: DELETE` (`deleteLinkedInPost`; un 404 cuenta como borrado; solo URN `share` o `ugcPost`). Con la cuenta en modo `api` y la API en `live`, `pnpm -s cli publications retire <id> --delete` lo borra y la deja retirada (pregunta antes; `--yes`). En `dry-run` nunca se llama. Con la cuenta a mano, o un post confirmado con el enlace de «Copiar enlace» (URN `activity`), se borra a mano y se retira sin `--delete`. Si `DELETE` acepta un URN `activity` es parte de S2 (5).
- **Qué deben confirmar S2 y S3** (los números son de §8): **S2**, con el generador de tokens y la cuenta del operador: (1) que un token de solo Share on LinkedIn publica en `/rest/posts` con `Linkedin-Version: 202610`; (3) que `urn:li:person:<sub>` de `/v2/userinfo` es un autor válido; (4) si `GET /rest/videos/{urn}` responde con solo `w_member_social` (si da 403, el publisher ya sigue sin esperar); (5) que `/feed/update/urn:li:share:<n>/` abre el post, y si `DELETE` acepta un URN `activity`; (8) un texto con los 15 caracteres reservados y 3.000 caracteres; (9) un video 9:16; (10) el verbo y las cabeceras de la subida de una imagen (`PUT` con `Bearer`); y (2) si la app acepta `http://localhost` como dirección de retorno. **S3:** la respuesta escrita de LinkedIn Developer Support sobre el §3.1(26) de los API Terms (¿un calendario propio que publica a la hora cuenta como "automatizar publicaciones"?). Si S3 no la permite, LinkedIn queda siempre en `manual`. El resultado se anota aquí y en `docs/ESTADO.md`; si algo no calza, se corrige el publisher antes de pasar una cuenta a `api`.

## 1. Resumen

- **Mecanismo:** REST de LinkedIn, `POST https://api.linkedin.com/rest/posts` (**Posts API**), con las cabeceras obligatorias `Linkedin-Version: AAAAMM` y `X-Restli-Protocol-Version: 2.0.0`. Medios por subida de bytes a una URL que LinkedIn entrega (Images, Videos y Documents API): **no hace falta URL pública** (a diferencia de Instagram). Madurez alta; riesgo medio-alto, por los términos (ver 9) y no por la técnica.
- **Perfil personal (DOC):** el producto **Share on LinkedIn** es de acceso inmediato (self-serve, "Open Permissions", sin aprobación) y da `w_member_social`. Pero la página oficial de ese producto aún documenta el endpoint viejo (`/v2/ugcPosts` y `/v2/assets`), de 2023. Que un token de solo Share on LinkedIn funcione contra `/rest/posts` (el endpoint vigente) **no lo dice ninguna página oficial que haya leído**; lo afirman varios terceros: NO VERIFICADO, se prueba en minutos con el generador de tokens.
- **Página de empresa (DOC):** `w_organization_social` **no** es abierto. Viene solo con **Community Management API** (o Advertising API), un producto "vetted" con nivel Desarrollo y nivel Estándar. LinkedIn exige **organización legal registrada, uso comercial, correo de empresa verificado, sitio web y dominio verificados, y la app verificada por un super admin de la Página**. No hay camino documentado para una persona natural.
- **Endpoint vigente (DOC):** la Posts API "reemplaza" a `ugcPosts`; la página de `ugcPosts` se titula "(Legacy)"; Images, Videos y Documents API reemplazan a la Assets API. No encontré fecha de cierre de `ugcPosts` ni de `/v2/assets` para apps self-serve: NO VERIFICADO.
- **Tokens (DOC):** access token de **60 días**. Refresh token programático **solo para socios MDP aprobados**; una app self-serve debe volver a pasar por la autorización (sin pantalla si el miembro sigue con sesión y el token no venció). Hay que prever reconexión cada 60 días.
- **Programar:** la API **no** tiene programación nativa (el esquema del post no tiene ningún campo de fecha futura; `lifecycleState` solo acepta `PUBLISHED` al crear). La cola y el calendario son de AgentSales.
- **Texto:** 3.000 caracteres (DOC solo en la página legacy de `ugcPosts`), con **escape obligatorio** de `| { } @ [ ] ( ) < > # \ * _ ~` en el campo `commentary` (formato "little text").
- **Punto crítico de términos (DOC, resumen de la herramienta):** los API Terms de la API self-serve prohíben "usar el Contenido o las APIs para automatizar publicaciones en LinkedIn" (§3.1(26)). Choca de frente con un programador automático sobre `w_member_social`. Ver sección 9; es la decisión principal del operador.
- **Sin sandbox** (DOC por omisión): las publicaciones son reales; solo hay perfiles de prueba para el miembro, no páginas de prueba.

## 2. Requisitos de cuenta y app

| Requisito | Dato | Fuente |
|---|---|---|
| Cuenta | Una cuenta de miembro de LinkedIn por persona (perfil personal). Para la Página, ese miembro debe tener rol en ella: `ADMINISTRATOR`, `DIRECT_SPONSORED_CONTENT_POSTER` o `CONTENT_ADMIN` para `w_organization_social` | DOC (posts-api) |
| App | Se crea en `linkedin.com/developers/apps`. Cada app tiene Client ID y Client Secret (pestaña Auth). Las autorizaciones y productos son por app | DOC |
| Página asociada a la app | La guía de Community Management pide crear una Página y asociarla a la app; un **super admin** de la Página debe **verificar** la app. El formulario de creación de una app simple (solo Share on LinkedIn) **también la exige**: comprobado por el operador el 2026-10-20 (§0) | DOC (quick-start, community-management-app-review) + prueba real |
| Costo | Ninguno documentado para Share on LinkedIn ni para Community Management. No hay tabla de precios | DOC por omisión |
| Plazo de aprobación | **No figura en la doc.** Para las APIs restringidas, "caso por caso, sin plazo fijo". Para Community Management Desarrollo/Estándar no hay cifra | NO VERIFICADO |

### 2.1 Perfil personal: Share on LinkedIn (self-serve)

- **DOC (getting-access):** "Open Permissions are the only permissions that are available to all developers without special approval". Tabla de permisos abiertos: *Sign in with LinkedIn using OpenID Connect* (`profile`, `email`, más `openid`) y **Share on LinkedIn** (`w_member_social`: "Post, comment and like posts on behalf of an authenticated member"). Se agregan solos en la pestaña **Products** de la app.
- **Alcance real de `w_member_social` (DOC):** crear publicaciones, comentar y dar "me gusta" como el miembro. **No** permite leer publicaciones propias: `r_member_social` es **restringido** y "closed" (la FAQ de Community Management dice: "We're not accepting access requests at this time"). Tampoco da métricas (ver 5 y 6).
- **Identificar al miembro:** con el producto OpenID Connect (abierto), `GET https://api.linkedin.com/v2/userinfo` devuelve `sub`, `name`, `picture`, etc. El autor del post es `urn:li:person:{id}`. Que `urn:li:person:{sub}` sea ese mismo id: **INFERENCIA** (la página de Share on LinkedIn remite a OIDC "para obtener el Person URN", pero no escribe la fórmula; el discovery document declara `subject_types_supported: pairwise`, es decir, el id es propio de la app). `/v2/me` (Profile API) quedó "restringido a desarrolladores aprobados" y no sirve.
- **Un solo usuario:** la app self-serve sirve para cualquier miembro que la autorice, sin límite de roles ni modo desarrollo (no hay un "modo desarrollo" de la app como en Meta). Límite de elegibilidad de la API self-serve: la app no debe esperar "más de 100.000 usuarios de por vida" (API Terms §1.4).

### 2.2 Página de empresa: Community Management API

- **DOC (community-management-app-review, increasing-access):**
  - "Our Community Management APIs are only available to **registered legal organizations for commercial use cases only**."
  - Se pide: correo de empresa (verificado; "personal email addresses won't pass the vetting process"), nombre legal, dirección registrada, sitio web y política de privacidad.
  - Revisión del nivel **Desarrollo**: caso de uso aprobado, correo verificado, organización verificada, sitio web y dominio verificados, y app verificada por la Página de esa misma organización.
  - Si la solicitud se rechaza: "You won't be able to re-apply... with your existing app"; hay que crear otra app y otra solicitud.
  - La app no debe incluir "Linked" ni "In" ni logos de LinkedIn/Microsoft.
- **Niveles (DOC, increasing-access):**

| Nivel | Qué es | Límites | Cómo se pide |
|---|---|---|---|
| Desarrollo | Nivel por defecto. "Developers are expected to build core business use cases... within twelve (12) months of the provisioning" | **500 llamadas por app y 100 por miembro, cada 24 h**; **BATCH_GET: ninguna llamada**; webhooks de acciones sociales desactivados | Formulario de acceso (pestaña Products) |
| Estándar | Capacidad completa, sin restricciones, "for live production" | Sin restricciones | Segundo formulario + **video de pantalla** que muestre el flujo OAuth, publicar en la Página, ver comentarios y qué datos personales se muestran, + credenciales de prueba. "LinkedIn reserves the right to review applications and select partners at its discretion" |

- **¿Sirve una app de desarrollo de un solo usuario sin aprobación completa?** **No hay camino sin revisión.** El nivel Desarrollo ya es una aprobación (organización legal, dominio, correo de empresa). Una vez aprobado, 500 llamadas al día alcanzan de sobra para una Página propia. Pero la doc lo describe como nivel para "construir y probar" con **12 meses** para terminar la integración, y no dice qué pasa al cumplirse ese plazo si no se sube a Estándar: NO VERIFICADO. Subir a Estándar requiere video y además "Valid privacy policy".
- **Restricción práctica (DOC, FAQ de Community Management):** el acceso a Community Management "only [for] new developer applications that don't have access to other API products" (la opción sale en gris si la app ya tiene, por ejemplo, Share on LinkedIn). Hay que usar una **app nueva y limpia** para Community Management; la app de Share on LinkedIn queda aparte.
- **Permisos que trae Community Management (DOC):** `w_member_social`, `w_organization_social`, `r_organization_social`, `rw_organization_admin`, `r_member_postAnalytics`, `r_member_profileAnalytics`, `*_social_feed` y otros. O sea, una app con Community Management cubre **perfil personal y Página** con un solo OAuth (y el perfil personal es un caso de uso reconocido: "Profile Management" / "Executive Management").
- **Descartado como atajo:** la Advertising API también da `w_organization_social`, pero exige su propia aprobación y es para anuncios.
- **Rol del miembro en la Página:** además del scope, el miembro que autoriza debe tener rol en la Página (`ADMINISTRATOR`, `CONTENT_ADMIN` o `DIRECT_SPONSORED_CONTENT_POSTER`, DOC de posts-api). Los accesos a la Página no se conceden por API: se hace en la interfaz de LinkedIn (DOC, quick-start). Para listar las Páginas del miembro: `GET /rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED` (permiso `rw_organization_admin` o `r_organization_admin`, es decir, solo con Community Management). El id de la organización también sale de la URL de administración de la Página: INFERENCIA, no documentado en lo leído.

## 3. Autenticación

### 3.1 Flujo OAuth 2.0 authorization code (DOC, authorization-code-flow)

1. **Autorización:** `GET https://www.linkedin.com/oauth/v2/authorization` con `response_type=code`, `client_id`, `redirect_uri`, `scope` (codificado, separado por espacios; el miembro acepta todo el paquete, no elige) y `state` (opcional en la doc; usarlo siempre contra CSRF). Si cambian los scopes de la app, los usuarios deben reautorizar.
2. **Redirección:** `?code=...&state=...`. El `code` **dura 30 minutos** y se usa una vez. Errores: `user_cancelled_login`, `user_cancelled_authorize`.
3. **Canje:** `POST https://www.linkedin.com/oauth/v2/accessToken` con `Content-Type: application/x-www-form-urlencoded` y `grant_type=authorization_code`, `code`, `client_id`, `client_secret`, `redirect_uri` (idéntico al del paso 1). Esto va **en el servidor**: lleva el secret.
4. **Respuesta:** `access_token` (~500 caracteres; prever 1.000 o más), `expires_in` (5.184.000 s = **60 días**), `scope`, y **solo si la app tiene refresh tokens**, `refresh_token` y `refresh_token_expires_in`.
5. Si se pide un scope distinto al ya concedido, **todos los tokens anteriores quedan invalidados**; con el mismo scope se pueden tener varios tokens válidos a la vez.

### 3.2 Duración y refresco

| Dato | Valor | Fuente |
|---|---|---|
| Access token | 60 días ("Currently, all access tokens are issued with a 60-day lifespan"; "LinkedIn does not generate long-lived access tokens") | DOC |
| Refresh token programático | **Solo "approved Marketing Developer Platform (MDP) partners"** (programmatic-refresh-tokens) y "a limited set of partners" (authorization-code-flow). Vence a los **365 días fijos** desde la autorización; al usarlo, el access token nuevo trae otros 60 días pero el refresh token **no se extiende** (al día 360 vencen ambos en 5 días y el miembro debe reautorizar). LinkedIn puede revocarlos "at any time" | DOC |
| ¿Recibe refresh token una app self-serve? | **No según la doc** (no figura entre los beneficios de Share on LinkedIn). ¿Lo recibe una app con Community Management en nivel Desarrollo o Estándar? La doc no lo dice (¿"MDP partner" = Community Management aprobado?) | NO VERIFICADO; se ve mirando si llega `refresh_token` en la primera respuesta |
| "Refresco" sin refresh token | Repetir el flujo de autorización: si el miembro sigue con sesión en linkedin.com **y** el token actual no ha vencido, LinkedIn se salta la pantalla y redirige solo; si no, vuelve al flujo normal | DOC |
| Cuota de refrescos | Si se usa refresh token, hay una cuota diaria por app (se ve en el panel; reinicia 00:00 UTC) | DOC (developer-portal-tools) |

**Implicación de diseño (INFERENCIA):** sin refresh token, el sistema debe avisar de la reconexión con antelación (por ejemplo desde el día 50) y ofrecer un botón "Reconectar LinkedIn" que lance el flujo con `state`; como el miembro no tiene que re-aceptar si sigue con sesión, el costo para el operador es un clic. Un token vencido (401) obliga a reconectar. Los tokens se guardan cifrados (API Terms §4.2 permite guardarlos; §7.1(a) pide cifrado en tránsito y en reposo).

### 3.3 Redirect URI y `http://localhost`

- **DOC:** se agrega en la pestaña **Auth** de la app. Debe ser **absoluta**, "via HTTPS" según el texto del paso 1; los parámetros de consulta se ignoran; no puede llevar `#`; debe coincidir con una registrada. Para pruebas con Postman la doc sugiere `https://oauth.pstmn.io/v1/callback`.
- **`http://localhost`:** la doc oficial **no lo dice** (ni lo acepta ni lo prohíbe). Varios terceros (CData, guías de la comunidad) lo usan con `http://localhost:PUERTO/...`. **Se guarda:** el 2026-10-20 el operador registró `http://localhost:8787/api/oauth/linkedin/callback` en Auth > Authorized redirect URLs y LinkedIn lo aceptó (a diferencia del panel de Meta). Que el OAuth completo vuelva bien a esa dirección: NO VERIFICADO hasta la primera conexión.
- **Alternativas si lo rechaza (de menos a más esfuerzo):**
  1. **Token Generator del Developer Portal** (DOC, developer-portal-tools): `linkedin.com/developers/tools/oauth/token-generator`; eliges app, flujo y scopes, el miembro aprueba y copias el token (60 días). Sin redirect. Sirve para la demo con la cuenta del operador, igual que "Generate token" en Instagram. Que el generador ofrezca `w_member_social` para una app con solo Share on LinkedIn: NO VERIFICADO (lo normal es que sí, "los scopes disponibles dependen de los productos de la app").
  2. Registrar la URL HTTPS del servidor de F8 (el dominio propio) y usar el flujo real en producción.
  3. Túnel HTTPS en local.
- **Inspector de tokens (DOC):** el Developer Portal tiene "Token inspector" (y un endpoint de introspección) para ver vigencia y scopes de un token.

## 4. Operaciones

Todas las llamadas llevan `Authorization: Bearer <token>`, `Linkedin-Version: 202610` (ver 4.1) y `X-Restli-Protocol-Version: 2.0.0`. Los URN que van en la ruta o en la consulta se codifican (`urn%3Ali%3Ashare%3A123`). Host: `https://api.linkedin.com/rest/...`.

### 4.1 Endpoint vigente y versionado

| Tema | Hecho | Fuente |
|---|---|---|
| Vigente | **Posts API** `POST /rest/posts`. "The Posts API replaces the ugcPosts API" (posts-api, ugc-post-api, contentapi-migration-guide). Images / Videos / Documents API reemplazan a la Assets API | DOC |
| Deprecado/legacy | `POST /v2/ugcPosts` (página titulada "UGC Post API (Legacy)"), `/v2/shares` (Share API) y `/v2/assets?action=registerUpload`. La página de Share on LinkedIn (consumer/self-serve, última actualización 2023) **sigue mostrando `/v2/ugcPosts` y `/v2/assets`**, sin cabecera de versión. Una fecha de cierre para esas rutas en apps self-serve: no la encontré (el aviso de cierre de la doc aplica a "partners with Marketing permissions only") | DOC |
| Cabecera | `Linkedin-Version: AAAAMM` obligatoria; "the latest version is not applied by default" (no existen llamadas sin versión). Sin cabecera: error. Con versión cerrada: **HTTP 426** "Version Header is Deprecated" | DOC (versioning, error-handling) |
| Ciclo de vida | Una versión nueva cada mes; "supported and stable for a minimum of one year before sunset". Hoy la última es **202610** (octubre 2026, cierre 2027-10-15). 202511 cierra el 2026-11-16; 202601, el 2027-01-15; 202510 y anteriores ya figuran "Deprecated". Migrar = cambiar el valor de la cabecera y revisar el changelog de cada recurso. LinkedIn se reserva parches por seguridad o privacidad dentro de la ventana | DOC (migrations, versioning) |
| Recomendación | Constante configurable `LINKEDIN_API_VERSION` (por defecto `202610`) y revisión anual (INFERENCIA). Un test que falle si pasan más de ~10 meses sin revisarla sería barato | INFERENCIA |
| Respuesta de creación | `201` y cabecera **`x-restli-id`** con el URN: `urn:li:share:…` o `urn:li:ugcPost:…` (la doc admite ambos, sin decir cuándo cada uno) | DOC |

### 4.2 Crear una publicación (`POST /rest/posts`)

Campos del esquema (DOC, post-api-schema):

| Campo | Obligatorio | Detalle |
|---|---|---|
| `author` | sí (al crear) | `urn:li:person:{id}` o `urn:li:organization:{id}` |
| `commentary` | sí | Texto en formato "little" (sección 5.3). Texto vacío: `INVALID_VALUE_BLANK_FIELD` |
| `visibility` | sí | `PUBLIC`, `CONNECTIONS` (1er grado), `LOGGED_IN`, `CONTAINER` |
| `distribution` | sí | `{ "feedDistribution": "MAIN_FEED", "targetEntities": [], "thirdPartyDistributionChannels": [] }`. `NONE` solo para anuncios ("dark posts"). Segmentación (`targetEntities`): audiencia mayor de 300 miembros, solo organizaciones |
| `lifecycleState` | sí | Al crear solo se acepta `PUBLISHED`. En respuestas: `DRAFT`, `PUBLISHED`, `PUBLISH_REQUESTED` (se publica de forma asíncrona al terminar el procesamiento), `PUBLISH_FAILED` ("An edit is required in order to re-attempt publishing") |
| `isReshareDisabledByAuthor` | no (`false`) | |
| `content` | no | Uno de: `media`, `poll`, `multiImage`, `article`, `reference`; ver 4.3 |
| `contentCallToActionLabel`, `contentLandingPage` | no | Botón de llamado a la acción (`LEARN_MORE`, `SIGN_UP`, `BUY_NOW`, etc.; `BUY_NOW` y `SHOP_NOW` desde 202504). Pensado para anuncios; su efecto en orgánico: NO VERIFICADO |
| `reshareContext.parent` | solo reposts | URN del post a compartir |

Permisos por tipo de autor (DOC): `w_member_social` para `urn:li:person:*`; `w_organization_social` para `urn:li:organization:*`, "Restricted to organizations where the authenticated member has one of the following company page roles".

### 4.3 Tipos de contenido

Matriz orgánica (DOC, posts-api): texto, imagen, video, documento, artículo, **MultiImage** y **encuesta**: sí. **Carrusel**: no (solo anuncios). Celebration: sí en la matriz, pero "currently, celebration post can't be created through external api".

| Tipo | Flujo | Detalle |
|---|---|---|
| Texto | `POST /rest/posts` sin `content` | |
| Imagen | 1) `POST /rest/images?action=initializeUpload` con `{"initializeUploadRequest":{"owner":"urn:li:person:…"}}` → `value.uploadUrl`, `value.image` (`urn:li:image:…`), `uploadUrlExpiresAt`. 2) Subir los bytes a `uploadUrl` (el ejemplo oficial usa `curl --upload-file` con `Authorization: Bearer`, que es un PUT; la página de Share on LinkedIn dice POST: confirmar el verbo). 3) `POST /rest/posts` con `content.media = { "id": "urn:li:image:…", "altText": "…" }` | `SYNCHRONOUS_UPLOAD` no está soportado. Estado del recurso: `WAITING_UPLOAD`, `PROCESSING`, `AVAILABLE`, `PROCESSING_FAILED` |
| Varias imágenes | Igual que imagen, y `content.multiImage = { "images": [ { "id": "urn:li:image:…", "altText": "…" }, … ] }` | **Mínimo 2 y máximo 20**; `altText` por imagen. Es el equivalente del carrusel de Instagram |
| Video | 1) `POST /rest/videos?action=initializeUpload` con `{"initializeUploadRequest":{"owner":"…","fileSizeBytes":N,"uploadCaptions":false,"uploadThumbnail":false}}` → `value.video` (`urn:li:video:…`), `uploadInstructions[]` (cada parte con `firstByte`, `lastByte`, `uploadUrl`), `uploadToken`, `uploadUrlsExpireAt`. 2) Partir el archivo en trozos de **4.194.304 bytes** (la primera parte es 0–4194303) y subir cada uno con **PUT** (`Content-Type: application/octet-stream`); guardar el `ETag` de cada respuesta. 3) `POST /rest/videos?action=finalizeUpload` con `{"finalizeUploadRequest":{"video":"urn:li:video:…","uploadToken":"<token>","uploadedPartIds":["<etag1>","<etag2>"]}}` en el mismo orden. 4) Esperar `AVAILABLE` (`GET /rest/videos/{urn}`). 5) `POST /rest/posts` con `content.media = { "id": "urn:li:video:…", "title": "…" }` | Las URL de subida vencen en ~30 días; subir con una vencida da 401/`EXPIRED_UPLOAD_URL`. Subtítulos: un solo archivo SRT, solo inglés. Miniatura propia opcional (`uploadThumbnail`) |
| Documento (PDF) | 1) `POST /rest/documents?action=initializeUpload` → `value.document` (`urn:li:document:…`) y `uploadUrl`. 2) Subir el archivo (ejemplo oficial: `curl -i --upload-file Mydoc.pdf -H 'Authorization: Bearer …'`). 3) `POST /rest/posts` con `content.media = { "id": "urn:li:document:…", "title": "Nombre.pdf" }` (**`title` obligatorio** para documentos) | PPT, PPTX, DOC, DOCX y PDF; **máximo 100 MB y 300 páginas**. En el feed se ve como carrusel deslizable (es la alternativa orgánica a un carrusel de imágenes) |
| Encuesta | `POST /rest/posts` con `content.poll = { "question": "…", "options": [ {"text":"…"}, … ], "settings": { "duration": "THREE_DAYS" } }` | Pregunta hasta **140 caracteres**; **2 a 4 opciones** de hasta **30 caracteres**; `duration`: `ONE_DAY`, `THREE_DAYS`, `SEVEN_DAYS`, `FOURTEEN_DAYS`; solo `SINGLE_VOTE`; **no se puede editar**; el autor ve quién votó; prohibido preguntar opiniones políticas, de salud u otros datos sensibles |
| Artículo con enlace | 1) Subir la miniatura con Images API (opcional). 2) `POST /rest/posts` con `content.article = { "source": "https://…", "title": "…", "description": "…", "thumbnail": "urn:li:image:…", "thumbnailAltText": "…" }` | **No hay scraping de la URL**: título, descripción y miniatura los pone la app. `source` y `title` obligatorios; `title` menos de 400 caracteres; `description` y `thumbnailAltText` menos de 4.086 |
| Compartir un post (repost) | `reshareContext.parent` | |

### 4.4 Editar

`POST /rest/posts/{urn}` con `X-RestLi-Method: PARTIAL_UPDATE` y cuerpo `{"patch":{"$set":{"commentary":"…"}}}`; éxito `204` (DOC). Campos editables: **`commentary`**, `contentCallToActionLabel`, `contentLandingPage`, `lifecycleState` y partes de `adContext`. **No** se pueden cambiar medios, visibilidad ni encuestas. `isEditedByAuthor` pasa a `true`. El permiso exacto de edición no se lista aparte (se asume el mismo `w_*_social`): NO VERIFICADO.

### 4.5 Borrar

`DELETE /rest/posts/{urn}` con `X-RestLi-Method: DELETE`; éxito **`204`**; es idempotente (borrar uno ya borrado también da 204); no hay borrado en lote (DOC). Permiso: la doc no lo detalla; `w_member_social` / `w_organization_social` según el autor (INFERENCIA, se prueba).

### 4.6 Pausar, cerrar, consultar estado

- **Pausar:** no existe (no hay estado "pausado" en `lifecycleState`). INFERENCIA. Lo más cercano: borrar y volver a publicar, o cerrar comentarios (`POST /rest/socialMetadata/{urn}?actor=…` con `commentsState: CLOSED`; **borra los comentarios existentes**; el permiso exacto no queda claro entre los `*_social_feed`: NO VERIFICADO).
- **Cerrar** = borrar (o dejar de gestionar). Las encuestas se cierran solas al vencer su duración.
- **Estado:** `GET /rest/posts/{urn}?viewContext=AUTHOR` devuelve `lifecycleState` y `lifecycleStateInfo` (`contentStatus` `PENDING`/`PROCESSING`/`FAILED`, `reviewStatus`). **Lo que sí está claro:** listar por autor (`q=author`) exige `r_member_social` (cerrado) para personas y `r_organization_social` para organizaciones. **Lo que no está claro:** si un token con **solo `w_member_social`** puede hacer un `GET` de un post por URN. La doc de Images API dice que un token con solo `w_member_social` "would be unable to perform a GET call for rest/images" en el gateway versionado (es de escritura). Por analogía, `GET /rest/posts/{urn}` y el polling de estado de imágenes pueden dar 403 en una app self-serve: **NO VERIFICADO, prueba obligatoria** (ver 8).
- **Enlace al post (DOC):** `https://www.linkedin.com/feed/update/{urn}/` (la doc lo da con `urn:li:ugcPost:…`; con `urn:li:share:…` debería ser igual: INFERENCIA, se prueba). Guardar siempre el URN de `x-restli-id`.
- **Idempotencia:** no hay clave de idempotencia documentada. Un `POST /rest/posts` cuyo resultado se perdió (timeout, 5xx tras enviar) **puede haber publicado**. Con una app self-serve no se puede listar los posts propios para comprobarlo (`r_member_social` cerrado). Tratar un timeout de creación como estado incierto y pedir al operador que revise su perfil antes de reintentar (INFERENCIA).

## 5. Medios, texto y métricas

### 5.1 Medios (DOC)

| Medio | Límites | Nota |
|---|---|---|
| Imagen | JPG, PNG, GIF (hasta 250 cuadros). **Menos de 36.152.320 píxeles**. El peso máximo en MB no figura en la Images API (NO VERIFICADO). `altText` hasta 4.086 caracteres (recomendado menos de 120) | Nuestras imágenes de 1080x1350 (1,46 Mpx) caben de sobra. Las imágenes del carrusel de Instagram sirven para `multiImage` sin reprocesar |
| Video | MP4; **3 s a 30 min; 75 KB a 500 MB** (sección "Video File Size Specifications"). La tabla de campos dice "Maximum allowed Videos size is 5GB": contradicción en la misma página. **Usar 500 MB** hasta confirmar. Proporciones y códecs para video orgánico: no los da la API (remite a la ayuda de LinkedIn de anuncios de video): NO VERIFICADO | El reel de Instagram (9:16, 1080x1920, H.264/AAC, `faststart`) debería aceptarse; se prueba |
| Documento | PPT, PPTX, DOC, DOCX, PDF; 100 MB; 300 páginas | |
| Encuesta | ver 4.3 | |
| URL pública | **No.** Se sube por bytes desde el worker a la URL de subida | Quita el riesgo de URLs firmadas de R2 que había en Instagram. El worker debe leer el objeto de R2 y subirlo (las partes de video de 4 MiB se pueden leer con *range requests*) |

### 5.2 Subida: detalles que importan

- Los recursos nacen en `WAITING_UPLOAD` y pasan por `PROCESSING` a `AVAILABLE`. Crear el post con un recurso que no está listo da `MEDIA_ASSET_PROCESSING_FAILED` / `MEDIA_ASSET_WAITING_UPLOAD` (400): esperar y reintentar (ver 7). Para video, hacer polling a `GET /rest/videos/{urn}` hasta `AVAILABLE` (o `PROCESSING_FAILED` con `processingFailureReason`).
- Un token solo con `w_member_social` puede no poder consultar `GET /rest/images/{urn}` (ver 4.6). Si es así, el flujo de imagen debe confiar en el reintento de `POST /rest/posts`.
- El propietario (`owner`) del recurso debe coincidir con el `author` (para personas "the caller must match the owner"; para organizaciones, rol de administrador o equivalente).

### 5.3 Texto (`commentary`) en formato "little" (DOC, little-text-format)

- **Largo:** 3.000 caracteres. **DOC solo en la página legacy de `ugcPosts`**: "The maximum length of the text of a UGC Post is 3,000 characters". La página de la Posts API no da cifra (el error `FIELD_LENGTH_TOO_LONG` no la menciona). Los terceros coinciden en 3.000. **INFERENCIA que aplica igual**; validar en código con un margen y no contar mal el texto con los escapes (si el límite cuenta la cadena escapada o la visible: NO VERIFICADO). En la interfaz solo se ven ~210 caracteres antes de "ver más" (TERCEROS): la idea fuerte va al principio.
- **Caracteres reservados que hay que escapar con barra invertida** (gramática `Text` de la doc): `|` `{` `}` `@` `[` `]` `(` `)` `<` `>` `#` `\` `*` `_` `~`. Regla literal: "All reserved characters need to be escaped with a backslash, even if those characters are not used in one of the supported elements or templates". En JSON la barra va doblada: el texto `Precio (UF) #1` se envía como `"Precio \\(UF\\) \\#1"` (en el ejemplo oficial de viñetas: `"\\* Point 1"`). Los saltos de línea van como `\n` normal de JSON.
  - **Consecuencia:** el texto que redacta la IA, con paréntesis, guiones bajos, asteriscos, `#`, `@`, etc., **debe pasar por una función `escapeLittleText()` antes de enviarse**, y el contrato debe separar "texto plano" de "texto con menciones/hashtags". Test unitario con los 15 caracteres.
- **Hashtags (DOC):** escribir `#palabra` en el texto se convierte en hashtag (la API lo devuelve como plantilla `{hashtag|\#|palabra}`). Para enviar un hashtag explícito: `{hashtag|\#|palabra}`. Para un `#` literal: `\#`. **No hay máximo de hashtags documentado**: NO VERIFICADO.
- **Menciones (DOC):** `@[Nombre](urn:li:organization:123)` o `@[Nombre](urn:li:person:abc)`. El texto entre corchetes debe coincidir con el nombre **con mayúsculas y minúsculas** o se muestra como texto normal; en organizaciones debe ser el nombre completo; en personas basta con uno de los nombres. Las menciones a personas requieren su URN, que se obtiene con la API *People Typeahead* (`posts-atmention-search-api`, parte de Community Management); sin eso, solo se pueden mencionar organizaciones cuyo URN ya se conoce. **No hay máximo de menciones documentado**: NO VERIFICADO. No mencionar cuentas ajenas sin decisión del operador (notifican).
- **Emojis y largo en UTF-16:** no documentado: NO VERIFICADO.

### 5.4 Métricas y lectura (qué requiere qué)

| Qué | Endpoint | Permiso | Disponible para |
|---|---|---|---|
| Estadísticas de un post propio (impresiones, alcance, reacciones, comentarios, reposts, guardados, envíos, clics en enlaces, seguidores ganados, vistas de perfil) | `GET /rest/memberCreatorPostAnalytics?q=entity&entity=(share:urn%3Ali%3Ashare%3A…)&queryType=IMPRESSION&aggregation=TOTAL` (o `q=me` para todos los posts) | **`r_member_postAnalytics`** | **Solo con Community Management** (no con Share on LinkedIn). Las métricas nuevas (`POST_SAVE`, `LINK_CLICKS`, etc.) desde 202604 |
| Estadísticas de la Página | `GET /rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=urn%3Ali%3Aorganization%3A…` (también por `shares=List(…)`) | `rw_organization_admin` (rol `ADMINISTRATOR`) | Community Management. Solo datos orgánicos; ventana móvil de **12 meses** |
| Reacciones y comentarios (resumen) | `GET /rest/socialMetadata/{urn}` | `r_organization_social_feed` / `r_member_social_feed` (este último "granted to select developers only") | Community Management; el de miembro, restringido |
| Leer o listar los posts de una persona | `GET /rest/posts?q=author&author=…` | **`r_member_social`**: restringido y "closed" | **Nadie nuevo** |
| Leer los posts de una Página | mismo endpoint | `r_organization_social` | Community Management |

Conclusión: con **solo Share on LinkedIn no hay métricas ni lectura** del perfil personal. El tablero de resultados del perfil personal exige Community Management (que a su vez exige organización legal), o se llena a mano.

Almacenamiento (DOC, data-storage-requirements, aplica a datos *leídos* por la API del programa de marketing): URN e IDs, sin límite; actividad social de **miembros** (publicaciones, comentarios, menciones y sus metadatos), **48 horas**; datos de perfil de otros miembros, **24 h** de caché; actividad social de **organizaciones**, 6 semanas (6 meses si la organización autenticó la app); datos de administración y reporte de la Página (sin datos individuales), **1 año**. No aplica a lo que tú mismo generas (el texto que AgentSales redacta). Que el recuento de métricas de un post personal cuente como "actividad social de miembros": NO VERIFICADO; no guardar comentarios ni datos de quienes comentan.

## 6. Límites

| Límite | Valor | Fuente |
|---|---|---|
| Ventana | 24 h; **reinicia a medianoche UTC** (21:00 o 20:00 en Chile según horario). Dos tipos: por **aplicación** y por **miembro** (por app) | DOC (rate-limits) |
| Share on LinkedIn (página del producto, 2023) | Miembro: **150 solicitudes/día**; Aplicación: **100.000/día** (UTC) | DOC. Si rige también para `/rest/posts`: NO VERIFICADO |
| API Terms (self-serve) | Sin cuota explícita, el tope por defecto es 100.000 llamadas diarias; intentar superar o eludir los límites (por ejemplo con varias apps) está prohibido (§1.4(4), §3.1(20)) | DOC (resumen) |
| Community Management, nivel Desarrollo | **500 por app y 100 por miembro, cada 24 h**; `BATCH_GET` sin llamadas | DOC |
| Community Management, nivel Estándar y límites por endpoint | "Standard rate limits are not published in documentation". Se ven en el Developer Portal > app > pestaña **Analytics** (solo endpoints con al menos una llamada hoy UTC) | DOC |
| Alertas | Correo a los administradores de la app al superar el 75% de la cuota de la **app** (no del miembro), con 1 a 2 h de retraso | DOC |
| Publicaciones por día | No hay tope documentado de posts por día. Con 150 llamadas por miembro al día: texto = 1 llamada; imagen = 3 (inicializar, subir, publicar); video = 3 + número de partes (un video de 200 MB son ~48 partes) | INFERENCIA |
| Contenido | Texto 3.000; encuesta 140/30; imágenes hasta 20; video 500 MB; documento 100 MB y 300 páginas | DOC |

- Ojo con el video: las partes de 4 MiB cuentan como llamadas (si las subidas a `dms-uploads` cuentan en la cuota: NO VERIFICADO). Con el tope de 150 por miembro al día, un video grande podría consumir casi toda la cuota. Medir en la demo con la pestaña Analytics.
- Un `429` también puede ser "protección de infraestructura" y se normaliza solo (DOC).

## 7. Errores comunes

Códigos y mensajes de la Posts API (DOC, tabla "API Error Details") más los generales de la plataforma:

| HTTP | Código/mensaje | Qué hacer | ¿Reintentable? |
|---|---|---|---|
| 400 | `INVALID_URN_TYPE`, `INVALID_URN_ID`, `MISSING_FIELD`, `INVALID_VALUE_FOR_FIELD`, `INVALID_VALUE_BLANK_FIELD` | Error de payload: corregir | No |
| 400 | `FIELD_LENGTH_TOO_LONG` | Texto o campo demasiado largo (`commentary`) | No (acortar) |
| 400 | `INVALID_IMAGE_ID`, `INVALID_VIDEO_ID`, `INVALID_DOCUMENT_ID`, `EXPIRED_UPLOAD_URL` | Recurso inválido o URL de subida vencida: volver a inicializar la subida | No tal cual; reinicializar |
| 400 | `MEDIA_ASSET_WAITING_UPLOAD`, `MEDIA_ASSET_PROCESSING_FAILED` | El medio aún no está listo o falló el procesamiento | Esperar y reintentar el primero; el segundo, rehacer el medio |
| 401 | Token vacío, inválido, vencido o **revocado por el miembro** | Reconectar la cuenta (`ACCOUNT_RECONNECT`) | No hasta reconectar |
| 403 | `ACCESS_DENIED` | Falta el scope o el rol en la Página; o el recurso es de otro propietario | No |
| 404 | `NOT_FOUND` | URN equivocado o ya borrado | No |
| 409 | `CONFLICT` | "A write conflict occurred. Retry the request." | **Sí**, con backoff |
| 411 | `Length Required` | Un POST sin cuerpo necesita `Content-Length` | No (corregir) |
| 422 | `UNPROCESSABLE_ENTITY` | Error semántico del payload | No |
| 426 | Versión de `Linkedin-Version` cerrada | Subir la constante de versión | No |
| 429 | `TOO_MANY_REQUESTS` ("Resource level throttle limit...") | Bajar la frecuencia; si es cuota diaria, esperar a medianoche UTC. No hay cabecera `Retry-After` documentada | **Sí**, con espera larga |
| 500 | `INTERNAL_SERVER_ERROR` | Registrar `x-li-uuid`, `x-li-request-id` y reportar si persiste. Ojo: un fallo de verificación del token también sale como 500 | **Sí** (ver idempotencia en 4.6) |
| 503 / 504 | `SERVICE_UNAVAILABLE` / Gateway Timeout | Reintentar con backoff | **Sí** |

- **Reintentos de creación:** un 5xx o un timeout en `POST /rest/posts` puede haber publicado igual (no hay clave de idempotencia). Marcar la publicación como "estado incierto" y pedir confirmación en vez de reintentar a ciegas (INFERENCIA).
- Los mensajes exactos de los `400` que devuelve la API real para escapes mal puestos en `commentary`: NO VERIFICADO.

## 8. Cómo probar sin riesgo

No hay sandbox ni entorno de pruebas (DOC por omisión). Opciones, de menos a más riesgo:

1. **Generador de tokens (sin código ni redirect):** `linkedin.com/developers/tools/oauth/token-generator`, app con Share on LinkedIn y OpenID Connect, scopes `openid profile w_member_social`. Con ese token (curl, sin tocar `.env`):
   - `GET /v2/userinfo` → `sub` (confirma la fórmula del `urn:li:person`).
   - `POST /rest/posts` de **texto** con `visibility: CONNECTIONS` (solo contactos de 1er grado; menos exposición que `PUBLIC`) y `Linkedin-Version: 202610`. Confirma que el endpoint vigente acepta un token de Share on LinkedIn (la gran duda de la sección 1).
   - Luego `DELETE /rest/posts/{urn}` (204) y `GET /rest/posts/{urn}` para ver si `w_member_social` basta para leer por URN.
2. **Perfil de prueba (DOC, API Terms §2.3):** hasta **cinco** perfiles de prueba creados **a mano** (no con scripts), identificados en el titular como "Test Profile at [empresa]", que **no pueden interactuar con miembros reales** ni con páginas. Sirven de miembro para probar el flujo OAuth completo sin tocar el perfil real del operador. Si pueden autorizar una app y publicar: NO VERIFICADO. **No se pueden crear páginas de prueba** ("create any test companies" prohibido): publicar en la Página es siempre real.
3. **Página real:** publicar un texto sencillo y borrarlo enseguida es la única prueba posible para `w_organization_social`. No existe modo seco en la API; el `dry-run` de AgentSales debe validar el payload en local (esquema zod, escapes, largos) y no llamar.
4. **Pruebas automáticas:** msw/fakes, sin llamar a LinkedIn (regla del proyecto).

**Lista de pruebas NO VERIFICADO (orden sugerido para la demo):**

| # | Qué probar | Cómo |
|---|---|---|
| 1 | Un token de solo Share on LinkedIn funciona contra `/rest/posts` (y qué `Linkedin-Version` acepta) | Punto 1 de arriba |
| 2 | `http://localhost:PUERTO/...` como redirect URI | Guardarlo en Auth: **hecho el 2026-10-20, LinkedIn lo acepta**. Falta el OAuth completo con esa vuelta (primera conexión desde el panel) |
| 3 | `urn:li:person:{sub}` es el autor válido | `userinfo` + post de texto |
| 4 | Un token con solo `w_member_social` puede hacer `GET /rest/posts/{urn}` y `GET /rest/images/{urn}` | Tras publicar, leerlos; si hay 403, el diseño no depende de leer |
| 5 | Enlace `https://www.linkedin.com/feed/update/{urn}/` abre el post (share y ugcPost) | Abrirlo |
| 6 | `refresh_token` en la respuesta del canje (self-serve y Community Management) | Mirar la respuesta, sin imprimir tokens |
| 7 | Cuántas llamadas descuenta una imagen y un video (cuota real por miembro) | Pestaña Analytics del Developer Portal, una llamada de cada tipo |
| 8 | Texto con los 15 caracteres reservados y 3.000 caracteres exactos (con y sin escapes) | Un post de prueba con `CONNECTIONS`, borrar después |
| 9 | Video: 9:16 de 1080x1920 H.264, tamaño máximo real, subida por partes | Subir el reel de muestra |
| 10 | Subida de imagen: verbo (PUT o POST) y cabeceras | Primera subida real |
| 11 | Plazo y criterios de Community Management (Desarrollo) para AgentPey | Solo se conoce al enviar la solicitud |
| 12 | `https://www.linkedin.com/feed/?shareActive=true&text=…` abre el editor con el texto puesto (saltos de línea, hashtags, tildes, emojis) | Un clic en «Copiar texto y abrir LinkedIn» en un post a mano, sin publicar (§0, «Abrir el editor con el texto puesto») |

### Resultado del flujo a mano con un post real (2026-10-21, en producción; la hizo Claude con la autorización explícita del operador)
- **Cómo:** un post real y público de AgentPey sobre seguridad en pagos agénticos (sin Stellar ni blockchain; salió de los hechos del perfil), redactado por la IA, revisado y aprobado por el operador (en español, sin cambios). Producción en `live` y el worker encendido **solo unos minutos** para dejar la publicación en **`awaiting_manual_confirm`** (cuenta a mano: no se llamó a LinkedIn) y de vuelta a `dry-run` con el worker apagado. Claude abrió el editor de LinkedIn en el Chrome del operador y escribió el texto aprobado; **el operador revisó y pulsó Publicar**.
- **Confirmación:** el operador copió el enlace con «Copiar enlace a la publicación» y AgentSales lo **rechazó** (`PUBLISHED_URL_INVALID`): LinkedIn entrega ahí un enlace **corto** `https://lnkd.in/p/<código>`, y el validador solo acepta `linkedin.com` (`packages/core/src/linkedin.ts`, que lo dice: «un `lnkd.in`» no se acepta). El enlace corto redirige (301) a `https://www.linkedin.com/posts/<usuario>_<texto>-share-<id>-<código>/`; con ese enlace largo, sin parámetros, la confirmación pasó y AgentSales guardó el canónico `https://www.linkedin.com/feed/update/urn:li:share:<id>/`.
- **Arreglado el mismo día:** el error de un `lnkd.in` ahora dice que es el enlace corto y que se copie el de la **barra de direcciones** (haciendo clic en la fecha de la publicación); el consejo general ya no manda a «Copiar enlace a la publicación». No se acepta el corto porque no trae el número de la publicación y resolverlo pide red (`packages/core/src/linkedin.ts`).
- **Sigue pendiente:** S2 (publicar por la API: los términos de LinkedIn parecen prohibirlo y es el perfil personal del operador) y S3 (consultar a LinkedIn Developer Support). La cuenta sigue **a mano**.

## 9. Riesgos y términos de uso relevantes

**Contratos que aplican (según la vía):**

- **LinkedIn API Terms of Use** (self-serve: Share on LinkedIn, OIDC). Última revisión: 2022-12-13 (según la página). Los puntos siguientes salen del resumen de la herramienta; **leer el texto original antes de decidir**: `linkedin.com/legal/l/api-terms-of-use`.
- **LinkedIn Marketing API Terms** (Community Management, Advertising): `linkedin.com/legal/l/marketing-api-terms`.
- **User Agreement** (vigente desde 2025-11-03), **Professional Community Policies** y la ayuda "prohibited software and extensions".

**Hallazgo principal (API Terms §3.1(26), prohibiciones generales):**

> "Use the Content or the APIs to automate posting on the LinkedIn Services."

(Cita literal tal como la devolvió la herramienta.) Leída a la letra, **un programador/publicador automático sobre la API self-serve** es lo que esa cláusula prohíbe; Share on LinkedIn existe para que un miembro comparta contenido, pero la doc no define el límite entre "compartir con ayuda de una app" y "automatizar publicaciones". **No hay interpretación oficial publicada** en lo que leí. Otros datos del mismo contrato:

- §1.4 (elegibilidad self-serve): la app debe ayudar a los miembros a "publishing, discussing and sharing content", **no** usar el contenido para publicidad, **no** esperar más de 100.000 usuarios de por vida y **no** "rely on access to the APIs as a fundamental aspect of your business". Para una oferta comercial a terceros cuyo núcleo es publicar en LinkedIn, esta última condición es difícil de sostener.
- §2.4: licencia no sublicenciable; no se permite "distribute or allow access to the stand-alone APIs".
- §3.1(24): prohíbe scraping o leer LinkedIn fuera de las APIs.
- §2.2: las credenciales (Client ID/Secret, tokens) son secretas, no se comparten ni transfieren. §7.1(d): incidentes de seguridad se informan en 24 horas.
- §11.3: LinkedIn puede suspender o terminar el acceso "at any time for any reason" (en general con 30 días de aviso para discontinuaciones).
- **No menciona IA** ni contenido generado por IA.

**Marketing API Terms (según el resumen, para Community Management):**

- Permiten administrar Páginas y perfiles de **Authorized Clients** ("Page Management" y "Member Profile Management", §1.6). Las páginas de la doc de Community Management citan como caso aprobado "Profile Management: Create and manage posts, comments, and reactions... on behalf of individual profiles".
- Solo se puede usar el caso de uso **declarado en la solicitud** (§2.1); LinkedIn puede auditar y exigir cambios (§2.3) y suspender el acceso por incumplimiento, incluso tras aprobar.
- Con terceros: contratos con los clientes (§1.2, §1.5), no mezclar clientes sin relación en una misma cuenta de Página (§1.7), no dar acceso a las APIs o los datos a nadie más que a tus clientes (§3.2(a)), y no usar las APIs en cuentas que gestionas tú para vender servicios de reventa (§3.2(k)). Lo leí resumido: confirmar el texto.
- Sin mención de "automatizar", "programar" ni IA (la herramienta no encontró esas palabras).
- Datos de miembros: no usar para publicidad, ventas ni reclutamiento; no exportar ni transferir a terceros; no combinar con otros datos; solo mostrarlos a quienes gestionan esa Página o perfil (restricted-use-cases). **No** se permite usar los datos como feed social en un sitio web. "No Headless or Fake Accounts: Do not... use individual profiles to manage multiple customers' accounts".

**Reglas de la plataforma (no de la API):**

- **User Agreement §8.2 (resumen):** prohíbe "bots or other unauthorized automated methods" para "create, comment on, like, share, or re-share posts, or otherwise drive inauthentic engagement". La palabra clave es *unauthorized*: la API con OAuth del propio miembro es el método autorizado; el navegador automatizado (Playwright) no lo es. **No automatizar LinkedIn con navegador** bajo ninguna circunstancia (la ayuda de LinkedIn advierte que los usuarios de esas herramientas arriesgan que sus "accounts [be] restricted or shut down").
- **Contenido generado por IA:** User Agreement §3.6 reconoce que hay contenido "automatically generated and shared using tools offered by LinkedIn or others off LinkedIn" y recomienda revisarlo. Las Professional Community Policies no tienen una regla general de rotulado de IA; sí prohíben "synthetic or manipulated media that depicts a person saying something they did not say" (exige aclararlo) y "artificially increase engagement" o acuerdos previos para dar "me gusta" o reposts cruzados. El esquema de la Posts API **no tiene campo de "hecho con IA"** (a diferencia de `is_ai_generated` de Instagram): no lo vi en lo leído.
- **Riesgo de cuenta:** el perfil personal del operador es un activo; una restricción por conducta automatizada puede dejarlo sin perfil. Una Página pierde alcance o se restringe.

**Qué cambia si se ofrece a terceros (sección pedida):**

1. **Perfiles personales de terceros:** técnicamente, cada tercero autoriza tu app y `w_member_social` basta, sin aprobar. Pero el contrato self-serve (§1.4(5), §3.1(26), §2.4) hace frágil un producto cuyo negocio *es* publicar en LinkedIn. La vía correcta para eso es Community Management con caso de uso "Profile Management".
2. **Páginas de terceros:** Community Management en **nivel Estándar**: formulario, política de privacidad válida, cumplimiento de requisitos de almacenamiento de datos, video de pantalla con el flujo OAuth, publicar en la Página, ver comentarios y qué datos personales se muestran; credenciales de prueba; y que la app esté completamente integrada. Los límites del nivel Desarrollo (500 llamadas por app y 100 por miembro al día) no alcanzan para clientes reales. Si la aprobación del Estándar se puede reusar en otra app: sí, con otro formulario que indica el Client ID de la app aprobada (DOC).
3. **Marketing Developer Platform / socios:** la doc de refresh tokens habla de "approved Marketing Developer Platform (MDP) partners" y los errores remiten a `developer.linkedin.com/partner-programs`. Un programa de socios (con *Technical Sign Off* según "Integration Requirements", página que no leí) es la vía formal para volumen, refresh tokens y reputación. Plazos y requisitos del programa de socios: NO VERIFICADO.
4. **Organización legal:** sin entidad registrada con correo y dominio propios, no hay Community Management (ni para ti ni para tus clientes: "registered legal organizations... commercial use cases only").
5. **Datos:** reglas de la sección 5.4 (48 h para actividad de miembros) obligan a no almacenar comentarios ni datos de quienes interactúan; las métricas agregadas de Página se pueden guardar un año.

## 10. Fuentes

Consultadas el **2026-10-19** (versión `li-lms-2026-10` de la doc de marketing, salvo indicación).

Posts y medios
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/post-api-schema?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/poll-post-api?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/version/article-ads-integrations?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/ugc-post-api?view=li-lms-2026-10 (legacy; límite de 3.000)
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/social-metadata-api?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/contentapi-migration-guide?view=li-lms-2026-10

Versionado y migraciones
- https://learn.microsoft.com/en-us/linkedin/marketing/versioning?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/integrations/migrations?view=li-lms-2026-10

Acceso y aprobación
- https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access
- https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin (2023; endpoint legacy y límites 150/100.000)
- https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/quick-start?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/organization-access-control-by-role?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/profile-api

Autenticación, límites y errores
- https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
- https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens
- https://learn.microsoft.com/en-us/linkedin/shared/authentication/developer-portal-tools
- https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits
- https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/error-handling

Métricas, datos y restricciones
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/post-statistics?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/data-storage-requirements?view=li-lms-2026-10
- https://learn.microsoft.com/en-us/linkedin/marketing/restricted-use-cases?view=li-lms-2026-10

Términos y políticas (leídas resumidas; confirmar el texto)
- https://www.linkedin.com/legal/l/api-terms-of-use
- https://www.linkedin.com/legal/l/marketing-api-terms
- https://www.linkedin.com/legal/user-agreement
- https://www.linkedin.com/legal/professional-community-policies
- https://www.linkedin.com/help/linkedin/answer/a1341387 (software y extensiones prohibidos)

Pistas de terceros (solo orientación, no fuente): búsquedas web del 2026-10-19 sobre Share on LinkedIn con `/rest/posts`, el límite de 3.000 caracteres, la falta de programación nativa y `http://localhost` como redirect (CData, Publora, PostEverywhere, Blotato, OpenTweet y otros). Nada de lo marcado DOC depende de ellos.

No leído: `integration-requirements-community-management`, `posts-atmention-search-api`, `comments-api`, la política "Do's and Don'ts" completa del User Agreement, la ayuda de LinkedIn sobre programar publicaciones en la interfaz nativa (existe, sin API).

## 11. Riesgos y recomendación

**Riesgos, por orden de gravedad:**

1. **Términos:** la cláusula §3.1(26) de los API Terms self-serve (automatizar publicaciones) choca con un programador automático; y el §1.4(5) con una oferta a terceros. No hay interpretación oficial leída. Riesgo: perder el acceso de la app y, peor, que se asocie con restricción del perfil personal.
2. **Página sin vía self-serve:** `w_organization_social` exige Community Management, que exige organización legal, dominio, correo de empresa, y una app limpia. Plazo desconocido; si se rechaza, hay que empezar con otra app.
3. **Sin métricas ni lectura** en el perfil personal con la vía self-serve (`r_member_social` cerrado): el sistema no podrá confirmar el estado de lo publicado ni evitar duplicados tras un timeout.
4. **Reconexión cada 60 días** sin refresh token (salvo que Community Management lo entregue).
5. **Escapes del `commentary`:** un texto de IA sin escapar se publica mal o falla. Es técnico, barato de cubrir con tests.

**Recomendación:**

- **Fase inicial (perfil personal): publicación asistida con un clic humano.** La IA redacta, el operador revisa y pulsa "Publicar" en el panel; el worker llama a `POST /rest/posts` en ese momento. Sin programación futura automática ni reintentos silenciosos. Antes de construir el calendario para LinkedIn, **escribir a LinkedIn Developer Support** (`linkedin.com/help/linkedin/ask/dsapi`) para preguntar si publicar en nombre del propio miembro, tras su aprobación, entra en §3.1(26). Mientras no haya respuesta, no activar la programación automática en LinkedIn (la agenda puede recordar "te toca publicar" con el texto y los medios listos, como se hace con Marketplace).
- **Página AgentPey:** pedir Community Management (nivel Desarrollo) **solo si** AgentPey es una organización legal con dominio y correo propios; con una app nueva. Si no, publicación manual asistida (el sistema entrega texto y medios listos).
- **Técnico:** adaptador `LinkedInPublisher` con `Linkedin-Version` configurable (por defecto 202610), `escapeLittleText()` con tests, subida por bytes desde R2 (sin URL pública), estado "incierto" tras timeouts, aviso de reconexión desde el día 50. Nunca navegador automatizado.
- **Orden de pruebas:** las 11 de la sección 8, empezando por la 1 con el generador de tokens (diez minutos, sin código).
