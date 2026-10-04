# 08 · Guía del operador: cómo trabajar con Claude Code en este proyecto

Esta guía es para ti (Vinny), no para Claude. Explica el ciclo de trabajo, los comandos de git que vas a usar y los hábitos que mantienen el proyecto ordenado.

## El rol de cada uno
- **Tú:** product owner y líder técnico. Apruebas specs y planes, respondes preguntas de producto, haces los trámites de cuentas, pruebas las demos y haces el merge de los PRs.
- **Claude Code:** desarrollador. Planifica tareas, implementa, testea, documenta y hace commits en ramas.
- **Subagentes:** `arquitecto` cuida el diseño, `revisor` revisa el código antes del PR e `integraciones` investiga APIs externas.

## Ciclo de trabajo

```
Fase:   /fase-plan N ──► (tareas) ──► /fase-cerrar N ──► tag
Tarea:  /estado ─► /tarea FN-TXX ─► apruebas el plan ─► implementa + tests
        ─► /revisar ─► push + PR ─► revisas en GitHub ─► merge ─► /clear
```

### Una sesión típica (30 a 90 minutos)
1. Abre la terminal en la carpeta del proyecto y ejecuta `claude`.
2. `/estado` → te dice dónde vas y qué sigue.
3. `/tarea F0-T01` (o la que indique `/estado`).
4. Claude presenta un **plan**. Léelo. Si algo no te calza, dilo antes de aprobar: es el momento más barato para corregir.
5. Claude implementa. Aprueba o rechaza los permisos que te pida (git push, migraciones, etc.).
6. `/revisar` → corrige lo bloqueante.
7. Pide a Claude hacer push y abrir el PR, o hazlo tú (ver git abajo).
8. En GitHub: mira el PR, espera el check verde de CI y haz **Squash and merge**.
9. En la terminal: `git switch main && git pull`.
10. `/clear` antes de la siguiente tarea (contexto limpio = mejores resultados).

## Git: los comandos que vas a usar

```bash
git status                       # qué cambió
git switch main && git pull      # volver a main actualizado
git switch -c feat/f0-t01-...    # nueva rama (Claude lo hace en /tarea)
git log --oneline -10            # últimos commits
git push -u origin <rama>        # subir la rama
gh pr create --fill              # abrir el PR (requiere GitHub CLI: gh auth login)
git tag -a v0.0.1 -m "F0"        # marcar el cierre de fase
git push origin --tags
```

Reglas: `main` solo recibe cambios por PR; una rama por tarea; nunca `--force` sobre `main`.

## Atajos útiles de Claude Code
- **Shift+Tab**: cambia de modo; incluye el **modo plan**, en el que Claude solo analiza y no edita. Útil para preguntas de diseño.
- `/clear`: contexto nuevo. Úsalo entre tareas.
- `/context`: cuánto contexto está ocupado.
- `/agents`: ver y editar subagentes.
- `claude -c`: retomar la última conversación.
- Escribe `/` para ver las skills del proyecto (`estado`, `tarea`, `revisar`, `adr`, `fase-plan`, `fase-cerrar`).

## Hábitos que marcan la diferencia
- **No saltarse el spec.** Si se te ocurre una funcionalidad nueva, anótala en el backlog del roadmap; no la metas a mitad de una tarea.
- **Tareas chicas.** Si una tarea se alarga más de una sesión, pide partirla.
- **Lee los diffs de los PRs**, aunque sea por encima. Es la mejor forma de aprender el código.
- **Cuando Claude se equivoca de forma recurrente**, no lo corrijas solo en el chat: agrega la regla a `CLAUDE.md` o a la skill correspondiente.
- **Decisiones → ADR.** Si discutes una alternativa por más de 5 minutos, merece `/adr`.
- **Demo al cerrar cada fase.** Si no puedes demostrarla, no está terminada.

## Qué hacer cuando…
| Situación | Acción |
|---|---|
| Claude propone algo fuera del spec | "Fuera de alcance; anótalo en el backlog del roadmap" |
| `pnpm check` falla y no se arregla | Pídele diagnosticar la causa raíz antes de intentar más cambios; si persiste, `/clear` y retoma con `/tarea` |
| Una API externa no se comporta como dice el doc | Pide al subagente `integraciones` verificar y actualizar las notas; luego ajusta el spec |
| Quieres cambiar el stack o un patrón | `/adr "..."` primero, código después |
| Perdiste el hilo entre sesiones | `/estado` |
| Quieres preparar el contenido de una propiedad | Con `pnpm dev` corriendo: `pnpm -s cli prepare P001` (espera y muestra la revisión), y después `pnpm -s cli content P001` para leer los textos (`--platform portal` para uno solo). Con `LLM_PROVIDER=fake` en `.env` no gasta cuota |
| `prepare` dice `CONTENT_EDITED` | Editaste textos a mano y prepararlos de nuevo los reemplazaría: usa `--no-texts` para rehacer solo las imágenes, o `--replace-edits` si quieres textos nuevos |
| `prepare` dice "Sigue en cola" | El worker no está corriendo: levanta `pnpm dev` (la corrida espera en cola y arranca sola) |
| Una corrida de contenido falla con `LLM_AUTH_REQUIRED` | La CLI de Claude perdió la sesión: abre `claude`, usa `/login` y prepara de nuevo. `pnpm -s cli doctor` muestra si tiene sesión |
| `doctor` marca ffmpeg o ffprobe en rojo, o una corrida falla con `MEDIA_TOOL_NOT_INSTALLED` | Falta ffmpeg o es anterior a 8.1 (no arma las fotos HEIC del iPhone): `brew install ffmpeg` o `brew upgrade ffmpeg`. Si está en otra ruta, ajusta `FFMPEG_PATH` y `FFPROBE_PATH` en `.env` |
| `doctor` marca Chromium en rojo, o una corrida falla con `RENDER_BROWSER_NOT_INSTALLED` | Falta el Chromium que pide la versión de Playwright del proyecto (pasa también al actualizarlo): `pnpm --filter @agentsales/media exec playwright install chromium` |
| Quieres ver cómo redacta la IA sin tocar la base | `pnpm eval:content` en tu terminal: evalúa las propiedades listas de `agentsales-pruebas` con tu CLI de Claude (descuenta del plan), muestra la revisión por canal y deja los textos en `tmp/eval/<fecha>/`. Termina con error si algún texto tiene errores. `--provider fake` prueba el comando sin gastar cuota. Ctrl+C corta la llamada en curso y no sigue con las demás |
| Quieres comprobar que la CLI de Claude responde | `pnpm llm:smoke` en tu terminal: una llamada corta con datos inventados (descuenta del plan) |
