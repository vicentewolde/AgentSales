# ADR-0005 · Cola de trabajos con pg-boss y worker separado

- **Estado:** Aceptado
- **Fecha:** 2026-09-28

## Contexto
Procesar video, renderizar plantillas, llamar a la IA y publicar son tareas lentas y pueden fallar. Además hay publicaciones programadas y sincronizaciones periódicas.

## Decisión
- **pg-boss** sobre el mismo Postgres de Neon (conexión directa): cola, reintentos con backoff, jobs programados (`startAfter`) y cron.
- Proceso **`apps/worker`** separado de la API. La API solo encola.
- Jobs iniciales:
  - `media.process`
  - `content.prepare`
  - `publication.publish`
  - `publication.sync`
  - `tokens.refresh`
- Los handlers son idempotentes: reintentar un job no duplica una publicación (se verifica `external_id` y el estado antes de actuar).

## Consecuencias
- Sin infraestructura extra (ni Redis): todo vive en Postgres.
- La API responde rápido; el panel consulta estados.
- pg-boss necesita la conexión **directa** de Neon (sin `-pooler`): el pooler usa PgBouncer en modo transacción y no soporta bloqueos de sesión. Se documenta en `.env.example`.
- Mientras el worker corre, mantiene el cómputo de Neon despierto: 100 CU-horas al mes equivalen a unas 400 h a 0,25 CU. Se enciende solo al desarrollar (ver ADR-0007).

## Alternativas descartadas
- **BullMQ + Redis:** otra pieza que operar.
- **node-cron en memoria:** se pierde todo si el proceso se reinicia, y no tiene reintentos.

## Seguimiento
- 2026-10-10 (F5-T04, spec F5 §4.11, ADR-0017): job `marketplace.profile` (`login` y `forget` del perfil del navegador de Marketplace), con la política **`stately`** por corredor (la primera cola que la usa: uno activo y uno en cola, así un `forget` espera detrás de un login en curso; con `exclusive` se rechazaría y el perfil no se borraría), sin reintentos, 15 min. No mira `PUBLISH_MODE` (no publica). Como la política no se puede cambiar después de crear la cola, si alguna vez se cambia hay que borrar la cola.
- 2026-09-29 (F0-T06): pg-boss 12.35.0 en `apps/worker`. Cada job se declara con `defineJob` (datos validados con zod y solo ids), con una política por cola que aplica el worker (`createQueue` + `updateQueue`) y `batchSize: 1`. Un `AppError` no reintentable no se reintenta. Contrato objetivo (`JOB_NAMES`/`JOB_PAYLOADS` en `core`, puerto `JobQueue`) y tabla de políticas en `docs/01-arquitectura.md` → Cola de trabajos.
- 2026-09-30 (`/fase-plan 1`): **enmienda.** Se agrega el job `import.run`, porque la importación de F1 sube videos de hasta 300 MB y debe reintentarse si R2 falla. Así se mantiene "la API solo encola":
  - La API crea el `import_run` en `queued`, encola `{ importRunId }` y responde `202`.
  - El worker importa y deja el run en `succeeded` o `failed`, también en el último intento.
  - En el MVP, la API y el worker comparten disco local (`<workspace>/tmp/imports`) para los archivos subidos. Con el despliegue de F7 pasan a R2.
  - El adaptador se extrae a `packages/queue` en F1 (spec F1 §4.6, T08 y T09).
- 2026-10-01 (F1-T08): extraído a `packages/queue`.
  - Productor `createJobQueue`, con arranque diferido y caché de colas diaria para no mantener Neon despierto.
  - `createBoss`, `QUEUE_SCHEMA` y `checkQueueSchema`.
  - `JOB_NAMES` y `JOB_PAYLOADS` en core.
  - `QUEUE_NOT_INITIALIZED` pasa a `QUEUE_UNAVAILABLE`.
  - La deduplicación por `singletonKey` depende de la política de la cola, que es inmutable: T09 la fija para `import.run`.
- 2026-10-01 (F1-T09): `import.run` en el worker.
  - La cola `import.run` es `exclusive`, con 2 reintentos y expiración a las 2 h.
  - `QueuePolicy.policy` solo va a `createQueue`, y el worker avisa si una cola existente tiene otra política.
  - `defineJob` está tipado por `JobName`, con `isLastAttempt` (`includeMetadata`).
  - El handler es `runImport` (core).
  - Al arrancar, el worker cierra los runs abandonados (`IMPORT_ABANDONED`).
- 2026-10-01 (F1-T11): la API compone `createJobQueue` (con `onError` resumido y `stop()` al apagar) y guarda las subidas del panel en `<workspace>/tmp/imports/{id}/input/` en streaming (`@agentsales/importers/staging`). `POST /imports/local` existe solo en desarrollo, para la CLI. Las dos cosas se quitan en F7 (subida directa a R2).
- 2026-10-02 (`/fase-plan 2`, ADR-0012): **enmienda.** No se crea `media.process`: el procesamiento de medios es la primera etapa del job `content.prepare` (medios, renders, reel y textos, cada una idempotente). Cola `exclusive` con `singletonKey = contentRunId`, 2 reintentos con backoff desde 30 s y expiración a los 30 min. El estado vive en `content_runs`, como el de las cargas en `import_runs` (spec F2 §4.4).
- 2026-10-03 (F2-T11): `content.prepare` en el worker, con la política de la enmienda anterior. Cada intento usa su propio procesador y temporal; el renderizador y la IA son del proceso. Al apagar, el worker corta los handlers, espera a pg-boss y recién después cierra Chromium (`stopWorker`). Al arrancar cierra las corridas abandonadas (2 h), reencola las `queued` y borra temporales de más de 24 h. `Job.errorLogFields` deja que un job registre solo el código de sus errores.
- 2026-10-04 (`/fase-plan 3`, ADR-0014): `publication.publish` con cola `exclusive` (`singletonKey = publicationId`), 2 reintentos con backoff desde 60 s y expiración a los 15 min (el sondeo de un reel dura hasta 5 min); el worker reencola al arrancar las publicaciones en `publishing`. `tokens.refresh` corre al arrancar el worker y una vez al día. Los casos de uso que escriben con el candado del aviso encolan **después** de confirmar la transacción (pg-boss usa otra conexión). Conectar una cuenta (OAuth) es la única llamada síncrona a una plataforma desde la API (spec F3 §4.6); el seguimiento de ADR-0014 (punto 9) la extiende a conectar con el token del panel y al refresco a pedido.
- 2026-10-06 (F3-T12): `publication.publish` en el worker con la política de la línea anterior. `JobContext` suma `retryCount` (el reintento, que va a la bitácora de la publicación). El publisher de Instagram se registra con el worker en los dos modos (el modo lo decide cada publicación) y arma su cliente recién al primer intento en `live`. Al arrancar, después de crear las colas, el worker reencola las publicaciones en `publishing` (`requeuePublishingPublications`): es lo que recupera una que quedó sin job tras un apagado en el último intento o una cola caída al publicar. El log de un intento lleva solo el código y si se reintenta (`errorLogFields`). La idempotencia de este job no depende de `external_id` (que existe recién después de publicar), sino del estado `publishing` y del `progress` guardado antes del paso que publica: un reintento retoma sin publicar dos veces.
- 2026-10-06 (F3-T14): `tokens.refresh` en el worker, con cola `exclusive` y un `singletonKey` fijo desde que se crea (el job del arranque y el del cron no se pisan). Tiene 3 reintentos con backoff desde 60 s y expira a los 5 min. Es el primer job con cron: `Job.schedule` (`JobSchedule`) y `WorkerBoss.schedule`, que `registerJobs` aplica después de crear la cola, todos los días a las 12:00 de `America/Santiago`. Un cron perdido con el worker apagado no se repite: lo cubre el refresco del arranque. Es idempotente sin `external_id`: lo refrescado en las últimas 24 h se salta, así que un reintento del lote no repite cuentas. El refresco a pedido (`POST /accounts/:id/refresh`) es síncrono en la API (seguimiento de ADR-0014).
- 2026-10-06 (`/fase-plan 4`, ADR-0015): `publication.sync` en F4 con cola `exclusive` (`singletonKey = publicationId`), 2 reintentos desde 60 s y expiración a los 2 min; corre a pedido, 2 min después de publicar en `live` (`startAfter`, encolado después de guardar `published`) y al arrancar el worker; el cron es de F6. `tokens.refresh` suma las cuentas de Mercado Libre con su política (más de 7 días desde el último refresco). Pausar, reactivar y cerrar una publicación de Portal son síncronos en la API (ADR-0015, punto 8), no jobs.
- 2026-10-07 (F4-T08): `tokens.refresh` refresca también Mercado Libre, con la política de su plataforma (core, `refreshAccountTokens`): las cuentas de Portal con 7 días o más desde el último refresco, revisado otra vez dentro del candado de credenciales (ADR-0015). La cola no cambia (`exclusive`, clave fija, 3 reintentos, 5 min): cada cuenta de Mercado Libre suma como mucho 10 s de espera del candado y 10 s de llamada. Sigue siendo idempotente sin `external_id`: lo refrescado queda fuera por su política (24 h en Instagram, 7 días en Mercado Libre), así que un reintento no rota el par de nuevo. Sin `ML_APP_ID` o `ML_CLIENT_SECRET`, el worker no arma el cliente y esas cuentas fallan con `MERCADOLIBRE_NOT_CONFIGURED`, que no se reintenta, sin cambiar y con un aviso en el log; Instagram sigue. El refresco a pedido de Mercado Libre (`POST /accounts/:id/refresh`) es síncrono en la API, como el de Instagram.
- 2026-10-09 (F4-T18): `publication.sync` quedó como estaba previsto: `exclusive` por `publicationId`, 2 reintentos con backoff desde 60 s y expiración a los 2 min (`PUBLICATION_SYNC_QUEUE`). Lo encolan con `enqueueSync` (core) el intento de Portal en `live` (2 min después), el arranque, las operaciones con una respuesta perdida (30 s) y la API (T19). Un `PUBLICATION_SYNC_STALE` en el último intento no es un fallo: se registra como información. El cron periódico sigue en F6.
