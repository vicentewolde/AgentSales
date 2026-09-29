# Estado del proyecto

> Este archivo es la memoria de trabajo entre sesiones. Claude lo lee al empezar y lo actualiza al terminar cada tarea. Mantenerlo corto: el historial detallado vive en git y en `CHANGELOG.md`.

**Actualizado:** 2026-09-29
**Fase actual:** F0 · Fundaciones (`docs/specs/fase-0-fundaciones.md`)
**Última tarea terminada:** F0-T04 · packages/db y packages/storage
**Siguiente paso:** F0-T05 · apps/api (Hono, `/health` y manejador de `AppError`)

## Progreso de la fase
| Tarea | Estado | PR |
|---|---|---|
| F0-T01 Esqueleto y tooling | ✅ terminada | [#1](https://github.com/vicentewolde/AgentSales/pull/1) |
| F0-T02 packages/config | ✅ terminada | [#2](https://github.com/vicentewolde/AgentSales/pull/2) |
| F0-T03 packages/core base | ✅ terminada | [#3](https://github.com/vicentewolde/AgentSales/pull/3) |
| F0-T04 packages/db y packages/storage | ✅ terminada | |
| F0-T05 apps/api | ⏳ pendiente | |
| F0-T06 apps/worker | ⏳ pendiente | |
| F0-T07 apps/cli | ⏳ pendiente | |
| F0-T08 apps/web | ⏳ pendiente | |
| F0-T09 CI | ⏳ pendiente | |
| F0-T10 Cierre | ⏳ pendiente | |

Leyenda: ⏳ pendiente · 🔨 en curso · ✅ terminada · ⛔ bloqueada

## Bloqueos y pendientes del operador
- [x] Sección "Antes de F0" de `docs/07-checklist-cuentas.md` (Neon, R2 y `APP_ENCRYPTION_KEY` según el operador; se verifican en T02 y T04)
- [ ] Iniciar el trámite de la app de Meta (lento, en paralelo)
- [ ] Preparar las 3 propiedades de muestra (necesarias para F1)

## Notas de la última sesión
- 2026-09-29: el proyecto se llama **AgentSales** (antes "IA Corredor"); CLI `agentsales`, paquetes `@agentsales/*`.
- 2026-09-29: se reemplazó Supabase por Neon (Postgres) + Cloudflare R2 (archivos) por el límite de 2 proyectos gratis (ADR-0007). Alta paso a paso en `docs/09-alta-neon-r2.md`.
- 2026-09-29: el runtime pasa de Node 22 a **Node 26** (ADR-0008). Node 26 no trae corepack: pnpm se instala aparte.
- 2026-09-29 (F0-T01): tooling con TypeScript 7 (ADR-0009), Biome 2.5, Vitest 5 y pnpm 11. `tsconfig.json` raíz revisa los `*.ts` de la raíz (`noEmit`); cada paquete nuevo se agrega a sus `references` según la plantilla de `05-convenciones.md`. Vitest usa un único `vitest.config.ts` raíz; `passWithNoTests` se quita en T02.
- 2026-09-29 (F0-T02): `@agentsales/config` con `loadEnv()` (zod; errores con nombres de variable y sin valores), `loadEnvFile()` (usa `process.loadEnvFile` de Node, sin dotenv) y `createLogger()` (pino; redacta claves sensibles, URLs con credenciales, errores y bindings). Los paquetes internos resuelven su fuente con la condición `@agentsales/source` (ADR-0010). El `.env` del operador pasa la validación (verificado con un script que solo imprime nombres de variables).
- 2026-09-29 (F0-T03): `@agentsales/core` con enums como tuplas `as const`, `AppError` y máquina de estados (16 transiciones válidas; se prueban las 100 combinaciones). `config` ya usa `PUBLISH_MODES` y `LLM_PROVIDERS` de `core`: primer import entre paquetes, verificado con `tsc -b` y Vitest sin `dist/` (falta tsx, en T04). Biome permite en `core` solo `zod` e imports relativos. Tras la revisión: estado terminal `cancelled`, grupos `INITIAL/TERMINAL/ACTIVE_PUBLICATION_STATUSES` e `isAppError`; `02-modelo-datos` nombra todos los tipos enum.
- 2026-09-29 (F0-T04): `@agentsales/db` (Drizzle + `pg`, 9 tablas y 12 enums desde `core`, migración `0000_init` aplicada en Neon, seed del corredor `demo` idempotente) y `@agentsales/storage` (R2 vía S3; `storage:check` OK contra el bucket real). Puerto `MediaStorage` en `core`. El cliente fija `sslmode=verify-full`. Imports entre paquetes verificados con `tsc -b`, Vitest, tsx y drizzle-kit sin `dist/`.
- Deuda F0-T04: en T09 (CI) comprobar que `pnpm db:generate` no produce cambios (esquema y migraciones sincronizados).
- Deuda F0-T02:
  - F3: derivar la clave con HKDF-SHA256 desde `APP_ENCRYPTION_KEY` al implementar el cifrado de tokens.
  - F2: exigir `ANTHROPIC_API_KEY` cuando `LLM_PROVIDER=anthropic-api`.
  - F5: resolver `BROWSER_PROFILES_DIR` contra la raíz del workspace.
  - El redactor oculta cualquier clave con `key` (por ejemplo `objectKey` de S3); usar nombres como `objectPath` en logs.
  - Solo las apps llaman a `loadEnvFile()` y `loadEnv()`; `db` y `storage` reciben opciones concretas, y `apps/web` solo importa tipos de config.
- Se creó la documentación base, 6 ADRs, los specs F0 (aprobado) y F1 (borrador), y la configuración de Claude Code.
