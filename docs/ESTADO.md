# Estado del proyecto

> Este archivo es la memoria de trabajo entre sesiones. Claude lo lee al empezar y lo actualiza al terminar cada tarea. Mantenerlo corto: el historial detallado vive en git y en `CHANGELOG.md`.

**Actualizado:** 2026-09-29
**Fase actual:** F0 · Fundaciones (`docs/specs/fase-0-fundaciones.md`)
**Última tarea terminada:** F0-T07 · apps/cli
**Siguiente paso:** F0-T08 · apps/web (panel React con la página Estado del sistema)

## Progreso de la fase
| Tarea | Estado | PR |
|---|---|---|
| F0-T01 Esqueleto y tooling | ✅ terminada | [#1](https://github.com/vicentewolde/AgentSales/pull/1) |
| F0-T02 packages/config | ✅ terminada | [#2](https://github.com/vicentewolde/AgentSales/pull/2) |
| F0-T03 packages/core base | ✅ terminada | [#3](https://github.com/vicentewolde/AgentSales/pull/3) |
| F0-T04 packages/db y packages/storage | ✅ terminada | [#4](https://github.com/vicentewolde/AgentSales/pull/4) |
| F0-T05 apps/api | ✅ terminada | [#5](https://github.com/vicentewolde/AgentSales/pull/5) |
| F0-T06 apps/worker | ✅ terminada | [#6](https://github.com/vicentewolde/AgentSales/pull/6) |
| F0-T07 apps/cli | ✅ terminada | [#7](https://github.com/vicentewolde/AgentSales/pull/7) |
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
- 2026-09-29 (F0-T05): `@agentsales/api` (Hono en `127.0.0.1:8787`): `/health` con db (`pingDatabase`), storage (`head`) y cola (pendiente de T06, por eso `degraded`); errores `{ error: { code, message } }` con tabla código→HTTP; logger de requests (`/health` en debug); Host permitidos y CSRF; apagado ordenado e idempotente. `pnpm dev` levanta las apps en paralelo. Verificado contra Neon y R2 reales.
- 2026-09-29 (F0-T06): `@agentsales/worker` con pg-boss 12 (esquema `pgboss` creado en Neon), registro de handlers por nombre y `system.ping`; apagado ordenado que espera los jobs en curso (verificado: job de 5 s terminado tras SIGINT, `completed` en la base). `/health` ya responde `ok` con la cola. **Apagar el worker al terminar de desarrollar** (mantiene Neon despierto). Tras la revisión: `defineJob` (zod + política por cola), `batchSize: 1`, errores no reintentables sin reintento y arranque interrumpible.
- 2026-09-29 (F0-T07): `@agentsales/cli` (`agentsales doctor` y `status`) con commander, picocolors y el cliente `hc<AppType>`. `doctor` revisa Node, `.env` (sin valores), `PUBLISH_MODE`, API, base, almacenamiento y cola (desde `/health`), ffmpeg, Chromium y Claude; verificado con y sin la API levantada. `PUBLISH_MODE=live` en rojo (probado en tests, sin tocar `.env`). Tras la revisión: el modo sale de la API (y si no coincide con `.env` es error), `/health` se valida con zod y hay errores claros (ECONNREFUSED, timeout, `CODE: mensaje`).
- Deuda F0-T05: el timeout de `/health` no cancela el check (una consulta colgada sigue ocupando el pool de 5); si molesta, pasar un `AbortSignal` a `HealthCheck`. Pendientes de F1 anotados en su spec (registro de cambios).
- Deuda F0-T04: en T09 (CI) comprobar que `pnpm db:generate` no produce cambios (esquema y migraciones sincronizados).
  - F1-T04: ampliar `MediaStorage` con streams (videos grandes) y migración `0001` con los únicos de `field_definitions` y `media` (ya anotado en el spec F1).
  - r2.dev deshabilitado en el bucket: verificado a mano por el operador (2026-09-29).
- Deuda F0-T02:
  - F3: derivar la clave con HKDF-SHA256 desde `APP_ENCRYPTION_KEY` al implementar el cifrado de tokens.
  - F2: exigir `ANTHROPIC_API_KEY` cuando `LLM_PROVIDER=anthropic-api`.
  - F5: resolver `BROWSER_PROFILES_DIR` contra la raíz del workspace.
  - El redactor oculta cualquier clave con `key` (por ejemplo `objectKey` de S3); usar nombres como `objectPath` en logs.
  - Solo los puntos de entrada (apps y `src/scripts/*`) llaman a `loadEnvFile()` y `loadEnv()`; `db` y `storage` reciben opciones concretas (Biome lo exige), y `apps/web` solo importa tipos de config.
- Se creó la documentación base, 6 ADRs, los specs F0 (aprobado) y F1 (borrador), y la configuración de Claude Code.
