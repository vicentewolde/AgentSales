# Instagram: contenido de marca y personal (nota complementaria para F9)

Nota verificada el 2026-10-19 con la documentación oficial vigente de Meta. **Complementa** a `docs/integraciones/instagram.md` (que cubre carrusel de imágenes, reel, autenticación, límites, errores y App Review para terceros) y **no repite** lo ya verificado allí. Aquí solo va lo que esa nota no cubría, para publicar contenido de marca o personal (no inmobiliario) del operador y de AgentPey, y más adelante de terceros.

Convención: **DOC** = documentación oficial de Meta; **INFERENCIA** = deducido; **NO VERIFICADO** = falta prueba real. No se hizo ninguna llamada a la API ni se abrió el panel.

Aviso de método: las páginas de Meta se leyeron con una herramienta que extrae y resume el texto (páginas oficiales y sus versiones `.md`), no en el navegador. Las citas literales cortas pueden tener paráfrasis. Varias páginas de referencia están escritas para Facebook Login y no mencionan Instagram Login; cuando una página no distingue el tipo de login, se anota "sin restricción de login declarada", que **no** equivale a "funciona con Instagram Login". Todo lo que dependa de eso queda NO VERIFICADO hasta probarlo con la cuenta del operador.

## 1. Resumen

- **Casi todo lo nuevo sirve con Instagram Login según la doc, salvo música, ubicación, encuesta y marca de publicidad pagada.** Imagen suelta, Stories (imagen y video), carrusel mixto foto + video, `alt_text`, `cover_url`, `user_tags`, `trial_params` y `is_ai_generated` están documentados. La doc de colaboradores (`collaborators`) y de ubicación (`location_id`) no restringe el login en la publicación, pero sus páginas auxiliares son de Facebook Login: NO VERIFICADO con Instagram Login.
- **Cuentas:** solo profesionales (Empresa o Creador). Las cuentas personales no tienen API. El operador debe usar una cuenta profesional.
- **Cuentas propias (operador, AgentPey):** el modo desarrollo con acceso estándar basta, sin App Review ni verificación del negocio (DOC). Riesgo nuevo y crítico para marca: la doc de modos dice que los datos creados en desarrollo solo los ven los usuarios con rol. Si eso aplica a las publicaciones de Instagram, los seguidores no las verían. NO VERIFICADO; probar antes de planear F9 (sección 2.3).
- **Cuota:** es por cuenta de Instagram, así que los avisos y el contenido propio comparten cuota si salen por la misma cuenta, y no comparten si son cuentas distintas (sección 3).
- **Programar:** la doc oficial no documenta ningún parámetro de programación en Instagram; da por hecho que programa la app (sección 4). Mantener el calendario propio (pg-boss).
- **Métricas:** existen con `instagram_business_manage_insights` en `graph.instagram.com`; el permiso es nuevo y la doc se contradice sobre su revisión (sección 5).
- **Comentarios:** viable como paso futuro con `instagram_business_manage_comments`, también con acceso estándar para cuentas propias (sección 6).
- **Terceros:** acceso avanzado, App Review, verificación del negocio y Access Verification, ya descritos en la nota principal §13; esta nota agrega qué pasa con los dos permisos nuevos (sección 7).
- **Qué publica hoy AgentSales para posts (F9-T13):** imagen suelta, carrusel de 2 a 10 y reel, con la cuota de la cuenta compartida con los avisos (sección 13). **La prueba S1 sigue pendiente y es obligatoria antes de publicar de verdad un post.**

## 2. Cuentas y app para cuentas propias

### 2.1 Tipos de cuenta (DOC)

| Tipo | Qué dice la doc | Marca |
|---|---|---|
| Empresa (`BUSINESS`) | Soportada por Instagram Login | DOC |
| Creador (`MEDIA_CREATOR`) | Soportada por Instagram Login; `account_type` devuelve uno de los dos valores | DOC |
| Personal | No se menciona en ninguna página de la plataforma actual; todas exigen "Instagram professional account". La Instagram Basic Display API, que daba acceso de lectura a cuentas personales, terminó el 2024-12-04 (fecha confirmada solo por fuentes secundarias y por un resumen de búsqueda de Meta; la página oficial de Basic Display que se pudo leer no trae el aviso) | DOC por omisión + fuente secundaria |
| Diferencias Empresa y Creador para publicar | **Ninguna página las distingue** (publicación, Stories, reels, carrusel, colaboradores). Solo hay una excepción: "Creator is not eligible for branded content" (se refiere a quién puede ser el patrocinador en anuncios de colaboración pagada, que es solo de Facebook Login y no se usa) | DOC; si Creador tiene alguna limitación real de API: NO VERIFICADO |

- **Qué significa para F9:** la cuenta personal del operador debe ser profesional para entrar al sistema. Convertirla es una acción dentro de la app de Instagram (Configuración > Tipo de cuenta); esa conversión **no** está en la doc de desarrolladores y no se verificó aquí. @vicentewoldec ya publicó por API, así que ya es profesional.
- **Página de Facebook:** sigue sin ser obligatoria con Instagram Login (DOC, nota principal §2).

### 2.2 ¿Basta modo desarrollo con roles para cuentas propias, sin App Review?

**Sí, según la doc (DOC, lectura de tres páginas coincidentes):**

- Modos de la app: en modo desarrollo "solo pueden usar la app los usuarios con rol"; los permisos con acceso estándar o avanzado funcionan para ellos, y App Review se asocia al modo live, no al desarrollo.
- Resumen de la plataforma de Instagram y guía de Business Login: el **acceso estándar** (el de por defecto) basta si la app sirve a cuentas profesionales "que posees o administras" **y que agregaste a tu app en el App Dashboard**. El acceso avanzado (App Review + verificación del negocio) solo se exige para cuentas que no son tuyas ni administras, o para usuarios sin rol.
- La página de App Review de Instagram lo dice sin vueltas: no hace falta cuando la app sirve solo a un negocio que posees o administras con acceso estándar.
- **Consecuencia:** una app de uso propio puede quedarse en modo desarrollo de forma indefinida. El Data Use Checkup anual **no se exige** a apps con solo acceso estándar (DOC, nota principal §13.1). Lo que sí exige modo live son funciones como los webhooks (ver sección 6).

**Lo que la doc no resuelve (NO VERIFICADO):**

- Que el acceso estándar aplique igual a la cuenta de **AgentPey** si el operador la administra pero la cuenta de Instagram es otra identidad. INFERENCIA fuerte: da lo mismo, porque lo que cuenta es tener la cuenta agregada a la app y con rol, como @vicentewoldec.
- La página de resumen advierte que con acceso estándar "algunas funciones pueden no funcionar bien". No dice cuáles.

### 2.3 Riesgo crítico: ¿las publicaciones hechas en modo desarrollo las ven los seguidores?

- **DOC (modos de la app):** "Los datos creados en modo desarrollo solo los ven los usuarios con rol"; al pasar a live, "los datos creados en desarrollo (por ejemplo publicaciones de prueba) pasan a verse". La nota principal §13.2 ya lo recogía.
- **La doc no aclara si eso aplica a una publicación real de Instagram** hecha por la API de contenido, que en la práctica es un post normal de la cuenta. La demo de F3 (2026-10-06) publicó un carrusel y un reel y se borraron a mano; **nadie comprobó desde una cuenta sin rol si eran visibles**.
- **Por qué importa:** si fueran invisibles para los seguidores, publicar contenido de marca en modo desarrollo no serviría y habría que pasar la app a live (con solo los permisos aprobados; para uso propio habría que pedir acceso avanzado igualmente). **NO VERIFICADO; es la primera prueba de F9** (sección 9, prueba 1).

### 2.4 Cómo se agregan las cuentas a la app y cuántas puede tener

- **DOC (caso de uso de Instagram):** en el App Dashboard, caso de uso de Instagram > **API setup with Instagram login** > sección **Generate access tokens** > **Add account** (o **Generate token** junto a la cuenta) > Continue > iniciar sesión en Instagram en la ventana emergente > Save > copiar el token (largo, 60 días). La sección se llama "tokens" en plural y el botón es "Add account", lo que sugiere varias cuentas.
- **Cuántas cuentas:** la doc **no dice** si hay un límite ni lo contrario. Para el rol de Tester la doc genérica de roles dice hasta 50 (500 con Business Manager verificado); que ese tope aplique a testers de Instagram: NO VERIFICADO (nota principal §12.2). Para F9 (operador + AgentPey) no importa: son 2 o 3 cuentas.
- **Rol:** la doc oficial no describe el rol "Instagram Tester" (nota principal §12.2); lo que se sabe viene de guías de terceros y de la cuenta del operador, que ya aceptó la invitación. Para sumar AgentPey: invitar su nombre de usuario de Instagram como Instagram Tester y **aceptar la invitación iniciando sesión como esa cuenta** (Editar perfil > Aplicaciones y sitios web > Tester Invites). Después, Add account con esa cuenta.
- **Tokens por cuenta:** cada cuenta tiene su propio token de 60 días y su propio ciclo de refresco, igual que hoy. No hay un token "de la app" que cubra varias cuentas. El modelo `platform_accounts` ya sirve (nota principal §12.1).
- **Variante de F7:** para la cuenta personal del operador y AgentPey, es el mismo operador quien inicia sesión en la ventana de Generate token; no hay tema de confianza con terceros.

## 3. Cuota de publicaciones: ¿por cuenta? ¿se comparte con los avisos?

- **Por cuenta de Instagram (DOC):** "Instagram accounts are limited to 100 API-published posts within a 24-hour moving period" (guía de publicación), y `content_publishing_limit` se consulta con el `<IG_ID>` de la cuenta. Es decir, la unidad es la cuenta de Instagram, no la app ni el corredor del sistema.
- **Se comparte con los avisos si es la misma cuenta (INFERENCIA, firme):** si el contenido de marca sale por @vicentewoldec y los avisos de prueba también, ambos suman en el mismo contador de esa cuenta. AgentPey, al ser otra cuenta, tiene el suyo. La doc no habla de reparto entre "apps": otra app que publique por la misma cuenta también suma (la nota principal §6.1 ya decía que la publicación manual desde la app de Instagram no cuenta).
- **Contradicción abierta de Meta, igual que en la nota principal §6:** 100 en el apartado de límite de tasa y 50 en el apartado de carruseles y en la referencia de `content_publishing_limit` (`quota_total` "currently 50"). Leer `quota_total` del `config`. Sigue sin medirse el valor real.
- **Qué cuenta: NO VERIFICADO para Stories y reels.** La doc dice que `quota_usage` son los "IG Containers" **publicados**; carrusel cuenta 1 (DOC). No dice si una Story, un reel o una imagen suelta cuentan igual, ni si las Stories cuentan. Una Story podría no contar o contar 1: la doc no lo declara. Medir con `content_publishing_limit` antes y después de publicar una Story de prueba (sección 9, prueba 5).
- **Contenedores:** 400 por cuenta en 24 h móviles (DOC, referencia IG User Media). Un carrusel mixto de N ítems gasta N + 1.
- **Para F9:** con 1 a 3 publicaciones al día por cuenta la cuota no importa en la práctica; lo importante es que el chequeo previo a `media_publish` (nota principal §6.1) use el `<IG_ID>` de la cuenta correcta.

## 4. Programar publicaciones

- **DOC: no existe `scheduled_publish_time` ni parámetro de programación para Instagram en ninguna de las páginas leídas.** Lo buscado: guía de publicación (con Instagram Login y la general), referencia de `IG User Media`, `media_publish`, `IG Container`, changelog de Instagram (2025-01 a 2026-10). El changelog no tiene ninguna entrada sobre programación. El índice de la doc (`llms.txt`) tiene la sección "Scheduling" vacía.
- **La única mención es indirecta:** la guía de publicación recomienda que la app aplique el límite de publicaciones "especialmente si tu app permite a los usuarios programar publicaciones para el futuro". Es decir, Meta da por hecho que **programa la app**, no Instagram.
- **Contenedores no sirven de programación:** un contenedor vence a las 24 h (DOC, nota principal §4.4), así que no se puede crear con días de anticipación y publicar después.
- **Pista no oficial (contradictoria):** un blog de un proveedor afirma que `published=false` más `scheduled_publish_time` (entre 10 minutos y 75 días) funciona al crear el contenedor; varias otras guías de terceros dicen lo contrario. Es el mecanismo de las Páginas de Facebook, no hay doc de Instagram que lo respalde. **NO VERIFICADO y no recomendado.** Si se quisiera probar: un contenedor de imagen con esos parámetros en la cuenta del operador, sin `media_publish`; esperar un error de parámetro desconocido.
- **Decisión de diseño (INFERENCIA):** mantener el calendario propio de F6 (pg-boss, hora de Chile), que crea los contenedores poco antes de la hora y publica. No depender de nada del lado de Instagram.

## 5. Métricas del post publicado (insights)

### 5.1 Qué pide y desde cuándo existe

- **DOC (guía de Insights y referencia de insights de `IG Media`):** con Instagram Login, host `graph.instagram.com`, token de usuario de Instagram, permisos `instagram_business_basic` **e** `instagram_business_manage_insights`. Endpoint: `GET /<IG_MEDIA_ID>/insights?metric=<métricas>`; parámetros opcionales `period` y `breakdown`.
- **Desde cuándo:** el changelog de Instagram del **2025-01-21** dice que las APIs de insights quedan disponibles para apps con Instagram Login (también aparece la métrica `views`). El anuncio oficial de Meta de **2025-03-24** ("User and media insights on Instagram API with Instagram Login") dice que el permiso `instagram_business_manage_insights` se "introdujo con esta actualización". Las dos fechas no coinciden; ambas son anteriores a hoy. Para F9 basta con que **hoy está documentado y disponible**.
- **Acceso:** acceso estándar basta para cuentas propias agregadas a la app; el acceso avanzado se necesita para cuentas ajenas (DOC, guía de Insights). El anuncio de 2025 dice que "se requiere acceso avanzado para pedirlo a cualquier usuario de la app" (se refiere a cuentas ajenas).
- **Inconsistencia de la doc sobre el permiso (NO VERIFICADO):** `instagram_business_manage_insights` **no aparece** en la lista de scopes de la guía de Business Login (solo los cuatro `basic`, `content_publish`, `manage_messages`, `manage_comments`), ni en la lista de permisos del resumen de la plataforma, ni en la lista de la página de App Review, ni en la lista de 34 permisos de Access Verification. Sí aparece en las dos páginas de insights y en el anuncio. Hay que confirmar en el panel que el caso de uso lo ofrece (en 2026-10-05 los otros dos permisos tampoco venían agregados y hubo que sumarlos en "Permisos y funciones", nota principal §3.6) y que el OAuth o Generate token acepta ese scope.
- **El token existente no lo trae (INFERENCIA):** el token de @vicentewoldec se generó con `basic` y `content_publish`; para leer insights hay que volver a generar o autorizar con el scope nuevo y guardar los permisos concedidos.

### 5.2 Métricas disponibles (DOC, referencia de insights de `IG Media`)

| Métrica | Posts del feed | Reels | Stories |
|---|---|---|---|
| `reach` (alcance) | sí | sí | sí |
| `likes` | sí | sí | no |
| `comments` | sí | sí | no |
| `saved` | sí | sí | no |
| `shares` | sí | sí | sí |
| `reposts` | sí | sí | sí |
| `views` | sí | sí | sí |
| `total_interactions` | sí | sí | sí |
| `follows`, `profile_visits`, `profile_activity` | sí | no | sí |
| `ig_reels_avg_watch_time`, `ig_reels_video_view_total_time`, `reels_skip_rate` | no | sí | no |
| `replies`, `navigation`, `link_clicks` | no | no | `replies` y `navigation` sí; `link_clicks` solo con Facebook Login |

- `impressions` y `plays` están **deprecadas**: `impressions` no funciona para medios creados desde el 2024-07-02 y las demás se retiraron a partir del 2025-04-21; usar `views`.
- `total_likes`, `total_comments` y `total_views` (que incluyen impulso y cruces) son solo de Facebook Login.
- **Carruseles:** la referencia dice "Insights data is not available for any media within an Instagram Media album". Está redactado para los **hijos**; si el carrusel completo (el ID que devuelve `media_publish`) tiene insights: **NO VERIFICADO**. Probar con el carrusel de la demo.
- **Alternativa barata para "likes y comentarios":** los campos `like_count` y `comments_count` del propio medio (`GET /<MEDIA_ID>?fields=like_count,comments_count`) con solo `instagram_business_basic`. La referencia de `IG Media` no los marca como exclusivos de Facebook Login, pero tampoco mapea permisos por campo: **NO VERIFICADO**. `like_count` se omite si el dueño oculta los "me gusta". Ojo: esa misma página marca `caption` y `media_product_type` como solo de Facebook Login, lo que contradice lo que el publisher de F3 ya usa; probablemente es error de resumen, pero conviene comprobarlo en la misma llamada de prueba.

### 5.3 Límites y demoras

- **Demora:** "los datos pueden tardar hasta 48 horas" (DOC). Un post recién publicado puede devolver conjunto vacío.
- **Dato sin valor:** si no hay datos, la API devuelve un conjunto vacío, **no 0** (DOC). El código debe distinguir "sin dato" de "cero".
- **Retención:** las métricas de medios se guardan hasta 2 años; las de usuario, hasta 90 días (DOC, páginas distintas).
- **Stories:** las métricas están disponibles solo mientras vive la Story (24 h; hay que leerlas antes, o capturarlas con el webhook `story_insights`, que exige app publicada); con menos de 5 espectadores devuelve error de código `10`; `replies` da 0 en Europa y Japón (DOC).
- **Umbrales de seguidores:** algunas métricas de **cuenta** (no de medio) no se entregan con menos de 100 seguidores (DOC). Para medios la doc no da umbral; NO VERIFICADO.
- **Solo cuentas profesionales**, una cuenta por consulta (DOC).
- **Cuota de llamadas:** sin tope aparte; cuenta dentro del límite de uso de negocio de Instagram (nota principal §6).

## 6. Leer y responder comentarios (viabilidad futura)

- **DOC (Comment Moderation):** con Instagram Login, `graph.instagram.com`, permisos `instagram_business_basic` e `instagram_business_manage_comments`.

| Operación | Endpoint |
|---|---|
| Leer comentarios de un medio | `GET /<IG_MEDIA_ID>/comments` |
| Leer respuestas de un comentario | `GET /<IG_COMMENT_ID>/replies` |
| Responder | `POST /<IG_COMMENT_ID>/replies` con `message` |
| Ocultar o mostrar | `POST /<IG_COMMENT_ID>` |
| Activar o desactivar comentarios de un medio | `POST /<IG_MEDIA_ID>?comment_enabled=<BOOL>` (también con `instagram_business_basic` + `manage_comments`, DOC IG Media) |
| Borrar un comentario | `DELETE /<IG_COMMENT_ID>` |

- **Webhooks:** la doc recomienda suscribirse a `comments` y `live_comments` "para evitar el límite de llamadas". La guía del caso de uso dice que funciones como los webhooks "requieren que tu app esté publicada" (modo live). Con la app en modo desarrollo, la lectura sería por consulta (polling) y consume el límite de llamadas. Si los webhooks funcionan en desarrollo para cuentas con rol: NO VERIFICADO. El operador ya decidió no usar webhooks (nota principal §2).
- **Acceso:** acceso estándar basta para cuentas propias; avanzado para ajenas (DOC). **`instagram_business_manage_comments` sí está en la lista de App Review** (nota principal §13.1 y la página de App Review), pero **no** en la de Access Verification (los 34 permisos).
- **Viabilidad (INFERENCIA):** técnicamente viable y sin App Review para cuentas propias. Lo único que se agrega al sistema es un scope más (y reconectar las cuentas para tenerlo) y, para responder con IA, una regla editorial nueva. No se evaluó nada de eso aquí.
- **Aviso de doc:** en la página de permisos de Meta, la descripción de `instagram_business_manage_comments` es una copia de la de `content_publish` (error de la página). Los requisitos del screencast sí hablan de comentarios: mostrar crear, actualizar y borrar un comentario, en la app y en Instagram.

## 7. Qué se agrega para ofrecerlo a terceros (acceso avanzado) frente a solo cuentas propias

Lo ya verificado (nota principal §12 y §13) no se repite: acceso avanzado, App Review, verificación del negocio (14 días laborables), Access Verification (5 días), screencast por permiso, política de privacidad, callbacks de desautorización y eliminación. Lo nuevo de esta ronda:

| Tema | Solo cuentas propias | Terceros |
|---|---|---|
| Permisos básicos (`basic`, `content_publish`) | Acceso estándar, sin App Review, app en desarrollo | Acceso avanzado: App Review + verificación del negocio + Access Verification (ambos están en la lista de 34) |
| `instagram_business_manage_insights` | Acceso estándar, sin revisión (DOC de insights) | El anuncio de 2025 dice que se necesita acceso avanzado; la página de App Review **no lo lista** y Access Verification tampoco: si exige App Review propia y screencast: NO VERIFICADO (lo dirá el panel al agregar el permiso a la solicitud) |
| `instagram_business_manage_comments` | Acceso estándar | Acceso avanzado; está en la lista de App Review (screencast: crear, actualizar y borrar un comentario); no está en Access Verification |
| Nombre del permiso de publicación | `instagram_business_content_publish` (panel) | La página de App Review lo escribe `instagram_business_content_publishing` (con "ing"); ya anotado como NO VERIFICADO |
| Modo de la app | Desarrollo, indefinidamente (INFERENCIA fuerte) | Live |
| Visibilidad de lo publicado | **NO VERIFICADO** (sección 2.3) | Pública |
| Ampliar el caso de uso | No pasa nada | Cambiar la función de la app obliga a volver a enviarla (Platform Terms 3.a.vii, nota principal §13.1): sumar insights y comentarios después de aprobada exige otra revisión; conviene pedir de entrada los permisos que se van a usar |
| Cuentas | Operador y AgentPey con rol | Cada tercero conecta la suya; por cliente aislado (Platform Terms 5.b) |

- **Diseño recomendado (INFERENCIA):** si el plan es ofrecerlo a terceros, pedir juntos en la primera revisión los cuatro permisos que se usarán (`basic`, `content_publish`, `manage_insights`, `manage_comments`), no dos y luego otros.
- **Uso propio y uso a terceros pueden convivir** en la misma app: lo propio funciona con rol y acceso estándar; terceros, con acceso avanzado (nota principal §13.1).

## 8. Tipos de publicación por API que AgentSales aún no usa

Sección principal del encargo. Resumen y luego detalle. "Sin login declarado" significa que la página de referencia no dice a qué login aplica.

| Tipo o campo | ¿Con Instagram Login? | Parámetros y límites | Marca |
|---|---|---|---|
| Imagen suelta | Sí | `POST /<IG_ID>/media` con `image_url`, sin `media_type`; luego `media_publish` (JPEG, 8 MB, 4:5 a 1,91:1, 320 a 1440 px). Ya cubierto en la nota principal §4.1 | DOC |
| Video suelto en el feed (`media_type=VIDEO`) | La guía de Instagram Login lo lista junto a `REELS` y `STORIES`; la referencia de `IG User Media` ya no lista `VIDEO` entre los valores de `media_type` (solo `CAROUSEL`, `REELS`, `STORIES`) | Qué hace exactamente `VIDEO`: NO VERIFICADO. Usar `REELS` para todo video del feed | DOC contradictoria |
| Story de imagen | Sí | `media_type=STORIES` + `image_url`. JPEG, 8 MB, sRGB, 9:16 recomendada (no se da rango aceptable) | DOC |
| Story de video | Sí | `media_type=STORIES` + `video_url`. MOV o MP4, H.264/HEVC, AAC, 23 a 60 fps, ancho máx. 1920 px, proporción 0,1:1 a 10:1 (9:16 recomendada), 25 Mbps, **3 a 60 s, 100 MB**. Se acepta URL de video o de reel, no ambas | DOC |
| Stories: qué no se puede | Stickers de enlace, encuesta o ubicación: no se pueden publicar. `collaborators`, `alt_text`, `location_id` y encuestas: no soportados. Sí se puede mencionar usuarios sin sticker con `user_tags` (x e y opcionales; nota del 2025-07-09) | Vencen a las 24 h. La página de lectura de Stories dice que no se pueden actualizar ni borrar por esa vía. Sin sticker de enlace, una Story no puede llevar un enlace clicable | DOC |
| Carrusel mixto foto + video | **Sí** | Hasta 10 ítems, "images, videos, or a mix", mínimo 2 (nota principal §4.2). Hijo de video: contenedor con `video_url`, `media_type=VIDEO` e `is_carousel_item=true`. Los reels no pueden ser hijos. Las imágenes se recortan según la primera. Los hijos no llevan caption, `location_id` ni encuesta. Qué especificaciones de video valen para un hijo (¿las del reel?) y si aplica `user_tags` en hijos: NO VERIFICADO | DOC + NO VERIFICADO (parcial) |
| Reel con `cover_url` | Sí (sin login declarado) | `cover_url`: imagen JPEG pública, 8 MB, sRGB, 9:16 recomendada (si no, se recorta el 9:16 central; para el feed, el cuadrado central de 1:1). **Si se mandan `cover_url` y `thumb_offset`, gana `cover_url`.** Esto resuelve el NO VERIFICADO de la nota principal §4.3. `thumb_offset` por defecto: 0 ms | DOC |
| Reel con audio (música) | **No** | La Audio API (`GET /ig_audio`, `audio_configuration` con `audio_id`, `audio_volume`, `video_volume`) es **solo de Facebook Login** y exige Página vinculada. Con Instagram Login el audio es el que viene dentro del archivo de video. `audio_name`: nombre del audio original del reel (solo reels; se puede renombrar una vez) | DOC |
| Reel con audio: derechos | Un video con audio de terceros con derechos puede quedar sin `media_url` y marcarse con copyright; el contenedor expone `copyright_check_status` (`matches_found`, `status`) | Usar música propia o con licencia. Cómo se comporta Instagram al publicar por API un reel con música con derechos: NO VERIFICADO | DOC + NO VERIFICADO |
| Reel de prueba (`trial_params`) | Sí (la guía de Instagram Login lo lista) | `trial_params` con `graduation_strategy` obligatorio: `MANUAL` o `SS_PERFORMANCE`; solo `media_type=REELS`; se muestra solo a no seguidores al inicio. Novedad del 2025-12-03 | DOC |
| `alt_text` | Sí | Solo imágenes (suelta o hijo de carrusel), hasta 1.000 caracteres; no reels ni Stories. Agregado el 2025-03-24 | DOC |
| `collaborators` (collab) | **NO VERIFICADO** | Hasta 3 usuarios (la referencia de `IG User Media`); la página del edge de colaboradores dice hasta 5, otra incongruencia. Soportado en imagen del feed, reel y carrusel; no en Stories. La página no dice si el colaborador debe aceptar la invitación ni si debe ser público. El edge de lectura (`/collaborators`) y la API de invitaciones (`collaboration_invites`) son solo de Facebook Login. La página de subida reanudable (solo Facebook Login) lista `collaborators` para reels | DOC (sin login declarado) |
| `location_id` | **NO VERIFICADO** | "ID of a Page associated with a location": se obtiene con la Pages Search API (`GET https://graph.facebook.com/pages/search`, con el campo `location`). Eso es **Facebook Graph**, con token de usuario de Facebook o token de app con la función Page Public Metadata Access, no con un token de Instagram Login. No se admite en hijos de carrusel. Una Página sin datos de ubicación falla con `INSTAGRAM_PLATFORM_API__INVALID_LOCATION_ID`. **INFERENCIA:** sin Facebook Login no hay forma documentada de conseguir un ID válido; descartar la ubicación por ahora | DOC + INFERENCIA |
| `user_tags` (etiquetar usuarios) | Sin login declarado | Arreglo de objetos con `username` (público) y `x`, `y` (0,0 a 1,0 desde la esquina superior izquierda), obligatorios en imágenes y opcionales en Stories. Sirve para imágenes, videos y Stories. La publicación puede responder con `config_issue: USER_TAGGING_FAILURE` y aun así publicarse (en `media_publish`). Se notifica a los etiquetados; las menciones en caption cuentan dentro de 20 @ | DOC |
| `is_ai_generated` | Sí (ambos logins) | Ver nota principal §4.2 | DOC |
| Encuesta (`poll_attachment`), aviso de comentario (`is_comment_prompt_used`), colaboración pagada (`is_paid_partnership`, `branded_content_sponsor_ids`) | **No** | Solo Facebook Login | DOC |
| Etiquetas de producto y filtros | No | No soportado con Instagram Login | DOC |
| Publicación solo de texto | No | Instagram exige imagen o video en todo contenedor; no hay publicación de texto solo (en Threads, que es otra API, sí) | INFERENCIA (la doc no lo dice en una frase) |
| Subida reanudable de reel (plan B de la nota principal §4.5) | **Probablemente no** | La página de subida reanudable dice "disponible solo para apps con Facebook Login for Business" (host `rupload.facebook.com`, token de Facebook). La guía de Instagram Login, releída hoy, la lista como limitación de Facebook Login. La página "Upload Media" de Instagram Login que figura en el índice dio error 404 al leerla. **Corrige** a la nota principal §4.5: el plan B del reel por subida reanudable no está disponible con Instagram Login según la doc de hoy; queda `video_url` público | DOC (contradice la lectura de la nota principal, que quedó NO VERIFICADO) |

**Quién puede qué (cuentas):** la doc no distingue Empresa de Creador en ninguna fila (sección 2.1). Todo lo anterior se considera válido para las dos hasta que una prueba diga lo contrario.

**Cómo distinguir lo publicado:** una Story publicada informa `media_type` `IMAGE` o `VIDEO`, y un reel informa `VIDEO`; hay que mirar `media_product_type` para distinguirlos (DOC, guía de publicación). Con Instagram Login, la página de referencia de `IG Media` marca ese campo como de Facebook Login (NO VERIFICADO; el publisher de F3 ya lo pide, ver sección 5.2).

## 9. Pruebas propuestas para F9 (sin riesgo)

Orden de menor a mayor riesgo. Ninguna la corre Claude: las corre el operador con sus cuentas, primero en `dry-run`; todo lo que publica de verdad es solo con su autorización explícita en el chat y se borra a mano después.

1. **Visibilidad en modo desarrollo (la más importante):** publicar una imagen simple y neutra en la cuenta propia (@vicentewoldec o AgentPey), abrir su `permalink` desde una sesión sin rol (otro teléfono, otra cuenta o ventana privada) y ver si se ve y si aparece en el perfil y en el feed de un seguidor. Si no se ve: F9 debe incluir pasar la app a live y pedir acceso avanzado incluso para cuentas propias.
2. **Agregar AgentPey:** invitar como Instagram Tester, aceptar iniciando sesión como esa cuenta, Add account, token, `/me?fields=user_id,username,account_type`. Anotar `account_type`.
3. **Permisos nuevos:** ver si "Permisos y funciones" ofrece `instagram_business_manage_insights` y `instagram_business_manage_comments`; si el panel pide App Review para ellos; regenerar el token con los scopes y leer los permisos concedidos.
4. **`pnpm ig:smoke` ampliado (solo contenedor, sin publicar):** una imagen con `alt_text` y `user_tags`; una Story de imagen; un carrusel mixto (2 hijos: imagen y video) y un reel con `cover_url` y `thumb_offset` a la vez; un reel con `collaborators` y otro con `location_id` (esperado: error; anota el código).
5. **Cuota:** `content_publishing_limit` antes y después de publicar una imagen, una Story y un reel (¿cuenta cada uno 1?, ¿`quota_total` 50 o 100?).
6. **Insights y contadores:** sobre el post de la prueba 1, tras 1 hora y 48 horas: `GET /<MEDIA_ID>?fields=like_count,comments_count`, `GET /<MEDIA_ID>/insights?metric=reach,likes,comments,saved,shares,views,total_interactions`, y lo mismo sobre un carrusel (¿hay insights del padre?).
7. **Comentarios:** `GET /<MEDIA_ID>/comments` sobre la prueba 1 con el token con `manage_comments`; comentar desde otra cuenta; leerlo.
8. **Programación nativa (solo para cerrar la duda):** contenedor de imagen con `published=false` y `scheduled_publish_time`, sin `media_publish`. Esperado: error de parámetro. No usar en producción.

## 10. Correcciones que esta ronda hace a la nota principal

- **§4.3 (reel):** `cover_url` **sobrescribe** a `thumb_offset` si van ambos (DOC); ya no es NO VERIFICADO.
- **§4.5 (subida reanudable):** la doc de hoy la limita a Facebook Login for Business. El plan B del reel ya no existe con Instagram Login.
- **§5 (carrusel):** los videos mezclados con imágenes son oficiales; las especificaciones de video de un hijo siguen NO VERIFICADO.
- **§13.2 y esta nota 2.3:** "los datos creados en desarrollo solo los ven los usuarios con rol" puede afectar la visibilidad de los posts reales: pasa de dato curioso a riesgo de F9.
- **Permisos:** la lista de scopes de Business Login omite `instagram_business_manage_insights`, que las páginas de insights sí piden.

## 11. Preguntas abiertas que dependen del operador

1. ¿Se aprueba probar la visibilidad en modo desarrollo (prueba 1) con una publicación real y neutra en @vicentewoldec antes de definir F9?
2. ¿AgentPey es una cuenta de Instagram ya profesional (Empresa o Creador) y quién la administra?
3. ¿La cuenta personal del operador que se quiere usar es @vicentewoldec o es otra? Si es otra y es personal, hay que convertirla a profesional.
4. ¿F9 va a usar música? Con Instagram Login no hay selector de música por API; habría que subir el video con el audio ya incluido y con derechos.
5. ¿Se prefiere pedir desde ya `instagram_business_manage_insights` y `instagram_business_manage_comments` en la app (requiere agregarlos al caso de uso y reconectar las cuentas) o dejarlos para un paso posterior?

## 12. Fuentes (consultadas el 2026-10-19)

Oficiales de Meta:

- Publicación de contenido (general; login, `trial_params`, `alt_text`, carrusel mixto, límite de 100 y de 50, nota de programación): https://developers.facebook.com/documentation/instagram-platform/content-publishing.md
- Publicación con Instagram Login: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing
- Referencia `IG User Media` (parámetros, especificaciones de Stories, reel, imagen; `location_id`, `user_tags`, `collaborators`, `cover_url`, `audio_name`): https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media.md y https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
- `media_publish` (50 por 24 h, publicación parcial `config_issue`): https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media_publish.md
- `content_publishing_limit` (por cuenta, `quota_total` 50, sin mención de Stories): https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit.md
- Contenedor (`copyright_check_status`, 24 h): https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-container.md
- Subida reanudable (solo Facebook Login for Business): https://developers.facebook.com/documentation/instagram-platform/content-publishing/resumable-uploads.md
- Audio API (solo Facebook Login): https://developers.facebook.com/documentation/instagram-platform/content-publishing/audio-api.md
- Stories (lectura; no se editan ni se borran): https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/stories.md
- Compartir a Stories (intención en el celular; no es API de servidor): https://developers.facebook.com/documentation/instagram-platform/sharing-to-stories.md
- Colaboradores (edge solo Facebook Login; hasta 5): https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-media/collaborators.md
- Pages Search API (origen del `location_id`): https://developers.facebook.com/docs/pages-api/search-pages/
- Insights (guía): https://developers.facebook.com/documentation/instagram-platform/insights.md
- Insights de `IG Media` (métricas por tipo, 48 h, 2 años, Stories 24 h): https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights.md
- Insights de `IG User` (umbral de 100 seguidores, 90 días): https://developers.facebook.com/documentation/instagram-platform/api-reference/instagram-user/insights.md
- Anuncio de Meta de insights con Instagram Login (2025-03-24): https://developers.facebook.com/blog/post/2025/03/24/user-and-media-insights-on-instagram-api-with-instagram-login/
- `IG Media` (campos con Instagram Login, `like_count`, `comments_count`, `comment_enabled`): https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media.md
- Moderación de comentarios: https://developers.facebook.com/documentation/instagram-platform/comment-moderation.md
- Resumen de la plataforma (tipos de cuenta, permisos, acceso estándar y avanzado, límites): https://developers.facebook.com/documentation/instagram-platform/overview.md
- Instagram API con Instagram Login (funciones): https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login.md
- Business Login (acceso estándar, cuentas agregadas al App Dashboard, scopes): https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login.md
- Primeros pasos (Generate token): https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started.md
- Caso de uso de Instagram (Add account, Publish): https://developers.facebook.com/documentation/development/create-an-app/instagram-use-case.md
- Modos de la app: https://developers.facebook.com/documentation/development/build-and-test/app-modes.md
- App Review de Instagram (permisos con revisión, cuándo no hace falta): https://developers.facebook.com/documentation/instagram-platform/app-review.md
- Permisos de Meta (`instagram_business_*`, descripciones): https://developers.facebook.com/docs/permissions/
- Access Verification (34 permisos): https://developers.facebook.com/docs/development/release/access-verification
- Changelog de Instagram (2025-01-21, 2025-03-24, 2025-12-03, 2026-04-22, 2026-06-01, 2026-06-22, 2026-07-30): https://developers.facebook.com/documentation/instagram-platform/changelog.md
- Índice de la doc de Instagram (sección de programación vacía): https://developers.facebook.com/documentation/instagram-platform/llms.txt
- Páginas que dieron "no se pudo encontrar la página" (no existen o cambiaron de ruta): `.../instagram-api-with-instagram-login/upload-media.md` y `.../content-publishing.md` de esa ruta, `.../api-reference/instagram-user/media.md`, `.../api-reference/instagram-user/media-publish.md`.

Pistas no oficiales (nunca como fuente final):

- Programación con `scheduled_publish_time` en Instagram (afirmación aislada de un proveedor, contradicha por otros): https://posteverywhere.ai/blog/schedule-instagram-posts-api (contraste: https://postproxy.dev/how-to/schedule-instagram-stories/ y https://bundle.social/blog/instagram-graph-api)
- Fin de la Basic Display API y de las cuentas personales (2024-12-04): https://help.zapier.com/hc/en-us/articles/32429170578317-Instagram-app-deprecation-on-Dec-4-2024

## 13. Qué publica hoy AgentSales para posts (F9-T13, 2026-10-20)

**Prueba S1, primera parte hecha (2026-10-21, en el Mac con `PUBLISH_MODE=live` y la base de desarrollo; la hizo Claude con la autorización explícita del operador):** con el token de *Generate token* de `@vicentewoldec` (marca AgentPey), un post de imagen (JPEG 1080×1350, variante `ig_4x5`) se publicó de verdad por la API y quedó `published` con su `permalink` (`https://www.instagram.com/p/<código>/`). La cuenta dueña lo ve como una publicación normal (con «View insights» y «Boost post»). La tabla de `publications` lo muestra con formato `carrusel` aunque es una sola imagen (revisar la etiqueta). **Confirmado el mismo día por el operador:** otra persona, desde su teléfono y su propia cuenta de Instagram (sin rol en la app), vio el post.

**Estado de la prueba S1 (visibilidad en modo desarrollo, sección 2.3 y prueba 1 de la sección 9): PASADA (2026-10-21).** Lo que publica la API con la app en modo desarrollo lo ve una cuenta sin rol; los posts de marca pueden salir en `live` por Instagram (siempre con la instrucción del operador). El App Review de Meta sigue haciendo falta para que **otros** (corredores que no son evaluadores) conecten su cuenta, no para la visibilidad. Por decisión del operador (2026-10-20), F9-T13 se construyó contra simulaciones (msw), sin ninguna llamada a Meta. **S1 es obligatoria antes de cualquier publicación real de un post en Instagram**: hasta que el operador la haga y anote aquí el resultado, ningún post de marca sale en `live` por Instagram. Lo que S1 tiene que confirmar: que una publicación real y neutra hecha por la API en la cuenta propia (app en modo desarrollo) la ve una cuenta **sin rol** en la app (su `permalink`, el perfil y el feed de un seguidor). Si no la ve, los posts de Instagram esperan la aprobación de Meta (App Review, `docs/11-app-review-meta.md`) y el resto de las redes sigue.

Lo que el código publica de un post (`postPublicationPlan` en `packages/core/src/use-cases/open-publications.ts`, y el mismo publisher de los avisos, `packages/publishers/src/instagram/publisher.ts`):

| Tipo del post (`post.kind`) | Formato | Medios | Llamadas |
|---|---|---|---|
| `image` | `post` (imagen suelta) | El `ig_4x5` (1080×1350, JPEG) de la **primera** foto, aunque el post tenga más (la revisión lo advierte con `MEDIA_UNUSED`, sin impedir aprobar) | Un contenedor con `image_url` y `caption`, sin `media_type` |
| `carousel` | `post` (carrusel) | Los `ig_4x5` de **2 a 10** fotos, en su orden. Con menos de 2 procesadas no se abre (`CONTENT_NOT_READY`); fuera de 2 a 10 originales, la revisión del texto no lo aprueba (`MEDIA_REQUIREMENT`) | Un hijo por foto (`is_carousel_item`), sin caption; el carrusel con `children` y `caption` |
| `video` | `reel` | El `ig_reel` (9:16, de 3 a 90 s, **sin texto encima** en un post) del primer video | `media_type=REELS`, `video_url`, `thumb_offset=1000` (la portada es el cuadro del segundo 1, el mismo del `thumb` del panel) y `share_to_feed=true` |
| `text` | — | — | **No se publica en Instagram**: Instagram no publica solo texto (sección 8). La revisión del texto lo frena (`MEDIA_REQUIREMENT`), el plan no abre la publicación y el publisher rechaza un input sin medios (`NO_MEDIA`) |

- **Caption:** `instagramCaption`, el cuerpo y, tras una línea en blanco, los hashtags (hasta 2.200 caracteres y 30 hashtags, revisados al aprobar y otra vez en el publisher). Sin título.
- **Idiomas:** una marca con dos idiomas tiene un texto por idioma y, con eso, **dos publicaciones** de la misma cuenta, cada una con el caption de su idioma, que se programan por separado (la cadencia las espacia).
- **Cuota compartida:** el cupo (`content_publishing_limit`) es de la cuenta de Instagram (sección 3). Si un post y los avisos de un corredor salen por la misma cuenta, suman en el mismo contador; antes de crear contenedores el publisher consulta el cupo de esa cuenta y, sin cupo, la publicación del post se reprograma 6 h después (`IG_PUBLISH_LIMIT` con la señal de espera, hasta 3 veces seguidas), igual que la de un aviso. Otra cuenta (AgentPey) tiene su propio cupo.
- **Sin publicar dos veces:** el mismo progreso del contenedor de F3 (ADR-0014). Un medio que Instagram no pudo descargar (`IG_MEDIA_FETCH_FAILED`) se reintenta con un contenedor nuevo y URLs firmadas nuevas; un corte después de crear el contenedor retoma ese contenedor, y si ya estaba publicado busca el medio por caption y formato en vez de pedir otro `media_publish`.
- **Fuera de F9-T13 (sección 8, sin usar todavía):** carrusel mixto foto + video, `cover_url` del reel (está documentado, pero sin login declarado), `alt_text`, Stories, `collaborators`, `user_tags` e `is_ai_generated`.
- **Contratos:** `packages/publishers/src/instagram/post.test.ts` (los tres formatos, dos idiomas, la cuota compartida con un aviso, otra cuenta con su propio cupo, el error de descarga y dos cortes). Ningún test llama a Meta.
