# CLAUDE.md — AgentSales

Sistema que toma avisos (propiedades hoy, productos después) con fotos y videos, redacta el contenido con IA, procesa los medios y los publica en Instagram, Portal Inmobiliario y Facebook Marketplace, con aprobación, calendario y seguimiento. Proyecto personal de Vinny (operador) para aprender y luego ofrecer a corredores independientes.

## Al empezar cada sesión
1. Lee `docs/ESTADO.md`: fase actual, última tarea y siguiente paso.
2. Lee el spec de la fase en curso: `docs/specs/fase-N-*.md`.
3. Si la tarea toca un área, lee el doc correspondiente (mapa abajo) **antes** de escribir código.

## Mapa de documentación
| Doc | Cuándo leerlo |
|---|---|
| `docs/00-vision.md` | Alcance, qué está fuera del MVP |
| `docs/01-arquitectura.md` | Paquetes, flujos, máquina de estados, contratos Publisher y LLM |
| `docs/02-modelo-datos.md` | Cualquier cambio de base de datos |
| `docs/03-plataformas.md` | Cualquier integración externa |
| `docs/04-formato-publicaciones.md` | Prompts, plantillas y textos |
| `docs/05-convenciones.md` | Estilo, tests y git (reglas obligatorias) |
| `docs/06-roadmap.md` | Fases y criterios de aceptación |
| `docs/07-checklist-cuentas.md` | Trámites que hace el operador, no tú |
| `docs/10-despliegue.md` | Desplegar en Fly.io, encender y apagar, logs y volver atrás (lo hace el operador) |
| `docs/adr/` | Decisiones tomadas; no las contradigas sin un ADR nuevo |

## Stack (resumen; detalle en 05-convenciones)
Node 26 · pnpm 11 workspaces · TypeScript 7 strict · Hono (+ cliente RPC `hc`) · React + Vite + Tailwind + TanStack Query + React Router · Drizzle + `pg` + Neon (Postgres) · Cloudflare R2 (archivos, API S3) · pg-boss · exceljs + yauzl (xlsx y zip) · commander + picocolors (CLI) · sharp · ffmpeg · Playwright · zod · Vitest (+ PGlite para los repositorios) · Biome · pino.

## Estructura
```
apps/     api · worker · cli · web
packages/ config · core · db · storage · queue · importers · llm · media · templates · publishers
docs/     documentación, specs y ADRs
data/     plantillas (en git) y muestras (fuera de git)
```
`packages/core` no depende de infraestructura. Las apps componen adaptadores y llaman casos de uso.

## Comandos
```bash
pnpm dev                 # api + worker + web (apágalo al terminar: mantiene Neon despierto)
pnpm check               # lint + typecheck + tests (obligatorio antes de commit)
pnpm lint | pnpm format  # Biome (revisar | corregir)
pnpm typecheck           # tsc -b
pnpm test                # solo tests
pnpm build               # build de producción sin tests (API, worker y paquetes con tsconfig.build.json; el panel con Vite)
pnpm db:generate         # generar migración tras cambiar el esquema
pnpm db:migrate          # aplicar migraciones
pnpm db:seed             # seeds idempotentes
pnpm db:backup           # respaldo local de la base con pg_dump a BACKUP_DIR (fuera del proyecto; deja los últimos 14; no necesita pnpm dev; necesita brew install libpq)
pnpm db:dev-scrub        # borra las credenciales copiadas en la rama dev de Neon (solo .env; se niega si parece producción: la misma base o clave que .env.production, o credenciales que la clave de .env abre; pide confirmación, --yes; lo corre el operador)
pnpm storage:check       # verifica acceso al bucket de R2, el PUT prefirmado (y que R2 rechace otro contenido) y la regla de CORS para el panel (--origin <url>; con ENV_FILE=.env.production y --origin https://agentsales.agentpey.com, el bucket de producción; habla con R2: lo corre el operador)
pnpm auth:admin --email <correo>  # (en el servidor: ENV_FILE=.env.production pnpm auth:admin …) crea el administrador o le da un enlace de restablecer, en el portapapeles sin imprimirlo (habla directo con la base; lo corre el operador)
gh workflow run deploy.yml --ref main  # despliega en Fly.io (solo main con la CI en verde; lo corre el operador, nunca Claude: D8). Guía docs/10-despliegue.md: secretos, dominio, encender y apagar el worker para una demo, logs y volver atrás
pnpm -s cli login --email <correo>  # la sesión de la CLI (pide la contraseña sin mostrarla y, con el doble factor, el código de la app: lo corre el operador en su terminal); con --api https://<dominio>, la de un servidor (queda guardada; AGENTSALES_API_URL manda sobre ella); whoami (dice el servidor), logout
pnpm -s cli doctor       # salud del entorno (con pnpm dev corriendo, o contra el servidor si el login es con --api)
pnpm -s cli status       # /health y PUBLISH_MODE (con pnpm dev corriendo, o contra el servidor si el login es con --api)
pnpm worker:ping         # encola un job de prueba (con el worker corriendo)
pnpm llm:smoke           # una llamada real y corta a la CLI de Claude con datos inventados (gasta cuota; la corre el operador); con --provider anthropic-api [--model <id>], a la API con ANTHROPIC_API_KEY, e imprime los tokens y el costo estimado (gasta centavos)
pnpm ig:smoke            # crea UN contenedor de imagen en Instagram desde una URL firmada de R2 y espera FINISHED, sin publicar (--broker <slug>, --listing <id_propiedad>; habla con Meta: lo corre el operador)
pnpm fb:smoke --broker <slug>  # (solo un corredor propio) abre con ventana el perfil de Facebook del corredor (inicias sesión a mano si hace falta) y guarda en tmp/fb-smoke/ la captura y el árbol del formulario de Marketplace, sin llenar nada ni hacer clic; con --menus, además, el árbol de cada menú que abres a mano, al apretar Enter. Con --listing <id_propiedad> llena el formulario real con esa propiedad después de tu s/N (--yes), respeta el límite del día, nunca hace Siguiente ni Publicar ni cambia estados, y deja la ventana abierta hasta que la cierras; con --diagnostico errores,sin-evidencia,sin-fotos,lento (solo para investigar un fallo) anota los errores técnicos de la página sin datos del operador (habla con Facebook: lo corre el operador)
pnpm uf:smoke            # pide el valor de la UF de hoy y los próximos 31 días a la API BDE del Banco Central con BCCH_API_TOKEN, y una consulta con un token inventado, sin tocar la base (habla con el Banco Central: lo corre el operador)
pnpm ml:test-user --broker <slug>  # crea UN usuario de prueba de Mercado Libre con la cuenta real conectada y deja su clave en el portapapeles, sin imprimirla (habla con Mercado Libre: lo corre el operador)
pnpm ml:smoke            # recorre el catálogo de Inmuebles y las ubicaciones de Chile, pregunta a validate por un aviso de prueba y sus variantes, y lee la búsqueda de ítems y los paquetes, sin crear ni cambiar nada en Mercado Libre (--broker <slug>, --category <MLC…>; informe en tmp/ml-smoke/; escribe el catálogo en la base; habla con Mercado Libre: lo corre el operador). Con --listing <id_propiedad>, arma el aviso real y solo pregunta a validate si lo aceptaría
pnpm eval:content        # evalúa el prompt sobre las propiedades listas de agentsales-pruebas, sin escribir en la base (--broker <slug>; --provider fake no gasta cuota; con claude-cli lo corre el operador; --provider anthropic-api [--model <id>] usa la API, gasta centavos e imprime el costo estimado)
pnpm -s cli import <xlsx> --media <carpeta|zip>  # carga propiedades: sube la planilla y los medios directo a R2 y espera (con pnpm dev corriendo; --dry-run simula por el mismo camino; --no-wait)
pnpm -s cli listings     # propiedades cargadas (detalle: cli listing <id>; historial: cli imports)
pnpm -s cli prepare <id_propiedad>  # prepara fotos, portada, reel y textos y espera (con pnpm dev; --no-texts, --replace-edits, --no-wait)
pnpm -s cli content <id_propiedad>  # textos por canal con su revisión (--platform instagram|portal|marketplace, --json)
pnpm -s cli approve <id_propiedad>  # aprueba los textos sin errores (--platform, --undo para quitar la aprobación)
pnpm -s cli publish <id_propiedad>  # publica y espera: carrusel y reel, el aviso con --platform portal, o el formulario de Marketplace con --platform marketplace (espera el formulario listo y el enlace; tú haces Siguiente y Publicar) (en live pide confirmación; --yes, --no-wait)
pnpm -s cli publications [<id_propiedad>]  # estado, modo, enlace y, en Portal, el estado en Mercado Libre y el vencimiento; en Marketplace, el precio en pesos con la UF usada (--events; publications cancel|retire <id>)
pnpm -s cli publications pause|resume|close|sync <id>  # Portal: pausa, reactiva, cierra (en live pide confirmación; --yes) o pide leer el estado en Mercado Libre
pnpm -s cli publications update|relist <id>  # Portal: manda al aviso el precio, los atributos o el texto nuevos, o republica uno vencido o cerrado (en live pide confirmación; --yes)
pnpm -s cli schedule <id_propiedad…> --at "2026-10-19 10:00"  # programa en hora de Chile (--platform, --spacing <min>; --publication <id> para una sola; en live pide confirmación, --yes); unschedule <id> la desprograma
pnpm -s cli agenda       # lo pendiente (atrasadas, te toca, atascadas, fallas, tareas a mano, espera tu revisión, aprobadas sin publicar, por vencer, próximas, respaldo) con el comando de cada una (--broker, --json)
pnpm -s cli tracking     # cada propiedad por plataforma (--broker, --archived, --json)
pnpm -s cli listing ready|pause|resume|reopen|archive <id_propiedad>  # la propiedad manda sobre sus publicaciones; listing close <id_propiedad> --reason vendida|arrendada|retirada (pide confirmación; --yes)
pnpm -s cli brokers auto-publish <slug> on|off  # publicación automática del corredor (pregunta siempre; --yes)
pnpm -s cli brokers create|edit|show|logo|template  # corredores: crear (--slug --name --brand --color …), editar la marca (--own/--not-own y --cap/--no-cap, solo el administrador), su lista de alta, el logo (PNG, JPEG o WebP) y su planilla (--out, --force)
pnpm -s cli users list|invite|reset|disable|enable  # usuarios (administrador): invite --email --name --broker <slug>|--admin; el enlace va al portapapeles, nunca a la pantalla (no lo pegues en el chat)
pnpm -s cli usage [--month AAAA-MM]  # el gasto de IA del mes por corredor (estimado), con su tope
pbpaste | pnpm -s cli publications confirm <id> --url-stdin  # Marketplace: lo publicaste (el enlace no se imprime); publications not-published <id> si no
pnpm -s cli accounts     # cuentas y vencimiento (pbpaste | pnpm -s cli accounts connect instagram --broker <slug> --token-stdin; Mercado Libre: accounts connect mercadolibre --broker <slug> y después pbpaste | … --url-stdin (en el servidor con su dominio, el botón del panel); Marketplace: accounts connect marketplace --broker <slug> abre Chromium para iniciar sesión a mano (lo pide el operador; solo corredores propios y no en producción, donde es a mano para todos), o --manual activa Marketplace a mano; accounts refresh <id> [--force]; accounts disconnect <id> pide confirmación, --yes)
```
(Los comandos existen desde F0; si alguno falta, la tarea que lo introduce debe crearlo.)

## Glosario (español → código)
corredor → `Broker` · propiedad/aviso → `Listing` · medio (foto/video) → `Media` · texto generado → `Content` · publicación (aviso × cuenta × formato: carrusel, reel o aviso en Portal) → `Publication` · cuenta conectada → `PlatformAccount` · campo configurable → `FieldDefinition` · carga → `ImportRun`.

## Reglas de trabajo (obligatorias)
1. **Spec primero.** No implementes nada que no esté en el spec aprobado de la fase. Si falta algo, propónlo y actualiza el spec antes.
2. **Una tarea, o un lote de tareas relacionadas, a la vez** (desde 2026-10-09: tareas de la misma zona van juntas), en su propia rama `<tipo>/<id-tarea(s)>-<resumen>` (ej. `feat/f4-t21-t22-panel-portal`), con commits Conventional Commits. Nunca dos ramas en paralelo: la Mac de 8 GB no aguanta dos `pnpm check` a la vez.
3. **Planifica antes de editar:** para tareas de más de un archivo, presenta el plan (archivos, pasos, tests) y espera el OK del operador, salvo su aprobación permanente (desde 2026-10-01: aplica tu recomendación y cuéntale después; las preguntas de sus cuentas o de producto sí se hacen).
4. **Tests con el código:** el caso de uso o adaptador nuevo viene con sus tests en el mismo commit. Nunca debilites un test para que pase.
5. **`pnpm check` en verde** antes de dar una tarea por terminada (una vez; se repite solo si falla por "timed out" de PGlite o del panel). La CI de GitHub corre en un clon limpio y el merge la exige en verde sobre el último commit.
6. **Documentación viva:** si el código cambia algo documentado, actualiza el doc en el mismo PR. Al terminar la tarea, actualiza `docs/ESTADO.md`.
7. **Decisiones estructurales → ADR** (`/adr`). No cambies stack, patrones ni contratos en silencio.
8. **Dependencias:** solo las del stack. Una nueva requiere justificación en el PR.
9. **Si algo es ambiguo, pregunta.** Mejor una pregunta que una suposición cara.

## Reglas de seguridad (no negociables)
- `PUBLISH_MODE=dry-run` por defecto. **Nunca** cambies a `live` ni publiques de verdad sin instrucción explícita del operador en el chat. En `dry-run`, Portal puede leer de Mercado Libre y validar sin publicar (ADR-0016), nunca crear ni cambiar un aviso.
- `pnpm ml:test-user` es la única escritura en Mercado Libre que no mira `PUBLISH_MODE` (crea un usuario de prueba con la cuenta real; la corre solo el operador, ADR-0015).
- Ningún test llama APIs reales de Instagram, Mercado Libre, Facebook ni Anthropic. Usa msw o fakes.
- No leas, muestres ni commitees `.env`. No loguees tokens ni secretos.
- La sesión de la CLI (`~/.agentsales/cli-session.json`) es del operador: úsala a través de la CLI, pero nunca leas ni muestres ese archivo. Los enlaces de invitación (`/invitacion#…`) son secretos: no los imprimas ni los pegues en el chat.
- No subas datos reales de clientes (`data/muestras/`) a git.
- Marketplace: nunca automatices el clic final (ni el de Siguiente), ni resuelvas o evadas captchas o verificaciones, ni disfraces la automatización. Conectar la cuenta de Marketplace y `pnpm fb:smoke` abren Facebook en cualquier modo, porque no publican (ADR-0017): los pide y corre solo el operador. No leas la carpeta de perfiles (`BROWSER_PROFILES_DIR`: guarda la sesión de Facebook); de `tmp/fb-smoke/` lee solo, y siempre con el permiso del operador en el chat: `summary.json` y los árboles que lista (`*.aria.yml`), y de una corrida de `--listing` los archivos de diagnóstico de su carpeta `fb-smoke-<id>/` (`formulario.aria.yml`, `control-faltante.aria.yml`, `listas-abiertas.aria.yml`, `errores-de-la-pagina.txt`); nunca las capturas `.png`.
- Nunca `git push --force` a `main` ni reescribas su historia.
- Desplegar es del operador (spec F8, D8): nunca corras `gh workflow run deploy.yml`, `fly deploy`, `fly secrets`, `fly machine start/stop` ni otro comando que hable con Fly.io; preparas los archivos y la guía (`docs/10-despliegue.md`).

## Reglas editoriales de la IA (resumen)
Solo datos entregados; nunca inventar. Respetar `show_exact_address`. Precio con formato chileno (`UF 5.800`, `$650.000`). Sin requisitos discriminatorios. Detalle completo en `docs/04-formato-publicaciones.md`.

## Flujo con skills del proyecto
- `/estado` — dónde estamos y qué sigue (usar al abrir sesión).
- `/fase-plan N` — redactar o revisar el spec de la fase N.
- `/tarea FN-TXX` — ejecutar una tarea (o un lote: `/tarea F4-T21 F4-T22`) del spec de punta a punta.
- `/revisar` — revisión del diff actual con el subagente `revisor`.
- `/adr "título"` — registrar una decisión.
- `/fase-cerrar N` — verificar criterios, changelog y tag.

Subagentes: `arquitecto` (coherencia con ADRs y diseño), `revisor` (calidad, tests, seguridad), `integraciones` (investiga APIs externas y documenta).

## Definición de terminado (por tarea)
- [ ] Criterios "Hecho cuando" del spec cumplidos
- [ ] Tests nuevos o actualizados, y `pnpm check` en verde
- [ ] Docs afectados actualizados, y `docs/ESTADO.md` al día
- [ ] Commit(s) convencional(es) en la rama de la tarea o del lote
- [ ] Resumen al operador: qué cambió, cómo probarlo y siguiente paso
