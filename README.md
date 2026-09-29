# IA Corredor

Publica avisos inmobiliarios (y luego productos en general) en Instagram, Portal Inmobiliario y Facebook Marketplace: la IA redacta, procesa fotos y videos, y el sistema publica, programa y hace seguimiento.

> Estado: **F0 · Fundaciones**. Ver `docs/ESTADO.md`.

## Requisitos
- Node.js 22 LTS y pnpm
- ffmpeg
- Claude Code con sesión iniciada (para generar contenido en local)
- Proyecto de Neon (Postgres) y bucket de Cloudflare R2, ambos gratis (ver `docs/09-alta-neon-r2.md`)

## Puesta en marcha
```bash
cp .env.example .env        # completar valores (ver docs/07-checklist-cuentas.md)
pnpm install
pnpm db:migrate && pnpm db:seed && pnpm storage:check
pnpm cli doctor
pnpm dev                    # API :8787 · panel :5173
```
*(Estos comandos quedan operativos al terminar F0.)*

## Documentación
Empieza por `docs/00-vision.md` y `docs/01-arquitectura.md`. Las decisiones están en `docs/adr/` y los planes por fase en `docs/specs/`. Para el operador: `docs/07-checklist-cuentas.md` (trámites) y `docs/08-guia-operador.md` (cómo trabajar con Claude Code).

## Cómo se desarrolla
Con Claude Code, siguiendo `CLAUDE.md`: spec por fase → una tarea por rama y PR → revisión → cierre de fase con tag.
