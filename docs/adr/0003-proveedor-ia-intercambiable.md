# ADR-0003 · Proveedor de IA intercambiable (Claude CLI ahora, API después)

- **Estado:** Aceptado
- **Fecha:** 2026-09-28

## Contexto
El operador tiene plan Max de Claude y quiere aprovecharlo durante el desarrollo. La documentación de Anthropic indica que, salvo aprobación previa, terceros no pueden ofrecer el login de claude.ai ni sus límites en sus productos (incluidos agentes con el Agent SDK); deben usar API key.

## Decisión
- Puerto `LLMProvider` en `packages/core` con `generateStructured(schema)`.
- Adaptadores en `packages/llm`:
  - `claude-cli`: ejecuta `claude -p` con `--output-format json` como subproceso, autenticado con el plan Max del operador. **Solo uso propio y local.**
  - `anthropic-api`: SDK oficial con `ANTHROPIC_API_KEY`. **Obligatorio en cuanto el sistema lo use alguien más.**
  - `fake`: determinista, para tests.
- Selección con la variable `LLM_PROVIDER`.
- Toda salida se valida con zod; los prompts se versionan y se registra `prompt_version`.

## Consecuencias
- Cero costo de IA durante el piloto propio.
- `claude -p` es más lento que la API y depende de tener la CLI instalada y autenticada: `corredor doctor` lo verifica.
- Pasar a producción es cambiar una variable, no el código.

## Alternativas descartadas
- **Solo API desde el inicio:** tiene costo desde el día 1, sin beneficio técnico en la fase local.
- **Agent SDK con login de claude.ai en un producto para terceros:** no permitido por los términos.
