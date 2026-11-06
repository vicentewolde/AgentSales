# ADR-0040 · La API de modelos de Meta, detrás de un puerto

- **Estado:** propuesto
- **Fecha:** 2026-11-06
- **Contexto:** Aval usó Muse Spark (texto y herramientas), SAM 3.1 (segmentación de video) y Muse Voice. AgentSales ya tiene el puerto `LlmProvider` con la CLI de Claude y la API de Anthropic.

## Decisión

- El registro habla con modelos solo por `ModelClient` (`packages/registry/src/ports/model.ts`). El adaptador de Meta se escribe en el lote 2 y se enchufa por configuración.
- Se aplican los mismos topes de gasto por corredor que a la IA de AgentSales y la misma regla: **las pruebas no llaman APIs reales**.
- Si se quiere usar Claude para lo mismo, se escribe otro adaptador; el registro no cambia.

## Consecuencias

- Cambiar de proveedor no toca la lógica de verificación.
- Las claves de Meta se guardan como cualquier secreto del proyecto (nunca en el repo ni en el chat).
