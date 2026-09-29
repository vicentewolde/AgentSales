---
name: fase-plan
description: Redacta o revisa el spec de una fase del roadmap y lo deja aprobado por el operador, antes de escribir código.
argument-hint: "[numero-de-fase]"
disable-model-invocation: true
---

# /fase-plan $ARGUMENTS — Planificar la fase

Objetivo: dejar `docs/specs/fase-$ARGUMENTS-*.md` en estado **Aprobado**, con tareas pequeñas, ordenadas y verificables.

## Pasos

1. **Contexto.** Lee `docs/ESTADO.md`, la sección de la fase en `docs/06-roadmap.md`, los ADRs de `docs/adr/` y los docs relevantes al tema. Si la fase anterior está cerrada, revisa su registro en `CHANGELOG.md` para no repetir trabajo.

2. **Spec.**
   - Si el spec **no existe**, créalo desde `docs/specs/_plantilla.md`.
   - Si **existe en borrador**, revísalo contra lo que ya existe en el código (lee los paquetes reales, no supongas).
   - Si la fase integra una plataforma externa, delega primero en el subagente `integraciones` para verificar la documentación oficial vigente, y usa sus notas.

3. **Tareas.** Cada tarea:
   - Idealmente ≤ medio día de trabajo; si es más grande, pártela.
   - Tiene dependencias explícitas, archivos principales y "Hecho cuando" verificable (con tests).
   - No mezcla capas sin necesidad (ej. no mezclar el adaptador y la UI en la misma tarea).

4. **Revisión de arquitectura.** Pide al subagente `arquitecto` que revise el spec contra los ADRs y `01-arquitectura.md`. Incorpora sus observaciones bloqueantes; lista las demás.

5. **Preguntas al operador.** Todo lo que sea decisión de producto o dependa de sus cuentas o datos va a "Preguntas abiertas". Házselas (máximo 4, concretas, con opciones y tu recomendación) y actualiza el spec con las respuestas.

6. **Aprobación.** Muestra un resumen: objetivo, número de tareas, riesgos principales y ADRs nuevos necesarios. Solo cuando el operador diga que aprueba:
   - Cambia el estado del spec a **Aprobado** y agrega una fila al registro de cambios.
   - Actualiza la tabla de progreso de `docs/ESTADO.md` con las tareas de la fase.
   - Si surgieron decisiones estructurales, propón usar `/adr`.

No escribas código de la aplicación en este comando.
