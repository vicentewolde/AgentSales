# Spec F0 · Fundaciones

- **Estado:** Aprobado (listo para comenzar)
- **Rama base:** `main`
- **Tag al cerrar:** `v0.0.1`
- **Referencias:** `docs/01-arquitectura.md`, `docs/02-modelo-datos.md`, `docs/05-convenciones.md`, ADR 0001, 0002, 0003 y 0005

## 1. Objetivo
Tener el esqueleto completo funcionando: monorepo que compila y testea, base de datos con el esquema v1 en Supabase, API, worker, CLI y panel conectados, y un comando `doctor` que diga si el entorno está sano. Nada de funcionalidad de negocio todavía.

## 2. Alcance
- Monorepo pnpm con tooling (TypeScript, Biome, Vitest).
- `packages/config`: variables de entorno validadas, logger y redactor de secretos.
- `packages/core`: enums de dominio, `AppError` y máquina de estados de publicaciones (pura, con tests).
- `packages/db`: esquema Drizzle completo según `02-modelo-datos.md`, migración inicial y seed de corredor demo.
- `apps/api`: Hono, `/health`, manejo de errores y tipo `AppType` exportado.
- `apps/worker`: pg-boss arrancando, job de prueba y apagado ordenado.
- `apps/cli`: `corredor doctor` y `corredor status`.
- `apps/web`: shell React con página "Estado del sistema".
- CI con GitHub Actions.

## 3. Fuera de alcance
- Importación, IA, medios y publicación (F1 en adelante).
- Autenticación (F7).
- Paquetes `importers`, `llm`, `media`, `templates` y `publishers` (se crean en su fase).

## 4. Diseño

### 4.1 Estructura resultante
```
apps/{api,worker,cli,web}
packages/{config,core,db}
```
Nombres de paquete: `@ia-corredor/<nombre>`. Binario de la CLI: `corredor`.

### 4.2 Scripts raíz (`package.json`)
| Script | Hace |
|---|---|
| `pnpm dev` | Levanta api, worker y web en paralelo |
| `pnpm check` | `biome check` + `tsc -b` + `vitest run` |
| `pnpm test` | vitest en todos los paquetes |
| `pnpm db:generate` | drizzle-kit generate |
| `pnpm db:migrate` | aplica migraciones |
| `pnpm db:seed` | seed idempotente |
| `pnpm setup:storage` | crea el bucket privado `media` si no existe |
| `pnpm cli <args>` | ejecuta la CLI en modo dev (tsx) |

### 4.3 Contratos
- `GET /health` → `200 { status: "ok"|"degraded", publishMode, checks: { db, storage, queue }, version }`. Cada check es `{ ok, latencyMs, error? }`. Responde 200 aunque haya checks fallidos (con `degraded`).
- `corredor doctor`: verifica env, db, storage, cola, `ffmpeg -version`, Chromium de Playwright y `claude --version`. Imprime ✓/✗ por ítem con una sugerencia de arreglo, y sale con código 1 si algo crítico falla. Los ítems que su fase aún no necesita (Playwright, Claude) salen como advertencia, no como error.
- `corredor status`: llama a `/health` y muestra `PUBLISH_MODE` destacado.

### 4.4 Datos
- Migración `0000_init`: todas las tablas y enums de `02-modelo-datos.md`.
- Seed: corredor `demo` con marca de ejemplo. Las `field_definitions` se siembran en F1.

### 4.5 Decisiones
- `tsx` para ejecutar TypeScript en dev; build con `tsc` a `dist/`.
- Web en puerto 5173 con proxy de Vite `/api` → API en 8787.
- El worker y la API comparten `packages/config` y leen el mismo `.env` de la raíz.

## 5. Tareas

### F0-T01 · Esqueleto del monorepo y tooling
- **Depende de:** —
- **Descripción:** `pnpm-workspace.yaml`, `package.json` raíz con scripts, `tsconfig.base.json` (strict, NodeNext, ES2023), `biome.json`, `.nvmrc` (22), `.editorconfig`, `vitest.workspace` o config por paquete.
- **Hecho cuando:**
  - [ ] `pnpm install` y `pnpm check` pasan con el repo vacío de lógica
  - [ ] `docs/ESTADO.md` actualizado

### F0-T02 · packages/config
- **Depende de:** T01
- **Descripción:** esquema zod de todas las variables de `.env.example` (las de fases futuras, opcionales); `loadEnv()` que falla con un mensaje claro indicando qué falta; logger pino con redactor de `token|secret|password|authorization|key`.
- **Hecho cuando:**
  - [ ] Tests: env válida, env inválida (mensaje legible) y redacción de secretos en logs
  - [ ] `PUBLISH_MODE` por defecto es `dry-run`

### F0-T03 · packages/core — base del dominio
- **Depende de:** T01
- **Descripción:** enums (`Platform`, `ListingStatus`, `PublicationStatus`, `Currency`, `Operation`), clase `AppError { code, message, retriable, details }` y máquina de estados de publicaciones según `01-arquitectura.md` (incluido `awaiting_manual_confirm`): `canTransition(from, to)` y `transition(from, to)`, que lanza `AppError("INVALID_TRANSITION")`.
- **Hecho cuando:**
  - [ ] Tests que cubren todas las transiciones válidas y un conjunto de inválidas
  - [ ] Cero dependencias de infraestructura en `core`

### F0-T04 · packages/db — esquema, migración, seed y storage
- **Depende de:** T02, T03
- **Descripción:** esquema Drizzle de todas las tablas (usando los enums de `core`), migración inicial, cliente de base de datos, `db:migrate`, `db:seed` (corredor demo, idempotente) y `setup:storage` (bucket `media` privado).
- **Hecho cuando:**
  - [ ] Migración aplicada en Supabase sin errores
  - [ ] Correr `db:seed` dos veces no duplica
  - [ ] Bucket `media` existe y es privado
  - [ ] `02-modelo-datos.md` coincide con el esquema (actualizar si hubo ajustes)

### F0-T05 · apps/api — Hono y /health
- **Depende de:** T04
- **Descripción:** servidor Hono con logger de requests, manejador global de `AppError` → JSON `{ error: { code, message } }` con status HTTP según el código, `/health` con los 3 checks, y `export type AppType`.
- **Hecho cuando:**
  - [ ] Test de `/health` con dependencias simuladas
  - [ ] `curl localhost:8787/health` funciona contra Supabase real

### F0-T06 · apps/worker — pg-boss
- **Depende de:** T04
- **Descripción:** arranque de pg-boss (crea su esquema), registro de handlers por nombre de job, job `system.ping` que loguea y termina, y apagado ordenado con SIGINT/SIGTERM. Check de cola en `/health` (API) usando pg-boss en modo solo lectura o una consulta al esquema.
- **Hecho cuando:**
  - [ ] Un `system.ping` encolado desde un script de prueba se procesa y se ve en el log
  - [ ] Ctrl+C no deja jobs colgados

### F0-T07 · apps/cli — doctor y status
- **Depende de:** T05
- **Descripción:** commander, cliente RPC `hc<AppType>`, comandos `doctor` y `status` según §4.3, y salida con colores (picocolors).
- **Hecho cuando:**
  - [ ] `pnpm cli doctor` muestra el estado real del entorno
  - [ ] `PUBLISH_MODE` se muestra en rojo si es `live`

### F0-T08 · apps/web — shell del panel
- **Depende de:** T05
- **Descripción:** Vite + React + Tailwind + TanStack Query + React Router; layout con menú (Estado, Propiedades y Publicaciones deshabilitados por ahora); página "Estado del sistema" con `/health`; banner permanente de `PUBLISH_MODE`.
- **Hecho cuando:**
  - [ ] `pnpm dev` levanta todo y la página muestra los checks en vivo
  - [ ] Se ve bien en pantalla de notebook y en móvil

### F0-T09 · CI
- **Depende de:** T01 (idealmente al final)
- **Descripción:** `.github/workflows/ci.yml` que en cada PR y push a `main` corre install con caché de pnpm y `pnpm check`. Los tests no requieren base de datos real.
- **Hecho cuando:**
  - [ ] El PR de esta tarea muestra el check en verde

### F0-T10 · Cierre de fase
- **Depende de:** todas
- **Descripción:** `/fase-cerrar 0`: verificar criterios, README con "cómo levantar", `CHANGELOG.md`, `docs/ESTADO.md` apuntando a F1 y tag `v0.0.1`.

## 6. Criterios de aceptación de la fase
- [ ] Clonar el repo, copiar `.env`, correr `pnpm install && pnpm db:migrate && pnpm db:seed && pnpm dev`, y el panel muestra todo en verde
- [ ] `pnpm cli doctor` pasa (con advertencias permitidas para Playwright y Claude)
- [ ] CI en verde en `main`
- [ ] Documentación coherente con el código

## 7. Plan de demo
1. `pnpm cli doctor`
2. `pnpm dev` → abrir http://localhost:5173 → Estado del sistema en verde
3. Apagar internet → el panel muestra `degraded` sin caerse

## 8. Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| Conexión a Supabase por pooler en modo transacción rompe pg-boss o drizzle-kit | Usar el **Session pooler** (5432) o la conexión directa; documentado en `.env.example` |
| Sobre-ingeniería en el esqueleto | Nada de paquetes que no use esta fase |

## 9. Preguntas abiertas
- (ninguna)

## 10. Registro de cambios del spec
| Fecha | Cambio |
|---|---|
| 2026-09-28 | Versión inicial |
