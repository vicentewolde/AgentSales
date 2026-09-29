---
name: estado
description: Resume en qué fase y tarea va el proyecto, qué hay sin commitear y cuál es el siguiente paso. Usar al abrir cada sesión.
disable-model-invocation: true
allowed-tools: Read Grep Glob
---

# /estado — ¿Dónde estamos?

Contexto del repositorio:
- Rama actual: !`git branch --show-current`
- Cambios sin commitear: !`git status --short`
- Últimos commits: !`git log --oneline -8`

Pasos:
1. Lee `docs/ESTADO.md`.
2. Lee el spec de la fase actual (`docs/specs/fase-N-*.md`), solo la sección de tareas y los criterios de aceptación.
3. Contrasta: ¿la rama y los commits coinciden con lo que dice ESTADO? Si no (tarea hecha pero no marcada, rama huérfana, cambios sin commitear), señálalo.

Responde en español, breve, con este formato:

**Fase:** FN · nombre — X de Y tareas terminadas
**Rama actual:** … (limpia / con cambios sin commitear)
**Última tarea:** …
**Siguiente paso recomendado:** `/tarea FN-TXX` — título, en una línea
**Pendientes del operador:** solo los que bloquean el siguiente paso
**Inconsistencias:** solo si las hay

No modifiques archivos en este comando.
