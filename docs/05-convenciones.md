# 05 · Convenciones de desarrollo

## Idioma

- **Código, base de datos, commits (tipo) y nombres técnicos:** inglés.
- **Documentación, UI, mensajes al usuario y descripción de commits:** español.
- Glosario de dominio en `CLAUDE.md`.

## Stack y herramientas

| Área | Elección |
|---|---|
| Runtime | Node.js 26 (LTS previsto para 2026-10-28), ESM — ADR-0008 |
| Paquetes | pnpm 11 workspaces (versión fija en `packageManager`) |
| Lenguaje | TypeScript 7 `strict`, sin `any` (usar `unknown` y validar) — ADR-0009 |
| Lint y formato | Biome 2 |
| Validación | zod en todos los bordes: HTTP, archivos, IA, APIs externas, env, datos de jobs |
| API | Hono y su cliente RPC tipado (`hc`) para web y CLI |
| ORM | Drizzle ORM + drizzle-kit (migraciones SQL versionadas) |
| Base de datos | Postgres en Neon (plan gratis), conexión directa; driver `pg` |
| Archivos | Cloudflare R2 vía API S3 (`@aws-sdk/client-s3`) |
| Cola | pg-boss |
| Importación | exceljs (xlsx) y yauzl (zip), en `packages/importers` (spec F1 §4.9) |
| Medios | sharp (imágenes) y ffmpeg 8.1 o más nuevo con ffprobe (HEIC y video, programas del sistema), en `packages/media` (spec F2 §4.2) |
| Plantillas y render | HTML propio en `packages/templates`, con Inter de `@fontsource/inter` (OFL); Playwright 1.63 (Chromium) en `packages/media` para dibujarlo (spec F2 §4.2) |
| Tests | Vitest 5; msw para HTTP externo; Testing Library + jsdom para componentes; PGlite para los repositorios de `packages/db` (D4 del spec F1); Playwright para el render de plantillas (F2) y, más adelante, e2e del panel (pendiente) |
| Logs | pino, JSON en producción y pretty en dev |
| UI | React + Vite + Tailwind + TanStack Query + React Router |
| CLI | commander + picocolors; cliente RPC `hc<AppType>` de Hono |

Cualquier dependencia nueva que no esté en esta tabla requiere justificación en el PR (y un ADR si es estructural). Las herramientas de desarrollo se fijan con versión exacta. `hono` va en la **misma versión** en `apps/api`, `apps/cli` y `apps/web`: si difieren, `hc<AppType>` puede tiparse mal sin avisar.

## Código

- Funciones puras en `core`; efectos en adaptadores. `core` solo importa `zod` e imports relativos (y `vitest` en `*.test.ts(x)` y `test/`): Biome lo exige con `noRestrictedImports` y su tsconfig no carga tipos de Node. Biome no revisa `require()` ni `import()` dinámico: no se usan en `core`.
- Valores de dominio como tuplas `as const` en `core` (`PLATFORMS`, `PUBLICATION_STATUSES`…), reutilizadas por `z.enum()` y `pgEnum()`; nunca se repiten los literales en otro paquete.
- Un caso de uso por archivo: `packages/core/src/use-cases/import-listings.ts`.
- Errores tipados: `AppError` con `code` (ej. `IMPORT_INVALID_ROW`, `PUBLISH_RATE_LIMITED`) y `retriable: boolean`. Nada de `throw "string"`. Se reconocen con `isAppError`, no con `instanceof`.
- La API traduce el código a HTTP en este orden (`apps/api/src/errors.ts`), y responde solo `{ error: { code, message } }`, nunca `details` ni `cause`:

  | Código | HTTP |
  |---|---|
  | `INVALID_TRANSITION`, `LISTING_NOT_READY`, `CONTENT_EDITED`, `CONTENT_NOT_CURRENT`, `CONTENT_RUN_ACTIVE`, `CONTENT_LOCKED`, `PUBLICATION_PENDING`; desde F3-T14, `ACCOUNT_NOT_CONNECTED` y `ACCOUNT_REFRESH_UNSUPPORTED`; desde F3-T15, `CONTENT_HAS_ERRORS`, `CONTENT_NOT_READY`, `CONTENT_NOT_APPROVED`, `PUBLICATION_IN_PROGRESS`, `PUBLICATION_CONFLICT`, `NOTHING_TO_PUBLISH`, `REMOVAL_NOT_CONFIRMED` y `PUBLISH_MODE_LOCKED` | 409 (un pedido válido que el estado actual no permite: esperar, recargar, descartar o confirmar) |
  | `REQUEST_TOO_LARGE` | 413 |
  | `IG_AUTH_INVALID`, `IG_PERMISSION_DENIED`, `IG_REQUEST_REJECTED` | 400 (Instagram rechazó el token o el permiso al conectar; F3-T13) |
  | `IG_UNEXPECTED_RESPONSE` | 502 (Instagram respondió algo con otra forma) |
  | `JOB_PAYLOAD_INVALID`, `IMPORT_RUN_INVALID`, `*_ROW_INVALID`; desde F3-T15, `PUBLICATION_EVENT_INVALID`, `PUBLICATION_REFERENCE_INVALID` y `PUBLICATION_PROGRESS_INVALID` | 500 (datos que arma el servidor, o una fila corrupta en la base: no es culpa del cliente) |
  | `*_NOT_FOUND` | 404 |
  | `*_INVALID*` o `INVALID_*` | 400 |
  | `*_RATE_LIMITED` | 429 |
  | `*_UNAVAILABLE` | 503 |
  | cualquier otro | 500 (también `*_CONFLICT`, salvo `PUBLICATION_CONFLICT`: es una carrera entre intentos del job, no un error del cliente. `PUBLICATION_CONFLICT` es 409 por el spec F3 §4.8: bajo el candado no debería ocurrir, y si ocurre, el operador puede recargar) |

  Además:
  - Un `AppError` que resulta en 500 mantiene su `code` pero responde un mensaje genérico; el detalle queda solo en el log.
  - Un error que no es `AppError` responde `500 INTERNAL_ERROR`.
  - Una `HTTPException` 4xx de Hono responde `HTTP_<status>` (por ejemplo `HTTP_429`) y conserva sus headers.
  - Un cuerpo JSON mal formado responde `400 INVALID_JSON`, también cuando lo detecta `hono/validator`.
  - Un `Host` no local responde `403 HOST_NOT_ALLOWED`; una ruta inexistente, `404 ROUTE_NOT_FOUND`.
- Nada de secretos en el código. Todo por `packages/config` (env validado con zod al arrancar).
- Solo los puntos de entrada cargan el entorno (`loadEnvFile`/`loadEnv`): las apps y los `src/scripts/*` de cada paquete. El resto de un paquete recibe opciones concretas (`createDb(url)`, `createR2Storage({...})`, `createJobQueue({...})`); Biome lo exige en `db`, `storage`, `importers`, `queue`, `llm`, `media`, `templates` y `publishers`, que además no se importan entre sí (los adaptadores no dependen unos de otros). Excepciones, solo como `devDependency` y prohibidas por Biome en `src`: los tests de `importers` usan `TEMPLATE_COLUMNS` de `@agentsales/db`, y los tests y el script de muestras de `media` (`render:samples`) usan `@agentsales/templates`.
- `drizzle-orm` va en la **misma versión exacta** en `packages/db` y `packages/queue` (`checkQueueSchema` recibe un `SQL` de Drizzle): si difieren, falla el typecheck.
- Nombres de archivos: `kebab-case.ts`. Componentes React: `PascalCase.tsx`.
- Imports entre paquetes solo por su nombre público (`@agentsales/core`), nunca por ruta relativa a otro paquete.

## Estructura de un paquete

Cada paquete o app en `packages/<nombre>` o `apps/<nombre>` sigue esta estructura:

```
package.json      # "name": "@agentsales/<nombre>", "type": "module"
tsconfig.json
src/              # código y tests unitarios (*.test.ts junto al código)
test/             # opcional: fixtures, helpers y tests de integración
```

`tsconfig.json` del paquete:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": ".", "outDir": "dist", "types": ["node"] },
  "include": ["src", "test"],
  "references": [{ "path": "../config" }]
}
```

- `include` tiene `src` y `test`, así `tsc -b` también tipa los tests.
- `types` se declara siempre. `packages/core` usa `"types": []` para que el compilador rechace `process`, `Buffer` y compañía.
- `references` enumera solo los paquetes internos de los que depende (el ejemplo depende de `config`; `packages/core` no tiene ninguna). Además, cada paquete nuevo se agrega a `references` del `tsconfig.json` raíz.
- `apps/web` sobrescribe `lib` (con DOM), `jsx`, `module`/`moduleResolution` (`Bundler`) y `types: ["vite/client"]`, y usa `emitDeclarationOnly` en vez de `noEmit`, porque un proyecto referenciado no puede tener `noEmit`. `vite.config.ts` tiene su propio `tsconfig.node.json` (con tipos de Node). Las declaraciones de la web van a `node_modules/.cache/tsc/`, fuera de `dist/`, porque `vite build` vacía esa carpeta. Los tests del panel tienen su propio `tsconfig.test.json` (con tipos de Node, porque Vitest los trae) y quedan fuera del `tsconfig.json` de la app, donde la guardia `no-node-types.ts` exige que no haya tipos de Node. La web **no** debe ver tipos de Node: lo que exporta la API para `AppType` usa tipos mínimos (por ejemplo `AppLogger`), nunca los de pino o Node.

`exports` del `package.json` del paquete:

```json
"exports": {
  ".": {
    "@agentsales/source": "./src/index.ts",
    "types": "./dist/src/index.d.ts",
    "default": "./dist/src/index.js"
  }
}
```

Una subruta (por ejemplo `./contracts` y `./testing` en `apps/api`, `./testing` en `packages/core` o `./staging` en `packages/importers`, desde F1, o `./tools` en `packages/media`, desde F2: la versión mínima de ffmpeg sin cargar sharp, para `doctor`) repite las tres condiciones con su propio punto de entrada: `"@agentsales/source": "./src/contracts/index.ts"`, `"types": "./dist/src/contracts/index.d.ts"` y `"default": "./dist/src/contracts/index.js"`. Una salida de dobles de prueba (`./testing`: los repositorios en memoria de core, o `testDeps` de la API) solo se importa desde tests, y Biome lo hace cumplir.

- En desarrollo se usa la condición `@agentsales/source`, que resuelve al código fuente sin compilar antes (ADR-0010). Se activa una sola vez por herramienta:
  - `tsc`: `customConditions` en `tsconfig.base.json`.
  - Vitest: `ssr.resolve.conditions` en `vitest.config.ts`.
  - tsx: `NODE_OPTIONS=--conditions=@agentsales/source` en los scripts `dev` y `cli`.
  - Vite: `resolve.conditions`.
- Sin la condición, Node cae **en silencio** a `dist/`, que puede estar viejo. Si un cambio "no se ve", revisa que la herramienta tenga la condición.
- En producción se usa `dist/`, que genera `tsc -b`.
- Las dependencias internas se declaran como `"@agentsales/<nombre>": "workspace:*"`.
- Los scripts no se llaman como comandos propios de pnpm (`ping`, `test` de un filtro, `install`…): `pnpm --filter x ping` ejecuta el comando de pnpm, no el script. Se usan nombres como `job:ping` y, si el nombre podría chocar, se invocan con `pnpm --filter x run <script>`.
- Los scripts de paquete que ejecutan TypeScript usan `NODE_OPTIONS=--conditions=@agentsales/source tsx …` (y lo mismo para `drizzle-kit`).

## Dependencias y pnpm

- pnpm 11 exige una antigüedad mínima a cada versión publicada (`minimumReleaseAge`). **No se agregan excepciones** (`minimumReleaseAgeExclude`): si una versión es demasiado nueva, se usa la anterior.
- Los scripts de instalación de dependencias se aprueban uno a uno en `allowBuilds` de `pnpm-workspace.yaml`, con un comentario del motivo.
- **Biome:** un override reemplaza las opciones de `noRestrictedImports` en vez de sumarlas. Por eso `@agentsales/core/testing` se repite en cada override que restringe imports. Además, el override de tests (el último) apaga la regla, así que un override nuevo que restrinja imports va **antes** que él.

## Tests

- **core:** tests unitarios obligatorios (máquina de estados, validaciones, formateo de precios).
- **Adaptadores externos:** tests de contrato con respuestas grabadas (msw). **Ningún test llama a APIs reales ni publica.**
- **Instagram (`packages/publishers`, F3):** `useInstagramServer()` (`packages/publishers/test/instagram-server.ts`) levanta msw con `onUnhandledFrame: "error"` (una llamada sin handler falla el test) y registra cada petición (método, URL, cabecera `Authorization` y formulario) para afirmar qué se mandó. `errorText(error)` junta mensaje, pila, detalles y causa: los tests revisan que ningún token, secret ni código aparezca ahí. Cada respuesta se prueba con y sin la envoltura `data: [ ]`, y los cortes (sin red, tope de tiempo, señal) con `HttpResponse.error()` y `delay("infinite")`. El test de `pnpm ig:smoke` (`apps/worker/src/smoke/ig-smoke.test.ts`) arma su propio servidor msw, porque una app no importa los `test/` de un paquete, y revisa en cada caso que no hubo `media_publish`. La prueba con Meta de verdad es manual (`pnpm ig:smoke`, sin publicar; la publicación real, solo en la demo con `live` autorizado).
- **Repositorios (`packages/db`):**
  - Se prueban contra Postgres en memoria con PGlite (`createTestDatabase()` de `packages/db/test/pglite.ts`, que aplica todas las migraciones), sin Neon ni red.
  - Reciben `SchemaDatabase` y no usan nada propio del driver (`$client`, `rowCount`, el tipo de resultado de `execute` de pg).
  - Los casos de uso se prueban con los repositorios en memoria de `@agentsales/core/testing`, que solo se importa desde tests (Biome).
  - Los dos repositorios se prueban con los mismos fixtures, para que tengan la misma semántica.
  - Cada `describe` usa sus propios datos (otra categoría u otras filas), para que se pueda correr solo.
- **Importadores:** los Excel de prueba se arman **en memoria** con exceljs (`buildWorkbook` y `syntheticRow` de `packages/importers/test/workbook.ts`), con datos inventados: no hay binarios de fixtures en git. La plantilla real (`data/plantillas/plantilla_propiedades.xlsx`) se prueba directamente. Si hace falta un archivo real (por ejemplo, un export de Google Sheets), va en `packages/importers/test/fixtures/` y solo con datos inventados.
- **Panel (React):**
  - Tests de componentes con Testing Library en jsdom, activado por archivo con `// @vitest-environment jsdom`.
  - Patrón: `createApiClient` (el `hc` completo) y `unwrap(res, schema)`, que lanza `ApiError { code, status }`. Un solo `ApiClientContext`, hooks por recurso en `src/queries/` con fábricas de `queryKey`, y páginas en `React.lazy` desde `routes.tsx`.
  - Componentes: uno por archivo en `src/components/`, y una carpeta por sección cuando pasa de unas 300 líneas o tiene varios archivos (`src/components/content/`), como `commands/doctor/` en la CLI. Un archivo de componente solo exporta componentes (la recarga en caliente de Vite lo pide): las constantes y funciones van en un `.ts` aparte (`content/caption.ts`).
  - Nada de red: `App` recibe el cliente, y el arnés `apps/web/test/harness.tsx` lo arma contra la API real en proceso (`createApp(testDeps(...))` de `@agentsales/api/testing`, quitando el prefijo `/api` como el proxy de Vite). `intercept` responde en lugar de la API para simular caídas o respuestas puntuales. `contentSetup` arma un aviso con fotos y hace de worker con `prepareContent` y dobles (la sección Contenido). jsdom no puede pasarle a la API un `FormData` con archivos, así que `POST /imports` (multipart) se registra en `uploads` y se reenvía a `POST /imports/local`. La subida real del cliente del panel a la API se prueba en el entorno de Node (`apps/web/src/api/upload.test.ts`, sin `@vitest-environment jsdom`). Para el sondeo se usa `vi.useFakeTimers({ shouldAdvanceTime: true })`, que deja cargar las páginas en `React.lazy`. El router en memoria acepta la ruta inicial (`initialPath`, con `initialEntries`).
  - Del paquete de la API, el código del panel solo hace `import type` de la raíz; en tiempo de ejecución, solo `@agentsales/api/contracts`. Biome no distingue `import type`, así que lo revisa un test (`apps/web/src/api-imports.test.ts`).
- **CLI:** un comando por archivo (`apps/cli/src/commands/<nombre>.ts`), o una carpeta con `index.ts` si el comando tiene varios módulos (`commands/doctor/`). Las ayudas compartidas van en `commands/shared.ts`, la espera de una corrida en `commands/wait-run.ts` (`waitForRun`, de `import`, `prepare` y `publish`, con `isQueued` cuando lo que se espera no tiene `queued`) y las vistas en `commands/<x>-view.ts` (`import-run-view.ts`, `content-view.ts`, `publication-view.ts`), y ningún comando importa a otro. Lo que se le pide a la terminal (confirmar, leer la entrada estándar, abrir un enlace) va en `Terminal` (`context.ts`), y los tests lo reemplazan. Cada comando tiene una función `run<Nombre>(deps)` que devuelve el código de salida y un `register(program, ctx)`. Los tests corren contra la API real en proceso: `createApp(testDeps(...))` de `@agentsales/api/testing`, con `app.request` como `fetch` del cliente (`apps/cli/test/harness.ts`), sin red; para publicar, `publicationHarness` sobre el escenario de core (en el panel, `publicationSetup`). La espera se prueba con un reloj falso (`sleep` y `now` inyectados).
- **Medios (`packages/media`):** excepción a "msw para lo externo" (spec F2, D6): el adaptador se prueba de verdad con sharp, ffmpeg y ffprobe, que la CI instala (ffmpeg 9.0.1 estático, fijado por versión y sha256). Las fotos de prueba las genera sharp en memoria (`packages/media/test/images.ts`), y los videos ffmpeg (`testsrc`, `color` y `sine`) en el temporal del test, que revisa el reel con ffprobe. Los tests limitan a sharp y ffmpeg a 2 hilos (`TEST_THREADS`), para no atrasar a los demás archivos que corren en paralelo, y los casos que ffmpeg no puede dar (una versión vieja, un proceso que no termina) usan un ffmpeg falso. El único binario versionado es un HEIC sintético de 5,6 KB hecho de mosaicos (`packages/media/test/fixtures/`, con el script que lo generó: `sips` de macOS sobre un JPEG de sharp, sin personas). Los casos de uso usan `createInMemoryMediaProcessor` (`@agentsales/core/testing`). En local, `pnpm test` necesita ffmpeg y ffprobe 8.1 o más nuevos en el `PATH` (o `FFMPEG_PATH` y `FFPROBE_PATH`), y el Chromium de Playwright (`pnpm --filter @agentsales/media exec playwright install chromium`), los mismos que pide `doctor`. El render se prueba de verdad (`packages/media/test/render.test.ts`): tamaños, transparencia y que una plantilla no pueda pedir nada a la red (un servidor local cuenta las peticiones). Las plantillas se prueban como HTML (`packages/templates/src/slides.test.ts`), y `pnpm --filter @agentsales/media run render:samples` deja imágenes de muestra con datos inventados en `tmp/render-samples/`.
- **LLM:** los tests de core usan `createInMemoryLlmProvider` (`@agentsales/core/testing`), con respuestas en orden. El adaptador `claude-cli` se prueba con un ejecutable falso que se genera en el temporal (`packages/llm/test/fake-claude.ts`) e imita los sobres de la CLI, incluido uno real de sesión vencida. **Guardia:** `vitest.config.ts` fija `CLAUDE_CLI_PATH` a un ejecutable que no existe, así ningún test llama a la CLI real. La prueba con la CLI real es manual (`pnpm llm:smoke`). Evaluación de prompts aparte con `pnpm eval:content` (F2-T16).
- Ubicación: `src/**/*.test.ts(x)` o `test/**/*.test.ts(x)` dentro de cada paquete. Es el patrón que busca `vitest.config.ts`; un test fuera de él no corre.
- Tope por test: 20 s (`testTimeout` en `vitest.config.ts`, desde F2-T09). Los tests de medios cargan el procesador y atrasaban a otros; el tope solo da margen.
- `pnpm check` = lint + typecheck + tests. Debe pasar antes de cada commit.

## Git

- Rama principal: `main`, siempre estable.
- Una rama por tarea: `<tipo>/<id-tarea>-<resumen>`. Ejemplo: `feat/f1-t03-import-xlsx`.
- **Conventional Commits:** `feat(importers): importa hoja Propiedades desde xlsx`. Tipos: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `build`, `ci`.
- Un PR por tarea, con squash merge a `main`. La descripción del PR enlaza la tarea del spec.
- **`main` está protegida:** todo cambio entra por PR, y el merge exige el check `check` de `.github/workflows/ci.yml` en verde sobre el último commit, con la rama al día respecto de `main`. La regla aplica también a los administradores, y bloquea el force push y el borrado.
- **La CI** instala con el lockfile congelado y corre `pnpm check`. También verifica que `pnpm db:generate` no produzca cambios y hace el build del panel. No usa secretos.
- **El repositorio es público:** nada de secretos, datos de clientes ni capturas con datos reales en commits, issues o PRs.
- Al cerrar cada fase: tag `vX.Y.0` (F0 → `v0.0.1`, F1 → `v0.1.0`, …).
- Nunca `git push --force` a `main`. Nunca commitear `.env` ni datos reales de clientes.

## Seguridad operacional

- `PUBLISH_MODE=dry-run` es el default. Solo se cambia a `live` a mano: en `.env` o, para una sesión, `PUBLISH_MODE=live pnpm dev` (la variable del entorno gana sobre `.env`, y la API y el worker la reciben juntos), y el sistema lo muestra en rojo en el panel y la CLI.
- Primeras publicaciones `live`: solo en cuentas de prueba del operador.
- Los logs pasan por el redactor de `@agentsales/config`:
  - Oculta el valor de toda clave que contenga `token`, `secret`, `password`, `authorization` o `key`, a cualquier profundidad, también dentro de errores y bindings.
  - Oculta las credenciales de URLs (`usuario:clave@`) y los parámetros sensibles (`access_token=`, `X-Amz-Signature=`…) en cualquier texto.
  - Oculta los tokens de Mercado Libre (`APP_USR-…`, `TG-…`) en cualquier texto, aunque no vayan en un parámetro sensible (F4-T02).
- Aun así, no se loguea el objeto `env` completo ni respuestas crudas de APIs externas.
- Como `key` también oculta nombres como `objectKey`, en los logs se usan nombres como `objectPath`.

## Documentación viva

- Cada tarea que cambia comportamiento actualiza la documentación afectada **en el mismo PR**.
- `docs/ESTADO.md` se actualiza al terminar cada tarea: qué se hizo y cuál es el siguiente paso.
- `CHANGELOG.md` se actualiza al cerrar cada fase.
- Decisiones relevantes → ADR nuevo en `docs/adr/`.
