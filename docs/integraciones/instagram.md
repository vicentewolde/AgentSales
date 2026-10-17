# Instagram (Instagram API with Instagram Login)

Nota verificada el 2026-10-02 (límites de contenido) y completada el 2026-10-04 (autenticación, operaciones, límites, errores, revisión de la app) para planificar F3.

**Ampliada el 2026-10-15 (planificación de F6):** la sección 6.1 verifica qué informa la API al llegar al límite de publicación, los códigos de límite de llamadas y las cabeceras de uso. Esa ronda se leyó con la misma herramienta que extrae y resume el texto (páginas oficiales de Meta y sus versiones `.md`); no se hizo ninguna llamada a la API.

Convención: **DOC** = documentación oficial de Meta; **INFERENCIA** = deducido; **NO VERIFICADO** = falta prueba real. Todo lo marcado NO VERIFICADO se prueba con la cuenta del operador en la demo de F3 (primero en `dry-run`, luego en `live` con su autorización); la lista consolidada está en la sección 8.

Aviso de método: las páginas de Meta se leyeron con una herramienta que extrae y resume el texto, no en el navegador. Las cifras y los nombres exactos coinciden entre varias páginas, pero las citas literales cortas pueden tener paráfrasis. Antes de codificar algo crítico (por ejemplo la tabla de errores), conviene abrir la página y confirmar.

## 1. Resumen

- **Prueba real (2026-10-06, demo de F3, cuenta @vicentewoldec, `v25.0`):** con el token de Generate token y URLs prefirmadas de R2 se publicó un carrusel de 5 imágenes (cerca de 1 min) y un reel (cerca de 2 min), con sus `permalink` (`/p/…` y `/reel/…`), y se borraron a mano. Detalle en la lista de la sección 8.
- **Mecanismo:** API de Instagram con Instagram Login (host `graph.instagram.com`). Se crea un contenedor por medio, se consulta su estado y se publica con `media_publish`. Madurez alta; riesgo bajo para cuentas propias.
- **Cuenta y app (DOC):** cuenta profesional (Empresa o Creador), **sin** Página de Facebook obligatoria. App tipo **Business**. Con **acceso estándar** (el de por defecto) la app sirve solo a personas con rol en ella: alcanza para la demo con la cuenta del operador, sin App Review. Terceros (F7) exigen acceso avanzado: App Review y verificación del negocio.
- **Autenticación (DOC):** OAuth con `https://www.instagram.com/oauth/authorize`; el código dura 1 hora; token corto de 1 hora; token largo de 60 días; refresco con `refresh_access_token` (token de al menos 24 h, vigente). El `client_id` y el `client_secret` son el **Instagram app ID y secret**, que **no** son los de Settings > Basic.
- **Punto crítico para el plan:** la doc no dice si `http://localhost` se acepta como redirect URI. **Verificado el 2026-10-05: el panel lo rechaza** (sección 3.6). En F3 la cuenta se conecta con el token de Generate token (spec F3, D4).
- **Borrar:** la referencia oficial limita `DELETE /<media_id>` a Facebook Login. Con Instagram Login **no está documentado**; se borra a mano desde la app. Se puede probar una vez en la demo (sección 4).
- **Límites:** el contenido ya verificado (sección 5), 400 contenedores y 100 publicaciones por 24 h móviles. Ojo: la doc de Meta se contradice (100 en la guía, 50 en la referencia de `content_publishing_limit`). El código debe leer `quota_total` en vez de fijar el número.
- **Correcciones a `docs/03-plataformas.md`:** el rango de reels "5 a 90 s" no es un límite de la API (es una decisión de producto); el límite no es "50 a 100" sino lo anterior; el plazo de App Review "2 a 4 semanas" no figura en la doc (NO VERIFICADO); "la API no permite borrar" queda matizado (ver sección 4).

## 2. Requisitos de cuenta y app

| Requisito | Dato | Fuente |
|---|---|---|
| Tipo de cuenta | Profesional: "businesses and creators". `account_type` devuelve `BUSINESS` o `MEDIA_CREATOR` | DOC |
| Página de Facebook | No requerida: "This API setup does not require a Facebook Page to be linked" (que la cuenta del operador esté vinculada a una Página no molesta) | DOC |
| Tipo de app | **Business**. Si la app no lo es, hay que crear otra | DOC (get-started) |
| Producto | "Instagram API with Instagram Login" (panel: Instagram > API setup with Instagram login) | DOC |
| Permisos (scopes) | `instagram_business_basic` y `instagram_business_content_publish` bastan para F3. Existen además `instagram_business_manage_messages` e `instagram_business_manage_comments`: no se piden | DOC |
| Scopes antiguos | Los valores anteriores a `instagram_business_*` quedaron deprecados el 2025-01-27 | DOC |
| Acceso estándar | Por defecto; "intended for apps that will only be used by people who have roles on them, during app development, or for testing". Sirve para cuentas propias o agregadas a la app | DOC (overview, business-login) |
| Acceso avanzado | Obligatorio si la app sirve cuentas profesionales que no son del dueño. Exige **App Review** y **verificación del negocio** | DOC |
| Verificación del negocio | Necesaria si usuarios sin rol en la app (ni en un Business dueño de la app) la van a usar | DOC |
| Costo | Ninguno documentado. Se asume gratis | INFERENCIA |
| Plazo de App Review | No figura en la doc. El "2 a 4 semanas" de `03-plataformas.md` queda **NO VERIFICADO** | NO VERIFICADO |
| Limitaciones de Instagram Login | Sin búsqueda de hashtags, sin etiquetas de producto, sin anuncios de colaboración pagada con partner ads; "cannot access ads or tagging" | DOC |
| Webhooks | La guía los menciona, pero publicar no los necesita (decisión del operador: no se usan) | DOC + decisión |

**Dar acceso al operador (pista):** la guía oficial solo dice que se genera el token en el panel junto a la cuenta de Instagram. Según la comunidad de Meta, para sumar una cuenta como tester hay que usar el rol **"Instagram Tester"** (no el rol "Tester" genérico), y luego aceptar la invitación en instagram.com > Editar perfil > Aplicaciones autorizadas > pestaña "Tester invites". ESTADO.md dice que el tester ya está aceptado (2026-10-02), así que esto solo importa si hay que repetirlo. Fuente: hilo de la comunidad (pista, no oficial).

**Nota sobre App Review para el MVP:** F3 no la necesita. En F7 (terceros) se pide acceso avanzado a `instagram_business_content_publish` e `instagram_business_basic`; el plazo se conocerá al enviarla.

### 2.1 Qué ID y secret usa el OAuth (confirmar el par de `.env`)

- **DOC:** `client_id` = "Your app's **Instagram App ID** displayed in App Dashboard > Instagram > API setup". `client_secret` = "Your **Instagram App Secret** displayed in App Dashboard". La página de resumen de la plataforma dice que se obtienen "configuring the business login settings in the App Dashboard". Son distintos de los del App ID y App secret de la app de Facebook (Settings > Basic): la pista de la comunidad coincide en que son **dos pares distintos** dentro de la misma app. Que siempre sean distintos: NO VERIFICADO; se comprueba mirando ambos.
- **Ruta del menú según la doc oficial:** `App Dashboard > Instagram > API setup with Instagram login > 3. Set up Instagram business login > Business login settings`.
- **Ruta en el panel nuevo (por casos de uso), según fuentes de terceros:** `Use cases > (caso de uso de Instagram) > Customize > API setup with Instagram login`. NO VERIFICADO cuál de las dos ve el operador.

Instrucción paso a paso para el operador (no pegues el secret en el chat):

1. Entra a developers.facebook.com/apps y abre `AgentSales-IG`.
2. En el menú izquierdo abre **Instagram > API setup with Instagram login** (o **Use cases > Customize > API setup with Instagram login** en el panel nuevo).
3. Baja al paso **3. Set up Instagram business login** y pulsa **Business login settings**.
4. Ahí aparecen **Instagram app ID**, **Instagram app secret** (botón "Show") y la lista **OAuth redirect URIs** (también el **Embed URL**, que trae `client_id`, `redirect_uri` y `scope` ya armados).
5. Abre el `.env` en tu editor y compara: `INSTAGRAM_APP_ID` (antes `META_APP_ID`) debe ser **igual al Instagram app ID**, y `INSTAGRAM_APP_SECRET` igual al Instagram app secret (compara los primeros y los últimos 4 caracteres, sin copiarlo a ninguna parte).
6. Compara con **Settings > Basic** (App ID y App secret de la app de Facebook). Si lo que tienes en `.env` coincide con **ese** par, es el equivocado: el OAuth de Instagram fallará (la comunidad reporta "Invalid platform app" o "Invalid client_id").
7. Confirma que el App ID de `.env` es el del paso 4 en el panel; si no, corrige el `.env`.
8. Prueba barata sin tocar tokens: abre en el navegador `https://www.instagram.com/oauth/authorize?client_id=<ID>&redirect_uri=<URI>&response_type=code&scope=instagram_business_basic` con tu ID. Si muestra la pantalla de permisos, el ID es válido; si muestra error de app o de URI, no.

Recomendación para el spec: nombrar las variables `INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET` en lugar de `META_*`, para que no se confundan con el par de Settings > Basic (ver sección 11).

## 3. Autenticación

### 3.1 URL de autorización (DOC)

`GET https://www.instagram.com/oauth/authorize`

| Parámetro | Obligatorio | Valor |
|---|---|---|
| `client_id` | sí | Instagram app ID (sección 2.1) |
| `redirect_uri` | sí | Debe coincidir exactamente con una de las "OAuth redirect URIs" del panel. El panel puede agregar una `/` final: revisar la lista |
| `response_type` | sí | `code` |
| `scope` | sí | Separados por coma o por espacio: `instagram_business_basic,instagram_business_content_publish` |
| `state` | no (usarlo igual) | Valor opaco para protección CSRF; vuelve en la redirección |
| `force_reauth` | no | `true` obliga a iniciar sesión con la cuenta profesional (útil para elegir la cuenta correcta) |
| `enable_fb_login` | no | `false` oculta el login con Facebook en la pantalla de Instagram (por defecto `true`). Agregado el 2026-02-06 |

- `force_reauth` y `enable_fb_login` salen de la guía de Business Login; la página de referencia `oauth-authorize` no los lista (DOC, páginas desiguales; confirmar probando).
- Si el usuario rechaza: la redirección trae `error=access_denied&error_reason=user_denied&error_description=...` (DOC).
- Éxito: la redirección trae `?code=...`. El código **dura 1 hora y es de un solo uso** (DOC). La doc advierte que al final viene un `#_` que **no** es parte del código: hay que quitarlo (DOC). Si se copia a mano desde la barra de direcciones, quitar `#_`.

### 3.2 Código por token corto (DOC)

`POST https://api.instagram.com/oauth/access_token` con `client_id`, `client_secret`, `grant_type=authorization_code`, `redirect_uri` (idéntico al de la autorización) y `code`. Los ejemplos de la doc usan formulario (`-F`); `application/x-www-form-urlencoded` es lo esperable (INFERENCIA).

Respuesta: `access_token` (token corto, **1 hora**), `user_id` y `permissions` (cadena separada por comas). **La doc muestra la respuesta envuelta en `"data": [ { ... } ]`**; la API real suele devolver el objeto plano. NO VERIFICADO: el parser debe aceptar ambas formas.

### 3.3 Token corto por token largo (DOC)

`GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=<SECRET>&access_token=<CORTO>`

- Respuesta: `access_token`, `token_type` (`bearer`) y `expires_in` en segundos; el ejemplo de la doc muestra `5183944` (unos 60 días).
- Debe hacerse **en servidor**: lleva el secret.
- Los tokens que se generan con el botón **Generate token** del panel ya son **largos (60 días)**; los del flujo de Business Login son cortos (1 hora) hasta canjearlos (DOC, get-started).

### 3.4 Refresco (DOC)

`GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<LARGO>`

Condiciones:
- El token debe tener **al menos 24 horas** de antigüedad.
- Debe estar **vigente**: un token vencido no se refresca (hay que reconectar la cuenta). La doc dice que tokens sin refrescar durante 60 días "expiran permanentemente".
- La cuenta debe haber concedido `instagram_business_basic`.
- La respuesta trae un token y su nueva vigencia (se asume otra vez 60 días: INFERENCIA).
- No hay doc de cuántas veces se puede refrescar: sin límite conocido.

### 3.5 Identificar la cuenta (DOC)

`GET https://graph.instagram.com/v25.0/me?fields=user_id,username,account_type,name,profile_picture_url,media_count&access_token=...`

| Campo | Significado |
|---|---|
| `id` | ID de la persona **con alcance de app** (app-scoped) |
| `user_id` | **ID de la cuenta profesional de Instagram (`<IG_ID>`)**; es el que se usa en `/<IG_ID>/media` y `/<IG_ID>/media_publish` |
| `account_type` | `BUSINESS` o `MEDIA_CREATOR` |

- El `user_id` que devuelve el canje del código aparece descrito como "Instagram-scoped user ID". Si coincide con `user_id` de `/me` o con `id`: NO VERIFICADO. **Regla recomendada:** después de conectar, llamar a `/me?fields=user_id,username,account_type` con el token largo y guardar **ese** `user_id` como identificador de la cuenta (`platform_accounts.external_id`) y `username`/`account_type` como datos visibles.
- La respuesta de `/me` también aparece en la doc envuelta en `"data": [ ]`: igual que arriba, parser tolerante.
- `me` en lugar del ID: la guía de inicio usa `/me` para leer el perfil y `/<IG_ID>/media` para listar medios. Si `/me/media` y `/me/media_publish` funcionan: NO VERIFICADO; usar el `user_id`.

### 3.6 Redirect URI en local: ¿`http://localhost`?

> **Verificado el 2026-10-05 en el panel del operador (diseño por casos de uso): NO lo acepta.** Al guardar `http://localhost:8787/oauth/instagram/callback` en "URL de redireccionamiento" (Casos de uso > Administrar mensajes y contenido en Instagram > Personalizar > Configuración de la API con el inicio de sesión de Instagram > 4. Configura un inicio de sesión empresarial de Instagram > Configurar), el panel responde "Error al guardar los URI de redireccionamiento. Verifícalos y vuelve a intentarlo". En F3 la cuenta se conecta con el token de **Generate token** (alternativa 1, spec F3 D4). No se probó `https://localhost`.
>
> En ese mismo panel, los permisos `instagram_business_basic` e `instagram_business_content_publish` no venían agregados al caso de uso: se agregaron el 2026-10-05 en la pestaña "Permisos y funciones" y quedaron "Listo para prueba" (acceso estándar, sin App Review). El "Identificador de la aplicación de Instagram" se ve en la pestaña de configuración de la API, distinto del identificador general de la app.

- **DOC:** solo dice que la URI debe coincidir exactamente con la lista del panel. **No dice nada** sobre HTTP, HTTPS ni `localhost` para Instagram Login. La página de seguridad de Facebook Login define "Enforce HTTPS" (exige HTTPS en las redirecciones OAuth), pero tampoco menciona `localhost`, y es de otro producto.
- **Pistas no oficiales (contradictorias):** hay reportes de que Instagram rechaza `http://localhost` (error "invalid redirect_uri") y se arregló con `https://localhost:...`, y otros de que en modo desarrollo `http://localhost` funciona (en Facebook Login se dice que HTTP en `localhost` está permitido solo mientras la app está en modo desarrollo; sin cita oficial).
- **Conclusión (antes de la prueba; resuelta arriba, el panel lo rechaza):** la prueba es inmediata y sin riesgo: pegar `http://localhost:8787/oauth/instagram/callback` en "OAuth redirect URIs" y guardar. Si el panel lo rechaza, la respuesta está ahí. Si lo guarda, aun así hay que ver que la pantalla de autorización no falle (punto 8 de la sección 2.1).

Alternativas si no acepta HTTP (de menos a más esfuerzo):

1. **Token del panel (documentado, sin OAuth):** botón **Generate token** junto a la cuenta, en API setup with Instagram login. Entrega un token **largo (60 días)** y no necesita redirect. El sistema acepta el token pegado una vez (`agentsales` CLI o formulario del panel), lo cifra y lo refresca como cualquier otro. Sirve para la demo de F3 y para el piloto con una cuenta; el OAuth completo se necesita solo para conectar cuentas de terceros (F7). Si ese token se puede refrescar igual: NO VERIFICADO (la doc de refresco habla de "long-lived token" en general).
2. **HTTPS local con certificado de confianza (mkcert):** registrar `https://localhost:8787/oauth/instagram/callback`; Hono con `@hono/node-server` acepta opciones TLS. Sin dependencias nuevas en producción, solo un certificado local. NO VERIFICADO que Instagram acepte `https://localhost`: hay reportes de que sí.
3. **Redirigir a una URL HTTPS cualquiera y copiar el código a mano:** registrar una URL HTTPS que no hace falta que responda (o un túnel); tras aprobar, el navegador queda en esa URL con `?code=...#_`; el operador copia el `code` (sin `#_`) y lo pega en el sistema (un comando `agentsales instagram connect --code`). El código vale 1 hora. NO VERIFICADO que el panel acepte una URL que no existe; no hay verificación de dominio documentada.
4. **Túnel (cloudflared, ngrok):** la URL pública HTTPS apunta a `localhost:8787`. Los túneles rápidos cambian de dirección en cada arranque (hay que re-registrar la URI); un túnel con nombre y dominio propio es estable. Es lo que la comunidad recomienda; añade una herramienta.

## 4. Operaciones

Todas con `Authorization` por parámetro `access_token` (o cabecera `Authorization: Bearer`; INFERENCIA, la doc usa el parámetro), host `graph.instagram.com`. Versión: los ejemplos de la doc usan **v25.0** (la última versión de Graph API es v26.0, publicada el 2026-07-29). Algunas páginas de OAuth omiten la versión. Se recomienda fijar `v25.0` en una constante configurable; si `graph.instagram.com` acepta v26.0 o llamadas sin versión: NO VERIFICADO.

### 4.1 Publicar una imagen suelta (DOC)

1. `POST /<IG_ID>/media` con `image_url` (URL pública), `caption` (opcional), `alt_text` (opcional, hasta 1000 caracteres, solo para imágenes). Devuelve `{ "id": "<CONTAINER_ID>" }`.
2. `POST /<IG_ID>/media_publish` con `creation_id=<CONTAINER_ID>`. Devuelve `{ "id": "<MEDIA_ID>" }`.

### 4.2 Publicar un carrusel (DOC)

1. Un contenedor **por ítem**: `POST /<IG_ID>/media` con `image_url` (o `video_url`) y `is_carousel_item=true`. Los hijos **no llevan caption**.
2. Contenedor del carrusel: `POST /<IG_ID>/media` con `media_type=CAROUSEL`, `children=<id1>,<id2>,...` (hasta **10**), `caption`.
3. `POST /<IG_ID>/media_publish` con `creation_id=<ID_DEL_CARRUSEL>`.

- El subcódigo 2207028 dice "carruseles de 2 a 10 fotos o videos": **mínimo 2** (DOC, tabla de errores).
- Los reels **no** pueden ir como hijos (DOC).
- Un carrusel de N imágenes gasta **N + 1 contenedores** del tope de 400 (sección 6).
- Parámetro opcional `is_ai_generated=true` (DOC, 2026-06-22): autodeclaración de contenido hecho con IA. En carruseles va **solo en el contenedor padre**; ponerlo en un hijo da error. Es opcional. Si AgentSales debe usarlo: decisión del operador (ver sección 11).

### 4.3 Publicar un reel (DOC)

`POST /<IG_ID>/media` con `media_type=REELS`, `video_url` (obligatorio), `caption`, y opcionales:
- `share_to_feed`: "When true, indicates that the reel can appear in both the Feed and Reels tabs". El valor por defecto no se documenta (NO VERIFICADO): enviarlo explícito.
- `cover_url`: imagen de portada, "for Reels only". `thumb_offset`: milisegundos del cuadro a usar como miniatura ("for videos and reels"). Si se pueden mandar los dos a la vez y cuál gana: NO VERIFICADO. El error 2207057 avisa de un `thumb_offset` fuera del video.
- `collaborators`, `location_id`, `trial_params`, `is_ai_generated`: no se usan.

Luego se consulta el estado hasta `FINISHED` y se publica con `media_publish`.

### 4.4 Estado del contenedor (DOC)

`GET /<CONTAINER_ID>?fields=status_code,status`

| `status_code` | Significado |
|---|---|
| `IN_PROGRESS` | Aún se procesa |
| `FINISHED` | Listo para publicar |
| `ERROR` | Falló; el campo `status` trae el **subcódigo** de error (sección 7) |
| `EXPIRED` | No se publicó en 24 h y expiró |
| `PUBLISHED` | Ya está publicado |

- **Ritmo recomendado por Meta:** "querying a container's status once per minute, for no more than 5 minutes".
- **Vida del contenedor:** 24 horas (DOC: "Containers expire after 24 hours").
- La doc dice que consultar el estado sirve "si `POST /media_publish` no devuelve el ID del medio publicado".
- Las imágenes suelen quedar `FINISHED` casi al instante, y los videos tardan más. **Medido el 2026-10-06:** una imagen suelta quedó `FINISHED` en la primera consulta (`pnpm ig:smoke`); en `live`, el carrusel de 5 imágenes salió en cerca de 1 min y el reel en cerca de 2 min, de punta a punta.

### 4.5 Subida reanudable para reels (DOC)

La página de publicación con Instagram Login documenta `upload_type=resumable`: se crea el contenedor con `media_type=REELS` y `upload_type=resumable`, y luego se envía el archivo con `POST https://rupload.facebook.com/ig-api-upload/<CONTAINER_ID>` con las cabeceras `Authorization: OAuth <TOKEN>`, `offset` y `file_size` (el cuerpo es el archivo; también admite un archivo alojado en un servidor público). Respuesta de éxito: `{"success":true,"message":"Upload successful."}`.
- Valor para AgentSales: **evita exponer una URL pública para el reel** (se sube desde el worker). Los reels son lo que más pesa y lo que más puede fallar con URLs (descarga lenta, `2207003`).
- Si funciona con tokens de Instagram Login en la práctica y la forma exacta de cada solicitud: **NO VERIFICADO**. Se deja como plan B del reel; no entra en F3 salvo que `video_url` con URL prefirmada falle.
- Solo existe para video; las imágenes siempre necesitan `image_url`.

### 4.6 Permalink y datos del medio (DOC)

`GET /<MEDIA_ID>?fields=id,media_type,media_product_type,permalink,timestamp,caption,is_shared_to_feed` (host `graph.instagram.com` para Instagram Login).
- `permalink` es la "permanent URL to the media". **No** está disponible en los hijos de un álbum: pedirlo del ID del **carrusel** (el que devuelve `media_publish`), no de los hijos.
- Con el `permalink` se guarda la URL de la publicación (criterio de aceptación de F3).
- `media_product_type` distingue `FEED` y `REELS`. Formato del enlace de un reel (`/reel/...`): INFERENCIA. El publisher (F3-T09) pide `media_type` y `media_product_type` en los últimos medios para no confundir el carrusel con el reel del mismo aviso, que llevan el mismo caption.

### 4.7 Editar, pausar y cerrar

- **Editar el caption de un medio ya publicado:** no se documentó en lo consultado (la referencia de `IG Media` ofrece `POST /<MEDIA_ID>` solo para activar o desactivar comentarios). Se asume **no soportado**: NO VERIFICADO. Un cambio de texto implica publicar de nuevo (y borrar a mano el anterior).
- **Pausar/archivar:** no existe en la API (INFERENCIA; no aparece en la doc).

### 4.8 Borrar una publicación

- **DOC (referencia de `IG Media`, sección Deleting):** `DELETE /<IG_MEDIA_ID>` borra publicaciones que no son anuncios, historias, reels y **álbumes completos** (no se puede borrar un ítem suelto de un carrusel: se usa el ID del carrusel). El changelog lo registra el **2025-12-03** como novedad ("all versions", permiso `instagram_manage_contents`).
- **Pero** la tabla de requisitos de esa sección lista solo **Facebook Login**: token de usuario de Facebook, host `graph.facebook.com`, permisos `instagram_basic` e `instagram_manage_contents`, y la limitación dice que "this api only supports Instagram API with Facebook login only". Lo leí en las dos páginas de referencia (`ig-media` e `instagram-media`). El changelog no precisa el tipo de login.
- **Conclusión:** con **Instagram Login la API no permite borrar** según la doc vigente. El permiso `instagram_manage_contents` no está entre los cuatro scopes `instagram_business_*`.
- **Para la demo:** la muestra se borra **a mano** desde la app de Instagram (abrir la publicación > menú de tres puntos > Eliminar). Como prueba opcional se puede intentar una vez `DELETE graph.instagram.com/<MEDIA_ID>` sobre la publicación de muestra (el resultado esperado es un error de permisos). Si funcionara, se documenta; el código de F3 no debe depender de eso.
- **Efecto en el sistema:** "cerrar" en Instagram = marcar como no disponible y avisar al operador (como ya dice `03-plataformas.md`).

## 5. Medios

La publicación necesita URLs públicas (DOC): "We cURL media used in publishing attempts, so the media must be hosted on a publicly accessible server at the time of the attempt". La doc no distingue subir imágenes de subir videos para esto.

### Imágenes (DOC, referencia IG User Media)

| Requisito | Valor |
|---|---|
| Formato | **JPEG** (los JPEG extendidos MPO y JPS no se soportan; la guía dice que JPEG es el único formato) |
| Peso máximo | **8 MB** (el error 2207004 dice "less than 8 MiB") |
| Proporción | entre **4:5 y 1,91:1** (de 0,8 a 1,91) |
| Ancho mínimo | 320 px (se escala hacia arriba si hace falta) |
| Ancho máximo | **1440 px** (se escala hacia abajo si hace falta) |
| Espacio de color | **sRGB** (otros se convierten a sRGB) |
| URL | pública en el momento del intento; Instagram descarga ("cURL") la imagen |

- Carrusel: todas las imágenes se recortan según la **primera** del carrusel; por defecto 1:1 si no se indica otra (DOC). Nuestro estándar de 1080x1350 (4:5) respeta el rango, el ancho de 1080 está entre 320 y 1440, y 1350 de alto con ratio 0,8 cae justo en el límite inferior de 4:5. Evitar ratios aun más verticales por redondeos (por ejemplo 1080x1351).
- Tamaño de un JPEG de 1080x1350 con calidad ~85: 200 a 500 KB (INFERENCIA), muy por debajo de 8 MB.

### Carrusel (DOC)

- Máximo **10** ítems (imágenes, videos o mezcla); mínimo **2** (tabla de errores). `docs/04-formato-publicaciones.md` ya fija "máximo 10 slides" con "verificar": queda **verificado**. Con portada y ficha, hasta 8 fotos de contenido, como ya dice el doc.
- Los videos dentro de un carrusel: la referencia consultada no da especificaciones distintas a las del reel (NO VERIFICADO si aplican las mismas). No se usan en F3.

### Reels (DOC, referencia IG User Media)

| Requisito | Valor |
|---|---|
| Contenedor | **MOV o MP4**, sin *edit lists*, con el `moov` al inicio (`-movflags +faststart`) |
| Video | **HEVC o H.264**, barrido progresivo, GOP cerrado, submuestreo 4:2:0 |
| Audio | **AAC**, hasta 48 kHz, 1 o 2 canales; bitrate de audio 128 kbps |
| Frame rate | **23 a 60 FPS** |
| Resolución | máximo **1920 px** en horizontal; proporción entre 0,01:1 y 10:1, **recomendada 9:16** |
| Bitrate de video | VBR, máximo **25 Mbps** |
| Duración | mínimo **3 s**, máximo **15 min** |
| Peso | máximo **300 MB** |
| Portada (cover) | JPEG, hasta 8 MB, sRGB; recomendada 9:16 (si no, se recorta el 9:16 central) |

- **Corrección:** "entre 5 y 90 s" de `docs/03-plataformas.md` y `docs/04-formato-publicaciones.md` no corresponde al límite de la API (3 s a 15 min). Si se quiere mantener 5 a 90 s, es una política de producto de AgentSales (reels cortos), no un requisito de Meta. Decisión del operador.
- Nuestro estándar 9:16 de 1080x1920 cumple (1920 es el máximo en horizontal; con 1080 de ancho y 1920 de alto: el límite se refiere a "horizontal pixels", así que 1080 queda bajo 1920).
- Asegurar `faststart`, sin edit lists y GOP cerrado al codificar con ffmpeg (por ejemplo `-c:v libx264 -pix_fmt yuv420p -movflags +faststart` más GOP cerrado, y `-c:a aac -ar 48000 -b:a 128k`). **Verificado en local (F2-T08, 2026-10-03, ffmpeg 9.0.1)**, con ffprobe en los tests de `packages/media`. Los parámetros están en `REEL_SPEC`:
  - libx264 `veryfast`, CRF 23, `-maxrate 20M -bufsize 40M`, yuv420p, 30 fps.
  - GOP fijo de 2 s y cerrado: `-g 60 -keyint_min 60 -sc_threshold 0 -flags +cgop`. x264 escribe `open_gop=0`, y hay un cuadro clave cada 2 s.
  - AAC estéreo a 48 kHz y 128 kb/s.
  - `-movflags +faststart` (`moov` antes de `mdat`) y `-use_editlist 0` (sin `elst`).

  Hay un desfase de ~67 ms entre el inicio del video y el del audio (dos B-frames de x264), sin edit list que lo corrija; es inocuo, y `-bf 0` lo quita si molestara. **Meta aceptó el reel** en la prueba en `live` del 2026-10-06 (`video_url` con URL prefirmada de R2, `thumb_offset=1000`, `share_to_feed=true`, sin `cover_url`).
- Si el video de origen ya cumple, evitar recodificar; en otro caso, `media.process` genera `ig_reel` (`docs/02-modelo-datos.md`).
- La portada del reel (`cover_url`) pide otra URL pública. Si no hay una imagen 9:16 lista, se puede omitir y dejar que Instagram use el primer cuadro (INFERENCIA), o pasar `thumb_offset`. Decisión de spec.

### Caption (DOC, referencia IG User Media)

- **2.200 caracteres, 30 hashtags y 20 menciones (@)** como máximo (verificado el 2026-10-04; antes NO VERIFICADO). El error 2207010 es "caption exceeds 2.200 characters" y 2207040 "más de 20 etiquetas @". `docs/04-formato-publicaciones.md` ya usa 2.200 y 5 a 12 hashtags: coherente. Validar en código antes de crear el contenedor.
- Los usuarios mencionados reciben una notificación al publicar (DOC): la plantilla no debe mencionar cuentas ajenas.

### URL pública: qué se sabe y qué no

| Pregunta | Respuesta |
|---|---|
| ¿URL pública de cualquier host? | La doc exige "publicly accessible server at the time of the attempt". No impone dominio ni CDN (DOC por omisión) |
| ¿Funcionan las URLs prefirmadas de R2/S3 con query larga? | **Sí para imágenes (verificado el 2026-10-06 con `pnpm ig:smoke`):** un contenedor de imagen con la URL firmada de 1 h de una portada JPEG de 84 KB quedó `FINISHED` en la primera consulta. **Y para el reel (`video_url`), verificado en la prueba en `live` del mismo día.** Lo que sigue es la nota original: **NO VERIFICADO.** La doc no habla de query strings, redirecciones, `Content-Type` ni longitud de URL |
| ¿Exige `Content-Type` correcto? | No está documentado. Terceros reportan que el `Content-Type` incorrecto o la URL que redirige causan 2207052 (pista, no oficial). Dejar `image/jpeg` y `video/mp4` en el objeto (ya lo hacemos) |
| ¿Cuándo descarga Meta? | Imágenes: "at the time of the attempt" (INFERENCIA: al crear el contenedor). Videos: el contenedor queda `IN_PROGRESS` mientras Meta procesa; **puede seguir descargando después del `POST`** (INFERENCIA). Por eso la URL debe seguir vigente hasta `FINISHED` |
| ¿Tiempo de espera de descarga? | El subcódigo 2207003 ("it takes too long to download the media") indica que hay un tope; no se publica cuántos segundos |

**Riesgo propio de R2 (DOC de Cloudflare, consulta 2026-10-04):** una URL prefirmada queda atada a **un método HTTP** y solo funciona en el dominio S3 (`<ACCOUNT_ID>.r2.cloudflarestorage.com`), **no** en dominios personalizados. El vencimiento máximo es 7 días. Si Meta hiciera una petición `HEAD` antes del `GET`, una URL firmada para `GET` daría 403: NO VERIFICADO si Meta lo hace. Plan B (ya anotado en `03-plataformas.md`): un prefijo del bucket público con dominio propio y claves no adivinables, con una regla de ciclo de vida que borre los objetos tras 24 h. Las fotos y el reel terminan siendo públicos en Instagram de todas formas; el reel ya sale sin metadatos GPS (F2).

## 6. Límites

| Límite | Valor | Fuente |
|---|---|---|
| Publicaciones por API por cuenta | **100** en ventana móvil de 24 h (guía de publicación). "Carousels count as a single post" | DOC |
| Contradicción de Meta | Otra sección de la misma guía (Carousel limitations) y la referencia de `content_publishing_limit` dicen **50** (`quota_total` "currently 50") | DOC (contradictoria) |
| Contenedores por cuenta | **400** en 24 h móviles (referencia IG User Media). Un carrusel de N imágenes consume N + 1 | DOC |
| Vida de un contenedor | 24 h | DOC |
| Carrusel | 2 a 10 ítems | DOC |
| Caption | 2.200 caracteres, 30 hashtags, 20 menciones | DOC |
| Llamadas (Instagram Business Use Case) | `4800 × número de impresiones` de la cuenta en 24 h; "impresiones" = veces que el contenido de la cuenta entró en la pantalla de alguien en las últimas 24 h | DOC |

- **Endpoint de consulta:** `GET /<IG_ID>/content_publishing_limit?fields=quota_usage,config&since=<unix>`. `since` es un timestamp "no older than 24 hours" (opcional). Respuesta (DOC): `quota_usage` (veces que se publicó un contenedor desde `since`) y `config` con `quota_total` y `quota_duration` (`86400` s). La referencia lista los permisos de Facebook Login (`instagram_basic`, `instagram_content_publish`, `pages_read_engagement`) y ejemplos con `graph.facebook.com`; la guía de publicación lista el endpoint también. **Si responde con token de Instagram Login en `graph.instagram.com`: la referencia lo lista como requisito desde la relectura del 2026-10-15 (sección 6.1); el valor real de `quota_total` sigue sin medirse.**
- **Qué cuenta:** la referencia dice "IG Container" publicados. Que un carrusel cuenta 1 es **DOC**; si un reel cuenta 1: la doc no distingue (INFERENCIA: 1). Si los reintentos fallidos cuentan: NO VERIFICADO (una publicación fallida no debería consumir cuota de publicación, pero sí contenedores).
- **Cuota de llamadas:** para una cuenta con pocas impresiones el tope baja: con 0 impresiones la fórmula da 0 (INFERENCIA). Una cuenta de prueba nueva podría toparse con el límite 80002 u otro. Observarlo en la demo.
- **Cabeceras:** `X-App-Usage` (`call_count`, `total_cputime`, `total_time`, en % de la hora) y `X-Business-Use-Case-Usage` (con `estimated_time_to_regain_access` en minutos) están documentadas para la Graph API en general. **Si `graph.instagram.com` las devuelve: NO VERIFICADO.** Registrarlas si llegan; no depender de ellas.
- **Mensajería** (2 a 100 llamadas por segundo según endpoint): no aplica.

### 6.1 Al llegar al límite: qué informa la API (verificado el 2026-10-15)

**`content_publishing_limit` con Instagram Login (DOC, referencia leída el 2026-10-15):**

- **Corrige el NO VERIFICADO de arriba:** la referencia lista ahora como requisitos, para Instagram Login, un token de usuario de Instagram, el host **`graph.instagram.com`** y los permisos `instagram_business_basic` e `instagram_business_content_publish` (y para Facebook Login, `graph.facebook.com` con `instagram_basic`, `instagram_content_publish` y `pages_read_engagement`). Es decir, el endpoint está documentado para nuestro tipo de login. Que además responda en la práctica con el token de Generate token: sigue sin medirse (la demo del 2026-10-06 no dejó el valor; ver 8.5).
- **Solicitud:** `GET /<IG_USER_ID>/content_publishing_limit?fields=quota_usage,config&since=<unix>`. `fields` es opcional (por defecto se devuelve solo `quota_usage`). `since` es un timestamp Unix "no older than 24 hours"; si se omite, cuenta las últimas 24 h.
- **Respuesta:** `{"data":[{"quota_usage":2,"config":{"quota_total":50,"quota_duration":86400}}]}`. Va **envuelta en `data: [ ]`** (como las de `/me` y el canje, §3.2): el parser debe leer `data[0]`.
  - `quota_usage`: "number of IG Containers published since the `since` time". Solo cuentan los contenedores **publicados** (los hijos de un carrusel no se publican por separado: un carrusel suma 1, coherente con la guía de publicación).
  - `config.quota_total`: máximo por período, "currently 50". La guía de publicación sigue diciendo 100 en un párrafo y 50 en otro (§6). **La referencia dice 50.** Leer el valor de `config`.
  - `config.quota_duration`: 86400 s ("currently"). Ventana **móvil** de 24 h.
- **El ejemplo pide `rate_limit_settings`**, pero el campo no figura en la tabla de campos ni en la respuesta de ejemplo: NO VERIFICADO; no usarlo.
- **¿Se puede saber cuándo se libera un cupo?** **No.** La API no entrega marcas de tiempo de las publicaciones ni una hora de reinicio; solo `quota_usage` de una ventana móvil. INFERENCIA de diseño: AgentSales conoce la hora de cada `media_publish` hecho por él; con una ventana móvil, el próximo cupo se libera cuando el **más antiguo** de las últimas 24 h cumple 24 h. Para publicaciones hechas por otras apps con la misma cuenta, lo único que se puede hacer es volver a consultar `quota_usage < quota_total` cada cierto tiempo (por ejemplo cada hora). La publicación manual desde la app de Instagram no cuenta: el tope habla de posts "API-published" (DOC).
- **Para planificar el calendario (F6):** antes de cada `media_publish`, consultar el límite y publicar solo si `quota_usage < quota_total`; con el uso de un corredor independiente (pocas publicaciones al día) el tope no debería alcanzarse.

**Error de tope diario (DOC, tabla de errores, 2026-10-15):** código `9`, subcódigo `2207042`, HTTP 400; mensaje "You reached maximum number of posts that is allowed to be published by Content Publishing API."; recomendación oficial: "The app user has reached their daily publishing limit. Advise the app's user to try again the following day." Es decir, Meta no da un plazo exacto más allá de "al día siguiente"; con ventana móvil puede liberarse antes (INFERENCIA). **No es reintentable de inmediato.**

**Códigos de límite de llamadas (DOC, guía de manejo de errores y guía de límites de la Graph API, 2026-10-15):**

| Código | Qué dice la doc | Recomendación de espera | Marca |
|---|---|---|---|
| 4 | "Demasiadas llamadas a la API": la app del token alcanzó su límite. Problema temporal | "Espera y vuelve a intentar la operación". Dejar de llamar: seguir insistiendo alarga la espera; mirar `X-App-Usage`. **Ojo:** con el subcódigo `2207051` (spam) el 4 **no** es un límite de llamadas y no se reintenta | DOC |
| 17 | "Demasiadas llamadas de usuario a la API": el usuario del token alcanzó su límite | Esperar y reintentar; revisar que la app no sea la causa; reducir o espaciar las llamadas del usuario | DOC |
| 80002 | Es el código de error del límite de **uso de negocio de Instagram** (BUC `instagram`): llamadas en 24 h = 4800 × impresiones de la cuenta, por par app y usuario de la app, en ventana móvil de 24 h | **Sin espera fija.** "Si se alcanza el límite, deja de hacer llamadas"; esperar los minutos de `estimated_time_to_regain_access` si llega. **No figura en la tabla de errores de Instagram** | DOC (guía de límites) |
| 613 | "Se alcanzó un límite de frecuencia personalizado"; mirar la doc de cada API | Sin espera fija. No figura en la tabla de errores de Instagram | DOC |
| 32 | Límite de la API de Páginas | No aplica a Instagram Login | DOC |
| 9 / 2207042 | Tope diario de publicaciones (arriba) | "Al día siguiente"; ver la ventana móvil | DOC |

- **Los códigos 17, 80002 y 613 no aparecen en la tabla de errores de Instagram** (`error-codes`), que solo trae 4 (con 2207051) y 9 (con 2207042) entre los de límite. Salen de la guía general de la Graph API.
- **Ninguna página da un tiempo de espera fijo** para 4, 17, 80002 o 613. Política propuesta (INFERENCIA, la fija el spec): usar `estimated_time_to_regain_access` si llega; si no, esperar 1 hora con backoff exponencial y sin consumir reintentos de la publicación (ya en §11, punto 19).

**Cabeceras de uso (DOC, guía de límites de la Graph API):**

- `X-App-Usage`: cadena JSON con `call_count`, `total_time` y `total_cputime`, enteros que son **porcentajes** del límite de la app.
- `X-Business-Use-Case-Usage`: cadena JSON (hasta 32 objetos por llamada, por id de negocio) con `type` (entre ellos `instagram`), `call_count`, `total_cputime`, `total_time` (porcentajes) y **`estimated_time_to_regain_access`, en minutos**: "el tiempo que debe pasar hasta que las llamadas dejen de limitarse".
- **¿Las devuelve `graph.instagram.com`?** NO VERIFICADO. La sección de límites de la visión general de la plataforma de Instagram dice que "todos los endpoints" están sujetos al límite de uso de negocio, pero **no nombra ni las cabeceras, ni el código 80002, ni `estimated_time_to_regain_access`, ni el host**; la guía de límites de la Graph API no nombra hosts; las páginas de Instagram Login y de publicación no mencionan cabeceras. Se mide en una llamada real (8.7): registrar las cabeceras (solo sus nombres y valores, sin tokens) en la próxima corrida de `ig:smoke`.

## 7. Errores comunes

El cuerpo de error de Graph trae `error.code`, `error.error_subcode` y `error.message`. El estado `ERROR` de un contenedor trae el subcódigo en `status`. **Clasificar primero por subcódigo y después por código:** el código 4 sirve tanto para el límite de la app como para `2207051` (spam).

### 7.1 Autenticación y permisos

| Código | Significado (DOC) | Reintento |
|---|---|---|
| 190 | Token caducado o inválido (subcódigos 458 app no instalada, 460 contraseña cambiada, 463 caducado, 467 inválido) | **No**: marcar la cuenta `needs_reconnect` y avisar |
| 10 | Permiso denegado | **No** |
| 200 a 299 | Permiso faltante o no concedido | **No** |
| 102 | Sesión de la API inválida | **No** |

### 7.2 Límites de llamadas (DOC, doc general de Graph API)

| Código | Significado | Reintento |
|---|---|---|
| 4 | Límite de la app | Sí, **con espera** (si el subcódigo es 2207051, **no**: es spam) |
| 17 | Límite del usuario | Sí, con espera |
| 32 | Límite de Página | No esperable con Instagram Login |
| 80002 | Límite de la plataforma Instagram | Sí, con espera |
| 613 | Límite personalizado (lo trae la lista del operador; no figura en las páginas consultadas) | NO VERIFICADO; tratar igual que 17 |
| 9 / 2207042 | Se alcanzó el máximo diario de publicaciones | **No hasta que se libere la ventana**; reprogramar |

Verificado el 2026-10-15 contra la guía de errores y la de límites: ver la sección 6.1 (la tabla de errores de Instagram solo trae 4 con 2207051 y 9 con 2207042; 17, 80002 y 613 vienen de la guía general; ninguna da un tiempo de espera fijo).

Para todos: parar, esperar y espaciar (la doc recomienda detener las llamadas de inmediato: seguir insistiendo alarga la recuperación). Usar `estimated_time_to_regain_access` si llega; si no, 1 hora.

**Cómo lo aplica AgentSales desde F6-T04 (spec F6 §4.5):** `IG_RATE_LIMITED` (4, 17, 80002, 613) e `IG_PUBLISH_LIMIT` (9 / 2207042) llevan `details.waitMinutes` (la espera de la cabecera de uso o 60 min; 6 h para el máximo diario, porque la API no dice cuándo se libera un cupo, §6.1). Con esa señal el intento reprograma la publicación para después de la espera, hasta 3 veces seguidas; la cuarta la deja `failed`.

### 7.3 Errores de medios y publicación (DOC, tabla de errores de Instagram)

| Subcódigo | Código | Significado | Reintento (INFERENCIA) |
|---|---|---|---|
| 2207001 | -1 | Error del servidor de Instagram ("Try again") | Sí, con backoff y contenedor nuevo |
| 2207003 | -2 | Tarda demasiado en descargar el medio | Sí, 1 o 2 veces con URL nueva; si persiste, mirar el origen |
| 2207004 | 36000 | Imagen demasiado grande (menos de 8 MiB) | **No** (contenido) |
| 2207005 | 36001 | Formato de imagen no soportado | **No** |
| 2207006 | 24 | Medio no encontrado (permiso o token vencido): regenerar el contenedor | Rehacer el flujo desde el contenedor |
| 2207008 | 24 | Constructor del medio caducado; contenedor temporalmente no disponible: "try again" en 30 s a 2 min | Sí, mismo contenedor, esperando |
| 2207009 | 36003 | Proporción fuera de 4:5 a 1,91:1 | **No** |
| 2207010 | 36004 | Caption de más de 2.200 caracteres | **No** |
| 2207020 | -2 | El medio expiró (contenedor de más de 24 h) | Contenedor nuevo |
| 2207023 | 100 | Tipo de medio desconocido | **No** |
| 2207026 | 352 | Formato de video no soportado | **No** (recodificar) |
| 2207027 | 9007 | Medio aún no listo | Seguir sondeando y publicar después |
| 2207028 | 100 | Carrusel fuera de 2 a 10 ítems | **No** |
| 2207032 | -1 | No se pudo crear el contenedor ("try again") | Sí, 1 vez con contenedor nuevo |
| 2207035 a 2207037, 2207040 | 100 | Etiquetas de producto o de foto inválidas, o más de 20 @ | **No** |
| 2207042 | 9 | Máximo diario de publicaciones | **No** hasta que se libere |
| 2207050 | 25 | Cuenta restringida, inactiva o con verificación pendiente | **No**: avisar al operador |
| 2207051 | 4 | Sospecha de spam; actividad restringida | **No**: avisar al operador |
| 2207052 | 9004 | No se pudo traer el medio desde la URL | Sí, 1 o 2 veces con URL nueva; si persiste, probar el plan B de URLs |
| 2207053 | -1 | Error desconocido de subida ("try again") | Sí, con contenedor nuevo |
| 2207057 | 1 | `thumb_offset` fuera del video | **No** |

- La lista de retry sale de los textos de la doc ("try again", "regenerate container") y de la lógica de cada error (INFERENCIA). No existe una bandera `is_transient` documentada.
- **Idempotencia de publicar:** si `media_publish` falla o se corta la respuesta, **no volver a llamarlo a ciegas**: consultar el contenedor; si ya está `PUBLISHED`, buscar el medio (por ejemplo `GET /<IG_ID>/media?fields=id,permalink,timestamp,caption&limit=5` y comparar). Cómo obtener el `media_id` a partir de un contenedor `PUBLISHED`: NO VERIFICADO.

## 8. Cómo probar sin riesgo

- **Local (F2):** salida JPEG sRGB 1080x1350, peso < 8 MB, no más de 10 slides; reel: ffprobe confirma códec, fps (23 a 60), duración, `moov` al inicio. Hecho.
- **Tests de F3:** msw o fakes con los cuerpos de la sección 4; ningún test llama a Meta (regla del proyecto).
- **Sandbox de Meta:** no existe un sandbox de publicación. Lo más cercano es la **app en modo desarrollo con acceso estándar y la cuenta del operador** (rol en la app). No hay "cuenta de prueba" separada con datos ficticios para Instagram Login.
- **`pnpm ig:smoke` (F3-T19):** crea un contenedor de imagen desde una URL prefirmada de R2 (la portada de un aviso preparado) y espera `FINISHED` o error, **sin** `media_publish`. Comprueba que Meta acepta la URL firmada (con su query larga) y descarga la imagen (punto 8 de la lista), antes de publicar nada. Un `FINISHED` no dice si Meta hizo un `HEAD` antes del `GET`; eso solo se sabría si fallara con 403 o 2207052. El reel se verificó después, en la prueba en `live` del mismo día.
- **`dry-run` primero:** el publisher arma las solicitudes, valida y registra lo que enviaría, sin llamar a Meta. Luego `live` con una propiedad de muestra, solo con autorización explícita del operador en el chat, y la publicación se borra a mano.

### Lista de pruebas (actualizada con la demo de F3, 2026-10-06)

Orden sugerido, de menor a mayor riesgo; las primeras no publican nada:

1. ~~Guardar `http://localhost:8787/oauth/instagram/callback` en "OAuth redirect URIs"~~ **Resuelto el 2026-10-05: el panel lo rechaza** (§3.6). **2026-10-06:** el token de Generate token sirvió para `/me` (al conectar), crear contenedores y publicar; el sistema estima su vencimiento en 60 días hasta el primer refresco. Queda probar el refresco y su vencimiento real (punto 4).6).
2. ~~Confirmar que `META_APP_ID` es el Instagram app ID~~ **Hecho el 2026-10-05:** las variables se llaman `INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET` y el operador confirmó el identificador de Instagram (sección 2.1).
3. Canje del código: forma de la respuesta (con o sin `data`), y si `user_id` coincide con el `user_id` de `/me`. Ver también qué devuelve un secret o una `redirect_uri` equivocados: hoy cualquier rechazo del canje se informa como "el código venció, ya se usó o la dirección de retorno no coincide" (F3-T08); afinarlo en F7, con el OAuth en uso.
4. **Verificado el 2026-10-07 a las 20:05 (hora de Chile)**: el token de **Generate token** sí se refresca. Con la cuenta conectada el día anterior a las 16:31, el primer `pnpm dev` refrescó al arrancar (`refreshed: 1`, en 1,1 s, con el token en la URL tal como lo documenta Meta), y el vencimiento pasó de estimado a real: 2026-12-06 20:05 (60 días). Un `accounts refresh --force` inmediato no llamó (`too_recent`, desde el 2026-10-08 20:05), y el log no tuvo el token. La programación diaria quedó una sola vez en `pgboss.schedule` (`0 12 * * *`, `America/Santiago`, `missed: skip`). Queda por ver (no bloquea) si el canje largo y el refresco aceptan la cabecera `Bearer` en vez del token en la URL (el resto de las llamadas ya la usa).
5. **2026-10-06:** `GET /me` responde en `graph.instagram.com` con Instagram Login. `content_publishing_limit` también, por inferencia: el publisher no dejó la nota que deja cuando no responde. El valor de `quota_total` no se registró: 50 o 100 sigue sin verificar.
6. Versión de API: `v25.0` funciona (2026-10-06); `v26.0` y la omisión no se probaron.
7. Cabeceras `X-App-Usage` y `X-Business-Use-Case-Usage` en las respuestas: no observadas (no se registran). **2026-10-15:** la doc no dice si `graph.instagram.com` las devuelve (sección 6.1); la medición es una llamada de lectura a `content_publishing_limit` que imprima los nombres y valores de esas cabeceras, lo corre el operador (por ejemplo ampliando `pnpm ig:smoke`).
8. **Imagen con URL prefirmada: verificado el 2026-10-06** (`pnpm ig:smoke`, cuenta @vicentewoldec conectada con el token de Generate token, `v25.0`): el contenedor de imagen con la URL firmada de R2 quedó `FINISHED` al instante, sin publicar. Con eso también quedó probado que el token de Generate token sirve para `/me` (al conectar) y para crear contenedores. **Publicación en vivo de muestra, verificada el 2026-10-06** (P002, con la instrucción del operador): carrusel de 5 imágenes y reel de `REEL_SPEC`, ambos con URLs prefirmadas de R2, publicados al primer intento. Meta acepta la query larga de R2 también para el video; si hace `HEAD`, no lo rechaza. Falta que el operador confirme que la portada del reel fue el cuadro del segundo 1. Lo que sigue es el plan original: carrusel de 3 a 4 imágenes con URL prefirmada de R2 (¿acepta la query larga? ¿hace `HEAD`?), luego el reel (¿acepta el MP4 de `REEL_SPEC`?, tiempo hasta `FINISHED`, `cover_url`/`thumb_offset`, `share_to_feed` por defecto).
9. **2026-10-06:** se guardaron los `permalink` del carrusel (`/p/…`) y del reel (`/reel/…`, así que el formato del enlace del reel queda verificado). No hubo retoma: un segundo `media_publish` y `media_product_type` en `/media` no se ejercitaron. Plan original: `permalink` del carrusel y del reel; tiempo hasta que el enlace funciona. Ver qué devuelve un segundo `media_publish` sobre un contenedor ya publicado (el publisher lo evita, pero un corte justo durante el pedido deja una ventana: spec F3 §4.4) y si `/<IG_ID>/media` trae `media_type` y `media_product_type` con Instagram Login.
10. `DELETE` no se intentó (spec F3, D8); el borrado manual desde la app funcionó (2026-10-06).
11. Cuántos contenedores y publicaciones suma `content_publishing_limit` tras la prueba (¿un reel cuenta 1?): no se midió.

## 9. Riesgos y términos de uso relevantes

- Meta puede cambiar los límites sin aviso (esta misma doc se contradice: 100 contra 50 publicaciones): las constantes (10 slides, 4:5, 8 MB, 300 MB, 2.200 caracteres) deben vivir en un solo archivo de configuración de la plataforma, no repartidas por las plantillas. El tope de publicaciones se lee con `content_publishing_limit` en vez de fijarlo.
- Un carrusel con una primera imagen fuera del rango 4:5 a 1,91:1 recorta todas: la plantilla debe renderizar siempre en 4:5.
- **Spam y restricciones (2207050, 2207051):** publicar demasiado rápido o contenido repetitivo puede restringir la cuenta. Mantener un ritmo bajo y variar el texto.
- **Tokens:** una cuenta cuyo token venció sin refrescar (más de 60 días) se reconecta de cero; avisar con tiempo.
- **Contenido con IA:** Meta ofrece `is_ai_generated` para autodeclarar. Es opcional según la doc; el criterio de cuándo usarlo es del operador.
- **Cuentas de terceros (F7):** acceso avanzado, App Review y verificación del negocio. Los términos de la plataforma de Meta (Platform Terms) y la política de datos se leerán entonces; no se revisaron en esta nota.
- **Secretos:** el `client_secret` solo en servidor; el canje de código y de token largo nunca desde el navegador (DOC: "must be made in server-side code").

## 10. Fuentes (consultadas el 2026-10-02 y el 2026-10-04)

Oficiales de Meta:

- IG User Media (especificaciones de imagen, reel, portada, carrusel, parámetros, 400 contenedores, 24 h): https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/ (2026-10-02 y 2026-10-04)
- Content Publishing: https://developers.facebook.com/docs/instagram-platform/content-publishing (2026-10-02 y 2026-10-04)
- Content Publishing con Instagram Login (flujos, estados, sondeo, subida reanudable, `is_ai_generated`): https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing (2026-10-02 y 2026-10-04)
- `content_publishing_limit`: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit (2026-10-04)
- Contenedor (`status_code`, `status`): https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-container (2026-10-04)
- IG Media (permalink, `DELETE`): https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media y https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/ (2026-10-04)
- IG User (campos `id`, `username`): https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user (2026-10-04)
- Códigos de error de Instagram: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes (2026-10-04)
- Business Login for Instagram (OAuth, tokens, refresco): https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login y https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login (2026-10-04)
- Referencia de `oauth/authorize`: https://developers.facebook.com/docs/instagram-platform/reference/oauth-authorize/ (2026-10-04)
- Primeros pasos (Generate token, `/me`, tipo de app): https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started (2026-10-04)
- Resumen de la plataforma y de Instagram Login (niveles de acceso, App Review, límites de llamadas): https://developers.facebook.com/docs/instagram-platform/overview y https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login (2026-10-04)
- Changelog de Instagram (DELETE 2025-12-03, `enable_fb_login` 2026-02-06, `is_ai_generated` 2026-06-22): https://developers.facebook.com/docs/instagram-platform/changelog (2026-10-04)
- Changelog de Graph API (v26.0, 2026-07-29): https://developers.facebook.com/docs/graph-api/changelog (2026-10-04)
- Límites de llamadas de Graph API: https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ (2026-10-04 y 2026-10-15: códigos 4, 17, 80002, 613, cabeceras, `estimated_time_to_regain_access` en minutos)
- `content_publishing_limit`, versión `.md` (host `graph.instagram.com` con Instagram Login, respuesta en `data`, `rate_limit_settings` sin documentar): https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit.md (2026-10-15)
- Códigos de error de Instagram, versión `.md` (4/2207051, 9/2207042): https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/error-codes.md (2026-10-15)
- Visión general de la plataforma, sección de límites (BUC, 4800 × impresiones; sin cabeceras ni 80002): https://developers.facebook.com/docs/instagram-platform/overview (2026-10-15)
- Manejo de errores de la Graph API (4 y 17: "espera y vuelve a intentar"): https://developers.facebook.com/docs/graph-api/guides/error-handling/ (2026-10-15)
- Publicación con Instagram Login (100 y 50 posts, 400 contenedores, sin cabeceras): https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing (2026-10-15)
- Manejo de errores de Graph API: https://developers.facebook.com/docs/graph-api/guides/error-handling/ (2026-10-04)
- Seguridad de Facebook Login ("Enforce HTTPS", modo estricto): https://developers.facebook.com/docs/facebook-login/security (2026-10-04)
- Cloudflare R2, URLs prefirmadas (método atado a la URL, solo dominio S3, 7 días): https://developers.cloudflare.com/r2/api/s3/presigned-urls/ (2026-10-04)

Pistas no oficiales (nunca como fuente final):

- Resúmenes de terceros que coinciden con las cifras de Meta: https://adaptlypost.com/blog/instagram-reels-api-max-length-file-size (2026-10-02)
- Discusión de `invalid redirect_uri` con HTTPS en localhost: https://github.com/nextauthjs/next-auth/discussions/7061 (2026-10-04)
- Guía de implementación con `http://localhost` en desarrollo: https://gist.github.com/PrenSJ2/0213e60e834e66b7e09f7f93999163fc (2026-10-04)
- Causas de 2207052 y 2207003 (redirecciones, `Content-Type`): https://bundle.social/instagram-api/errors (2026-10-04)
- Rol "Instagram Tester" e invitaciones: https://developers.facebook.com/community/threads/2645731442173067/ (2026-10-04)

## 11. Implicaciones para el spec de F3

**Autenticación y cuenta**

1. **Redirect en local.** Probar primero la URI `http://localhost:8787/oauth/instagram/callback` en el panel (1 minuto). Plan: (a) si el panel la acepta y la pantalla de autorización funciona, usarla; (b) si no, **conexión por token del panel** (Generate token, documentado) para la demo, con el OAuth completo implementado y probado con msw pero activado en F7; (c) en paralelo, soportar `https://localhost` con mkcert o la copia manual del `code` (sin `#_`) como comando de CLI. No introducir un túnel como dependencia del MVP.
2. **Variables.** Renombrar `META_APP_ID`/`META_APP_SECRET` a `INSTAGRAM_APP_ID`/`INSTAGRAM_APP_SECRET` (o documentar bien que son los de Instagram), y que el comando `doctor` avise si faltan. Primera tarea de F3: que el operador siga la sección 2.1.
3. **Alcance de scopes:** pedir solo `instagram_business_basic,instagram_business_content_publish`. Usar `enable_fb_login=false` si la pantalla confunde al operador (parámetro nuevo, probarlo).
4. **Parsers tolerantes:** aceptar la respuesta con o sin la envoltura `data: [ ]` en el canje y en `/me`.
5. **Cuenta conectada:** tras el canje largo, llamar a `/me?fields=user_id,username,account_type` y guardar `user_id` (el de `/me`), `username`, `account_type`, los permisos concedidos y `expires_at = ahora + expires_in`. Si falta `instagram_business_content_publish` en `permissions`, rechazar la conexión con un mensaje claro.
6. **Refresco:** job diario que refresca los tokens con **más de 24 h y menos de 30 días de vigencia restante** (por ejemplo, a los 30 días de uso); nunca antes de las 24 h, nunca después de vencido. Un 190 en el refresco marca la cuenta `needs_reconnect` y avisa al operador con 10 días de anticipación del vencimiento. Estado visible en el panel.

**Publicación**

7. **Flujo en pg-boss, sin dormir dentro del job:** (1) crear contenedores hijos; (2) sondear cada hijo (`FINISHED`); (3) contenedor del carrusel; (4) `media_publish`; (5) leer `permalink`. Guardar los IDs de contenedor en la publicación **antes** de `media_publish`, y no reintentar `media_publish` sin consultar el estado (sección 7).
8. **Ritmo de sondeo:** Meta recomienda 1 vez por minuto durante máximo 5 minutos. Propuesta: primera consulta a los 5 s, luego 10 s, 20 s, 30 s y después cada 60 s hasta el tope de 5 min; si se supera, la publicación pasa a `failed` con causa "Instagram no terminó de procesar el medio" y se permite reintentar con contenedor nuevo. Las imágenes casi siempre quedan `FINISHED` de inmediato. Ritmo configurable en `config`.
9. **URLs prefirmadas:** generarlas **justo antes de crear cada contenedor** (nunca guardarlas ni pre-generarlas al programar) y con vencimiento de **1 hora** (`3600` s, configurable), que cubre los 5 min de sondeo y un reintento. En un reintento se generan URLs nuevas. Con `Content-Type` correcto en el objeto. Plan B si la demo muestra 2207052 o 403 por `HEAD`: prefijo público con dominio propio, claves no adivinables y regla de ciclo de vida de 24 h; para el reel, la subida reanudable.
10. **Validar antes de llamar:** caption (2.200 caracteres, 30 hashtags, 20 menciones), carrusel de 2 a 10 ítems, JPEG 4:5 de menos de 8 MB, reel dentro de los límites de la API y del tope de producto (3 s a 15 min de Meta; 5 a 90 s es política nuestra y se decide en el spec).
11. **Cuota:** antes de publicar, consultar `content_publishing_limit` (si responde en `graph.instagram.com`); si no, un contador local. Leer `quota_total` del `config`; no fijar 100 ni 50. Presupuestar contenedores: carrusel de N imágenes = N + 1 de 400 por día. Con el ritmo de un corredor independiente, no es un tema práctico.
12. **Versión de API** fija en una constante (`v25.0` hoy), con la prueba de la sección 8, y un solo archivo de constantes de plataforma.
13. **`is_ai_generated`:** decidir si el publisher lo envía (ver preguntas abajo). Si se usa, solo en el contenedor padre del carrusel.
14. **Cerrar/despublicar:** no hay `DELETE` con Instagram Login. `Publisher.close` en Instagram marca la publicación como cerrada en el sistema y deja un aviso "borra la publicación a mano en Instagram", con el enlace guardado. Para la demo, el operador borra la muestra desde la app. No codificar `DELETE` en F3.
15. **Editar un texto ya publicado:** no se documenta en la API; el sistema no lo ofrece. Un cambio es una publicación nueva.

**Errores y reintentos**

16. **No reintentar (acción humana o contenido):** 190, 10, 200 a 299, 102, 2207004, 2207005, 2207009, 2207010, 2207023, 2207026, 2207028, 2207035 a 2207037, 2207040, 2207050, 2207051, 2207057. Pasan a `failed` con una causa legible (ya existe la regla del proyecto de `failed` con causa legible en F6).
17. **Reintentar con backoff exponencial (máximo 2 o 3) y contenedor nuevo:** HTTP 5xx, códigos 1 y 2, 2207001, 2207003, 2207032, 2207052, 2207053, 2207020, 2207006.
18. **Esperar, no recrear:** 2207008 (30 s a 2 min), 2207027 (seguir sondeando).
19. **Reprogramar sin consumir reintentos:** 4 (si no es 2207051), 17, 80002, 613, 9 y 2207042; respetar `estimated_time_to_regain_access` si llega; si no, 1 hora.
20. **Registrar** (sin tokens) las cabeceras `X-App-Usage` y `X-Business-Use-Case-Usage` cuando existan, para aprender los valores reales.

**Demo (criterio de aceptación de F3)**

21. Orden: prueba de la URI y del par de ID (sin publicar) → conectar la cuenta → `dry-run` de la propiedad de muestra → pedir autorización del operador en el chat → `live` con el carrusel → `live` con el reel → guardar `permalink` → borrar a mano → anotar en esta nota los resultados de la lista de la sección 8 y cambiar los NO VERIFICADO.
22. **Qué decidir antes de empezar el spec** (preguntas al operador, en el resumen de la respuesta): tope del reel (3 s a 15 min de Meta o 5 a 90 s de producto), uso de `is_ai_generated`, cómo conectar en local (token del panel o HTTPS local), si se acepta probar `DELETE` en la demo, y renombrar las variables `META_*`.

## 12. Ampliación 2026-10-16 (planificación de F7): cuentas de otros corredores en modo desarrollo

Ronda hecha el 2026-10-16 con la misma herramienta que extrae y resume el texto (páginas oficiales de Meta, incluidas sus versiones `.md`); no se hizo ninguna llamada a la API. Lo que ya estaba en las secciones 2, 3.6 y 11 no se repite: aquí solo lo nuevo o lo que corrige un NO VERIFICADO.

### 12.1 ¿Puede la app, en modo desarrollo, publicar en la cuenta de otra persona con rol en la app?

- **DOC (modos de la app):** en modo desarrollo "solo los usuarios con rol pueden usar la app"; sus permisos y funciones funcionan para ellos con acceso estándar o avanzado. En modo live, solo funcionan los permisos aprobados en App Review. Los datos creados en desarrollo solo los ven los usuarios con rol.
- **DOC (resumen de la plataforma de Instagram):** el acceso estándar es el de por defecto y está "pensado para apps que solo usarán personas con roles en ellas, durante el desarrollo o las pruebas". Basta si la app sirve a "tu propia cuenta profesional o una que administras". El acceso avanzado se exige si la app sirve cuentas profesionales que no son tuyas ni administras, o si la usan personas sin rol (ni en el portafolio de negocios dueño de la app).
- **DOC (guía de Business Login):** con acceso estándar las cuentas deben estar "agregadas a tu app en el App Dashboard".
- **Conclusión:** sí, según la doc, una cuenta profesional ajena **con rol en la app** queda cubierta por el acceso estándar y los dos permisos (`instagram_business_basic`, `instagram_business_content_publish`) funcionan para ella sin App Review. La doc no tiene una frase que diga "publicar en la cuenta de un tester funciona"; es la lectura de las tres páginas anteriores (INFERENCIA fuerte, la misma situación de la cuenta @vicentewoldec, que tiene rol). La página de resumen advierte además que "algunas funciones pueden no funcionar bien" con acceso estándar. **Publicar en una cuenta de un tercero con rol: NO VERIFICADO.** Prueba: con un corredor de confianza (o una segunda cuenta profesional del propio operador sin rol de administrador), agregarlo como Instagram Tester, conectarlo y correr `pnpm ig:smoke` (solo crea un contenedor, no publica) antes de cualquier `live`.
- **Cuenta y token siguen siendo por corredor:** el modelo ya guarda `platform_accounts` por corredor; no hace falta cambiar el diseño, solo el modo de conseguir el token (12.2).

### 12.2 Cómo se agrega un Instagram Tester y cómo acepta

- **DOC (roles de la app):** las invitaciones se envían desde **Roles** del App Dashboard (si la app está en un portafolio de negocios, desde Business Manager). Las de Administrador, Developer y Analytics van a desarrolladores registrados; las de **Tester** pueden ir también a usuarios comunes. Un Tester puede dar cualquier permiso a la app mientras está en desarrollo y usar todas sus funciones; no puede editar la configuración ni dar acceso a otros. Meta recomienda agregar solo empleados o personas con un acuerdo para actuar en tu nombre, y quitar a los que ya no prueban.
- **La doc oficial no describe el rol "Instagram Tester".** Ni la página de roles, ni la de modos, ni las de Instagram Login (get-started, business-login, instagram-use-case, overview) lo mencionan; la de roles describe la aceptación solo para el consumidor de Facebook (Configuración > Apps y sitios web > Solicitudes). El índice de la documentación tampoco tiene una página con ese nombre. Lo que sigue viene de guías de terceros y de la nota de la sección 2 (hilo de la comunidad), **no es doc oficial**:
  1. App Dashboard > **App roles > Roles > Add People**, elegir **Instagram Tester** (bajo "Additional roles for this app"), escribir el **nombre de usuario de Instagram** y pulsar Add. Queda "Pending".
  2. La persona acepta en Instagram (web o app): foto de perfil > **Editar perfil > Apps y sitios web > Tester Invites** (las guías ponen nombres levemente distintos) > **Accept**. Si no aparece, esperar unos minutos y refrescar. El estado en Roles pasa a "Active".
  3. Un tester de Facebook no sirve: debe ser una cuenta de Instagram profesional.
- **NO VERIFICADO:** que el menú de 2026 sea ese; confirmar con el corredor de prueba.
- **Cuántos testers:** **DOC genérico** (roles): hasta **50 testers** en la mayoría de las apps no vinculadas a un Business Manager; hasta **500 entre analytics y testers** si la app está vinculada a un Business Manager con verificación. 500 administradores. **Que el límite de 50 aplique al rol "Instagram Tester": NO VERIFICADO** (la doc no distingue). Para F7 (un puñado de corredores) no es una restricción práctica.

### 12.3 ¿Sirve "Generate token" para la cuenta de un tester?

- **DOC (get-started e instagram-use-case):** en `Instagram > API setup with Instagram login`, sección **Generate access tokens**, se pulsa **Generate token** (o **Add account**), se **inicia sesión en Instagram en una ventana emergente** y se copia el token (largo, 60 días). La doc no dice si la cuenta debe ser del dueño de la app ni si sirve para un tester.
- **INFERENCIA:** como el token se genera iniciando sesión en esa cuenta de Instagram, **el operador no puede generarlo "por" el corredor** sin las credenciales del corredor (inaceptable) o sin que el corredor inicie sesión él mismo en esa ventana, delante del operador. En ese caso el token queda visible para el operador (da poder de publicar en la cuenta): es un tema de confianza y de términos, no técnico. Que el botón lista a las cuentas con rol de Instagram Tester (y no solo la del dueño): **NO VERIFICADO**; se ve en el panel al agregar al tester.
- **OAuth para testers:** por la doc de modos, un usuario con rol puede autorizar la app en modo desarrollo (INFERENCIA), con la limitación ya conocida: la URI de retorno debe ser HTTPS (el panel rechaza `http://localhost`, sección 3.6). Eso deja el OAuth completo para F8.
- **Puente para F7 local (decisión del operador):** (a) sesión presencial: el corredor inicia sesión en la ventana de Generate token en el computador del operador y este pega el token con el comando existente (`accounts connect instagram --token-stdin`); (b) la copia manual del `code` (alternativa 3 de la sección 3.6), **NO VERIFICADO** que el panel acepte una URI HTTPS que no responde; (c) esperar a F8. El token dura 60 días y el job de refresco ya lo renueva.

### 12.4 Qué exige App Review / acceso avanzado (resumen para F8)

- **DOC (App Review de Instagram):** necesario para dar acceso avanzado a usuarios sin rol. No hace falta si la app solo sirve a un negocio propio o administrado con acceso estándar. Si la app atiende a varios negocios (proveedor de tecnología), se exige App Review con acceso avanzado tanto en Instagram Login como en Facebook Login. Una app usa **uno u otro** login, no ambos.
- **Qué se pide al enviar:** (1) que la app se pueda cargar y probar desde fuera; (2) botón de login visible, con las pautas de marca, tanto en la app como en el video; (3) descripción paso a paso del caso de uso; (4) **al menos una llamada exitosa a la API por cada permiso** que pide acceso avanzado; (5) ajustes de la app: **ícono de 1024x1024, URL de política de privacidad, categoría y correo de contacto del negocio**; (6) instrucciones para el revisor (web es hoy la única plataforma con Instagram Login) con credenciales de prueba si hacen falta; (7) por permiso: descripción de uso, **video (screencast) de la experiencia completa**, aceptación de los términos de uso permitido y los permisos de los que depende. Se envía desde `Instagram > API setup with Instagram login > Complete app review`, o `App Review > Requests`.
- **Verificación del negocio (DOC):** obligatoria para el acceso avanzado; sin ella "los usuarios de otros negocios no podrán dar permisos" a la app. Un administrador de la app la conecta a un negocio (Settings > Basic > Verification) y solo un administrador del negocio la completa en Business Manager. **La página no lista los documentos, ni el plazo, ni si un independiente sin empresa puede verificarse** (menciona una "Individual Verification" sin explicarla): **NO VERIFICADO**. Tarea del operador antes de F8: abrir la ayuda "About Business Verification" de Business Manager y ver qué pide a una persona natural en Chile.
- **Plazo de revisión:** sigue sin figurar en la doc (NO VERIFICADO, sección 2).
- **Nombre del permiso:** la página de App Review se resumió con el nombre `instagram_business_content_publishing` (con "ing"), mientras el resto de la doc y el panel usan `instagram_business_content_publish`. Probablemente es un error de resumen; abrir la página y confirmar antes de redactar la solicitud (NO VERIFICADO).
- **Efecto en el diseño:** mientras F7 y F8 vivan con el acceso estándar, cada corredor nuevo cuesta un paso manual del operador (invitarlo como tester y que acepte) y la app **no** puede estar abierta al público. Pasar a que cualquiera conecte su cuenta exige verificación del negocio, política de privacidad publicada, video por permiso y HTTPS: es el trabajo de F8.

### 12.5 Fuentes de esta ronda (consultadas el 2026-10-16)

- Roles de la app (invitaciones, límites de 50 y 500, aceptación del consumidor): https://developers.facebook.com/docs/development/build-and-test/app-roles/ y https://developers.facebook.com/documentation/development/build-and-test/app-roles.md
- Modos de la app (desarrollo y live, acceso estándar y avanzado): https://developers.facebook.com/documentation/development/build-and-test/app-modes.md
- Resumen de la plataforma de Instagram (acceso estándar y avanzado): https://developers.facebook.com/docs/instagram-platform/overview
- App Review de Instagram (requisitos del envío): https://developers.facebook.com/documentation/instagram-platform/app-review.md
- Verificación del negocio: https://developers.facebook.com/docs/development/release/business-verification
- Business Login (cuentas agregadas a la app con acceso estándar): https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login.md
- Primeros pasos (Generate token, inicio de sesión en la ventana): https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started
- Caso de uso de Instagram (Add account, App Review): https://developers.facebook.com/documentation/development/create-an-app/instagram-use-case.md
- Pista no oficial (rol "Instagram Tester", Tester Invites; resultados de búsqueda que citan guías de terceros): sin una página única que citar; ver también el hilo de la sección 10.
