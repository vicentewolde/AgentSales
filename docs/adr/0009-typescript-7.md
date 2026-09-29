# ADR-0009 · TypeScript 7 (compilador nativo)

- **Estado:** Aceptado
- **Fecha:** 2026-09-29
- **Modifica a:** ADR-0001 (fija la versión de TypeScript; el resto sigue vigente)

## Contexto
ADR-0001 eligió TypeScript strict sin fijar versión. Al instalar el tooling en F0-T01, la versión `latest` en npm es **TypeScript 7.0.2** (publicada el 2026-07-08). Es el compilador nativo, reescrito en Go. La línea anterior, basada en JavaScript, es la 6.0.x.

Lo que se observó en F0-T01:
- `tsc -b` funciona con referencias de proyecto y es notablemente más rápido.
- TS 7 rechaza un `tsconfig.json` de solución con `files: []` y sin referencias (error TS18002). Por eso el `tsconfig.json` raíz revisa los `*.ts` de la raíz con `noEmit`.
- `types` ya no incluye todos los `@types/*` por defecto. Cada paquete declara los suyos, lo que permite dejar `packages/core` sin tipos de Node.

Riesgo: la API programática de TypeScript cambia respecto de las versiones 5.x y 6.x. Una herramienta que importe `typescript` como librería, o que declare `typescript@^5` como dependencia par, podría fallar. Las herramientas del stack previstas para F0–F3 (tsx, Vite, drizzle-kit y Vitest) compilan con esbuild o Rolldown, no con la API de TypeScript. Hono RPC solo depende del sistema de tipos.

## Decisión
- El proyecto usa **TypeScript 7.0.x**, con versión exacta en el `package.json` raíz, y typecheck con `tsc -b`.
- `tsconfig.base.json` no define `types`. Cada paquete declara los suyos: `["node"]` en los que lo necesitan y `[]` en `packages/core`.
- **Respaldo:** si una dependencia del stack no funciona con TS 7, primero se intenta aislarla. Por ejemplo, un `typescript@6` como dependencia de desarrollo solo en ese paquete. Si no se puede, el proyecto baja a TS 6.0.x, y se registra en la sección de Seguimiento de este ADR con el motivo.

## Consecuencias
- Typecheck rápido, lo que ayuda a mantener `pnpm check` antes de cada commit.
- La plantilla de tsconfig por paquete (`05-convenciones.md`) es la que se validó con TS 7.
- Riesgo de ecosistema: plugins o herramientas que usen la API de TypeScript. Se revisa al agregar cada dependencia nueva.

## Alternativas descartadas
- **TypeScript 6.0.x:** es la línea JavaScript de transición, con compatibilidad amplia. Pero es más lenta, y el ecosistema ya se mueve a TS 7. Queda como respaldo.
- **TypeScript 5.9:** tiene dos versiones mayores de atraso y sus valores por defecto difieren de 6 y 7, lo que complicaría migrar más adelante.

## Seguimiento
- (sin incidencias)
