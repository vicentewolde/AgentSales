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
| Validación | zod en todos los bordes: HTTP, archivos, IA, APIs externas, env |
| API | Hono y su cliente RPC tipado (`hc`) para web y CLI |
| ORM | Drizzle ORM + drizzle-kit (migraciones SQL versionadas) |
| Base de datos | Postgres en Neon (plan gratis), conexión directa |
| Archivos | Cloudflare R2 vía API S3 (`@aws-sdk/client-s3`) |
| Cola | pg-boss |
| Tests | Vitest 5; msw para HTTP externo; Playwright para e2e del panel |
| Logs | pino, JSON en producción y pretty en dev |
| UI | React + Vite + Tailwind + TanStack Query |

Cualquier dependencia nueva que no esté en esta tabla requiere justificación en el PR (y un ADR si es estructural). Las herramientas de desarrollo se fijan con versión exacta.

## Código

- Funciones puras en `core`; efectos en adaptadores. `core` solo importa `zod` e imports relativos (y `vitest` en `*.test.ts(x)` y `test/`): Biome lo exige con `noRestrictedImports` y su tsconfig no carga tipos de Node. Biome no revisa `require()` ni `import()` dinámico: no se usan en `core`.
- Valores de dominio como tuplas `as const` en `core` (`PLATFORMS`, `PUBLICATION_STATUSES`…), reutilizadas por `z.enum()` y `pgEnum()`; nunca se repiten los literales en otro paquete.
- Un caso de uso por archivo: `packages/core/src/use-cases/import-listings.ts`.
- Errores tipados: `AppError` con `code` (ej. `IMPORT_INVALID_ROW`, `PUBLISH_RATE_LIMITED`) y `retriable: boolean`. Nada de `throw "string"`.
- Nada de secretos en el código. Todo por `packages/config` (env validado con zod al arrancar).
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
- `apps/web` (F0-T08) sobrescribe `lib` (con DOM), `jsx`, `module`/`moduleResolution` (`Bundler`) y usa `emitDeclarationOnly` en vez de `noEmit`, porque un proyecto referenciado no puede tener `noEmit`.

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

- En desarrollo se usa la condición `@agentsales/source`, que resuelve al código fuente sin compilar antes (ADR-0010). Se activa una sola vez por herramienta:
  - `tsc`: `customConditions` en `tsconfig.base.json`.
  - Vitest: `ssr.resolve.conditions` en `vitest.config.ts`.
  - tsx: `NODE_OPTIONS=--conditions=@agentsales/source` en los scripts `dev` y `cli`.
  - Vite: `resolve.conditions`.
- Sin la condición, Node cae **en silencio** a `dist/`, que puede estar viejo. Si un cambio "no se ve", revisa que la herramienta tenga la condición.
- En producción se usa `dist/`, que genera `tsc -b`.
- Las dependencias internas se declaran como `"@agentsales/<nombre>": "workspace:*"`.

## Tests

- **core:** tests unitarios obligatorios (máquina de estados, validaciones, formateo de precios).
- **Adaptadores externos:** tests de contrato con respuestas grabadas (msw). **Ningún test llama a APIs reales ni publica.**
- **Importadores:** fixtures en `packages/importers/test/fixtures/` (Excel pequeños, incluidos casos con errores).
- **LLM:** en los tests se usa el proveedor `fake`. Evaluación de prompts aparte con `pnpm eval:content` (fase 2).
- Ubicación: `src/**/*.test.ts(x)` o `test/**/*.test.ts(x)` dentro de cada paquete. Es el patrón que busca `vitest.config.ts`; un test fuera de él no corre.
- `pnpm check` = lint + typecheck + tests. Debe pasar antes de cada commit.

## Git

- Rama principal: `main`, siempre estable.
- Una rama por tarea: `<tipo>/<id-tarea>-<resumen>`. Ejemplo: `feat/f1-t03-import-xlsx`.
- **Conventional Commits:** `feat(importers): importa hoja Propiedades desde xlsx`. Tipos: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `build`, `ci`.
- Un PR por tarea, con squash merge a `main`. La descripción del PR enlaza la tarea del spec.
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
