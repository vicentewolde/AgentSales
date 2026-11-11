# Spec F9.6 · Publicar a mano en X e Instagram

- **Estado:** **Aprobado** el 2026-11-10 por el operador (en el chat). ADR-0041 nuevo.
- **Rama base:** `main` (F9.5 cerrada, `v1.6.0`)
- **Referencias:** ADR-0029 (punto 9), ADR-0023, ADR-0036, ADR-0041 (nuevo), `docs/08-guia-operador.md` («Publicar a diario desde AgentPey», «El modo a mano»), `docs/integraciones/linkedin.md`, `docs/integraciones/x.md`

## 1. Objetivo
Que el operador publique a diario desde la marca AgentPey en **X e Instagram con lo más simple**: él dice los días y de qué quiere hablar; AgentSales arma el plan, los textos y las imágenes y deja todo en el **calendario**; a la hora, cada publicación aparece en «Hoy» con su texto listo y el operador **copia, pega y publica** desde su teléfono o su computador. Sin créditos de X, sin servidor en vivo y sin el trámite de Meta.

## 2. Alcance
- **Instagram a mano para marcas** (ADR-0041): cuenta sin credenciales, creada por el administrador con el usuario de Instagram.
- **Confirmar sin enlace** en X e Instagram («Ya lo publiqué»).
- **Asistente de copiar** en el post, en «Hoy» y en Seguimiento: X con «Copiar texto y abrir X», Instagram con el texto copiado y las imágenes o el video para bajar.
- **La rutina** documentada: pedir el plan con los días (`plan --days --guidance`), aceptar ideas, conseguir imágenes (tarjetas de la marca), «Aprobar la semana», y a la hora, «Hoy».
- Lo ya existente se reutiliza: calendario, plan, tarjetas, aprobar la semana, modo a mano de X.

## 3. Fuera de alcance
- Avisos en el teléfono o el correo a la hora de publicar (queda como idea: hoy se ve en «Hoy»).
- Publicar en Instagram por la API para la cuenta nueva (trámite de Meta aparte).
- Likes, reposts y respuestas automáticas (reglas de X: `docs/15-propuesta-radar-x.md`).
- Instagram a mano para los avisos de un corredor.

## 4. Diseño
- **D1.** `MANUAL_MODE_PLATFORMS` incluye `instagram`. `setAccountMode` rechaza `manual` en una cuenta de Instagram de un corredor que no es marca (`ACCOUNT_MODE_NOT_SUPPORTED`).
- **D2.** `activateManualInstagramAccount` (core): solo para una marca; `external_account_id = "manual:<usuario>"` (usuario en minúsculas, sin `@`, letras, números, punto y guion bajo), `credentials = null`, `meta = { mode: "manual", handle }`, `display_name = "@<usuario>"`. Desconecta la cuenta de Instagram conectada de la marca (una conectada por marca y plataforma) y se niega si esa tiene publicaciones `scheduled`, `publishing` o `awaiting_manual_confirm` (`ACCOUNT_HAS_PENDING_PUBLICATIONS`, con el id de una).
- **D3.** `POST /accounts/instagram/manual` (administrador, `{ broker, handle }`) y `pnpm -s cli accounts connect instagram --broker <slug> --manual --handle <usuario>`.
- **D4.** `CONFIRM_WITHOUT_URL_PLATFORMS = ["linkedin", "x", "instagram"]`; `confirmedWithoutLink` y los textos del panel ya dependen de esa lista.
- **D5.** Panel: `HandAssist` (generaliza al de LinkedIn) por red: LinkedIn y X abren el editor con el texto por un enlace normal; Instagram solo copia y muestra las imágenes o el video. El enlace de X es `https://x.com/intent/post?text=<texto>` (**NO VERIFICADO**; con el enlace entero sobre ~1.800 caracteres, el editor se abre vacío y el texto va por el portapapeles). Ninguna automatiza el navegador.
- **D6.** La lista «Lista para publicar a diario» dice, para Instagram a mano, «A mano: publicas tú desde la app y confirmas», sin pedir token ni prueba de entrada (S1 es para publicar por la API).
- **D7 (T05, ADR-0042).** El idioma de una imagen: `media.language` (`es`, `en` o `null` = sirve para todos los idiomas, lo de siempre), solo con sentido en los originales de un post. Se marca con `PATCH /posts/:id/media/:mediaId` (`{ language }`), `post upload --language`, `post media-language` y un selector bajo cada foto en el panel. Se niega con `POST_MEDIA_IN_USE` (409) si el post tiene publicaciones con sus medios ya fijados (aprobadas, programadas, publicándose, fallidas, esperando el clic, pausadas o con resultado dudoso).
- **D8 (T05).** Qué medios lleva un texto (`mediaForText`, core, la usan la publicación, la revisión, la vista previa y «Qué se publica»): en X, LinkedIn, Discord y TikTok, los de su idioma y los sin idioma; en Instagram, todos, primero los de su idioma y los sin idioma y después los de otros idiomas (cada grupo por `sortOrder`). Las tarjetas siguen su regla por idioma (ADR-0038). En Instagram, un post de imagen cuyas imágenes son de más de un idioma sale como carrusel (de 2 a 10).
- **D9 (T05).** El orden de lo subido sigue el orden del pedido: `post_uploads.sort_order` se reserva al pedir la URL, y `complete` (y el worker, para los archivos grandes) crea cada medio con ese orden. `post_uploads.language` lleva el idioma pedido con `--language` hasta el medio.

## 5. Tareas
### T01 · Core: Instagram a mano para marcas y confirmar sin enlace
- **Archivos:** `packages/core/src/platform-account.ts`, `use-cases/connect-linkedin-account.ts` (`setAccountMode`), `use-cases/confirm-manual-publication.ts`, nuevo `use-cases/connect-instagram-manual-account.ts`, `social/daily-readiness.ts`, `index.ts`.
- **Hecho cuando:** los puntos D1, D2 y D4 con sus pruebas (unitarias y de repositorio con PGlite donde toque): marca sí, corredor de propiedades no; cuenta anterior desconectada; negativa con pendientes; Instagram y X confirman sin enlace; las demás redes siguen exigiéndolo.

### T02 · API y CLI
- **Archivos:** `apps/api/src/routes/accounts.ts` y su contrato, `apps/api/src/access.ts` (permiso del administrador, como Marketplace a mano), `apps/cli/src/commands/accounts.ts`.
- **Hecho cuando:** D3, con pruebas de la ruta (rol, validación del usuario, 201) y del comando; `publications confirm <id> --no-url` sirve para X e Instagram.

### T03 · Panel
- **Archivos:** `apps/web/src/components/posts/` (`HandAssist`, `handAssist.ts`, el actual `LinkedIn*`), `agenda/agenda.ts`, `HomePage`, `TrackingPage`, `PostPublishing`.
- **Hecho cuando:** D5: en el post, en «Hoy» y en Seguimiento, una publicación a mano de X o Instagram muestra su asistente; «Ya lo publiqué» no pide enlace; LinkedIn sigue igual. Pruebas del módulo puro (enlace de X, límite de largo) y del filtro de la agenda.

### T04 · Documentación y cierre
- **Archivos:** `docs/08-guia-operador.md` (la rutina «Publicar a mano en X e Instagram»), `docs/integraciones/x.md`, `docs/integraciones/instagram-contenido-propio.md`, `docs/ESTADO.md`, ADR-0029 (nota al punto 9).
- **Hecho cuando:** la guía describe la rutina completa y qué hacer con la cuenta nueva; el operador probó una publicación a mano de X y una de Instagram (en `docs/ESTADO.md`).

### T05 · El idioma de cada imagen (ADR-0042)
- **Archivos:** `packages/core` (nuevo `post-media-language.ts`, `media.ts`, `ports/media-repository.ts`, `post.ts`, `use-cases/post-uploads.ts`, `use-cases/open-publications.ts`, `social/check.ts`, nuevo `use-cases/post-media-language.ts`), `packages/db` (esquema, migración, repositorios de medios y subidas), `apps/api` (`routes/posts.ts`, contratos, `access.ts`, `errors.ts`), `apps/cli` (`post upload --language`, `post media-language`, `post show`), `apps/web` (`PostMedia`, `preview/`, `PostSummary`), `docs/02-modelo-datos.md`, `docs/08-guia-operador.md`.
- **Hecho cuando:** D7 a D9 con sus pruebas: la función pura (X separa por idioma, Instagram junta y ordena, el post de imagen bilingüe es carrusel), la revisión cuenta los medios de cada texto, el repositorio con PGlite guarda y lee el idioma y el orden reservado, la ruta (rol, 404, 409, archivado), la CLI y el selector del panel; dos archivos subidos en un pedido quedan en el orden pedido aunque terminen al revés.

## 6. Criterios de aceptación
1. `accounts connect instagram --broker agentpey --manual --handle <usuario>` crea la cuenta a mano y lo dice; en un corredor de propiedades se niega.
2. Una publicación de Instagram programada para AgentPey aparece en «Hoy» a su hora con el texto, y se confirma con «Ya lo publiqué» sin enlace.
3. Lo mismo en X con la cuenta en modo a mano, con «Copiar texto y abrir X».
4. Con una cuenta de Instagram por la API con publicaciones pendientes, activar la manual se niega.
5. `pnpm check` en verde (la CI) y ninguna prueba toca redes reales.

## 7. Riesgos
| Riesgo | Mitigación |
|---|---|
| El enlace `x.com/intent/post` cambia o no precarga el texto | NO VERIFICADO; el portapapeles es el respaldo y el botón sigue sirviendo |
| Sin enlace no se abre el post desde Seguimiento ni se retira por la API | Se dice en la guía; borrar a mano |
| Una cuenta de Instagram por la API desconectada deja publicaciones atadas | La activación se niega con pendientes (D2) |
| El operador se olvida de publicar | «Hoy» y la agenda marcan lo atrasado; los avisos quedan como idea |

## 8. Preguntas abiertas
- ¿Un aviso (correo o WhatsApp) a la hora de cada publicación? Se decide con el uso real.

## 9. Registro de cambios del spec
- 2026-11-10: creado y aprobado por el operador.
- 2026-11-11: T05 (el idioma de cada imagen, D7 a D9, ADR-0042), a pedido del operador.
