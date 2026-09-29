---
name: tarea
description: Ejecuta una tarea del spec de punta a punta — rama, plan, implementación con tests, verificación, docs y commit.
argument-hint: "[id-tarea, ej. F0-T01]"
disable-model-invocation: true
---

# /tarea $ARGUMENTS — Ejecutar una tarea

Estado del repositorio:
- Rama actual: !`git branch --show-current`
- Cambios sin commitear: !`git status --short`

## 1. Preparar
- Lee `docs/ESTADO.md` y la sección **$ARGUMENTS** del spec de la fase actual en `docs/specs/`.
- Verifica que sus dependencias estén ✅ en ESTADO. Si no, detente y avisa.
- El spec debe estar **Aprobado**. Si no, detente y sugiere `/fase-plan`.
- Si hay cambios sin commitear que no son de esta tarea, detente y pregunta qué hacer con ellos.
- Parte desde `main` actualizado y crea la rama `<tipo>/<id-en-minúsculas>-<resumen-corto>` (ej. `feat/f0-t02-config`).
- Marca la tarea como 🔨 en `docs/ESTADO.md`.

## 2. Planificar
Lee los docs que la tarea toca (modelo de datos, plataformas, convenciones, ADRs). Luego presenta al operador:
- Archivos a crear o modificar
- Pasos en orden
- Tests que vas a escribir
- Dudas o supuestos

**Espera su OK antes de editar**, salvo que la tarea sea trivial (1–2 archivos sin decisiones).

## 3. Implementar
- En incrementos pequeños; escribe los tests del comportamiento junto con el código (o antes).
- Respeta `docs/05-convenciones.md` y las reglas de seguridad de `CLAUDE.md`, en especial `dry-run` y cero llamadas reales en tests.
- Si descubres que el spec está mal o incompleto: detente, explícalo y propone el cambio al spec antes de seguir.
- Si tomas una decisión estructural, propón un ADR (`/adr`).

## 4. Verificar
- `pnpm check` debe pasar completo. Si falla, arréglalo; nunca desactives reglas ni tests para pasar.
- Revisa uno por uno los criterios "Hecho cuando" de la tarea y demuestra cada uno (comando, salida o test).

## 5. Documentar
- Actualiza los docs afectados si el comportamiento o los contratos cambiaron.
- En `docs/ESTADO.md`: tarea ✅, última tarea, siguiente paso y notas breves (decisiones, deuda técnica).

## 6. Commit
- Uno o más commits Conventional Commits (tipo y ámbito en inglés, descripción en español).
- No hagas `push` sin pedir permiso.

## 7. Cerrar
Responde al operador con:
1. **Qué se hizo** (3–5 viñetas)
2. **Cómo probarlo** (comandos exactos)
3. **Siguiente paso:** `/revisar`, luego push y PR. Ofrece ejecutar tú `git push -u origin <rama>` y `gh pr create` con título y descripción que enlacen la tarea del spec.
