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
| `pnpm check` falla y no se arregla | Pídele diagnosticar la causa raíz antes de intentar más cambios; si persiste, `/clear` y retoma con `/tarea` |
| Una API externa no se comporta como dice el doc | Pide al subagente `integraciones` verificar y actualizar las notas; luego ajusta el spec |
| Quieres cambiar el stack o un patrón | `/adr "..."` primero, código después |
| Perdiste el hilo entre sesiones | `/estado` |
| Quieres preparar el contenido de una propiedad | Con `pnpm dev` corriendo: `pnpm -s cli prepare P001` (espera y muestra la revisión), y después `pnpm -s cli content P001` para leer los textos (`--platform portal` para uno solo). Con `LLM_PROVIDER=fake` en `.env` no gasta cuota |
| `prepare` dice `CONTENT_EDITED` | Editaste textos a mano y prepararlos de nuevo los reemplazaría: usa `--no-texts` para rehacer solo las imágenes, o `--replace-edits` si quieres textos nuevos |
| `prepare` dice "Sigue en cola" | El worker no está corriendo: levanta `pnpm dev` (la corrida espera en cola y arranca sola). En `publish` el aviso puede salir aunque el worker corra: publica de a una, y un carrusel tarda más de 20 s en dar señales (deuda anotada en ESTADO) |
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
| Quieres publicar en Portal desde el panel | En Contenido, pestaña **Portal Inmobiliario**: arriba dice lo que le falta al aviso. Aprueba el texto y usa "Publicar en Portal Inmobiliario". El aviso publicado muestra su estado en Mercado Libre y el vencimiento, con Pausar, Reactivar, Cerrar (pide confirmación) y Actualizar (solo en vivo) |
| Quieres saber si Mercado Libre aceptaría el aviso de una propiedad, sin publicar | `pnpm ml:smoke --listing P001` en tu terminal (no necesita `pnpm dev`; necesita el texto de Portal preparado). Arma el aviso real y solo le pregunta a Mercado Libre si lo aceptaría: nunca sube fotos ni crea nada. Sin paquete con cupo dice "no verificado"; con el usuario de prueba y su paquete, lo revisa completo. El informe queda en `tmp/ml-smoke/` |
| Quieres pausar, reactivar, cerrar o actualizar un aviso de Portal | `pnpm -s cli publications P001` muestra el id, el estado en Mercado Libre y el vencimiento. Luego `pnpm -s cli publications pause <id>`, `resume <id>`, `close <id>` (en vivo pregunta: es irreversible y volver a publicar usa otro cupo) o `sync <id>` (pide leer el estado; el worker tiene que estar corriendo). Si la CLI dice `OPERATION_UNCONFIRMED`, no lo repitas: el cambio pudo aplicarse; míralo con `publications P001` o pide la lectura con `sync` |
| Quieres publicar de verdad en Portal Inmobiliario | Pasa a F5, con el usuario de prueba conectado y su paquete; ver la checklist (`docs/07-checklist-cuentas.md`) |
| `PUBLICATION_LISTING_CHANGED` | Reimportaste la planilla después de aprobar: descarta la publicación y aprueba de nuevo |
| `PUBLICATION_PENDING` al preparar o `CONTENT_LOCKED` al editar | El texto está aprobado y tiene publicaciones que no han salido (o ya salieron): publícalas, descártalas o retíralas primero. Es a propósito: lo aprobado no cambia |
| `PUBLISH_MODE_MISMATCH` o `PUBLISH_MODE_LOCKED` | Una publicación pedida en vivo llegó a un worker en simulación, o una que ya empezó en vivo se quiso reintentar en simulación: arranca con `PUBLISH_MODE=live` y reintenta |
| Una publicación queda en "publicando" mucho rato | El worker no corre o se cortó: levanta `pnpm dev` (la reencola al arrancar) o usa "Volver a encolar" en el panel. Nunca publica dos veces |
| `IG_PUBLISH_OUTCOME_UNKNOWN` | No se sabe si salió: revisa tu Instagram. Si no salió, descártala y publica de nuevo; si salió, bórrala a mano antes de volver a publicar |
| `ML_PUBLISH_OUTCOME_UNKNOWN` | Búscalo en tu cuenta de Mercado Libre. Si no está, descarta y publica de nuevo; si está, ciérralo allá antes (volver a publicar gasta otro cupo) |
| Quieres renovar el token | Lo hace el worker solo (al arrancar y a las 12:00, hora de Chile): Instagram, 24 h después de conectar o del último refresco; Mercado Libre, cada 7 días (si falta `ML_APP_ID` o `ML_CLIENT_SECRET` en `.env`, se salta con un aviso en el log). A pedido: `pnpm -s cli accounts refresh <id>`; en Instagram, `--force` no espera a que falten 30 días, pero sí respeta las 24 h; en Mercado Libre, `--force` renueva siempre. Como el worker corre solo con `pnpm dev`, ábrelo de vez en cuando: con 4 meses sin renovarse, Mercado Libre da de baja el acceso (Instagram, a los 60 días) y hay que reconectar la cuenta |
| Quieres comprobar que Instagram descarga las fotos desde R2, sin publicar | `pnpm ig:smoke` en tu terminal, con la cuenta conectada (no necesita `pnpm dev`): le pide a Instagram que prepare la portada de la primera propiedad preparada (`--listing <id_propiedad>` para elegir otra; `--broker <slug>` si hay cuentas en varios corredores) y espera hasta 5 min. `✓` si la descargó; si no, el código (`IG_MEDIA_FETCH_FAILED` es que no pudo bajar el enlace de R2). Nunca publica, ni siquiera en `live`: lo preparado vence solo en 24 h. Habla con Instagram aunque estés en `dry-run` |
| Quieres que Claude conozca el formulario de Marketplace (F5) | `pnpm fb:smoke --broker agentsales-pruebas` en tu terminal (no necesita `pnpm dev`). Se abre una ventana de Chromium con el perfil de Facebook del corredor (vive fuera del proyecto, en `~/.agentsales/browser-profiles`). La primera vez, inicia sesión a mano en esa ventana, también el código de verificación: el sistema no escribe nada y espera hasta 10 min. Después guarda en `tmp/fb-smoke/` la captura y el árbol **del formulario** (sin la barra con tu nombre) y un resumen, y cierra la ventana. No llena nada ni hace clic. Avísale a Claude: lee solo el árbol del formulario |
| `fb:smoke` dice que el perfil está abierto (`MARKETPLACE_PROFILE_BUSY`) | Otra ventana de Chromium tiene el perfil (por ejemplo, el worker con un formulario): ciérrala y vuelve a correrlo |
| `fb:smoke` se detiene con una verificación, Marketplace no disponible o "el formulario cambió" | No reintentes en bucle. Abre Facebook en tu navegador y revisa el estado de tu perfil (Perfil → Estado del perfil → Marketplace); resuelve tú la verificación. Si "el formulario cambió", avísale a Claude con el resumen de `tmp/fb-smoke/summary.json` (no trae datos tuyos) |
