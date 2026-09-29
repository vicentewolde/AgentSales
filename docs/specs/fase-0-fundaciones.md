# Spec F0 · Fundaciones

- **Estado:** Aprobado (listo para comenzar)
- **Rama base:** `main`
- **Tag al cerrar:** `v0.0.1`
- **Referencias:** `docs/01-arquitectura.md`, `docs/02-modelo-datos.md`, `docs/05-convenciones.md`, ADR 0001, 0002 (solo la parte de Drizzle), 0003, 0005, 0007, 0008, 0009 y 0010

## 1. Objetivo
Tener el esqueleto completo funcionando: monorepo que compila y testea, base de datos con el esquema v1 en Neon, API, worker, CLI y panel conectados, y un comando `doctor` que diga si el entorno está sano. Nada de funcionalidad de negocio todavía.

## 2. Alcance
- Monorepo pnpm con tooling (TypeScript, Biome, Vitest).
- `packages/config`: variables de entorno validadas, logger y redactor de secretos.
- `packages/core`: enums de dominio, `AppError` y máquina de estados de publicaciones (pura, con tests).
- `packages/db`: esquema Drizzle completo según `02-modelo-datos.md`, migración inicial y seed de corredor demo.
- `packages/storage`: archivos en Cloudflare R2 (API S3): subir, leer, borrar, URL prefirmada y comprobación de acceso.
- `apps/api`: Hono, `/health`, manejo de errores y tipo `AppType` exportado.
- `apps/worker`: pg-boss arrancando, job de prueba y apagado ordenado.
- `apps/cli`: `agentsales doctor` y `agentsales status`.
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
packages/{config,core,db,storage}
```
Nombres de paquete: `@agentsales/<nombre>`. Binario de la CLI: `agentsales`.

### 4.2 Scripts raíz (`package.json`)
| Script | Hace |
|---|---|
| `pnpm dev` | Levanta api, worker y web en paralelo |
| `pnpm check` | `biome check` + `tsc -b` + `vitest run` |
| `pnpm lint` | `biome check` (sin corregir) |
| `pnpm format` | `biome check --write` (formato y correcciones seguras) |
| `pnpm typecheck` | `tsc -b` |
| `pnpm test` | vitest en todos los paquetes |
| `pnpm db:generate` | drizzle-kit generate |
| `pnpm db:migrate` | aplica migraciones |
| `pnpm db:seed` | seed idempotente |
| `pnpm storage:check` | sube, lee y borra un objeto de prueba en el bucket de R2 (el bucket lo crea el operador a mano) |
| `pnpm cli <args>` | ejecuta la CLI en modo dev (tsx) |

T01 crea `check`, `lint`, `format`, `typecheck` y `test`. Los demás los agrega la tarea que los introduce: `db:*` y `storage:check` en T04, `dev` en T05–T08 y `cli` en T07.

### 4.3 Contratos
- `GET /health` → `200 { status: "ok"|"degraded", publishMode, checks: { db, storage, queue }, version }`. Cada check es `{ ok, latencyMs, error? }`. Responde 200 aunque haya checks fallidos (con `degraded`).
- `agentsales doctor`: verifica env, db, storage, cola, `ffmpeg -version`, Chromium de Playwright y `claude --version`. Imprime ✓/✗ por ítem con una sugerencia de arreglo, y sale con código 1 si algo crítico falla. Los ítems que su fase aún no necesita (Playwright, Claude) salen como advertencia, no como error. Neon suspende el cómputo tras 5 min sin actividad y la primera conexión puede tardar unos segundos: el check de base de datos usa un timeout de 10 s y un reintento antes de fallar.
- `agentsales status`: llama a `/health` y muestra `PUBLISH_MODE` destacado.

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
- **Descripción:** `pnpm-workspace.yaml`, `package.json` raíz con scripts, `tsconfig.base.json` (strict, NodeNext, ES2023), `biome.json`, `.nvmrc` (26, ADR-0008), `.editorconfig`, `vitest.config.ts` raíz (Vitest 5 ya no tiene `vitest.workspace`; se pasa a `test.projects` cuando un paquete necesite otro entorno, p. ej. web en T08).
- **Hecho cuando:**
  - [x] `pnpm install` y `pnpm check` pasan con el repo vacío de lógica
  - [x] `docs/ESTADO.md` actualizado

### F0-T02 · packages/config
- **Depende de:** T01
- **Descripción:** esquema zod de todas las variables de `.env.example` (las de fases futuras, opcionales); `loadEnv()` que falla con un mensaje claro indicando qué falta; logger pino con redactor de `token|secret|password|authorization|key`.
- **Hecho cuando:**
  - [x] Tests: env válida, env inválida (mensaje legible) y redacción de secretos en logs
  - [x] Se quita `passWithNoTests` de `vitest.config.ts` (primera tarea con tests)
  - [x] `PUBLISH_MODE` por defecto es `dry-run`
  - [x] `DATABASE_URL` con host `-pooler` se rechaza con un mensaje claro (debe ser la conexión directa de Neon, con `sslmode=require`)
  - [x] `APP_ENCRYPTION_KEY` acepta cualquier texto de al menos 32 caracteres y rechaza los más cortos. La derivación de 32 bytes con HKDF-SHA256 se implementa en F3, junto con el cifrado de tokens

### F0-T03 · packages/core — base del dominio
- **Depende de:** T01
- **Descripción:** enums (`Platform`, `ListingStatus`, `PublicationStatus`, `Currency`, `Operation`), clase `AppError { code, message, retriable, details }` y máquina de estados de publicaciones según `01-arquitectura.md` (incluido `awaiting_manual_confirm`): `canTransition(from, to)` y `transition(from, to)`, que lanza `AppError("INVALID_TRANSITION")`.
- **Hecho cuando:**
  - [x] Tests que cubren todas las transiciones válidas y un conjunto de inválidas
  - [x] `core` exporta `PUBLISH_MODES` y `LLM_PROVIDERS`, y `packages/config` los usa en su esquema (`z.enum(PUBLISH_MODES)`) en vez de repetir los literales
  - [x] Cero dependencias de infraestructura en `core`: su tsconfig usa `"types": []` y Biome prohíbe importar `node:*` y librerías de infraestructura en `packages/core/**`

### F0-T04 · packages/db y packages/storage — esquema, migración, seed y R2
- **Depende de:** T02, T03
- **Descripción:** agrega a `core` los enums restantes de `02-modelo-datos.md` con su test (`PLATFORM_ACCOUNT_STATUSES`, `FIELD_TYPES`, `MEDIA_KINDS`, `MEDIA_ROLES`, `CONTENT_STATUSES`, `LISTING_SOURCES`, `CLOSE_REASONS`) y, si `core` empieza a usar `zod`, lo declara como dependencia. Esquema Drizzle de todas las tablas (usando los enums de `core`; el índice único parcial de `publications` excluye `TERMINAL_PUBLICATION_STATUSES`, equivalente a los activos), migración inicial, cliente de base de datos, `db:migrate` y `db:seed` (corredor demo, idempotente). Driver de Postgres estándar (`pg` o `postgres`), no el serverless de Neon. `packages/storage`: cliente S3 hacia Cloudflare R2 (`@aws-sdk/client-s3`, endpoint `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`, región `auto`) con put, get, delete, head y URL prefirmada de lectura (TTL `SIGNED_URL_TTL_SECONDS`), más el script `storage:check`.
- **Hecho cuando:**
  - [x] Migración aplicada en Neon sin errores (conexión directa)
  - [x] Correr `db:seed` dos veces no duplica
  - [x] `pnpm storage:check` sube, lee, genera una URL prefirmada que responde 200 y borra un objeto de prueba en el bucket privado de R2
  - [x] Tests de `storage` con el cliente S3 simulado: la URL prefirmada respeta el TTL configurado
  - [x] `02-modelo-datos.md` coincide con el esquema (actualizar si hubo ajustes)
  - [x] Un import entre paquetes (`@agentsales/db` → `@agentsales/config` y `@agentsales/core`) resuelve al código fuente con `tsc -b`, Vitest y tsx (ADR-0010)

### F0-T05 · apps/api — Hono y /health
- **Depende de:** T04
- **Descripción:** servidor Hono con logger de requests, manejador global de `AppError` (reconocido con `isAppError`, no con `instanceof`) → JSON `{ error: { code, message } }` con status HTTP según una tabla explícita de códigos (`INVALID_TRANSITION` → 409, `*_NOT_FOUND` → 404, `*_INVALID*` → 400; por defecto 500, documentada en `05-convenciones.md`); nunca expone `details` ni `cause` en la respuesta, `/health` con los 3 checks, y `export type AppType`.
- **Hecho cuando:**
  - [ ] Test de `/health` con dependencias simuladas
  - [ ] `curl localhost:8787/health` funciona contra Neon y R2 reales

### F0-T06 · apps/worker — pg-boss
- **Depende de:** T04
- **Descripción:** arranque de pg-boss (crea su esquema), registro de handlers por nombre de job, job `system.ping` que loguea y termina, y apagado ordenado con SIGINT/SIGTERM. Check de cola en `/health` (API) usando pg-boss en modo solo lectura o una consulta al esquema. pg-boss usa la conexión directa de Neon; mientras el worker corre mantiene el cómputo despierto (ADR-0007), así que se apaga cuando no se desarrolla.
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
| Conexión por el pooler de Neon (`-pooler`, modo transacción) rompe pg-boss y drizzle-kit | Usar solo la conexión **directa** (sin `-pooler`); `loadEnv()` la rechaza si detecta el sufijo |
| Arranque en frío de Neon (suspende a los 5 min) hace fallar `/health` o `doctor` | Timeout de 10 s con un reintento; el panel muestra `degraded` sin caerse |
| Worker encendido 24/7 agota las 100 CU-horas mensuales del plan gratis | Encenderlo solo al desarrollar; ver ADR-0007 |
| Sobre-ingeniería en el esqueleto | Nada de paquetes que no use esta fase |

## 9. Preguntas abiertas
- (ninguna)

## 10. Registro de cambios del spec
| Fecha | Cambio |
|---|---|
| 2026-09-28 | Versión inicial |
| 2026-09-29 | Supabase reemplazado por Neon + Cloudflare R2 (ADR-0007); nuevo `packages/storage`; `APP_ENCRYPTION_KEY` libre de formato |
| 2026-09-29 | Runtime Node 26 (ADR-0008) y TypeScript 7 (ADR-0009); Vitest 5 con config raíz; scripts `lint`, `format` y `typecheck`; criterios nuevos en T02 (`passWithNoTests`) y T03 (`core` sin tipos de Node) |
| 2026-09-29 | T02: HKDF de `APP_ENCRYPTION_KEY` se mueve a F3 (donde se cifra); `exports` con condición `@agentsales/source` (ADR-0010) |
| 2026-09-29 | T03: `awaiting_manual_confirm → failed` (captcha o abandono, ADR-0004); `AppError.code` es texto libre en mayúsculas |
| 2026-09-29 | T04: puerto `MediaStorage` en `core`; driver `pg`; enums de Postgres `operation` y `currency`; el cliente fija `sslmode=verify-full`; Vitest sin la condición `module` |
| 2026-09-29 | Revisión de T03: estado terminal `cancelled` (desde todo lo que no llegó a la plataforma); estados iniciales, terminales y activos en `core`; `isAppError`; T04 agrega los enums restantes; T05 fija la tabla código→HTTP |
| 2026-09-29 | Revisión de T02: criterios nuevos en T03 (enums compartidos en `core`) y T04 (import entre paquetes verificado) |
