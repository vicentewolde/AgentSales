---
name: revisar
description: Revisión de código del trabajo en la rama actual frente al spec, las convenciones y las reglas de seguridad, usando el subagente revisor.
argument-hint: "[id-tarea opcional]"
disable-model-invocation: true
---

# /revisar — Revisión de la rama actual

Contexto:
- Rama: !`git branch --show-current`
- Archivos cambiados respecto a main: !`git diff --stat main...HEAD`

## Pasos
1. Identifica la tarea o el lote (argumento `$ARGUMENTS`, o el nombre de la rama: `f4-t21-t22` son dos) y su sección en el spec; en un lote, los criterios de cada tarea.
2. Delega en el subagente **`revisor`**, pasándole:
   - los ids de las tareas y la ruta del spec,
   - que revise `git diff origin/main...HEAD` completo (main local puede estar atrasado),
   - que corra `pnpm check`.
3. Si el cambio toca contratos entre paquetes, esquema de base de datos o la estructura de apps y paquetes, delega en paralelo en **`arquitecto`** para la coherencia con los ADRs.
4. Presenta los hallazgos consolidados, sin duplicados, en tres grupos:
   - 🔴 **Bloqueantes:** hay que arreglarlos antes del PR
   - 🟡 **Importantes:** arreglar ahora o crear deuda anotada en ESTADO
   - 🟢 **Sugerencias**
5. Pregunta al operador cuáles corregir. Corrige solo esos, vuelve a correr `pnpm check` y haz commit (`fix(...)` o `refactor(...)`).

No hagas push ni merge desde este comando.
