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
- `claude -p` es más lento que la API y depende de tener la CLI instalada y autenticada: `agentsales doctor` lo verifica.
- Pasar a producción es cambiar una variable, no el código.

## Alternativas descartadas
- **Solo API desde el inicio:** tiene costo desde el día 1, sin beneficio técnico en la fase local.
- **Agent SDK con login de claude.ai en un producto para terceros:** no permitido por los términos.

## Seguimiento
- 2026-10-02 (`/fase-plan 2`):
  - Los prompts pasan de `packages/llm/prompts/` a core, junto con el esquema de salida, el ensamblado y la revisión editorial (ADR-0013). `packages/llm` queda como transporte.
  - El puerto cambia: recibe `system`, `prompt`, el JSON Schema (sin topes) y un `AbortSignal`, y devuelve `{ data: unknown, model }`; core valida con zod. Sin imágenes en F2 (spec F2, §4.5).
  - `claude-cli` no usa `--bare` (exige `ANTHROPIC_API_KEY` y no usa el login del plan), corre con `--safe-mode`, sin herramientas, en un directorio vacío y con un entorno mínimo **sin** `ANTHROPIC_API_KEY`: con la clave en el entorno, la CLI cobraría por API (`docs/integraciones/claude-code-cli.md`).
  - `anthropic-api` es un stub en F2 (`LLM_NOT_CONFIGURED`), y el entorno exige `ANTHROPIC_API_KEY` si se elige.
  - Los términos siguen vigentes: el login de claude.ai es solo para uso propio del operador.
