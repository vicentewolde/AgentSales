# 05 · Convenciones de desarrollo

## Idioma

- **Código, base de datos, commits (tipo) y nombres técnicos:** inglés.
- **Documentación, UI, mensajes al usuario y descripción de commits:** español.
- Glosario de dominio en `CLAUDE.md`.

## Stack y herramientas

| Área | Elección |
|---|---|
| Runtime | Node.js 26 (LTS desde 2026-10-28), ESM — ADR-0008 |
| Paquetes | pnpm workspaces |
| Lenguaje | TypeScript `strict`, sin `any` (usar `unknown` y validar) |
| Lint y formato | Biome |
| Validación | zod en todos los bordes: HTTP, archivos, IA, APIs externas, env |
| API | Hono y su cliente RPC tipado (`hc`) para web y CLI |
| ORM | Drizzle ORM + drizzle-kit (migraciones SQL versionadas) |
| Base de datos | Postgres en Neon (plan gratis), conexión directa |
| Archivos | Cloudflare R2 vía API S3 (`@aws-sdk/client-s3`) |
| Cola | pg-boss |
| Tests | Vitest; msw para HTTP externo; Playwright para e2e del panel |
| Logs | pino, JSON en producción y pretty en dev |
| UI | React + Vite + Tailwind + TanStack Query |

Cualquier dependencia nueva que no esté en esta tabla requiere justificación en el PR (y un ADR si es estructural).

## Código

- Funciones puras en `core`; efectos en adaptadores.
- Un caso de uso por archivo: `packages/core/src/use-cases/import-listings.ts`.
- Errores tipados: `AppError` con `code` (ej. `IMPORT_INVALID_ROW`, `PUBLISH_RATE_LIMITED`) y `retriable: boolean`. Nada de `throw "string"`.
- Nada de secretos en el código. Todo por `packages/config` (env validado con zod al arrancar).
- Nombres de archivos: `kebab-case.ts`. Componentes React: `PascalCase.tsx`.
- Imports entre paquetes solo por su nombre público (`@agentsales/core`), nunca por ruta relativa a otro paquete.

## Tests

- **core:** tests unitarios obligatorios (máquina de estados, validaciones, formateo de precios).
- **Adaptadores externos:** tests de contrato con respuestas grabadas (msw). **Ningún test llama a APIs reales ni publica.**
- **Importadores:** fixtures en `packages/importers/test/fixtures/` (Excel pequeños, incluidos casos con errores).
- **LLM:** en los tests se usa el proveedor `fake`. Evaluación de prompts aparte con `pnpm eval:content` (fase 2).
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
- Los logs pasan por un redactor que oculta `token`, `secret`, `password` y `authorization`.

## Documentación viva

- Cada tarea que cambia comportamiento actualiza la documentación afectada **en el mismo PR**.
- `docs/ESTADO.md` se actualiza al terminar cada tarea: qué se hizo y cuál es el siguiente paso.
- `CHANGELOG.md` se actualiza al cerrar cada fase.
- Decisiones relevantes → ADR nuevo en `docs/adr/`.
