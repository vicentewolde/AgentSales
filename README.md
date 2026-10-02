# AgentSales

Publica avisos inmobiliarios (y luego productos en general) en Instagram, Portal Inmobiliario y Facebook Marketplace: la IA redacta, procesa fotos y videos, y el sistema publica, programa y hace seguimiento.

> Estado: **F1 · Carga cerrada (`v0.1.0`)**. Siguiente: F2 · Contenido. Ver `docs/ESTADO.md`.

## Requisitos
- Node.js 26 (`.nvmrc`) y pnpm 11 (`npm i -g pnpm@11`; Node 26 ya no trae corepack)
- ffmpeg
- Proyecto de Neon (Postgres) y bucket privado de Cloudflare R2, ambos gratis: `docs/09-alta-neon-r2.md`
- Más adelante: Claude Code con sesión iniciada (F2) y Chromium de Playwright (F5). Hoy `doctor` los muestra como advertencia si faltan.

## Puesta en marcha
```bash
cp .env.example .env     # completar DATABASE_URL, R2_* y APP_ENCRYPTION_KEY (docs/09-alta-neon-r2.md)
pnpm install
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
- **`PUBLISH_MODE=dry-run` por defecto:** no se publica nada de verdad. En `live` se ve en rojo en el panel y la CLI.
- **La cola la inicializa el worker:** la primera vez aparece con error hasta que el worker arranca (lo hace `pnpm dev`); refresca el panel.
- **Detén `pnpm dev` al terminar** (Ctrl+C): el worker y el panel mantienen Neon despierto y consumen las horas del plan gratis.
- **Antes de cada commit, `pnpm check`** (lint, tipos y tests). La CI lo exige para hacer merge a `main`.

## Documentación
Empieza por `docs/00-vision.md` y `docs/01-arquitectura.md`. Las decisiones están en `docs/adr/` y los planes por fase en `docs/specs/`. Para el operador: `docs/07-checklist-cuentas.md` (trámites) y `docs/08-guia-operador.md` (cómo trabajar con Claude Code).

## Cómo se desarrolla
Con Claude Code, siguiendo `CLAUDE.md`: spec por fase → una tarea por rama y PR → revisión → cierre de fase con tag.
