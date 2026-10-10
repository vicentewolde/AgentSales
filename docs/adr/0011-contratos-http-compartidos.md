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
  - `media` no tiene esquema en core: `MediaRecord` es una proyección del repositorio, y la API expone `mediaItemSchema` en `contracts`, sin `storagePath` ni `checksum` y con la URL firmada. El esquema se agrega a core cuando un caso de uso lo necesite (previsto en F2: `media.process`, variantes y `photo_order` de la IA).
  - "Imports relativos" en `contracts` significa solo `./`: Biome rechaza `../`, que sale al código del servidor, y un test (`apps/api/test/contracts-boundary.test.ts`) lo prueba.
  - Se sumó la salida de solo tests `@agentsales/api/testing` (`testDeps`, `fakeUploads`, `silentLogger`), restringida con Biome como `@agentsales/core/testing`.
  - Los archivos se tipan con `z.custom<File>`, nunca con `z.instanceof(File)`, que filtra el `File` de `node:buffer` a `AppType`.
- 2026-10-03 (F2-T03): `media` tiene esquema en core (`mediaSchema`: rol, variante, padre y medidas), que devuelve `MediaRepository.listByListing`. `MediaRecord` sigue como la proyección de la carga, y `mediaItemSchema` de `contracts` sigue siendo la vista HTTP (sin `storagePath` ni `checksum`). El seguimiento de F1 anunciaba el esquema para `media.process` y para `photo_order` de la IA: los dos quedaron descartados (ADR-0012 y spec F2, D3), y el esquema se agregó para las variantes y renders.
- 2026-10-03 (F2-T02 a F2-T15): las entidades `contentRun`, `contentRunReport` y `content` viven en core, y sus vistas HTTP en `contracts` (`contentRunViewSchema`, `contentViewSchema`, `contentCheckSchema`, `contentMediaSchema`, `listingContentResponseSchema` y los cuerpos de pedir y editar). La vista del texto no lleva `rawOutput` ni el proveedor o el modelo de la IA, y la de la corrida saca `provider` y `model` de `report.llm`. Las URLs firmadas las arma la API. `mediaItemSchema` suma `thumbUrl` y las medidas.
- 2026-10-06 (cierre de F3): `contracts` suma las vistas de cuentas (`GET /accounts` con `connect.instagram.startUrl`, validado como URL `http(s)`), de aprobación (`ContentApproveResponse` con `created` y `skipped`) y de publicaciones (`publicationView`, sin `progress` ni `externalId`; la bitácora filtrada al leer). `CLIENT_HEADER` (`X-AgentSales-Client`) y `CLI_CLIENT` permiten que la API registre a la CLI como actor. `OAUTH_REDIRECT_ERRORS` son los códigos que la vuelta del OAuth le pasa al panel en `?error=` (no son `AppError`). Las vistas siguen sin llevar tokens ni URLs de lo enviado a Instagram.
- 2026-10-09 (F4-T19): `ErrorBody` suma `error.issues`, opcional y solo en `PORTAL_NOT_READY`: lo que le falta al aviso para Portal (código, campo del Excel y motivo en español, sin datos del aviso), validado con `portalReadinessIssueSchema` antes de salir. Sigue sin exponerse ningún otro `details`. Las rutas de Portal (`pause`, `resume`, `close`, `sync`) suman sus esquemas (`publicationCloseBodySchema`, `publicationOperationResponseSchema`, `publicationSyncResponseSchema`), y la vista de la publicación, `remoteState`. `ML_AUTH_INVALID` responde 400 también en las operaciones (no se distingue por ruta: la cuenta ya quedó `expired` y el mensaje pide reconectar).
- 2026-10-09 (revisión de F4-T19): `POST /publications/:id/sync` responde 409 `PUBLICATION_NOT_PUBLISHED` si no hay nada que leer (una simulación, o una que no está publicada ni pausada), en vez de un 202 que el job descartaría.
- 2026-10-10 (F5-T08): `error.issues` también en `MARKETPLACE_NOT_READY` (los mismos esquemas, ahora `readinessIssueSchema` y `readinessSchema`; los nombres de Portal quedan como alias), y `ErrorBody` suma `error.publicationId` (un uuid, opcional) solo en `MANUAL_CONFIRM_PENDING` y `MARKETPLACE_FORM_OPEN`: la publicación con el formulario abierto (la que espera el clic final; en `MARKETPLACE_FORM_OPEN`, si no hay una esperando, la que todavía se llena), para que la CLI y el panel ofrezcan "lo publiqué" o "no lo publiqué" (o pidan esperar). Cada uno se valida antes de salir; ningún otro `details`. Las rutas de Marketplace suman `marketplaceLoginBodySchema` y `marketplaceLoginResponseSchema`, `accountDisconnectBodySchema` (desconectar lleva cuerpo siempre), `publicationConfirmBodySchema` y `publicationConfirmResponseSchema`; la vista de la cuenta, `sessionCheckedAt` y `lastLoginError`; la de la publicación, `manual` (derivado del progreso, nunca el progreso crudo); el contenido y aprobar, `marketplaceReadiness`.
