# ADR-0039 · Aval se integra como «registro verificable»

- **Estado:** propuesto
- **Fecha:** 2026-11-06
- **Contexto:** Aval se construyó como proyecto aparte para el hackatón de Meta. El operador decidió que sea parte de AgentSales, un solo proyecto inmobiliario. Aval tiene su propio almacén en archivos, su servidor y su interfaz.

## Decisión

1. La lógica de Aval vive en un paquete nuevo, `@agentsales/registry`, **sin infraestructura** salvo `node:crypto`. No va en `core` porque `core` no usa tipos de Node.
2. Lo que toca archivos, `pdftotext`, red o la API de modelos se reescribe como **adaptadores** en lotes posteriores; el paquete expone puertos (`ModelClient`).
3. Los datos pasan del almacén de archivos de Aval a **tablas de Postgres** (migración aditiva, ver el spec de F12).
4. El registro es **un destino de publicación más** («registro»), con estado, bitácora y aprobación como cualquier otra publicación.
5. El repo `vicentewolde/aval` queda **congelado** como referencia del hackatón. Los cambios nuevos se hacen aquí.

## Consecuencias

- Las reglas de AgentSales (spec primero, `pnpm check`, `dry-run`) rigen sobre todo lo que venga de Aval.
- Una dependencia nueva solo con justificación en el PR (para el servidor MCP, `@modelcontextprotocol/sdk`, en el lote 3).
- El registro puede compartir afirmaciones con los textos de la IA (pie verificado), pero no cambia el contrato `Publisher`.
