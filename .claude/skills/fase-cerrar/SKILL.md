---
name: fase-cerrar
description: Cierra una fase — verifica criterios de aceptación, ejecuta la demo, revisa coherencia docs-código, actualiza changelog y estado, y prepara el tag.
argument-hint: "[numero-de-fase]"
disable-model-invocation: true
---

# /fase-cerrar $ARGUMENTS — Cerrar la fase

Contexto:
- Rama: !`git branch --show-current`
- Cambios sin commitear: !`git status --short`

## Pasos
1. **Precondiciones.** Debes estar en `main`, actualizado y sin cambios pendientes, y todas las tareas de la fase deben estar ✅ en `docs/ESTADO.md` (salvo la de cierre). Si no, lista lo que falta y detente.

2. **Verificación.** Para cada criterio de aceptación del spec y del roadmap:
   - Ejecuta el comando o test que lo demuestra y muestra la evidencia.
   - Márcalo `[x]` solo si quedó demostrado.
   - Los que requieren acción humana (ej. ver un post en Instagram) déjalos como checklist para el operador.

3. **Demo.** Entrega el "Plan de demo" del spec como pasos exactos para que el operador lo ejecute, y espera su confirmación.

4. **Coherencia.** Delega en el subagente `arquitecto` una auditoría de desviación entre docs y código (modelo de datos, contratos, estructura). Corrige los docs desactualizados en una rama `docs/fN-cierre`.

5. **Registro.**
   - `CHANGELOG.md`: mueve lo de "Sin publicar" a `[vX.Y.0] - fecha`, con lo añadido, cambiado y corregido desde la perspectiva del operador.
   - Spec: estado **Cerrado**, más una fila en el registro de cambios.
   - `docs/ESTADO.md`: fase siguiente, tabla de progreso reiniciada y siguiente paso `/fase-plan N+1`.
   - `README.md`: actualiza la sección de puesta en marcha si cambió.

6. **Tag.** Propón los comandos y ejecútalos solo con permiso:
   ```bash
   git tag -a vX.Y.0 -m "FN · <nombre>"
   git push origin main --tags
   ```

7. **Retro breve.** Tres líneas: qué funcionó, qué no, y qué cambiar en la próxima fase. Si algo afecta la forma de trabajar, propón editar `CLAUDE.md` o las skills.
