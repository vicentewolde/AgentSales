# Spec F9 · Contenido de marca

- **Estado:** **Aprobado** el 2026-10-19 por el operador (revisado por el `arquitecto`; P1 a P6 respondidas; tres entregas, ejecución en paralelo y la decisión de arquitectura D19)
- **Rama base:** `main`, con F8 cerrada (`v1.0.0`)
- **Tag al cerrar:** `v1.1.0` (entrega 1), `v1.2.0` (entrega 2) y `v1.3.0` (entrega 3, cierre de la fase)
- **Referencias:** `docs/00-vision.md`, ADR-0006, ADR-0013, ADR-0014, ADR-0015, ADR-0017, ADR-0018, ADR-0019, ADR-0021 a ADR-0023, ADR-0025, ADR-0027, ADR-0029 y ADR-0030 (nuevos), `docs/01-arquitectura.md`, `docs/02-modelo-datos.md`, `docs/04-formato-publicaciones.md`, `docs/10-despliegue.md`, `docs/11-app-review-meta.md`, `docs/integraciones/meta-verificacion-empresa.md`, ADR-0028 (el corredor conecta su Instagram, F8), y las notas de integración nuevas: `docs/integraciones/x.md`, `linkedin.md`, `discord.md`, `tiktok.md`, `instagram-contenido-propio.md`, `meta-ads.md` y `manychat.md` (2026-10-19)

## 1. Objetivo
AgentSales deja de ser solo para avisos: el operador gestiona su contenido de marca (su marca personal y AgentPey) en **Instagram, X, LinkedIn y Discord** desde el mismo panel y la misma CLI. Define el perfil editorial de cada marca, **le pide a la IA un plan de ideas y fechas**, acepta lo que sirve, la IA redacta el texto de cada red, él aprueba y programa, y el sistema publica con el mismo calendario, reintentos y seguimiento que ya tienen los avisos. La IA propone; **nada se publica sin que el operador lo apruebe** (ADR-0030). Queda preparado, sin construirlo, para el piloto con una oficina de una corredora grande (anuncios de Meta, leads y ManyChat) y para ofrecerlo después a otras marcas (§4.17).

## 2. Alcance
- **Posts como sujeto de publicación** (ADR-0029): tabla `posts` y el sujeto genérico en textos, corridas, publicaciones y medios, sin cambiar el comportamiento de los avisos.
- **Marcas:** `brokers.kind` (`broker` | `brand`) y el **perfil editorial** de cada marca: idiomas, público, líneas de contenido, hechos que la IA puede afirmar, cosas que evitar y cadencia por red.
- **Dos idiomas** (P4): cada texto de un post tiene su idioma; una marca puede publicar en español, en inglés o en los dos.
- **Posts manuales:** crear un post con tema o borrador, subir imágenes o video directo a R2 (ADR-0025), pedir los textos por red a la IA, editarlos, aprobar, programar y publicar.
- **Cinco redes** (§4.6): Instagram (imagen, carrusel y reel de un post), Discord (webhook de canal), LinkedIn (perfil personal, **a mano** por defecto), X (texto con hasta 4 imágenes o 1 video) y TikTok (video como **borrador** en la bandeja del creador).
- **Resultado dudoso:** un estado nuevo, `outcome_unknown`, para cuando una red pudo haber publicado y no se sabe (§4.6).
- **La IA propone** (ADR-0030): un plan de ideas con fecha sugerida para un período; el operador acepta, edita o descarta cada idea; al aceptar, se redactan los textos.
- **Verificaciones por red** antes de aprobar: largo, escape de caracteres, menciones masivas, enlaces en X, datos que no están en el perfil.
- **Panel y CLI:** Contenido (lista, editor por red con conteo de caracteres, medios), Plan (ideas), calendario semanal que mezcla posts y avisos, y la CLI `post`, `plan` y `brand`.
- **Pruebas de entrada** (§4.8) con las cuentas reales, que hace el operador: desde el 2026-10-20, verificación obligatoria antes de publicar de verdad en cada red, no antes de construir.
- **Costos y topes:** gasto de IA por marca (tope de F7, ahora también con posts y planes) y el costo de X anotado por publicación.

## 3. Fuera de alcance
- **Terceros** (cobro, planes, otras marcas con sus propias cuentas): el diseño no lo impide (el alcance por marca ya existe, ADR-0022), pero cada red pide aprobaciones propias (App Review de Meta, Community Management de LinkedIn, el caso de uso en X). Después de F9.
- **Métricas y aprender de lo que funcionó**, y leer o responder comentarios y mensajes: la siguiente fase del producto (`docs/00-vision.md`).
- **Stories, música, encuestas, colaboraciones y ubicación en Instagram** (no disponibles con Instagram Login, o sin forma documentada de obtener el dato: `instagram-contenido-propio.md` §2).
- **Hilos en X**, hasta probar que responderse a uno mismo está permitido (§4.8); **documentos PDF, encuestas y artículos en LinkedIn**; **foros, etiquetas y Crosspost en Discord**; el bot de Discord.
- **La página de empresa de LinkedIn de AgentPey** por API (pide Community Management API: `linkedin.md` §2); entra cuando exista la aprobación y la organización.
- **Imágenes generadas por IA, tarjetas de texto y edición de video:** el post usa los medios que sube el operador.
- **Publicar sin aprobar** (`auto_publish`) en posts, y la IA buscando noticias o tendencias en internet (ADR-0030).
- Un **navegador automatizado** en LinkedIn, X o Instagram: no se usa (sus términos sancionan la automatización fuera de la API).
- **Anuncios pagados en Meta, leads, ManyChat y TikTok público con fotos** (el piloto con una oficina, F10), y **organizaciones** (franquicia: organización → oficina → agente, F11): ver §4.17. F9 no lleva código de anuncios, pero no cierra puertas para ellos.

## 4. Diseño

### 4.1 Componentes afectados
- `packages/core`: `Subject` (aviso o post), `posts`, perfil editorial, planes, prompts y verificaciones de redes (`social/`), puertos `PostRepository`, `PostLock`, `EditorialProfileRepository`, `PlanRunRepository`, `PostUploadRepository`; los casos de uso de publicar, aprobar, programar, vigilar y cancelar pasan a trabajar sobre un sujeto. Los que dan por hecho el aviso (y que T05 a T08 revisan uno por uno): `approve-content`, `unapprove-content`, `edit-content`, `open-publications`, `request-content-run`, `publish-listing`, `publication-start`, `start-publication`, `publish-publication`, `confirm-manual-publication`, `cancel-publication`, `retire-publication`, `schedule-publications`, `start-due-publications`, `resume-auto-publish`, `refresh-account-tokens`, `ensure-access-token`, `publish/input.ts` (los medios se buscan por aviso y, fuera de Instagram, solo se envía `body`: los hashtags de LinkedIn y X se pierden), `content/locked-content.ts`, `content/media-keys.ts` (las claves de R2 se arman por aviso), `tracking/agenda.ts` y `tracking/row.ts`.
- `packages/db`: esquema y migraciones (§4.11), repositorios nuevos y los existentes con sujeto (`sumLlmCost` en `content-runs.ts` cruza con `listings`).
- `packages/publishers`: `discord`, `linkedin`, `x`, `tiktok` (subrutas propias, como `marketplace`) y la parte de Instagram que arma el input desde un post.
- `packages/config`: `redactText` reconoce las URL de webhook de Discord y los `Bearer` genéricos.
- `apps/api` (rutas de posts, planes, perfil y OAuth; `app.ts` resuelve el dueño de un recurso por el aviso y ahora también por el post; `request-context.ts` anota al usuario en la bitácora también con `PostLock`), `apps/worker` (jobs `post.draft` y `content.plan`; `content.prepare`, `requeueQueuedContentRuns` y `resumeCutAutoPublish` ignoran las corridas de posts), `apps/cli`, `apps/web`.

### 4.2 El post como sujeto (ADR-0029)
```
Subject = { kind: "listing" | "post", id }
posts ── contents (post_id, language) ── publications (post_id, language) ── publication_events
      └─ media (post_id)                  └─ platform_accounts (de la marca)
content_runs (post_id): la corrida de textos de un post (una activa por post)
```
Reglas de core, como predicados y **no** como `CHECK` de la base (para poder relajarlas): un aviso solo cuelga de un `Broker` con `kind = broker`; un post puede colgar de **cualquier** corredor o marca (una oficina que publica avisos y contenido de marca usa el mismo corredor); `auto_publish` no se aplica a los posts; un post nunca pasa a `active` ni se cierra por venta. El código nuevo no compara ids a mano: usa siempre `scopeOf`, `inScope` y `can` (`access.ts`, `permissions.ts`), así el alcance por conjunto de la fase de organizaciones se cambia en un solo lugar.

Un post tiene un estado propio:

| Estado | Significa |
|---|---|
| `idea` | Propuesta de la IA, sin textos. Se acepta, se edita o se descarta |
| `draft` | Aceptado o creado a mano; los textos se están redactando o editando |
| `ready` | Al menos un texto aprobado (las publicaciones nacen de ahí, como en ADR-0014) |
| `archived` | Descartado o terminado; no se programa |

Reglas de los posts (F9-T10): un post archivado no se edita ni recibe medios (`POST_ARCHIVED`, 409); un post con publicaciones pendientes (`PENDING_PUBLICATION_STATUSES`) no se archiva hasta cancelarlas o resolverlas (`POST_HAS_PENDING_PUBLICATIONS`, 409); un post tiene hasta 20 medios, contando las subidas pendientes. Desde F9-T21, sus redes (`posts.platforms`) mandan al aprobar, publicar y programar (`POST_PLATFORM_EXCLUDED`; el texto aprobado se revisa antes: una red quitada, pedida a mano y sin texto aprobado da `CONTENT_NOT_APPROVED`) y una red con publicaciones pendientes no se le quita (`POST_HAS_PENDING_PUBLICATIONS`, 409, con sus ids: primero se cancelan o resuelven).

El estado de la publicación de cada red es el de ADR-0014 más `outcome_unknown` (§4.6), con la misma bitácora. La agenda y el seguimiento (F6) muestran posts y avisos juntos, con el tema del post como título.

### 4.3 Marcas y perfil editorial
- `brokers.kind`: `broker` (hoy) o `brand`. El panel esconde Propiedades, Importar y las plataformas de avisos en una `brand`, y muestra Contenido y Plan. Una marca nueva se crea con `agentsales brokers create --kind brand`. `kind` solo dice qué ve el panel; podrá sumar valores (`org`, `office`) con `ALTER TYPE … ADD VALUE` y **no decide permisos**.
- **Marcas del operador:** "Vinny" (marca personal) y "AgentPey", cada una con sus cuentas (ADR-0029, punto 7), `operator_owned = true`.
- **Perfil editorial** (`editorial_profiles`, uno por marca):

| Campo | Qué es |
|---|---|
| `languages` | `["es"]`, `["en"]` o `["es", "en"]`: los idiomas en que publica la marca. La primera es la principal |
| `audience` | A quién le habla, en una o dos frases |
| `pillars` | Líneas de contenido: `{ key, name, description, weight }` (por ejemplo "Lo que aprendo construyendo", "Producto", "Bastidores") |
| `facts` | **Lista de hechos que la IA puede afirmar** (una frase cada uno). Lo que no está aquí no se afirma |
| `avoid` | Temas, palabras o promesas que no se usan |
| `cadence` | Cuántos posts por semana en cada red, los días y horas preferidos (hora de Chile) y las horas de espacio entre un idioma y el otro (por defecto 6) |
| `defaultHashtags` | Se suman a `brokers.fixed_hashtags` de la marca (que ya existe) |

El tono sigue siendo `brokers.tone`. La IA recibe el perfil y el brief del post; **nunca** `internal_notes` ni nada de otras marcas. Un brief que escribió la IA no cuenta como fuente de hechos (`posts.brief_origin`, ADR-0030).

### 4.4 El texto por red
Un post tiene **un texto por red y por idioma** (`contents` con `post_id` y `language`), como un aviso tiene uno por canal. A diferencia de los avisos, la IA escribe el texto completo (modifica ADR-0013 punto 1 para posts, ADR-0030), validado con zod y con la versión `SOCIAL_PROMPT_VERSION`, y luego pasa por las verificaciones de la red. Prompts en `packages/core/src/social/` y reglas en `docs/04-formato-publicaciones.md`. El texto sale con los hashtags dentro cuando la red no los separa (LinkedIn y X): una función por red arma lo que se envía (`socialCaption`), en vez de enviar solo `body`.

| Red | Largo | Reglas propias |
|---|---|---|
| Instagram | 2.200 caracteres y hasta 30 hashtags (ya verificado) | Los hashtags van aparte (`instagramCaption`). Imagen, carrusel (2 a 10) o reel |
| X | 280 caracteres ponderados (URL = 23, emoji = 2) | Un enlace se permite si el operador lo marca; ese post cuesta US$0,20 en vez de US$0,015 y el editor lo avisa (`x.md` §2). Sin hilos (§3) |
| LinkedIn | 3.000 caracteres | El campo `commentary` exige escapar `\| { } @ [ ] ( ) < > # \ * _ ~` (`linkedin.md` §5): una función de escape probada, y los hashtags escritos como texto |
| Discord | 2.000 caracteres (embeds fuera de F9) | `allowed_mentions: { parse: [] }` siempre y `@everyone`/`@here` neutralizados en el texto (`discord.md` §4) |

Verificaciones comunes (`checkPostContent`): largo, caracteres reservados, menciones masivas, **cifras, nombres propios y enlaces que no estén en el perfil o en un brief escrito por el operador**, y requisitos de medios (un reel exige video; X, hasta 4 imágenes o 1 video).

**Dos idiomas (P4):** si la marca tiene dos idiomas, el borrador crea un texto por idioma en cada red. Cada texto se aprueba y se publica por separado, como publicaciones distintas de la misma cuenta, espaciadas por la cadencia. Respondido (P4): son publicaciones separadas, espaciadas por la cadencia (6 h por defecto).

### 4.5 Los medios de un post
- Subida directa a R2 con URL prefirmada (ADR-0025), por la misma ruta de la API y del panel que las cargas: `POST /api/posts/:id/uploads` y `…/uploads/complete`. El registro de lo pendiente vive en `post_uploads` (la tabla de cargas, `import_runs`, es de planillas); un trabajo periódico borra de R2 lo abandonado, como la limpieza de las cargas. Imágenes (JPEG, PNG, WebP, HEIC) y videos (MP4, MOV), con los topes de la carga. Las claves de R2 de un post van bajo `posts/{postId}/…`.
- El worker procesa lo subido con el pipeline existente (`MediaProcessor`): variantes `ig_4x5` y `thumb`, y el reel 9:16 con tope de 90 s. Para X se agrega una variante de video reducida (la doc fija un máximo de 1280×1024: NO VERIFICADO, `x.md` §5), y para Discord un video bajo 20 MiB o, si no cabe, solo un enlace (D8). **Así quedó en F9-T14:** Discord no tiene variante propia; su publicación fija la más liviana del video entre `x_video` (720p, 8 Mbps como mucho) e `ig_reel`, y el publisher la adjunta si pesa hasta 20 MiB. Si no cabe, no se adjunta y, como hoy no hay un enlace al video que no exponga una URL firmada de larga vida (R2 no tiene un dominio público), se publica **solo el texto** con una nota en la bitácora; el enlace estable queda pendiente (un dominio público de medios, después de S5).
- Cada publicación fija los medios (`media_ids`) al nacer, como en ADR-0014.

### 4.6 Las cuatro redes

| | Instagram | Discord | LinkedIn | X |
|---|---|---|---|---|
| Cuenta | Profesional (Empresa o Creador), la del operador y la de AgentPey | Un webhook de canal; la URL es el secreto | Perfil personal; la página de empresa, después | Una cuenta con app propia |
| Conexión | Como hoy (token de la app o OAuth de F8) | `accounts connect discord --webhook-stdin` (la URL va cifrada) | OAuth 2.0; token de 60 días **sin refresco**: se reconecta cada dos meses | OAuth 2.0 con PKCE; token de 2 h que se renueva al publicar |
| Modo | Siempre por API | Siempre por API | **`manual` por defecto** (P1); `api` cuando LinkedIn aclare su término | Siempre por API |
| Qué publica | Imagen, carrusel, reel | Texto y hasta 10 archivos de 20 MiB | Texto, imagen, varias imágenes, video | Texto con 4 imágenes o 1 video |
| Medios | URL firmada de R2 (ya probado) | Se suben los bytes | Se suben los bytes | Se suben los bytes (por partes) |
| Programar | Calendario propio (la API no programa) | Calendario propio | Calendario propio en modo `api`; en `manual`, a la hora programada el reloj la deja lista para publicar a mano (`awaiting_manual_confirm`, sin llamar a la red): ese es el recordatorio | Calendario propio |
| Borrar | A mano | Con el webhook | `DELETE` | `DELETE` |
| Idempotencia | Progreso del contenedor (F3) | **Ninguna:** ante un corte justo al enviar queda `outcome_unknown` | URN del post | X rechaza el texto repetido (403, NO VERIFICADO): se trata como `outcome_unknown`, no como "ya publicado" |
| Costo | Gratis | Gratis | Gratis | Pago por uso: US$0,015 por post; US$0,20 con enlace |
| Riesgo | Datos de modo desarrollo invisibles al público (§4.8) | Bajo | Términos que prohíben "automatizar publicaciones" (§4.8, D5) | Costo, suspensión por automatización, reglas de IA |

Todas respetan `PUBLISH_MODE` y el `dry-run` de la publicación (ADR-0016): en `dry-run` no se escribe nada en la red; lo único que puede leerse es la cuenta propia. Contratos con `msw` o fakes; ningún test llama a las APIs reales.

**TikTok (D16, `docs/integraciones/tiktok.md`).** En F9, solo **video como borrador**: Content Posting API en modo *Upload* (permiso `video.upload`). El worker sube el video por partes desde R2 (`FILE_UPLOAD`, trozos de 5 a 64 MB) y llega a la bandeja del creador; el operador lo termina y publica en la app, así que la publicación queda en `awaiting_manual_confirm` hasta que pega el enlace o la marca como publicada. Según tres blogs de terceros no exige la auditoría de TikTok (NO VERIFICADO: prueba S6). Quedan para el piloto: publicar directo en público (*Direct Post*: auditoría de semanas, y puede rechazarse mientras la app solo sirva a las cuentas del operador), fotos y carruseles (solo por URL de un dominio propio verificado en DNS) y el compositor con las etiquetas de contenido comercial y de IA que TikTok exige. Cuentas: las personales del operador (por probar si pueden autorizar la API). OAuth: token de 24 h y refresco de 365 días que puede rotar. No hay borrado por API.

**Resultado dudoso (ADR-0029, punto 8):** `outcome_unknown` es un estado pendiente que cuenta como activo. El publisher guarda en su progreso "enviando" antes de la llamada que publica; un intento que encuentra ese progreso sin resultado (corte, reinicio del worker, reencolado de las `publishing` al arrancar o por la vigilancia) **no reintenta**: devuelve `OUTCOME_UNKNOWN` (no reintentable) y core pasa la publicación a `outcome_unknown`. El operador la resuelve en un paso, "salió" (con el enlace si lo tiene) o "no salió" (queda `failed` y se puede volver a intentar). La agenda lo muestra con su propia clase.

**Traspaso a mano por cuenta (ADR-0029, punto 9):** una cuenta con `meta.mode = manual` no llama a la red: la publicación pasa a `awaiting_manual_confirm` con el texto y los medios listos, y el operador confirma con el enlace (o marca que no salió). Hoy solo Marketplace lo hace y está atado a su precio, su URL y el candado del aviso; T06 lo generaliza.

### 4.7 Cuentas, secretos y vencimientos
- Las credenciales siguen cifradas en `platform_accounts.credentials_encrypted` (AES-256-GCM con la AAD de siempre), ahora con una **unión por plataforma**: Instagram y LinkedIn, `{ accessToken }`; X y TikTok, `{ accessToken, refreshToken }`; Discord, `{ webhookUrl }`. La unión admite también un token que **no vence** (un campo explícito, porque `token_expires_at = null` ya significa «desconocido»), que necesitará el piloto con un token de system user de Meta (§4.17).
- `token_expires_at`: LinkedIn vence a los 60 días y **no se puede renovar solo**, así que la agenda suma una clase "token por vencer" (7 días antes) para las cuentas que no se renuevan; el "por vencer" de hoy es el de Portal (`tracking/agenda.ts`). X se renueva con el refresh token, que se supone que rota (NO VERIFICADO, `x.md` §3): `ensureAccessToken` (ADR-0015) lo hace antes de cada intento con el candado de credenciales, y X entra al job `tokens.refresh`.
- **OAuth de LinkedIn y X:** el `state` va firmado con la plataforma y la marca, en una cookie `__Host-` como la de Mercado Libre, y es de un solo uso (`oauth_states_used`). El `code_verifier` de PKCE de X vive en esa misma cookie firmada, nunca en la base ni en la URL. Las rutas `/oauth/*` van fuera del CSRF, como las de Meta. Como en Instagram (ADR-0028), cada plataforma suma su permiso de conexión (`linkedin.connect`, `x.connect`, `tiktok.connect`) para que el corredor o la marca conecte la suya; renovar y desconectar siguen siendo del administrador.
- `meta` por plataforma con su esquema zod, como Instagram y Mercado Libre. LinkedIn suma `mode` (`api` | `manual`); X suma `spendLimitUsd`.
- Los secretos nunca van a logs ni a la bitácora: `redactText` reconoce la URL del webhook de Discord (`discord.com/api/webhooks/<id>/<token>`) y los `Bearer`, antes de que exista el primer publisher nuevo (T02).

### 4.8 Pruebas de entrada (las hace el operador; ninguna bloquea construir: todas son verificación obligatoria antes de publicar de verdad)
**Ninguna prueba bloquea construir** (decisiones del operador del 2026-10-20): S1 (Instagram) y S5 (Discord) para T13 y T14, y después S2 y S3 (LinkedIn), S4 (X) y S6 (TikTok) para T15, T16 y T26. Todo se construye contra simulaciones (`msw`), y cada prueba es una **verificación obligatoria antes de cualquier publicación real** en esa red; si falla, se ajusta el código (o el modo de la cuenta) antes de publicar. En LinkedIn, además, la cuenta nace en modo `manual` (D5) y solo pasa a `api` con S2 y S3 resueltas. Se hacen **a mano**, con la consola o el generador de tokens de cada plataforma y los comandos de la sección 8 de su nota de integración; no necesitan el código de la aplicación. Cada una responde un NO VERIFICADO que decide el diseño. Después, cada publisher trae su propio `pnpm social:smoke --platform …` (que sí publica de verdad y por eso se declara en `CLAUDE.md` como `ml:test-user`, solo para el operador, en cuentas o servidores de prueba y con su instrucción en el chat).

| # | Prueba | Si falla |
|---|---|---|
| S1 | **Instagram:** una publicación real y neutra en una cuenta profesional propia, vista desde una cuenta **sin rol** en la app (modo desarrollo) | Los seguidores no ven lo publicado: Instagram espera la aprobación de Meta (el App Review aún no está enviado: verificación del negocio con Certilink SpA, proveedor técnico y revisión, unas 5 semanas sin rechazos; `docs/11-app-review-meta.md`). El resto de las redes sigue |
| S2 | **LinkedIn:** el token de "Share on LinkedIn" publica en `/rest/posts` (perfil personal) | Se pide `w_member_social` por otro producto, o LinkedIn queda siempre a mano |
| S3 | **LinkedIn:** respuesta de LinkedIn Developer Support sobre el §3.1(26) de sus términos (¿un calendario propio cuenta como "automatizar publicaciones"?) | LinkedIn queda siempre en modo `manual` |
| S4 | **X:** crear un post, ver el saldo descontado, un reply a uno mismo, el rechazo de texto repetido y si un 4xx cobra | Sin hilos; el costo real se ajusta en `x.md` |
| S5 | **Discord:** un webhook de prueba con texto, imagen y un video, en un servidor privado | Se ajusta la variante de video (D8) |
| S6 | **TikTok:** crear la app con tu cuenta de Chile, autorizar una cuenta personal con `video.upload`, subir un video de R2 y ver el borrador en la bandeja; ver si acepta un redirect `https://localhost` y si el refresh rota | Si una cuenta personal no puede autorizar, se prueba una Creator o Business; si el borrador no llega sin auditoría, TikTok pasa al piloto |

### 4.9 La IA propone (ADR-0030)
```
panel o CLI (plan) → requestPlanRun (core): período (por defecto, las próximas 2 semanas), redes y cuántas ideas
  → plan_run en queued y, ya confirmado, se encola content.plan
  → el worker: brief = perfil editorial + temas de los últimos 60 días + ideas descartadas
    → IA (JSON validado con zod): lista de ideas { tema, línea, redes, formato, fecha y hora sugeridas, porqué }
    → verificaciones (fechas dentro del período y de la cadencia, líneas que existen, sin hechos nuevos)
    → cada idea queda como post en estado idea (source = ai, brief_origin = ai, plan_run_id)
  → plan_run en succeeded o failed, con el gasto de IA anotado
operador: acepta (→ draft y se encola post.draft), edita el brief, mueve la fecha o descarta
post.draft → la IA redacta el texto de cada idioma de las redes sugeridas de la idea que sirven al formato → verificaciones → contents en draft
operador: revisa, edita, aprueba y programa (o publica)
```
Una idea sin aceptar no gasta IA en textos ni tiene publicaciones: no se programa ni ocupa un horario del calendario de publicación. Mientras no se descarte, sí cuenta en los posts por semana de la cadencia cuando se pide otro plan que cubre su fecha (`plannedSlots`), para que dos planes no llenen dos veces la misma semana; descartarla, o moverla fuera del período, libera ese cupo. `auto_publish` no aplica (ADR-0030, punto 4).

### 4.10 Contratos (API, ADR-0011; todo bajo `/api` con sesión y alcance por marca)
- `GET/PUT /api/brokers/:id/editorial-profile`.
- `GET /api/posts` (`brokerId`, `status`, `from`, `to`); `POST /api/posts`; `GET/PATCH /api/posts/:id`; `POST /api/posts/:id/archive`.
- `POST /api/posts/:id/uploads` y `…/uploads/complete` (medios, ADR-0025).
- `POST /api/posts/:id/draft` (pide los textos); `PATCH /api/posts/:id/contents/:platform/:language` (edita); `POST …/approve` y `…/unapprove`.
- `POST /api/posts/:id/publish` y `/schedule` (como los avisos); `POST /api/publications/:id/resolve` (`outcome_unknown`: `{ outcome: "published" | "not_published", url? }`) y `…/confirm` para el modo `manual`.
- `POST /api/plans` (pedir un plan); `GET /api/plans?brokerId` (los planes de una marca, `listPlanRuns`); `GET /api/plans/:id`; `POST /api/posts/:id/accept` y `/discard` (ideas).
- `GET /oauth/linkedin/start|callback` y `GET /oauth/x/start|callback`.
- Permisos (ADR-0022): `posts.manage`, y cada ruta nueva entra a la tabla de permisos; un test la revisa. Un corredor ve solo los posts de su marca; el administrador ve todos.
- CLI: `post create|list|show|draft|edit|approve|publish|schedule|archive`, `plan [--days 14] [--platform …]`, `plan show <id>`, `plan list` (F9-T21), `post accept|discard <id>`, `post edit --platforms|--date|--brief` (F9-T21), `brand show|edit` (perfil editorial), `publications resolve <id> --published|--not-published`, `accounts connect linkedin|x|discord`.

### 4.11 Datos
Migraciones desde la `0014` (o la siguiente libre). Reglas: **`ALTER TYPE … ADD VALUE` para todo valor nuevo de un enum** (nunca recrear el tipo: la `0006` se detiene si la tabla tiene filas), y ninguna migración usa en la misma transacción un valor recién agregado.
- `platform` suma `x`, `linkedin`, `discord` y `tiktok`; `publication_status` suma `outcome_unknown`.
- `brokers.kind` enum nuevo (`broker` default, `brand`).
- `editorial_profiles` (`broker_id` PK/FK, `languages` text[], `audience`, `pillars` jsonb, `facts` text[], `avoid` text[], `cadence` jsonb, `default_hashtags` text[], timestamps).
- `posts` (`id`, `broker_id`, `topic`, `brief`, `brief_origin` `operator|ai`, `kind` `text|image|carousel|video`, `status`, `source` `manual|ai`, `pillar` null, `planned_at` null, `plan_run_id` FK null, `created_by`, `rationale` null, timestamps). Índice `(broker_id, status, planned_at)`. Desde F9-T20 (migración `0018`), `platforms` text[] null: las redes del post (las de una idea; `null` = todas las de la marca).
- `plan_runs` (`id`, `broker_id`, `period_start`, `period_end`, `status`, `request` jsonb, `report` jsonb, `llm_*` como `content_runs`, timestamps): **se crea junto con `posts`** (T03) porque `posts.plan_run_id` la referencia; la lógica llega en T20, con un índice único parcial: un plan activo (`queued` o `running`) por marca.
- `contents`, `content_runs`, `publications`: `post_id` null, `listing_id` null y `CHECK (num_nonnulls(listing_id, post_id) = 1)`. `contents` y `publications` suman `language` (`es` por defecto: lo existente es español). Únicos: una publicación activa por `(post_id, platform_account_id, format, language)` y la actual por aviso; una corrida activa por post; `contents` único por `(content_run_id, platform, language)`. `publications` suma `cost_usd numeric(10,4)` null (el costo estimado, hoy solo X; suma mensual por cuenta para `spendLimitUsd`). `publications.listing_source_hash` ya es nulo. Los `NOT NULL` que se quitan son solo de metadatos y el `CHECK` es válido sobre los datos de hoy (todas las filas tienen `listing_id`).
- Índices nuevos: `(post_id)` en `publications`, `(post_id, platform, created_at)` en `contents`, `(post_id, created_at)` en `content_runs`.
- `media`: `post_id` null y `CHECK (num_nonnulls(listing_id, post_id) <= 1)`; único `(post_id, checksum) WHERE role = 'original'`.
- `post_uploads` (subidas pendientes de un post: `id`, `post_id`, `object_path`, `expected_bytes`, `status`, `expires_at`).
- Seeds idempotentes: las dos marcas del operador (sin cuentas) y sus perfiles editoriales vacíos, que el operador llena.
- **Borrado de Meta (ADR-0027):** no cambia. `eraseInstagramUser` ya filtra por cuenta e incluye las publicaciones de posts en esa cuenta; `posts` y `contents` son textos del operador y también alimentan X y LinkedIn, así que no se borran. T03 suma un test que lo fija.

### 4.12 Costos
- **IA:** el plan y los textos van por `LLMProvider` y se anotan por marca (F7); en el servidor, la API de Anthropic con el tope mensual. `sumLlmCost` cuenta las corridas de avisos, las de posts y los planes (T11 y T20). Con dos idiomas, un post cuesta el doble de textos. Un plan de 10 ideas más sus textos es del orden de centavos de dólar (a medir en T22: la estimación, unos US$ 0,12 con Sonnet 5.5 en dos idiomas, está en `docs/integraciones/anthropic-api.md` §13; la medición con la API la corre el operador).
- **X:** pago por uso con créditos prepagados. El sistema anota el costo estimado de cada publicación en `cost_usd` (US$0,015; US$0,20 con enlace) y respeta `spendLimitUsd` de la cuenta (por defecto **US$10 al mes**, P2): pasado el límite, la publicación queda `failed` con la causa. El tope duro está en la consola de X.
- Instagram, LinkedIn y Discord no cobran.

### 4.13 Seguridad y reglas
- Se mantienen todas las reglas de seguridad de `CLAUDE.md`: `dry-run` por defecto, nunca `live` sin instrucción del operador, ningún test llama APIs reales, nada de secretos en logs.
- `pnpm social:smoke` y las pruebas de entrada publican de verdad en una cuenta propia: se agregan a `CLAUDE.md` junto a `ml:test-user` (solo las corre el operador; T01).
- Sin navegador automatizado en estas redes (§3).
- El texto de la IA nunca sale con `@everyone`/`@here`, ni con menciones que no estén en el brief del operador.
- Permisos y reglas de sujeto: §4.2 y §4.10.

### 4.14 Decisiones
| # | Decisión | Estado |
|---|---|---|
| D1 | Una marca es un `Broker` con `kind = brand`; un post cuelga de cualquier corredor y un aviso solo de `kind = broker` (predicado de core, ADR-0029) | Tomada |
| D2 | El post es otro sujeto de publicación, con `CHECK` de uno solo (ADR-0029) | Tomada |
| D3 | Se mantiene una cuenta conectada por marca y plataforma: el perfil personal y AgentPey son dos marcas | Tomada |
| D4 | Los idiomas son del perfil de la marca y cada texto tiene el suyo; con dos idiomas salen dos publicaciones separadas, espaciadas por la cadencia | **Respondida (P4)** |
| D5 | LinkedIn: perfil personal, cuenta en modo `manual`; pasa a `api` solo si LinkedIn aclara su término (S3) | **Respondida (P1)** |
| D6 | X: enlaces permitidos y marcados (cuestan más), sin hilos, tope por defecto de US$10 al mes; en `dry-run` no se escribe | **Respondida (P2)** |
| D7 | Discord: webhook de canal, sin bot, sin foros ni embeds | Tomada |
| D8 | Discord y videos: variante bajo 20 MiB si cabe; si no, un enlace al video (F9-T14: mientras no haya un enlace seguro, solo el texto con una nota en la bitácora, §4.5) | **Respondida (P5)** |
| D9 | Las ideas de la IA son posts `idea`; aceptar, aprobar y programar son pasos distintos (ADR-0030) | Tomada |
| D10 | La IA solo afirma lo que está en `facts` o en un brief escrito por el operador (ADR-0030) | Tomada |
| D11 | Instagram solo imagen, carrusel y reel; sin Stories ni música en F9 | Tomada |
| D12 | Programar lo hace el reloj de AgentSales en todas las redes (ninguna API lo ofrece) | Tomada |
| D13 | Métricas y comentarios, a la siguiente fase. Los permisos de anuncios (Marketing API) son de **otra app** de Meta, no de la revisión en curso: `AgentSales-IG` sigue pidiendo solo `instagram_business_basic` e `instagram_business_content_publish` | Tomada |
| D14 | Terceros después de F9 | Tomada |
| D15 | La prueba S1 de Instagram la hace el operador en su cuenta cuando llegue el momento, sin publicar nada antes de su instrucción | **Respondida (P3)** |
| D16 | TikTok en F9: solo video, como borrador en la bandeja (modo *Upload*); la publicación directa pública y las fotos, con el piloto | **Respondida** |
| D17 | Orden: F9 propio → F10 piloto con una oficina (servicio operado por el operador) → F11 organizaciones | **Respondida** |
| D18 | Anuncios (F10): campañas por aviso incluidas, la corredora paga a Meta directo, ManyChat conviviendo con interfaz propia que permite reemplazarlo | **Respondida** |
| D19 | **Arquitectura de despliegue:** una base de código y **una instancia** mientras solo la use el operador; **dos instancias del mismo código** (personal y de clientes, cada una con sus datos, cuentas y apps de Meta, TikTok y X) cuando ocurra lo primero de: entra el primer dato real de un cliente, la oficina firma el piloto, o un incidente de una red amenaza la app compartida. Dos plataformas con dos bases de código: descartado (el piloto necesita el mismo motor de posts). T27 deja barato el corte | **Respondida** |
| D20 | Tres entregas con su etiqueta: `v1.1.0`, `v1.2.0` y `v1.3.0` (§5.1) | **Respondida** |
| D21 | Ejecución en paralelo: agentes en worktrees, con la CI de GitHub como juez (§5.2) | **Respondida** |

### 4.15 ADRs
ADR-0029 (el post como sujeto de publicación, el resultado dudoso, el traspaso a mano por cuenta, las credenciales por plataforma y el access token al publicar; modifica ADR-0006, 0014, 0015, 0017 y 0023) y ADR-0030 (la IA propone, el operador decide; modifica ADR-0013 solo para posts), ambos **Aceptados** con la aprobación del spec (2026-10-19). Los ADR-0031 a ADR-0033 (anuncios, dinero y leads) son del piloto: quedan **Propuestos** como borrador para no cerrar puertas, y se aprueban con el spec de esa fase.

### 4.16 Dependencias nuevas
Ninguna prevista. LinkedIn y X se hablan con `fetch` y zod, como Mercado Libre; Discord, con `fetch` y `FormData`. Si la subida por partes de X lo justifica, se evalúa en T16, con su justificación en el PR.

### 4.17 Hoja de ruta y preparación del piloto
Orden acordado con el operador (2026-10-19): **F9** para sus dos marcas → **F10, piloto con una oficina** de una corredora grande (3 a 10 agentes; servicio operado por el operador; la corredora paga a Meta directo y AgentSales no recibe dinero de anuncios) → **F11, organizaciones** (franquicia). El primer cliente no es la franquicia maestra.

- **F10 (piloto):** anuncios de Meta sobre publicaciones de Instagram (impulsar un post con un clic, campañas por aviso, nacen pausados, dos aprobaciones —texto y gasto— y tres topes: ADR-0031 y ADR-0032), leads con atribución a aviso y oficina, ManyChat conviviendo (una interfaz propia con ManyChat como primer adaptador, ADR-0033), reporte de gasto, y TikTok público y con fotos. Los formularios instantáneos de Meta quedan para después. Notas: `meta-ads.md` y `manychat.md`.
- **F11 (organizaciones):** `organizations`, árbol de oficinas y agentes, membresías y roles por nodo, alcance por conjunto, aprobación por niveles y contenido corporativo como plantilla con una copia por agente. Su propio spec y ADR (modifica ADR-0022).
- **Qué deja abierto F9 para no cerrar esas puertas** (revisión del `arquitecto`, 2026-10-19): posts en cualquier corredor (§4.2); `kind` extensible y sin decidir permisos (§4.3); alcance siempre por `scopeOf`/`inScope`/`can`; una cuenta por marca y plataforma como regla de los casos de uso y nunca como índice único de la base; la unión de credenciales admite tokens que no vencen (§4.7); `publications.cost_usd` es solo del costo de X y no se extiende a anuncios, que tendrán su propio agregado; `operator_owned` no gana significados nuevos.
- **Trámites del operador que pueden empezar ya, sin código** (los de plazo más largo): la verificación del negocio con Certilink SpA, que sirve para todo el portafolio de Meta (`meta-verificacion-empresa.md`); una **segunda app de Meta** para anuncios (Facebook Login for Business y Marketing API; la `AgentSales-IG` usa Instagram Login, que no puede manejar anuncios); la Página de Facebook vinculada al Instagram, la cuenta publicitaria en pesos y su medio de pago en el portafolio de la oficina; el plan Pro de ManyChat de la corredora; un abogado para el contrato de encargo y la privacidad de leads antes del 2026-12-01 (Ley 21.719, salvo que se postergue); y dos pruebas en el Graph API Explorer: que el id de un medio publicado con Instagram Login sirva como `source_instagram_media_id` en la Marketing API (A1) y que exista una validación de anuncios sin efectos (A2).

## 5. Tareas
Una tarea (o un lote de tareas relacionadas) = una rama = un PR. F8 cerró (`v1.0.0`). Las pruebas de entrada (§4.8) las hace el operador en paralelo al código, que se construye contra simulaciones (`msw` y fakes).

- **A** · el sujeto genérico, sin cambiar los avisos: T01 a T08
- **B** · la marca, los posts y el texto: T09 a T12
- **C** · las redes: T13 a T16 y T26 (TikTok); cada una se construye contra simulaciones y su prueba de entrada se hace antes de publicar de verdad (decisión del operador, 2026-10-20)
- **D** · panel y CLI: T17 a T19
- **E** · la IA propone: T20 a T22
- **F** · cierre: T23 a T25
- Y **T27**, el despliegue parametrizado por instancia (D19), independiente de todo lo demás

Los tests de contrato de repositorios y de casos de uso de avisos pasan sin cambiar sus aserciones de comportamiento (se actualizan solo los datos de prueba que ahora llevan `postId: null`).

### 5.1 Entregas (D20)
| Entrega | Tareas | Etiqueta | Queda funcionando |
|---|---|---|---|
| **1 · Publicar lo mío** | T01 a T14 y T27 | `v1.1.0` | Posts con perfil editorial, texto con IA por red e idioma, aprobación, calendario y CLI; publicar en Instagram y Discord |
| **2 · Más redes y panel** | T15, T16, T26, T17, T18 y T19 | `v1.2.0` | LinkedIn (a mano), X, TikTok (borrador), la pantalla Contenido, el calendario y la guía |
| **3 · La IA propone** | T20 a T22, y T23 a T25 | `v1.3.0` | El plan de ideas, la evaluación de calidad, la documentación completa, la prueba con todas las cuentas y el cierre de la fase |

Cada entrega cierra con los docs y `docs/ESTADO.md` al día, su sección del `CHANGELOG` y la etiqueta (con el permiso del operador, como `v1.0.0`). La prueba en vivo de lo que entrega, solo con su instrucción en el chat. T25 es el cierre de la fase (`/fase-cerrar 9`).

### 5.2 Ejecución en paralelo (D21)
**Olas** (lo que se puede hacer a la vez, según las dependencias):
- **Entrega 1:** ola 1, T01 y T27 → ola 2, T02 y T03 → ola 3, T04 → ola 4, dos cadenas a la vez: el núcleo (T05 → T06 → T07 → T08) y la marca y el texto (T09 → T10 → T11) → ola 5, T12, T13 y T14 (S1 y S5, antes de publicar de verdad en Instagram y Discord; decisión del operador 2026-10-20).
- **Entrega 2:** T15, T16, T26 y la cadena T17 → T18 a la vez (S2 y S3, S4 y S6, antes de publicar de verdad en LinkedIn, X y TikTok; decisión del operador 2026-10-20); T19 al final (depende de los publishers).
- **Entrega 3:** T20 → T21 y T22 a la vez → T23, T24 y T25.

**Reglas:**
- Cada tarea, en su **worktree** y su rama `feat/f9-tXX-…`, la hace un agente; el agente principal coordina, revisa y hace los merges.
- **Como máximo 3 ramas con código a la vez** (la Mac de 8 GB). En el Mac cada rama corre solo las pruebas y el typecheck de los paquetes que toca; **nunca dos `pnpm check` completos a la vez**. El chequeo completo lo corre la CI de GitHub en cada PR, y el merge exige `check` e `image` en verde sobre el último commit, como siempre.
- **Archivos calientes en serie:** dos ramas en paralelo no tocan los mismos archivos de alto choque (`packages/db/src/schema.ts` y las migraciones, `packages/core/src/enums.ts`, `permissions.ts`, `apps/api/src/access.ts` y los `index.ts` que reexportan). Si dos tareas los necesitan, se encadenan o la segunda se rebasa sobre la primera ya mergeada. Las migraciones de F9 se numeran al hacer el merge.
- `revisor` revisa cada PR (y el `arquitecto` los que cambian contratos), en paralelo con la CI.
- El operador **no aprueba tarea por tarea** (su aprobación permanente del 2026-10-01). Sí decide sus cuentas, las pruebas de entrada, todo lo que sea `live` y las etiquetas.

### F9-T01 · Plataformas, marcas y estados nuevos
- **Depende de:** F8 cerrada
- **Descripción:** `x`, `linkedin`, `discord` y `tiktok` en `PLATFORMS` (una sola migración para las cuatro), sus etiquetas y nombres cortos; `outcome_unknown` en los estados de publicación (transiciones, `PENDING_PUBLICATION_STATUSES`, único parcial activo); `brokers.kind` y `agentsales brokers create --kind`; la regla «un aviso solo cuelga de un corredor `kind = broker`» (un post, de cualquiera) y `auto_publish` fuera de los posts; el panel esconde lo de avisos en una `brand`. En `CLAUDE.md`: el glosario (`Post`, marca) y la regla de `social:smoke`. Sin publishers todavía.
- **Archivos principales:** `packages/core/src/enums.ts`, `labels.ts`, `publication-state.ts`, `broker.ts`; `packages/db/src/schema.ts` y migración `0014` (solo `ALTER TYPE … ADD VALUE` y la columna `kind`); `apps/cli`, `apps/web` (navegación); `CLAUDE.md`.
- **Hecho cuando:**
  - [ ] la migración aplica sobre una base con filas en `publications` (PGlite con datos de F3 a F8) y las marcas existentes quedan `broker`
  - [ ] la tabla de transiciones cubre `publishing → outcome_unknown → published | failed` con tests, y una `outcome_unknown` cuenta como activa
  - [ ] `docs/10-despliegue.md` explica que volver atrás después de usar los valores nuevos rompe la lectura
  - [ ] `pnpm check` pasa, y docs y `docs/ESTADO.md` actualizados

### F9-T02 · Credenciales por plataforma y redactor
- **Depende de:** T01
- **Descripción:** la unión de credenciales por plataforma en core y en `platform_accounts` (con la AAD de siempre), con TikTok y con un token que no vence; `redactText` con la URL del webhook de Discord y los `Bearer`; `checkConnectedCredentials` por plataforma.
- **Archivos principales:** `packages/core/src/platform-account.ts`, `redact.ts`, `packages/db/src/repositories/platform-accounts.ts`, `packages/config`
- **Hecho cuando:**
  - [ ] `{ webhookUrl }` se guarda cifrada y se lee descifrada solo por `getCredentials`; las cuentas existentes siguen leyéndose
  - [ ] un test de redacción cubre la URL del webhook en logs, errores y eventos
  - [ ] `pnpm check` pasa

### F9-T03 · Esquema de posts y migración
- **Depende de:** T01
- **Descripción:** `posts`, `plan_runs`, `post_uploads`, `editorial_profiles`; `post_id` y `language` donde corresponde; los `CHECK`, únicos e índices de §4.11; `publications.cost_usd`; seeds de las dos marcas. Solo esquema: los repositorios llegan en T04.
- **Archivos principales:** `packages/db/src/schema.ts`, migración `0015`, `packages/db/test`
- **Hecho cuando:**
  - [ ] la migración aplica sobre datos reales de avisos (filas de todas las tablas tocadas) y no cambia ninguna fila
  - [ ] el `CHECK` rechaza una fila con los dos sujetos o con ninguno (`media` admite ninguno)
  - [ ] un test fija que el borrado de Meta no toca `posts` ni `contents`
  - [ ] `docs/02-modelo-datos.md` actualizado; `pnpm check` pasa

### F9-T04 · Repositorios con sujeto y `PostLock`
- **Depende de:** T03
- **Descripción:** `Subject`, `PostRepository`, `PostUploadRepository`, `PlanRunRepository`, `EditorialProfileRepository` (solo lectura y escritura básica); los repositorios existentes aceptan `postId`; `PostLock` con las reglas de `ListingLock`; `sumLlmCost` suma avisos, posts y planes; el permiso `posts.manage` y el dueño de un post por su marca.
- **Archivos principales:** `packages/core/src/subject.ts`, `ports/post-repository.ts`, `ports/post-lock.ts`, `packages/db/src/repositories/*`, `packages/core/src/permissions.ts`, `apps/api/src/app.ts`, `request-context.ts`
- **Hecho cuando:**
  - [ ] contratos de repositorio con PGlite para posts, y los de avisos con las mismas aserciones
  - [ ] `PostLock` serializa dos operaciones sobre el mismo post y la bitácora anota al usuario (`request-context`)
  - [ ] `sumLlmCost` cuenta una corrida de post y un plan
  - [ ] la tabla de permisos tiene `posts.manage` y su test pasa; `pnpm check` pasa

### F9-T05 · Aprobar, editar y abrir publicaciones sobre un sujeto
- **Depende de:** T04
- **Descripción:** `approve-content`, `unapprove-content`, `edit-content`, `open-publications`, `request-content-run` y los jobs que reencolan corridas (`requeueQueuedContentRuns`, `resumeCutAutoPublish`) aceptan un sujeto y usan el candado que corresponde; las corridas de posts no caen en `content.prepare`; lo propio del aviso sigue solo para avisos.
- **Archivos principales:** `packages/core/src/use-cases/*`, `apps/worker/src/jobs/content-prepare.ts`
- **Hecho cuando:**
  - [ ] los tests de avisos pasan y hay tests nuevos para posts (aprobar, quitar la aprobación, editar con la corrida activa)
  - [ ] una corrida de post `queued` no se reencola como `content.prepare`
  - [ ] `pnpm check` pasa

### F9-T06 · El intento de publicar, el traspaso por cuenta y el resultado dudoso
- **Depende de:** T05
- **Descripción:** `publish-publication` y `publish/input.ts` sobre un sujeto (medios por sujeto, `socialCaption` en vez de enviar solo `body`); el contrato `Publisher` con `OUTCOME_UNKNOWN` y el progreso "enviando"; `requiresManualConfirm` por plataforma y cuenta; `confirmManualPublication` y `resolvePublication` genéricos; `ensureAccessToken` por plataforma al publicar. Marketplace y Portal no cambian de comportamiento.
- **Archivos principales:** `packages/core/src/use-cases/publish-publication.ts`, `confirm-manual-publication.ts`, `ensure-access-token.ts`, `ports/publisher.ts`, `publish/input.ts`
- **Hecho cuando:**
  - [ ] con un publisher falso: un corte tras "enviando" deja `outcome_unknown` y ningún reintento llama otra vez; el reencolado al arrancar el worker no vuelve a publicar
  - [ ] una cuenta en `manual` no llama a la red y la confirmación guarda el enlace; los tests de Marketplace pasan sin cambios
  - [ ] el filtro `listing_id IS NOT NULL` de `listByStatus`, `listDue` y `listStalePublishing` (F9-T04) se quita o se parametriza cuando sus casos de uso trabajen con sujeto: las publicaciones `publishing` de posts también se reencolan al arrancar el worker (sin republicar: el progreso "enviando" las lleva a `outcome_unknown`) y la vigilancia las ve
  - [ ] `docs/01-arquitectura.md` (contrato Publisher, estados, flujo 3) actualizada; `pnpm check` pasa

### F9-T07 · Programar, reloj, vigilancia y cancelar sobre un sujeto
- **Depende de:** T06
- **Descripción:** `publish-listing`/`publication-start`, `schedule-publications`, `start-due-publications`, `cancel-publication`, `retire-publication` y la vigilancia de F6 sobre un sujeto; el paso a `active` y el cierre por venta solo en avisos.
- **Archivos principales:** `packages/core/src/use-cases/*`, `apps/worker/src/jobs/*`
- **Hecho cuando:**
  - [ ] un post con un publisher falso recorre aprobar → programar → publicar → reintento → `published`
  - [ ] el reloj de un minuto publica posts programados y la vigilancia no confunde un post con un aviso
  - [ ] `pnpm check` pasa

### F9-T08 · Agenda y seguimiento con posts
- **Depende de:** T07
- **Descripción:** la agenda y el seguimiento muestran posts y avisos juntos (`tracking/agenda.ts`, `row.ts`); las clases nuevas `outcome_unknown` y "token por vencer"; la agenda ya no da por hecho el aviso.
- **Archivos principales:** `packages/core/src/tracking/*`, `apps/api`, `apps/cli`
- **Hecho cuando:**
  - [ ] la agenda ordena posts y avisos juntos; una `outcome_unknown` y un token de LinkedIn a 7 días aparecen con su comando
  - [ ] `SubjectRef` ya no admite `string` (el id de un aviso, la rama de transición de F9-T04): todo llamador pasa un `Subject`; `listByListing` de medios y de publicaciones queda absorbido por `listBySubject`, y `listCurrent`, `findActive` y `listBySubject` tienen la misma firma (un `Subject`)
  - [ ] `pnpm check` pasa

### F9-T09 · Perfil editorial
- **Depende de:** T04
- **Descripción:** casos de uso, `GET/PUT /api/brokers/:id/editorial-profile` y `agentsales brand show|edit`; el perfil se valida (idiomas, líneas con peso, cadencia por red).
- **Archivos principales:** `packages/core/src/editorial-profile.ts`, `apps/api`, `apps/cli`
- **Hecho cuando:**
  - [ ] solo lo edita el administrador o el corredor de esa marca, y el perfil de una marca nunca se entrega a otra (tabla de permisos)
  - [ ] `pnpm check` pasa

### F9-T10 · Posts manuales y sus medios
- **Depende de:** T04, T09
- **Descripción:** crear, listar, ver, editar y archivar posts (`brief_origin = operator`); subir medios directo a R2 con `post_uploads`; el worker procesa lo subido con el pipeline de medios (variantes de Instagram y X) y limpia lo abandonado.
- **Archivos principales:** `packages/core/src/use-cases/*post*.ts`, `apps/api/src/routes/posts.ts`, `apps/worker`, `packages/media`
- **Hecho cuando:**
  - [ ] subir una imagen y un video a un post con R2 falso, con avance y reintento; una subida abandonada se borra
  - [ ] el único `(post_id, checksum)` evita duplicados y las claves van bajo `posts/{postId}/`
  - [ ] tabla de permisos y su test al día; `pnpm check` pasa

### F9-T11 · El texto por red con IA
- **Depende de:** T09, T10
- **Descripción:** prompt de redes (`SOCIAL_PROMPT_VERSION`) y brief con el perfil editorial; un texto por red e idioma; `checkPostContent` con las reglas de §4.4; `socialCaption`; job `post.draft`; gasto de IA por marca.
- **Archivos principales:** `packages/core/src/social/*`, `apps/worker/src/jobs/post-draft.ts`
- **Hecho cuando:**
  - [ ] con `fake` y respuestas fijas, el texto de cada red e idioma cumple su largo y su escape; un `@everyone` o una cifra ajena al perfil impide aprobar; un brief de la IA no vale como fuente de hechos
  - [ ] el gasto queda anotado por marca y respeta el tope
  - [ ] al terminar una corrida `post.draft` pedida con `replaceEdits` que sustituye textos aprobados, se llama a `settlePostStatus` (F9-T05): el post no queda `ready` sin un texto vigente aprobado, con test
  - [ ] `docs/04-formato-publicaciones.md` tiene la sección de redes; `pnpm check` pasa

### F9-T12 · Aprobar, publicar y programar un post (CLI)
- **Depende de:** T08, T11
- **Descripción:** `agentsales post …` completo contra la API; `publications resolve` y `confirm`.
- **Archivos principales:** `apps/cli/src/commands/post.ts`, `apps/api/src/routes/posts.ts`
- **Hecho cuando:**
  - [ ] los comandos que la agenda ya sugiere para posts existen: `post show <id>`, `publications resolve <id> --published|--not-published`, `publications confirm <id> --url-stdin` y `publications not-published <id>` para un post, y uno para reintentar o publicar por id de publicación (revisión de F9-T08)
  - [ ] con un publisher falso, `post create → draft → approve → schedule` deja la publicación programada y `agenda` la muestra
  - [ ] `pnpm check` pasa

### F9-T13 · Instagram para posts
- **Depende de:** T07, T10 (S1: verificación obligatoria antes de publicar de verdad, no antes de construir; decisión del operador 2026-10-20)
- **Descripción:** el publisher de Instagram arma su input desde un post (imagen suelta, carrusel de 2 a 10, reel) y comparte la cuota de la cuenta con los avisos.
- **Archivos principales:** `packages/core/src/publish/input.ts`, `packages/publishers/src/instagram`
- **Hecho cuando:**
  - [ ] contratos con `msw` para los tres formatos y para el límite de cuota compartido
  - [ ] el resultado de S1 queda anotado en `instagram-contenido-propio.md` y en `docs/ESTADO.md`
  - [ ] `pnpm check` pasa

### F9-T14 · Discord
- **Depende de:** T07, T10 (S5: verificación obligatoria antes de publicar de verdad, no antes de construir; decisión del operador 2026-10-20)
- **Descripción:** publisher de webhook (texto y archivos), `allowed_mentions` fijo, `outcome_unknown` ante un corte, límites y 429, conexión con `accounts connect discord --webhook-stdin`, `social:smoke --platform discord`.
- **Archivos principales:** `packages/publishers/src/discord/*`, `packages/core/src/use-cases/connect-account.ts`
- **Nota (2026-10-20):** `social:smoke --platform discord` no se construyó: S5 se hace a mano (§4.8) y es la verificación antes de publicar de verdad. El lector del enlace del mensaje (`parseDiscordMessageUrl`, en core y sin red) deja como `external_id` el id del mensaje, el mismo que guarda el publisher.
- **Hecho cuando:**
  - [ ] contratos con `msw` (éxito, 429 con `retry_after`, 404 del webhook, corte → `outcome_unknown`)
  - [ ] la URL del webhook no aparece en ningún log ni evento
  - [ ] `pnpm check` pasa

### F9-T15 · LinkedIn
- **Depende de:** T07, T10 (S2 y S3: verificación obligatoria antes de publicar de verdad, no antes de construir; decisión del operador 2026-10-20)
- **Descripción:** OAuth del perfil personal (con `state` firmado y de un solo uso), publisher de texto, imagen, varias imágenes y video por `/rest/posts` con la cabecera de versión, función de escape de `commentary`, modo `manual` por defecto (deja el texto listo y espera la confirmación), recordatorio en la agenda, aviso 7 días antes de que venza el token.
- **Archivos principales:** `packages/publishers/src/linkedin/*`, `apps/api/src/routes/oauth.ts`
- **Nota (2026-10-20):** el OAuth vive en `apps/api/src/routes/oauth-linkedin.ts` (montado en `/oauth/linkedin`, con el `state` de `oauth.ts`). `accounts connect linkedin --broker <slug>` abre el inicio del OAuth en el navegador (con la sesión del panel); el botón del panel queda para T17/T19. `accounts mode <id> manual|api` (administrador) cambia el modo; reconectar el mismo perfil conserva el modo. El lector del enlace (`parseLinkedInPostUrl`, en core y sin red) deja como `external_id` el URN del post, el mismo formato que guarda el publisher (`x-restli-id`); el enlace de «Copiar enlace» trae un URN `activity`, que no es el `share` de la API. El `DELETE` está en el cliente (`deleteLinkedInPost`, solo con URN `share` o `ugcPost`), pero retirar desde AgentSales sigue marcándose a mano (`retirePublication`): conectarlo queda para T19. `social:smoke --platform linkedin` no se construyó: S2 se hace a mano (§4.8).
- **Hecho cuando:**
  - [ ] contratos con `msw` y tests del escape con todos los caracteres reservados
  - [ ] en modo `manual` no se llama a la red y la confirmación guarda el enlace
  - [ ] el `state` del OAuth es de un solo uso y va amarrado a la marca
  - [ ] `pnpm check` pasa

### F9-T16 · X
- **Depende de:** T07, T10 (S4: verificación obligatoria antes de publicar de verdad, no antes de construir; decisión del operador 2026-10-20)
- **Descripción:** OAuth 2.0 con PKCE (el verificador en la cookie firmada), refresco al publicar y en `tokens.refresh`, publisher de texto con imágenes o video (subida por partes), conteo ponderado de caracteres, `cost_usd`, `spendLimitUsd`, el 403 por texto repetido como `outcome_unknown`.
- **Archivos principales:** `packages/publishers/src/x/*`
- **Nota (2026-10-20):** construido contra simulaciones (msw); S4 es la verificación obligatoria antes de publicar de verdad (`x.md` §0). La marca del enlace es **por post** (`posts.x_link_allowed`, migración `0016`, `PATCH /api/posts/:id`): se suma al brief (el enlace tiene que estar en los dos), y sin ella la IA no recibe enlaces para X. El tope se fija con `accounts spend-limit <id> <dólares>` (administrador) y suma el `cost_usd` en `live` del mes de Chile de la cuenta sin contar las fallidas. `social:smoke --platform x` no se construyó (S4 se hace a mano). **Corrección (2026-10-20):** el criterio de la marca explícita del enlace en X ya tiene dónde marcarse: `post edit <id> --x-link` / `--no-x-link` en la CLI (`post show` la muestra y `post approve` da ese comando cuando un texto de X con enlace no la tiene) y «Permitir un enlace en X» en el detalle del post del panel, con el aviso del costo (los montos de core, `X_LINK_POST_COST_USD`); las dos mandan `PATCH /api/posts/:id` con `xLinkAllowed`.
- **Hecho cuando:**
  - [ ] contratos con `msw`: éxito, 402 por saldo, 429, 403 por texto repetido, refresh que rota
  - [ ] un post con enlace pide la marca explícita y anota US$0,20; pasado el límite mensual, `failed` con la causa
  - [ ] un enlace en X requiere una marca explícita del operador por post (no basta con que el enlace esté en el brief), con el aviso del costo US$0,20. Hasta T16, "marcar" es escribirlo en el brief del operador (`checkPostContent`, F9-T11; `docs/04-formato-publicaciones.md`)
  - [ ] `pnpm check` pasa

### F9-T17 · Panel: Contenido
- **Depende de:** T12
- **Descripción:** lista de posts por marca y estado; editor con una pestaña por red e idioma (conteo de caracteres, vista previa, verificaciones), medios con avance, aprobar, programar y publicar; editor del perfil editorial; resolver una `outcome_unknown` y confirmar una publicación a mano.
- **Archivos principales:** `apps/web/src/pages/Posts*.tsx`, `BrandPage.tsx`
- **Hecho cuando:**
  - [ ] el sha256 de un medio es obligatorio hasta 100 MB y opcional sobre eso, como ADR-0025 punto 2 (el navegador no puede hashear en streaming): la clave pasa a `posts/{postId}/original/{uploadId}.{ext}`, `post_uploads` suma un estado `uploaded` y el worker calcula el sha256 en streaming, crea el medio y deduplica; con un seguimiento en ADR-0025 (hoy, F9-T10, el sha256 es obligatorio siempre)
  - [ ] tests de componentes y de las consultas; sin dependencias nuevas
  - [ ] `pnpm check` pasa

### F9-T18 · Panel: calendario
- **Depende de:** T17
- **Descripción:** vista semanal y mensual de lo programado, con posts y avisos, y mover una fecha.
- **Archivos principales:** `apps/web/src/pages/CalendarPage.tsx`
- **Nota (2026-10-20):** la lectura es `GET /calendar?from=&to=&broker=` (en `routes/tracking.ts`, con `calendarEntries` de core y hasta 43 días por pedido); muestra las programadas por su hora y, para ver la semana completa, también lo ya publicado por su `publishedAt` (lo aprobado, publicándose o fallido sigue en Seguimiento). Mover una fecha no suma ruta: es `POST /publications/:id/schedule` (`schedulePublication`, F6) con el `ScheduleForm` de siempre (confirmación en vivo incluida). Sin arrastrar (opcional, sin dependencias nuevas). `chileDateStart` y `chileDateOf` (core) dan los bordes de los días de Chile.
- **Hecho cuando:**
  - [ ] la hora se muestra en hora de Chile; reprogramar usa el mismo caso de uso de F6
  - [ ] `pnpm check` pasa

### F9-T19 · CLI de cuentas y guía del operador
- **Depende de:** T12, T14 a T16
- **Descripción:** `accounts connect linkedin|x|discord|tiktok`, mensajes de error con "qué hacer", y la guía en `docs/08-guia-operador.md`.
- **Nota (2026-10-20):** cada código de los publishers y de la conexión de Instagram, LinkedIn, X, Discord y TikTok tiene su consejo (`publicationErrorAdvice`). Las pruebas: `packages/publishers/src/error-advice.test.ts` lee el código de cada red (los literales `IG_`, `LINKEDIN_`, `X_`, `DISCORD_` y `TIKTOK_` de su carpeta) y falla si uno nuevo no tiene consejo (los motivos de `validate` van dentro de `PUBLISH_INPUT_INVALID` y quedan en una lista aparte); `packages/core/src/publish/error-advice.test.ts` fija a mano los de conectar y retirar (`F9_CONNECT_AND_RETIRE`) y los de core; `apps/api/src/routes/oauth-errors.test.ts` recorre `OAUTH_REDIRECT_ERRORS` del contrato (con un `<RED>_NOT_CONFIGURED` por cada red de `OAUTH_PROVIDERS`) contra `publicationErrorAdvice`; y `apps/web/src/components/accounts/accounts.test.ts` exige, por cada código de `OAUTH_REDIRECT_ERRORS` y cada red de `OAUTH_PROVIDERS`, el texto propio que muestra el panel al volver del OAuth (`oauthErrorText`, sin el genérico "No se pudo conectar" y con el nombre de la red puesto), que es donde el operador ve esos errores. La CLI muestra el consejo también en `publications`, `publish` y `post show`. `accounts` dice las redes que faltan con su comando; `accounts connect` explica las variables cuando falta la app. `connect.x` y `connect.tiktok` pasan a obligatorios (`AppDeps.tiktok` también); `OAUTH_PROVIDERS` suma `x`. Cuentas del panel suma Discord (solo el comando de la CLI: la URL del webhook no se pega en el panel), LinkedIn, X y TikTok (botón del OAuth, con su permiso `*.connect`). **Retirar en LinkedIn por la API:** `Publisher.remove` (opcional, idempotente), `createLinkedInOperations` en `operationsFor` de la API, `retirePublication` con `deleteRemote` (solo publicación y API en `live`, cuenta en modo `api`; si no, `PUBLISH_MODE_MISMATCH` o `RETIRE_DELETE_UNSUPPORTED`) y `publications retire <id> --delete` en la CLI; el panel no tiene retirar para los posts todavía. Las redes con token que rota (X y TikTok, `ROTATING_TOKEN_PLATFORMS`) dan `RETIRE_DELETE_UNSUPPORTED` sin llamar hasta que retirar use `ensureRotatingAccessToken` (seguimiento de ADR-0029). La guía del operador suma "Conectar las redes de los posts (F9)".
- **Hecho cuando:**
  - [x] cada error de una red tiene su consejo (como `error-advice.ts`)
  - [x] retirar con `--delete`: en simulación no se llama a la red (una publicación de `dry-run` se retira sin llamar; `retire-publication.test.ts`)
  - [x] con la publicación en vivo y la API en simulación, `PUBLISH_MODE_MISMATCH` sin llamar (`retire-publication.test.ts` y `publications-retire.test.ts`)
  - [x] una cuenta a mano no borra: `RETIRE_DELETE_UNSUPPORTED` y sigue sirviendo retirar a mano (`retire-publication.test.ts`; el 409, también `publications-retire.test.ts`)
  - [x] un 404 de LinkedIn cuenta como borrado (`packages/publishers/src/linkedin/publisher.test.ts`)
  - [x] X y TikTok no borran todavía: `RETIRE_DELETE_UNSUPPORTED` sin llamar (`retire-publication.test.ts`)
  - [ ] `pnpm check` pasa

### F9-T20 · El plan de ideas (core y worker)
- **Depende de:** T09, T11
- **Descripción:** `requestPlanRun`, el prompt del plan, su validación (fechas, líneas, cadencia, sin hechos nuevos) y el job `content.plan`; aceptar y descartar ideas; el gasto del plan entra a `sumLlmCost`.
- **Archivos principales:** `packages/core/src/social/plan.ts`, `apps/worker/src/jobs/content-plan.ts`
- **Nota (2026-10-20):** lo puro vive en `social/` (`plan.ts`: período, lo que ve la IA, verificaciones y reporte; `plan-prompt.ts`; `plan-sample.ts`, el plan de ejemplo de `fake`) y los casos de uso en `use-cases/` (`requestPlanRun` y `getPlanRun` en `request-plan-run.ts`, `runPlan` en `run-plan.ts`, `acceptIdea` y `discardIdea` en `plan-ideas.ts`). Decisiones: (1) el prompt del plan tiene su versión propia, `PLAN_PROMPT_VERSION` (`social-plan-v1`), y no `SOCIAL_PROMPT_VERSION` (seguimiento en ADR-0030); (2) cada idea se valida por separado: una mal formada, con fecha fuera del período o de la cadencia, con una línea que no existe, con cifras o nombres fuera del perfil o con un tema repetido se descarta al reporte (`plan_runs.report`, `planRunReportSchema`) y el plan sigue; cero ideas válidas también es `succeeded`; (3) una red de la idea que no se pidió, que no admite el formato (Instagram sin imagen, TikTok sin video), fuera de su cadencia o con la semana llena se le **quita** a la idea, que sigue con las demás (se descarta si no le queda ninguna); (4) **decisión del operador:** las redes de cada idea se guardan en el post (`posts.platforms`, text[] null, migración `0018`; `null` = todas las de la marca, como un post manual) y, al aceptarla, `post.draft` redacta solo para esas; `updatePost` las cambia. Además, para todo post, `post.draft` deja fuera las redes que no sirven a su `kind` (`kindProblem`, la misma regla del plan: Instagram sin imagen o video, TikTok sin video), y sin ninguna es `POST_NO_PLATFORMS`; (5) **decisión del operador:** "descartadas" son las ideas de la IA archivadas de los últimos 60 días (después el tema vuelve a estar disponible), y "recientes" los demás posts creados o planificados en 60 días, incluidas las ideas sin decidir; la repetición se compara por tema normalizado (`topicKey`). Lo ya planificado en el período (ideas, borradores y listos con `planned_at`; uno sin redes propias cuenta en todas) ocupa su cupo de posts por semana (`plannedSlots`, también en el prompt como `ya_planificados`). Lo programado en `publications` sin `planned_at` en su post no se cuenta (sería otra consulta); (6) las ideas y el `succeeded` se guardan en una transacción (`PlanRunRepository.markSucceeded` con `ideas`, con el id de cada post puesto por core para anotarlo en el reporte): un intento repetido no duplica; (7) un plan activo por marca, respaldado en la base (índice único parcial `plan_runs_one_active_per_broker`, migración `0018`; un segundo `create` es `PLAN_RUN_CONFLICT`): una marca con un plan en cola o corriendo recibe ese (`reused`), también si dos pedidos se cruzan; (8) el plan de ejemplo se arma con lo que pide el prompt (`samplePlanResponse`, con la opción `respond` nueva del proveedor `fake` de `packages/llm`); (9) aceptar cambia `idea → draft` en el candado del post y después llama a `requestContentRun` tal cual (si eso falla, la idea queda aceptada y los textos se piden de nuevo); el tope de IA se revisa antes de cambiar nada; (10) `proposePlanIdeas` (`social/plan-propose.ts`) es la llamada, la validación y las verificaciones sin repositorios: la usan `runPlan` y T22; (11) `listPlanRuns` lista los planes de una marca con su alcance (para T21); (12) si quien pidió el plan ya no existe al guardarlo, las ideas quedan sin autor (`created_by = null`) en vez de fallar; (13) `contentRunErrorOf` vive en `content/run-error.ts`, compartido por las tres corridas. Editar el brief o mover la fecha de una idea es `updatePost` (F9-T10), que ya sirve. Código nuevo de cara al operador: `POST_NOT_IDEA` (409); `PLAN_RUN_INVALID` (400), `PLAN_RUN_ABORTED` y `PLAN_RUN_ABANDONED` son del plan. Las rutas, la CLI y el panel son de T21.
- **Hecho cuando:**
  - [x] con `fake`: un plan de N ideas crea N posts `idea` (`brief_origin = ai`), sin textos ni publicaciones (`use-cases/plan-run.test.ts`, `apps/worker/src/jobs/content-plan.test.ts`)
  - [x] el plan no repite temas de los últimos 60 días ni ideas descartadas; una idea con fecha fuera del período se descarta (`social/plan.test.ts`, `use-cases/plan-run.test.ts`)
  - [x] el gasto se anota (también si falla después de llamar), entra a `sumLlmCost` y respeta el tope (`use-cases/plan-run.test.ts`; los repositorios, `packages/db/test/subject-repositories.contract.ts`)
  - [x] aceptar → `draft` + corrida + `post.draft` encolado; descartar → `archived`; aceptar o descartar algo que no es `idea` → `POST_NOT_IDEA`; `auto_publish` no aplica (`use-cases/plan-run.test.ts`)
  - [x] `pnpm check` pasa

### F9-T21 · Plan en el panel y la CLI
- **Depende de:** T17, T20
- **Descripción:** pedir un plan, ver las ideas por semana, aceptar, editar, mover y descartar, y "redactar lo aceptado"; `agentsales plan`.
- **Core listo (F9-T20):** `requestPlanRun`, `getPlanRun`, `listPlanRuns` (para `GET /api/plans?brokerId`, con alcance y `posts.manage`), `acceptIdea`, `discardIdea` y `updatePost` (también cambia las redes de una idea, `platforms`). `POST_NOT_IDEA` ya es 409 en la API.
- **Nota (2026-10-20):** **API** (`apps/api/src/routes/plans.ts`): `POST /plans` (202; encola `content.plan` después de crear, o devuelve el plan en curso con `reused`), `GET /plans?brokerId` (el administrador manda la marca: sin ella, `PLAN_RUN_INVALID`) y `GET /plans/:id` (el plan con su período en días de Chile, lo pedido, el error con su consejo, `planRunErrorAdvice` en core; el reporte reducido a lo descartado y las advertencias, sin el proveedor; y cada idea con las redes que se le quitaron, cuántos textos vigentes tiene y su última corrida). `POST /posts/:id/accept` (202, con la corrida) y `/discard`; `PATCH /posts/:id` suma `platforms`. Todas en la tabla de permisos como de sesión, con `posts.manage` en core; un plan ajeno es 404 por `ownedBy` (`/plans/:id/*`), como un post; `AppDeps.planRuns` es nuevo. **CLI:** `plan [--broker] [--days] [--platform] [--count] [--start] [--no-wait]` espera como `prepare` y muestra las ideas por semana (`groupByPlanWeek` y `planWeekText`, core) con su id y su comando; `plan show <id>` y `plan list`; `post accept|discard <id>` (aceptar no espera los textos: se aceptan varias seguidas y `post draft` sigue la misma corrida); `post edit` suma `--platforms` (`todas` = `null`), `--date` (`ninguna` la quita) y `--brief`. **Panel:** página **Plan** (`/plan`, en el menú después de Contenido) con pedir un plan (días, redes de la marca —con cuenta o cadencia— y cantidad), el estado que se actualiza solo mientras está en cola o corriendo (y mientras se redactan los textos de una aceptada, con el tope de `RUN_WAIT`), el error con su consejo, las ideas por semana con aceptar, editar (brief, fecha y redes) y descartar (con confirmación), y **Redactar lo aceptado** (las aceptadas sin textos ni corrida activa: pide sus textos una por una). El administrador elige la marca en el selector (con "Todos" se le pide elegir una). **Decisiones:** (1) las redes del post mandan en todos los caminos (`requirePostPlatform` en core; ajustado tras la revisión del `arquitecto`, con la decisión del operador de rechazar también una red quitada pedida a mano): sin redes pedidas, `schedulePost` y `post publish` usan solo `posts.platforms`; `POST_PLATFORM_EXCLUDED` es 409 al aprobar su texto (`POST /posts/:id/contents/:platform/:language/approve`), al publicar (`POST /posts/:id/publish` con esa red) y al empezar o programar una publicación suya (`POST /publications/:id/publish` y `/schedule`); en `POST /posts/:id/schedule` con esa red pedida sale una fila `skipped` con ese código (200), y sin redes pedidas no se informa; y el reloj deja una programada suya en `failed` con ese código, no reintentable. Aprobar el texto de una red quitada también es `POST_PLATFORM_EXCLUDED`, y `updatePost` no quita una red con publicaciones pendientes (`POST_HAS_PENDING_PUBLICATIONS`, 409). Los textos no se borran y vuelven a servir si la red vuelve al post; (2) `post show` y el detalle del post en el panel dicen las redes del post, avisan del texto que falta de una red agregada (con un botón para redactar) y de los textos de redes quitadas; (3) `plannedSlots` cuenta lo planificado en las semanas completas del período (`planWeeks`: del lunes de la primera al domingo de la última, hora de Chile), leído con `PostRepository.list` por rango de `planned_at` (sin el tope de 300 de `listRecent`, que queda solo para los temas: a la IA viajan como mucho 100); (4) el plan no muestra su gasto de IA (eso es de `usage`); (5) `GET /plans` da los 20 más recientes, fijo; `GET /plans/:id` lee textos y corridas solo de las ideas aceptadas; (6) la CLI y el panel muestran las redes con las mismas funciones de core (`postPublishesOn`, `postNetworkGaps` —con `kindProblem`—, `ideaNeedsDraft`), y el panel no ofrece publicar una red quitada.
- **Hecho cuando:**
  - [x] aceptar una idea encola `post.draft` y la idea pasa a `draft` (`apps/api/src/routes/plans.test.ts`, `apps/cli/src/commands/plan.test.ts`, `apps/web/src/pages/PlanPage.test.tsx`)
  - [x] cada ruta nueva está en la tabla de permisos y lo de otra marca es 404 (`plans.test.ts`, `scope.test.ts`)
  - [x] las redes del post mandan al aprobar, publicar, programar, empezar y en el reloj, y no se quita una red con pendientes (`schedule-subject.test.ts`, `post-content.test.ts`, `posts-content.test.ts`, `post.test.ts`, `PlanPage.test.tsx`); las semanas del borde cuentan completas (`social/plan.test.ts`, `use-cases/plan-run.test.ts`); un segundo `POST_REFERENCE_INVALID` al guardar las ideas sube y deja el plan en `failed` (`plan-run.test.ts`)
  - [ ] `pnpm check` pasa (lo juzga la CI del PR)

### F9-T22 · Evaluación de la calidad
- **Depende de:** T20
- **Descripción:** `pnpm eval:social` sobre perfiles de prueba, sin escribir en la base (`--provider fake` no gasta cuota): cuenta ideas repetidas, afirmaciones fuera del perfil, largos y escapes; imprime el costo estimado.
- **Archivos principales:** `apps/worker/src/scripts/eval-social.ts`, `apps/worker/src/eval/run-social-eval.ts`, `social-profiles.ts`, `social-options.ts`
- **Hecho cuando:**
  - [x] un perfil sin `facts` produce un plan sin cifras ni clientes inventados
  - [ ] el costo de un plan y sus textos (con dos idiomas) queda medido en `docs/integraciones/anthropic-api.md` (parcial: la estimación y el comando están en §13; la medición real queda pendiente del operador)
- **Nota (2026-10-20):** `pnpm eval:social [--provider fake|claude-cli|anthropic-api] [--model <id>] [--profile <nombre>] [--ideas N] [--strict] [--out]` corre el plan (`proposePlanIdeas`) y los textos de las primeras `N` ideas aceptadas (`draftPostTexts`, 3 por defecto) sobre tres marcas **inventadas** en el repo (`sin-hechos`, `dos-idiomas` con 10 ideas en cuatro redes, y `con-historial`), sin la base: no recibe repositorios ni se conecta, y con `fake` ni siquiera lee el `.env`. Cuenta ideas repetidas (los descartes por tema igual) y **parecidas** (advertencia: 60 % de palabras en común, lo que la verificación no ve), afirmaciones fuera del perfil (ideas y textos), largos, escapes (LinkedIn que solo cabe sin escapes, hashtags en el cuerpo, caracteres invisibles; el markdown queda como la advertencia de la revisión), menciones masivas, términos a evitar (advertencia) y los descartes por motivo; imprime el costo del plan y de los textos por separado y en total (parcial si no todas las llamadas informaron tokens). Sale con 1 solo si hay fallas, un corte o problemas que llegan al operador (textos con errores o escapes); las ideas que el plan descarta son la defensa funcionando y quedan como estadística, salvo con `--strict` (revisión del 2026-10-20). Un error de la IA queda en su perfil, salvo los que no se arreglan reintentando (sin sesión o clave, sin saldo, el límite de la CLI) o uno inesperado, que detienen la evaluación conservando el informe parcial. Los medios se suponen subidos según el formato de la idea (los textos no se evalúan por medios). El primer criterio lo prueba un test con `sin-hechos` y un `fake` que inyecta ideas con cifras y clientes inventados ("Atendimos a 300 clientes", "Nuestra clienta María González triplicó sus ventas", "Más de 50 marcas confían en nosotros"): se descartan con `FACT_NOT_IN_PROFILE` y se cuentan; los demás contadores, con respuestas inyectadas. **Límite:** el contador "fuera del perfil" no es una garantía, porque hereda los límites de la heurística de core; por ejemplo, "Trabajamos con Banco Estado y Falabella" (sin punto final) se toma como un título y no se marca. El umbral de "parecidas" (60 %) queda así, como advertencia, hasta la primera corrida real del operador. **La medición real del costo queda pendiente del operador** (`pnpm eval:social --provider anthropic-api --profile dos-idiomas --ideas 10 --out`, y con `--model claude-haiku-5-5`): la estimación de §13 de `anthropic-api.md` es de unos US$ 0,12 con Sonnet 5.5 y US$ 0,006 con Haiku 5.5 por un plan de 10 ideas y sus textos en dos idiomas.

### F9-T23 · Documentación
- **Depende de:** T01 a T22 y T26
- **Descripción:** `03-plataformas.md`, `02-modelo-datos.md`, `01-arquitectura.md`, `04-formato-publicaciones.md`, `07-checklist-cuentas.md`, `10-despliegue.md`, `00-vision.md`, `06-roadmap.md`, y el seguimiento de ADR-0014, ADR-0015 y ADR-0023. `00-vision.md` se actualiza ya al aprobar el spec.

### F9-T24 · Prueba con las cuentas reales (contigo)
- **Depende de:** T19, T21 y T26
- **Descripción:** conectar tus cuentas de Instagram, Discord, LinkedIn, X y TikTok, correr el plan, aceptar ideas, y publicar uno en cada red en `live`, solo con tu instrucción en el chat.

### F9-T25 · Cierre de fase
- **Depende de:** T24
- **Descripción:** `/fase-cerrar 9`: criterios, changelog y tag `v1.3.0` (la etiqueta de la entrega 3, §5.1; `v1.1.0` y `v1.2.0` ya cerraron las entregas 1 y 2).

### F9-T27 · Despliegue parametrizado por instancia
- **Depende de:** —
- **Descripción:** deja listo desplegar una segunda instancia del mismo código (D19) sin cambiar la actual: el nombre de la app de Fly, el dominio y el Environment de GitHub pasan a ser parámetros del flujo de despliegue (por ejemplo, un `fly.<instancia>.toml` y una entrada `instance` en `deploy.yml`). La guía `docs/10-despliegue.md` explica cómo crear la segunda instancia (app de Fly, base de Neon, bucket de R2, secretos, y sus propias apps de Meta, TikTok y X). **No se despliega nada:** desplegar es del operador (D8 de F8).
- **Archivos principales:** `fly.toml`, `.github/workflows/deploy.yml`, `docs/10-despliegue.md`
- **Hecho cuando:**
  - [ ] sin parámetros, el flujo despliega la instancia de hoy igual que antes (mismo `app`, mismo Environment, mismos guardias de la CI)
  - [ ] la guía de la segunda instancia está escrita y revisada por el `arquitecto`
  - [ ] `pnpm check` (o la CI) pasa

### F9-T26 · TikTok (video como borrador)
- **Depende de:** T07, T10 (S6: verificación obligatoria antes de publicar de verdad, no antes de construir; decisión del operador 2026-10-20)
- **Descripción:** OAuth (Login Kit) con refresco que rota, publisher en modo *Upload* (`video.upload`, `FILE_UPLOAD` por partes desde R2), estado asíncrono (consulta o webhook), traspaso a mano (`awaiting_manual_confirm`) hasta que el operador pega el enlace, variante de video para TikTok, `accounts connect tiktok`.
- **Archivos principales:** `packages/publishers/src/tiktok/*`, `apps/api/src/routes/oauth.ts`
- **Hecho cuando:**
  - [ ] contratos con `msw`: init, subida por trozos en orden, estados `PROCESSING_UPLOAD` / `SEND_TO_USER_INBOX` / `FAILED`, límite de envíos pendientes (5 por 24 h) y refresh que rota
  - [ ] en `dry-run` no se llama a TikTok; el `state` del OAuth es de un solo uso
  - [ ] `pnpm check` pasa

## 6. Criterios de aceptación de la fase
1. Las dos marcas (personal y AgentPey) existen, sin propiedades en el panel, cada una con su perfil editorial y sus cuentas.
2. Se crea un post, se suben medios, la IA redacta un texto por red (e idioma) que cumple el largo, el escape y las reglas, y el operador lo edita y lo aprueba.
3. Un post programado se publica en Instagram, Discord y X con el Mac apagado (servidor de F8, con el worker encendido: hoy está en modo demo con el worker apagado y dejarlo siempre encendido es decisión del operador, `docs/10-despliegue.md` paso 11), con la misma bitácora que un aviso; LinkedIn y TikTok dejan el texto o el video listo y el operador confirma.
4. En `dry-run` ninguna red recibe nada; en `live`, solo con instrucción explícita.
5. Una publicación con resultado dudoso queda `outcome_unknown`, no se reintenta sola, y se resuelve en un paso.
6. El plan propone ideas con fecha para un período, sin repetir temas, sin cifras ni clientes que no estén en el perfil, y sin crear textos ni publicaciones hasta aceptar.
7. Ninguna idea de la IA se publica sin aprobar y programar (o publicar) a mano.
8. Los avisos de F1 a F8 funcionan igual: sus tests pasan sin cambiar sus aserciones.
9. Un corredor o marca no ve posts, perfiles ni cuentas de otra (tabla de permisos y su test).
10. El gasto de IA (avisos, posts y planes) y el de X quedan anotados y se respetan los topes.
11. `pnpm check` y la CI pasan.

## 7. Plan de demo
1. `agentsales brand edit` en la marca AgentPey: idiomas, líneas de contenido y tres hechos.
2. `agentsales plan --days 14`: 8 ideas con fecha. Descartas dos, aceptas tres.
3. `post show`: los textos por red e idioma de una idea aceptada; editas el de X y el de LinkedIn; el panel marca un enlace en X y avisa que cuesta más.
4. Subes una foto; apruebas Instagram y Discord; programas dentro de unos minutos.
5. `agenda` muestra lo programado junto a un aviso; llega la hora y se publica en Instagram y Discord (en `dry-run`: solo el registro).
6. Con tu instrucción, repites en `live` en un servidor de Discord y una cuenta de prueba.
7. `publications` muestra el estado y los enlaces; una publicación con corte simulado queda en `outcome_unknown` y la resuelves.
8. LinkedIn deja el texto listo; lo publicas tú y confirmas con el enlace.
9. `usage` muestra el gasto de IA por marca.

## 8. Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| La app de Meta en desarrollo no muestra lo publicado a quien no tiene rol (`instagram-contenido-propio.md` §5) | Prueba S1 antes de publicar de verdad en Instagram (T13 se construye antes, contra simulaciones; decisión del operador 2026-10-20); si falla, Instagram espera la aprobación de F8 |
| Los términos de LinkedIn prohíben "automatizar publicaciones" | Modo `manual` por defecto (P1) y consulta a LinkedIn (S3); sin navegador automatizado |
| La IA inventa datos de la marca | Solo `facts` y un brief escrito por el operador; `checkPostContent` bloquea cifras y nombres ajenos; `eval:social` (T22); el humano aprueba |
| X cobra más de lo previsto o suspende la cuenta por automatización | `spendLimitUsd` de US$10, el aviso de costo por enlace, tope en la consola de X, publicar solo posts aprobados y declarar la cuenta si X lo pide |
| Un mensaje se publica dos veces (Discord, X) | El progreso "enviando" y `outcome_unknown`: nunca se reintenta tras un corte sin saber (ADR-0029, punto 8) |
| La generalización rompe los avisos | T01 a T08 sin cambiar las aserciones de los tests existentes; migración probada con datos; revisión del `arquitecto` en cada lote |
| Volver atrás una versión desplegada rompe la lectura de filas nuevas | Documentado en `10-despliegue.md`; las migraciones son solo aditivas |
| El token de LinkedIn vence cada 60 días y nadie lo nota | Clase "token por vencer" en la agenda, 7 días antes |
| El alcance es grande para una fase | Los lotes se pueden cerrar por separado: A y B dejan un gestor manual; cada red del lote C es independiente; E es el último y se puede mover a F10 |
| Cuentas personales o de marca restringidas por las redes | Cuentas de prueba en las pruebas de entrada, ritmo bajo y publicación solo con aprobación humana |
| El App Review de Meta no está enviado y tarda unas 5 semanas: mientras, los corredores son evaluadores y puede que el público no vea lo publicado | Prueba S1 antes de publicar de verdad en Instagram; la verificación del negocio con Certilink SpA ya está en marcha y sirve también a la app de anuncios del piloto |
| TikTok pide auditoría para publicar en público y puede rechazarla si la app solo atiende al operador | F9 solo usa el modo borrador; la auditoría se presenta con el piloto, que es el caso de uso real |

## 9. Preguntas abiertas
- [x] **P1 · LinkedIn** (respondida 2026-10-19): perfil personal a mano; se escribe a LinkedIn por el §3.1(26) y se pasa a API solo si lo permiten. La página de AgentPey queda para cuando exista la organización.
- [x] **P2 · X** (respondida 2026-10-19): enlaces permitidos y marcados, tope de US$10 al mes.
- [x] **P3 · Instagram** (respondida 2026-10-19): la prueba S1 la hace el operador cuando llegue el momento.
- [x] **P4 · Idiomas** (respondida 2026-10-19, la recomendación): cada idea sale como **dos posts separados**, uno por idioma, espaciados unas horas (6 h por defecto) en la misma cuenta.
- [x] **P5 · Discord** (respondida 2026-10-19, la recomendación): un servidor de pruebas privado que crea el operador para S5; si el reel supera 20 MiB, va un enlace.
- [x] **P6 · TikTok** (respondida 2026-10-19): solo video y como borrador en F9; el operador tiene cuentas personales de TikTok y un dominio propio para el piloto.

## 10. Registro de cambios del spec
| Fecha | Cambio |
|---|---|
| 2026-10-19 | Borrador: alcance acordado con el operador (para él y AgentPey, clientes después; la IA propone temas y calendario; las cuatro redes de una vez; spec ahora y código al cerrar F8) y notas de integración de X, LinkedIn, Discord e Instagram para contenido propio |
| 2026-10-19 | Revisión del `arquitecto` (11 bloqueantes, aplicados): la migración de enums solo con `ALTER TYPE … ADD VALUE` (la `0006` se detiene con filas) y volver atrás documentado; el resultado dudoso se llama `outcome_unknown` (el `needs_review` de la agenda ya existe) con el progreso "enviando" y sin reintento ciego; el traspaso a mano generalizado por cuenta (LinkedIn); el access token de X al publicar; credenciales por plataforma y redactor de la URL del webhook; el gasto de IA de posts y planes dentro del tope; las corridas de posts fuera de `content.prepare` y del reintento de `auto_publish`; `plan_runs` junto con `posts`; la clase de agenda "token por vencer" (no existía); tareas partidas (T01 a T08), sin tarjeta de texto y con el registro de subidas de posts. Además: índices, unique por idioma, `cost_usd`, `brief_origin`, PKCE en la cookie firmada, permisos `posts.manage`, reglas aviso/post por `kind`, `social:smoke` en `CLAUDE.md`, el borrado de Meta sin tocar `posts` ni `contents`, y las pruebas de entrada hechas a mano |
| 2026-10-19 | Respuestas del operador: LinkedIn a mano (P1), X con enlaces y tope de US$10 (P2), prueba de Instagram por el operador (P3) y dos idiomas por marca (P4, pendiente la forma de publicarlos) |
| 2026-10-19 | F8 cerró (`v1.0.0`): ADR renumerados (el 0028 lo tomó «el corredor conecta su propio Instagram»; los de este spec pasan a 0029 y 0030). Acuerdos con el operador: orden F9 → piloto con una oficina → organizaciones (§4.17), TikTok como borrador de video (D16, T26), posts en cualquier corredor, `kind` extensible, alcance siempre por `inScope`/`can`, credenciales que admiten tokens que no vencen y los permisos de anuncios en otra app de Meta (D13). Anuncios, dinero y leads quedan como borradores ADR-0031 a ADR-0033 |
| 2026-10-19 | **Aprobado por el operador**: el plan tal como está; tres entregas (D20, §5.1); ejecución en paralelo con agentes en worktrees y la CI como juez (D21, §5.2); P4 y P5 con las recomendaciones; la decisión de arquitectura D19 (una instancia ahora, dos del mismo código al llegar el primer cliente) y su tarea T27. ADR-0029 y ADR-0030 pasan a Aceptados |
| 2026-10-20 | Revisión de F9-T10: §4.2 suma las reglas de los posts (archivado no se edita, no se archiva con publicaciones pendientes, hasta 20 medios); F9-T17 suma el criterio del sha256 opcional sobre 100 MB (ADR-0025 punto 2); el video para X sale con la duración completa (su límite lo revisa T16) |
| 2026-10-20 | F9-T07: aclarado que una publicación de una cuenta en modo `manual` (LinkedIn) programada no es solo un recordatorio como Marketplace: a la hora el reloj la deja en `awaiting_manual_confirm`, lista para publicar a mano, sin llamar a la red |
| 2026-10-20 | Revisión de F9-T11: F9-T16 suma el criterio de la marca explícita del operador por post para un enlace en X (hasta T16, "marcar" es escribirlo en el brief del operador) |
| 2026-10-20 | Revisión de F9-T08: T12 suma el criterio de los comandos que la agenda ya sugiere para posts (incluido reintentar por id de publicación) |
| 2026-10-20 | F9-T17: el perfil editorial se edita en Mi marca y en la página de cada corredor (no hay `BrandPage.tsx`); sin sha256 (sobre 100 MB) cada pedido es una subida nueva y las `uploaded` cuentan en el tope de 20 medios; el worker las revisa al empezar `post.media` (`finalizePostUploads`); la respuesta de `complete` suma `uploaded` |
| 2026-10-20 | **Decisión del operador:** T13 (Instagram) y T14 (Discord) se construyen ya, contra simulaciones (`msw`); S1 y S5 pasan a ser verificación obligatoria **antes de cualquier publicación real**, no antes de construir (§4.8, dependencias de T13 y T14, §5.2 y riesgos). F9-T14: el video de Discord es la variante más liviana entre `x_video` e `ig_reel`, y si no cabe en 20 MiB sale solo el texto con una nota (sin enlace seguro todavía, §4.5 y D8); `social:smoke --platform discord` queda sin construir (S5 es a mano) |
| 2026-10-20 | **Decisión del operador:** LinkedIn (T15), X (T16) y TikTok (T26) también se construyen ya, contra simulaciones (`msw`); S2 y S3 (LinkedIn), S4 (X) y S6 (TikTok) pasan a ser verificación obligatoria **antes de cualquier publicación real**, no antes de construir (§4.8 y dependencias de T15, T16 y T26). S4 (X) y S6 (TikTok) quedan igual que S2 y S3: se verifican antes de publicar de verdad en X y TikTok, no antes de construir T16 y T26. F9-T15: el OAuth en `routes/oauth-linkedin.ts`, `accounts connect linkedin` abre el inicio del OAuth (el botón del panel, T17/T19), `accounts mode` cambia el modo, el `DELETE` existe en el cliente pero retirar sigue a mano hasta T19, y `social:smoke --platform linkedin` queda sin construir (S2 es a mano) |
| 2026-10-20 | F9-T19: consejos para cada error de las redes (con su prueba que lee el código), conectar LinkedIn, X y TikTok desde Cuentas del panel y Discord con el comando de la CLI, `connect.x` y `connect.tiktok` obligatorios en el contrato, retirar un post de LinkedIn borrándolo por la API (`publications retire --delete`, `Publisher.remove`) y la sección de F9 en la guía del operador |
| 2026-10-20 | F9-T20: el prompt del plan con versión propia (`PLAN_PROMPT_VERSION`, seguimiento en ADR-0030); una red que no sirve se le quita a la idea en vez de descartarla entera; ideas y `succeeded` en una transacción. Decisiones del operador en la revisión: al aceptar una idea se redacta solo para sus redes (`posts.platforms`, migración `0018`) y las descartadas dejan de bloquear un tema a los 60 días. Del `arquitecto`: un plan activo por marca con índice único parcial (`0018`), `post.draft` sin las redes que no sirven al tipo del post, `proposePlanIdeas` sin repositorios y `listPlanRuns` para T21 (§4.9, §4.10, §4.11 y F9-T21 al día) |
| 2026-10-20 | F9-T25: la etiqueta del cierre es `v1.3.0` (decía `v1.1.0`, la de la entrega 1) |
| 2026-10-20 | F9-T21: las rutas, la CLI y la pantalla Plan del plan de ideas; las redes del post mandan también al publicar y programar (`POST_PLATFORM_EXCLUDED`); `plannedSlots` cuenta las semanas completas del borde, leídas por rango de `planned_at` (§4.10 y F9-T21 al día) |
