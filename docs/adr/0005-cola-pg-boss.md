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
