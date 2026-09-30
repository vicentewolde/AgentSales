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
| `pnpm cli <args>` | ejecuta la CLI en modo dev (tsx); `pnpm -s cli doctor` para una salida sin el eco de pnpm |
| `pnpm worker:ping [delayMs]` | encola un `system.ping` para probar el worker (T06) |

T01 crea `check`, `lint`, `format`, `typecheck` y `test`. Los demás los agrega la tarea que los introduce: `db:*` y `storage:check` en T04, `dev` en T05–T08 y `cli` en T07.

### 4.3 Contratos
- `GET /health` → `200 { status: "ok"|"degraded", publishMode, checks: { db, storage, queue }, version }`. Cada check es `{ ok, latencyMs, error? }`. Responde 200 aunque haya checks fallidos (con `degraded`). `queue.ok` indica que el esquema `pgboss` existe (la cola se inicializó alguna vez), no que el worker esté corriendo.
- `agentsales doctor`: verifica env, db, storage, cola, `ffmpeg -version`, Chromium de Playwright y `claude --version`. Imprime ✓/✗ por ítem con una sugerencia de arreglo, y sale con código 1 si algo crítico falla. Los ítems que su fase aún no necesita (Playwright, Claude) salen como advertencia, no como error. Neon suspende el cómputo tras 5 min sin actividad y la primera conexión puede tardar unos segundos: el check de base de datos usa un timeout de 10 s y un reintento antes de fallar.
- `agentsales status`: llama a `/health` y muestra `PUBLISH_MODE` destacado.

### 4.4 Datos
- Migración `0000_init`: todas las tablas y enums de `02-modelo-datos.md`.
- Seed: corredor `demo` con marca de ejemplo. Las `field_definitions` se siembran en F1.

### 4.5 Decisiones
- `tsx` para ejecutar TypeScript en dev; build con `tsc` a `dist/`.
- Web en puerto 5173 con proxy de Vite `/api` → API en 8787. La API expone sus rutas **sin prefijo** (`/health`, y en F1 `/imports`, `/listings`), igual que las llama la CLI; el proxy quita el prefijo: `"/api": { target: "http://127.0.0.1:8787", rewrite: (p) => p.replace(/^\/api/, "") }`, y la web usa `hc<AppType>("/api")`. Target `127.0.0.1` y no `localhost`, porque la API solo escucha en IPv4.
- El worker y la API comparten `packages/config` y leen el mismo `.env` de la raíz.

## 5. Tareas

### F0-T01 · Esqueleto del monorepo y tooling
- **Depende de:** —
- **Descripción:** `pnpm-workspace.yaml`, `package.json` raíz con scripts, `tsconfig.base.json` (strict, NodeNext, ES2023), `biome.json`, `.nvmrc` (26, ADR-0008), `.editorconfig`, `vitest.config.ts` raíz (Vitest 5 ya no tiene `vitest.workspace`; los tests del panel usan jsdom por archivo, así que no hizo falta `test.projects`).
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
- **Descripción:** servidor Hono con logger de requests, manejador global de `AppError` (reconocido con `isAppError`, no con `instanceof`) → JSON `{ error: { code, message } }` con status HTTP según una tabla explícita de códigos (`INVALID_TRANSITION` → 409, `*_NOT_FOUND` → 404, `*_INVALID*` → 400; por defecto 500, documentada en `05-convenciones.md`); nunca expone `details` ni `cause` en la respuesta, `/health` con los 3 checks, y `export type AppType`. El check de base de datos usa una función `pingDatabase(db)` que se agrega a `@agentsales/db` (`select 1`, con un reintento por el arranque en frío de Neon); el de almacenamiento usa `storage.head("_healthcheck/ping")` (devuelve `null` si hay acceso y lanza si fallan credenciales o bucket), sin agregar métodos al puerto.
- **Hecho cuando:**
  - [x] Test de `/health` con dependencias simuladas
  - [x] `curl localhost:8787/health` funciona contra Neon y R2 reales

### F0-T06 · apps/worker — pg-boss
- **Depende de:** T04
- **Descripción:** arranque de pg-boss (crea su esquema), registro de handlers por nombre de job, job `system.ping` que loguea y termina, y apagado ordenado con SIGINT/SIGTERM. Check de cola en `/health` (API) como consulta de solo lectura al esquema `pgboss` (por ejemplo, una función en `@agentsales/db` junto a `pingDatabase`), sin `boss.start()` en la API (arrancaría el mantenimiento y la supervisión). Documenta en `01-arquitectura.md` dónde vive el adaptador de `JobQueue` para cuando la API tenga que encolar (F2). pg-boss usa la conexión directa de Neon, pasada por `toPgConnectionString` de `@agentsales/db` para mantener `sslmode=verify-full`; mientras el worker corre mantiene el cómputo despierto (ADR-0007), así que se apaga cuando no se desarrolla.
- **Hecho cuando:**
  - [x] Un `system.ping` encolado desde un script de prueba se procesa y se ve en el log
  - [x] Ctrl+C no deja jobs colgados

### F0-T07 · apps/cli — doctor y status
- **Depende de:** T05
- **Descripción:** commander, cliente RPC `hc<AppType>`, comandos `doctor` y `status` según §4.3, y salida con colores (picocolors). La URL de la API se arma con `http://127.0.0.1:${API_PORT}`; `status` tolera unos 30 s (el peor caso de `/health` es 25 s); `doctor` obtiene db, storage y cola desde `/health` y, si la API no responde, sugiere `pnpm dev`. La CLI no define script `dev` (`pnpm dev` levanta solo api, worker y web).
- **Hecho cuando:**
  - [x] `pnpm cli doctor` muestra el estado real del entorno
  - [x] `PUBLISH_MODE` se muestra en rojo si es `live`

### F0-T08 · apps/web — shell del panel
- **Depende de:** T05
- **Descripción:** Vite + React + Tailwind + TanStack Query + React Router; layout con menú (Estado, Propiedades y Publicaciones deshabilitados por ahora); página "Estado del sistema" con `/health` (sondeo cada 30–60 s solo con la pestaña visible, por Neon); banner permanente de `PUBLISH_MODE`. Proxy según §4.5. Comprobar que `import type { AppType } from "@agentsales/api"` no arrastra tipos de Node al `tsc -b` de la web. `AppType = ReturnType<typeof createApp>` arrastra la firma de `createApp(deps: AppDeps)` y, con ella, `Logger` de pino; si molesta, tipar `AppDeps.logger` con un tipo estructural mínimo, porque una salida solo de tipos no alcanza.
- **Hecho cuando:**
  - [x] `pnpm dev` levanta todo y la página muestra los checks en vivo
  - [x] Se ve bien en pantalla de notebook y en móvil

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
| Arranque en frío de Neon (suspende a los 5 min) hace fallar `/health` o `doctor` | Timeout de conexión de 10 s por intento, con un reintento (tope de 25 s por check); el panel muestra `degraded` sin caerse |
| El panel sondeando `/health` mantiene Neon despierto (cada sondeo hace `select 1`) y consume CU-horas | La página Estado sondea cada 30–60 s y solo con la pestaña visible (`refetchIntervalInBackground: false`); ver ADR-0007 |
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
| 2026-09-29 | T09: CI en `.github/workflows/ci.yml` (acciones fijadas por SHA; install con lockfile congelado, `pnpm check`, migraciones al día y build del panel). Simulada en un clon limpio, destapó que la web compilaba el código fuente de la API: `redactText` pasa a `core`, la API no usa `NodeJS.*` en lo que exporta y los tests del panel van en `tsconfig.test.json` |
| 2026-09-29 | Revisión de T08: Vite lee `API_PORT`/`WEB_PORT` del `.env` de la raíz; solo la página Estado sondea (el banner no); errores del panel como `CODE: mensaje`, con timeout de 35 s y cancelación; banner con un solo `role="status"` y contraste AA; guardia de tipos de Node en la web; declaraciones fuera de `dist/`; contratos HTTP pendientes de un ADR-0011 en F1 |
| 2026-09-29 | T08: contrato de `/health` (`healthReportSchema`) en `core`, que usan la API, la CLI y el panel; `core` usa `zod`; la API tipa su logger con `AppLogger` (mínimo) para que `AppType` no meta pino ni los tipos de Node en la web (verificado: la web rechaza `process`); tests del panel con jsdom y Testing Library por archivo; sondeo de `/health` cada 30 s solo con la pestaña visible |
| 2026-09-29 | Revisión de T07: `PUBLISH_MODE` se toma de la API (error si no coincide con `.env`) y `live` va en rojo también en `doctor`; `/health` validado con zod en la CLI; errores de la API como `CODE: mensaje`; sugerencias para base y almacenamiento; notas para F1-T06 y T08 |
| 2026-09-29 | T07: `doctor` marca error en Node distinto de 26, `.env` inválido, API caída (con base, almacenamiento y cola), ffmpeg ausente; advertencia en Chromium, Claude y `PUBLISH_MODE=live`. `status` sale con 1 si no está `ok`. Chromium se detecta en la caché de ms-playwright, sin instalar Playwright. `commander@15.0.0`, `picocolors@1.1.1` |
| 2026-09-29 | Revisión de T06: `defineJob` con zod y política por cola aplicada por el worker; `batchSize: 1`; errores no reintentables sin reintento; arranque interrumpible; extracción de la cola "en la primera fase en que la API encole" |
| 2026-09-29 | T06: `pg-boss@12.35.0`; adaptador en `apps/worker` (a `packages/queue` en F2); `checkQueueSchema` en `@agentsales/db`; script `pnpm worker:ping` (no `ping`: choca con un comando de pnpm) |
| 2026-09-29 | Revisión de T05: rutas sin prefijo y proxy con rewrite (§4.5); Host permitidos y CSRF en la API; riesgo del sondeo a Neon; notas para T06, T07 y T08; `pnpm dev` con filtros explícitos |
| 2026-09-29 | T05: la API escucha solo en `127.0.0.1` (sin autenticación hasta F7); tabla de errores con 429 (`*_RATE_LIMITED`) y 503 (`*_UNAVAILABLE`); `queue` responde `pendiente: F0-T06` hasta el worker; `hono@4.13.10` y `@hono/node-server@2.1.1` por la política de antigüedad |
| 2026-09-29 | Revisión de T04: errores de storage como `AppError`; `createDb` con `onError`; `pingDatabase` y check de storage en T05; `toPgConnectionString` en T06 |
| 2026-09-29 | T04: puerto `MediaStorage` en `core`; driver `pg`; enums de Postgres `operation` y `currency`; el cliente fija `sslmode=verify-full`; Vitest sin la condición `module` |
| 2026-09-29 | Revisión de T03: estado terminal `cancelled` (desde todo lo que no llegó a la plataforma); estados iniciales, terminales y activos en `core`; `isAppError`; T04 agrega los enums restantes; T05 fija la tabla código→HTTP |
| 2026-09-29 | Revisión de T02: criterios nuevos en T03 (enums compartidos en `core`) y T04 (import entre paquetes verificado) |
