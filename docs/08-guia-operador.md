# 08 · Guía del operador: cómo trabajar con Claude Code en este proyecto

Esta guía es para ti (Vinny), no para Claude. Explica el ciclo de trabajo, los comandos de git que vas a usar y los hábitos que mantienen el proyecto ordenado.

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
| Es la primera vez con F7, olvidaste tu contraseña o te bloqueaste | `pnpm auth:admin --email tu@correo.cl` en tu terminal (no necesita `pnpm dev`): crea tu administrador o te da un enlace nuevo, en el portapapeles. Ábrelo con `pnpm dev` corriendo y elige tu contraseña. Después, `pnpm -s cli login --email tu@correo.cl` para la CLI (Claude la usa con tu sesión) |
| Un comando dice "Inicia sesión" (`AUTH_REQUIRED`) | La sesión de la CLI venció (30 días, o 7 sin uso) o se cerró: `pnpm -s cli login --email tu@correo.cl` en tu terminal |
| `pnpm check` falla y no se arregla | Pídele diagnosticar la causa raíz antes de intentar más cambios; si persiste, `/clear` y retoma con `/tarea` |
| Una API externa no se comporta como dice el doc | Pide al subagente `integraciones` verificar y actualizar las notas; luego ajusta el spec |
| Quieres cambiar el stack o un patrón | `/adr "..."` primero, código después |
| Perdiste el hilo entre sesiones | `/estado` |
| Quieres preparar el contenido de una propiedad | Con `pnpm dev` corriendo: `pnpm -s cli prepare P001` (espera y muestra la revisión), y después `pnpm -s cli content P001` para leer los textos (`--platform portal` para uno solo). Con `LLM_PROVIDER=fake` en `.env` no gasta cuota |
| `prepare` dice `CONTENT_EDITED` | Editaste textos a mano y prepararlos de nuevo los reemplazaría: usa `--no-texts` para rehacer solo las imágenes, o `--replace-edits` si quieres textos nuevos |
| `prepare` dice "Sigue en cola" | El worker no está corriendo: levanta `pnpm dev` (la corrida espera en cola y arranca sola). `publish` dice "en cola o esperando su turno": el worker publica de a una, y un carrusel tarda más de 20 s en dar señales |
| Una corrida de contenido falla con `LLM_AUTH_REQUIRED` | La CLI de Claude perdió la sesión: abre `claude`, usa `/login` y prepara de nuevo. `pnpm -s cli doctor` muestra si tiene sesión |
| `doctor` marca ffmpeg o ffprobe en rojo, o una corrida falla con `MEDIA_TOOL_NOT_INSTALLED` | Falta ffmpeg o es anterior a 8.1 (no arma las fotos HEIC del iPhone): `brew install ffmpeg` o `brew upgrade ffmpeg`. Si está en otra ruta, ajusta `FFMPEG_PATH` y `FFPROBE_PATH` en `.env` |
| `doctor` marca Chromium en rojo, o una corrida falla con `RENDER_BROWSER_NOT_INSTALLED` | Falta el Chromium que pide la versión de Playwright del proyecto (pasa también al actualizarlo): `pnpm --filter @agentsales/media exec playwright install chromium` |
| Quieres ver cómo redacta la IA sin tocar la base | `pnpm eval:content` en tu terminal: evalúa las propiedades listas de `agentsales-pruebas` con tu CLI de Claude (descuenta del plan), muestra la revisión por canal y deja los textos en `tmp/eval/<fecha>/`. Termina con error si algún texto tiene errores. `--provider fake` prueba el comando sin gastar cuota. Ctrl+C corta la llamada en curso y no sigue con las demás |
| Quieres comprobar que la CLI de Claude responde | `pnpm llm:smoke` en tu terminal: una llamada corta con datos inventados (descuenta del plan) |
| Quieres conectar tu Instagram (o reconectarlo: cuenta vencida o `IG_AUTH_INVALID`) | En el panel de Meta, tu app → Casos de uso → API de Instagram → "Genera identificadores de acceso" → **Generar identificador** (en inglés, **Generate token**) junto a tu cuenta, y cópialo. Con la API corriendo: `pbpaste | pnpm -s cli accounts connect instagram --broker agentsales-pruebas --token-stdin`. Revisa con `pnpm -s cli accounts` o en **Cuentas** del panel |
| Quieres aprobar y publicar en simulación | En la sección Contenido de la propiedad: "Aprobar Instagram" y "Publicar en Instagram (simulación)", o `pnpm -s cli approve P001` y `pnpm -s cli publish P001`. No llama a Instagram: la bitácora muestra lo que se habría enviado. Retíralas al terminar ("Marcar como retirada" o `pnpm -s cli publications retire <id>`) |
| Quieres publicar de verdad en Instagram | Solo cuando lo decidas tú: `PUBLISH_MODE=live pnpm dev` (no se toca `.env`), y "Publicar en Instagram (en vivo)" en el panel o `pnpm -s cli publish P002` (pide confirmación). Para borrarla: en Instagram, `···` → Eliminar, y después "Marcar como retirada" (o `publications retire <id>`), que confirma que la borraste a mano. Al terminar, detén `pnpm dev` y arranca sin la variable |
| Quieres publicar en Portal Inmobiliario (simulación) | `pnpm -s cli approve P001 --platform portal` (avisa si le falta algo al aviso) y `pnpm -s cli publish P001 --platform portal`. En simulación solo lee de Mercado Libre y le pregunta si el aviso es válido: nunca lo crea. Si falta información (`PORTAL_NOT_READY`), la CLI la lista: complétala en la planilla y vuelve a importarla |
| Quieres conectar Mercado Libre (o reconectarlo: cuenta vencida o `ML_AUTH_INVALID`) | En **Cuentas** del panel, el bloque Mercado Libre del corredor muestra los dos comandos para copiar: el primero abre el enlace (autoriza con la cuenta administradora); al volver, el navegador muestra un error de conexión (es lo esperado), copias la dirección completa de la barra (vale 10 min) y corres el segundo |
| Quieres un usuario de prueba de Mercado Libre (para publicar en Portal sin pagar) | Sigue el paso a paso de `docs/07-checklist-cuentas.md` (sección F4): crearlo (con `pnpm ml:test-user --broker agentsales-pruebas`, que deja la clave en tu portapapeles), pedir su activación a soporte, contratar el paquete sin cargo con su sesión (nunca con tu cuenta real: ahí cobra) y conectarlo en una ventana privada. Su clave va solo a tu gestor de claves |
| Quieres publicar en Portal desde el panel | En Contenido, pestaña **Portal Inmobiliario**: arriba dice lo que le falta al aviso. Aprueba el texto y usa "Publicar en Portal Inmobiliario". El aviso publicado muestra su estado en Mercado Libre y el vencimiento, con Pausar, Reactivar, Cerrar (pide confirmación), Actualizar (lee su estado; solo en vivo), "Actualizar aviso" (manda el precio o el texto nuevos), "Republicar" (uno vencido o cerrado) y "vence en N días" |
| Quieres saber si Mercado Libre aceptaría el aviso de una propiedad, sin publicar | `pnpm ml:smoke --listing P001` en tu terminal (no necesita `pnpm dev`; necesita el texto de Portal preparado). Arma el aviso real y solo le pregunta a Mercado Libre si lo aceptaría: nunca sube fotos ni crea nada. Sin paquete con cupo dice "no verificado"; con el usuario de prueba y su paquete, lo revisa completo. El informe queda en `tmp/ml-smoke/` |
| Quieres pausar, reactivar, cerrar o actualizar un aviso de Portal | `pnpm -s cli publications P001` muestra el id, el estado en Mercado Libre y el vencimiento. Luego `pnpm -s cli publications pause <id>`, `resume <id>`, `close <id>` (en vivo pregunta: es irreversible y volver a publicar usa otro cupo) o `sync <id>` (pide leer el estado; el worker tiene que estar corriendo). Si la CLI dice `OPERATION_UNCONFIRMED`, no lo repitas: el cambio pudo aplicarse; míralo con `publications P001` o pide la lectura con `sync` |
| Quieres publicar de verdad en Portal Inmobiliario | Pendiente (D15 de F4): con el usuario de prueba conectado y su paquete; ver la checklist (`docs/07-checklist-cuentas.md`) |
| `PUBLICATION_LISTING_CHANGED` | Reimportaste la planilla después de aprobar: descarta la publicación y aprueba de nuevo |
| `PUBLICATION_PENDING` al preparar o `CONTENT_LOCKED` al editar | El texto está aprobado y tiene publicaciones que no han salido (o ya salieron): publícalas, descártalas o retíralas primero. Es a propósito: lo aprobado no cambia |
| `PUBLISH_MODE_MISMATCH` o `PUBLISH_MODE_LOCKED` | Una publicación pedida en vivo llegó a un worker en simulación, o una que ya empezó en vivo se quiso reintentar en simulación: arranca con `PUBLISH_MODE=live` y reintenta |
| Una publicación queda en "publicando" mucho rato | El worker no corre o se cortó: levanta `pnpm dev` (la reencola al arrancar; con el worker corriendo, la vigilancia de cada hora la reencola sola si lleva más de 70 min, salvo Marketplace) o usa "Volver a encolar" en el panel. Nunca publica dos veces |
| `IG_PUBLISH_OUTCOME_UNKNOWN` | No se sabe si salió: revisa tu Instagram. Si no salió, descártala y publica de nuevo; si salió, bórrala a mano antes de volver a publicar |
| `ML_PUBLISH_OUTCOME_UNKNOWN` | Búscalo en tu cuenta de Mercado Libre. Si no está, descarta y publica de nuevo; si está, ciérralo allá antes (volver a publicar gasta otro cupo) |
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
| Un usuario no puede entrar: "bloqueado" (`AUTH_LOCKED`) | Diez contraseñas equivocadas seguidas lo bloquean 15 minutos: que espere, o dale otro enlace con **Restablecer** en su detalle de **Corredores** (o `pnpm -s cli users reset <correo>`); elegir la contraseña nueva quita el bloqueo. Si eres tú, `pnpm auth:admin --email tu@correo.cl` |
| Conectar Mercado Libre dice `OAUTH_STATE_USED` | Pegaste una dirección de vuelta que ya se usó (cada enlace de autorizar sirve una vez): corre de nuevo el primer comando del bloque Mercado Libre en **Cuentas** y autoriza otra vez |
| Quieres respaldar la base ahora | `pnpm db:backup` en tu terminal (no necesita `pnpm dev`). Deja `agentsales-AAAAMMDD-HHMM.dump` en `~/.agentsales/backups` (o en `BACKUP_DIR`) y conserva los últimos 14. El worker lo hace solo cada día a las 13:00 y al arrancar si el último tiene más de 20 h. Más abajo, cómo restaurar |
| `BACKUP_TOOL_NOT_INSTALLED`, o `doctor` avisa por `pg_dump` | Falta el cliente de Postgres: `brew install libpq` (queda en `/opt/homebrew/opt/libpq/bin`, que el respaldo busca solo; si lo instalaste en otro lado, fija `PG_BIN_DIR` en `.env`) |
| `doctor` dice que `pg_dump` no puede respaldar una base más nueva | Tu `pg_dump` es de una versión mayor anterior a la de Neon: `brew upgrade libpq` |
| `BACKUP_FAILED` | `pnpm db:backup` muestra la causa: sin conexión o Neon sin CU-horas (reintenta más tarde), la carpeta sin espacio o sin permisos. Los respaldos buenos nunca se borran por un intento fallido |
| `BACKUP_IN_PROGRESS` | Ya hay un respaldo en curso (el del worker o otro `pnpm db:backup`): espera unos minutos y vuelve a intentarlo |

## Dar de alta un corredor (F7)

De punta a punta, con `pnpm dev` corriendo. Todo se puede hacer en el panel (**Corredores**) o en la CLI.

1. **Crear el corredor:** en **Corredores → Crear un corredor** (o `pnpm -s cli brokers create --slug <slug> --name <nombre> --brand <marca> --color <#RRGGBB>`). Si no es tuyo, déjalo **no propio**: su IA usa la API de Anthropic (con tu clave) y su Marketplace va a mano. Si quieres, ponle un **tope de IA del mes** en dólares.
2. **Invitar a su usuario:** en el detalle del corredor, **Usuarios → Invitar** (o `pnpm -s cli users invite --email <correo> --name <nombre> --broker <slug>`). El enlace se muestra **una sola vez** (en la CLI queda en el portapapeles): envíaselo por un canal privado. Vence en 72 h; si se pierde o vence, **Restablecer** da otro.
3. **El corredor entra** con el enlace, elige su contraseña y completa **Mi marca**: colores, WhatsApp (Portal lo exige), logo, y baja su planilla de Excel (ya trae su hoja Corredor llena). Ojo: si después carga una planilla vieja, puede deshacer lo que editó en Mi marca (manda lo último que se guarde).
4. **Sus cuentas** (las conectas tú, en **Cuentas**):
   - **Instagram:** como evaluador de tu app de Meta, en persona (pasos en `docs/07-checklist-cuentas.md`, "Antes de F7").
   - **Mercado Libre:** como hoy, con su cuenta y la dirección de vuelta.
   - **Marketplace:** **Activar Marketplace a mano** (el formulario automático es solo para tus corredores). Al publicar, el sistema deja el texto, las fotos y el precio listos; el corredor lo publica en Facebook y confirma con el enlace o "No lo publiqué".
5. **La lista de alta** del corredor (en su detalle, en Mi marca y en `pnpm -s cli brokers show <slug>`) dice qué falta y quién lo hace.
6. **El gasto:** en **Corredores** y con `pnpm -s cli usage`, lo gastado en IA en el mes (estimado: la cifra oficial está en la consola de Anthropic). Con el tope alcanzado, preparar los textos se frena hasta que subas el tope o empiece el mes siguiente.

Para desactivar a alguien: **Desactivar** en su usuario (o `pnpm -s cli users disable <correo>`) cierra sus sesiones al tiro.

## Restaurar un respaldo de la base

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

