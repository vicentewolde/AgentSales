# Spec F9.5 · Lista para mostrar

- **Estado:** Borrador (2026-10-22)
- **Rama base:** `main`, con F9 cerrada (`v1.3.0`)
- **Tag al cerrar:** `v1.4.0`
- **Referencias:** `docs/06-roadmap.md#f95`, `docs/specs/fase-9-contenido-de-marca.md` (deuda de su cierre), ADR-0016, ADR-0022, ADR-0028, ADR-0029, ADR-0030, `docs/01-arquitectura.md`, `docs/04-formato-publicaciones.md`, `docs/05-convenciones.md`, `docs/integraciones/x.md`, `discord.md`, `tiktok.md`, `instagram.md`, `mercadolibre.md`

## 1. Objetivo
Dejar AgentSales presentable y confiable para la **demo con la oficina del piloto el viernes 2026-10-30**, que el operador hace él mismo desde el servidor (`https://agentsales.agentpey.com`). En la demo muestra una propiedad que llega a Instagram, los posts de AgentPey con el plan de ideas, y el calendario con su seguimiento, y publica de verdad en sus cuentas (con su instrucción en el chat ese día). El panel debe verse como un producto terminado, hablar en el idioma de un corredor, mostrar cómo quedará cada publicación antes de aprobarla y no dejar nada «fallido» que en realidad no se sabe si salió. Los textos de la IA no deben sonar a IA, y el plan no debe repetir ideas ni elegir fechas y redes raras. Además se cierra la deuda interna de F9 que el operador pidió antes de la demo.

## 2. Alcance
**Lo que se ve en la demo**
- Un **sistema visual** del panel (colores, tipografía, espacios, botones, insignias de estado, tarjetas, tablas y estados vacíos) aplicado a todas las pantallas, sin dependencias nuevas.
- Una **portada** («Hoy») que resume lo pendiente, lo próximo y lo publicado.
- **Lenguaje claro** en estados, botones y mensajes, y los detalles vistos al cerrar F9: «Publicar» solo con algo por publicar, «simulación» solo cuando el servidor está en `dry-run`, un post de una imagen no dice «carrusel», y el panel del Mac responde también en `127.0.0.1`.
- **Vista previa** por red (foto y texto como se verán) antes de aprobar, en posts y en la sección Contenido de una propiedad.
- **«Salió / no salió» en Instagram y Portal:** su resultado dudoso pasa a `outcome_unknown` y se resuelve en un paso, también desde la sección Contenido de una propiedad.

**La IA**
- **Textos que no suenan a IA** en avisos y posts: sin clichés de vendedor ni muletillas típicas, con su verificación (advertencia en la revisión) y su contador en `eval:content` y `eval:social`.
- **Ideas variadas y fechas con sentido:** el plan descarta ideas parecidas entre sí, y el día, la hora y las redes de cada idea salen de la cadencia del perfil (código), no de la IA.

**Lo interno**
- X: el **tope de gasto atómico** y el **video sin bajarlo entero a memoria**.
- **Retirar borrando en X**; en TikTok, que no tiene cómo borrar por API, un mensaje que lo dice y manda a borrarlo a mano.
- **Video para Discord** que quepa en 20 MiB (una variante más liviana), en vez de publicar solo el texto.
- La CLI y el servidor de **versiones distintas** no fallan al leer un valor nuevo.
- **De quién es una cuenta** se decide en una sola función de core; el panel pide las cuentas con la marca del post.

## 3. Fuera de alcance
- La revisión de nombres propios con hechos estructurados por marca (deuda de F9): a F10, con las marcas de clientes.
- LinkedIn por la API: S2 y S3 son del operador (sin código; la cuenta sigue a mano).
- La revisión de Production de TikTok, el App Review de Meta y un dominio público de medios (`media.agentpey.com`): F10.
- El worker siempre encendido (decisión del operador: solo los días de demo; `docs/10-despliegue.md` paso 11).
- Rehacer la navegación o agregar pantallas nuevas fuera de la portada; modo oscuro; el panel en el celular más allá de que no se rompa.
- Todo lo de F10 (anuncios, leads, ManyChat) y F11 (organizaciones).

## 4. Diseño

### 4.1 Componentes afectados
- `apps/web`: tema de Tailwind, estilos globales, componentes base, el marco (navegación), la portada, etiquetas de estado, vista previa, la sección Contenido de una propiedad y el detalle de un post.
- `packages/core`: `OUTCOME_UNKNOWN_CODES`, la revisión editorial (muletillas), los prompts de avisos y posts, el plan de ideas (parecido y asignación de fechas y redes), retirar, la función de dueño de una cuenta.
- `packages/publishers`: X (tope, video en streaming, borrar), Instagram y Mercado Libre (resultado dudoso), Discord (variante liviana).
- `packages/media`: la variante de video para Discord.
- `packages/db`: la reserva atómica del gasto de X (si hace falta una consulta nueva; sin tablas nuevas, ver §4.3).
- `apps/api` y `apps/cli`: esquemas de respuesta tolerantes y la versión en una cabecera.
- `apps/worker`: `eval:content` y `eval:social`, `post.media` (la variante de Discord).

### 4.2 Contratos
- **`outcome_unknown`** en Instagram (`IG_PUBLISH_OUTCOME_UNKNOWN`) y Portal (`ML_PUBLISH_OUTCOME_UNKNOWN`): se suman a `OUTCOME_UNKNOWN_CODES`; `publications resolve` y su ruta ya existentes sirven para avisos. Sin estados nuevos.
- **Versión:** la API responde la cabecera `X-AgentSales-Version` (la de `package.json` raíz). La CLI la compara con la suya y, si difieren, avisa una vez por comando en stderr («la CLI es x.y.z y el servidor a.b.c»), sin fallar.
- **Esquemas de respuesta de la CLI:** los enums que vienen del servidor se leen con un valor de respaldo (`unknown`) en vez de fallar; se muestran tal como llegan.
- **`accountOwnedBy(account, broker)`** en core: única regla de «cuenta de la marca» para la lista de alta y el panel.
- **Prompts:** `CONTENT_PROMPT_VERSION`, `SOCIAL_PROMPT_VERSION` y `PLAN_PROMPT_VERSION` suben de versión.
- **Plan:** la IA propone tema, línea, formato, redes preferidas y el porqué; el código asigna fecha, hora y redes según la cadencia (seguimiento de ADR-0030, punto de las fechas).
- Sin rutas nuevas para la portada: usa `/agenda` y `/tracking` (si falta un dato, se agrega a esas respuestas de forma aditiva).

### 4.3 Datos
- Sin migraciones, salvo que la reserva atómica del gasto de X la necesite (T08 lo decide con el `arquitecto`; si hace falta, solo agrega).

### 4.4 Decisiones
- **D1 · Fecha fija y corte.** El código se integra hasta el **miércoles 2026-10-28**. El jueves 29 es el cierre (docs, `v1.4.0`) y el despliegue, que hace el operador. Si el miércoles alguna tarea de «Lo interno» (T08 a T12) no está integrada, pasa a F10 sin bloquear la demo: no se despliega nada a medias.
- **D2 · Sin dependencias nuevas.** El sistema visual se hace con Tailwind y componentes propios; la tipografía es la del sistema (sin fuentes externas) y los íconos, SVG en línea.
- **D3 · Muestra antes de aplicar.** T01 publica primero una pantalla de muestra (el marco, una lista y un detalle) para que el operador la vea; con su visto bueno (o su aprobación permanente) se aplica al resto.
- **D4 · «Simulación» por el modo del servidor.** Una publicación que todavía no empieza (`approved`, `failed` sin intento en curso) nace con `dryRun: true` como valor seguro; el panel no muestra ese valor sino el modo del servidor (`publishMode` de `/health`). Desde `scheduled` o `publishing`, muestra el modo fijado en la publicación. «Simulación» solo aparece en `dry-run`.
- **D5 · Vista previa genérica.** Imita la forma de cada red (foto, nombre de la cuenta, texto cortado donde la red lo corta, «ver más»), sin logos ni marcas de las redes.
- **D6 · Muletillas de IA como advertencia.** Una lista en core (español e inglés: «¡Descubre…!», «sumérgete», «no es solo X, es Y», «en el corazón de», «sin duda», exceso de signos de exclamación, guion largo como pausa, tríadas de adjetivos, etc.) que la revisión marca como advertencia, no como error: el operador decide.
- **D7 · El código pone las fechas del plan.** Las ranuras salen de la cadencia de cada red (días, horas, espacio y posts por semana), sin chocar con lo ya planificado. La IA solo ordena por preferencia. Dos ideas del mismo plan con 60 % o más de palabras en común: la segunda se descarta (`IDEA_TOO_SIMILAR`) y queda en el reporte.
- **D8 · Discord con variante liviana.** Si el video más liviano supera 20 MiB, el worker genera una variante `discord_video` con un bitrate calculado para quedar bajo 19 MiB según su duración (y 720p como máximo). Si aun así no cabe, sale el texto como hoy. No se abre un dominio público.
- **D9 · TikTok no se borra por API.** `retire --delete` en TikTok responde un mensaje claro: se borra a mano en la app y después `publications retire` sin `--delete`.
- **D10 · Ejecución en paralelo** como en F9: un agente por tarea en su worktree y su rama, como máximo 3 con código a la vez, sin tocar los mismos archivos calientes; la CI es el juez; el `revisor` revisa cada PR y el `arquitecto` los que tocan contratos (T04, T06, T08, T11, T12); solo el coordinador edita `docs/ESTADO.md`.
- **D11 · La portada reemplaza a «Estado».** `/` pasa a ser «Hoy»; la página de salud del sistema queda en `/estado`, en el menú del administrador.

## 5. Tareas
Orden de ejecución (D10): una tarea entra apenas se libera un cupo, en este orden. Entre paréntesis, la zona que la separa de las demás.

| Cupo | Tareas |
|---|---|
| Tanda 1 | T01 (web: base visual) · T05 (core: prompts y revisión) · T08 (X) |
| Tanda 2 | T02 (web: lenguaje y detalles) · T04 (core y web: resultado dudoso) · T06 (core: plan) |
| Tanda 3 | T03 (web: portada) · T07 (web: vista previa) · T09 (retirar) |
| Tanda 4 | T10 (Discord y media) · T11 (API y CLI: versiones) · T12 (dueño de la cuenta) |
| Jueves 29 | T13 (cierre, del coordinador) |

### F9.5-T01 · Sistema visual del panel
- **Depende de:** —
- **Descripción:** tokens de diseño en el tema de Tailwind (colores con un primario y un acento, grises, éxito, advertencia, error e información; tipografía del sistema con su escala; espacios y radios), estilos globales, y componentes base: botón (primario, secundario, peligro, fantasma; tamaños; cargando), insignia de estado, tarjeta, tabla, campo de formulario, aviso, estado vacío y encabezado de página. El marco del panel (navegación y cabecera) con el nombre AgentSales y el corredor o marca activa. Primero una muestra (D3); después, aplicarlo a todas las páginas sin cambiar su comportamiento.
- **Archivos principales:** `apps/web/src/index.css` (hoy solo `@import "tailwindcss"`: Tailwind v4 sin `@theme`), `apps/web/src/components/ui/` (nuevo), `apps/web/src/layout/Layout.tsx` (`MENU`, `LayoutBody`), `apps/web/src/labels.ts` (los `*_TONE`), `components/StatusBadge.tsx`, `RunStatusBadge.tsx`, `ErrorAlert.tsx`, y las páginas de `apps/web/src/pages/` (unos 10 archivos definen hoy sus propias clases `PRIMARY`/`SECONDARY`, por ejemplo `components/content/ContentSection.tsx:20`)
- **Hecho cuando:**
  - [ ] la muestra está publicada para el operador antes de aplicar a todo
  - [ ] todas las páginas usan los componentes base; no quedan botones ni insignias con estilos sueltos
  - [ ] las pruebas existentes del panel pasan sin cambiar sus aserciones de comportamiento (solo selectores, si hace falta)
  - [ ] se ve bien a 1280 px y no se rompe a 390 px
  - [ ] `pnpm check` pasa (CI)

### F9.5-T02 · Lenguaje claro y los detalles de F9
- **Depende de:** T01
- **Descripción:** un solo lugar con las etiquetas de estados, formatos y errores frecuentes en lenguaje de corredor; «Publicar» solo con algo por publicar; «simulación» según D4; un post de una imagen en Instagram dice «imagen», no «carrusel»; el servidor de Vite escucha en `127.0.0.1` (sirve también `localhost` en el navegador).
- **Archivos principales:** `packages/core/src/labels.ts` (`PUBLICATION_STATUS_TEXT`, `PUBLICATION_FORMAT_TEXT` l.151 —«carrusel» para todo `post`—, `publicationModeText` l.170), `apps/web/src/components/publications/publications.ts` (`publishButtonText`), `PublicationItem.tsx` (l.178, 260, 358, 364), `PublicationsPanel.tsx`, `components/posts/PostPublishing.tsx` (`PostPublishBar` l.108, `PublicationRow` l.354-363), `components/posts/labels.tsx`, `components/content/Preview.tsx:49`, `apps/web/vite.config.ts` (`server.host`). **Nota:** toda publicación nace con `dryRun: true` (`packages/db/src/repositories/publications.ts:210`) y el modo real se fija al pasar a `publishing`/`scheduled` (`requirePublicationMode`, `core/src/publication.ts:187`): antes de eso el panel muestra el modo de `/health` (`useFreshPublishMode`)
- **Hecho cuando:**
  - [ ] cada estado de publicación y de post tiene su etiqueta clara, con un test que recorre todos los valores del enum
  - [ ] el botón Publicar no aparece sin publicaciones pendientes (test)
  - [ ] con `PUBLISH_MODE=live` una aprobada no dice «simulación» (test)
  - [ ] un post de una imagen dice «imagen» (test)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T03 · La portada «Hoy»
- **Depende de:** T01, T02
- **Descripción:** la página de inicio del panel con tres bloques: **te toca** (lo de la agenda que pide acción: resultado dudoso, por aprobar, a mano, fallas), **próximas** (lo programado de los próximos 7 días, avisos y posts) y **publicado hace poco** (con su enlace). Cada fila lleva a su detalle. Vacíos amables.
- **Archivos principales:** `apps/web/src/pages/HomePage.tsx` (nueva; `/` hoy es `StatusPage`, que pasa a `/estado`), `apps/web/src/routes.tsx`, `Layout.tsx` (`MENU`), `queries/tracking.ts` (`useAgenda`, `useTracking`), `queries/calendar.ts`; si falta un dato, `apps/api/src/routes/tracking.ts` y `contracts/index.ts` (aditivo)
- **Hecho cuando:**
  - [ ] la portada muestra los tres bloques con datos de `/agenda` y `/tracking` (test con datos simulados)
  - [ ] un corredor ve solo lo suyo (el alcance de las rutas que usa)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T04 · «Salió / no salió» en Instagram y Portal
- **Depende de:** —
- **Descripción:** `IG_PUBLISH_OUTCOME_UNKNOWN` y `ML_PUBLISH_OUTCOME_UNKNOWN` pasan a `outcome_unknown` (sin reintento solo), la agenda los muestra como «resultado dudoso», y la sección Contenido de una propiedad tiene los botones «Salió» (con el enlace opcional) y «No salió», como los posts.
- **Archivos principales:** `packages/core/src/publish/outcome.ts` (`OUTCOME_UNKNOWN_CODES` l.23 y su comentario), `publish/error-advice.ts:109`, `use-cases/publish-publication.ts` (~l.442), `packages/publishers/src/instagram/errors.ts:203` y `mercadolibre/errors.ts:405` (solo si hace falta), `apps/web/src/components/publications/PublicationItem.tsx` y `PublicationsPanel.tsx` (la caja de resolver, reutilizando o moviendo `OutcomeBox` de `components/posts/PostPublishing.tsx:252`), `queries/` de publicaciones de avisos (acción `resolve` sobre `POST /publications/:id/resolve`, que ya existe)
- **Hecho cuando:**
  - [ ] un corte simulado de Instagram y otro de Mercado Libre dejan `outcome_unknown` (tests con `msw`)
  - [ ] resolver «salió» y «no salió» desde el panel de una propiedad (test)
  - [ ] el seguimiento de F9 (criterio 5) queda completo en el spec de F9 y en `docs/ESTADO.md`
  - [ ] `pnpm check` pasa (CI)

### F9.5-T05 · Textos que no suenan a IA
- **Depende de:** —
- **Descripción:** reescribir las instrucciones de estilo de los prompts de avisos (Instagram, Portal, Marketplace) y de posts (cada red) para que suenen a una persona: frases concretas, sin clichés de vendedor ni muletillas (D6), menos signos de exclamación y emojis, hashtags medidos. La lista de muletillas en core, con su advertencia en la revisión y su contador en `eval:content` y `eval:social`. Las versiones de los prompts suben.
- **Archivos principales:** `packages/core/src/content/prompt.ts` (`CONTENT_SYSTEM_PROMPT`, versión `listing-content-v2`), `content/check.ts` (`checkContent`), `packages/core/src/social/prompt.ts` (`SOCIAL_SYSTEM_PROMPT`, versión `social-post-v1`), `social/check.ts`, `packages/core/src/content/ai-tells.ts` (nuevo: la lista y su detector), `apps/worker/src/eval/run-eval.ts` y `run-social-eval.ts` (`SocialEvalCounts`), `docs/04-formato-publicaciones.md`
- **Hecho cuando:**
  - [ ] la revisión marca como advertencia un texto con muletillas, en español e inglés (tests)
  - [ ] `eval:content` y `eval:social` cuentan las muletillas (tests con `fake`)
  - [ ] `docs/04-formato-publicaciones.md` dice las reglas nuevas
  - [ ] `pnpm check` pasa (CI)

### F9.5-T06 · Ideas variadas y fechas con sentido
- **Depende de:** — (si T05 ya está integrada, parte de ella; si no, toca solo el prompt del plan)
- **Descripción:** el prompt del plan pide ideas con ángulos y formatos distintos y deja de pedir fecha y hora; el código asigna las ranuras con la cadencia (D7) y las redes según la cadencia y el formato (`kindProblem`); las ideas parecidas se descartan (`IDEA_TOO_SIMILAR`). `PLAN_PROMPT_VERSION` sube. Seguimiento en ADR-0030.
- **Archivos principales:** `packages/core/src/social/plan-prompt.ts` (`PLAN_SYSTEM_PROMPT`, regla 6), `social/plan.ts` (`ideaShape` l.365 —sin `fecha` ni `hora`—, `buildPlanBrief` l.318, `plannedSlots` l.262, `checkPlanIdeas` l.517, `platformProblem`), `social/plan-slots.ts` (nuevo: las ranuras), `social/plan-sample.ts`, `use-cases/run-plan.ts` (~l.270), `apps/worker/src/eval/run-social-eval.ts` (`similarTopics`, que pasa a core), ADR-0030 (seguimiento)
- **Hecho cuando:**
  - [ ] las fechas y horas de un plan caen siempre en las ranuras de la cadencia, sin dos ideas en la misma ranura ni sobre lo ya planificado (tests)
  - [ ] dos ideas parecidas: la segunda se descarta con `IDEA_TOO_SIMILAR` (test)
  - [ ] una idea de video no cae en una red sin video, ni una de texto en Instagram (test)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T07 · Vista previa por red
- **Depende de:** T01
- **Descripción:** un componente de vista previa para Instagram (imagen, carrusel y reel), X, LinkedIn, Discord, TikTok, Portal y Marketplace (D5), en el detalle del post (por red e idioma) y en la sección Contenido de una propiedad, con la primera foto o la portada y el texto como se cortará.
- **Archivos principales:** `apps/web/src/components/preview/` (nuevo: una vista por red), `components/content/Preview.tsx` (`InstagramPanel`, `ListingPanel`), `components/content/MarketplacePanel.tsx`, `components/posts/PostTexts.tsx` (`Preview` local l.75, que se reemplaza), `content/caption.ts`
- **Hecho cuando:**
  - [ ] cada red tiene su vista previa con el texto y el medio correctos (tests)
  - [ ] la vista previa se actualiza al editar el texto
  - [ ] `pnpm check` pasa (CI)

### F9.5-T08 · X: tope de gasto atómico y video en streaming
- **Depende de:** —
- **Descripción:** el gasto de una publicación de X se reserva de forma atómica antes de llamar a X (una sola sentencia que suma solo si cabe bajo `spendLimitUsd`) y se libera si no se publicó; el video se sube a X por partes leyendo de R2 como stream, sin cargarlo entero.
- **Archivos principales:** `packages/core/src/use-cases/publish-publication.ts` (`requireXBudget` l.807), `core/src/x/cost.ts`, `packages/db/src/repositories/publications.ts` (`setCostUsd` l.556, `sumCostUsdSince` l.578; una reserva condicional nueva), el puerto de publicaciones en core, `packages/publishers/src/x/publisher.ts` (`downloadXMedia` l.139: `arrayBuffer` l.167) y `x/api.ts` (`uploadVideo` l.198, partes de 4 MB)
- **Hecho cuando:**
  - [ ] dos publicaciones simultáneas de la misma cuenta no pasan el tope (test de repositorio con PGlite)
  - [ ] el video se sube por partes sin un `Buffer` del archivo entero (test con `msw`)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T09 · Retirar borrando en X (y el mensaje de TikTok)
- **Depende de:** —
- **Descripción:** `Publisher.remove` en X con `DELETE /2/tweets/:id` y `ensureRotatingAccessToken` en retirar; TikTok responde D9.
- **Archivos principales:** `packages/core/src/use-cases/retire-publication.ts` (`removeRemote` ~l.160: hoy rechaza X y TikTok en l.176 por usar solo el token guardado; pasa a `ensureRotatingAccessToken`, `use-cases/ensure-access-token.ts:378`), `packages/publishers/src/x/publisher.ts` y `x/api.ts` (`deletePost`, como `deleteLinkedInPost` en `linkedin/publisher.ts:429`), `apps/api/src/portal.ts:22` (`createApiOperations`: X), `core/src/publish/error-advice.ts` (el mensaje de TikTok)
- **Hecho cuando:**
  - [ ] `publications retire --delete` en X borra el post (test con `msw`) y solo en `live`
  - [ ] en TikTok el mensaje dice que se borra a mano (test)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T10 · Video para Discord que quepa
- **Depende de:** —
- **Descripción:** la variante `discord_video` (D8) en `packages/media` y en `post.media` cuando el post va a Discord y el video más liviano supera 20 MiB; el publisher la usa.
- **Archivos principales:** `packages/media/src/pipeline.ts` (`DISCORD_VIDEO_SPEC`, junto a `X_VIDEO_SPEC` l.62), `packages/media/src/video.ts` (`processVideo` l.335, `encodeXVideo` l.291, `probe`), `packages/core/src/enums.ts:142` (`PROCESSED_MEDIA_VARIANTS`, `VIDEO_MEDIA_VARIANTS`: archivo caliente), `core/use-cases/process-post-media.ts` (~l.183), `core/use-cases/open-publications.ts:204` (`discordVideo`), `packages/publishers/src/discord/publisher.ts:66` (`discordAttachments`)
- **Hecho cuando:**
  - [ ] un video largo genera una variante bajo 20 MiB (test con un video generado por ffmpeg)
  - [ ] el publisher adjunta la variante (test con `msw`); si no hay, sale el texto como hoy
  - [ ] `pnpm check` pasa (CI)

### F9.5-T11 · CLI y servidor de versiones distintas
- **Depende de:** —
- **Descripción:** cabecera `X-AgentSales-Version` en la API; la CLI avisa la diferencia (§4.2) y lee los enums de las respuestas con respaldo.
- **Archivos principales:** `apps/api/src/app.ts` (middleware de la cabecera), `apps/cli/src/api-client.ts` (`unwrap` l.162: hoy un enum nuevo da `UNEXPECTED_RESPONSE`), los esquemas que la CLI usa de `apps/api/src/contracts/index.ts` (`ONBOARDING_STEPS` l.1265, `owner` l.1268, `PUBLICATION_STATUSES`, `AGENDA_KINDS`, `AGENDA_ACTIONS`, `CONTENT_CHECK_CODES`, `POST_STATUSES`, `POST_KINDS`, `BROKER_KINDS`, `TOKEN_REFRESH_SKIP_REASONS`): una variante tolerante para la CLI, sin aflojar la validación de las entradas de la API
- **Hecho cuando:**
  - [ ] una respuesta con un valor de enum nuevo no hace fallar la CLI (tests)
  - [ ] la CLI avisa una vez cuando las versiones difieren (test)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T12 · De quién es una cuenta
- **Depende de:** —
- **Descripción:** `accountOwnedBy` en core usada por la lista de alta y el panel; el detalle del post pide las cuentas con la marca del post, no con la del selector.
- **Archivos principales:** `packages/core/src/onboarding.ts` (l.66 y l.69), `packages/core/src/accounts/owner.ts` (nuevo), `apps/web/src/components/posts/PostPublishing.tsx` (`platformsWithoutAccount` l.65 y `useAccounts(useBrokerFilter())` l.125, que pasa a pedir las cuentas de `post.brokerId`), `apps/web/src/pages/AccountsPage.tsx:106`
- **Hecho cuando:**
  - [ ] la lista de alta y el panel usan la misma función (tests)
  - [ ] el administrador con otro corredor en el selector ve activas las redes del post (test)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T13 · Cierre
- **Depende de:** T01 a T07 (T08 a T12 si se integraron)
- **Descripción:** docs al día, `CHANGELOG [1.4.0]`, `docs/ESTADO.md`, roadmap, la etiqueta `v1.4.0` con permiso del operador y la guía de la demo (§7).
- **Hecho cuando:**
  - [ ] los criterios de §6 verificados
  - [ ] el operador tiene la guía paso a paso de la demo

## 6. Criterios de aceptación de la fase
1. Todas las pantallas del panel usan el mismo sistema visual y la portada resume el día.
2. Ningún estado, botón o mensaje del recorrido de la demo usa palabras técnicas; «simulación» aparece solo en `dry-run`.
3. Antes de aprobar se ve cómo quedará la publicación en cada red.
4. Un resultado dudoso en Instagram o Portal queda `outcome_unknown` y se resuelve desde el panel.
5. Los textos de la IA no tienen muletillas en `eval:content` y `eval:social` con la IA real (medición del operador o de Claude con su permiso), y el plan no repite ideas ni pone fechas fuera de la cadencia.
6. Los avisos y posts de F1 a F9 funcionan igual: sus tests pasan.
7. `pnpm check` y la CI pasan.

## 7. Plan de demo (viernes 2026-10-30, en el servidor)
Antes (jueves 29, el operador): desplegar; crear su corredor para propiedades y conectarle `@vicentewoldec`; cargar la propiedad de ejemplo; encender el worker el viernes; pasar a `live` solo durante la demo y volver a `dry-run`.
1. Entrar al panel: la portada «Hoy».
2. Propiedad: cargar la de ejemplo, preparar (fotos, portada, reel y textos), ver la vista previa de Instagram, aprobar y publicar (en `live`, con la instrucción del operador).
3. AgentPey: pedir un plan de 14 días, aceptar dos ideas, ver sus textos y su vista previa, aprobar y programar uno en unos minutos.
4. Calendario: lo programado junto a la propiedad; llega la hora y sale solo.
5. Seguimiento: la portada y la agenda con lo publicado y su enlace.

## 8. Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| Poco tiempo: 12 tareas en unos 4 días hábiles | Tres agentes en paralelo; lo interno al final con corte el miércoles (D1); el coordinador prioriza lo visible |
| El rediseño rompe una pantalla justo antes de la demo | T01 sin cambiar comportamiento; las pruebas del panel como red; recorrido de la demo en el Mac antes de desplegar |
| Dos tareas del panel chocan en los mismos archivos | T01 primero; T02, T03 y T07 en zonas distintas; merges cortos y frecuentes |
| La publicación programada con el Mac apagado nunca se probó (criterio 3 de F9) | Recomendado: una prueba corta el jueves 29 tras desplegar (programar un post en simulación y ver que sale a su hora) |
| Publicar de verdad en la demo | Solo con la instrucción del operador en el chat; `live` solo durante la demo |
| Los prompts nuevos empeoran algo que hoy funciona | Las versiones suben; `eval:content` y `eval:social` con `fake` en la CI y una corrida real antes de desplegar |

## 9. Preguntas abiertas
- (respondidas en la entrevista del 2026-10-22: demo del operador desde el servidor el viernes 30, con publicaciones reales en sus cuentas; propiedades con un corredor nuevo suyo conectado a `@vicentewoldec` y una propiedad de ejemplo que borra después; posts con AgentPey; worker solo los días de demo; lo interno también antes de la demo; sin ensayo general)

## 10. Registro de cambios del spec
| Fecha | Cambio |
|---|---|
| 2026-10-22 | Borrador tras la entrevista con el operador; alcance y nombre aprobados por él |
