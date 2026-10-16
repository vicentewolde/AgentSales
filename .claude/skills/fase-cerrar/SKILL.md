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

2. **Preparar la demo.** Antes de verificar y de mostrar nada, revisa que el entorno no tenga tropiezos ajenos a la fase (en F6 costaron media demo). Avisa antes de `pnpm dev` y apágalo al terminar:
   - **Migraciones:** compara las de `packages/db/drizzle/` con las aplicadas en Neon; si falta alguna, `pnpm db:migrate` (el worker falla sin ella).
   - **Restos en vivo de fases anteriores:** con `pnpm -s cli agenda` y `pnpm -s cli publications <id>` de las propiedades de la demo, busca publicaciones en vivo fallidas o a medias. Bloquean la simulación (`PUBLISH_MODE_LOCKED`); descartarlas es decisión del operador: pregúntale.
   - **Datos del corredor y de las propiedades:** que tengan lo que pide cada paso del plan de demo (por ejemplo, el WhatsApp para Portal: `pnpm -s cli approve <id> --platform portal` dice lo que falta) y textos aprobados donde hagan falta.
   - **Cuentas y herramientas:** `pnpm -s cli accounts` (conectadas y vigentes) y `pnpm -s cli doctor`.
   - Lo que no se pueda arreglar sin el operador va en una lista corta antes de empezar, con tu recomendación (ej. cubrir ese paso con las pruebas).

3. **Verificación.** Para cada criterio de aceptación del spec y del roadmap:
   - Ejecuta el comando o test que lo demuestra y muestra la evidencia.
   - Márcalo `[x]` solo si quedó demostrado.
   - Los que requieren acción humana (ej. ver un post en Instagram) déjalos como checklist para el operador.

4. **Demo.** Entrega el "Plan de demo" del spec como pasos exactos para que el operador lo ejecute, y espera su confirmación.

5. **Coherencia.** Delega en el subagente `arquitecto` una auditoría de desviación entre docs y código (modelo de datos, contratos, estructura). Corrige los docs desactualizados en una rama `docs/fN-cierre`.

6. **Registro.**
   - `CHANGELOG.md`: mueve lo de "Sin publicar" a `[vX.Y.0] - fecha`, con lo añadido, cambiado y corregido desde la perspectiva del operador.
   - Spec: estado **Cerrado**, más una fila en el registro de cambios.
   - `docs/ESTADO.md`: fase siguiente, tabla de progreso reiniciada y siguiente paso `/fase-plan N+1`.
   - `README.md`: actualiza la sección de puesta en marcha si cambió.

7. **Tag.** Los cambios del cierre entran a `main` por PR (la rama está protegida y exige el check `check` de la CI). Después del merge, desde `main` actualizado, propón los comandos y ejecútalos solo con permiso, con la versión del roadmap (F0 → `v0.0.1`, F1 → `v0.1.0`, …):
   ```bash
   git tag -a vX.Y.Z -m "FN · <nombre>"
   git push origin vX.Y.Z
   ```

8. **Retro breve.** Tres líneas: qué funcionó, qué no, y qué cambiar en la próxima fase. Si algo afecta la forma de trabajar, propón editar `CLAUDE.md` o las skills.
