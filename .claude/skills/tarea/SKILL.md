---
name: tarea
description: Ejecuta una tarea del spec de punta a punta — rama, plan, implementación con tests, verificación, docs y commit.
argument-hint: "[id-tarea o lote, ej. F0-T01 o F4-T21 F4-T22]"
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
- Un **lote** (varias tareas relacionadas, desde 2026-10-09) va en una sola rama y un solo PR; cada tarea conserva sus criterios "Hecho cuando".
- Parte desde `main` actualizado y crea la rama `<tipo>/<id-en-minúsculas>-<resumen-corto>` (ej. `feat/f0-t02-config` o `feat/f4-t21-t22-panel-portal`).
- Marca la tarea como 🔨 en `docs/ESTADO.md`.

## 2. Planificar
Lee los docs que la tarea toca (modelo de datos, plataformas, convenciones, ADRs). Luego presenta al operador:
- Archivos a crear o modificar
- Pasos en orden
- Tests que vas a escribir
- **Sin red:** cómo se comporta la tarea si Neon, R2 o una API externa no responden. Qué ve el operador (un mensaje claro, no un stack trace), que el proceso no se caiga, y que los logs no se inunden (los errores repetidos se resumen, como en el worker de F0-T10)
- Dudas o supuestos

**Espera su OK antes de editar**, salvo que la tarea sea trivial (1–2 archivos sin decisiones) o que el operador haya dado aprobación permanente (la dio el 2026-10-01: aplica tu recomendación y cuéntale después; las preguntas de sus cuentas o de producto sí se hacen).

## 3. Implementar
- En incrementos pequeños; escribe los tests del comportamiento junto con el código (o antes).
- Respeta `docs/05-convenciones.md` y las reglas de seguridad de `CLAUDE.md`, en especial `dry-run` y cero llamadas reales en tests.
- Si descubres que el spec está mal o incompleto: detente, explícalo y propone el cambio al spec antes de seguir.
- Si tomas una decisión estructural, propón un ADR (`/adr`).
- Después de cada `pnpm add`, revisa `git diff pnpm-workspace.yaml`. Si la versión es muy nueva, pnpm 11 agrega por su cuenta `minimumReleaseAgeExclude`, y eso **nunca se acepta**:
  1. Quita la entrada de `pnpm-workspace.yaml`.
  2. Restaura `pnpm-lock.yaml` y el `package.json` afectado (`git checkout -- pnpm-lock.yaml <package.json>`).
  3. Instala la versión anterior que sí tenga la antigüedad mínima (`pnpm add <paquete>@<versión>`) y vuelve a revisar el diff.

## 4. Verificar
- `pnpm check` debe pasar completo, una vez (si solo fallan pruebas por "timed out" de PGlite o del panel, repítelo). Si falla, arréglalo; nunca desactives reglas ni tests para pasar.
- Revisa uno por uno los criterios "Hecho cuando" de la tarea y demuestra cada uno (comando, salida o test).
- **CI:** desde 2026-10-09 no se simula en local: la CI de GitHub corre en un clon limpio, sin `.env` ni artefactos de build, y el merge la exige en verde sobre el último commit. Si falla, lee el log (`gh run view <id> --log-failed`), arréglalo en la rama y vuelve a hacer push. Si falla `db:generate`, falta una migración: genérala y commitéala.

## 5. Documentar
- Actualiza los docs afectados si el comportamiento o los contratos cambiaron.
- En `docs/ESTADO.md`: tarea ✅, última tarea, siguiente paso y notas breves (decisiones, deuda técnica).

## 6. Commit
- Uno o más commits Conventional Commits (tipo y ámbito en inglés, descripción en español).
- **`push`, PR y merge:** desde el 2026-10-01 el operador los autorizó en cada rama sin preguntar, salvo que diga lo contrario. El merge, solo con `CI / check` en verde sobre el último commit.
- El repo es **público**: nada de secretos, `.env`, tokens ni datos reales de clientes en commits, PRs ni capturas.

## 7. Cerrar
Responde al operador con:
1. **Qué se hizo** (3–5 viñetas)
2. **Cómo probarlo** (comandos exactos)
3. **Siguiente paso:** el PR (push con `git push origin <rama>`, por nombre: otra sesión puede usar la carpeta) y `/revisar` con `revisor` y `arquitecto` en paralelo; luego las correcciones y el merge.

**Merge:** `main` está protegida y el merge exige el check `CI / check` en verde sobre el último commit de la rama. Espéralo en segundo plano (`gh run watch` sobre el run del sha exacto del último commit), sin sondear en bucle. Si está en verde, haz el merge; si falla, lee el log, arréglalo en la rama y vuelve a hacer push.
