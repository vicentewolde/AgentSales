# 08 · Guía del operador: cómo trabajar con Claude Code en este proyecto

Esta guía es para ti (Vinny), no para Claude. Explica el ciclo de trabajo, los comandos de git que vas a usar y los hábitos que mantienen el proyecto ordenado.

> **El servidor en internet** (`https://agentsales.agentpey.com`, desde F8) tiene su propia guía: `docs/10-despliegue.md` (desplegar, encender y apagar el worker para una demo, logs, volver atrás, restaurar un respaldo del servidor). Esta guía habla de tu Mac, salvo donde diga lo contrario.

## El rol de cada uno
- **Tú:** product owner y líder técnico. Apruebas specs y planes, respondes preguntas de producto, haces los trámites de cuentas, pruebas las demos y haces el merge de los PRs.
- **Claude Code:** desarrollador. Planifica tareas, implementa, testea, documenta y hace commits en ramas.
- **Subagentes:** `arquitecto` cuida el diseño, `revisor` revisa el código antes del PR e `integraciones` investiga APIs externas.

## Ciclo de trabajo

```
Fase:   /fase-plan N ──► (tareas) ──► /fase-cerrar N ──► tag
Tarea:  /estado ─► /tarea FN-TXX ─► apruebas el plan ─► implementa + tests
        ─► /revisar ─► push + PR ─► revisas en GitHub ─► merge ─► /clear
```

### Una sesión típica (30 a 90 minutos)
1. Abre la terminal en la carpeta del proyecto y ejecuta `claude`.
2. `/estado` → te dice dónde vas y qué sigue.
3. `/tarea F0-T01` (o la que indique `/estado`).
4. Claude presenta un **plan**. Léelo. Si algo no te calza, dilo antes de aprobar: es el momento más barato para corregir.
5. Claude implementa. Aprueba o rechaza los permisos que te pida (git push, migraciones, etc.).
6. `/revisar` → corrige lo bloqueante.
7. Pide a Claude hacer push y abrir el PR, o hazlo tú (ver git abajo).
8. En GitHub: mira el PR, espera el check verde de CI y haz **Squash and merge**.
9. En la terminal: `git switch main && git pull`.
10. `/clear` antes de la siguiente tarea (contexto limpio = mejores resultados).

## Git: los comandos que vas a usar

```bash
git status                       # qué cambió
git switch main && git pull      # volver a main actualizado
git switch -c feat/f0-t01-...    # nueva rama (Claude lo hace en /tarea)
git log --oneline -10            # últimos commits
git push -u origin <rama>        # subir la rama
gh pr create --fill              # abrir el PR (requiere GitHub CLI: gh auth login)
git tag -a v0.0.1 -m "F0"        # marcar el cierre de fase
git push origin --tags
```

Reglas: `main` solo recibe cambios por PR; una rama por tarea o por lote de tareas relacionadas; nunca `--force` sobre `main`.

## Atajos útiles de Claude Code
- **Shift+Tab**: cambia de modo; incluye el **modo plan**, en el que Claude solo analiza y no edita. Útil para preguntas de diseño.
- `/clear`: contexto nuevo. Úsalo entre tareas.
- `/context`: cuánto contexto está ocupado.
- `/agents`: ver y editar subagentes.
- `claude -c`: retomar la última conversación.
- Escribe `/` para ver las skills del proyecto (`estado`, `tarea`, `revisar`, `adr`, `fase-plan`, `fase-cerrar`).

## Hábitos que marcan la diferencia
- **No saltarse el spec.** Si se te ocurre una funcionalidad nueva, anótala en el backlog del roadmap; no la metas a mitad de una tarea.
- **Tareas chicas.** Si una tarea se alarga más de una sesión, pide partirla.
- **Lee los diffs de los PRs**, aunque sea por encima. Es la mejor forma de aprender el código.
- **Cuando Claude se equivoca de forma recurrente**, no lo corrijas solo en el chat: agrega la regla a `CLAUDE.md` o a la skill correspondiente.
- **Decisiones → ADR.** Si discutes una alternativa por más de 5 minutos, merece `/adr`.
- **Demo al cerrar cada fase.** Si no puedes demostrarla, no está terminada.

## Qué hacer cuando…
| Situación | Acción |
|---|---|
| Claude propone algo fuera del spec | "Fuera de alcance; anótalo en el backlog del roadmap" |
| Es la primera vez con F7, olvidaste tu contraseña o te bloqueaste | `pnpm auth:admin --email tu@correo.cl` en tu terminal (no necesita `pnpm dev`; para el servidor, `ENV_FILE=.env.production pnpm auth:admin --email tu@correo.cl`, que también te quita el doble factor al usar el enlace): crea tu administrador o te da un enlace nuevo, en el portapapeles. Ábrelo con `pnpm dev` corriendo y elige tu contraseña. Después, `pnpm -s cli login --email tu@correo.cl` para la CLI (Claude la usa con tu sesión) |
| Un comando dice "Inicia sesión" (`AUTH_REQUIRED`) | La sesión de la CLI venció (30 días, o 7 sin uso) o se cerró: `pnpm -s cli login --email tu@correo.cl` en tu terminal (con un servidor, agrega `--api https://<dominio>`) |
| Quieres usar la CLI contra el servidor | `pnpm -s cli login --email tu@correo.cl --api https://agentsales.agentpey.com` en tu terminal: la dirección queda guardada con la sesión y todos los comandos van allí (`whoami` dice cuál). Para volver a la API del Mac, `pnpm -s cli login --email tu@correo.cl` sin `--api`. Para una prueba puntual, `AGENTSALES_API_URL=https://… pnpm -s cli status` manda sobre la guardada (el token no viaja a un servidor que no lo emitió); ojo: un `login` con la variable puesta deja guardada esa dirección, como `--api`. Solo `https://`, salvo `localhost` y `127.0.0.1` |
| `pnpm check` falla y no se arregla | Pídele diagnosticar la causa raíz antes de intentar más cambios; si persiste, `/clear` y retoma con `/tarea` |
| Una API externa no se comporta como dice el doc | Pide al subagente `integraciones` verificar y actualizar las notas; luego ajusta el spec |
| Quieres cambiar el stack o un patrón | `/adr "..."` primero, código después |
| Perdiste el hilo entre sesiones | `/estado` |
| Quieres preparar el contenido de una propiedad | Con `pnpm dev` corriendo: `pnpm -s cli prepare P001` (espera y muestra la revisión), y después `pnpm -s cli content P001` para leer los textos (`--platform portal` para uno solo). Con `LLM_PROVIDER=fake` en `.env` no gasta cuota |
| Una propiedad no tiene video y quieres un reel | Con 3 fotos o más, preparar el contenido arma el reel con ellas (la portada primero, unos 3 s cada una con un fundido, hasta 10 fotos, y el texto encima al comienzo); en **Contenido → Instagram** dice «Reel armado con tus fotos», y `content` dice «Reel: sí, armado con tus fotos». Cambiar la portada, el orden de las fotos o el precio lo rehace al preparar de nuevo. Si subes un video, el reel pasa a salir del video. Al aprobar Instagram se abren **dos publicaciones**, el carrusel y el reel (antes, sin video, solo el carrusel): `publish` las publica las dos, y si no quieres el reel, descarta esa publicación (`pnpm -s cli publications cancel <id>`) |
| `prepare` dice `CONTENT_EDITED` | Editaste textos a mano y prepararlos de nuevo los reemplazaría: usa `--no-texts` para rehacer solo las imágenes, o `--replace-edits` si quieres textos nuevos |
| `prepare` dice "Sigue en cola" | El worker no está corriendo: levanta `pnpm dev` (la corrida espera en cola y arranca sola). `publish` dice "en cola o esperando su turno": el worker publica de a una, y un carrusel tarda más de 20 s en dar señales |
| Una corrida de contenido falla con `LLM_AUTH_REQUIRED` | La CLI de Claude perdió la sesión: abre `claude`, usa `/login` y prepara de nuevo. `pnpm -s cli doctor` muestra si tiene sesión |
| `doctor` marca ffmpeg o ffprobe en rojo, o una corrida falla con `MEDIA_TOOL_NOT_INSTALLED` | Falta ffmpeg o es anterior a 8.1 (no arma las fotos HEIC del iPhone): `brew install ffmpeg` o `brew upgrade ffmpeg`. Si está en otra ruta, ajusta `FFMPEG_PATH` y `FFPROBE_PATH` en `.env` |
| `doctor` marca Chromium en rojo, o una corrida falla con `RENDER_BROWSER_NOT_INSTALLED` | Falta el Chromium que pide la versión de Playwright del proyecto (pasa también al actualizarlo): `pnpm --filter @agentsales/media exec playwright install chromium` |
| Quieres ver cómo redacta la IA sin tocar la base | `pnpm eval:content` en tu terminal: evalúa las propiedades listas de `agentsales-pruebas` con tu CLI de Claude (descuenta del plan), muestra la revisión por canal y deja los textos en `tmp/eval/<fecha>/`. Termina con error si algún texto tiene errores. `--provider fake` prueba el comando sin gastar cuota. Ctrl+C corta la llamada en curso y no sigue con las demás |
| Quieres ver qué ideas y textos de posts propone la IA, y cuánto cuestan | `pnpm eval:social` en tu terminal: corre el plan y los textos de 3 ideas sobre cuatro marcas inventadas (sin hechos, con dos idiomas, con historial y con un pedido que trae datos falsos), sin tocar la base, y cuenta ideas repetidas, datos inventados, ideas que hablan de «nosotros» sin ser un equipo, largos, escapes y menciones masivas, con el costo del plan y de los textos. `--profile dos-idiomas --ideas 10` mide un plan completo; `--provider anthropic-api` usa la API (centavos) y `--provider fake` no gasta nada; `--out` deja el detalle en `tmp/eval-social/`. Termina con error si un texto tiene errores o escapes, o si la IA falla; las ideas que el plan descarta son la defensa funcionando (con `--strict`, también hacen fallar) |
| Quieres comprobar que la CLI de Claude responde | `pnpm llm:smoke` en tu terminal: una llamada corta con datos inventados (descuenta del plan) |
| Quieres conectar tu Instagram (o reconectarlo: cuenta vencida o `IG_AUTH_INVALID`) | En el panel de Meta, tu app → Casos de uso → API de Instagram → "Genera identificadores de acceso" → **Generar identificador** (en inglés, **Generate token**) junto a tu cuenta, y cópialo. Con la API corriendo: `pbpaste | pnpm -s cli accounts connect instagram --broker agentsales-pruebas --token-stdin`. Revisa con `pnpm -s cli accounts` o en **Cuentas** del panel |
| Publicar y Programar están en gris en un aviso | El corredor no tiene conectada la cuenta de esa red: debajo dice «Conecta tu cuenta de Instagram en Cuentas para publicar» (o «Reconecta…» si la cuenta venció o se desconectó) con el enlace **Ir a Cuentas** (F9.5-T20). Conéctala y el botón se activa solo; el texto aprobado no se pierde |
| Un error del panel dice «No se pudo completar la acción» | Los errores se muestran en simple (F9.5-T20): una frase que dice qué pasó y qué hacer, y al final, chico, `código: X` para reportarlo (o buscarlo en esta guía). Los códigos frecuentes tienen su frase propia (`ACCOUNT_NOT_CONNECTED`, `USER_EMAIL_TAKEN`, …); el resto muestra el mensaje general y debajo el detalle de la API. Lo mismo en el error de una publicación fallida, de una preparación y en Seguimiento: la frase y, al final, «(código: X)» |
| Quieres aprobar y publicar en simulación | En la sección Contenido de la propiedad: "Aprobar Instagram" y "Publicar en Instagram (simulación)", o `pnpm -s cli approve P001` y `pnpm -s cli publish P001`. No llama a Instagram: la bitácora muestra lo que se habría enviado. Retíralas al terminar ("Marcar como retirada" o `pnpm -s cli publications retire <id>`) |
| Una publicación dice «simulación» o «en vivo» | Una aprobada todavía no tiene modo: muestra el del sistema (el de la franja de arriba), porque es el que usará al publicarla. Desde F9.5-T22 la franja dice el modo de **la marca elegida** en el selector («Simulación: nada se publica en las redes» o «En vivo: lo que publiques en <marca> sale de verdad»); con «Todos», dice el modo del servidor y cuántas marcas están en vivo. Desde que se programa o se publica, muestra el suyo aunque el sistema cambie después: una fallida que empezó en vivo sigue diciendo «en vivo». En Instagram, un post con una sola foto se llama «imagen» y con varias, «carrusel». El botón Publicar aparece solo si queda algo por publicar |
| Quieres encender o apagar el modo en vivo de una marca (F9.5-T22, ADR-0036) | Una marca publica de verdad solo con **dos llaves**: el servidor en `PUBLISH_MODE=live` y la marca encendida. Con cualquiera apagada, todo es simulación. Todas las marcas nacen apagadas y solo las propias (`--own`) pueden encenderse. Solo tú (administrador) lo cambias, y solo cuando lo decidas: `pnpm -s cli brokers live <slug> on --confirm <slug>` (`--yes` no basta para encender: repites el identificador), `pnpm -s cli brokers live <slug> off` para apagar, o el interruptor «Modo en vivo» en la ficha del corredor (**Corredores**), que pide escribir el identificador. `pnpm -s cli status` y `doctor` dicen el modo del servidor y las marcas encendidas; `brokers show <slug>` dice si esa marca publica hoy en simulación o de verdad. Para volver atrás: apaga la marca, o pon `PUBLISH_MODE=dry-run` en el servidor (apaga todas) |
| Quieres publicar de verdad en Instagram | Solo cuando lo decidas tú: `PUBLISH_MODE=live pnpm dev` (no se toca `.env`), con la marca encendida (`brokers live <slug> on --confirm <slug>`; sin eso sale en simulación), y "Publicar en Instagram (en vivo)" en el panel o `pnpm -s cli publish P002` (pide confirmación). Para borrarla: en Instagram, `···` → Eliminar, y después "Marcar como retirada" (o `publications retire <id>`), que confirma que la borraste a mano. Al terminar, detén `pnpm dev` y arranca sin la variable |
| Quieres publicar en Portal Inmobiliario (simulación) | `pnpm -s cli approve P001 --platform portal` (avisa si le falta algo al aviso) y `pnpm -s cli publish P001 --platform portal`. En simulación solo lee de Mercado Libre y le pregunta si el aviso es válido: nunca lo crea. Si falta información (`PORTAL_NOT_READY`), la CLI la lista: complétala en la planilla y vuelve a importarla |
| Quieres conectar Mercado Libre (o reconectarlo: cuenta vencida o `ML_AUTH_INVALID`) | En **Cuentas** del panel, el bloque Mercado Libre del corredor muestra los dos comandos para copiar: el primero abre el enlace (autoriza con la cuenta administradora); al volver, el navegador muestra un error de conexión (es lo esperado), copias la dirección completa de la barra (vale 10 min) y corres el segundo |
| Quieres un usuario de prueba de Mercado Libre (para publicar en Portal sin pagar) | Sigue el paso a paso de `docs/07-checklist-cuentas.md` (sección F4): crearlo (con `pnpm ml:test-user --broker agentsales-pruebas`, que deja la clave en tu portapapeles), pedir su activación a soporte, contratar el paquete sin cargo con su sesión (nunca con tu cuenta real: ahí cobra) y conectarlo en una ventana privada. Su clave va solo a tu gestor de claves |
| Quieres publicar en Portal desde el panel | En Contenido, pestaña **Portal Inmobiliario**: arriba dice lo que le falta al aviso. Aprueba el texto y usa "Publicar en Portal Inmobiliario". El aviso publicado muestra su estado en Mercado Libre y el vencimiento, con Pausar, Reactivar, Cerrar (pide confirmación), Actualizar (lee su estado; solo en vivo), "Actualizar aviso" (manda el precio o el texto nuevos), "Republicar" (uno vencido o cerrado) y "vence en N días" |
| Quieres saber si Mercado Libre aceptaría el aviso de una propiedad, sin publicar | `pnpm ml:smoke --listing P001` en tu terminal (no necesita `pnpm dev`; necesita el texto de Portal preparado). Arma el aviso real y solo le pregunta a Mercado Libre si lo aceptaría: nunca sube fotos ni crea nada. Sin paquete con cupo dice "no verificado"; con el usuario de prueba y su paquete, lo revisa completo. El informe queda en `tmp/ml-smoke/` |
| Quieres pausar, reactivar, cerrar o actualizar un aviso de Portal | `pnpm -s cli publications P001` muestra el id, el estado en Mercado Libre y el vencimiento. Luego `pnpm -s cli publications pause <id>`, `resume <id>`, `close <id>` (en vivo pregunta: es irreversible y volver a publicar usa otro cupo) o `sync <id>` (pide leer el estado; el worker tiene que estar corriendo). Si la CLI dice `OPERATION_UNCONFIRMED`, no lo repitas: el cambio pudo aplicarse; míralo con `publications P001` o pide la lectura con `sync` |
| Quieres publicar de verdad en Portal Inmobiliario | Pendiente (D15 de F4): con el usuario de prueba conectado y su paquete; ver la checklist (`docs/07-checklist-cuentas.md`) |
| `PUBLICATION_LISTING_CHANGED` | Reimportaste la planilla después de aprobar: descarta la publicación y aprueba de nuevo |
| `PUBLICATION_PENDING` al preparar o `CONTENT_LOCKED` al editar | El texto está aprobado y tiene publicaciones que no han salido (o ya salieron): publícalas, descártalas o retíralas primero. Es a propósito: lo aprobado no cambia |
| `PUBLISH_MODE_MISMATCH` o `PUBLISH_MODE_LOCKED` | Una publicación pedida en vivo llegó a un worker en simulación, o a una marca que ya no está en vivo (la apagaste o dejó de ser propia), o una que ya empezó en vivo se quiso reintentar en simulación: arranca con `PUBLISH_MODE=live`, enciende la marca (`brokers live <slug> on --confirm <slug>`) y reintenta |
| `LIVE_NOT_ALLOWED` o `LIVE_NOT_CONFIRMED` | Encender el modo en vivo de un corredor que no es propio (no se puede hasta que haya un ADR de clientes), o sin repetir su identificador: usa `--confirm <slug>` |
| Una publicación queda en "publicando" mucho rato | El worker no corre o se cortó: levanta `pnpm dev` (la reencola al arrancar; con el worker corriendo, la vigilancia de cada hora la reencola sola si lleva más de 70 min, salvo Marketplace) o usa "Volver a encolar" en el panel. Nunca publica dos veces |
| `IG_PUBLISH_OUTCOME_UNKNOWN` | No se sabe si salió (queda "no se sabe si salió" en la agenda; no se reintenta sola). Mira tu Instagram: si salió, `pbpaste \| pnpm -s cli publications resolve <id> --published --url-stdin` con el enlace copiado; si no, `publications resolve <id> --not-published` y después `publications retry <id>`. En el panel, lo mismo en la sección Contenido de la propiedad: **Sí, salió** (pega el enlace si lo tienes) o **No salió** (queda fallida y puedes **Reintentar**) |
| `ML_PUBLISH_OUTCOME_UNKNOWN` | No se sabe si el aviso se creó (queda "no se sabe si salió" en la agenda; no se reintenta sola: volver a publicar gasta otro cupo). Búscalo en tus publicaciones de Mercado Libre. Si hay más de uno, cierra a mano los que sobren. Si quedó uno, copia su enlace (o su número `MLC…`) y corre `pbpaste \| pnpm -s cli publications resolve <id> --published --url-stdin` (en vivo es obligatorio); si no quedó ninguno, `publications resolve <id> --not-published` y después `publications retry <id>`. En el panel, en la pestaña Portal de la sección Contenido: pega el enlace o el número en el campo y aprieta **Sí, salió** (en vivo el botón espera a que lo pegues); **No salió** pregunta antes si cerraste a mano los avisos que quedaron (**Sí, no quedó ninguno** lo confirma). Si el enlace no sirve, el error sale en el mismo recuadro |
| `PORTAL_ITEM_IN_USE` al decir que salió | El enlace o el número que pegaste es del aviso de otra publicación de la misma propiedad (por ejemplo, el aviso anterior a republicar): busca en Mercado Libre el aviso que salió ahora y pega ese |
| Resolviste «salió» un aviso **republicado** y pausar, reactivar, cerrar o "Actualizar aviso" dicen `PORTAL_PROGRESS_UNUSABLE` | Es lo esperado: el corte fue antes de que AgentSales guardara las fotos y el contacto del aviso nuevo, y sin ellos Mercado Libre no acepta cambios (tampoco con `publications update <id>`). El estado y el vencimiento sí se leen (`publications sync <id>`). Esos cambios hazlos a mano en Mercado Libre; si no quieres seguir así, ciérralo allá y republica desde AgentSales |
| Quieres renovar el token | Lo hace el worker solo (al arrancar y a las 12:00, hora de Chile): Instagram, 24 h después de conectar o del último refresco; Mercado Libre, cada 7 días (si falta `ML_APP_ID` o `ML_CLIENT_SECRET` en `.env`, se salta con un aviso en el log). A pedido: `pnpm -s cli accounts refresh <id>`; en Instagram, `--force` no espera a que falten 30 días, pero sí respeta las 24 h; en Mercado Libre, `--force` renueva siempre. Como el worker corre solo con `pnpm dev`, ábrelo de vez en cuando: con 4 meses sin renovarse, Mercado Libre da de baja el acceso (Instagram, a los 60 días) y hay que reconectar la cuenta |
| Quieres comprobar que Instagram descarga las fotos desde R2, sin publicar | `pnpm ig:smoke` en tu terminal, con la cuenta conectada (no necesita `pnpm dev`): le pide a Instagram que prepare la portada de la primera propiedad preparada (`--listing <id_propiedad>` para elegir otra; `--broker <slug>` si hay cuentas en varios corredores) y espera hasta 5 min. `✓` si la descargó; si no, el código (`IG_MEDIA_FETCH_FAILED` es que no pudo bajar el enlace de R2). Nunca publica, ni siquiera en `live`: lo preparado vence solo en 24 h. Habla con Instagram aunque estés en `dry-run` |
| Quieres que Claude conozca el formulario de Marketplace (F5) | `pnpm fb:smoke --broker agentsales-pruebas` en tu terminal (no necesita `pnpm dev`). Se abre una ventana de Chromium con el perfil de Facebook del corredor (vive fuera del proyecto, en `~/.agentsales/browser-profiles`). La primera vez, inicia sesión a mano en esa ventana, también el código de verificación: el sistema no escribe nada y espera hasta 10 min. Después guarda en `tmp/fb-smoke/` la captura y el árbol **del formulario** (sin la barra con tu nombre) y un resumen, y cierra la ventana. No llena nada ni hace clic. Avísale a Claude: lee solo el árbol del formulario |
| Claude necesita ver las opciones de un menú del formulario o las sugerencias de un campo | `pnpm fb:smoke --broker agentsales-pruebas --menus`. Hace lo mismo y, con el formulario a la vista (la ventana abre directo en `/marketplace/create/rental`), te pide: abre **a mano** en la ventana un menú (por ejemplo, el tipo de propiedad), o escribe algo en un campo con sugerencias (por ejemplo, la dirección), deja la lista a la vista y aprieta Enter en la terminal; se guarda `captura-1.aria.yml`. Repite con cada menú y escribe `listo` **solo cuando hayas terminado con todos**. El sistema no toca nada; nunca hagas clic en Siguiente ni en Publicar. Solo se guardan las listas de un menú **del formulario** desplegado; igual, no abras el menú de tu cuenta ni las notificaciones mientras tanto (podrían traer tu nombre) |
| Quieres probar el llenado real del formulario con una propiedad, sin publicar (F5) | `pnpm fb:smoke --listing P001` (con `--broker <slug>` si el código está en más de un corredor). No necesita `pnpm dev`, pero sí el texto de Marketplace aprobado, el Facebook del corredor conectado y, si el precio está en UF, `BCCH_API_TOKEN`. Te dice cuántos intentos lleva la cuenta hoy (se niega si llegó al límite) y pregunta `¿Llenar el formulario real de Facebook? s/N` (`--yes` para no preguntar). Llena el formulario y sube las fotos en una ventana de Chromium (la superficie se escribe en **pies cuadrados**, convertida desde tus m², y no hay campo de título), que queda abierta: **no hagas clic en Publicar**. Ciérrala cuando termines (o Ctrl+C) . Cerrar la ventana no deja un borrador (solo lo guarda el botón «Guardar borrador», que el sistema no aprieta); igual, revisa en Marketplace → Tus publicaciones que no quedó uno. Si Facebook muestra «¡Uy! Se ha producido un error», ciérralo: «Siguiente» sigue funcionando. Para investigarlo: `pnpm fb:smoke --listing P002 --diagnostico errores` (o `sin-evidencia`, `sin-fotos`, `lento`, separadas por coma): hace lo mismo y además anota los errores técnicos de la página en `tmp/fb-smoke/fb-smoke-<id>/errores-de-la-pagina.txt`, sin datos tuyos; dile a Claude y, con tu permiso, lo lee. No cambia nada en AgentSales ni cuenta en el límite. La captura del formulario lleno queda en `tmp/fb-smoke/fb-smoke-<id>/` (muestra las fotos y la ubicación): no la compartas; Claude lee solo, con tu permiso, los árboles y los archivos de diagnóstico de esa carpeta (nunca las capturas) |
| `fb:smoke` dice "Pasaron 10 minutos sin sesión" | Iniciar sesión o la verificación tomaron más de 10 min. Vuelve a correrlo: si alcanzaste a iniciar sesión, la sesión quedó en el perfil y va directo al formulario |
| `fb:smoke` dice que el perfil está abierto (`MARKETPLACE_PROFILE_BUSY`) | Otra ventana de Chromium tiene el perfil (por ejemplo, el worker con un formulario): ciérrala y vuelve a correrlo |
| `fb:smoke` pide una verificación, dice Marketplace no disponible o "el formulario cambió" | Una verificación (código, "confirma tu identidad", captcha) la resuelves tú, a mano, **en la misma ventana de Chromium** que abrió el comando: el sistema espera y no la toca. Si Marketplace no está disponible, revisa el estado de tu perfil en Facebook (Perfil → Estado del perfil → Marketplace). No reintentes en bucle. Si "el formulario cambió", avísale a Claude con `tmp/fb-smoke/summary.json` (solo trae la ruta y nombres de archivo, nada tuyo) |
| Quieres comprobar el valor de la UF (Marketplace convierte la UF a pesos) | `pnpm uf:smoke` en tu terminal (no necesita `pnpm dev`): muestra la UF de hoy con tu `BCCH_API_TOKEN`, si el Banco Central ya trae los días siguientes y cómo responde un token inventado. Nunca muestra tu token |
| `UF_SOURCE_AUTH_INVALID`, o `doctor` avisa por `BCCH_API_TOKEN` | El token del Banco Central falta, está mal copiado o venció (dura 1 año): entra a la BDE → Mi Cuenta → Apikey Token, renuévalo o extiéndelo y déjalo en `.env` con `pbpaste` |
| `UF_VALUE_MISSING` o `UF_VALUE_SUSPICIOUS` | El Banco Central todavía no tiene la UF de hoy (pasa el día 10 temprano) o el valor no calza con el de ayer: reintenta más tarde. Nunca se publica con un valor viejo |
| `MARKETPLACE_FORM_OPEN`, `MARKETPLACE_DAILY_LIMIT` o `MANUAL_CONFIRM_PENDING` | Otro formulario de Marketplace de la cuenta espera tu clic (publícalo o márcalo "No lo publiqué"), la cuenta ya hizo sus 3 intentos de hoy (sigue mañana) o esta publicación espera que digas si la publicaste |
| Quieres programar desde el panel | En Contenido, "Programar" en cada publicación o "Programar <canal>" junto a Publicar; en Propiedades, marca las casillas y "Programar seleccionadas" (canales, hora y minutos entre propiedades). La hora es de Chile; en vivo te pide confirmar. La página **Seguimiento** muestra la agenda y cada propiedad por plataforma, y se actualiza sola cada minuto mientras la miras |
| Quieres programar publicaciones | Con `pnpm dev` corriendo: `pnpm -s cli schedule P001 P002 --at "2026-10-19 10:00"` (hora de Chile; `--platform instagram` para un canal, `--spacing 30` para dejar 30 min entre propiedades). Salen solas a la hora mientras el worker corre; si estaba apagado, salen al encenderlo con 12 h o menos de atraso, y si no quedan "atrasadas" en la agenda. Marketplace queda como recordatorio: a la hora te toca apretar Publicar. `pnpm -s cli unschedule <id>` la desprograma |
| Quieres ver qué está pendiente | `pnpm -s cli agenda`: lo atrasado, lo que te toca, lo atascado, lo que falló (con qué hacer), las tareas a mano, lo que espera tu revisión o quedó aprobado sin publicar (con publicación automática), Portal por vencer, lo próximo y el respaldo, cada uno con su comando. `pnpm -s cli tracking` muestra cada propiedad por plataforma |
| Vendiste o arrendaste una propiedad | En el detalle de la propiedad, "Vendida", "Arrendada" o "Retirada" (te pide confirmar y te dice qué quedó como tarea a mano), o `pnpm -s cli listing close P001 --reason vendida` (o `arrendada`, `retirada`): cierra el aviso de Portal y descarta lo pendiente. Lo que esté en vivo en Instagram o Marketplace queda como tarea a mano: bórralo allá y `pnpm -s cli publications retire <id>`. `listing reopen P001` la reabre (no publica nada). `listing pause|resume` pausa y reanuda la propiedad con su aviso de Portal |
| Cambiaste el precio de una propiedad publicada en Portal | Carga la planilla y `pnpm -s cli publications update <id>`: manda el precio (o el texto nuevo, si preparaste y aprobaste otro) al aviso. Si el aviso venció o lo cerraste, `publications relist <id>` lo republica (en vivo usa un cupo) |
| Quieres que un corredor publique sin tu revisión | En **Cuentas**, la casilla "Publicación automática" del corredor (en vivo te avisa en rojo), o `pnpm -s cli brokers auto-publish <slug> on`: al preparar los textos se aprueba lo que no tiene errores y se publica solo (Marketplace queda como recordatorio). En vivo, `status` y `doctor` lo dicen en rojo. `off` lo apaga |
| Un corredor no puede preparar los textos: "llegó a su tope de IA de este mes" (`LLM_BUDGET_EXCEEDED`) | Sube su tope en su detalle de **Corredores** (o `pnpm -s cli brokers edit <slug> --cap <usd>`, o `--no-cap`) o espera al mes siguiente. Las imágenes sí se preparan |
| `LLM_NOT_CONFIGURED` en un corredor que no es tuyo | Falta `ANTHROPIC_API_KEY` en `.env` (sus textos usan la API): agrégala y reinicia `pnpm dev`. `doctor` lo avisa |
| `LLM_ACCOUNT_LIMIT` | La cuenta de Anthropic llegó a su límite de gasto o no tiene saldo: revisa la consola de Anthropic |
| `LLM_AUTH_REQUIRED` en un corredor que no es tuyo | La clave de la API de Anthropic venció, se revocó o está mal copiada (la tuya vence el 2026-12-31): crea otra en la consola de Anthropic, déjala en `.env` como `ANTHROPIC_API_KEY` y reinicia `pnpm dev`. Comprueba con `pnpm llm:smoke --provider anthropic-api` |
| `MARKETPLACE_AUTOMATION_NOT_ALLOWED` | El formulario automático de Marketplace es solo para tus corredores propios (ADR-0023): para los demás, activa **Marketplace a mano** en su detalle de **Corredores** (o `pnpm -s cli accounts connect marketplace --broker <slug> --manual`) y el corredor publica él mismo |
| Quieres el doble factor (recomendado para ti, el administrador) | En el panel, tu nombre → **Mi cuenta** → **Activar el doble factor**: abre el enlace en tu app de claves del teléfono (o escribe la clave a mano), escribe el código de 6 dígitos y guarda los 10 códigos de recuperación en tu gestor de claves (se muestran una vez). Desde entonces, el panel y `pnpm -s cli login` piden el código después de la contraseña. Si pierdes el teléfono: un código de recuperación, o `pnpm auth:admin --email tu@correo.cl` (el enlace que deja te quita el doble factor al usarlo). Una CLI de antes de este cambio no sabe pedir el código: actualiza el repo. En una rama de Neon copiada de producción, entrar con doble factor da `TOTP_UNREADABLE`: corre `pnpm auth:admin` y usa su enlace |
| "Demasiados pedidos seguidos" (`RATE_LIMITED`) | Los límites por IP (F8): 10 intentos de entrar por minuto, 50 por hora; espera los segundos que dice el mensaje |
| Un usuario no puede entrar: "bloqueado" (`AUTH_LOCKED`) | Diez contraseñas equivocadas seguidas lo bloquean 15 minutos: que espere, o dale otro enlace con **Restablecer** en su detalle de **Corredores** (o `pnpm -s cli users reset <correo>`); elegir la contraseña nueva quita el bloqueo (y, al usar el enlace, también el doble factor). Si eres tú, `pnpm auth:admin --email tu@correo.cl` |
| Conectar Mercado Libre dice `OAUTH_STATE_USED` | Pegaste una dirección de vuelta que ya se usó (cada enlace de autorizar sirve una vez): corre de nuevo el primer comando del bloque Mercado Libre en **Cuentas** y autoriza otra vez |
| Quieres respaldar la base ahora | `pnpm db:backup` en tu terminal (no necesita `pnpm dev`). Deja `agentsales-AAAAMMDD-HHMM.dump` en `~/.agentsales/backups` (o en `BACKUP_DIR`) y conserva los últimos 14. El worker de tu Mac lo hace solo cada día a las 13:00 y al arrancar si el último tiene más de 20 h; el del servidor sube su respaldo a R2 (`agentsales-backups`), no a tu Mac. Más abajo, cómo restaurar |
| `BACKUP_TOOL_NOT_INSTALLED`, o `doctor` avisa por `pg_dump` | Falta el cliente de Postgres: `brew install libpq` (queda en `/opt/homebrew/opt/libpq/bin`, que el respaldo busca solo; si lo instalaste en otro lado, fija `PG_BIN_DIR` en `.env`) |
| `doctor` dice que `pg_dump` no puede respaldar una base más nueva | Tu `pg_dump` es de una versión mayor anterior a la de Neon: `brew upgrade libpq` |
| `BACKUP_FAILED` | `pnpm db:backup` muestra la causa: sin conexión o Neon sin CU-horas (reintenta más tarde), la carpeta sin espacio o sin permisos. Los respaldos buenos nunca se borran por un intento fallido |
| `BROKER_HAS_ACTIVE_PUBLICATIONS` al borrar un corredor | Tiene publicaciones publicándose, programadas, esperando tu clic o con resultado dudoso (la CLI las lista): desprográmalas (`unschedule <id>`) o cancélalas (`publications cancel <id>`), confirma o di «no lo publiqué» y resuelve las dudosas (`publications resolve <id>`); después, vuelve a borrar |
| `BACKUP_IN_PROGRESS` | Ya hay un respaldo en curso (el del worker o otro `pnpm db:backup`): espera unos minutos y vuelve a intentarlo |

## La portada del panel: «Hoy» (F9.5)

Al entrar al panel llegas a **Hoy**, la primera entrada del menú. Arriba, tres cifras (lo que te toca, lo próximo y lo publicado en los últimos 7 días) y debajo, tres tarjetas:

- **Te toca:** lo que espera algo de ti: un resultado dudoso (di si salió o no), lo atrasado, lo que falló, lo que hay que publicar a mano, los textos por revisar, lo aprobado sin publicar, las cuentas por reconectar y Portal por vencer. Cada fila dice qué es (la insignia), qué hacer y lleva a su propiedad, a su post o a Cuentas. Cada publicación dice su red y su formato («Instagram · carrusel», «· reel», «· imagen»), así el carrusel y el reel de una misma propiedad no se ven como dos filas iguales (F9.5-T20).
- **Próximas:** lo programado para los próximos 7 días (propiedades y posts), con la fecha y hora de Chile y la red. El botón **Calendario** abre la vista de la semana o del mes.
- **Publicado hace poco:** lo que salió en los últimos 7 días (hasta 8), con **Ver en <red>** para abrirlo en la red y «simulación» si no fue de verdad. Las propiedades archivadas no aparecen aquí (como en Seguimiento sin «Mostrar archivadas»).

Mira lo mismo que **Seguimiento** (la agenda y lo publicado) y respeta el corredor de "Ver corredor". Se actualiza sola cada minuto mientras la tienes a la vista. La salud del sistema (base, almacenamiento, cola y worker), que antes era la portada, está en **Estado**, al final del menú (solo el administrador; también en `/estado`).

## Dar de alta un corredor (F7)

De punta a punta, con `pnpm dev` corriendo. Todo se puede hacer en el panel (**Corredores**) o en la CLI.

1. **Crear el corredor:** en **Corredores → Crear un corredor** (o `pnpm -s cli brokers create --slug <slug> --name <nombre> --brand <marca> --color <#RRGGBB>`). Basta con el **nombre** y el **nombre de la marca**: el identificador se arma solo desde la marca (minúsculas, sin tildes, con guiones; lo puedes cambiar en su campo chico, pero después ya no cambia). Lo demás está en **Opciones avanzadas**, plegado: los colores (vacíos, quedan el azul tinta `#233B78` y el cobre `#C96F24`), WhatsApp, correo, Instagram, sitio, tono, hashtags, si es **propio**, el **tope de IA del mes** en dólares y si es **una marca** (solo publica posts; no se cambia después). Si no es tuyo, déjalo **no propio**: su IA usa la API de Anthropic (con tu clave) y su Marketplace va a mano.
   - **Desde una planilla:** si el corredor te mandó la planilla de Excel con la hoja Corredor llena, súbela en **Llenar desde una planilla** (hasta 3 MB: la planilla de AgentSales pesa unos 15 kB). Sus datos quedan en el formulario para revisarlos; **no se guarda nada** hasta que aprietes **Crear corredor**. Si la planilla no tiene la hoja Corredor, la tiene vacía o un valor no sirve (un color que no es `#RRGGBB`, un correo mal escrito), el panel lo dice y marca el campo. El logo que nombre la hoja se sube después, en la página del corredor. Si la hoja no trae colores, quedan los por defecto (azul tinta y cobre); se cambian cuando quieras en la página del corredor o en **Mi marca**.
2. **Invitar a su usuario:** en el detalle del corredor, **Usuarios → Invitar** (o `pnpm -s cli users invite --email <correo> --name <nombre> --broker <slug>`). El enlace queda a la vista **hasta que lo ocultes** con **Listo, ocultarlo** (o hasta que venza): si recargas la página, sigue ahí (se guarda solo en esa pestaña del navegador, nunca en la dirección ni en el disco, y como mucho 2 horas; se borra antes al ocultarlo, al vencer, cuando el invitado ya eligió su contraseña, al cerrar sesión, cuando la sesión vence y cuando entra otro usuario en esa pestaña). En la CLI queda en el portapapeles. Tres botones: **Copiar** el enlace, **Copiar mensaje completo** (el saludo, el enlace y que vence en 72 h, listo para pegar en WhatsApp o donde quieras) y **Enviar por correo**, que abre tu programa de correo con ese mismo mensaje (asunto «Tu acceso a AgentSales»); revísalo y envíalo tú. El enlace va solo en el mensaje, nunca en la dirección de la página. El enlace sirve una sola vez; si lo mandas por correo, no lo reenvíes. Vence en 72 h; si lo perdiste o venció, **Restablecer** da otro (con el mismo botón).
   - **Una sesión por navegador.** La sesión del panel es una cookie del navegador: todas sus ventanas y pestañas comparten la misma. Si abres el enlace del corredor en tu navegador, la página avisa que tienes abierta tu sesión y solo la cierra si aprietas **Seguir y cerrar esa sesión**. Para ver como corredor y como administrador a la vez, abre el enlace (o entra como el corredor) en una **ventana privada** o en otro perfil del navegador.
3. **El corredor entra** con el enlace (la página dice «Crea tu usuario en AgentSales»), elige su contraseña y completa **Mi marca**: colores, WhatsApp (Portal lo exige), logo, y baja su planilla de Excel (ya trae su hoja Corredor llena). Ojo: si después carga una planilla vieja, puede deshacer lo que editó en Mi marca (manda lo último que se guarde).
4. **Sus cuentas** (las conectas tú, en **Cuentas**; desde F9.5-T20 cada tipo ve solo las redes que le sirven: un corredor de propiedades, Instagram, Mercado Libre y Marketplace; una marca, Instagram, X, LinkedIn, Discord y TikTok):
   - **Instagram:** como evaluador de tu app de Meta. En el servidor, con el botón **Conectar Instagram** de **Cuentas**: tú, o el propio corredor desde su usuario (ADR-0028; inicia sesión él mismo, desde donde esté, y solo puede conectar la suya). El botón lleva primero a una pantalla en español (F9.5-T20) que explica qué se autoriza (publicar y leer métricas básicas; nunca la contraseña), que la cuenta debe ser profesional (empresa o creador), que mientras Meta no apruebe la app solo funcionan las cuentas agregadas como evaluadoras y que la pantalla que sigue es de Instagram, en inglés; **Continuar a Instagram** sigue desde ahí; en tu Mac, con el token de *Generate token* (pasos en `docs/07-checklist-cuentas.md`, "Antes de F7").
   - **Mercado Libre:** en el servidor, con el botón **Conectar Mercado Libre** de **Cuentas** (la vuelta es automática); en tu Mac, con su cuenta y pegando la dirección de vuelta.
   - **Marketplace:** **Activar Marketplace a mano** (el formulario automático es solo para tus corredores). Al publicar, el sistema deja el texto, las fotos y el precio listos; el corredor lo publica en Facebook y confirma con el enlace o "No lo publiqué".
5. **La lista de alta** del corredor (en su detalle, en Mi marca y en `pnpm -s cli brokers show <slug>`) dice qué falta y quién lo hace (su Instagram lo conecta el propio corredor en **Cuentas**). Una **marca** (`--kind brand`) tiene la suya, porque solo publica posts: la marca, el **perfil editorial** (al menos un tema y un hecho), el usuario y **al menos una red de los posts** conectada (Instagram, X, LinkedIn o TikTok las conecta la marca en **Cuentas**; Discord, tú con la CLI). No pide WhatsApp, logo, Mercado Libre ni Marketplace, que son de los avisos.
6. **El gasto:** en **Corredores** y con `pnpm -s cli usage`, lo gastado en IA en el mes (estimado: la cifra oficial está en la consola de Anthropic). Con el tope alcanzado, preparar los textos se frena hasta que subas el tope o empiece el mes siguiente.

Para desactivar a alguien: **Desactivar** en su usuario (o `pnpm -s cli users disable <correo>`) cierra sus sesiones al tiro.

### Borrar un corredor de verdad (F9.5)

Para los corredores de prueba que ensucian el panel, o un cliente que se va y pide borrar sus datos. Es solo tuyo (administrador), por la CLI, y **no se puede deshacer**: saca un respaldo antes (`pnpm db:backup`; contra el servidor, `ENV_FILE=.env.production pnpm db:backup`).

1. `pnpm -s cli brokers delete <slug>` muestra lo que se borra (propiedades, fotos y videos, publicaciones, posts, usuarios, cuentas y cargas) sin borrar nada, y cuántas publicaciones están publicadas o pausadas: esas seguirán en las redes (retíralas antes si quieres bajarlas).
2. `pnpm -s cli brokers delete <slug> --confirm <slug>` lo borra: la base en un solo paso y después sus archivos en R2. Al final dice qué se borró y si quedó algo pendiente en R2 (la base queda borrada igual; lo pendiente se borra a mano por su clave).

Se niega si alguna publicación está publicándose, programada, esperando tu clic o con resultado dudoso: dice cuáles; desprográmalas o cancélalas, confirma o di «no lo publiqué» y resuelve las dudosas. Lo publicado en las redes sigue allá: borrar aquí no retira nada. El paso a paso para el servidor está en `docs/10-despliegue.md` ("Borrar un corredor de verdad").

## El contenido de tus marcas, de punta a punta (F9)

El recorrido completo de un post de marca, en orden. Cada paso tiene su sección más abajo; todo se hace en el panel o en la CLI, con `pnpm dev` corriendo (o contra el servidor).

1. **Las marcas:** `pnpm db:seed --operator-brands` crea `vinny` y `agentpey` (solo en tu instancia; `docs/07-checklist-cuentas.md`, "F9 · Contenido de marca"). Otra marca: `pnpm -s cli brokers create --kind brand …`.
2. **Sus redes:** conecta cada cuenta (Instagram, Discord, LinkedIn, X, TikTok) y haz su prueba de entrada antes de publicar de verdad ("Conectar las redes de los posts").
3. **El perfil editorial:** idiomas, público, temas de la marca, hechos, cosas que evitar y cadencia ("Llenar el perfil editorial").
4. **El plan:** la IA propone ideas con fecha; tú aceptas, editas o descartas cada una ("Pedir a la IA un plan de ideas"). O creas un post a mano ("Publicar un post de una marca").
5. **Los textos:** al aceptar una idea (`post accept <id> --wait` los espera) o con `post draft` (pide textos nuevos: gasta IA otra vez) la IA redacta un texto por red e idioma; los revisas y corriges.
6. **Aprobar:** cada texto por separado; aprobar abre una publicación por cuenta, formato e idioma.
7. **Programar o publicar:** a una hora de Chile (el reloj del worker publica a la hora) o ya.
8. **Lo que queda pendiente**, siempre con su comando en la `agenda` y en el detalle del post:
   - **"No se sabe si salió"** (`outcome_unknown`): miras la red y dices si salió o no (`publications resolve`).
   - **LinkedIn a mano:** a la hora el texto queda listo; lo publicas tú y confirmas con el enlace (`publications confirm`).
   - **TikTok:** el video llega como borrador a la bandeja de la app; pegas el texto, lo publicas allá y confirmas con el enlace.
   - **Reconectar LinkedIn** cada 60 días (la agenda avisa 7 días antes).

## Llenar el perfil editorial de tus marcas (F9)

El perfil editorial es **lo único que la IA sabe de una marca** cuando propone ideas y redacta posts. Lo que no está ahí, la IA no lo afirma. Se llena una vez y se ajusta cuando cambie algo. Con `pnpm dev` corriendo (o contra el servidor, con tu sesión de la CLI):

```bash
pnpm -s cli brand show --broker agentpey          # cómo está hoy
pnpm -s cli brand edit --broker agentpey \
  --languages es,en \
  --audience "Corredores independientes que quieren publicar sin perder la tarde" \
  --pillar "aprendizajes|Lo que aprendo construyendo|3|Errores, decisiones y lo que cambió" \
  --pillar "producto|Producto|2|Qué hace AgentSales y para quién" \
  --pillar "bastidores|Bastidores|1" \
  --fact "AgentSales publica avisos en Instagram, Portal Inmobiliario y Marketplace" \
  --fact "Lo construye una sola persona en Chile" \
  --avoid "promesas de ventas o de resultados" \
  --cadence "instagram/3/lun,mie,vie/10:00,19:00/6" \
  --cadence "linkedin/1/mar/09:00" \
  --hashtags "agentsales construirenpublico"
```

- **Idiomas:** `es`, `en` o `es,en`; el primero es el principal. Con dos, cada post sale en los dos idiomas como publicaciones separadas, espaciadas por la cadencia.
- **Público** (`--audience`): a quién le habla la marca, en una o dos frases. Ejemplo de un corredor: «Familias y profesionales que buscan arrendar o comprar departamento en Providencia, Ñuñoa y Las Condes, y propietarios que quieren arrendar su propiedad».
- **Temas de la marca** (antes «Líneas de contenido»; `--pillar "clave|nombre|peso|descripción"`): de qué publica tu marca y cuánto de cada tema. El peso reparte las ideas del plan; en el panel se elige como **Poco** (1), **Normal** (2) o **Mucho** (3), así un tema con «Mucho» recibe el triple de ideas que uno con «Poco». La clave va en minúsculas, sin espacios (la usan los posts); en el panel se arma sola desde el nombre si la dejas vacía. Ejemplos: «Propiedades disponibles» (mucho), «Consejos para arrendar o comprar» (normal), «El barrio: comercio, metro y parques» (poco), «Casos y cómo trabajo» (poco).
- **Hechos que la IA puede afirmar** (`--fact`, uno por frase): **lo más importante**. La IA solo afirma lo que esté aquí: escribe solo cosas verdaderas y comprobables (cifras, fechas, comunas, cómo trabajas). Sin hechos, la IA escribe sobre ideas y criterios, pero no inventa números ni nombres. Revísalos: lo que pongas aquí puede salir publicado. Ejemplos ya completados: «Corredor de propiedades en Santiago desde 2018», «Trabajo en Providencia, Ñuñoa y Las Condes», «Arriendos con contrato notarial y revisión de antecedentes». En el panel, los ejemplos llegan como frases a completar («Corredor de propiedades en [comuna] desde [año]», «Trabajo en [comunas]», «Arriendos con [cómo trabajas]») y el perfil no se guarda mientras quede algo entre corchetes.
- **Cosas que evitar** (`--avoid`): temas, palabras o promesas que no quieres ver. Ejemplos: «Prometer plusvalía o rentabilidad», «Hablar mal de otros corredores», «Requisitos sobre niños, nacionalidad o estado civil», «Dar la dirección exacta».
- **Cadencia** (`--cadence "red/posts por semana/días/horas/horas entre idiomas"`): por red (instagram, x, linkedin, discord, tiktok); los días como `lun,mar,mie,jue,vie,sab,dom` y las horas en **hora de Chile**. Las horas entre idiomas (solo con dos idiomas) son las que separan el post en un idioma del mismo post en el otro, en la misma red; son 6 si no las pones. `--remove-cadence <red>` quita una red. En el panel no se escribe este formato: marcas la red, escribes los posts por semana, aprietas los días (**L M M J V S D**) y agregas cada hora con el campo de hora y **Agregar** (se quita con su **×**).
- Cada opción **reemplaza** su campo y lo demás queda como estaba; `--add-fact` y `--add-avoid` suman a la lista. `--audience ""` lo borra.
- **Con un archivo:** `pnpm -s cli brand show --broker agentpey --json > perfil.json`, lo editas y `pnpm -s cli brand edit --broker agentpey --file perfil.json`. Los campos que el archivo no trae quedan como estaban.
- Si algo no sirve, la CLI dice qué campo y por qué (`EDITORIAL_PROFILE_INVALID`) y no guarda nada.
- El tono sigue siendo el de la marca (`brokers edit --tone`) y los hashtags del perfil se suman a los fijos de la marca.
- Un corredor edita solo el perfil de su marca; tú, el de cualquiera.

## Publicar un post de una marca (F9)

Un post es una publicación de la marca que no es un aviso: una idea, un aprendizaje, una novedad. Tiene **un texto por red y por idioma** (si la marca publica en dos idiomas, cada uno sale como una publicación aparte). Todo funciona en `dry-run` igual que en vivo, salvo que en `dry-run` nada sale a las redes. Con `pnpm dev` corriendo (o contra el servidor):

```bash
# 1. Crear: el tema y tu brief (lo que la IA puede usar y afirmar, además del perfil de la marca)
pnpm -s cli post create "Lo que aprendí esta semana" --broker agentpey \
  --brief "Tres cosas: …" --kind image --pillar aprendizajes --date "2026-10-23 10:00"

# 2. Subir medios (si el post lleva foto o video): van directo a R2, con avance
pnpm -s cli post upload <id_post> foto.jpg clip.mp4

# 3. Pedir los textos a la IA y esperar
pnpm -s cli post draft <id_post>

# 4. Revisar, corregir y aprobar
pnpm -s cli post show <id_post>
pbpaste | pnpm -s cli post edit <id_post> --platform linkedin --language es
pnpm -s cli post edit <id_post> --x-link                  # solo si el texto de X lleva un enlace (US$0,20; --no-x-link lo quita)
pnpm -s cli post approve <id_post>                       # todas las redes, o --platform x

# 5. Programar (hora de Chile) o publicar ya
pnpm -s cli post schedule <id_post> --at "2026-10-23 10:00"   # --platform para algunas redes
pnpm -s cli post publish <id_post>                            # --platform para una sola
```

- **`post list`** muestra tus posts (`--broker`, `--status idea|draft|ready|archived`, `--from` y `--to` como `AAAA-MM-DD`). **`post show`** dice todo: estado, medios y sus variantes ("procesando…" mientras el worker las arma), cada texto por red e idioma con su revisión, y cada publicación con el comando que le toca.
- **Un enlace en X** necesita dos cosas tuyas: que esté en tu brief y que lo permitas en el post (`post edit <id> --x-link`, o la casilla «Permitir un enlace en X» en el panel), porque ese post cuesta US$0,20 en vez de US$0,015. Sin el permiso, la revisión no deja aprobar el texto de X con un enlace.
- **El brief tuyo cuenta como fuente de hechos; el de la IA no.** La revisión marca cifras, nombres o enlaces que no están en el perfil ni en tu brief: corrígelos o súmalos al perfil antes de aprobar.
- **Los medios** se suben una vez: si repites `post upload` con el mismo archivo, no se vuelve a subir. Si se corta, vuelve a correr el comando: retoma lo que falta.
- **Un post sin imágenes todavía** (un carrusel, una imagen o un video aún sin archivos) igual redacta su texto y se puede aprobar: la revisión dice «Falta la imagen» (o «Faltan las imágenes del carrusel», o «Falta el video») como advertencia, no como error. Lo que no puedes es **publicarlo ni programarlo** hasta tener los medios: `post publish` y `post schedule` dicen que faltan (`CONTENT_NOT_READY`) y el reloj nunca intenta publicarlo. Súbelos con `post upload <id> <archivos…>`.
- **Aprobar** abre una publicación por cada red con la cuenta conectada; sin cuenta, el texto queda aprobado y la publicación nace cuando la conectes. Si ninguna red aprobada tiene cuenta, `post approve` te dice que la conectes primero (`pnpm -s cli accounts`) en vez de ofrecerte publicar; después `post publish` o `post schedule` abren sus publicaciones. `post approve --undo` quita la aprobación y descarta lo que no salió.
- **En vivo** (el servidor en `PUBLISH_MODE=live` **y** la marca encendida, `brokers live <slug> on`), `post publish`, `post schedule` y `publications retry` preguntan antes (`--yes` no pregunta). A la hora programada el reloj del worker publica sin volver a preguntar.
- **Una red a mano** (por ejemplo LinkedIn): a la hora queda lista para que la publiques tú; después `pbpaste | pnpm -s cli publications confirm <id> --url-stdin` con el enlace, o `publications not-published <id>` si no la publicaste.
- **"No se sabe si salió"** (`outcome_unknown`): el envío se cortó y AgentSales no sabe si la red la publicó. **Mira la red** y dilo: `pnpm -s cli publications resolve <id> --published` (con el enlace, si lo tienes: `pbpaste | … --published --url-stdin`) o `--not-published` (queda fallida). AgentSales nunca la reintenta solo, para no publicarla dos veces.
- **Reintentar o publicar ya una sola publicación:** `pnpm -s cli publications retry <id>` (el id sale en `post show` y en la agenda). Descartarla: `publications cancel <id>`. Retirar una publicada: `publications retire <id>` (en LinkedIn o X por la API, `--delete` la borra por ti; ver "Conectar las redes de los posts").
- **Antes de conectar las cuentas** de la marca, mira "Conectar las redes de los posts (F9)", más abajo: qué va en el `.env`, cómo se conecta cada red y las pruebas S1 a S6 antes de publicar de verdad.
- **`agenda`** muestra los posts junto a las propiedades, con el comando de cada cosa pendiente. **`post archive <id>`** da por terminado un post (primero hay que resolver o descartar sus publicaciones pendientes).
- Si algo falla, la CLI muestra el código y qué hacer: `POST_NO_PLATFORMS` (la marca no tiene cuentas ni cadencia: conecta una o define la cadencia en `brand edit`), `LLM_BUDGET_EXCEEDED` (la marca llegó a su tope de IA del mes: `pnpm -s cli usage`), `LLM_OUTPUT_INVALID` (la IA no respondió en el formato pedido: vuelve a pedir los textos), `CONTENT_EDITED` (ya editaste o aprobaste: `post draft --replace-edits` los reemplaza), `POST_NOT_READY` (una idea sin aceptar o un post archivado), `OUTCOME_UNKNOWN_PENDING` (primero di si salió).

### Lo mismo desde el panel (F9-T17)

Todo lo anterior se puede hacer en el panel, en **Contenido** (el menú de la izquierda; el administrador elige la marca en "Ver corredor"):

- **La lista** muestra los posts de la marca por estado (los archivados, con su filtro). Abajo, **Nuevo post**: tema, brief, tipo y fecha planeada (hora de Chile). Con "Todos" eliges la marca.
- **El detalle de un post** tiene, en orden: **Pedir los textos a la IA** (con "Reemplazar también los textos editados o aprobados" si ya los tocaste); **una pestaña por red e idioma** (con una «!» roja solo si la revisión encontró un error de verdad, y un «pendiente» amarillo si solo faltan las imágenes; el motivo se ve al pasar el cursor y debajo de las pestañas) con el texto, el conteo de esa red (en X cuenta como X: un enlace vale 23 y un emoji 2, y avisa que un enlace encarece el post; un enlace en X se permite con la casilla «Permitir un enlace en X» del post, que cuesta US$0,20 en vez de US$0,015), la vista previa, la revisión con lo que hay que corregir, **Editar** y **Aprobar** (o quitar la aprobación); **Fotos y videos** para subir con avance (puedes cancelar, y si falla, **Reintentar**; cada medio dice "procesando…" hasta que el worker arma sus versiones); **Publicar en …** una red a la vez (desactivado, con «Falta la imagen… Subir imágenes», mientras el post no tenga sus medios) y **Programar…** las redes que elijas a una hora de Chile (una red sin cuenta conectada aparece desactivada, con el aviso y el enlace a **Cuentas**; si ninguna tiene, tampoco se puede programar); y la lista de **Publicaciones**.
- **"No se sabe si salió"**: la publicación lo dice en ámbar. Mira la red y aprieta **Sí, salió** (pega el enlace si lo tienes) o **No salió** (queda fallida y puedes **Reintentar**).
- **Una red a mano** (LinkedIn): la publicación te pide publicarla tú; después pega el enlace y aprieta **Lo publiqué**, o **No lo publiqué**.
- **En vivo**, publicar y reintentar piden un segundo clic ("Sí, publicar en vivo"), y programar lo avisa en rojo.
- **Videos de más de 100 MB:** el navegador los sube sin calcular su huella (sha256); el servidor la calcula después y el video aparece en unos minutos. Si ya estaba en el post, no se duplica.
- **Calendario** (F9-T18, en el menú): la semana o el mes con lo programado y lo ya publicado, posts y propiedades juntos, en hora de Chile. Desde ahí cambias la hora de una publicación programada (la misma confirmación en vivo de siempre); lo aprobado sin programar, lo que se está publicando y lo fallido siguen en **Seguimiento**.
- **El perfil editorial** se edita en **Mi marca** (o, siendo administrador, en la página de cada corredor), con los mismos campos que `brand edit` (ver "Llenar el perfil editorial de tus marcas"). Cada campo explica qué va y trae **ejemplos de un corredor que se insertan con un clic** (después los cambias por los tuyos); los temas se pesan con **Poco / Normal / Mucho** (un peso distinto puesto con la CLI aparece como «Como está (peso N, de la CLI)», no se toca y un aviso dice que el reparto ya no es el que dicen los nombres), y la cadencia se arma con botones de días y chips de horas (hasta 8 horas por red; sin días ni horas, el plan usa de lunes a viernes a las 10:00). La clave de un tema nuevo se arma sola al guardar y queda fija: renombrar el tema después no la cambia. Si algo no sirve, el error aparece en rojo junto al campo y no se guarda nada.

### La vista previa por red (F9.5-T07)

Cada texto, el de un post (en su pestaña de red e idioma) y el de una propiedad (en **Contenido**: Instagram, Portal y Marketplace), trae una **vista previa con la forma de la red**: la foto o el video, el nombre de la cuenta y el texto **tal como se envía y cortado donde la red lo corta**. No lleva logos ni marcas de las redes: es una aproximación para revisar, no una captura.

- **Instagram:** la imagen, el carrusel (deslízalo; arriba dice en cuál vas, `1/4`, y abajo los puntos) o el reel vertical (en una propiedad sin video, el armado con sus fotos, con la nota «Reel armado con tus fotos»); el nombre de la cuenta conectada (`@usuario`) y el caption con los hashtags, cortado como Instagram (unos 125 caracteres o dos líneas) con «… más».
- **X:** el texto entero con los hashtags (X no lo corta: el contador dice si pasa de 280) y hasta 4 imágenes en grilla, o el video.
- **LinkedIn:** el texto cortado como LinkedIn (unos 210 caracteres o tres líneas) con «…ver más», y la imagen o las imágenes. Los caracteres que LinkedIn exige escapar se ven normales, como los lee la gente.
- **Discord:** el mensaje del webhook (su nombre, con la etiqueta APP), el texto **sin hashtags** (en Discord no se envían) y los adjuntos. `@everyone` y `@here` se ven como los escribiste, pero al enviar se neutralizan (no avisan a todo el canal), y la revisión no deja aprobar un texto que los tenga.
- **TikTok:** el video vertical. **TikTok no recibe el texto:** el video llega como borrador a la bandeja de la app y ahí pegas el texto que aparece debajo, «Texto para pegar en la app».
- **Portal Inmobiliario:** las fotos (la portada grande y las demás en miniatura), el título, el precio como en la planilla (`UF 5.800`) y la descripción entera.
- **Marketplace:** las fotos, el título (con el aviso de que el formulario de Facebook no tiene título: solo lo usa el plan B), el precio en pesos como en el plan B, con la UF usada (si está en UF y todavía no se convirtió, lo dice) y la descripción entera.

**Los medios de un post** son los que publicará la red: las fotos y el video en su orden, con la versión de esa red; uno que todavía no la tiene dice «procesando…». Si la red rechazaría el post por sus medios, la vista previa lo avisa arriba: un carrusel de Instagram con menos de 2 imágenes, o TikTok en un post que no es de video.

**Al editar**, la vista previa cambia mientras escribes, antes de guardar; cuando el borrador ya es distinto del texto guardado, lo dice arriba («con tu borrador, sin guardar»). Si cancelas, vuelve al texto guardado. Si la cuenta de la red no está conectada, aparece «tu cuenta» en vez del nombre.

## Música en los reels (F9.5-T19)

Cada propiedad y cada post con video puede llevar **música de fondo** de una biblioteca de 5 pistas libres de derechos (CC0: no hay que dar crédito). Por defecto, **sin música**.

**Una vez, antes de ofrecerla (lo haces tú):**
1. Baja las 5 pistas de sus páginas en OpenGameArt (la lista, con el enlace de cada una, está en `docs/integraciones/musica-reels.md`, sección «Las 5 pistas»), **escúchalas** y guarda la evidencia de su licencia (una captura de la página con «CC0» y la fecha).
2. Déjalas en una carpeta, cada una con el nombre de su pista en el catálogo y en MP3: `calm-piano.mp3`, `sunny-side-up.mp3`, `champ-de-tournesol.mp3`, `serenade-guitar.mp3` y `up-in-the-sky.mp3`. Dos vienen en WAV u OGG: conviértelas con `ffmpeg -i <original> -codec:a libmp3lame -b:a 192k <id>.mp3`.
3. Súbelas: `pnpm music:upload <carpeta>` (al bucket de desarrollo); para el servidor, `ENV_FILE=.env.production pnpm music:upload <carpeta>`. Dice qué subió (con su sha256) y qué rechazó (un nombre que no es del catálogo, o un archivo que no es MP3). Cada pista pasa antes por ffmpeg: si no se lee entera, no se sube. Repetirlo reemplaza las que vuelvas a subir, pero los reels ya armados no cambian hasta que elijas la pista de nuevo.
4. Antes de publicar de verdad con música en Instagram, prueba cada pista con tu cuenta (`copyright_check_status`, en la nota): si alguna da coincidencias, no la ofrezcas.

**Elegirla:**
- **Propiedad:** en **Contenido**, el selector **«Música del reel»** (con **Escuchar** si la pista ya está subida). Después toca **Rehacer imágenes** para armar el reel con ella (tus textos no cambian). CLI: `pnpm -s cli listing music <propiedad> <pista|ninguna>` y luego `pnpm -s cli prepare <propiedad> --no-texts`.
- **Post:** en su detalle, el mismo selector aparece si el post es de video y tiene un video (en un post de otro tipo, la música se rechaza); los videos (el reel, el de X y el de Discord) se rehacen solos en unos minutos. CLI: `pnpm -s cli post edit <id> --music <pista|ninguna>`.

**Cómo suena:** si el video trae sonido (alguien hablando), ese sonido va al frente y la música más baja, detrás; sin sonido (o el reel armado con fotos), la música va sola. Al final baja con un fundido. El mismo video con música va a todas las redes (Instagram, X, TikTok, Discord y LinkedIn).

**Si una pista no está subida:** se puede elegir igual, pero el reel sale **sin música** y la preparación lo avisa («todavía no está subida a la biblioteca»). Cuando la subas, prepara de nuevo y el reel sale con ella.

## Conseguir imagen para un post sin fotos (F9.5-T25)

Un post de imagen, carrusel o video sin medios no se publica, pero su texto se aprueba igual. En su detalle, en **Fotos y videos**, el botón **«Conseguir imagen»** (y el enlace del aviso «Falta la imagen») abre tres pestañas. Nada se genera solo: siempre lo pides tú, y lo conseguido entra como una foto subida (pasa por la vista previa y la aprobación).

1. **Tarjetas de la marca** (por defecto, US$0, sin claves): el tema del post sobre el color y el logo de la marca. En un **carrusel**, una portada, una tarjeta por punto del texto (sus viñetas, sus párrafos o sus oraciones) y un cierre con la marca y su `@cuenta` o su sitio. En un **post de video**, «Hacer video de las tarjetas» las une en un video 9:16 con la música del post (la que elegiste en «Música del reel»). El texto sale del post: pide los textos antes (un video de tarjetas los necesita). Elige 4:5 (Instagram) o 9:16 (reel e historia).
2. **Biblioteca (Pixabay)**: busca con el tema del post (lo puedes cambiar), «Sin personas» viene marcado, y tocas la foto que quieres. El worker la descarga y la guarda en AgentSales (Pixabay no pide crédito). Si Pixabay recibió demasiadas búsquedas, espera un minuto.
3. **Crear con IA (Nano Banana)**: una indicación propuesta desde el post (cámbiala si quieres), sin texto ni personas dentro de la imagen. Cuesta unos US$0,034 por imagen (`IMAGE_AI_PRICE_USD`), con un **tope de US$2 al mes por marca** (`IMAGE_AI_MONTHLY_CAP_USD`); al llegar, dice «Llegaste al tope de imágenes con IA de este mes». El gasto lo ves aparte del de texto en `pnpm -s cli usage` (la columna «Pedidos»). Si una imagen falla después de llamar a Google, no se reintenta sola (podría cobrar dos veces): pide otra. El modelo y el precio por defecto están sin verificar hasta tu prueba; si cambias `IMAGE_AI_MODEL`, cambia también `IMAGE_AI_PRICE_USD` (`doctor` te lo recuerda). Las imágenes no se marcan como IA (ADR-0038 §4).

**Las claves (las sacas tú, `docs/07-checklist-cuentas.md`, «F9.5 · Imágenes para posts sin fotos»):** `PIXABAY_API_KEY` y `GEMINI_API_KEY` en `.env` y, para el servidor, en `.env.production` y los secretos de Fly (`docs/10-despliegue.md`, paso 2). Sin una de ellas, su pestaña dice qué falta y las tarjetas siguen funcionando. Antes de usar la IA de verdad, haz las pruebas sin riesgo de la nota `docs/integraciones/imagenes-y-videos-generados.md` §7 (una búsqueda y una descarga en Pixabay; una imagen 4:5 y una 9:16 con Nano Banana) y cuéntale a Claude qué salió: la forma exacta del pedido a Google está sin verificar.

**Desde la CLI:**
```bash
pnpm -s cli post media <id>                                # qué fuentes hay y qué falta
pnpm -s cli post media <id> --card [--format 9:16]          # tarjetas (un post de video: su video)
pnpm -s cli post media <id> --stock "living luminoso"       # lista los resultados numerados
pnpm -s cli post media <id> --stock "living luminoso" --pick 3   # o el id de la foto de la lista
pnpm -s cli post media <id> --ai "Un living luminoso con plantas" [--format 9:16]
```
Espera hasta que el worker termina (con `pnpm dev` corriendo) y dice cuántos medios quedaron; `--no-wait` sale de inmediato. Nunca imprime una URL firmada.

## Pedir a la IA un plan de ideas (F9)

Si no sabes qué publicar, la IA te propone **ideas con fecha** para las próximas semanas, con el perfil editorial de la marca (sus temas, sus hechos y su cadencia). **Una idea no se publica sola:** tú decides cuáles aceptar; al aceptar una, la IA redacta sus textos, y después los revisas, apruebas y programas como cualquier post. Cada plan gasta IA de la marca (entra a su tope del mes), aunque descartes todo.

```bash
# 1. Pedir el plan (por defecto, 14 días desde mañana, todas las redes de la marca y las ideas que
#    pide su cadencia) y esperar: imprime las ideas por semana, cada una con su id y su comando
pnpm -s cli plan --broker agentpey --days 14 --platform linkedin,x --count 8
#    (opcional) con lo que quieres que trate: temas y tono, hasta 500 caracteres
pnpm -s cli plan --broker agentpey --guidance "Solo ideas para principiantes; evita hablar de precios"

# 2. Decidir cada idea
pnpm -s cli post accept <id_idea>      # pasa a borrador y la IA redacta sus textos (--wait los espera)
pnpm -s cli post discard <id_idea>     # no se vuelve a proponer en 60 días
pnpm -s cli post edit <id_idea> --date "2026-10-23 10:00" --platforms x,linkedin --brief "Lo que yo sé: …"

# 3. Seguir como un post: revisar, aprobar y programar
pnpm -s cli post show <id_idea>
pnpm -s cli post approve <id_idea>
pnpm -s cli post schedule <id_idea> --at "2026-10-23 10:00"
```

- **Qué quieres que trate el plan** (F9.5-T23): en el panel, el campo «¿Qué quieres que trate este plan?» de **Plan** (con ejemplos); en la CLI, `--guidance`. Guía los temas y el tono, pero **no es fuente de datos**: si escribes una fecha, una cifra o un cliente que no está en los hechos del perfil, la idea que lo afirme se descarta. Si el dato es verdad, agrégalo primero a los hechos (Mi marca o `brand edit --add-fact`).
- **Perfil vacío:** si la marca no tiene temas ni hechos, el panel y la CLI avisan «Tu perfil está vacío: las ideas saldrán genéricas». En el panel puedes ir a **Mi marca** o responder 4 preguntas (qué haces, para quién, de qué temas hablas, qué no dices): llenan el perfil para que lo revises y lo guardes; no se guarda solo. Si la marca es un equipo, dilo en un hecho («Somos un equipo de 4 corredores»): solo así las ideas hablan de «nosotros».
- **`plan show <id>`** vuelve a mostrar un plan con el estado de cada idea; **`plan list`** muestra los planes de la marca (`--broker` va antes o después de `list`: `plan list --broker agentpey` o `plan --broker agentpey list`). `--no-wait` pide el plan y sale con su id.
- **Esperar los textos de una idea:** `post accept <id> --wait` acepta y espera esa redacción, con su revisión al final. Sin `--wait` no espera (puedes aceptar varias seguidas) y los textos aparecen en `post show <id>` al terminar. **No uses `post draft` para esperar:** pide textos nuevos y vuelve a gastar IA; sirve solo si la idea quedó aceptada sin textos (por ejemplo, con el worker apagado).
- **Un plan a la vez por marca:** si ya hay uno en curso, pedir otro te muestra ese.
- **Lo que mira la IA:** no repite los temas de los últimos 60 días ni las ideas que descartaste, respeta la cadencia de cada red (días, horas y posts por semana, contando lo que ya está planificado esas semanas) y no inventa cifras ni nombres que no estén en el perfil. Las ideas que no pasan esas revisiones salen al final como "descartadas por las revisiones", con el motivo.
- **Antes de aceptar** puedes mover la fecha, cambiar las redes o escribir tu brief. **El brief tuyo cuenta como fuente de hechos**: si sabes algo concreto del tema, escríbelo antes de aceptar para que la IA lo use.
- **Las redes de cada idea** son las que la IA sugirió; al aceptarla, la IA redacta solo para esas. Si después le cambias las redes a un post, sus textos de las redes quitadas no se borran, pero ya no se aprueban, publican ni programan: aprobar, `post publish --platform` o publicar una publicación suya da `POST_PLATFORM_EXCLUDED`; `post schedule --platform` la informa como no programada, y sin `--platform` simplemente no se usa. Una red con publicaciones pendientes (aprobadas, programadas o fallidas, incluida la que el reloj dejó fallida con `POST_PLATFORM_EXCLUDED`) no se puede quitar (`POST_HAS_PENDING_PUBLICATIONS`): primero cancélalas con `publications cancel <id>`. `post show` y el panel avisan qué texto falta de una red agregada (pídelo con `post draft`; Instagram en un post de solo texto no cuenta, porque no sirve a ese tipo).
- **Si el plan falla**, la CLI y el panel dicen el motivo y qué hacer: `LLM_BUDGET_EXCEEDED` (la marca llegó a su tope de IA del mes: `pnpm -s cli usage`), `LLM_OUTPUT_INVALID` (la IA no respondió en el formato pedido: pide el plan de nuevo), `LLM_AUTH_REQUIRED` (renueva la sesión de la CLI de Claude), `PLAN_RUN_ABANDONED` (el worker se cortó: pide el plan de nuevo), o un error pasajero (vuelve a pedirlo en unos minutos).

### Lo mismo desde el panel (F9-T21)

En **Plan** (el menú de la izquierda; el administrador elige la marca en "Ver corredor"):

- **Pedir un plan:** los días (14 por defecto), las redes (sin marcar ninguna, todas las de la marca) y cuántas ideas (vacío: según la cadencia). Mientras la IA propone, la página lo dice y se actualiza sola.
- **Las ideas por semana**, cada una con su fecha y hora (Chile), su línea, sus redes, su tipo y el porqué. Por idea: **Aceptar**, **Editar** (brief, fecha y redes) y **Descartar** (pide confirmación). Una aceptada lleva al post, donde revisas, apruebas y programas.
- **Redactar lo aceptado:** si una idea quedó aceptada sin textos (por ejemplo, el worker no estaba al aceptarla), el botón pide sus textos.
- **Si el plan falla**, el motivo aparece en rojo con qué hacer.
- **Aprobar la semana** (F9.5-T27): cada semana con ideas aceptadas tiene el botón **Aprobar la semana…**; abajo, en «Publicar a diario desde AgentPey».

## Publicar a diario desde AgentPey (F9.5-T27)

La rutina para que una marca (AgentPey o vinny) publique todos los días en sus redes con unos 15 minutos a la semana y 2 al día. **Nada sale de verdad sin tus llaves:** el servidor en vivo, la marca encendida (`brokers live`, ADR-0036) y la prueba de entrada de cada red. Claude no las cambia ni las hace.

### Antes de empezar, una vez: la lista «Lista para publicar a diario»

En **Cuentas**, debajo del nombre de cada marca, la lista dice qué falta para publicar a diario y cómo resolverlo; en la terminal, `pnpm -s cli brand ready --broker agentpey` (`--json` para leerla de un script). Cada ítem es **✓ listo**, **✗ falta** (con su paso: un comando para copiar o un botón), **? lo marca el operador** (el sistema no lo sabe o lo haces tú a mano) o **· para saber**:

- **La marca:** el **modo** (simulación o en vivo, y por qué: el servidor en `dry-run`, la marca apagada o una marca que no es tuya), el **worker con horario** (si se enciende solo cada hora, ADR-0037; sin horario, lo programado sale solo con el worker encendido) y el **tope de IA del mes** (lo que gastan el plan y los textos). El tope de las imágenes con IA se suma cuando entre «Conseguir imagen» (F9.5-T25).
- **Por red:** la **cuenta conectada** (o vencida, con su comando para conectar) y la **prueba de entrada**: dice «hecha» solo con lo anotado en la nota de la red (`docs/integraciones/`; hoy S1, S4, S5 y S6 del 2026-10-21) y, si falta, «la marca el operador» con el paso. LinkedIn **a mano** no la necesita (S2 y S3 son para publicar por la API). Además, en **X** el tope de gasto del mes (con `accounts spend-limit <id> <dólares>` para cambiarlo; los créditos los cargas en console.x.com), que **una imagen o un video en X todavía no se probó de verdad** (S4 publicó un texto sin enlace: mira en X la primera publicación en vivo con imagen o video) y que un post con enlace necesita «Permitir un enlace en X»; en **LinkedIn**, que va a mano; en **TikTok**, que el video llega como borrador; en **Discord**, el tope de 20 MiB del video.

### Cada semana (unos 15 minutos)

1. **Pide el plan con guía** en **Plan** («¿Qué quieres que trate este plan?») o `pnpm -s cli plan --broker agentpey --days 7 --guidance "…"`. Las fechas las pone la cadencia (ADR-0034).
2. **Acepta** las ideas que te gusten (la IA redacta sus textos) y **descarta** las otras.
3. **Consigue las imágenes y videos** de los posts que los piden: súbelos en el post (`pnpm -s cli post upload <id> <archivos…>`) o con «Conseguir imagen» cuando esté (F9.5-T25). El texto se aprueba sin ellos, pero no se programa.
4. **Revisa los textos** y su vista previa en cada post; corrige lo que no te guste.
5. **Aprueba la semana:** en **Plan**, en la semana, **Aprobar la semana…** muestra cada post con sus textos por red (aprobado, por aprobar, con errores o sin la imagen) y **Aprobar y programar la semana** aprueba los textos sin errores y programa cada post **a su fecha**. En la terminal:

   ```bash
   pnpm -s cli post approve-week --broker agentpey                    # la semana de mañana
   pnpm -s cli post approve-week --broker agentpey --start 2026-11-02 # otra semana (cualquier día de ella)
   ```

   **Nunca publica en el momento:** solo programa, y lo que ya pasó (o es en menos de 2 minutos) queda sin programar con «La fecha no sirve». Con la marca en vivo pregunta antes, como programar (`--yes` en la CLI). Lo que no pudo sale post por post con su motivo y qué hacer: errores del texto, falta la imagen o el video, sin cuenta conectada, o sin textos todavía. Repetirlo es seguro: lo ya programado sigue igual. Las ideas sin decidir de la semana no entran.

### Cada día (unos 2 minutos)

- **Revisa Hoy** (la portada): lo que salió con su enlace, lo que falló con qué hacer, y lo que espera tu mano.
- **LinkedIn a mano:** a la hora, la publicación queda «esperando confirmación». En el post, **Copiar texto y abrir LinkedIn** copia el texto aprobado y abre linkedin.com en otra pestaña (un enlace normal: AgentSales no toca LinkedIn). Crea la publicación, pega el texto (con las imágenes del post), publica, copia el enlace y confírmalo con **Lo publiqué** (o `pbpaste | pnpm -s cli publications confirm <id> --url-stdin`).
- **TikTok:** el video llega como **borrador** a la app del teléfono; lo publicas desde ahí, con el texto de AgentSales, y lo confirmas con su enlace. **Publicar directo espera la auditoría de TikTok** (la revisión de Production con el video demo, que no se pidió todavía).
- **Discord, X e Instagram** salen solos a su hora con el worker encendido (o por horario).

## Conectar las redes de los posts (F9)

Cada marca (o corredor) publica sus posts en las cuentas que **tú** conectes. Se conectan en **Cuentas** del panel o con la CLI, con `pnpm dev` corriendo (o contra el servidor). `pnpm -s cli accounts` muestra las conectadas y, debajo, **las redes que faltan con el comando de cada una**.

> **Antes de publicar de verdad en una red, haz su prueba de entrada** (spec F9 §4.8): **S1** Instagram, **S2 y S3** LinkedIn, **S4** X, **S5** Discord y **S6** TikTok. Son obligatorias, a mano y con tus cuentas. El código se construyó contra simulaciones: hasta que hagas la prueba de una red y anotes el resultado en su nota de `docs/integraciones/`, esa red se usa solo en `dry-run`. Pasar a `live` lo decides tú, en el chat.

### Lo que va en el `.env` de la API

Cada red (salvo Discord) necesita **su app** creada en la plataforma, con su par de claves en el `.env`. Después de anotarlas, reinicia la API (`pnpm dev`, o en el servidor, sus secretos: `docs/10-despliegue.md`). Sin el par, conectar dice qué variable falta (`LINKEDIN_NOT_CONFIGURED`, `X_NOT_CONFIGURED`, `TIKTOK_NOT_CONFIGURED`) y no abre nada.

| Red | Variables | Dónde se crea la app | La dirección de retorno, si no la pones |
|---|---|---|---|
| Instagram | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_REDIRECT_URI` | developers.facebook.com (la de los avisos: `docs/07-checklist-cuentas.md`) | `<PUBLIC_URL>/api/oauth/instagram/callback` |
| LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI` | linkedin.com/developers, asociada a una **Página de empresa** que la verifica, con *Share on LinkedIn* y *Sign In with LinkedIn using OpenID Connect* | `<PUBLIC_URL>/api/oauth/linkedin/callback` (en el Mac, `http://localhost:8787/…`) |
| X | `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI` | console.x.com, una "Web App" con OAuth 2.0 de lectura y escritura, con créditos y tope de gasto en Billing | `<PUBLIC_URL>/api/oauth/x/callback` (en el Mac, `http://127.0.0.1:8787/…`: X no acepta `localhost`) |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI` | developers.tiktok.com, con Login Kit y Content Posting API (`video.upload`); por ahora en un **Sandbox**, con el dominio verificado | `<PUBLIC_URL>/api/oauth/tiktok/callback` (TikTok exige `https`: solo en el servidor) |
| Discord | ninguna | — (un webhook por canal) | — |

La dirección de retorno se registra **igual** en la app de cada red. **Deja las tres `*_REDIRECT_URI` vacías** (`LINKEDIN_REDIRECT_URI=`): una variable vacía cuenta como no puesta, y AgentSales usa la de la última columna. Escríbela solo si registraste otra dirección. Nunca pegues una clave en el chat.

### Lo que pide cada consola

Ya hecho el 2026-10-20 y 21 para las tres (detalle en `docs/07-checklist-cuentas.md`, "F9 · Contenido de marca"). Sirve también para una instancia nueva.

- **LinkedIn exige una Página de empresa:** sin Página, no deja crear la app. Se creó la Página "AgentSales" (Desarrollo de software, 0-1 empleados, tipo Autónomo, con logo) y la app "AgentSales" asociada a ella, con la privacidad `https://agentsales.agentpey.com/legal/privacidad`. Después, **la Página verifica la app**: es un paso de la consola, y la app queda "verificada" cuando un administrador de la Página la aprueba. En Products van *Share on LinkedIn* (Default Tier) y *Sign In with LinkedIn using OpenID Connect*; en Auth, las dos direcciones de retorno (Mac y servidor). **La Página existe solo para tener la app: AgentSales publica en tu perfil personal** (spec F9, P1), y esa cuenta nace a mano.
- **X cobra por post:** la app "Web App" con OAuth 2.0 de lectura y escritura, las dos direcciones de retorno (Mac y servidor) y la web `https://agentsales.agentpey.com`. Antes de S4, **carga créditos en Billing y fija el tope de gasto de la consola** (*spending limit*). Es un pago: lo haces tú. Sin créditos, X responde `X_PAYMENT_REQUIRED`.
- **TikTok, en un Sandbox:** el borrador de **Production** no se guarda sin un video demo y el texto de la revisión. Por eso todo se configura en un **Sandbox**: Login Kit y Content Posting API con `user.info.basic` y `video.upload`, **Direct Post apagado** (solo borradores), la dirección de retorno del servidor, la web y los términos y la privacidad de `/legal/`. El par del `.env` es **el del Sandbox**. En un Sandbox solo autorizan las cuentas de **Sandbox settings → Target Users → Add account**: agrega la tuya iniciando sesión con tu TikTok. La revisión de Production (con el video demo) se pide aparte, más adelante.
- **TikTok verifica el dominio por DNS:** pide un registro **TXT** en la raíz de `agentpey.com` con su código (`tiktok-developers-site-verification=…`, lo muestra la consola). El DNS está en Vercel: se agrega ahí, sin tocar el SPF del correo, y se vuelve a TikTok a verificar.

### Cómo se conecta cada una

- **Instagram:** igual que para los avisos (más arriba, "Dar de alta un corredor"): en el servidor, el botón **Conectar Instagram**; en el Mac, `pbpaste | pnpm -s cli accounts connect instagram --broker <slug> --token-stdin` con el token de *Generate token*. Detalle de los posts en `docs/integraciones/instagram-contenido-propio.md`.
- **LinkedIn** (tu perfil personal): el botón **Conectar LinkedIn** en Cuentas, o `pnpm -s cli accounts connect linkedin --broker <slug>`, que abre el enlace en el navegador donde tienes el panel abierto. En el Mac, abre el panel en `http://localhost:5173`: la vuelta de LinkedIn es `localhost` (al revés que X; el panel avisa si estás en otro). Autoriza en LinkedIn y vuelves a Cuentas. **La cuenta queda a mano** (ver "El modo a mano", abajo). El acceso dura 60 días y **no se renueva solo**: la agenda avisa una semana antes y se reconecta igual. Nota: `docs/integraciones/linkedin.md`.
- **X:** el botón **Conectar X**, o `pnpm -s cli accounts connect x --broker <slug>`. En el Mac, abre el panel en `http://127.0.0.1:5173` (no `localhost`) antes de conectar: el panel lo avisa si estás en otro. **Cada post cuesta créditos de X** (unos US$0,015; con un enlace, US$0,20, y el enlace hay que permitirlo en el post: con `pnpm -s cli post edit <id> --x-link` o la casilla «Permitir un enlace en X» del post). Cada cuenta tiene un **tope de gasto del mes** (por defecto US$10): `pnpm -s cli accounts spend-limit <id> <dólares>`. Pasado el tope, la publicación falla sin llamar a X (`X_SPEND_LIMIT_REACHED`). El tope duro sigue siendo el de la consola de X. Nota: `docs/integraciones/x.md`.
- **Discord:** se conecta el **webhook de un canal**. En Discord: Ajustes del servidor → Integraciones → Webhooks → Nuevo webhook (elige el canal) → **Copiar URL del webhook**. Después, en la terminal: `pbpaste | pnpm -s cli accounts connect discord --broker <slug> --webhook-stdin`. La URL es **el secreto del canal**: va del portapapeles a la API, nunca se escribe en la terminal ni se pega en el panel (por eso el panel solo muestra el comando para copiar). Un canal por marca: conectar otro webhook desconecta el anterior. Nota: `docs/integraciones/discord.md`.
- **TikTok:** **solo desde el servidor** (TikTok exige `https`; en el Mac no conecta), con el par en sus secretos (`docs/10-despliegue.md`) y tu cuenta agregada como Target User del Sandbox. El botón **Conectar TikTok**, o `pnpm -s cli accounts connect tiktok --broker <slug>` con la sesión de la CLI en el servidor; autoriza y deja marcado el permiso de subir videos. Solo publica **video**, y llega como **borrador** a la bandeja de la app de TikTok: tú lo abres, pegas el texto que está en AgentSales, lo publicas y confirmas con el enlace (`pbpaste | pnpm -s cli publications confirm <id> --url-stdin`). Nota: `docs/integraciones/tiktok.md`.

Un corredor puede conectar **su propio** Instagram, LinkedIn, X y TikTok desde su usuario (solo los suyos); Discord, renovar, desconectar, el modo y el tope de gasto son tuyos (administrador).

### El modo a mano (`accounts mode`)

Una cuenta de LinkedIn, X, Discord o TikTok puede estar **a mano** o **por la API**:

- **A mano:** a la hora programada, AgentSales deja el texto y los medios listos **sin llamar a la red**; tú publicas y confirmas con el enlace (`pbpaste | pnpm -s cli publications confirm <id> --url-stdin`), o `publications not-published <id>` si no lo hiciste. LinkedIn **nace a mano** y se queda así hasta que S2 y S3 estén resueltas.
- **Por la API:** AgentSales publica solo (en `live`).
- Se cambia con `pnpm -s cli accounts mode <id> manual|api` (pasar a `api` pregunta antes; `--yes`). El id sale en `pnpm -s cli accounts`. La tarjeta de la cuenta en Cuentas dice en qué modo está.

### Confirmar, resolver y retirar

- **Confirmar una publicación a mano** (LinkedIn a mano, TikTok, Marketplace): `pbpaste | pnpm -s cli publications confirm <id> --url-stdin` con el enlace copiado (no se imprime), o en el panel, **Lo publiqué**.
- **"No se sabe si salió"** (`outcome_unknown`): el envío se cortó y la red pudo haberlo publicado. Mira la red y di qué pasó: `pnpm -s cli publications resolve <id> --published` (con el enlace: `pbpaste | … --published --url-stdin`) o `--not-published`. AgentSales nunca la reintenta solo, para no publicarla dos veces. En X, un "texto repetido" también queda así: si no salió, cambia un poco el texto antes de reintentar. En el panel, el detalle del post (y, para una propiedad en Instagram o Portal, su sección Contenido, F9.5-T04b) muestra **Sí, salió** con el campo del enlace y **No salió**.
- **Retirar un post publicado:** bórralo a mano en la red y márcalo con `pnpm -s cli publications retire <id>` (pregunta si ya lo borraste). **En LinkedIn o X con la cuenta por la API**, AgentSales lo puede borrar por ti: `pnpm -s cli publications retire <id> --delete` (pregunta antes: es definitivo; solo en `live`). Si el post de LinkedIn se publicó a mano y pegaste el enlace de "Copiar enlace", LinkedIn no acepta borrarlo por la API: la CLI te dice que lo borres a mano. En X, borrar puede tener un costo que todavía no está verificado (no se anota). **TikTok no deja borrar por la API:** borra el video a mano en la app de TikTok y después corre `publications retire <id>` sin `--delete` (con `--delete`, la CLI te lo recuerda).

### Qué hacer cuando una red falla

Debajo de cada publicación fallida, el panel (**Qué hacer:**), `post show`, `publications`, `publish` y la `agenda` muestran **el consejo de su error**. Los más comunes:

| Lo que ves | Qué hacer |
|---|---|
| `LINKEDIN_NOT_CONFIGURED`, `X_NOT_CONFIGURED`, `TIKTOK_NOT_CONFIGURED` | Anota el par de la app en `.env` (tabla de arriba) y reinicia la API |
| `*_AUTH_INVALID`, `TOKEN_REFRESH_REJECTED`, cuenta "vencida" | Reconecta la cuenta (el mismo botón o `accounts connect`) y reintenta |
| `*_PERMISSION_DENIED`, `X_PERMISSION_MISSING` | Reconecta y acepta **todos** los permisos que pide la red |
| `DISCORD_WEBHOOK_NOT_FOUND`, `DISCORD_WEBHOOK_INVALID` | El webhook se borró o cambió: crea otro en el canal y conéctalo de nuevo |
| `X_PAYMENT_REQUIRED` | Sin créditos en X: recarga en console.x.com (Billing) |
| `X_SPEND_LIMIT_REACHED` | Llegaste al tope del mes: súbelo con `accounts spend-limit` o espera al mes siguiente |
| `X_LINK_NOT_ALLOWED` | Permite el enlace en el post (`pnpm -s cli post edit <id> --x-link` o la casilla «Permitir un enlace en X»; cuesta US$0,20) o quita el enlace del texto de X; después apruébalo y reintenta |
| `TIKTOK_PENDING_LIMIT` | Hay 5 borradores esperando en la app de TikTok: publícalos o descártalos |
| `TIKTOK_APP_RESTRICTED` | La app de TikTok todavía no tiene la auditoría: revisa S6 en `tiktok.md` |
| `*_RATE_LIMITED`, `*_UNAVAILABLE`, `*_UNREACHABLE` | Es pasajero: el sistema reintenta solo; si no, reintenta más tarde |
| `RETIRE_DELETE_UNSUPPORTED` | Esa red o esa cuenta no borra por la API: bórrala a mano y `publications retire <id>` |
| `TIKTOK_DELETE_UNSUPPORTED` | TikTok no deja borrar por la API: bórralo a mano en la app de TikTok y `publications retire <id>` (sin `--delete`) |

## Restaurar un respaldo de la base

> Esto es para un respaldo de tu Mac. Para uno del servidor (el de R2), sigue `docs/10-despliegue.md`, "Paso 10 · Restaurar un respaldo".

Restaurar **nunca** se hace sobre la base que usa AgentSales: se restaura en una base nueva y, si todo está bien, se cambia `DATABASE_URL` hacia ella.

1. Elige el archivo en `~/.agentsales/backups` (el nombre trae la fecha y la hora de Chile). `pg_restore --list <archivo>` muestra lo que tiene sin tocar nada.
2. Crea una base nueva vacía: en Neon, un proyecto nuevo (o una rama) con una base del mismo nombre; o en tu Mac, `createdb agentsales_restaurada` si tienes Postgres local.
3. Restaura con los datos de la conexión **directa** de la base nueva (el host sin `-pooler`, el usuario y el nombre de la base, que muestra Neon en Connect). Sin la contraseña en el comando: `pg_restore` te la pide (así no queda en el historial de la terminal ni a la vista de otros procesos):
   ```bash
   PGSSLMODE=require /opt/homebrew/opt/libpq/bin/pg_restore --no-owner --no-acl -h <host> -U <usuario> -d <base> -W agentsales-AAAAMMDD-HHMM.dump
   ```
   (Nunca pegues la contraseña ni la cadena de conexión en el chat.)
4. Apunta `DATABASE_URL` en `.env` a la base nueva y arranca `pnpm dev`. El worker crea de nuevo la cola de trabajos (el respaldo no la trae, a propósito: así no vuelven a correr trabajos viejos) y retoma lo pendiente desde la base.
5. **Usa la misma `APP_ENCRYPTION_KEY`** que cuando se hizo el respaldo: los tokens de Instagram y Mercado Libre van cifrados con ella. Con otra clave, la base funciona pero hay que reconectar las cuentas.
6. Las fotos, los videos y las portadas no están en el respaldo: viven en R2, que no se toca.

Para errores de las últimas 6 horas, Neon tiene además su propia restauración instantánea (en su consola), más rápida que un respaldo; ver `docs/integraciones/neon-backup.md`.

