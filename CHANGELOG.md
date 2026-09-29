# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versiones por fase (ver `docs/06-roadmap.md`).

## [Sin publicar]
### Añadido
- Documentación inicial: visión, arquitectura, modelo de datos, plataformas, formato de publicaciones, convenciones, roadmap y checklist de cuentas.
- ADRs 0001 a 0006.
- Specs F0 (aprobado) y F1 (borrador).
- Configuración de Claude Code: `CLAUDE.md`, skills del flujo de trabajo y subagentes.
- Plantilla Excel de propiedades.

### Cambiado
- Proyecto renombrado a **AgentSales** (paquetes `@agentsales/*`, CLI `agentsales`). El bucket de R2 se llama `agentsales-media`.
- Supabase reemplazado por Neon (Postgres) + Cloudflare R2 (archivos); nuevo ADR-0007 y guía de alta `docs/09-alta-neon-r2.md`.
