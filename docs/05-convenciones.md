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
| Tests | Vitest 5; msw para HTTP externo; Testing Library + jsdom para componentes; Playwright para e2e del panel |
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
  | `INVALID_TRANSITION` | 409 |
  | `*_NOT_FOUND` | 404 |
  | `*_INVALID*` o `INVALID_*` | 400 |
  | `*_RATE_LIMITED` | 429 |
  | `*_UNAVAILABLE` | 503 |
  | cualquier otro | 500 |

  Además:
  - Un `AppError` que resulta en 500 mantiene su `code` pero responde un mensaje genérico; el detalle queda solo en el log.
  - Un error que no es `AppError` responde `500 INTERNAL_ERROR`.
  - Una `HTTPException` 4xx de Hono responde `HTTP_<status>` (por ejemplo `HTTP_429`) y conserva sus headers.
  - Un cuerpo JSON mal formado responde `400 INVALID_JSON`.
  - Un `Host` no local responde `403 HOST_NOT_ALLOWED`; una ruta inexistente, `404 ROUTE_NOT_FOUND`.
- Nada de secretos en el código. Todo por `packages/config` (env validado con zod al arrancar).
- Solo los puntos de entrada cargan el entorno (`loadEnvFile`/`loadEnv`): las apps y los `src/scripts/*` de cada paquete. El resto de un paquete recibe opciones concretas (`createDb(url)`, `createR2Storage({...})`); Biome lo exige en `db` y `storage`.
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

Una subruta (por ejemplo `./contracts` en `apps/api` o `./testing` en `packages/core`, desde F1) repite las tres condiciones con su propio punto de entrada: `"@agentsales/source": "./src/contracts/index.ts"`, `"types": "./dist/src/contracts/index.d.ts"` y `"default": "./dist/src/contracts/index.js"`. Una salida de repositorios en memoria (`./testing`) solo se importa desde tests, y Biome lo hace cumplir.

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

## Tests

- **core:** tests unitarios obligatorios (máquina de estados, validaciones, formateo de precios).
- **Adaptadores externos:** tests de contrato con respuestas grabadas (msw). **Ningún test llama a APIs reales ni publica.**
- **Repositorios (`packages/db`):** tests contra Postgres en memoria con PGlite (`createTestDatabase()` de `packages/db/test/pglite.ts`, que aplica todas las migraciones), sin Neon ni red. Los casos de uso se prueban con los repositorios en memoria de `@agentsales/core/testing`, que solo se importa desde tests (Biome).
- **Importadores:** fixtures en `packages/importers/test/fixtures/` (Excel pequeños, incluidos casos con errores).
- **Panel (React):** tests de componentes con Testing Library en jsdom, activado por archivo con `// @vitest-environment jsdom`. Nada de red: el acceso a la API se inyecta por contexto (hoy `HealthFetcherContext`) o se simula `fetch`. El router en memoria acepta la ruta inicial (`initialPath`).
- **LLM:** en los tests se usa el proveedor `fake`. Evaluación de prompts aparte con `pnpm eval:content` (fase 2).
- Ubicación: `src/**/*.test.ts(x)` o `test/**/*.test.ts(x)` dentro de cada paquete. Es el patrón que busca `vitest.config.ts`; un test fuera de él no corre.
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

- `PUBLISH_MODE=dry-run` es el default. Solo se cambia a `live` a mano en `.env`, y el sistema lo muestra en rojo en el panel y la CLI.
- Primeras publicaciones `live`: solo en cuentas de prueba del operador.
- Los logs pasan por el redactor de `@agentsales/config`:
  - Oculta el valor de toda clave que contenga `token`, `secret`, `password`, `authorization` o `key`, a cualquier profundidad, también dentro de errores y bindings.
  - Oculta las credenciales de URLs (`usuario:clave@`) y los parámetros sensibles (`access_token=`, `X-Amz-Signature=`…) en cualquier texto.
- Aun así, no se loguea el objeto `env` completo ni respuestas crudas de APIs externas.
- Como `key` también oculta nombres como `objectKey`, en los logs se usan nombres como `objectPath`.

## Documentación viva

- Cada tarea que cambia comportamiento actualiza la documentación afectada **en el mismo PR**.
- `docs/ESTADO.md` se actualiza al terminar cada tarea: qué se hizo y cuál es el siguiente paso.
- `CHANGELOG.md` se actualiza al cerrar cada fase.
- Decisiones relevantes → ADR nuevo en `docs/adr/`.
