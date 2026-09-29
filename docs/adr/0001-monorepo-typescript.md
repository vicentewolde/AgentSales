# ADR-0001 · Monorepo TypeScript con pnpm

- **Estado:** Aceptado
- **Fecha:** 2026-09-28

## Contexto
El sistema tiene varias piezas (API, worker, panel web, CLI) que comparten dominio y tipos. El operador ya trabajó con React, TypeScript, Vite y Supabase (MycoTracker) y con TypeScript en otros proyectos. El desarrollo se hace con Claude Code, que rinde mejor con tipos estrictos y una estructura predecible.

## Decisión
- Monorepo con **pnpm workspaces**: `apps/*` y `packages/*`.
- **TypeScript strict** en todo, con Node 22 y ESM.
- **Hono** para la API y su cliente RPC tipado, compartido por web y CLI.
- **Biome** para lint y formato; **Vitest** para tests.
- Sin Turborepo por ahora: los scripts se orquestan con `pnpm -r` y `pnpm --filter`.

## Consecuencias
- Un solo lenguaje y los mismos tipos de punta a punta; los cambios de contrato los detecta el compilador.
- La CLI depende de que la API esté corriendo (aceptado: `pnpm dev` la levanta).
- Si el build se vuelve lento, se evalúa Turborepo con un ADR nuevo.

## Alternativas descartadas
- **Python (FastAPI):** buen ecosistema de medios, pero duplica tipos con el frontend React y es menos familiar.
- **Next.js full-stack:** mezcla UI con workers de larga duración (video, navegador), que no calzan bien en ese modelo.
