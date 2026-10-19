# Discord (webhooks de canal y bot propio)

Nota verificada el 2026-10-19 para planificar F9 (AgentSales como gestor de contenido de redes sociales: primero el servidor de Discord de la marca AgentPey y del operador; más adelante, servidores de terceros). Solo se leyó documentación pública; no se hizo ninguna llamada a la API ni se usó ninguna cuenta.

Convención: **DOC** = documentación oficial de Discord; **INFERENCIA** = deducido; **NO VERIFICADO** = falta prueba real o una lectura oficial. Todo lo marcado NO VERIFICADO se prueba en un servidor de pruebas del operador (sección 8).

Aviso de método:

- La doc de desarrolladores se movió: `discord.com/developers/docs/...` responde 301 a **`docs.discord.com/developers/...`**. Las páginas de referencia se leyeron con una herramienta que extrae y resume el texto, no en el navegador. Las cifras coinciden entre varias páginas, pero las citas literales cortas pueden tener paráfrasis. Antes de codificar algo crítico (tabla de errores, límites) conviene abrir la página y confirmar.
- Los artículos de soporte (`support.discord.com`, `support-dev.discord.com`) respondieron 403 a la lectura directa. La Política de Desarrolladores se leyó una vez a través de un lector público de páginas (no oficial) y su texto puede no ser la versión vigente (sección 9). Los términos de desarrollador y el artículo de verificación de apps **no se pudieron leer**; sus datos salen de resúmenes de búsqueda y quedan marcados.

## 1. Resumen

- **Mecanismos comparados:** (A) **webhook de canal** (`POST /webhooks/{id}/{token}`) y (B) **bot propio** (`POST /channels/{id}/messages` con `Authorization: Bot <token>`), más (B+) el "Crosspost" para canales de anuncios, que solo existe con bot.
- **Madurez:** alta en ambos (API estable, v10). Riesgo bajo para canales propios. No hay App Review ni cuota de publicación como en Meta.
- **A (webhook):** lo crea quien tenga el permiso `MANAGE_WEBHOOKS` en el canal (el dueño del servidor, sin pasar por el Developer Portal ni por ninguna revisión de Discord). Entrega una URL con el token incluido, que **es el secreto**. Sirve para publicar, editar y borrar **solo sus propios mensajes**, y para crear posts en foros (`thread_name`, `applied_tags`). No puede leer el canal, ni crear hilos en canales de texto, ni hacer Crosspost (INFERENCIA: esos endpoints piden autorización de bot).
- **B (bot):** se crea una app en el Developer Portal (cualquier cuenta de Discord), se copia el token del bot y se instala en el servidor con un enlace OAuth2 (`scope=bot` más los permisos). Da más control (leer historial para detectar duplicados, `nonce`, hilos desde un mensaje, Crosspost, listar etiquetas del foro), pero hay que guardar el token del bot, que da acceso a **todos** los servidores donde está instalado.
- **Límites de contenido (DOC):** `content` 2.000 caracteres; hasta 10 embeds por mensaje; 6.000 caracteres entre todos los textos de los embeds; archivos de hasta **20 MiB por archivo** (el límite por defecto subió de 10 a 20 MiB el 2026-09-03); solicitud completa de hasta 25 MiB.
- **Menciones:** enviar **siempre** `allowed_mentions` explícito (`{"parse": []}` por defecto). Para webhooks el valor por defecto de la doc solo procesa menciones de usuarios, pero no se debe depender de eso.
- **Idempotencia:** Execute Webhook **no tiene** `nonce` documentado; Create Message sí (`nonce` + `enforce_nonce`, ventana de "unos minutos"). Con webhook, un fallo de red después de enviar no se puede reconciliar: ver sección 7.2.
- **Terceros:** tres vías. (1) El cliente crea su webhook y pega la URL (sin app). (2) El cliente pulsa un enlace OAuth2 con `webhook.incoming`, elige el canal y nuestra app recibe el webhook sola. (3) El cliente instala nuestro bot. Un bot que solo usa REST no necesita intents privilegiados (INFERENCIA); la verificación de la app y el umbral exacto son NO VERIFICADO (sección 2.3).
- **Recomendación corta:** empezar con **webhook de canal** (A) para el servidor propio; dejar el bot (B) para cuando haga falta Crosspost, lectura de historial o instalación por terceros. Detalle en la sección 11.

## 2. Requisitos de cuenta y app

### 2.1 Comparación

| Aspecto | (A) Webhook de canal | (B) Bot propio |
|---|---|---|
| Quién lo crea | Quien tenga `MANAGE_WEBHOOKS` en ese canal (DOC). El dueño del servidor, en Ajustes del servidor > Integraciones > Webhooks (ruta según resumen de búsqueda del artículo de soporte; no se pudo leer). O por API: `POST /channels/{id}/webhooks` con `name` | Cualquier cuenta de Discord crea la app en el Developer Portal (guía "Building your first Discord Bot"); luego alguien con permisos en el servidor la instala |
| ¿Pasa por Discord? | No hay revisión ni aprobación. Es una acción del dueño dentro de su servidor | Crear y usar el bot, no. Verificación solo a escala (2.3) |
| Credencial | URL `https://discord.com/api/webhooks/{id}/{token}` | Token del bot (Bot page > Reset Token; "You won't be able to view your token again unless you regenerate it") |
| Alcance de la credencial | **Un canal** (y sus hilos) | **Todos los servidores** donde está el bot, según permisos |
| Permisos | No hay: el webhook postea en su canal. El permiso se exige a quien lo crea | Los del rol del bot: `VIEW_CHANNEL`, `SEND_MESSAGES`; `ATTACH_FILES`, `EMBED_LINKS` si se adjunta o se usan embeds; `SEND_MESSAGES_IN_THREADS` para hilos existentes; `MANAGE_MESSAGES` para publicar (Crosspost) mensajes ajenos |
| Autenticación en cada llamada | Ninguna cabecera: el token va en la URL | `Authorization: Bot <token>` y `User-Agent: DiscordBot ($url, $version)` |
| Costo | Ninguno documentado | Ninguno documentado |
| Gateway (WebSocket) | No | **No hace falta** para enviar por REST (la doc: las operaciones REST se hacen con la API HTTP; el ejemplo de inicio no usa el Gateway) |

Notas de la comparación:

- **Permiso para crear un webhook (DOC):** `MANAGE_WEBHOOKS` (`1 << 29`, "Lets members manage and edit webhooks"). `ADMINISTRATOR` lo incluye y salta las sobrescrituras de canal (DOC, página de permisos). Que el dueño del servidor tenga todos los permisos: INFERENCIA (no se leyó la frase en esa página).
- **Nombre del webhook (DOC):** 1 a 80 caracteres; no puede contener "clyde" ni "discord" (sin distinguir mayúsculas). Si la misma regla vale para el `username` de cada envío: NO VERIFICADO.
- **Límite de webhooks (DOC, tabla de códigos de error):** error `30007` "Maximum number of webhooks reached (15)" (por canal, INFERENCIA por el texto "(15)") y `30058` "per guild reached (1000)". Un artículo de Discord Moderator Academy dice "10 webhooks per server": contradice lo anterior; se toma la tabla de errores. Poco relevante para nosotros (uno por canal destino).
- **Instalar un bot:** `https://discord.com/oauth2/authorize?client_id=<ID>&scope=bot&permissions=<ENTERO>` (DOC). Si la app es pública, "anyone with your bot's URL can add it to guilds in which they have proper permissions"; si no es pública, solo la agrega su dueño (`bot_public` = false, DOC). Que ese permiso sea "Gestionar servidor": NO VERIFICADO en lo leído (la doc dice "proper permissions").
- **Qué guardar si se instala un bot (decisión de diseño):** el ID del canal destino y el ID del servidor, no solo el token.

### 2.2 Tercera vía para terceros: `webhook.incoming` (DOC, OAuth2)

El scope `webhook.incoming` "generates a webhook that is returned in the oauth token response for authorization code grants". El usuario "will be prompted to select a channel in which to allow the webhook"; la respuesta trae el objeto `webhook` y la doc dice que hay que guardar `webhook.token` y `webhook.id`. Cada flujo crea un webhook nuevo. Requiere una app propia (client id y secret) y un redirect URI, pero **no instala bot en el servidor del cliente** y el cliente no copia ninguna URL a mano. Si el webhook creado así es "de la app" (con `application_id`) y puede usar `components` interactivos: NO VERIFICADO. Qué permiso se exige al usuario que autoriza: NO VERIFICADO.

### 2.3 Verificación de la app, intents y escala (solo importa para el bot de terceros)

- **Intents privilegiados** (`GUILD_PRESENCES`, `GUILD_MEMBERS`, `MESSAGE_CONTENT`): se activan en el Developer Portal. Solo se necesitan para **recibir** eventos por el Gateway; un bot que solo manda mensajes por REST no los pide (INFERENCIA; la doc dice que REST es lo preferible y que los intents se declaran al conectar al Gateway). Con `MESSAGE_CONTENT` apagado, el contenido de mensajes llega vacío, salvo excepciones (DOC).
- **Cambio vigente (changelog, 2026-06-10):** la revisión de intents privilegiados pasa a basarse en **usuarios únicos que pueden ver la app** (umbral: **10.000**), ya no en servidores; la **Verificación de apps** quedó **separada** de esa revisión; las apps con acceso deben reaplicar una vez al año; las apps pueden seguir sumando servidores mientras la solicitud está en revisión. Con menos de 10.000 usuarios se activan sin pedir permiso.
- **Contradicción en la doc:** la página del Gateway sigue diciendo que las apps verificadas ("required for apps in 100+ guilds") deben ser aprobadas para el intent. Se toma el changelog como más reciente. El umbral actual de **verificación** (¿100 servidores?) y qué pasa al llegar ahí (¿no puede entrar a más servidores?): **NO VERIFICADO**, porque el artículo "How Do I Get My App Verified?" respondió 403. Se confirma en el Developer Portal (lista de verificación de la app) antes de ofrecer el bot a terceros.
- **Costo y plazo de verificación:** no figuran en lo leído. NO VERIFICADO.

## 3. Autenticación

**(A) Webhook:** no hay OAuth ni cabecera. El `id` y el `token` van en la ruta. Los endpoints "with Token" (Get, Modify, Delete) se describen como **sin autenticación** (DOC): quien tenga la URL puede, además de publicar, **leer los datos del webhook y borrarlo**. Esto es más grave que lo que dice un artículo de Moderator Academy ("only non-permanent problems may occur (e.g. spamming)"): borrar el webhook obliga a crear otro.

**(B) Bot:**

- Cabecera `Authorization: Bot <token>` (DOC). El token no vence solo; se invalida con "Reset Token". La doc de Términos de desarrollador, según un resumen de búsqueda (no leída directamente), permite a Discord suspender tokens **sin uso en 30 días**: NO VERIFICADO.
- `User-Agent: DiscordBot ($url, $versionNumber)` es obligatorio; sin un User-Agent válido, Cloudflare puede bloquear la solicitud (DOC). Se puede agregar información al final.
- **Versión de la API:** la tabla de la doc marca **v6 (deprecada) como la versión por defecto** si se omite el número, y v10 y v9 como "Available". Usar siempre `https://discord.com/api/v10/...` explícito (también en la URL del webhook: `/api/v10/webhooks/{id}/{token}`; que se acepte con webhooks: INFERENCIA, se prueba en 8).
- **Instalación por OAuth2:** `scope=bot` más `permissions`. Con solo `client_id` se usan los ajustes de instalación por defecto del Developer Portal. Añadir scopes más allá de `bot` y `applications.commands` convierte la instalación en el flujo completo de código de autorización (`response_type` obligatorio). Instalación por servidor = `integration_type=0` (GUILD_INSTALL). Instalación por usuario (`1`) no aplica.
- **Secretos a guardar:** token del bot (global, uno por app), y por cuenta conectada el ID del servidor y del canal. Nunca en logs ni en el chat; en el panel se muestra solo "conectado" y el nombre del canal.

## 4. Operaciones

Base: `https://discord.com/api/v10`. Todas las rutas con `{token}` van sin cabecera de autorización.

### 4.1 Publicar

| | (A) Webhook | (B) Bot |
|---|---|---|
| Endpoint | `POST /webhooks/{id}/{token}` | `POST /channels/{channel_id}/messages` |
| Obligatorio | Al menos uno de `content`, `embeds`, `components`, `file`, `poll` | Al menos uno de `content`, `embeds`, `sticker_ids`, `components`, `files[n]`, `poll`, `shared_client_theme` (salvo reenvío) |
| Query | `wait` (default `false`), `thread_id`, `with_components` | (sin query relevante) |
| Cuerpo | JSON, o `multipart/form-data` con `payload_json` y `files[n]` | Igual, más `nonce`, `enforce_nonce`, `message_reference`, `sticker_ids` |
| Identidad | `username` y `avatar_url` sobrescriben el nombre y el avatar del webhook | Siempre el bot |
| Respuesta | Con `wait=true`, el mensaje; sin ella, no confirma que se guardó | El mensaje (200) |

- **Siempre `wait=true` con webhooks (DOC + diseño):** con `false`, "an unsaved message does not return an error", y no devuelve el `id` del mensaje, que se necesita para editar y borrar. Se guardan `message.id` y `message.channel_id` (el de un post de foro: ver 4.3).
- **Link del mensaje:** `https://discord.com/channels/{guild_id}/{channel_id}/{message_id}`. El `guild_id` sale de "Get Webhook with Token" o de la respuesta del mensaje (si la trae: NO VERIFICADO). Es INFERENCIA del formato de enlace; no se leyó en la doc consultada.
- **`flags` permitidos al ejecutar un webhook (DOC):** solo `SUPPRESS_EMBEDS` (`1<<2`), `SUPPRESS_NOTIFICATIONS` (`1<<12`) e `IS_COMPONENTS_V2`. Con `IS_COMPONENTS_V2` el mensaje solo puede llevar `components` (usar `content` o `embeds` da 400). No se usa en F9 inicial.
- **Componentes:** los webhooks no propios solo pueden usar componentes no interactivos (y solo con `with_components=true`). No se usan.

### 4.2 Verificar la conexión sin publicar

- **(A)** `GET /webhooks/{id}/{token}` (DOC: "Get Webhook with Token", sin autenticación). Devuelve el webhook (`channel_id`, `guild_id`, `name`; campos exactos: NO VERIFICADO). Sirve para el botón "Probar conexión" y para detectar un webhook borrado (404, error `10015`). No publica nada.
- **(B)** `GET /users/@me` con el token del bot (INFERENCIA, no leído en esta ronda) y `GET /channels/{id}` para comprobar que ve el canal.

### 4.3 Hilos

**Post en un canal de foro o de medios (DOC):**

- **(A) Webhook:** `thread_name` en el cuerpo crea un post nuevo (la doc: "Requires a forum or media channel") y `applied_tags` (arreglo de IDs de etiqueta) también exige foro o medios. En un canal de foro o de medios **hay que enviar `thread_id` (query) o `thread_name` (cuerpo)**: sin ninguno, error `220001`; con ambos, `220002`. El primer mensaje del post es el contenido que se manda.
- **(B) Bot:** `POST /channels/{forum_id}/threads` con `name` (1 a 100 caracteres), `message` (el primer mensaje: `content`, `embeds`, `files[n]`...), `applied_tags`, `auto_archive_duration` (60, 1440, 4320 o 10080 minutos) y `rate_limit_per_user`. Permiso exigido: `SEND_MESSAGES` ("`CREATE_PUBLIC_THREADS` is ignored"). El hilo es `PUBLIC_THREAD`.
- **Etiquetas:** `available_tags` hasta 20 por canal; nombre de hasta 20 caracteres; una etiqueta `moderated` solo la pueden poner miembros con `MANAGE_THREADS`; `applied_tags` de un hilo, hasta 5. El indicador `REQUIRE_TAG` (`1<<4`) del canal obliga a poner al menos una al crear: si falta, error `40067` "A tag is required to create a forum post in this channel". **Cómo obtener los IDs de etiqueta:** con bot, `GET /channels/{id}` devuelve `available_tags`. Con solo webhook no hay endpoint documentado que los liste: el operador los copia a mano (desde el cliente con el modo desarrollador; cómo se copia el ID de una etiqueta: NO VERIFICADO) y se guardan en la configuración del canal. Si una etiqueta `moderated` falla con un webhook: NO VERIFICADO.
- **Respuesta de un post nuevo por webhook:** con `wait=true` vuelve un mensaje; que su `channel_id` sea el ID del hilo creado (y por tanto el `thread_id` para editar y borrar): INFERENCIA, NO VERIFICADO. Se prueba en 8.

**Mensaje dentro de un hilo existente (foro o canal):**

- **(A)** `?thread_id=<id>`. "The thread is automatically unarchived" (DOC). Un hilo bloqueado da `160005` "Thread is locked" y uno archivado sin poder reabrirse `50083`; si el webhook puede reabrir un hilo bloqueado: NO VERIFICADO (la doc de canales dice que solo `MANAGE_THREADS` desbloquea).
- **(B)** `POST /channels/{thread_id}/messages`; hace falta `SEND_MESSAGES_IN_THREADS` (`1<<38`): `SEND_MESSAGES` no cubre los mensajes dentro de hilos (DOC, página de permisos).

**Hilo a partir de un mensaje en un canal de texto o de anuncios (solo bot):** `POST /channels/{channel_id}/messages/{message_id}/threads` con `name`. En texto crea `PUBLIC_THREAD`, en anuncios `ANNOUNCEMENT_THREAD`; no funciona en foro ni medios; el ID del hilo es igual al del mensaje y un mensaje solo puede tener un hilo. La doc no lista el permiso (la de permisos dice que `CREATE_PUBLIC_THREADS` "lets members create public and announcement threads"; INFERENCIA que aplica). Un webhook no tiene un endpoint equivalente (INFERENCIA).

**Límites de hilos:** los servidores tienen un máximo de hilos activos y de miembros por hilo (DOC) sin cifra publicada en lo leído. En un foro, `rate_limit_per_user` también limita crear posts por usuario; los bots y quienes tienen `BYPASS_SLOWMODE` están exentos del límite de mensajes (DOC). Si eso cubre a un webhook: NO VERIFICADO.

### 4.4 Editar

- **(A)** `PATCH /webhooks/{id}/{token}/messages/{message_id}` (DOC). Todos los parámetros son opcionales: `content`, `embeds`, `flags`, `allowed_mentions`, `components`, `files[n]`, `payload_json`, `attachments`. `thread_id` en la query si el mensaje está en un hilo. Al editar `content`, las menciones se **reconstruyen** desde el texto nuevo. Solo se puede editar un mensaje **creado por ese webhook**.
- **(B)** `PATCH /channels/{channel_id}/messages/{message_id}`: el autor original edita `content`, `embeds`, `flags` y `components`. El bot solo edita sus mensajes.
- **Archivos al editar:** los archivos nuevos se **agregan**; para quitar o reemplazar hay que mandar `attachments` con **todos** los que se conservan, más los nuevos (v10). Si falta `attachments` al editar con archivos, los no listados se pierden.
- **Límite poco conocido (DOC, códigos de error):** `30046` "Maximum number of edits to messages older than 1 hour reached. Try again later". Editar un mensaje de más de 1 hora tiene un tope de ediciones; la cifra no figura. La política de F9 (corregir un texto ya publicado) debe preferir borrar y publicar de nuevo si falla.

### 4.5 Borrar

- **(A)** `DELETE /webhooks/{id}/{token}/messages/{message_id}` (204). `thread_id` en la query si va en un hilo. Solo mensajes creados por ese webhook.
- **(B)** `DELETE /channels/{channel_id}/messages/{message_id}` (204). Borrar mensajes ajenos exige `MANAGE_MESSAGES`. Un post de foro creado por la API se borra como canal (`DELETE /channels/{thread_id}`, requiere `MANAGE_THREADS` o ser el creador según el caso; INFERENCIA, no leído). Con webhook, borrar el **primer mensaje** de un post de foro deja o no el hilo vacío: NO VERIFICADO.
- **Pausar y estado:** no hay "pausar" ni "cerrar" en Discord. "Cerrar" = borrar el mensaje o, en un hilo, archivarlo y bloquearlo con bot (`PATCH /channels/{thread_id}` con `archived` y `locked`; requiere `MANAGE_THREADS` para bloquear, DOC).
- **Consultar estado:** `GET /webhooks/{id}/{token}/messages/{message_id}` (A, solo mensajes de ese webhook) o `GET /channels/{channel_id}/messages/{message_id}` (B, INFERENCIA; exige `READ_MESSAGE_HISTORY`). Un 404 con código `10008` "Unknown message" significa que se borró.

### 4.6 Canal de anuncios y "Crosspost" (solo bot)

- Un canal `GUILD_ANNOUNCEMENT` (tipo 5) es uno que "users can follow and crosspost into their own server". "Bots can post or publish messages in this type of channel if they have the proper permissions." (DOC).
- **Publicar (Crosspost):** `POST /channels/{channel_id}/messages/{message_id}/crosspost`. Exige `SEND_MESSAGES` si el mensaje es del propio bot y además `MANAGE_MESSAGES` si es de otro usuario. Marca el mensaje con el indicador `CROSSPOSTED` (`1<<0`) y dispara una actualización de mensaje. Devuelve el mensaje.
- **Límite de Crosspost:** la página **no** da el límite. Fuentes de terceros (fichas de bots en top.gg) hablan de **10 mensajes por hora por canal**: NO VERIFICADO, no oficial. Diseñar con una cola y el manejo de 429.
- **Seguir un canal desde otro servidor:** `POST /channels/{id}/followers`, requiere `MANAGE_WEBHOOKS` en el canal destino (DOC). Eso crea un webhook interno tipo 2 "Channel Follower"; no es para publicar nosotros.
- **¿Se puede publicar con un webhook en un canal de anuncios y luego hacer Crosspost?** La doc de Execute Webhook no excluye canales de anuncios. El Crosspost por API requiere autorización de usuario o bot, no un token de webhook (INFERENCIA). Un moderador sí puede pulsar "Publicar" a mano. Que un mensaje de webhook sea "publicable" por API: NO VERIFICADO.
- **Requisito de servidor "Comunidad" para tener canales de anuncios:** NO VERIFICADO (no se pudo leer el artículo de soporte). Lo sabrá el operador al intentar crear el canal.

## 5. Medios

### 5.1 Cómo se adjuntan (DOC, "Uploading Files")

- El cuerpo es `multipart/form-data`. Los parámetros que no son archivos van como campos sueltos o juntos en JSON en el campo **`payload_json`**.
- Cada archivo es una parte `files[n]` con nombre único (`files[0]`, `files[1]`...) y `Content-Disposition` con `filename`. Los ejemplos fijan `Content-Type` por parte (p. ej. `image/png`).
- `attachments`: arreglo JSON con un objeto por archivo; su `id` coincide con el índice `n` de `files[n]`; cada uno puede llevar `filename` y `description` (texto alternativo, **hasta 1024 caracteres**). Al crear, lista los archivos a agregar.
- **Imágenes dentro de un embed:** `embeds[].image.url` acepta http(s) o un adjunto: "Images can also be referenced in embeds using the `attachment://filename` URL." No se pueden fijar `provider`, `video` ni `height`, `width`, `proxy_url` de la imagen.
- **Exige URL pública:** **no**. Se sube el archivo en la propia solicitud; la URL de R2 puede ser prefirmada y no hace falta exponer nada. Alternativa: poner `image.url` apuntando a una URL pública (Discord la descarga); no hace falta en la primera versión.
- **Formatos que Discord muestra incrustados (DOC):** `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`. Un `.mp4` adjunto se reproduce en el cliente (INFERENCIA, práctica común; no figura en lo leído).
- **Cabecera:** se debe enviar un `Content-Type` válido (`application/json` o `multipart/form-data`); si falta o es inválido, error `50035`.

### 5.2 Tamaños

| Dato | Valor | Fuente |
|---|---|---|
| Límite por archivo, por defecto | **20 MiB para todos los usuarios, bots, webhooks y respuestas de interacciones** ("may be higher for users depending on Nitro status or server Boost Tier") | DOC (referencia y changelog del **2026-09-03**: subió de 10 a 20 MiB) |
| Tamaño máximo de la solicitud completa | **25 MiB** (Create Message) | DOC |
| Tope por Nitro o por nivel de boost | La doc **no da las cifras**. Fuentes de prensa: Nitro Basic 50 MB, Nitro 500 MB; boost nivel 2 y 3 más altos | NO VERIFICADO (no oficial) |
| Cantidad máxima de archivos por mensaje | No figura en las páginas leídas (se suele citar 10) | NO VERIFICADO |
| Error por archivo grande | `50045` "File uploaded exceeds the maximum size"; `40005` "Request entity too large" | DOC |

Nota de discrepancia: la doc de Create Message sigue diciendo "25 MiB" para la solicitud; la referencia dice 20 MiB por archivo. Diseñar con **20 MiB por archivo y menos de 25 MiB en total**. Una nota de prensa del 2026-08 habla de efecto el 14 de agosto; el changelog oficial dice 3 de septiembre; se toma el changelog.

**Efecto en AgentSales (INFERENCIA, hay que medir):**

- Una foto del pipeline (JPEG 1080x1350, calidad ~85) pesa unos 200 a 500 KB (cifra de `instagram.md`): 10 fotos caben sobradamente.
- El reel del pipeline se codifica con tope `-maxrate 20M` y CRF 23 (`REEL_SPEC`). Un reel de 30 a 60 s puede superar 20 MiB. Para Discord hará falta una variante más liviana (recodificar a menor bitrate), o publicar el reel como enlace público (comportamiento de Discord ante un enlace de video: NO VERIFICADO), o subirlo solo si pesa menos de 20 MiB. Decisión del operador en el spec de F9.
- Los servidores de terceros con boost pueden aceptar más, pero se desconoce desde la API cuál es el tope de ese canal (NO VERIFICADO: no se encontró un campo que lo informe). Con el límite por defecto como base, no se rompe.

### 5.3 Embeds (DOC, página de mensajes)

| Elemento | Límite |
|---|---|
| Embeds por mensaje | **10** (todos de tipo `rich`; Discord ignora el `type` que se envíe) |
| `title` | 256 caracteres |
| `description` | **4.096** caracteres (un artículo de Moderator Academy dice 2.048: se toma la referencia de la API) |
| `fields` | hasta 25 |
| `field.name` | 256 |
| `field.value` | 1.024 |
| `footer.text` | 2.048 |
| `author.name` | 256 |
| **Total** | **6.000 caracteres** sumando `title`, `description`, `field.name`, `field.value`, `footer.text` y `author.name` de **todos** los embeds del mensaje |
| `content` | **2.000** caracteres |

- Los embeds se deduplican por URL; si se pasa un límite, 400 (`50035`) con el detalle del campo.
- Discord "may strip certain characters from message content" (DOC): sanear el texto generado por IA o venido de datos del aviso.
- Un mensaje de solo `embeds` o solo `files` es válido (el error `50006` "Cannot send an empty message" ocurre si no hay nada).
- Límite del mensaje por **contenido** (2.000) es menor que una descripción de embed (4.096): para textos largos conviene el embed. Decisión de formato del spec (`04-formato-publicaciones.md`).

## 6. Límites

### 6.1 Cabeceras (DOC, "Rate Limits")

| Cabecera | Significado |
|---|---|
| `X-RateLimit-Limit` | Solicitudes permitidas en el cubo |
| `X-RateLimit-Remaining` | Solicitudes que quedan |
| `X-RateLimit-Reset` | Época Unix en segundos en que se reinicia |
| `X-RateLimit-Reset-After` | Segundos hasta el reinicio (con decimales) |
| `X-RateLimit-Bucket` | Identificador único del cubo (no incluye el recurso principal de la ruta) |
| `X-RateLimit-Global` | Solo en 429; solo si fue el límite global |
| `X-RateLimit-Scope` | Solo en 429: `user` (por bot o usuario), `global`, `shared` (por recurso) |
| `Retry-After` | En el 429; igual que `retry_after` del cuerpo |

- **Respuesta 429 (DOC):** HTTP 429 con cuerpo JSON `{ "message", "retry_after", "global" }`; `retry_after` es un **número decimal de segundos**. Los clientes deben apoyarse en `Retry-After` o `retry_after`. Respetar la espera exacta; no usar una espera fija.
- **Por ruta y recurso:** los límites son por ruta (con el método) y por recurso principal: `channel_id`, `guild_id` y **`webhook_id` o `webhook_id` + `webhook_token`**. Cada uno calcula sus límites por separado (DOC). Por tanto un webhook tiene su propio cubo.
- **Global:** "All bots can make up to 50 requests per second". Las solicitudes sin cabecera de autorización (webhooks) se limitan por **IP**. El límite global es aparte de los de cada ruta. Si la ejecución de webhooks cuenta en el global: la doc no lo dice (NO VERIFICADO).
- **Solicitudes inválidas (DOC):** más de **10.000 respuestas 401, 403 o 429 en 10 minutos** causan una restricción temporal por IP (Cloudflare). Los 429 con `X-RateLimit-Scope: shared` no cuentan. **"Repeatedly using a webhook after it returns 404 can cause a temporary restriction"**: ante un 404 del webhook, marcarlo roto y dejar de usarlo.
- **Cifras por webhook:** la doc de la API **no publica** cuántos mensajes por segundo admite un webhook. Fuentes secundarias: "30 mensajes por minuto" (artículo de Moderator Academy, oficial pero de moderación, no de la API) y "5 solicitudes por 2 segundos" (guías de terceros). Tratarlos como orientación (NO VERIFICADO). El código **no fija** números: lee las cabeceras y obedece el 429. El código de error `20028` "The write action you are performing on the channel has hit the write rate limit" es otro tope por canal (cifra desconocida).
- **Volumen esperado:** unas pocas publicaciones al día por canal. El límite casi no se alcanza; el riesgo es una ráfaga al reintentar o al publicar un lote a la vez (usar espaciado entre publicaciones del mismo canal, como `--spacing` de la CLI).

### 6.2 Otros límites

| Límite | Valor | Fuente |
|---|---|---|
| `content` | 2.000 caracteres | DOC |
| Embeds | 10 por mensaje, 6.000 caracteres en total | DOC |
| `allowed_mentions.users` y `.roles` | hasta 100 cada uno | DOC |
| `nonce` | hasta 25 caracteres | DOC |
| Nombre de hilo / post | 1 a 100 caracteres | DOC |
| Etiquetas de foro | 20 por canal; 5 por hilo | DOC |
| Webhooks | 15 por canal (INFERENCIA por el texto del error), 1.000 por servidor | DOC (códigos de error) |
| Ediciones de mensajes de más de 1 hora | Hay un tope (error 30046), sin cifra | DOC |

## 7. Errores comunes

### 7.1 Tabla (DOC, "Opcodes and Status Codes"; el reintento es INFERENCIA)

| HTTP / código | Significado | Reintento |
|---|---|---|
| 400 / `50035` | Cuerpo inválido (límite de caracteres, campo mal formado, `Content-Type` inválido) | **No** (error de contenido; corregir) |
| 400 / `50006` | Mensaje vacío | **No** |
| 400 / `220001` | Foro: falta `thread_name` o `thread_id` | **No** (configuración) |
| 400 / `220002` | Foro: llegaron ambos | **No** |
| 400 / `40067` | Foro con etiqueta obligatoria sin `applied_tags` | **No**: pedir etiqueta al operador |
| 400 / `240000` | Mensaje bloqueado por el filtro de enlaces dañinos | **No**: avisar |
| 401 / `50027` | Token de webhook inválido (o token de bot inválido) | **No**: marcar la cuenta `needs_reconnect` |
| 403 / `50013` | Sin permisos (bot) | **No**: avisar qué permiso falta |
| 403 / `50001` | Sin acceso al canal (bot) | **No** |
| 404 / `10015` | Webhook inexistente (borrado) | **No**; dejar de usarlo (riesgo de bloqueo) |
| 404 / `10003` | Canal inexistente | **No** |
| 404 / `10008` | Mensaje inexistente (editar o borrar) | **No** (ya estaba borrado) |
| (HTTP sin confirmar) / `40005`, `50045` | Solicitud o archivo demasiado grande | **No** (recomprimir o quitar el archivo) |
| (HTTP sin confirmar) / `50046` | Archivo inválido | **No** |
| 400 / `50083`, `160005` | Hilo archivado o bloqueado | Reabrir si hay permiso; si no, **No** |
| 400 / `30046` | Tope de ediciones de mensajes de más de 1 hora | **No** hasta más tarde; usar borrar y publicar de nuevo |
| 429 | Límite de llamadas | **Sí**, esperando `retry_after` (el mensaje no se creó: INFERENCIA); sin gastar el contador de reintentos |
| 502 | "No gateway was available. Wait and retry." | Sí, con espera; **resultado ambiguo** (ver 7.2) |
| 5xx | Error del servidor ("rare") | Sí, con espera; **resultado ambiguo** |

El código `40062` ("Service resource is being rate limited") también es reintentable con espera. La tabla de la doc lista cada código JSON con su mensaje, pero **no** el estado HTTP que lo acompaña: los estados de la columna izquierda para códigos JSON son INFERENCIA (clasificar siempre primero por el código JSON del cuerpo y después por el HTTP).

### 7.2 Idempotencia: Discord no la ofrece en webhooks

- **Execute Webhook no documenta `nonce`** ni ninguna clave de idempotencia. Enviar dos veces crea dos mensajes.
- **Create Message sí:** `nonce` (hasta 25 caracteres) con `enforce_nonce=true`: si el mismo autor ya envió un mensaje con ese `nonce` en "the past few minutes", se devuelve ese mensaje y no se crea otro. La ventana es corta y no está definida en minutos.
- **Qué hacer en AgentSales (diseño):**
  1. Guardar la publicación como `publishing` **antes** de llamar, con la fecha. Una publicación por intento; nunca dos intentos paralelos del mismo canal.
  2. Usar siempre `wait=true`. Con la respuesta, guardar `message.id` en la misma transacción que la marca `published`.
  3. **429 y errores de conexión antes de enviar** (DNS, rechazo de TLS): se puede reintentar sin riesgo. Un 429 no crea el mensaje.
  4. **Tiempo agotado, corte de red o 5xx después de enviar:** el resultado es desconocido. Con un **webhook** no se puede preguntar a Discord "¿ya estaba?", porque `GET .../messages/{id}` necesita el `id`, que se perdió, y el webhook no lee el canal. Regla propuesta: **no reintentar solo**; dejar la publicación en `needs_review` y que el operador mire el canal y confirme o reintente (como en Marketplace con `confirm`/`not-published`). Para un servidor propio es aceptable.
  5. Con **bot**: usar `nonce` = 25 primeros caracteres de un hash del id de publicación, con `enforce_nonce=true`, y además, antes de reintentar, leer los últimos mensajes del canal (`GET /channels/{id}/messages?limit=...`, necesita `VIEW_CHANNEL` y `READ_MESSAGE_HISTORY`) y buscar una marca propia (por ejemplo, el id de publicación en `footer.text` de un embed). Que `GET /channels/{id}/messages` no exija el intent `MESSAGE_CONTENT` para leer los mensajes del propio bot: NO VERIFICADO (la doc dice que sin el intent el contenido llega vacío salvo excepciones; los embeds y los mensajes propios podrían ser una excepción).
  6. Marcar los mensajes con el id de publicación en el pie del embed (`footer.text`), útil tanto para el operador como para la reconciliación con bot.

## 8. Cómo probar sin riesgo

- **No existe sandbox de Discord.** Lo equivalente: **un servidor de pruebas propio** (privado, sin invitados; crear servidores es gratis), con un canal de texto, uno de foro y uno de anuncios (si se puede), y un webhook por canal. Se prueba con `PUBLISH_MODE=live` solo para ese servidor y con la autorización del operador en el chat; el resto de los canales siguen en `dry-run`.
- **Tests automáticos:** msw o fakes (regla del proyecto): ningún test llama a Discord. Los cuerpos de la sección 4 y las respuestas de la 7 sirven de fixtures.
- **Prueba de conexión barata (sin publicar):** `GET /webhooks/{id}/{token}` valida que el webhook existe y a qué canal apunta (sección 4.2).
- **Lista de pruebas NO VERIFICADO (de menor a mayor riesgo):**
  1. Que `https://discord.com/api/v10/webhooks/{id}/{token}?wait=true` funciona (v10 con webhooks).
  2. Forma exacta de la respuesta de "Get Webhook with Token" (¿trae `guild_id` y `channel_id`?).
  3. Texto con `@everyone` y `allowed_mentions: {"parse": []}`: confirmar que **no** avisa a nadie; probar también sin `allowed_mentions` desde un webhook para ver qué pasa de verdad.
  4. Subida multipart con 1 foto y con 10 fotos; un video de unos 15 MiB y otro de 25 MiB (¿`50045`?); cantidad máxima de archivos.
  5. Post de foro con `thread_name` y `applied_tags` (y con una etiqueta obligatoria sin enviarla: `40067`); en la respuesta con `wait=true`, ¿`channel_id` es el hilo?
  6. Editar y borrar un mensaje de webhook, uno en un hilo (`thread_id`), y uno de más de 1 hora (`30046`).
  7. Con el bot: instalación con permisos mínimos, `POST` con `nonce`+`enforce_nonce` dos veces seguidas, Crosspost y su límite real por hora.
  8. Cabeceras `X-RateLimit-*` que devuelve un webhook; ráfaga de 10 mensajes para ver el 429 (en el servidor de pruebas).
  9. Qué hace el cliente ante un enlace a un video MP4 y a un archivo adjunto (reproducción).

## 9. Riesgos y términos de uso relevantes

Fuentes: Política de Desarrolladores de Discord (versión leída: vigente desde 2024-07-08, actualizada 2024-06-06, a través de un lector público de la página oficial; puede haber una versión posterior), resúmenes de búsqueda de los Términos de desarrollador, y las guías de Discord. **Leer las versiones vigentes en el Developer Portal antes de ofrecer el sistema a terceros.**

- **Automatización permitida por la API.** Los webhooks y los bots (con `Authorization: Bot`) son los mecanismos oficiales. Automatizar una cuenta de usuario normal ("self-bots") está prohibido y puede terminar en cierre de cuenta (guía oficial de self-bots). **Nunca usar un token de usuario** para publicar.
- **Contacto con usuarios.** Regla 5: "Do not contact users on Discord without their explicit permission" (incluye mensajes directos no solicitados). AgentSales **solo publica en canales** que el dueño eligió; **no envía mensajes directos**. Regla de marketing: los mensajes a usuarios deben ser relevantes para la función de la app (resumen de búsqueda).
- **Automatización para "mantener actividad".** Regla 13: no automatizar mensajes con el fin de mantener la actividad de un servidor, ni inflar la membresía con cuentas bot o de usuario. Publicar contenido de la marca en un calendario no es eso, pero **no publicar mensajes de relleno** para simular actividad.
- **IA.** Regla 21: no usar el contenido de mensajes obtenido de la API para entrenar modelos de aprendizaje automático o IA sin permiso expreso de Discord. AgentSales **solo escribe** (no lee ni guarda mensajes del servidor para entrenar): no aplica, pero la regla 15 obliga a no usar datos de la API "for any purpose outside of what is necessary to provide your stated functionality". Una obligación de declarar que el texto fue hecho con IA en Discord: **no se encontró** en lo leído (NO VERIFICADO; en Instagram sí existe `is_ai_generated`).
- **Límites.** Los Términos dicen que Discord puede fijar límites y que el desarrollador "will not attempt to circumvent" ni los de cada API; para excederlos necesita consentimiento escrito. No repartir envíos entre varios webhooks o bots para esquivar el límite de un canal.
- **Credenciales.** Regla 4: no pedir a los usuarios contraseñas ni tokens de acceso. **Un webhook no es una credencial de usuario**, pero pedirle a un tercero que "pegue su URL" es pedir un secreto del canal: explicar para qué sirve y que puede borrarlo cuando quiera. Para terceros, la vía OAuth `webhook.incoming` evita copiar y pegar.
- **Datos de la API.** Regla 17: no vender ni compartir los datos de la API con corredores de datos ni redes publicitarias. Los términos clasifican como "API Data" incluso las credenciales y tokens. Guardar solo lo necesario: IDs de servidor y canal, nombre del canal, token cifrado.
- **Política de privacidad.** La Política remite a la sección 5 (privacidad y seguridad del usuario) de los Términos; no se pudo leer. Si el bot se ofrece a terceros, se asume que hará falta una política de privacidad y términos propios (como en Meta); NO VERIFICADO el requisito exacto.
- **Spam y reputación.** Los Community Guidelines prohíben el spam masivo y herramientas para facilitarlo (resumen de búsqueda). Publicar la misma pieza en muchos servidores ajenos sin permiso puede llevar a la suspensión de la app. Un mensaje por pieza, en canales elegidos por el dueño.
- **Moderación de contenido.** El filtro de enlaces dañinos (`240000`) puede bloquear un mensaje. Un servidor con AutoMod puede borrar o frenar mensajes del bot o del webhook (si AutoMod aplica a webhooks: NO VERIFICADO).
- **Leaks.** Quien obtenga la URL del webhook puede publicar en ese canal con el nombre y avatar que quiera, **borrar el webhook** (endpoint sin autenticación) y leer sus datos. Guardar cifrada y redactar en logs: cualquier `https://discord.com/api/webhooks/<id>/<token>` (incluso dentro de mensajes de error de `fetch`, trazas y reportes de fallas). No imprimirla en la CLI ni en el chat; el panel solo muestra los últimos caracteres o "conectado". La rotación se hace borrando el webhook y creando otro (que se pueda regenerar el token de un webhook existente por API: no figura en la doc leída, NO VERIFICADO).

## 10. Fuentes (consultadas el 2026-10-19)

Oficiales (doc de desarrolladores, leída con la herramienta de extracción de texto):

- https://docs.discord.com/developers/resources/webhook (antes `discord.com/developers/docs/resources/webhook`, 301): Create Webhook, Execute Webhook, Get/Edit/Delete Webhook Message, webhooks "with Token", tipos de webhook.
- https://docs.discord.com/developers/resources/message : Create Message, `nonce`/`enforce_nonce`, `allowed_mentions`, límites de embeds y de la solicitud (25 MiB), Crosspost, editar y borrar, indicadores del mensaje.
- https://docs.discord.com/developers/resources/channel : canales de foro y medios, crear un post, etiquetas, canales de anuncios, hilos, límites de hilos.
- https://docs.discord.com/developers/reference : "Uploading Files" (multipart, `payload_json`, `files[n]`, `attachments`, `attachment://`, 20 MiB), versiones de la API (v6 por defecto, deprecada), User-Agent, autenticación.
- https://docs.discord.com/developers/topics/rate-limits : cabeceras, 429, cubos por recurso, límite global de 50 solicitudes por segundo, límite de solicitudes inválidas.
- https://docs.discord.com/developers/topics/permissions : bits de los permisos, sobrescrituras e implícitos.
- https://docs.discord.com/developers/topics/opcodes-and-status-codes : códigos HTTP y códigos JSON de error.
- https://docs.discord.com/developers/topics/oauth2 : instalación de bots, `webhook.incoming`, flujo de código, contextos de instalación.
- https://docs.discord.com/developers/resources/application : `bot_public`, `install_params`, indicadores de intents y verificación.
- https://docs.discord.com/developers/events/gateway : intents privilegiados; REST sin Gateway.
- https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review : umbral de 10.000 usuarios, plazo de 90 días, reaplicación anual.
- https://docs.discord.com/developers/quick-start/getting-started : crear la app, el token del bot y el enlace de instalación.
- https://docs.discord.com/developers/change-log : 2026-06-10 (separación de la verificación y de la revisión de intents, umbral de usuarios), 2026-09-03 (límite de archivos de 10 a 20 MiB).
- https://docs.discord.com/developers/policies-and-agreements/developer-policy (307 a `support-dev.discord.com/hc/articles/8563934450327-Discord-Developer-Policy`): leída a través de un lector público (no oficial); versión de 2024-07-08.

Oficiales de Discord, secundarios (no de la API):

- https://discord.com/moderation/4405223159703-322-using-webhooks-and-embeds (Discord Moderator Academy): aviso sobre la URL, límites de embeds (la descripción de 2.048 contradice a la API), "30 messages per minute", "10 webhooks per server" (contradice a los códigos de error).

No se pudieron leer (403 a la lectura directa); lo que se cita de ellas viene de resúmenes de búsqueda:

- https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks (ruta de creación en Ajustes del servidor > Integraciones).
- https://support.discord.com/hc/en-us/articles/360032008192-Announcement-Channels
- https://support.discord.com/hc/en-us/articles/25444343291031-File-Attachments-FAQ (tope por Nitro y boost).
- https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service (límites de API, tokens sin uso en 30 días).
- https://support-dev.discord.com/hc/en-us/articles/23926564536471-How-Do-I-Get-My-App-Verified
- https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots

No oficiales (solo pista):

- Prensa y blogs sobre el límite de 20 MB y los topes de Nitro (gaminghq.eu, dexerto.com, neowin.net, file.kiwi).
- Fichas de bots en top.gg (10 publicaciones por hora por canal en Crosspost).
- Guías de terceros (hookdeck.com, space-node.net) para "5 solicitudes por 2 segundos por webhook".

## 11. Riesgos y recomendación

**Riesgos principales**

1. **Fuga de la URL del webhook:** da publicar, borrar el webhook y leer sus datos. Mitigación: cifrar, redactar en logs, no mostrar, rotar.
2. **Menciones por accidente (`@everyone`, `@here`, roles):** el texto viene de IA y de datos del aviso. Mitigación: `allowed_mentions` explícito en cada envío (`{"parse": []}` por defecto; roles solo si el operador los pide) y, además, neutralizar `@everyone`/`@here` en el texto antes de enviar.
3. **Publicación doble sin idempotencia (webhook):** un corte después de enviar deja el resultado desconocido. Mitigación: `wait=true`, estado `publishing` antes de llamar, y `needs_review` ante la duda (sección 7.2).
4. **Videos de más de 20 MiB:** el reel del pipeline puede no caber. Requiere una variante liviana o un enlace.
5. **Doc y políticas en movimiento:** la doc cambió de dominio, subió el límite de archivos hace poco y la verificación de apps cambió el 2026-06-10. Los términos de desarrollador no se pudieron leer.
6. **Webhook 404 repetido:** puede bloquear la IP. Parar al primer `10015`.

**Recomendación**

- **Primero (A) webhook de canal**, para el servidor propio (AgentPey y el del operador). Razones: lo crea el dueño en un minuto, sin app, sin revisión, sin token global que proteger; cubre publicar, editar, borrar, adjuntar y crear posts de foro con etiquetas; y su alcance es un solo canal, así que una fuga tiene daño acotado. El costo es la falta de idempotencia y de lectura; para unas pocas publicaciones al día en un servidor propio, es aceptable con `needs_review`.
- **Después (B) bot**, cuando haga falta algo que el webhook no da: Crosspost en canales de anuncios, hilos desde un mensaje en canales de texto, `nonce` y lectura del historial para reconciliar, listar las etiquetas del foro. Para terceros, instalar el bot exige guardar un token global y cumplir los requisitos de verificación a escala (umbral aún NO VERIFICADO).
- **Para terceros, en este orden:** (1) el cliente crea su webhook y lo pega (es lo que menos nos compromete); (2) `webhook.incoming` por OAuth si se quiere una conexión con un clic, sin bot; (3) bot instalado, solo si algún cliente necesita Crosspost u otro servicio de bot. La interfaz `Publisher` (docs/01-arquitectura.md) puede tener un único adaptador `discord` con una estrategia por cuenta (`webhook` o `bot`), de modo que cambiar de A a B no cambie el resto del sistema.
- **Decisiones del operador pendientes:** ver la lista de preguntas en la respuesta a esta investigación (política de reels, canal de anuncios con Crosspost, etiquetas de foro, qué hacer ante el resultado desconocido).
