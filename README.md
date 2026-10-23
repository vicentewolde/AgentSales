# AgentSales

Publica avisos inmobiliarios (y luego productos en general) en Instagram, Portal Inmobiliario y Facebook Marketplace: la IA redacta, procesa fotos y videos, y el sistema publica, programa y hace seguimiento. Desde F9 hace lo mismo con el contenido de marca (posts) en Instagram, X, LinkedIn, Discord y TikTok, con una IA que propone ideas y el operador aprobando todo.

> Estado: **F9.5 · Lista para mostrar** cerrada (`v1.4.0`): el panel presentable para la demo con la oficina del piloto. F9 (contenido de marca) cerrada con `v1.3.0`; sigue F10 (el piloto). El MVP (`v1.0.0`, F8) corre en `https://agentsales.agentpey.com` (simulación). Pendientes del operador: el App Review de Meta y las pruebas de entrada de las redes (S1 a S6). Ver `docs/ESTADO.md`.

## Requisitos
- Node.js 26 (`.nvmrc`) y pnpm 11 (`npm i -g pnpm@11`; Node 26 ya no trae corepack)
- ffmpeg 8.1 o más nuevo, con ffprobe (`brew install ffmpeg`): arma las fotos HEIC del iPhone y el reel
- Chromium de Playwright, para dibujar la portada y la ficha (se instala en la puesta en marcha)
- La CLI de Claude (Claude Code) con sesión iniciada en tu plan (`claude` y `/login`): redacta los textos. Para probar sin gastar cuota, `LLM_PROVIDER=fake` en `.env`
- Una clave de la API de Anthropic (`ANTHROPIC_API_KEY`, F7), solo si atiendes corredores que no son tuyos: sus textos se redactan por la API y se cobran por uso (`docs/07-checklist-cuentas.md`)
- Proyecto de Neon (Postgres) y bucket privado de Cloudflare R2, ambos gratis: `docs/09-alta-neon-r2.md`
- El cliente de Postgres (`brew install libpq`), para el respaldo local de la base (`pg_dump`; `doctor` revisa que su versión alcance a la de Neon)

## En internet
El servidor (Fly.io) y el dominio `agentsales.agentpey.com` ya existen. Desplegar, encender y apagar el worker para una demo, ver los logs, volver atrás y restaurar un respaldo está en `docs/10-despliegue.md`; desplegar lo hace solo el operador. La puesta en marcha de abajo es la de tu Mac, para desarrollar (usa una rama de Neon y un bucket de R2 propios, no los de producción).

## Puesta en marcha
```bash
cp .env.example .env     # completar DATABASE_URL, R2_* y APP_ENCRYPTION_KEY (docs/09-alta-neon-r2.md)
pnpm install
pnpm --filter @agentsales/media exec playwright install chromium   # el Chromium que pide Playwright (repetir al actualizarlo)
pnpm db:migrate          # aplica las migraciones en Neon
pnpm db:seed             # crea el corredor demo y las 36 definiciones de campos (se puede repetir; --operator-brands suma tus marcas, F9)
pnpm storage:check       # sube, lee y borra un objeto de prueba en R2
pnpm auth:admin --email tu@correo.cl   # tu usuario de administrador: el enlace para elegir la contraseña queda en el portapapeles
pnpm dev                 # API en 127.0.0.1:8787 · worker · panel en http://localhost:5173
```
Abre el enlace del portapapeles (con `pnpm dev` corriendo), elige tu contraseña y entras al panel. Si la olvidas o te bloqueas, `pnpm auth:admin` de nuevo te da otro enlace. En otra terminal, con `pnpm dev` corriendo:
```bash
pnpm -s cli login --email tu@correo.cl   # la CLI pide la contraseña sin mostrarla (--api https://<dominio> para un servidor); whoami y logout
pnpm -s cli doctor       # Node, .env, API, base, almacenamiento, cola y herramientas
pnpm -s cli status       # /health y PUBLISH_MODE
pnpm worker:ping         # opcional: encola un job de prueba; el worker loguea "pong"
```
Cargar y consultar propiedades, con `pnpm dev` corriendo (la carga la procesa el worker). Las rutas son relativas a la carpeta donde corres el comando:
```bash
pnpm -s cli import propiedades.xlsx --media medios   # o --media medios.zip; --dry-run simula
pnpm -s cli imports [<id>]                           # historial de cargas, o el reporte de una
pnpm -s cli listings [--status ready] [--json]
pnpm -s cli listing <id_propiedad> [--broker <slug>] [--json]
```
También se puede importar desde el panel, en http://localhost:5173/importar (el Excel y un zip de fotos y videos), y ver las propiedades en http://localhost:5173/propiedades.

Preparar el contenido de una propiedad lista (fotos para cada canal, portada, ficha, reel y textos de la IA), con `pnpm dev` corriendo:
```bash
pnpm -s cli prepare <id_propiedad>                   # --no-texts rehace solo las imágenes; --replace-edits reemplaza tus ediciones
pnpm -s cli content <id_propiedad> [--platform portal] [--json]
pnpm eval:content                                    # evalúa los textos de la IA sin guardar nada (gasta cuota; --provider fake no)
pnpm eval:social                                     # evalúa el plan de ideas y los textos de posts sobre perfiles de prueba, sin la base (gasta cuota; --provider fake no)
pnpm llm:smoke                                       # una llamada corta a la CLI de Claude con datos inventados
```
En el panel, el detalle de cada propiedad tiene la sección **Contenido**: preparar, el avance, la vista previa por canal (carrusel, caption, reel, Portal y Marketplace) con su revisión editorial y la edición de los textos.

Conectar Instagram y publicar (F3), con `pnpm dev` corriendo. La cuenta se conecta con el token del botón **Generate token** del panel de Meta (copiado al portapapeles); las variables `INSTAGRAM_*` solo las necesita el botón de Cuentas (OAuth), que exige HTTPS y por eso funciona en el servidor y no en tu Mac:
```bash
pbpaste | pnpm -s cli accounts connect instagram --broker <slug> --token-stdin
pnpm -s cli accounts [refresh <id> [--force]]        # cuentas, vencimiento y refresco
pnpm -s cli approve <id_propiedad> [--platform instagram] [--undo]
pnpm -s cli publish <id_propiedad>                   # en dry-run simula; en live pide confirmación
pnpm -s cli publications <id_propiedad> [--events]   # estado, enlace y bitácora; cancel | retire <id>
pnpm ig:smoke                                        # comprueba que Instagram descarga desde R2, sin publicar (no necesita pnpm dev)
```
En el panel: la página **Cuentas** (http://localhost:5173/cuentas) y, en la sección Contenido de cada propiedad, aprobar por canal y las publicaciones de Instagram (publicar, reintentar, descartar, marcar como retirada y la bitácora). Para publicar de verdad en una sesión, `PUBLISH_MODE=live pnpm dev` (la API y el worker lo reciben juntos, sin tocar `.env`); al terminar, arranca de nuevo sin la variable. Lo publicado en vivo se borra a mano en Instagram y se marca como retirado.
Conectar Mercado Libre y publicar en Portal Inmobiliario (F4), con `pnpm dev` corriendo. Hace falta la app de Mercado Libre y `ML_APP_ID`, `ML_CLIENT_SECRET` y `ML_REDIRECT_URI` en `.env` (pasos en `docs/07-checklist-cuentas.md`):
```bash
pnpm -s cli accounts connect mercadolibre --broker <slug>   # abre el enlace; autoriza y copia la dirección de vuelta
pbpaste | pnpm -s cli accounts connect mercadolibre --broker <slug> --url-stdin
pnpm -s cli approve <id_propiedad> --platform portal        # avisa lo que le falta al aviso
pnpm -s cli publish <id_propiedad> --platform portal        # en dry-run solo lee de Mercado Libre y valida
pnpm -s cli publications pause|resume|close|sync <id>       # cerrar en live pide confirmación
pnpm ml:smoke [--listing <id_propiedad>]                    # catálogo y validate, sin publicar (no necesita pnpm dev)
pnpm ml:test-user --broker <slug>                           # un usuario de prueba de Mercado Libre (clave al portapapeles)
```
En el panel, la pestaña **Portal Inmobiliario** de cada propiedad muestra lo que falta, aprobar, publicar y el aviso con su estado en Mercado Libre, el vencimiento y Pausar, Reactivar, Cerrar y Actualizar.

Conectar Facebook y publicar en Marketplace (F5), con `pnpm dev` corriendo. Solo arriendos de casa o departamento; un precio en UF necesita `BCCH_API_TOKEN` en `.env` (`docs/07-checklist-cuentas.md`). En vivo, el sistema llena el formulario en una ventana de Chromium y **tú haces Siguiente y Publicar**:
```bash
pnpm -s cli accounts connect marketplace --broker <slug>    # abre Chromium: inicias sesión a mano
pnpm -s cli approve <id_propiedad> --platform marketplace   # avisa lo que le falta al aviso
pnpm -s cli publish <id_propiedad> --platform marketplace   # en dry-run no abre Facebook
pbpaste | pnpm -s cli publications confirm <id> --url-stdin  # lo publicaste (o publications not-published <id>)
pnpm fb:smoke --listing <id_propiedad>                      # llena el formulario real sin publicar (no necesita pnpm dev)
pnpm uf:smoke                                               # el valor de la UF de hoy con tu token
```
En el panel: **Cuentas** (iniciar sesión en Facebook, desconectar) y la pestaña **Marketplace** de cada propiedad (lo que falta, aprobar, publicar, "Formulario listo", pegar el enlace, "No lo publiqué", Marcar como retirada y el plan B para copiar los textos).

Programar, seguir y respaldar (F6), con `pnpm dev` corriendo. Lo programado sale solo a la hora mientras el worker está encendido (si estaba apagado, al encender salen las de 12 h o menos de atraso); Marketplace programado es solo un recordatorio ("te toca"):
```bash
pnpm -s cli schedule <id_propiedad…> --at "2026-10-19 10:00" [--platform instagram] [--spacing 15]   # hora de Chile
pnpm -s cli unschedule <id>                                  # o schedule --publication <id> --at … para reprogramar
pnpm -s cli agenda                                           # lo que toca hacer hoy, con el comando de cada cosa
pnpm -s cli tracking                                         # cada propiedad en cada plataforma
pnpm -s cli listing pause|resume|reopen|archive <id_propiedad>
pnpm -s cli listing close <id_propiedad> --reason vendida|arrendada|retirada   # cierra Portal y te deja las tareas a mano
pnpm -s cli publications update|relist <id>                  # Portal: manda los cambios o republica uno vencido
pnpm -s cli brokers auto-publish <slug> on|off               # aprobar y publicar solo al preparar
pnpm db:backup                                               # respaldo en ~/.agentsales/backups (no necesita pnpm dev)
```
En el panel: la página **Seguimiento** (http://localhost:5173/seguimiento) con la agenda y la tabla por plataforma; programar en cada publicación, en el canal y varias propiedades a la vez desde **Propiedades**; los botones de la propiedad en su detalle (Pausar, Vendida, Arrendada…), y la publicación automática en **Cuentas**. El worker también respalda la base cada día a las 13:00; cómo restaurar, en `docs/08-guia-operador.md`.

Varios corredores (F7), con `pnpm dev` corriendo y tu sesión de administrador. Cada corredor entra con su usuario y ve solo lo suyo; el paso a paso está en `docs/08-guia-operador.md` ("Dar de alta un corredor"):
```bash
pnpm -s cli brokers create --slug <slug> --name <nombre> --brand <marca> --color <#RRGGBB>   # un corredor nuevo
pnpm -s cli users invite --email <correo> --name <nombre> --broker <slug>   # su usuario: el enlace queda en el portapapeles
pnpm -s cli brokers template <slug>                          # su planilla de Excel, con su marca
pnpm -s cli accounts connect marketplace --broker <slug> --manual   # Marketplace a mano (corredores que no son tuyos)
pnpm -s cli usage [--month 2026-10]                          # el gasto de IA del mes por corredor (estimado)
pnpm -s cli users list|reset|disable|enable                  # los usuarios; reset deja otro enlace en el portapapeles
pnpm -s cli brokers show|edit|logo <slug>                    # su marca, sus ajustes (--cap <usd> para el tope de IA) y su logo
pnpm llm:smoke --provider anthropic-api                      # una llamada corta por la API (gasta centavos)
```
En el panel: **Corredores** (alta, marca, logo, planilla, usuarios y gasto), **Ver corredor** para mirar uno a la vez y, para el corredor, **Mi marca**. Los enlaces de invitación son secretos: envíalos por un canal privado o con **Enviar por correo** (al correo del invitado, sin reenviarlo).

Contenido de marca (F9), con `pnpm dev` corriendo. Cada red necesita su app y sus variables en `.env` (salvo Discord) y su prueba de entrada antes de publicar de verdad (`docs/07-checklist-cuentas.md`, "F9 · Contenido de marca"); el paso a paso está en `docs/08-guia-operador.md` ("El contenido de tus marcas, de punta a punta"):
```bash
pnpm db:seed --operator-brands                               # tus marcas vinny y agentpey (solo en tu instancia)
pnpm -s cli brand show|edit --broker <slug>                  # el perfil editorial: idiomas, líneas, hechos, cadencia
pnpm -s cli accounts connect linkedin|x|tiktok --broker <slug>   # OAuth en el navegador donde tienes el panel
pbpaste | pnpm -s cli accounts connect discord --broker <slug> --webhook-stdin
pnpm -s cli accounts mode <id> manual|api                    # LinkedIn nace a mano; spend-limit <id> <usd> para X
pnpm -s cli plan --broker <slug> [--days 14]                 # la IA propone ideas con fecha; plan show|list
pnpm -s cli post accept|discard <id>                         # aceptar una idea redacta sus textos (accept --wait los espera)
pnpm -s cli post create|list|show|upload|draft|edit|approve|publish|schedule|archive
pnpm -s cli publications resolve <id> --published|--not-published   # "no se sabe si salió"
pbpaste | pnpm -s cli publications confirm <id> --url-stdin  # LinkedIn a mano o TikTok: lo publicaste (LinkedIn también con --no-url, sin enlace)
pnpm eval:social                                             # evalúa el plan y los textos sin la base (--provider fake no gasta)
```
En el panel: **Contenido** (posts, textos por red e idioma, medios, aprobar, programar, resolver y confirmar), **Plan** (las ideas por semana) y **Calendario** (lo programado de posts y propiedades); el perfil editorial, en **Mi marca**.
- **`PUBLISH_MODE=dry-run` por defecto:** no se publica nada de verdad. En `live` se ve en rojo en el panel y la CLI.
- **La cola la inicializa el worker:** la primera vez aparece con error hasta que el worker arranca (lo hace `pnpm dev`); refresca el panel.
- **Detén `pnpm dev` al terminar** (Ctrl+C): el worker y el panel mantienen Neon despierto y consumen las horas del plan gratis.
- **Antes de cada commit, `pnpm check`** (lint, tipos y tests). La CI lo exige para hacer merge a `main`.

## Documentación
Empieza por `docs/00-vision.md` y `docs/01-arquitectura.md`. Las decisiones están en `docs/adr/` y los planes por fase en `docs/specs/`. Para el operador: `docs/07-checklist-cuentas.md` (trámites) y `docs/08-guia-operador.md` (cómo trabajar con Claude Code).

## Cómo se desarrolla
Con Claude Code, siguiendo `CLAUDE.md`: spec por fase → una tarea por rama y PR → revisión → cierre de fase con tag.
