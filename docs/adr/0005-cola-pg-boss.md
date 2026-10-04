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
- 2026-10-04 (`/fase-plan 3`, ADR-0014): `publication.publish` con cola `exclusive` (`singletonKey = publicationId`), 2 reintentos con backoff desde 60 s y expiración a los 15 min (el sondeo de un reel dura hasta 5 min); el worker reencola al arrancar las publicaciones en `publishing`. `tokens.refresh` corre al arrancar el worker y una vez al día. Los casos de uso que escriben con el candado del aviso encolan **después** de confirmar la transacción (pg-boss usa otra conexión). Conectar una cuenta (OAuth) es la única llamada síncrona a una plataforma desde la API (spec F3 §4.6).
