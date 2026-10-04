# CLAUDE.md — AgentSales

Sistema que toma avisos (propiedades hoy, productos después) con fotos y videos, redacta el contenido con IA, procesa los medios y los publica en Instagram, Portal Inmobiliario y Facebook Marketplace, con aprobación, calendario y seguimiento. Proyecto personal de Vinny (operador) para aprender y luego ofrecer a corredores independientes.

## Al empezar cada sesión
1. Lee `docs/ESTADO.md`: fase actual, última tarea y siguiente paso.
2. Lee el spec de la fase en curso: `docs/specs/fase-N-*.md`.
3. Si la tarea toca un área, lee el doc correspondiente (mapa abajo) **antes** de escribir código.

## Mapa de documentación
| Doc | Cuándo leerlo |
|---|---|
| `docs/00-vision.md` | Alcance, qué está fuera del MVP |
| `docs/01-arquitectura.md` | Paquetes, flujos, máquina de estados, contratos Publisher y LLM |
| `docs/02-modelo-datos.md` | Cualquier cambio de base de datos |
| `docs/03-plataformas.md` | Cualquier integración externa |
| `docs/04-formato-publicaciones.md` | Prompts, plantillas y textos |
| `docs/05-convenciones.md` | Estilo, tests y git (reglas obligatorias) |
| `docs/06-roadmap.md` | Fases y criterios de aceptación |
| `docs/07-checklist-cuentas.md` | Trámites que hace el operador, no tú |
| `docs/adr/` | Decisiones tomadas; no las contradigas sin un ADR nuevo |

## Stack (resumen; detalle en 05-convenciones)
Node 26 · pnpm 11 workspaces · TypeScript 7 strict · Hono (+ cliente RPC `hc`) · React + Vite + Tailwind + TanStack Query + React Router · Drizzle + `pg` + Neon (Postgres) · Cloudflare R2 (archivos, API S3) · pg-boss · exceljs + yauzl (xlsx y zip) · commander + picocolors (CLI) · sharp · ffmpeg · Playwright · zod · Vitest (+ PGlite para los repositorios) · Biome · pino.

## Estructura
```
apps/     api · worker · cli · web
packages/ config · core · db · storage · queue · importers  (desde F2+: llm · media · templates · publishers)
docs/     documentación, specs y ADRs
data/     plantillas (en git) y muestras (fuera de git)
```
`packages/core` no depende de infraestructura. Las apps componen adaptadores y llaman casos de uso.

## Comandos
```bash
pnpm dev                 # api + worker + web (apágalo al terminar: mantiene Neon despierto)
pnpm check               # lint + typecheck + tests (obligatorio antes de commit)
pnpm lint | pnpm format  # Biome (revisar | corregir)
pnpm typecheck           # tsc -b
pnpm test                # solo tests
pnpm db:generate         # generar migración tras cambiar el esquema
pnpm db:migrate          # aplicar migraciones
pnpm db:seed             # seeds idempotentes
pnpm storage:check       # verifica acceso al bucket de R2
pnpm -s cli doctor       # salud del entorno (con pnpm dev corriendo)
pnpm -s cli status       # /health y PUBLISH_MODE (con pnpm dev corriendo)
pnpm worker:ping         # encola un job de prueba (con el worker corriendo)
pnpm llm:smoke           # una llamada real y corta a la CLI de Claude con datos inventados (gasta cuota; la corre el operador)
pnpm eval:content        # evalúa el prompt sobre las propiedades listas de agentsales-pruebas, sin escribir en la base (--broker <slug>; --provider fake no gasta cuota; con claude-cli lo corre el operador)
pnpm -s cli import <xlsx> --media <carpeta|zip>  # carga propiedades (con pnpm dev corriendo; --dry-run simula)
pnpm -s cli listings     # propiedades cargadas (detalle: cli listing <id>; historial: cli imports)
pnpm -s cli prepare <id_propiedad>  # prepara fotos, portada, reel y textos y espera (con pnpm dev; --no-texts, --replace-edits, --no-wait)
pnpm -s cli content <id_propiedad>  # textos por canal con su revisión (--platform instagram|portal|marketplace, --json)
```
(Los comandos existen desde F0; si alguno falta, la tarea que lo introduce debe crearlo.)

## Glosario (español → código)
corredor → `Broker` · propiedad/aviso → `Listing` · medio (foto/video) → `Media` · texto generado → `Content` · publicación (aviso × plataforma) → `Publication` · cuenta conectada → `PlatformAccount` · campo configurable → `FieldDefinition` · carga → `ImportRun`.

## Reglas de trabajo (obligatorias)
1. **Spec primero.** No implementes nada que no esté en el spec aprobado de la fase. Si falta algo, propónlo y actualiza el spec antes.
2. **Una tarea a la vez**, en su propia rama `<tipo>/<id-tarea>-<resumen>`, con commits Conventional Commits.
3. **Planifica antes de editar:** para tareas de más de un archivo, presenta el plan (archivos, pasos, tests) y espera el OK del operador.
4. **Tests con el código:** el caso de uso o adaptador nuevo viene con sus tests en el mismo commit. Nunca debilites un test para que pase.
5. **`pnpm check` en verde** antes de dar una tarea por terminada.
6. **Documentación viva:** si el código cambia algo documentado, actualiza el doc en el mismo PR. Al terminar la tarea, actualiza `docs/ESTADO.md`.
7. **Decisiones estructurales → ADR** (`/adr`). No cambies stack, patrones ni contratos en silencio.
8. **Dependencias:** solo las del stack. Una nueva requiere justificación en el PR.
9. **Si algo es ambiguo, pregunta.** Mejor una pregunta que una suposición cara.

## Reglas de seguridad (no negociables)
- `PUBLISH_MODE=dry-run` por defecto. **Nunca** cambies a `live` ni publiques de verdad sin instrucción explícita del operador en el chat.
- Ningún test llama APIs reales de Instagram, Mercado Libre, Facebook ni Anthropic. Usa msw o fakes.
- No leas, muestres ni commitees `.env`. No loguees tokens ni secretos.
- No subas datos reales de clientes (`data/muestras/`) a git.
- Marketplace: nunca automatices el clic final, ni resuelvas o evadas captchas o verificaciones.
- Nunca `git push --force` a `main` ni reescribas su historia.

## Reglas editoriales de la IA (resumen)
Solo datos entregados; nunca inventar. Respetar `show_exact_address`. Precio con formato chileno (`UF 5.800`, `$650.000`). Sin requisitos discriminatorios. Detalle completo en `docs/04-formato-publicaciones.md`.

## Flujo con skills del proyecto
- `/estado` — dónde estamos y qué sigue (usar al abrir sesión).
- `/fase-plan N` — redactar o revisar el spec de la fase N.
- `/tarea FN-TXX` — ejecutar una tarea del spec de punta a punta.
- `/revisar` — revisión del diff actual con el subagente `revisor`.
- `/adr "título"` — registrar una decisión.
- `/fase-cerrar N` — verificar criterios, changelog y tag.

Subagentes: `arquitecto` (coherencia con ADRs y diseño), `revisor` (calidad, tests, seguridad), `integraciones` (investiga APIs externas y documenta).

## Definición de terminado (por tarea)
- [ ] Criterios "Hecho cuando" del spec cumplidos
- [ ] Tests nuevos o actualizados, y `pnpm check` en verde
- [ ] Docs afectados actualizados, y `docs/ESTADO.md` al día
- [ ] Commit(s) convencional(es) en la rama de la tarea
- [ ] Resumen al operador: qué cambió, cómo probarlo y siguiente paso
