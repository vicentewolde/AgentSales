# ADR-0010 · Paquetes internos se resuelven al código fuente con la condición `@agentsales/source`

- **Estado:** Aceptado
- **Fecha:** 2026-09-29

## Contexto
Los paquetes del monorepo (`@agentsales/*`) se importan entre sí por su nombre público (`05-convenciones.md`). El spec F0 (4.5) fija `tsx` para ejecutar en desarrollo y `tsc -b` para compilar a `dist/`. Hace falta decidir a qué archivo apunta un `import "@agentsales/config"`:
- En desarrollo, a `dist/` obliga a compilar antes de cada ejecución, y un `dist/` viejo produce errores confusos.
- En producción no se quiere depender de tsx.

Las herramientas del stack aceptan condiciones de exportación propias: `tsc` con `customConditions`, Node y tsx con `--conditions`, Vite con `resolve.conditions` y Vitest con `ssr.resolve.conditions`.

## Decisión
- Cada paquete declara en `exports` una condición propia antes de las estándar:
  `"@agentsales/source": "./src/index.ts"`, `"types": "./dist/src/index.d.ts"`, `"default": "./dist/src/index.js"`.
- La condición se activa en **un solo lugar por herramienta**:
  - `tsc`: `customConditions` en `tsconfig.base.json`.
  - Vitest: `ssr.resolve.conditions` en `vitest.config.ts` para los tests de Node, repitiendo las condiciones por defecto de Vite salvo `module` (ver Seguimiento), y `resolve.conditions` con las de navegador para los tests del panel en jsdom. Las listas reemplazan las de Vite.
  - tsx y Node en desarrollo: `NODE_OPTIONS=--conditions=@agentsales/source` en los scripts `dev` y `cli` (T05–T07) y en los scripts de paquete (`db:*`, `storage:check`, drizzle-kit).
  - Vite (`apps/web`): `resolve.conditions` en su config (T08).
- En producción no se activa la condición y se usa `dist/`, generado con `tsc -b`.
- Las dependencias internas se declaran como `"workspace:*"`.

## Consecuencias
- En desarrollo y en tests se ejecuta siempre el código fuente actual, sin compilar antes.
- Los tipos entre paquetes pasan por las referencias de proyecto de `tsc -b`, así que un cambio de contrato rompe el typecheck.
- **Riesgo:** un runner que arranca sin la condición cae en silencio a `dist/`, que puede estar viejo o no existir. Para mitigarlo, la condición se configura una sola vez por herramienta. F0-T04 debe verificar un import entre paquetes con `tsc -b`, Vitest y tsx.
- Cada herramienta nueva que resuelva módulos (por ejemplo drizzle-kit en T04) debe revisarse contra esta condición.

## Alternativas descartadas
- **`paths` en tsconfig:** solo afecta a `tsc`. Vitest, tsx y Vite necesitarían alias duplicados, y el nombre del paquete dejaría de ser el contrato real.
- **`main`/`exports` apuntando a `src/*.ts`:** simple en desarrollo, pero producción tendría que ejecutar TypeScript (tsx o type stripping de Node), y el spec fija compilar a `dist/`.
- **Compilar antes de ejecutar (`tsc -b --watch` más `dist/`):** agrega un proceso más en desarrollo y el problema del `dist/` desactualizado.

## Seguimiento
- 2026-09-29 (F0-T04): verificado sin `dist/` con `tsc -b`, Vitest, tsx (`db:migrate`, `db:seed`, `storage:check`) y drizzle-kit (`db:generate` con `NODE_OPTIONS`).
- 2026-09-29 (F0-T04): Vitest no incluye la condición `module`: con ella carga builds ESM de dependencias (por ejemplo `@aws-sdk/checksums`) que no corren en Node sin bundler.
- 2026-09-29 (F0-T08): Vite usa `resolve.conditions: ["@agentsales/source", ...defaultClientConditions]`. Los tests del panel en jsdom usan `resolve.conditions` de `vitest.config.ts` (condiciones de navegador), no las de `ssr`.
