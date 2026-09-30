# AgentSales

Publica avisos inmobiliarios (y luego productos en general) en Instagram, Portal Inmobiliario y Facebook Marketplace: la IA redacta, procesa fotos y videos, y el sistema publica, programa y hace seguimiento.

> Estado: **F0 · Fundaciones cerrada (`v0.0.1`)**. Siguiente: F1 · Carga. Ver `docs/ESTADO.md`.

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
pnpm db:seed             # crea el corredor demo (se puede repetir)
pnpm storage:check       # sube, lee y borra un objeto de prueba en R2
pnpm dev                 # API en 127.0.0.1:8787 · worker · panel en http://localhost:5173
```
En otra terminal, con `pnpm dev` corriendo:
```bash
pnpm -s cli doctor       # Node, .env, API, base, almacenamiento, cola y herramientas
pnpm -s cli status       # /health y PUBLISH_MODE
pnpm worker:ping         # opcional: encola un job de prueba; el worker loguea "pong"
```
- **`PUBLISH_MODE=dry-run` por defecto:** no se publica nada de verdad. En `live` se ve en rojo en el panel y la CLI.
- **La cola la inicializa el worker:** la primera vez aparece con error hasta que el worker arranca (lo hace `pnpm dev`); refresca el panel.
- **Detén `pnpm dev` al terminar** (Ctrl+C): el worker y el panel mantienen Neon despierto y consumen las horas del plan gratis.
- **Antes de cada commit, `pnpm check`** (lint, tipos y tests). La CI lo exige para hacer merge a `main`.

## Documentación
Empieza por `docs/00-vision.md` y `docs/01-arquitectura.md`. Las decisiones están en `docs/adr/` y los planes por fase en `docs/specs/`. Para el operador: `docs/07-checklist-cuentas.md` (trámites) y `docs/08-guia-operador.md` (cómo trabajar con Claude Code).

## Cómo se desarrolla
Con Claude Code, siguiendo `CLAUDE.md`: spec por fase → una tarea por rama y PR → revisión → cierre de fase con tag.
