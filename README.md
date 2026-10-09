# AgentSales

Publica avisos inmobiliarios (y luego productos en general) en Instagram, Portal Inmobiliario y Facebook Marketplace: la IA redacta, procesa fotos y videos, y el sistema publica, programa y hace seguimiento.

> Estado: **F4 · Portal Inmobiliario cerrada** (con la simulación; la prueba en vivo con un usuario de prueba de Mercado Libre queda para el inicio de F5). Siguiente: F5 · Facebook Marketplace. Ver `docs/ESTADO.md`.

## Requisitos
- Node.js 26 (`.nvmrc`) y pnpm 11 (`npm i -g pnpm@11`; Node 26 ya no trae corepack)
- ffmpeg 8.1 o más nuevo, con ffprobe (`brew install ffmpeg`): arma las fotos HEIC del iPhone y el reel
- Chromium de Playwright, para dibujar la portada y la ficha (se instala en la puesta en marcha)
- La CLI de Claude (Claude Code) con sesión iniciada en tu plan (`claude` y `/login`): redacta los textos. Para probar sin gastar cuota, `LLM_PROVIDER=fake` en `.env`
- Proyecto de Neon (Postgres) y bucket privado de Cloudflare R2, ambos gratis: `docs/09-alta-neon-r2.md`

## Puesta en marcha
```bash
cp .env.example .env     # completar DATABASE_URL, R2_* y APP_ENCRYPTION_KEY (docs/09-alta-neon-r2.md)
pnpm install
pnpm --filter @agentsales/media exec playwright install chromium   # el Chromium que pide Playwright (repetir al actualizarlo)
pnpm db:migrate          # aplica las migraciones en Neon
pnpm db:seed             # crea el corredor demo y las 36 definiciones de campos (se puede repetir)
pnpm storage:check       # sube, lee y borra un objeto de prueba en R2
pnpm dev                 # API en 127.0.0.1:8787 · worker · panel en http://localhost:5173
```
En otra terminal, con `pnpm dev` corriendo:
```bash
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
pnpm llm:smoke                                       # una llamada corta a la CLI de Claude con datos inventados
```
En el panel, el detalle de cada propiedad tiene la sección **Contenido**: preparar, el avance, la vista previa por canal (carrusel, caption, reel, Portal y Marketplace) con su revisión editorial y la edición de los textos.

Conectar Instagram y publicar (F3), con `pnpm dev` corriendo. La cuenta se conecta con el token del botón **Generate token** del panel de Meta (copiado al portapapeles); las variables `INSTAGRAM_*` solo las necesita el OAuth, que llega en F7:
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
- **`PUBLISH_MODE=dry-run` por defecto:** no se publica nada de verdad. En `live` se ve en rojo en el panel y la CLI.
- **La cola la inicializa el worker:** la primera vez aparece con error hasta que el worker arranca (lo hace `pnpm dev`); refresca el panel.
- **Detén `pnpm dev` al terminar** (Ctrl+C): el worker y el panel mantienen Neon despierto y consumen las horas del plan gratis.
- **Antes de cada commit, `pnpm check`** (lint, tipos y tests). La CI lo exige para hacer merge a `main`.

## Documentación
Empieza por `docs/00-vision.md` y `docs/01-arquitectura.md`. Las decisiones están en `docs/adr/` y los planes por fase en `docs/specs/`. Para el operador: `docs/07-checklist-cuentas.md` (trámites) y `docs/08-guia-operador.md` (cómo trabajar con Claude Code).

## Cómo se desarrolla
Con Claude Code, siguiendo `CLAUDE.md`: spec por fase → una tarea por rama y PR → revisión → cierre de fase con tag.
