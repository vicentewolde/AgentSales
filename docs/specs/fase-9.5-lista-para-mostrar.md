# Spec F9.5 · Lista para mostrar

- **Estado:** **Cerrado** el 2026-10-22 (`v1.4.0`, la etiqueta con permiso del operador). **Aprobado** el 2026-10-22 por el operador (revisado por el `arquitecto`; ADR-0034 nuevo)
- **Rama base:** `main`, con F9 cerrada (`v1.3.0`)
- **Tag al cerrar:** `v1.4.0`
- **Referencias:** `docs/06-roadmap.md#f95`, `docs/specs/fase-9-contenido-de-marca.md` (deuda de su cierre), ADR-0011, ADR-0016, ADR-0022, ADR-0028, ADR-0029, ADR-0030, ADR-0034 (nuevo), `docs/01-arquitectura.md`, `docs/04-formato-publicaciones.md`, `docs/05-convenciones.md`, `docs/integraciones/x.md`, `discord.md`, `tiktok.md`, `instagram.md`, `mercadolibre.md`

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
- **`outcome_unknown`** en Instagram (`IG_PUBLISH_OUTCOME_UNKNOWN`) y Portal (`ML_PUBLISH_OUTCOME_UNKNOWN`): se suman a `OUTCOME_UNKNOWN_CODES`; `publications resolve` y su ruta ya existentes sirven para avisos, con tres ajustes para Portal (revisión del `arquitecto`, B1): `parsePublishedUrl` reconoce el enlace de Portal o Mercado Libre y saca el id del ítem (`MLC-?\d+` → `MLC\d+`) para `external_id`; en `live`, «salió» en Portal exige el enlace o el id; y al resolver «salió» en Portal la ruta encola `publication.sync` (para `remote_state` y el vencimiento). Los mensajes y consejos de IG y ML dicen «Salió / No salió» (no «descártala», que con `outcome_unknown` da `OUTCOME_UNKNOWN_PENDING`), y en Portal con varios ítems («many») piden cerrar a mano los sobrantes antes de decir «no salió». Sin estados nuevos.
- **Versión:** la API responde la cabecera `X-AgentSales-Version` (la de `package.json` raíz). La CLI la compara con la suya y, si difieren, avisa una vez por comando en stderr («la CLI es x.y.z y el servidor a.b.c»), sin fallar.
- **Respuestas con un valor nuevo (B5):** `contracts/index.ts` **no cambia** (aflojarlo cambiaría los tipos del panel). En la CLI, `unwrap` (`apps/cli/src/api-client.ts`) acepta el cuerpo cuando **todos** los errores de validación son `invalid_value` de un enum, y avisa una vez en stderr; las etiquetas de la CLI usan `TEXT[v] ?? v`, así el valor nuevo se muestra tal como llega. Seguimiento en ADR-0011.
- **`accountOwnedBy(account, brokerId)`** en core: única regla de «cuenta de la marca» para la lista de alta y el panel. Dice de quién es la cuenta; **no es un control de acceso** (ese sigue en `inScope`/`can`, ADR-0029 punto 13).
- **Prompts:** `CONTENT_PROMPT_VERSION`, `SOCIAL_PROMPT_VERSION` y `PLAN_PROMPT_VERSION` suben de versión.
- **Plan:** la IA propone tema, línea, formato, redes preferidas y el porqué; el código asigna fecha, hora y redes según la cadencia (D7, **ADR-0034**, que modifica ADR-0030 punto 2 y su seguimiento de F9-T20). `PLAN_DISCARD_CODES` solo crece: `IDEA_TOO_SIMILAR` y `NO_SLOT` se agregan al final y los códigos actuales se quedan (los reportes guardados se leen con `z.enum`).
- Sin rutas nuevas para la portada: usa `/agenda` (que ya trae «próximas» a 7 días) y `/tracking`; `trackingPublicationSchema` suma `publishedAt` de forma aditiva (seguimiento en ADR-0011).
- **`publicationFormatText`** (`core/labels.ts`) recibe el número de medios: un `post` de Instagram con un medio es «imagen» y con varios, «carrusel» (panel y CLI).
- **Retirar en X** (`Publisher.remove`) con el token que rota: la API compone el renovador de X y lo usa con `withCredentialsLock` (seguimiento en ADR-0029, que en F9-T19 decía que borrar no servía para X/TikTok).

### 4.3 Datos
- **Sin migraciones.** La reserva de gasto de X usa un candado sobre la fila de la cuenta (T08). `discord_video` es un valor nuevo de `media.variant`, que es `text` en la base (el índice único `(parent_media_id, variant)` sirve igual): solo cambia `PROCESSED_MEDIA_VARIANTS` en core.
- **Volver atrás** a la imagen de `v1.3.0` después de `v1.4.0`: una fila con `discord_video`, `outcome_unknown` en un aviso o un código nuevo del reporte del plan haría fallar la lectura de la versión vieja (ADR-0029, Consecuencias). `docs/10-despliegue.md` lo dice.

### 4.4 Decisiones
- **D1 · Fecha fija y corte.** El código se integra hasta el **miércoles 2026-10-28**. El jueves 29 es el cierre (docs, `v1.4.0`) y el despliegue, que hace el operador. Si el miércoles alguna tarea de «Lo interno» (T08 a T12) no está integrada, pasa a F10 sin bloquear la demo: no se despliega nada a medias.
- **D2 · Sin dependencias nuevas.** El sistema visual se hace con Tailwind y componentes propios; la tipografía es la del sistema (sin fuentes externas) y los íconos, SVG en línea.
- **D3 · Muestra antes de aplicar.** T01 publica primero una pantalla de muestra (el marco, una lista y un detalle) para que el operador la vea; con su visto bueno (o su aprobación permanente) se aplica al resto.
- **D4 · «Simulación» por el modo del servidor.** Toda publicación nace con `dryRun: true` como valor seguro. El panel muestra el **modo del servidor** (`publishMode` de `/health`) solo en `approved`, `cancelled` sin intento y `failed` que no empezó en vivo (`hasStartedLive`, `core/src/publication.ts:206`); en todos los demás estados (`scheduled`, `publishing`, `published`, `paused`, `unpublished`, `outcome_unknown`, `awaiting_manual_confirm` y `failed` que empezó en vivo, que queda bloqueada en vivo), el **modo fijado** en la publicación. «Simulación» solo aparece cuando el modo que corresponde es `dry-run`.
- **D5 · Vista previa genérica.** Imita la forma de cada red (foto, nombre de la cuenta, texto cortado donde la red lo corta, «ver más»), sin logos ni marcas de las redes.
- **D6 · Muletillas de IA como advertencia.** Una lista en core (español e inglés: «¡Descubre…!», «sumérgete», «no es solo X, es Y», «en el corazón de», «sin duda», exceso de signos de exclamación, guion largo como pausa, tríadas de adjetivos, etc.) que la revisión marca como advertencia, no como error: el operador decide.
- **D7 · El código pone las fechas y las redes del plan (ADR-0034).** La IA devuelve las ideas **en orden de preferencia**, cada una con sus redes preferidas y su formato, sin fecha ni hora. El código, idea por idea en ese orden:
  1. **Redes candidatas** = preferidas por la IA ∩ las pedidas en el plan ∩ las que sirven al formato (`kindProblem`). Una red pedida con 0 posts por semana no es candidata y sale con `OUT_OF_CADENCE`.
  2. **Ranuras** de cada red: los días y horas de su cadencia dentro del período, respetando posts por semana y como máximo `ceil(posts por semana / días)` posts por día en la red (la cadencia no tiene un campo de espacio), y sin chocar con lo ya planificado (`plannedSlots`) ni con lo asignado antes en el mismo plan. Una red **sin cadencia** usa los días hábiles a las 10:00 (hora de Chile) con un post por semana; una red con cadencia pero con **días u horas vacíos** toma de la ranura por defecto lo que le falta y conserva sus posts por semana.
  3. **La ranura de la idea** es la más temprana libre entre las candidatas, repartiendo por semana (primero las semanas con menos ideas, contando las ideas del plan y lo ya planificado de la marca); la idea queda en esa fecha y hora, y sus redes son las candidatas que tienen esa ranura libre en su cadencia. Las demás candidatas se le quitan (como hoy, al reporte).
  4. **Sin ranura libre** en ninguna candidata: la idea se descarta con `NO_SLOT`.
  Antes de asignar, dos ideas del mismo plan con 60 % o más de palabras de tema en común: la segunda se descarta con `IDEA_TOO_SIMILAR` (la medida `topicSimilarity` pasa de `eval:social` a core).
- **D8 · Discord con variante liviana.** Si el post va a Discord (`postPublishesOn(post, "discord")`) y el video más liviano supera 20 MiB, `post.media` genera una variante `discord_video` (720p como máximo) con un bitrate calculado para quedar bajo un tope de 19 MiB según su duración; el tope es un parámetro (para probar con un video corto) y hay un **bitrate mínimo** (por debajo, el video se vería ilegible: no se genera). Si no se puede o aun así no cabe, sale el texto como hoy. No se abre un dominio público.
- **D9 · TikTok no se borra por API.** `retire --delete` en TikTok responde un mensaje claro: se borra a mano en la app y después `publications retire` sin `--delete`.
- **D10 · Ejecución en paralelo** como en F9: un agente por tarea en su worktree y su rama, como máximo 3 con código a la vez, sin tocar los mismos archivos calientes; la CI es el juez; el `revisor` revisa cada PR y el `arquitecto` los que tocan contratos (T04a, T06, T08, T09, T10, T11, T12); solo el coordinador edita `docs/ESTADO.md`.
- **D11 · La portada reemplaza a «Estado».** `/` pasa a ser «Hoy»; la página de salud del sistema queda en `/estado`, en el menú del administrador.

## 5. Tareas
Orden de ejecución (D10): una tarea entra apenas se libera un cupo y sus dependencias están integradas, en este orden. Las dependencias evitan que dos ramas abiertas toquen los mismos archivos (revisión del `arquitecto`, B4).

| Cupo | Tareas |
|---|---|
| Tanda 1 | T01 (web: base visual) · T05 (core: prompts y revisión) · T08 (X: tope y video) |
| Tanda 2 | T02 (web: lenguaje, tras T01) · T04a (core y publishers: resultado dudoso) · T06 (core: plan, tras T05) |
| Tanda 3 | T07 (web: vista previa, tras T02) · T04b (web: salió / no salió, tras T02) · T09 (X: borrar, tras T08) |
| Tanda 4 | T03 (web: portada, tras T02) · T10 (Discord y media) · T12 (dueño de la cuenta) |
| Tanda 5 | T11 (CLI: versiones, tras T03) |
| Jueves 29 | T13 (cierre, del coordinador) |

Dependencias por archivos: T02 y T04b (`PublicationItem.tsx`, `PublicationsPanel.tsx`, `PostPublishing.tsx`); T02 y T07 (`content/Preview.tsx`); T08 y T09 (`x/publisher.ts`, `x/api.ts`); T05 y T06 (`run-social-eval.ts`, `04-formato-publicaciones.md` y las reexportaciones de core); T03 y T11 (`contracts/index.ts`, aunque T11 ya no lo cambia).

### F9.5-T01 · Sistema visual del panel
- **Depende de:** —
- **Descripción:** tokens de diseño en el tema de Tailwind (colores con un primario y un acento, grises, éxito, advertencia, error e información; tipografía del sistema con su escala; espacios y radios), estilos globales, y componentes base: botón (primario, secundario, peligro, fantasma; tamaños; cargando), insignia de estado, tarjeta, tabla, campo de formulario, aviso, estado vacío y encabezado de página. El marco del panel (navegación y cabecera) con el nombre AgentSales y el corredor o marca activa. Primero una muestra (D3); después, aplicarlo a todas las páginas sin cambiar su comportamiento.
- **Archivos principales:** `apps/web/src/index.css` (hoy solo `@import "tailwindcss"`: Tailwind v4 sin `@theme`), `apps/web/src/components/ui/` (nuevo), `apps/web/src/layout/Layout.tsx` (`MENU`, `LayoutBody`), `apps/web/src/labels.ts` (los `*_TONE`), `components/StatusBadge.tsx`, `RunStatusBadge.tsx`, `ErrorAlert.tsx`, y las páginas de `apps/web/src/pages/` (unos 10 archivos definen hoy sus propias clases `PRIMARY`/`SECONDARY`, por ejemplo `components/content/ContentSection.tsx:20`)
- **Hecho cuando:**
  - [ ] la muestra está publicada para el operador antes de aplicar a todo
  - [ ] todas las páginas usan los componentes base: no quedan constantes de clases propias (`PRIMARY`, `SECONDARY`, `BUTTON`) en `apps/web/src` (`grep`)
  - [ ] las pruebas existentes del panel pasan sin cambiar sus aserciones de comportamiento (solo selectores, si hace falta)
  - [ ] los componentes base tienen sus tests; el coordinador revisa capturas a 1280 px y a 390 px
  - [ ] `pnpm check` pasa (CI)

### F9.5-T02 · Lenguaje claro y los detalles de F9
- **Depende de:** T01
- **Descripción:** un solo lugar con las etiquetas de estados, formatos y errores frecuentes en lenguaje de corredor; «Publicar» solo con algo por publicar; «simulación» según D4; un post de una imagen en Instagram dice «imagen», no «carrusel» (`publicationFormatText` recibe el número de medios, §4.2; la CLI también la usa); el servidor de Vite escucha en `127.0.0.1` (sirve también `localhost` en el navegador).
- **Archivos principales:** `packages/core/src/labels.ts` (`PUBLICATION_STATUS_TEXT`, `PUBLICATION_FORMAT_TEXT` l.151 —«carrusel» para todo `post`—, `publicationModeText` l.170), `apps/web/src/components/publications/publications.ts` (`publishButtonText`), `PublicationItem.tsx` (l.178, 260, 358, 364), `PublicationsPanel.tsx`, `components/posts/PostPublishing.tsx` (`PostPublishBar` l.108, `PublicationRow` l.354-363), `components/posts/labels.tsx`, `components/content/Preview.tsx:49`, `apps/web/vite.config.ts` (`server.host`). **Nota:** toda publicación nace con `dryRun: true` (`packages/db/src/repositories/publications.ts:210`) y el modo real se fija al pasar a `publishing`/`scheduled` (`requirePublicationMode`, `core/src/publication.ts:187`): antes de eso el panel muestra el modo de `/health` (`useFreshPublishMode`)
- **Hecho cuando:**
  - [ ] cada estado de publicación y de post tiene su etiqueta clara, con un test que recorre todos los valores del enum
  - [ ] el botón Publicar no aparece sin publicaciones pendientes (test)
  - [ ] con `PUBLISH_MODE=live` una aprobada no dice «simulación», y una `failed` que empezó en vivo sigue diciendo «en vivo» con el servidor en `dry-run` (tests, D4)
  - [ ] un post de una imagen dice «imagen» (test)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T03 · La portada «Hoy»
- **Depende de:** T02
- **Descripción:** la página de inicio del panel con tres bloques: **te toca** (lo de la agenda que pide acción: resultado dudoso, por aprobar, a mano, fallas), **próximas** (lo programado de los próximos 7 días, avisos y posts) y **publicado hace poco** (con su enlace). Cada fila lleva a su detalle. Vacíos amables.
- **Archivos principales:** `apps/web/src/pages/HomePage.tsx` (nueva; `/` hoy es `StatusPage`, que pasa a `/estado`), `apps/web/src/routes.tsx`, `Layout.tsx` (`MENU`), `queries/tracking.ts` (`useAgenda`, `useTracking`), y `publishedAt` en `trackingPublicationSchema` (`apps/api/src/contracts/index.ts:1053`) y su ruta (`apps/api/src/routes/tracking.ts`), de forma aditiva. «Próximas» sale de la agenda (`AGENDA_UPCOMING_MS`, 7 días): no hace falta `/calendar`
- **Hecho cuando:**
  - [ ] la portada muestra los tres bloques con datos de `/agenda` y `/tracking` (test con datos simulados)
  - [ ] solo usa `/agenda` y `/tracking` con el corredor del selector, sin rutas nuevas (el alcance de esas rutas ya está probado)
  - [ ] `/estado` sigue mostrando la salud del sistema (D11)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T04a · Resultado dudoso de Instagram y Portal (core y publishers)
- **Depende de:** —
- **Descripción:** `IG_PUBLISH_OUTCOME_UNKNOWN` y `ML_PUBLISH_OUTCOME_UNKNOWN` pasan a `outcome_unknown` (sin reintento solo) y la agenda los muestra como «resultado dudoso»; los ajustes de Portal de §4.2 (el id `MLC…` desde el enlace, el enlace obligatorio en `live`, el `publication.sync` al resolver, el caso «many»); y los mensajes y consejos para «Salió / No salió».
- **Archivos principales:** `packages/core/src/publish/outcome.ts` (`OUTCOME_UNKNOWN_CODES` l.23 y su comentario), `publish/published-url.ts` (l.102-110), `use-cases/resolve-publication.ts` (l.47, l.110), `publish/error-advice.ts:109`, `use-cases/publish-publication.ts` (~l.442), `packages/publishers/src/instagram/errors.ts:203` y `mercadolibre/errors.ts:405` (los textos), `apps/api/src/routes/publications.ts` (`/publications/:id/resolve`: encolar `publication.sync` en Portal)
- **Hecho cuando:**
  - [ ] un corte simulado de Instagram y otro de Mercado Libre dejan `outcome_unknown` (tests con `msw`)
  - [ ] un aviso de Portal resuelto «salió» con su enlace queda con `externalId = MLC…` y se pide el sync, que lo lee (tests)
  - [ ] en `live`, «salió» en Portal sin enlace ni id se rechaza (test)
  - [ ] los mensajes ya no dicen «descártala» (test que lee los textos)
  - [ ] seguimiento en ADR-0029; `docs/01-arquitectura.md`, `instagram.md` y `mercadolibre.md` al día
  - [ ] `pnpm check` pasa (CI)

### F9.5-T04b · «Salió / no salió» en la sección Contenido de una propiedad (panel)
- **Depende de:** T02, T04a
- **Descripción:** los botones «Salió» (con el enlace; obligatorio en Portal en `live`) y «No salió» para una publicación `outcome_unknown` de un aviso, como en los posts, compartiendo el componente.
- **Archivos principales:** `apps/web/src/components/publications/PublicationItem.tsx` y `PublicationsPanel.tsx`, `OutcomeBox` de `components/posts/PostPublishing.tsx:252` (pasa a un componente compartido), las consultas de publicaciones de avisos (acción `resolve` sobre `POST /publications/:id/resolve`)
- **Hecho cuando:**
  - [ ] resolver «salió» y «no salió» desde el panel de una propiedad (test)
  - [ ] el criterio 5 de F9 queda completo en el spec de F9 y en `docs/ESTADO.md`
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
- **Depende de:** T05 (comparten `run-social-eval.ts`, `04-formato-publicaciones.md` y las reexportaciones de core)
- **Descripción:** el prompt del plan pide ideas con ángulos y formatos distintos y deja de pedir fecha y hora; el código asigna fecha, hora y redes con la regla de D7; las ideas parecidas se descartan (`IDEA_TOO_SIMILAR`) y las que no tienen ranura, con `NO_SLOT` (ambos al final de `PLAN_DISCARD_CODES`, sin quitar los actuales). `PLAN_PROMPT_VERSION` sube. Decisión en **ADR-0034**.
- **Archivos principales:** `packages/core/src/social/plan-prompt.ts` (`PLAN_SYSTEM_PROMPT`, regla 6), `social/plan.ts` (`ideaShape` l.365 —sin `fecha` ni `hora`—, `buildPlanBrief` l.318, `plannedSlots` l.262, `checkPlanIdeas` l.517, `platformProblem`), `social/plan-slots.ts` (nuevo: las ranuras), `social/plan-sample.ts`, `use-cases/run-plan.ts` (~l.270), `apps/worker/src/eval/run-social-eval.ts` (`similarTopics`, que pasa a core), ADR-0030 (seguimiento)
- **Nota de implementación (PR #224):** `PLAN_FALLBACK_PER_WEEK` baja de 3 a 1, como la ranura por defecto (14 días sin cadencia = 2 ideas); `eval:social` suma «sin ranura» (`NO_SLOT`) y cuenta `IDEA_TOO_SIMILAR` entre las repetidas; `topicSimilarity` vive en core y el `similarTopics` de `eval:social` queda para avisar las parecidas al historial. Archivos además de los de arriba: `social/plan-slots.test.ts` y `apps/worker/src/eval/run-social-eval.test.ts`.
- **Hecho cuando:**
  - [ ] las fechas y horas de un plan caen siempre en las ranuras de la cadencia, sin dos ideas en la misma ranura ni sobre lo ya planificado (tests)
  - [ ] dos ideas parecidas: la segunda se descarta con `IDEA_TOO_SIMILAR` (test)
  - [ ] una idea de video no cae en una red sin video, ni una de texto en Instagram (test)
  - [ ] una red sin cadencia o con días u horas vacíos usa la ranura por defecto de D7 (test)
  - [ ] sin ranura libre, la idea se descarta con `NO_SLOT` (test)
  - [ ] un reporte guardado con los códigos de antes se sigue leyendo (test)
  - [ ] `docs/04-formato-publicaciones.md` y `02-modelo-datos.md` al día
  - [ ] `pnpm check` pasa (CI)

### F9.5-T07 · Vista previa por red
- **Depende de:** T02 (comparten `content/Preview.tsx`)
- **Descripción:** un componente de vista previa para Instagram (imagen, carrusel y reel), X, LinkedIn, Discord, TikTok, Portal y Marketplace (D5), en el detalle del post (por red e idioma) y en la sección Contenido de una propiedad, con la primera foto o la portada y el texto como se cortará.
- **Archivos principales:** `apps/web/src/components/preview/` (nuevo: una vista por red), `components/content/Preview.tsx` (`InstagramPanel`, `ListingPanel`), `components/content/MarketplacePanel.tsx`, `components/posts/PostTexts.tsx` (`Preview` local l.75, que se reemplaza), `content/caption.ts`
- **Hecho cuando:**
  - [ ] cada red tiene su vista previa con el texto y el medio correctos (tests)
  - [ ] la vista previa se actualiza al editar el texto (test)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T08 · X: tope de gasto atómico y video en streaming
- **Depende de:** —
- **Descripción:** `reserveCostUsd(id, accountId, costUsd, { limitUsd, since })` reemplaza el par `sumCostUsdSince` + `setCostUsd` en `requireXBudget`: en una transacción, primero bloquea la fila de la cuenta (`SELECT … FROM platform_accounts WHERE id = $1 FOR NO KEY UPDATE` con `lock_timeout`, como `withCredentialsLock`) y después, en otra sentencia, suma lo del mes y fija `cost_usd` con la condición `status = 'publishing'` (B2: una sola sentencia no es atómica en READ COMMITTED). La liberación ya existe: `failed` no está en `COST_COUNTED_STATUSES`. El video se sube a X por partes leyendo de R2 como stream, sin cargarlo entero.
- **Archivos principales:** `packages/core/src/use-cases/publish-publication.ts` (`requireXBudget` l.807), `core/src/x/cost.ts`, `packages/db/src/repositories/publications.ts` (`setCostUsd` l.556, `sumCostUsdSince` l.578; una reserva condicional nueva), el puerto de publicaciones en core, `packages/publishers/src/x/publisher.ts` (`downloadXMedia` l.139: `arrayBuffer` l.167) y `x/api.ts` (`uploadVideo` l.198, partes de 4 MB)
- **Hecho cuando:**
  - [ ] test de contrato: la reserva que pasa el tope falla con `X_SPEND_LIMIT_REACHED` y no anota nada (PGlite tiene una sola conexión y no reproduce la concurrencia: el bloqueo queda documentado en `docs/01-arquitectura.md`)
  - [ ] el video se sube por partes sin un `Buffer` del archivo entero (test con `msw`)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T09 · Retirar borrando en X (y el mensaje de TikTok)
- **Depende de:** T08 (comparten `x/publisher.ts` y `x/api.ts`)
- **Descripción:** `Publisher.remove` en X con `DELETE /2/tweets/:id` y `ensureRotatingAccessToken` en retirar; la API compone el renovador de token de X (hoy `tokenRefreshers` solo existe en `apps/worker/src/worker.ts`) y renueva siempre bajo `withCredentialsLock` (la lección del token invalidado de S4). El costo de borrar no está verificado (`x.md` §2.1): no se anota. TikTok responde D9. Seguimiento en ADR-0029.
- **Archivos principales:** `packages/core/src/use-cases/retire-publication.ts` (`removeRemote` ~l.160: hoy rechaza X y TikTok en l.176 por usar solo el token guardado; pasa a `ensureRotatingAccessToken`, `use-cases/ensure-access-token.ts:378`), `packages/publishers/src/x/publisher.ts` y `x/api.ts` (`deletePost`, como `deleteLinkedInPost` en `linkedin/publisher.ts:429`), `apps/api/src/portal.ts:22` (`createApiOperations`: X) y `apps/api/src/server.ts:267` (el renovador de X), `core/src/publish/error-advice.ts` (el mensaje de TikTok)
- **Hecho cuando:**
  - [ ] `publications retire --delete` en X borra el post (test con `msw`) y solo en `live`
  - [ ] en TikTok el mensaje dice que se borra a mano (test)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T10 · Video para Discord que quepa
- **Depende de:** —
- **Descripción:** la variante `discord_video` (D8: tope de 19 MiB como parámetro, bitrate mínimo, `postPublishesOn(post, "discord")`) en `packages/media` y en `post.media`; `discordVideo` la prefiere y el publisher la adjunta. Sin migración (§4.3). Docs: `02-modelo-datos.md` (variantes), `01-arquitectura.md`, `03-plataformas.md`, `discord.md` y D8 del spec de F9.
- **Archivos principales:** `packages/media/src/pipeline.ts` (`DISCORD_VIDEO_SPEC`, junto a `X_VIDEO_SPEC` l.62), `packages/media/src/video.ts` (`processVideo` l.335, `encodeXVideo` l.291, `probe`), `packages/core/src/enums.ts:142` (`PROCESSED_MEDIA_VARIANTS`, `VIDEO_MEDIA_VARIANTS`: archivo caliente), `core/use-cases/process-post-media.ts` (~l.183), `core/use-cases/open-publications.ts:204` (`discordVideo`), `packages/publishers/src/discord/publisher.ts:66` (`discordAttachments`)
- **Hecho cuando:**
  - [ ] con un tope chico (parámetro), un video corto generado por ffmpeg produce una variante bajo el tope; bajo el bitrate mínimo no se genera (tests)
  - [ ] el publisher adjunta la variante (test con `msw`); si no hay, sale el texto como hoy
  - [ ] `pnpm check` pasa (CI)

### F9.5-T11 · CLI y servidor de versiones distintas
- **Depende de:** T03 (no comparten código, pero sí la zona de `contracts`)
- **Descripción:** cabecera `X-AgentSales-Version` en la API; la CLI avisa la diferencia y tolera un valor nuevo de enum en las respuestas (§4.2, B5), sin tocar `contracts/index.ts`. Seguimiento en ADR-0011.
- **Archivos principales:** `apps/api/src/app.ts` (la cabecera), `apps/cli/src/api-client.ts` (`unwrap` l.162-193), las etiquetas de la CLI (`TEXT[v] ?? v`)
- **Hecho cuando:**
  - [ ] una respuesta con un valor de enum nuevo no hace fallar la CLI: un test por cada fuente nueva de esta fase (`discord_video`, la muletilla de T05, `IDEA_TOO_SIMILAR` y `NO_SLOT`), y un error que no es de enum sigue fallando
  - [ ] la CLI avisa una vez cuando las versiones difieren (test)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T12 · De quién es una cuenta
- **Depende de:** —
- **Descripción:** `accountOwnedBy` en core usada por la lista de alta y el panel; el detalle del post pide las cuentas con la marca del post, no con la del selector.
- **Archivos principales:** `packages/core/src/onboarding.ts` (l.66 y l.69), `packages/core/src/accounts/owner.ts` (nuevo), `apps/web/src/components/posts/PostPublishing.tsx` (`platformsWithoutAccount` l.65 y `useAccounts(useBrokerFilter())` l.125: pasa a `useAccounts()` sin filtro —el alcance del usuario; `useAccounts` recibe un slug, no un id— y filtra con `accountOwnedBy(post.brokerId)`), `apps/web/src/pages/AccountsPage.tsx:106`
- **Hecho cuando:**
  - [ ] la lista de alta y el panel usan la misma función (tests)
  - [ ] el administrador con otro corredor en el selector ve activas las redes del post (test)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T13 · Cierre
- **Depende de:** T01 a T07 (T08 a T12 si se integraron, D1)
- **Descripción:** docs al día (`10-despliegue.md`: volver atrás, §4.3), `CHANGELOG [1.4.0]`, `docs/ESTADO.md`, roadmap, la etiqueta `v1.4.0` con permiso del operador y la guía de la demo (§7).
- **Hecho cuando:**
  - [ ] los criterios de §6 verificados
  - [ ] el operador tiene la guía paso a paso de la demo

## 6. Criterios de aceptación de la fase
1. Todas las pantallas del panel usan el mismo sistema visual y la portada resume el día.
2. Ningún estado, botón o mensaje del recorrido de la demo usa palabras técnicas; «simulación» aparece solo en `dry-run`.
3. Antes de aprobar se ve cómo quedará la publicación en cada red.
4. Un resultado dudoso en Instagram o Portal queda `outcome_unknown` y se resuelve desde el panel.
5. Con la IA real (corrida del operador, o de Claude con su permiso, de `eval:content` y `eval:social --profile dos-idiomas`), a lo más una advertencia de muletillas cada diez textos; y el plan no repite ideas ni pone fechas fuera de la cadencia (tests y la misma corrida).
6. Los avisos y posts de F1 a F9 funcionan igual: sus tests pasan.
7. `pnpm check` y la CI pasan.

**Verificación del cierre (2026-10-22, sobre `main` con #217 a #230, CI en verde en cada PR):**
- **Demostrados con pruebas:** 1 (los componentes base en todas las páginas, sin clases propias sueltas, y la portada: `ui.test.tsx`, `HomePage.test.tsx`), 2 (etiquetas de todos los estados y D4: `labels.test.ts`, `publication.test.ts`, `PublicationsPanel.test.tsx`), 3 (`previews.test.tsx`, `preview.test.ts`, `ContentSection.test.tsx`, `PostDetailPage.test.tsx`), 4 (`resolve-listing-outcome.test.ts`, `publications-portal.test.ts`, `OutcomeResolve.test.tsx`), 6 (las pruebas de F1 a F9 pasan; las que cambiaron solo cambian textos o donde ADR-0034 cambia el comportamiento) y 7.
- **Parcial, del operador:** 5 con la IA real (las pruebas con `fake` cuentan las muletillas y el plan no repite ideas ni sale de la cadencia: `ai-tells.test.ts`, `plan-slots.test.ts`; falta la corrida real de `eval:content` y `eval:social`).
- **Visual:** revisado por el coordinador en el navegador con datos de prueba; el recorrido real queda para el ensayo del jueves 29 (`docs/12-demo-oficina.md`).

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
| Conectar `@vicentewoldec` también al corredor nuevo crea otra fila de cuenta; el cupo diario de Instagram se cuenta por fila | Pocas publicaciones en la demo; el límite real de Instagram es por cuenta y está lejos |
| Queda algo programado en vivo al volver a `dry-run` después de la demo | Revisar la agenda y desprogramarlo (paso de la guía de la demo) |
| Volver atrás a `v1.3.0` falla al leer filas nuevas | Documentado en `10-despliegue.md` (§4.3) |
| Los prompts nuevos empeoran algo que hoy funciona | Las versiones suben; `eval:content` y `eval:social` con `fake` en la CI y una corrida real antes de desplegar |

## 9. Preguntas abiertas
- (respondidas en la entrevista del 2026-10-22: demo del operador desde el servidor el viernes 30, con publicaciones reales en sus cuentas; propiedades con un corredor nuevo suyo conectado a `@vicentewoldec` y una propiedad de ejemplo que borra después; posts con AgentPey; worker solo los días de demo; lo interno también antes de la demo; sin ensayo general)

## 10. Registro de cambios del spec
| Fecha | Cambio |
|---|---|
| 2026-10-22 | Borrador tras la entrevista con el operador; alcance y nombre aprobados por él |
| 2026-10-22 | Revisión del `arquitecto` (5 bloqueantes, aplicados): Portal al resolver un resultado dudoso (id `MLC…`, enlace obligatorio en `live`, sync, «many») y T04 partida en T04a y T04b; la reserva de gasto de X con candado sobre la cuenta; D7 definida y ADR-0034; dependencias por archivos y tandas rearmadas; T11 sin tocar `contracts`. No bloqueantes también aplicados: D4 por estado, `publicationFormatText` con el número de medios, el renovador de X en la API, `discord_video` sin migración, `useAccounts()` en T12, `publishedAt` en la portada, criterios verificables y riesgos de la demo |
| 2026-10-22 | **Aprobado por el operador** (el alcance, el nombre y el trabajo en paralelo) |
| 2026-10-22 | **Cierre de la fase** (T13, `v1.4.0`): 12 tareas en 14 PR (#217 a #230); la guía de la demo en `docs/12-demo-oficina.md` y el paso «En vivo solo durante una demo» en `docs/10-despliegue.md` |
| 2026-10-22 | T06 (PR #224, revisión del `revisor`): D7 precisada con lo implementado: una red con 0 posts por semana no es candidata (`OUT_OF_CADENCE`); con días u horas vacíos solo se completa lo que falta y se conservan sus posts por semana; el espacio mínimo es como máximo `ceil(posts por semana / días)` posts por día; las semanas con menos ideas cuentan también lo ya planificado. Nota de implementación en T06 (`PLAN_FALLBACK_PER_WEEK` de 3 a 1) |
