# ADR-0011 · Contratos HTTP compartidos en `@agentsales/api/contracts`; entidades en `core`

- **Estado:** Aceptado
- **Fecha:** 2026-09-30

## Contexto
La CLI y el panel validan en tiempo de ejecución lo que responde la API, porque la respuesta viene de la red y en ese puerto puede haber otro servicio. Con `hc<AppType>` solo reciben **tipos**. En F0:
- `healthReportSchema` vive en `core` (`health.ts`), y lo usan la API, la CLI y el panel.
- El esquema del cuerpo de error (`errorBodySchema`) está **duplicado** en `apps/web/src/api.ts` y `apps/cli/src/api-client.ts`, y el tipo `ErrorBody` vive en `apps/api/src/errors.ts`.
- F1 agrega muchos contratos más: parámetros de `/listings`, formularios de `/imports`, respuestas de listings, medios e `import_runs`.

Restricciones:
- El panel no puede importar el servidor en tiempo de ejecución: arrastraría Hono, pino, Drizzle y los tipos de Node (`docs/01-arquitectura.md` → "Tipos alcanzables desde `AppType`").
- `core` es dominio: solo `zod` e imports relativos (Biome). Poner ahí la forma de las respuestas HTTP mezcla el transporte con el dominio.

## Decisión
- **Entidades de dominio** (`listing`, `media`, `broker`, `importRun`, `importReport`), con sus esquemas zod y tuplas de valores, viven en `packages/core`. `healthReportSchema` también se queda en core.
- **Contratos HTTP** viven en la salida **`@agentsales/api/contracts`** (`apps/api/src/contracts/`):
  - el cuerpo de error (`errorBodySchema`, `ErrorBody`);
  - los parámetros de consulta y de ruta;
  - los formularios y cuerpos de entrada;
  - los sobres de respuesta, que componen entidades de core.
- `contracts` solo puede importar `zod`, `@agentsales/core` e imports relativos. Lo hace cumplir una regla `noRestrictedImports` de Biome para `apps/api/src/contracts/**`, igual que en core.
- La API valida la entrada y tipa la salida con esos esquemas. La CLI y el panel los importan en tiempo de ejecución para validar respuestas; del resto de la API solo importan `type AppType`.
- La salida sigue ADR-0010: `"./contracts"` en `exports`, con las condiciones `@agentsales/source`, `types` y `default`.
- `@agentsales/api` pasa de `devDependencies` a `dependencies` en `apps/web` y `apps/cli`, y `apps/api` declara `zod`.

## Consecuencias
- El `errorBodySchema` duplicado desaparece, y un cambio de contrato rompe el typecheck de los tres consumidores.
- Hay una salida más que mantener. La regla de Biome evita que `contracts` arrastre el servidor al bundle del panel.
- La guardia `no-node-types` del panel sigue siendo la red de seguridad para los tipos.
- Si en F7 los contratos se publican para terceros, ya están separados del servidor.

## Alternativas descartadas
- **Todo en `core`:** más simple, pero mezcla la forma de las respuestas HTTP con el dominio y hace crecer el paquete que importan todos.
- **Un paquete nuevo `packages/contracts`:** separa aún más, pero agrega un paquete y referencias de proyecto para algo que es de la API. Una salida del mismo paquete basta.
- **Solo tipos (`hc<AppType>`) sin validar en runtime:** la respuesta viene de la red, y F0 ya mostró que otro servicio puede estar en el puerto.

## Seguimiento
- 2026-10-02 (cierre de F1):
  - `media` no tiene esquema en core: `MediaRecord` es una proyección del repositorio, y la API expone `mediaItemSchema` en `contracts`, sin `storagePath` ni `checksum` y con la URL firmada.
  - "Imports relativos" en `contracts` significa solo `./`: Biome rechaza `../`, que sale al código del servidor, y un test (`apps/api/test/contracts-boundary.test.ts`) lo prueba.
  - Se sumó la salida de solo tests `@agentsales/api/testing` (`testDeps`, `fakeUploads`, `silentLogger`), restringida con Biome como `@agentsales/core/testing`.
  - Los archivos se tipan con `z.custom<File>`, nunca con `z.instanceof(File)`, que filtra el `File` de `node:buffer` a `AppType`.
