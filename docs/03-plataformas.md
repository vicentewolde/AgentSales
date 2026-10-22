# 03 · Plataformas

Resumen de cómo se integra cada canal. Antes de implementar un publisher, el subagente `integraciones` verifica esta información contra la documentación oficial vigente y deja las notas en `docs/integraciones/<plataforma>.md`. **Todo lo marcado (verificar) debe confirmarse antes de codificar.**

| Plataforma | Mecanismo | Fase | Riesgo |
|---|---|---|---|
| Instagram | API oficial (Instagram API with Instagram Login) | F3 (avisos); F9-T13 (posts) | Bajo |
| Portal Inmobiliario | API de Mercado Libre (sitio MLC) | F4 | Medio |
| Facebook Marketplace | Navegador automatizado + clic final humano | F5 | Alto |
| Yapo | Por definir (sin API pública conocida) | Post-MVP | Alto |
| TikTok | Content Posting API, modo *Upload* (video como borrador en la bandeja) | F9 (T26) | Medio |
| Discord | Webhook de canal (Execute Webhook) | F9 (T14) | Bajo |
| X | API v2 con OAuth 2.0 y PKCE (pago por uso) | F9 (T16) | Medio-alto |
| LinkedIn | Posts API (`/rest/posts`), perfil personal, a mano por defecto | F9 (T15) | Medio-alto (términos) |

## Instagram

- **API:** Instagram API with Instagram Login (host `graph.instagram.com`). **No requiere Página de Facebook** (verificado 2026-10-04); sí requiere cuenta profesional (Empresa o Creador) y una app de tipo Business.
- **Permisos:** `instagram_business_basic`, `instagram_business_content_publish` (nombres vigentes, verificados 2026-10-04; los scopes antiguos quedaron deprecados el 2025-01-27).
- **Setup:** app en developers.facebook.com con el producto Instagram; agregar la cuenta de prueba como tester de la app. Con acceso estándar (el de por defecto) la app funciona con cuentas que tienen rol en ella, sin App Review (verificado). Para cuentas de terceros hace falta acceso avanzado: App Review y verificación del negocio (verificado); el plazo de "2–4 semanas" no figura en la doc (NO VERIFICADO). El `client_id` y el `client_secret` del OAuth son el **Instagram app ID e Instagram app secret** del panel (Instagram > API setup with Instagram login > Business login settings), distintos de los de Settings > Basic; el operador confirmó el 2026-10-05 que `INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET` son ese par (pasos en `integraciones/instagram.md`, sección 2.1). **Otros corredores en F7 (2026-10-16, sección 12 de esa nota):** en modo desarrollo la app sirve a cuentas con rol en ella (acceso estándar), así que cada corredor se agrega como Instagram Tester y acepta la invitación en Instagram (el rol no está descrito en la doc oficial: pasos de terceros; el límite genérico es de 50 testers). Que se pueda publicar en la cuenta de un tester: NO VERIFICADO hasta probarlo con uno. El botón Generate token exige iniciar sesión en esa cuenta de Instagram, así que el operador no lo genera por el corredor sin que este inicie sesión él mismo; el OAuth con HTTPS funciona desde F8 con el botón de Cuentas en `agentsales.agentpey.com` (2026-10-19). Acceso avanzado (pendiente: Meta): App Review con video por permiso, política de privacidad, ícono 1024x1024 y verificación del negocio (documentos y plazo: NO VERIFICADO).
- **Flujo de publicación (verificado 2026-10-04):**
  1. Crear un contenedor por medio (`POST /{ig-user-id}/media`; los hijos de un carrusel llevan `is_carousel_item=true` y no llevan caption).
  2. Para carrusel (de 2 a 10 ítems), crear el contenedor padre con `media_type=CAROUSEL`, `children` y `caption`.
  3. Para video o reel (`media_type=REELS`, `video_url`), consultar `status_code` hasta `FINISHED`; Meta recomienda una consulta por minuto durante un máximo de 5 minutos. Un contenedor vive 24 h.
  4. Publicar (`POST /{ig-user-id}/media_publish` con `creation_id`) y leer el `permalink` del medio publicado (`GET /{media-id}?fields=permalink`; en carruseles, del ID del carrusel, no de los hijos).
- **Medios:** deben estar en una **URL pública** (usamos URLs prefirmadas de Cloudflare R2, con `Content-Type` correcto en cada archivo). La doc de Meta no dice nada sobre query strings, redirecciones ni `HEAD`, y una URL prefirmada de R2 queda atada al método `GET`. **Verificado el 2026-10-06:** Instagram acepta las URLs prefirmadas de R2 para imágenes (`pnpm ig:smoke` y el carrusel de la prueba en `live`) y para el reel (`video_url`, en la prueba en `live`). El plan B (dominio público propio para un prefijo del bucket, o subida reanudable del reel con `upload_type=resumable`) no hizo falta. La URL debe seguir vigente hasta que el contenedor llega a `FINISHED`: generarla justo antes de crear el contenedor, con vencimiento de 1 hora. Imágenes en JPEG sRGB, hasta 8 MB, proporción entre 4:5 y 1,91:1, ancho entre 320 y 1440 px (verificado 2026-10-02, `integraciones/instagram.md`). El carrusel se recorta a la proporción de la primera imagen, así que todas van en 4:5 (1080×1350). **Hasta 10 ítems por carrusel vía API (verificado).** Reels: la API acepta MOV o MP4 (sin edit lists, `moov` al inicio), HEVC o H.264, AAC, 23 a 60 fps, máximo 1920 px en horizontal, VBR hasta 25 Mbps, de **3 s a 15 min**, hasta 300 MB, proporción recomendada 9:16 (verificado). El tope de 3 a 90 s (spec F3, D7) es una decisión de producto, no un límite de Meta.
- **Límites (2026-10-04):** la guía de Meta dice 100 posts publicados por API por cuenta en una ventana móvil de 24 h, pero la referencia de `content_publishing_limit` dice `quota_total` "currently 50": la doc se contradice, así que el sistema lee `config.quota_total` en vez de fijar la cifra. Tope aparte de **400 contenedores** por cuenta en 24 h (un carrusel de N imágenes gasta N + 1). Un carrusel cuenta como 1 post (verificado). `content_publishing_limit` está documentado para Instagram Login en `graph.instagram.com` (verificado 2026-10-15; la respuesta va envuelta en `data: [ ]` con `quota_usage`, `config.quota_total` y `config.quota_duration`, ventana móvil de 24 h; la referencia dice 50). **No dice cuándo se libera un cupo:** el sistema espera 6 h fijas antes de reintentar (simplificación consciente, spec F6 §4.5; calcularlo desde la publicación propia más antigua de las últimas 24 h queda para cuando el volumen lo pida). El valor real de `quota_total` y si un reel cuenta como 1 post: NO VERIFICADO. Llamadas: `4800 × impresiones` de la cuenta en 24 h. Códigos de límite (4, 17, 80002, 613): sin tiempo de espera fijo en la doc; si el host de Instagram devuelve `X-App-Usage`/`X-Business-Use-Case-Usage` con `estimated_time_to_regain_access` (en minutos): NO VERIFICADO (`integraciones/instagram.md`, sección 6.1).
- **Tokens (verificado 2026-10-04):** OAuth en `https://www.instagram.com/oauth/authorize`; el código dura 1 hora y es de un solo uso; el token corto dura 1 hora; se canjea por uno largo de **60 días** (`graph.instagram.com/access_token`, `ig_exchange_token`) y se refresca con `refresh_access_token` (`ig_refresh_token`) solo si tiene **al menos 24 h** y **no ha vencido** (un token vencido obliga a reconectar). Se necesita un job periódico. La cuenta se identifica con el `user_id` de `/me`, no con `id` (app-scoped). **Redirect URI:** el panel de Meta rechaza `http://localhost` (2026-10-05). En F3 la cuenta se conecta con el token del botón Generate token, que sirvió para `/me`, crear contenedores y publicar (2026-10-06); el OAuth se prueba en F8 con HTTPS (`integraciones/instagram.md`, sección 3.6; en F7 siguió el Generate token).
- **Errores:** 190 (token) y permisos (10, 200 a 299) no se reintentan; límites (4, 17, 80002, 2207042): desde F6 reprograman la publicación (la espera de la cabecera de uso o 60 min; 6 h el máximo diario), hasta 3 esperas seguidas, y la cuarta deja `failed` (ADR-0018); errores de descarga de medios (2207003, 2207052) y transitorios (2207001, 2207032, 2207053) se reintentan con contenedor nuevo. Tabla completa en `integraciones/instagram.md`, sección 7.
- **Caption:** el texto se guarda sin los hashtags (`contents.body`) y los hashtags aparte (`contents.hashtags`). El publisher envía `instagramCaption(content)` (core), que los suma después de una línea en blanco; enviar solo `body` publicaría sin hashtags. Límites de Meta (verificado 2026-10-04): 2.200 caracteres, 30 hashtags y 20 menciones.
- **Despublicar (corregido 2026-10-04):** existe `DELETE /{media-id}` en la API de Instagram (novedad del 2025-12-03), pero la referencia de Meta lo limita a **Facebook Login** (host `graph.facebook.com`, permiso `instagram_manage_contents`); con Instagram Login no está documentado. Se asume que no se puede por API y se borra a mano desde la app. No se intentó en F3 (spec F3, D8): las publicaciones de la prueba se borraron a mano. "Cerrar" en Instagram = marcar como no disponible en el sistema y avisar al operador para archivarlo o borrarlo a mano.

### Instagram para posts (F9-T13)

Detalle en `docs/integraciones/instagram-contenido-propio.md` §13 y spec F9 §4.6.

- **Mismo publisher y misma app** que los avisos (`AgentSales-IG`, Instagram Login); el input no dice de qué sujeto viene. La cuenta de cada marca se conecta igual que la de un corredor (el botón de Cuentas en el servidor, el token de *Generate token* en el Mac).
- **Qué publica** según el tipo del post (`postPublicationPlan`): `image`, una imagen suelta (el `ig_4x5` de la primera foto); `carousel`, de 2 a 10 fotos; `video`, un reel 9:16 de 3 a 90 s **sin texto encima**; `text` no va a Instagram (la revisión lo frena con el error `MEDIA_NOT_SUPPORTED`; que falten las fotos o el video es solo la advertencia `MEDIA_REQUIREMENT`, F9.5-T21: el texto se aprueba y publicar espera los medios). Sin Stories, música, colaboraciones ni ubicación (D11).
- **Caption:** el cuerpo y los hashtags (`instagramCaption`), en el idioma de la publicación: con dos idiomas salen dos publicaciones de la misma cuenta.
- **Cuota compartida:** el cupo de `content_publishing_limit` es de la cuenta; posts y avisos de la misma cuenta suman en el mismo contador, y sin cupo un post se reprograma igual que un aviso.
- **Riesgo:** con la app en modo desarrollo, lo publicado podría no verse para quien no tiene rol en la app. **La prueba S1 del operador (spec F9 §4.8) es obligatoria antes de publicar un post de verdad**; si falla, Instagram espera el App Review (`docs/11-app-review-meta.md`). Gratis. En `dry-run` no se llama a Meta.

## Las redes de los posts (F9): resumen

Las cinco se construyeron contra simulaciones (msw); ningún test llama a la red real. Cada una exige su **prueba de entrada** (spec F9 §4.8, la hace el operador a mano) antes de la primera publicación real; hasta entonces se usa solo en `dry-run`. En `dry-run` ninguna escribe en la red (ADR-0016): conectar y renovar el token sí hablan con la red (leen la cuenta o rotan el token; no publican), X deja en la bitácora el costo que tendría y Discord la nota del video que no cabe, y TikTok queda en un traspaso simulado (`awaiting_manual_confirm` sin subir nada). Las variables de cada app están en `docs/07-checklist-cuentas.md` y `docs/08-guia-operador.md`.

| | Instagram | Discord | LinkedIn | X | TikTok |
|---|---|---|---|---|---|
| Conectar | Botón de Cuentas (servidor) o `--token-stdin` (Mac) | `accounts connect discord --webhook-stdin` (solo la CLI) | OAuth: botón o `accounts connect linkedin` | OAuth con PKCE: botón o `accounts connect x` | OAuth (Login Kit): botón o `accounts connect tiktok` |
| Modo | Siempre por API | `api` (puede pasar a `manual`) | **`manual` por defecto** (D5) | `api` (puede pasar a `manual`) | `api`, pero siempre termina a mano: el video llega como borrador |
| Token | 60 días, se renueva solo | No vence (la URL del webhook) | 60 días **sin renovación**: la agenda avisa 7 días antes | 2 h, se renueva al publicar y en `tokens.refresh` | 24 h, se renueva igual (refresh de 365 días) |
| Límites | 2.200 caracteres, 30 hashtags; imagen, carrusel (2 a 10) o reel | 2.000 caracteres; hasta 10 archivos de 20 MiB (24 MiB por mensaje) | 3.000 caracteres con escapes; hasta 20 imágenes o un video MP4 | 280 ponderados; hasta 4 imágenes o 1 video | Solo video; 5 borradores pendientes por 24 h |
| Costo | Gratis | Gratis | Gratis | US$0,015 por post, US$0,20 con enlace; tope del mes por cuenta (US$10) | Gratis |
| Retirar | A mano | A mano | `retire --delete` por la API (cuenta en `api`) o a mano | `retire --delete` por la API (cuenta en `api`) o a mano | A mano (no hay borrado por la API) |
| Prueba | S1 | S5 | S2 y S3 | S4 | S6 |

## Portal Inmobiliario (vía Mercado Libre)

Detalle verificado en `docs/integraciones/mercadolibre.md` (2026-10-06, leyendo la doc oficial con el navegador) y diseño en el spec F4.

- Portal Inmobiliario está integrado a Mercado Libre. Se publica en el sitio **MLC** con la API de ML (`POST /items`).
- **Clave:** en Chile hay que incluir el atributo `CMG_SITE` con `value_name: "POI"` para que el aviso aparezca en Portal Inmobiliario además de Mercado Libre.
- **Cuenta y costo:** publicar un inmueble exige un **paquete de publicación** (`silver`) con cupo; no hay publicación gratis ni sandbox. La app se crea con los datos del titular validados. Para probar, un usuario de prueba activado por soporte contrata paquetes sin cargo (`pnpm ml:test-user`, spec F4 D15).
- **Setup:** app en el DevCenter de Mercado Libre, OAuth 2.0 (authorization code) con redirect URI **HTTPS** (no necesita cargar). En desarrollo (Mac), el operador pega la dirección de vuelta en la CLI, sin túnel (spec F4, D1); en el servidor (F8, D20) la vuelta es automática y se conecta con el botón del panel.
- **Tokens:** `access_token` de unas 6 h (se lee `expires_in`); `refresh_token` de 6 meses, **de un solo uso** y que rota en cada refresco: se refresca con un candado por cuenta (ADR-0015).
- **Contacto:** desde el 01/10/2026, `seller_contact` con WhatsApp (`country_code2` y `phone2`) es obligatorio al crear y actualizar. La descripción no puede llevar teléfono, dirección ni sitio web (moderación).
- **Título y fotos:** el largo máximo lo da `settings.max_title_length` de cada categoría (en MLC, 60 en las hojas que usa AgentSales, verificado con `ml:smoke` el 2026-10-08; AgentSales usa 60). Fotos JPG o PNG de hasta 10 MB, recomendado 1200 px, al menos 1 obligatoria (12 como objetivo de calidad en casas y departamentos). F4 las sube directo (`/pictures/items/upload`).
- **Categorías, atributos y ubicación:** se descubren por API con token (árbol desde `MLC1459`, atributos con `tags.required`, `classified_locations` de Chile) y se cachean en la base. No se escriben a mano.
- **Moneda:** UF es `CLF` (2 decimales); CLP sin decimales.
- **Republicar, editar y vencer (consulta 2026-10-15, `integraciones/mercadolibre.md` §13; `re-publica`, `actualiza-tus-publicaciones` y el ciclo de vida releídas con el navegador el mismo día):** republicar es `POST /items/{id}/relist` con `price`, `quantity` y `listing_type_id` sobre un ítem `closed` (vencido o cerrado a mano), crea un ítem con **id y enlace nuevos**, **una sola vez por ítem padre**, y conserva las visitas si se hace dentro de **60 días**; si gasta un cupo, qué copia (la descripción, quizá no) y si pide `seller_contact`: NO VERIFICADO. Editar precio, título, fotos y descripción es `PUT` (con `seller_contact` completo y, desde el 12/03/2026, con las fotos en `pictures` en cada actualización de un `silver`; si eso alcanza a un `PUT` que solo cambia el estado: NO VERIFICADO); un precio inusual puede pausar el aviso por moderación (umbral desconocido); no hay límite de ediciones documentado. **No existe forma documentada de extender `stop_time` ni un aviso previo de vencimiento** (solo el topic `items`, después del cambio): el recordatorio se calcula con el `stop_time` leído.
- **Estados:** `active`, `paused` (también por moderación o mientras procesa fotos), `under_review`, `closed` (definitivo; republicar crea otro id). En MLC, casas y departamentos vencen a los 180 días en venta y a los 45 en arriendo. Validar sin publicar: `POST /items/validate` (en `dry-run`, ADR-0016) exige un paquete con cupo: sin él responde 402 y solo revisa el título. La simulación lo toma como advertencia (D14).
- **Consultas de interesados:** llegan como preguntas o leads (fase de respuestas, fuera del MVP).

## Facebook Marketplace

- **Sin API pública** para publicar avisos de particulares en Chile.
- **Mecanismo:** Playwright con un **perfil de navegador persistente por corredor**. El corredor inicia sesión a mano una vez; el sistema nunca ve su contraseña.
- **Flujo:** el worker abre el formulario "Nueva vivienda" (`/marketplace/create/rental`, **solo de arriendo**: una venta no va a Marketplace), llena campos (la ubicación con la dirección de la planilla, spec F5 D16), sube fotos y deja todo listo. El estado pasa a `awaiting_manual_confirm` y el operador hace el **clic final**. Luego pega la URL o el sistema la detecta.
- **Riesgos:** cambia el HTML sin aviso (los selectores se rompen), y Meta puede restringir cuentas por automatización. Mitigaciones:
  - Clic final humano.
  - Ritmo lento, con pausas fijas entre acciones (desde ADR-0017: sin variaciones al azar que imiten a una persona).
  - Máximo 3 intentos en vivo por cuenta y día (`MARKETPLACE_DAILY_LIMIT`, spec F5 D8) y un formulario a la vez.
  - Selectores centralizados en un solo archivo.
  - Capturas de pantalla ante errores.
- **Nunca** resolver captchas ni evadir verificaciones: si aparece una, se detiene y avisa al operador.
- **Desde el spec de F5** (ADR-0017, nota `docs/integraciones/fb-marketplace.md`): el operador hace también el clic de *Siguiente*; la sesión vive en un perfil fuera del repo (la base no guarda credenciales); el enlace lo detecta la ventana (solo la primera navegación desde el formulario) o lo pega el operador; no se leen estados de Facebook (las Condiciones de Meta prohíben recolectar datos con medios automatizados), así que retirar es a mano; `dry-run` no abre Facebook; ante cualquier pantalla fuera de la lista blanca, captura y se cierra la ventana; el precio va en pesos (la UF se convierte con el valor oficial del día, `docs/integraciones/uf.md`).
- **Marketplace en producción (F8, D4):** a mano para todos, también los corredores propios; el servidor no registra el formulario automático (sin perfiles ni Chromium con ventana) y conectar un perfil, abrir la ventana o publicar con una cuenta de perfil responden `MARKETPLACE_AUTOMATION_NOT_ALLOWED`. El formulario automático sigue en el Mac del operador, para desarrollo.
- **Marketplace a mano (F7, ADR-0023):** el formulario automático con el perfil del navegador queda solo para los corredores propios del operador (`operatorOwned`). Para los demás, la cuenta de Marketplace es "a mano" (`meta.mode = manual`, sin perfil ni Facebook abierto en el Mac del operador): al publicar, el sistema deja listos el texto, las fotos y el precio en pesos, el corredor publica él mismo y confirma con el enlace (o marca "No lo publiqué"). Abrir el formulario automático para un corredor ajeno responde `MARKETPLACE_AUTOMATION_NOT_ALLOWED` (403).

## Discord (F9, contenido de marca)

Detalle en `docs/integraciones/discord.md` (§0, lo que hace hoy AgentSales) y spec F9 §4.4 a §4.6.

- **Mecanismo:** un **webhook de canal** (D7: sin bot, foros ni embeds). La URL del webhook es el secreto: se conecta con `pbpaste | pnpm -s cli accounts connect discord --broker <slug> --webhook-stdin`, que la lee en Discord sin publicar y la guarda cifrada (`{ webhookUrl }`); nunca se imprime ni va al log. Un canal por marca.
- **Publicar:** Execute Webhook (`/api/v10/webhooks/<id>/<token>?wait=true`), texto de hasta 2.000 caracteres con `@everyone`/`@here` neutralizados y siempre `allowed_mentions: { parse: [] }`, y hasta 10 archivos de 20 MiB (`multipart`). El video es el liviano para Discord (`discord_video`, bajo 19 MiB, F9.5-T10) si `post.media` lo armó (el post va a Discord y el más liviano de los demás pesa más de 20 MiB) y, si no, la variante más liviana del post (`x_video` o `ig_reel`); si igual pesa más de 20 MiB (por ejemplo, un video tan largo que a 19 MiB se vería ilegible), sale solo el texto con una nota (sin enlace seguro al video todavía, D8).
- **Sin idempotencia:** se envía una sola vez (`sendOnce`); un corte, un 5xx o una respuesta sin el mensaje dejan `outcome_unknown` y el operador dice si salió. Un 429 se espera (corto) o reprograma (largo); un 404 o 401 del webhook deja la cuenta vencida (hay que conectar otro).
- **Estado:** construido y probado solo con simulaciones (msw). **La prueba S5 del operador (spec F9 §4.8) es obligatoria antes de publicar de verdad.**

## X (F9, contenido de marca)

Detalle en `docs/integraciones/x.md` (§0, lo que hace hoy AgentSales) y spec F9 §4.4 a §4.7 y §4.12.

- **Conectar:** OAuth 2.0 con PKCE (cliente confidencial, `X_CLIENT_ID` y `X_CLIENT_SECRET`). `pnpm -s cli accounts connect x --broker <slug>` abre el inicio (`/api/oauth/x/start`) con la sesión del panel en el host de `X_REDIRECT_URI` (en el Mac, `127.0.0.1`). El `state` firmado es de un solo uso y el verificador de PKCE va solo en la cookie firmada. Credenciales `{ accessToken, refreshToken }` cifradas.
- **Token:** dura unas 2 h; se renueva al publicar y en el job `tokens.refresh` con la misma función (`ensureRotatingAccessToken`), con tope de 10 s; solo `invalid_grant` deja la cuenta vencida.
- **Publicar:** texto de 280 caracteres ponderados con hasta 4 imágenes o 1 video (`x_video`, subido por partes), una sola vez (`sendOnce`). El 402 por saldo y el 429 son "no enviado" (el 429 se reprograma); el 403 por texto repetido, un 5xx o un corte dejan `outcome_unknown`. Sin hilos.
- **Retirar:** desde F9.5-T09, `pnpm -s cli publications retire <id> --delete` lo borra por la API (`DELETE /2/tweets/{id}`; un 404 cuenta como borrado), solo con la publicación y la API en `live` y la cuenta en modo `api`; el token se renueva antes si le quedan menos de 30 min, bajo el candado de credenciales. Borrar puede costar (no verificado, `x.md` §2.1) y no se anota. Con la cuenta a mano, se borra a mano en X y se retira sin `--delete`.
- **Costo:** pago por uso. Cada publicación anota `cost_usd` (US$0,015; US$0,20 con enlace). Un enlace exige la marca explícita del operador en el post (`xLinkAllowed`: `post edit <id> --x-link` en la CLI o «Permitir un enlace en X» en el detalle del post). Pasado el tope del mes de la cuenta (`spendLimitUsd`, US$10 por defecto; `accounts spend-limit <id> <dólares>`), la publicación queda `failed` sin llamar a X.
- **Estado:** construido y probado solo con simulaciones (msw). **La prueba S4 del operador (spec F9 §4.8) es obligatoria antes de publicar de verdad.**

## LinkedIn (F9, contenido de marca)

Detalle en `docs/integraciones/linkedin.md` (§0, lo que hace hoy AgentSales) y spec F9 §4.4 a §4.7.

- **Cuenta y conexión:** el **perfil personal** (la página de empresa, después: exige Community Management). OAuth 2.0 con `openid profile w_member_social` (app con *Share on LinkedIn* y *Sign In with LinkedIn using OpenID Connect*; `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` y `LINKEDIN_REDIRECT_URI`). `pnpm -s cli accounts connect linkedin --broker <slug>` abre el inicio en el navegador (con la sesión del panel; el corredor conecta el suyo con `linkedin.connect`); el `state` va firmado con la plataforma y la marca, en la cookie `__Host-agentsales_oauth_li`, y es de un solo uso. Token de **60 días sin refresco**: la agenda avisa 7 días antes y se reconecta.
- **Modo:** **`manual` por defecto** (D5, por el §3.1(26) de sus términos): a la hora programada la publicación queda lista para publicar a mano (`awaiting_manual_confirm`, sin llamar a LinkedIn) y se confirma con el enlace (el URN del post es el `external_id`). `accounts mode <id> api` (administrador) solo con S2 y S3 resueltas.
- **Publicar en `api`:** `POST /rest/posts` con `Linkedin-Version: 202610`: texto (3.000 caracteres con el `commentary` escapado y los hashtags como texto), imagen, varias imágenes (2 a 20) o un video MP4 (subida por partes de 4 MiB). Una sola vez (`sendOnce`); un 5xx o un corte dejan `outcome_unknown`. Un 401 deja la cuenta vencida; un 429 reprograma. **Retirar:** desde F9-T19, `pnpm -s cli publications retire <id> --delete` lo borra por la API (`DELETE /rest/posts/{urn}`; un 404 cuenta como borrado), solo con la publicación y la API en `live` y la cuenta en modo `api`. Con la cuenta a mano o un enlace pegado a mano (URN `activity`), se borra a mano en LinkedIn y se retira sin `--delete`. El panel todavía no retira posts.
- **Estado:** construido y probado solo con simulaciones (msw). **Las pruebas S2 y S3 del operador (spec F9 §4.8) son obligatorias antes de publicar de verdad.**

## TikTok (F9, contenido de marca)

Detalle en `docs/integraciones/tiktok.md` (§0, lo que hace hoy AgentSales) y spec F9 §4.6 y §4.7 (D16).

- **Mecanismo:** Content Posting API en modo *Upload* (permiso `video.upload`): el video va como **borrador a la bandeja** del creador, que lo termina (pega el texto, que en este modo no se envía) y lo publica en la app. Solo video: un post sin video no va a TikTok. Publicar directo en público (*Direct Post*, con auditoría), fotos y el compositor con las etiquetas comerciales y de IA quedan para el piloto.
- **Conexión:** Login Kit (OAuth) con `pnpm -s cli accounts connect tiktok --broker <slug>`, que abre `/api/oauth/tiktok/start?broker=<slug>` en el navegador (con la sesión del panel); el `state` va firmado con la plataforma y la marca en la cookie `__Host-agentsales_oauth_tt` y sirve una vez. Permiso `tiktok.connect` (el corredor o la marca conecta la suya). Credenciales `{ accessToken, refreshToken }` cifradas; el token de 24 h se renueva con el refresh token (365 días, puede rotar) al publicar y en `tokens.refresh`, con `ensureRotatingAccessToken`. Variables: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` y `TIKTOK_REDIRECT_URI`.
- **Publicar:** init con `FILE_UPLOAD`, el video (la variante `ig_reel`, 9:16) leído de R2 por trozos de 10 MiB con `Range` y subido en orden, y la consulta del estado (sin webhooks). Al llegar a `SEND_TO_USER_INBOX` la publicación queda en `awaiting_manual_confirm` hasta que el operador pega el enlace del video (`publications confirm`). `FAILED` la deja fallida (el reintento sube desde cero); el tope de 5 envíos pendientes por 24 h reprograma. En `dry-run` no se llama a TikTok. **Retirar:** TikTok no tiene cómo borrar por la API (D9 de F9.5): se borra a mano en la app y se marca con `publications retire <id>`; con `--delete` responde `TIKTOK_DELETE_UNSUPPORTED` sin llamar.
- **Estado:** construido y probado solo con simulaciones (msw). **La prueba S6 del operador (spec F9 §4.8) es obligatoria antes de publicar de verdad.**

## Yapo (post-MVP)

Sin API pública conocida. Evaluar el mismo enfoque que Marketplace y revisar sus términos de uso antes.

## Checklist para agregar una plataforma nueva

1. Nota de integración en `docs/integraciones/<plataforma>.md`: auth, límites, formatos y riesgos.
2. ADR si el mecanismo es nuevo (ej. primera integración por navegador).
3. Agregar el valor al enum `platform` con una migración.
4. Implementar `Publisher` en `packages/publishers/<plataforma>/` con tests de contrato (HTTP simulado con msw).
5. Plantilla de contenido y variantes de medios para la plataforma.
6. Probar en `dry-run`; antes de la primera publicación en `live`, la prueba de entrada a mano con una cuenta propia o de prueba (como S1 a S6 de F9), con su resultado anotado en la nota de integración.
7. Si la red tiene un modo a mano, sumarla a `MANUAL_MODE_PLATFORMS`; si su token rota, a `ROTATING_TOKEN_PLATFORMS`; y un consejo para cada código de error nuevo (`publicationErrorAdvice`, su test lo exige).
