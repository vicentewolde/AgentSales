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
- **Sin red:** cómo se comporta la tarea si Neon, R2 o una API externa no responden. Qué ve el operador (un mensaje claro, no un stack trace), que el proceso no se caiga, y que los logs no se inunden (los errores repetidos se resumen, como en el worker de F0-T10)
- Dudas o supuestos

**Espera su OK antes de editar**, salvo que la tarea sea trivial (1–2 archivos sin decisiones).

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
- `pnpm check` debe pasar completo. Si falla, arréglalo; nunca desactives reglas ni tests para pasar.
- Revisa uno por uno los criterios "Hecho cuando" de la tarea y demuestra cada uno (comando, salida o test).
- **Simulación de la CI** antes de proponer el PR: en un clon limpio de la rama en el scratchpad, sin `.env`, `node_modules` ni artefactos de build locales (`*.tsbuildinfo`, `dist`). En F0 esto destapó los tipos de Node filtrados a la web, que la caché local ocultaba. Como clona lo commiteado, se corre después del commit (paso 6) y se repite si agregas commits. Cada paso corta si falla; no uses pipes (`| tail`, `| grep`) que oculten el código de salida:
  ```bash
  set -euo pipefail
  clon="<scratchpad>/ci-<rama>"
  rm -rf "$clon"
  git clone --quiet --branch <rama> --single-branch "$(git rev-parse --show-toplevel)" "$clon"
  cd "$clon"
  pnpm install --frozen-lockfile
  pnpm check
  pnpm db:generate
  test -z "$(git status --porcelain packages/db/drizzle)"
  pnpm --filter @agentsales/web build
  ```
  Si `db:generate` deja cambios en `packages/db/drizzle`, falta una migración: genérala y commitéala en la rama.

## 5. Documentar
- Actualiza los docs afectados si el comportamiento o los contratos cambiaron.
- En `docs/ESTADO.md`: tarea ✅, última tarea, siguiente paso y notas breves (decisiones, deuda técnica).

## 6. Commit
- Uno o más commits Conventional Commits (tipo y ámbito en inglés, descripción en español).
- Después del commit, corre la simulación de la CI del paso 4.
- **`push`, PR y merge solo con autorización explícita del operador para esta rama.** Un permiso anterior no sirve para otra rama.
- El repo es **público**: nada de secretos, `.env`, tokens ni datos reales de clientes en commits, PRs ni capturas.

## 7. Cerrar
Responde al operador con:
1. **Qué se hizo** (3–5 viñetas)
2. **Cómo probarlo** (comandos exactos)
3. **Siguiente paso:** `/revisar`, luego push y PR. Ofrece ejecutar tú `git push -u origin <rama>` y `gh pr create` con título y descripción que enlacen la tarea del spec, y espera su autorización.

**Merge:** `main` está protegida y el merge exige el check `CI / check` en verde sobre el último commit de la rama. Revísalo con el estado del PR (`gh pr checks <n>` o `gh pr view <n> --json statusCheckRollup`), una vez cuando el operador lo pida, sin sondear en bucle. Si está en verde, haz el merge solo con su autorización explícita; si falla, lee el log, arréglalo en la rama y vuelve a simular la CI.
