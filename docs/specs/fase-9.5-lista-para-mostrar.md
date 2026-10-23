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
- **D2 · Sin dependencias nuevas.** El sistema visual se hace con Tailwind y componentes propios; tipografía Fraunces y DM Sans empaquetadas con el panel (sin pedir nada afuera) y los íconos, SVG en línea.
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

### Lote 2 · Lo que vio el operador en la primera prueba (2026-10-22)
El operador probó la demo en el servidor (propiedad de ejemplo, programar y salir solo, portada) y anotó lo que confunde o falta. Sus decisiones del mismo día: borrar **de verdad** los corredores de prueba (`corredor-demo`, `agentsales-pruebas`, `demo-meta` y `demo`), música de una **biblioteca libre de derechos** incluida, y la invitación por correo **abriendo su programa de correo** (sin servicio nuevo). Ejecución igual que el lote 1 (D10); este lote cierra con `v1.5.0`.

| Cupo | Tareas |
|---|---|
| Tanda A | T14 (borrar un corredor) · T15 (invitación, sesión y textos) · T18 (reel desde fotos) |
| Tanda B | T16 (crear un corredor fácil, tras T14) · T17 (perfil editorial claro, tras T15) · T19 (música, tras T18 y la nota `docs/integraciones/musica-reels.md`) |

### F9.5-T14 · Borrar un corredor de verdad
- **Depende de:** —
- **Descripción:** `purgeBroker` en core: borra un corredor y todo lo suyo (usuarios y sesiones, cuentas y sus credenciales, propiedades, medios y sus archivos en R2, textos, corridas, publicaciones y su bitácora, cargas, posts, perfil editorial, planes, valores de campos), en una transacción para la base y después los objetos de R2 por sus claves (lo que no se pueda borrar en R2 queda anotado y se reintenta, sin dejar filas huérfanas). Se niega si hay algo publicándose o programado (pide cancelarlo antes) y si el corredor es el único administrador de algo. Ruta de administrador `DELETE /brokers/:id` que exige repetir el slug; CLI `brokers delete <slug>` que muestra el resumen de lo que se borra (cuántas propiedades, medios, publicaciones, usuarios y cuentas) y pide escribir el slug (`--yes` no basta: exige `--confirm <slug>`). No borra nada en las redes (lo publicado sigue allá). Decisión en **ADR-0035** (extiende ADR-0027).
- **Archivos principales:** `packages/core/src/use-cases/purge-broker.ts` (nuevo), los repositorios de `packages/db` (un método de borrado por agregado o una consulta en transacción), `packages/storage` (borrar por lista de claves), `apps/api/src/routes/brokers.ts`, `apps/cli/src/commands/brokers.ts`, `docs/02-modelo-datos.md`, `docs/10-despliegue.md` (respaldo antes de borrar)
- **Hecho cuando:**
  - [ ] con PGlite, un corredor con propiedades, medios, publicaciones, posts, cuentas y usuarios queda sin una sola fila suya, y los demás corredores intactos (test de repositorio)
  - [ ] se niega con algo publicándose o programado (test)
  - [ ] la ruta es solo del administrador y exige el slug; la CLI muestra el resumen y exige `--confirm` (tests)
  - [ ] los archivos de R2 se borran por sus claves y un fallo de R2 no deja la base a medias (tests con el almacenamiento falso)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T15 · La invitación, la sesión y textos que confunden
- **Depende de:** —
- **Descripción:** (1) la página de la invitación explica qué hace («Estás creando tu usuario en AgentSales: elige una contraseña») y, si en ese navegador ya hay una sesión abierta, lo avisa antes de cambiarla («Tienes abierta la sesión de X; si sigues, se cierra. Para seguir viendo como administrador, abre este enlace en una ventana privada»); (2) junto al enlace de invitación o de restablecer, el botón **Enviar por correo** abre el programa de correo con el asunto y el mensaje listos (`mailto:` con el correo del invitado; el enlace va en el cuerpo y nunca en la URL de la página ni en los logs); (3) el aviso rojo «Este texto tiene publicaciones activas…» pasa a lenguaje claro («Ya se publicó o está por publicarse con este texto. Para cambiarlo, primero retira o descarta esas publicaciones») y en un tono de aviso, no de error; (4) la guía dice que la sesión es una por navegador.
- **Archivos principales:** `apps/web/src/pages/InvitationPage.tsx`, el bloque de usuarios de `apps/web/src/pages/BrokerPage.tsx`, `apps/web/src/components/content/ApprovableText.tsx` (o donde viva el aviso), `packages/core/src/labels.ts` si el texto es compartido, `docs/08-guia-operador.md`
- **Hecho cuando:**
  - [ ] la invitación con una sesión abierta muestra el aviso y no la cierra sin confirmar (test)
  - [ ] el botón arma un `mailto:` correcto con el correo, asunto y cuerpo (test)
  - [ ] el aviso nuevo aparece donde estaba el rojo (test)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T16 · Crear un corredor fácil
- **Depende de:** T14 (comparten `routes/brokers.ts` y `commands/brokers.ts`)
- **Descripción:** el formulario de **Crear un corredor** pide solo lo esencial (nombre y nombre de la marca; el slug se arma solo y se puede cambiar) y deja el resto en **Opciones avanzadas**, plegado (colores con un valor por defecto, WhatsApp, correo, Instagram, sitio, tono, hashtags, propio o no, tope de IA). **Crear desde una planilla:** subir la planilla de Excel con la hoja Corredor llena llena el formulario (se revisa antes de guardar), con la lectura que ya existe en `packages/importers` (`xlsx-reader.ts`, hoja Corredor). La CLI `brokers create` queda igual.
- **Archivos principales:** `apps/web/src/pages/BrokersPage.tsx` (formulario), `apps/api/src/routes/brokers.ts` (una ruta que lee la hoja Corredor sin guardar), `packages/importers/src/xlsx-reader.ts`, `docs/08-guia-operador.md`
- **Hecho cuando:**
  - [ ] se crea un corredor con solo nombre y marca (test)
  - [ ] una planilla con la hoja Corredor llena llena el formulario sin guardar nada (tests de la ruta y del panel)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T17 · Un perfil editorial que se entienda
- **Depende de:** T15 (zona del panel)
- **Descripción:** en Mi marca y en la página del corredor, el perfil editorial explica cada campo con un ejemplo de corredor de propiedades: **Público** («Familias jóvenes que buscan arriendo en Providencia y Ñuñoa»), **Temas de la marca** (hoy «Líneas de contenido»: qué temas publica y cuánto de cada uno, con el peso como «poco / normal / mucho» en vez de un número suelto), **Hechos que la IA puede afirmar** («12 años vendiendo en Ñuñoa», «Más de 200 propiedades arrendadas») y **Cosas que evitar** («Prometer plusvalía», «Hablar mal de otros corredores»), con ejemplos que se pueden insertar. **La cadencia** con días como botones (L M M J V S D) y horas como chips de hora (agregar «10:00», quitar con una x), en vez del texto `red/posts/días/horas/espacio`.
- **Archivos principales:** `apps/web/src/components/EditorialProfileForm.tsx` (o donde viva), `apps/web/src/pages/MyBrandPage.tsx`, `BrokerPage.tsx`, `docs/08-guia-operador.md`
- **Hecho cuando:**
  - [ ] cada campo tiene su ayuda y su ejemplo, y los ejemplos se pueden insertar (test)
  - [ ] la cadencia se edita con días y horas por botones y se guarda igual que hoy (test, sin cambiar el contrato)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T18 · Reel desde las fotos
- **Depende de:** —
- **Descripción:** si una propiedad no tiene video, la preparación arma el reel con sus fotos (la portada primero): video vertical 1080×1920, cada foto unos 3 s con un fundido, fondo difuminado para las fotos horizontales, y el texto del reel encima como hoy; con video, todo sigue igual. La clave del reel incluye que salió de fotos (no se rehace si nada cambió). El panel dice «Reel armado con tus fotos».
- **Archivos principales:** `packages/media/src/video.ts` (`encodeReelFromPhotos`), `packages/media/src/pipeline.ts`, `packages/core/src/use-cases/prepare-content.ts` (etapa `reel`), `packages/core/src/media-checks.ts`, `apps/web/src/components/content/Preview.tsx` (el aviso), `docs/04-formato-publicaciones.md`
- **Hecho cuando:**
  - [ ] una propiedad sin video y con 3 o más fotos queda con reel (tests con ffmpeg y del caso de uso)
  - [ ] con video, el reel sigue saliendo del video (test)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T19 · Música en los reels
- **Depende de:** T18 y la nota `docs/integraciones/musica-reels.md`
- **Descripción:** una biblioteca de 5 pistas libres de derechos (las de la nota) guardadas en R2 (`assets/musica/<id>.mp3`, las sube el operador con `pnpm music:upload`); cada propiedad y cada post de video puede elegir una o «sin música» (por defecto, sin música). **Decisiones del operador (2026-10-22):** solo pistas **CC0, sin crédito** en ningún texto; si el video trae sonido, se **mezcla**: el sonido del video al frente y la música detrás, a **−18 dB**, con fundido al final (sin sonido, la música sola); el mismo video con música va a **todas las redes** (Instagram, X, TikTok, Discord y LinkedIn). Elegir otra pista cambia la clave del reel: en un aviso se aplica al **«Rehacer imágenes»** o `prepare --no-texts`; en un post, los videos se rehacen solos (`post.media`). Sin música, las claves quedan como antes. Una pista sin archivo, o que ffmpeg no puede leer, deja el video sin música con un aviso, sin romper la etapa. Migración aditiva `0019` (`music_track_id` en `listings` y `posts`), sin ADR.
- **Archivos principales:** `packages/core/src/music/` (catálogo y `resolveReelMusic`), `packages/core/src/use-cases/prepare-content.ts`, `process-post-media.ts`, `listing-music.ts` y `posts.ts`, `packages/media/src/video.ts` (`MUSIC_SPEC`), `packages/storage/src/music-upload.ts`, `apps/api/src/routes/music.ts` y `listings.ts`, `apps/cli/src/commands/listing.ts` y `post.ts`, `apps/web/src/components/music/MusicPicker.tsx`, `docs/integraciones/musica-reels.md`
- **Hecho cuando:**
  - [ ] elegir una pista rehace el reel con esa música; «sin música» lo deja como hoy (tests)
  - [ ] solo pistas CC0 (test del catálogo)
  - [ ] `pnpm check` pasa (CI)

### Lote 3 · Lo que vio el operador al probar como corredor (2026-10-22) y publicar a diario desde AgentPey
El operador probó la demo como administrador y como un corredor nuevo (Oficina Demo) y pidió: arreglar lo que confunde, un diseño acogedor para corredores de propiedades, escribir y crear imágenes sin tener fotos, ideas del plan que obedezcan lo que él pide, y **empezar a publicar a diario desde la marca personal de AgentPey** en X, LinkedIn, Discord y TikTok además de Instagram. Decisiones del 2026-10-22: **el modo en vivo es por marca** (ADR-0036) y **el worker se enciende y se apaga solo** por horario (ADR-0037, propuesto). Este lote cierra con `v1.6.0`.

**Orden de las redes, de la más fácil a la más difícil de dejar publicando a diario** (con lo que ya está probado):
1. **Instagram:** ya funciona (carrusel, reel e imagen). Se publica de verdad con la prueba S1 hecha.
2. **Discord:** la más fácil. Un webhook, sin revisión ni costo, texto, imágenes y video hasta 20 MiB (con la versión liviana); S5 pasó.
3. **X:** fácil. API con OAuth, S4 pasó; cuesta unos US$ 0,015 por post de texto (US$ 0,20 con enlace) y tiene tope mensual; hay que cuidar la automatización.
4. **LinkedIn:** media. En modo **a mano** funciona hoy (el sistema deja el texto listo y el operador lo pega, 1 minuto al día). Por la API depende de S2 y S3 y de que LinkedIn lo permita en un perfil personal; la página de empresa pide una aprobación aparte de semanas.
5. **TikTok:** la más difícil. Solo video, y en Sandbox llega como borrador al teléfono; publicar directo exige la auditoría de TikTok (video demo, dominio, política) y puede tardar o rechazarse.

| Cupo | Tareas |
|---|---|
| Tanda A | T20 (corredor sin trabas, web) · T21 (texto e imagen pendientes en un post, core y web) · T22 (en vivo por marca, ADR-0036) |
| Tanda B | T23 (ideas del plan con instrucciones) · T24 (worker programado, ADR-0037) · T25 (tarjetas y biblioteca de imágenes) |
| Tanda C | T26 (diseño acogedor, tras A y B por tocar todo el panel) · T27 (publicar a diario en Discord, X, LinkedIn y TikTok) |

### F9.5-T20 · Un corredor sin trabas
- **Depende de:** —
- **Descripción:** (1) en un aviso, **Publicar y Programar quedan desactivados** mientras la red no tenga cuenta conectada, con el motivo y un enlace a **Cuentas** (como ya pasa en los posts); (2) los errores se muestran **en simple y sin código**: un mapa de códigos a mensajes (`ACCOUNT_NOT_CONNECTED`: «Conecta tu cuenta de Instagram en Cuentas para publicar»; `USER_EMAIL_TAKEN`: «Ese correo ya tiene un usuario en AgentSales»; y un mensaje genérico para el resto, con el código chico al final para reportarlo); (3) la vista previa de Instagram dice «Instagram sin conectar» en vez de «tu cuenta»; (4) **Cuentas** muestra solo las redes que sirven al tipo de corredor (propiedades: Instagram, Mercado Libre y Marketplace; marcas: Instagram, X, LinkedIn, Discord y TikTok); (5) en **Hoy**, cada publicación dice su formato («carrusel», «reel», «imagen»); (6) antes de **Conectar Instagram**, una pantalla en español explica qué se va a autorizar y por qué, que la cuenta debe ser profesional y que, mientras Meta no apruebe la app, solo funciona con cuentas evaluadoras; con un botón «Continuar a Instagram»; (7) el enlace de invitación **no desaparece** al recargar mientras no se cierre («Listo, ocultarlo»), con un botón **Copiar mensaje completo** además de «Enviar por correo», y una frase que dice «si lo perdiste, usa Restablecer».
- **Archivos principales:** `apps/web/src/components/publications/PublicationsPanel.tsx` y `publications.ts`, `apps/web/src/components/ErrorAlert.tsx` y un mapa en `apps/web/src/labels.ts`, `components/preview/account-name.ts`, `apps/web/src/pages/AccountsPage.tsx`, `pages/HomePage.tsx`, `components/brokers/OneTimeLink.tsx`
- **Hecho cuando:**
  - [ ] con Instagram sin conectar, Publicar y Programar están desactivados y dicen por qué (test)
  - [ ] ningún error del panel muestra un código técnico sin su explicación (test que recorre el mapa)
  - [ ] Cuentas de un corredor de propiedades no ofrece X, TikTok, LinkedIn ni Discord (test)
  - [ ] la pantalla previa a Instagram existe y el botón continúa el flujo (test)
  - [ ] el enlace de invitación sobrevive a una recarga hasta ocultarlo (test)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T21 · Un post sin imágenes: el texto y lo que falta
- **Depende de:** —
- **Descripción:** el texto de un post se puede redactar y **aprobar sin tener las imágenes**; lo que falta se dice como pendiente y no como error rojo. `MEDIA_REQUIREMENT` pasa de error a **advertencia «Falta la imagen / el video»** en la revisión del texto; **publicar y programar** siguen bloqueados hasta que existan los medios, con un botón «Conseguir imagen» (T25). La marca roja «!» en la pestaña de una red desaparece cuando el único motivo es que faltan medios, y cuando hay un error de verdad la pestaña dice cuál al pasar el cursor y en el panel («Instagram · español: el texto pasa de 2.200 caracteres»).
- **Archivos principales:** `packages/core/src/social/check.ts` (`MEDIA_REQUIREMENT`), `use-cases/draft-post.ts` y `kindProblem`, `use-cases/post-content.ts` (aprobar), `use-cases/publish-post.ts` (bloquear), `apps/web/src/components/posts/PostTexts.tsx` y `PostPublishing.tsx`
- **Hecho cuando:**
  - [ ] un post de imágenes sin imágenes redacta su texto, se aprueba y no se puede publicar ni programar (tests de core)
  - [ ] la revisión dice «Falta la imagen» como advertencia, y un error real sigue siendo error (test)
  - [ ] la pestaña explica su «!» (test del panel)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T22 · En vivo por marca (ADR-0036)
- **Depende de:** —
- **Descripción:** columna `brokers.live_enabled` (migración aditiva, por defecto `false`), `effectivePublishMode(serverMode, broker)` en core como única fuente del modo, y que publicar, programar, el reloj y los publishers la usen; `brokers live <slug> on|off` en la CLI (administrador, pide confirmación, solo corredores propios) y un interruptor en la ficha del corredor; el banner del panel y la CLI muestran el modo de la marca elegida («Simulación» o «En vivo» con el nombre). Una marca que no es del operador no se enciende. Con `PUBLISH_MODE=dry-run`, todo sigue en simulación.
- **Archivos principales:** `packages/db/src/schema.ts` y la migración `0020`, `packages/core/src/publication.ts` (`requirePublicationMode`), `use-cases/publish-publication.ts`, `schedule-*.ts`, `start-due-publications.ts`, `packages/core/src/publish-mode.ts` (nuevo), `apps/api` (rutas de corredores, `PublishModeBanner`), `apps/cli/src/commands/brokers.ts`, `apps/web/src/layout/PublishModeBanner.tsx`
- **Hecho cuando:**
  - [ ] la tabla completa de combinaciones (servidor `dry-run` o `live` × marca encendida o apagada × propia o no) da el modo esperado (test)
  - [ ] un test recorre el código y falla si algo lee `PUBLISH_MODE` sin pasar por la función (test)
  - [ ] publicar en una marca apagada con el servidor en `live` sale en simulación; en una encendida, de verdad (tests con los publishers falsos)
  - [ ] el panel y la CLI dicen el modo de la marca (tests)
  - [ ] `docs/10-despliegue.md` y la guía dicen cómo volver atrás (poner `dry-run` antes) y `pnpm check` pasa (CI)

### F9.5-T23 · Ideas del plan que obedecen
- **Depende de:** —
- **Descripción:** (1) en **Plan**, un campo **«¿Qué quieres que trate este plan?»** (opcional, hasta 500 caracteres, con ejemplos: «lanzamiento del 3 de noviembre», «solo ideas para principiantes», «evita hablar de precios») que llega al prompt como pedido del operador; es una guía de **temas y tono**, nunca una fuente de hechos (ADR-0030: los hechos siguen saliendo solo del perfil); `PLAN_PROMPT_VERSION` sube. (2) Si el perfil de la marca está vacío (sin temas ni hechos), el panel y la CLI **avisan antes de pedir el plan** («Tu perfil está vacío: las ideas saldrán genéricas») con un botón a **Mi marca** y un asistente corto de 4 preguntas (qué haces, para quién, de qué temas hablas, qué no dices) que llena el perfil para revisarlo. (3) Las ideas ya no hablan en primera persona del plural si el perfil no dice que es un equipo.
- **Archivos principales:** `packages/core/src/social/plan-prompt.ts` y `plan.ts`, `use-cases/request-plan-run.ts`, `apps/api/src/routes/plans.ts` y contratos, `apps/cli/src/commands/plan.ts` (`--guidance`), `apps/web/src/pages/PlanPage.tsx`, `docs/04-formato-publicaciones.md`, `docs/adr/0030-*.md` (seguimiento)
- **Hecho cuando:**
  - [ ] el pedido del operador llega al prompt y el plan de ejemplo (`fake`) lo refleja (tests)
  - [ ] un pedido con cifras o clientes que no están en el perfil no se vuelve un hecho en las ideas (test de la verificación)
  - [ ] con el perfil vacío, el panel avisa y ofrece el asistente (test)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T24 · El worker se enciende y se apaga solo (ADR-0037)
- **Depende de:** —
- **Descripción:** el workflow `.github/workflows/worker-schedule.yml` revisa **cada hora a los :50** (y a pedido, `workflow_dispatch`) y enciende la máquina del worker si está apagada, dentro de una franja del día (07:00 a 23:00 de Chile; de noche no lo despierta). El worker cierra limpio, sin cortar los jobs, cuando lleva `WORKER_IDLE_EXIT_MINUTES` sin jobs activos, sin formularios de Marketplace abiertos y sin nada programado que venza antes de la próxima revisión más un margen (`WORKER_STAY_AHEAD_MINUTES`, 70). `WORKER_IDLE_EXIT_MINUTES` es 0 por defecto: nunca se apaga. La agenda avisa «el worker está apagado y hay algo por vencer»: con horario, sale en la próxima revisión; sin horario, el worker debe estar encendido. `doctor` dice la próxima revisión. La guía de despliegue explica cómo crear el token de Fly, guardarlo en el Environment `worker-schedule` (solo `main`) y activar el horario; lo hace el operador. **El workflow no enciende nada sin el secreto, que crea el operador.**
- **Archivos principales:** `apps/worker/src/worker.ts`, `idle-exit.ts` y `shutdown.ts`, `packages/queue` (los jobs pendientes), `packages/config` (las variables), `packages/core/src/worker-schedule.ts` y `tracking/agenda.ts`, `.github/workflows/worker-schedule.yml` y `ci.yml` (actionlint), `apps/cli/src/commands/doctor/`, `docs/10-despliegue.md`
- **Hecho cuando:**
  - [ ] el worker se queda si algo vence dentro del margen o hay un job activo, y se apaga sin cortar los jobs cuando no hay nada (tests con reloj falso)
  - [ ] la consulta de los jobs pendientes corre contra el esquema real de pg-boss (test con PGlite)
  - [ ] la agenda avisa «el worker está apagado y hay algo por vencer» con o sin horario (test)
  - [ ] el minuto y la franja del workflow calzan con los de core, incluida la cuenta de bash (test)
  - [ ] la CI corre `actionlint` sobre los workflows, y la guía explica cómo activar el horario
  - [ ] `pnpm check` pasa (CI)

### F9.5-T25 · Tarjetas y biblioteca de imágenes desde el post
- **Depende de:** T21 (el botón vive donde T21 dice «Falta la imagen»); la nota `docs/integraciones/imagenes-y-videos-generados.md` y ADR-0038 (decisiones del operador del 2026-10-22)
- **Descripción:** en un post sin los medios que su tipo pide, un botón **Conseguir imagen** abre un panel con tres pestañas, en este orden:
  1. **Tarjetas de la marca** (por defecto, US$0, sin proveedor): sharp dibuja el título del post (o, en un carrusel, una portada, una tarjeta por punto del texto y una de cierre) sobre el color y el logo de la marca, en 4:5 (1080×1350) o 9:16 (1080×1920); el texto sale del post, nunca inventado. Para un post de video, «Hacer video de las tarjetas» las une con ffmpeg y la música de T19 (el mismo motor del reel desde fotos, T18).
  2. **Biblioteca (Pixabay)**: una búsqueda con el tema del post (editable), hasta 12 resultados sin personas como filtro sugerido; el usuario elige y el archivo **se descarga a R2** antes de usarse (nunca se enlaza a Pixabay). 100 peticiones por minuto; un 429 se dice en simple.
  3. **Crear con IA (Nano Banana 2.1)**: una indicación propuesta desde el post con su tema y la primera oración de su brief, sin llamar a la IA de texto (editable), sin texto dentro de la imagen; 4:5 o 9:16. Cada imagen anota su costo; **tope de US$2 al mes por marca** (configurable), y al llegar se niega con «Llegaste al tope de imágenes con IA de este mes».
  Lo conseguido entra como medios del post (mismo camino que una foto subida: R2, sha256, variantes) y pasa por la vista previa y la aprobación. **No se marca como IA** (ADR-0038 §4: solo cuando la red lo exige, hoy video realista, que no se construye). Puertos nuevos en core, `StockPhotoProvider` e `ImageGenerator`, con adaptadores `pixabay`, `gemini` y `fake`; modelo y precio en configuración (`PIXABAY_API_KEY`, `GEMINI_API_KEY`, `IMAGE_AI_MODEL`, `IMAGE_AI_PRICE_USD`, `IMAGE_AI_MONTHLY_CAP_USD`); sin claves, las pestañas 2 y 3 dicen qué falta y las tarjetas funcionan igual. Sin SDK nuevo (`fetch` + zod). La generación corre en el worker (job nuevo), no en la API. CLI: `post media <id> --card | --stock "<búsqueda>" --pick <n> | --ai "<indicación>"`.
- **Fuera de esta tarea:** video con IA; stock o IA en propiedades (permitido por ADR-0038 §6, se construye después si hace falta).
- **Archivos principales:** `packages/core/src/ports/` (dos puertos), `packages/core/src/use-cases/` (conseguir medios de un post y su gasto), `packages/media` (tarjetas con sharp y video de tarjetas), un paquete o carpeta de adaptadores (`pixabay`, `gemini`), `packages/config`, `apps/worker` (job), `apps/api/src/routes/posts.ts` y contratos, `apps/cli/src/commands/post.ts`, `apps/web/src/components/posts/` (panel «Conseguir imagen»), `docs/04-formato-publicaciones.md` (tarjetas), `docs/08-guia-operador.md`, `.env.example`
- **Hecho cuando:**
  - [ ] una tarjeta y un carrusel de tarjetas se generan con el texto del post y la marca, y quedan como medios del post (tests con sharp de verdad, sin red)
  - [ ] un video de tarjetas sale con ffmpeg y música (test con la misma prueba de T18)
  - [ ] con `fake`, la biblioteca y la IA devuelven una imagen que se guarda en R2 falso y se adjunta (tests); el adaptador de Pixabay y el de Gemini se prueban con msw (sin red)
  - [ ] el gasto se anota por marca, `cli usage` lo muestra aparte del texto, y al pasar el tope se niega (tests)
  - [ ] sin claves, el panel ofrece solo tarjetas y dice qué falta (test del panel)
  - [ ] `pnpm check` pasa (CI)

### F9.5-T26 · Un diseño acogedor para corredores de propiedades
- **Depende de:** T20, T21, T23 (tocan los mismos archivos del panel)
- **Descripción:** un nuevo sistema visual pensado como lo haría una diseñadora de interiores: cálido y acogedor, que invite a comprar una casa y que los propios corredores quieran usar. Paleta de tonos tierra (crema, arena, terracota suave, verde salvia y madera), tipografía con título serif elegante y texto limpio, fotos grandes de las propiedades como protagonistas, tarjetas con esquinas suaves y sombras tibias, una portada «Hoy» con una imagen de bienvenida y el saludo por nombre, y estados vacíos con ilustraciones de hogar. **Primero una muestra** (marco, «Hoy», lista y ficha de una propiedad) que el operador ve; con su visto bueno, se aplica a todo el panel como T01. Se mantiene el contraste AA y el uso en el teléfono.
- **Archivos principales:** `apps/web/src/index.css` (tokens), `apps/web/src/components/ui/`, `Layout.tsx`, y todas las páginas
- **Hecho cuando:** (D3) la muestra se publica para el operador antes de aplicar; no quedan colores ni clases del diseño anterior; las pruebas del panel pasan sin cambiar sus aserciones; contraste AA verificado; `pnpm check` pasa (CI)

### F9.5-T27 · Publicar a diario desde AgentPey
- **Depende de:** T22, T24 y T25 (en parte)
- **Descripción:** que el flujo semanal de una marca sea corto en las cinco redes: (1) **«Aprobar la semana»**: ver las ideas aceptadas de la semana con sus textos por red, aprobarlas y programarlas de una vez, con las horas de la cadencia; (2) por red: **Discord** y **X** quedan listos para vivo (revisar tope de X, imágenes y video con su variante, enlace marcado); **LinkedIn a mano** con un asistente «Copiar texto y abrir LinkedIn» y confirmar con el enlace; **TikTok** en borrador con el video listo y la nota de que publicar directo espera la auditoría; (3) una lista **«Lista para publicar a diario»** en Cuentas por marca: cuenta conectada, prueba de entrada hecha, modo de la marca, worker programado, tope de gasto; (4) la guía paso a paso para el operador (`docs/12-demo-oficina.md` se amplía o una guía nueva).
- **Archivos principales:** `apps/web/src/pages/` (Plan y Calendario), `apps/web/src/components/accounts/`, `packages/core/src/use-cases/schedule-subject.ts`, `docs/08-guia-operador.md`
- **Hecho cuando:** (se completan con las tareas anteriores) aprobar y programar una semana de ideas en una sola acción (test); la lista por marca dice qué falta (test); `pnpm check` pasa (CI)

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
| 2026-10-22 | **Lote 3** (T20 a T27): lo que vio el operador como corredor nuevo y publicar a diario desde AgentPey; ADR-0036 (en vivo por marca) y ADR-0037 (worker programado, propuesto) |
| 2026-10-22 | **Cierre del lote 2** (`v1.5.0`): T14 a T19 integradas en #233 a #239 |
| 2026-10-23 | **Cierre del lote 3** (`v1.6.0`): T20 a T27 integradas en #241 a #251 |
| 2026-10-22 | T25 (PR #249, revisión del `revisor` y del `arquitecto`): la indicación para la IA de imágenes sale del tema y la primera oración del brief, sin la IA de texto (editable); el costo de una imagen con IA se reserva de forma atómica antes de llamar, y después de llamar nada se reintenta solo |
| 2026-10-22 | **Lote 2** (T14 a T19) con las observaciones del operador en su primera prueba en el servidor; ADR-0035 (borrar un corredor) |
| 2026-10-22 | T19 (PR #239, revisión del `revisor`): las decisiones del operador sobre la música (solo CC0 sin crédito, mezcla con la música detrás a −18 dB, todas las redes, sin música por defecto; en un aviso se aplica al rehacer las imágenes, en un post solo); el criterio de atribución pasa a «solo pistas CC0 (test del catálogo)» |
| 2026-10-22 | **Cierre de la fase** (T13, `v1.4.0`): 12 tareas en 14 PR (#217 a #230); la guía de la demo en `docs/12-demo-oficina.md` y el paso «En vivo solo durante una demo» en `docs/10-despliegue.md` |
| 2026-10-22 | T06 (PR #224, revisión del `revisor`): D7 precisada con lo implementado: una red con 0 posts por semana no es candidata (`OUT_OF_CADENCE`); con días u horas vacíos solo se completa lo que falta y se conservan sus posts por semana; el espacio mínimo es como máximo `ceil(posts por semana / días)` posts por día; las semanas con menos ideas cuentan también lo ya planificado. Nota de implementación en T06 (`PLAN_FALLBACK_PER_WEEK` de 3 a 1) |
