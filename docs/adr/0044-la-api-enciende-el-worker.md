# ADR-0044 · La API enciende el worker cuando hay trabajo

- **Estado:** Aceptado (2026-11-21)
- **Fecha:** 2026-11-21
- **Reemplaza a / Modifica a:** modifica **ADR-0037**. El punto 2 (el encendido cada hora con el cron de GitHub) deja de ser el encendido principal y queda como respaldo. La alternativa descartada «La API despierta al worker» se retoma: la API pasa a quedar siempre encendida. Los puntos 1 (el apagado solo), 3 y 5 siguen igual.

## Contexto
- El worker 24/7 sondeando pg-boss agotó el 17-nov los 5 GB de transferencia del plan gratis de Neon. Además, encendido no deja dormir a Neon: 730 h al mes × 0,25 CU ≈ 182 CU-h, contra 100 gratis.
- El apagado solo (ADR-0037) funciona. El encendido con `worker-schedule.yml` (`50 * * * *`) no: GitHub lo corrió unas 3 veces al día, y un post programado quedó sin salir. Por eso #288 volvió a dejar el worker siempre encendido.
- Un despliegue de Fly no enciende una máquina del worker detenida.
- La API está en la misma app de Fly. Hoy se apaga sola sin tráfico (`min_machines_running = 0`), y por eso ADR-0037 descartó que despertara al worker.
- Fly tiene la API de Machines:
  - dirección interna `http://_api.internal:4280` «desde la red privada WireGuard de Fly», y la pública `https://api.machines.dev`;
  - autenticación `Authorization: FlyV1 …` o `Bearer …`;
  - `GET /v1/apps/{app}/machines` con el filtro `metadata.{clave}`, y `POST /v1/apps/{app}/machines/{id}/start`.

  Fuentes: [Working with the Machines API](https://docs.fly.io/machines/api/working-with-machines-api) y [Machines resource](https://docs.fly.io/machines/api/machines-resource), leídas el 2026-11-21. Fly pone `FLY_APP_NAME` en cada máquina ([Runtime environment](https://docs.fly.io/machines/runtime-environment)).

## Decisión
1. **La API enciende el worker detenido con la API de Machines** (`apps/api/src/worker-wake.ts`):
   - el token va en el secreto nuevo `FLY_WORKER_WAKE_TOKEN`, y el nombre de la app sale de `FLY_APP_NAME`;
   - la dirección es `FLY_MACHINES_API_URL`, por defecto la interna;
   - lista las máquinas del grupo `worker` y enciende las detenidas (`stopped`, `suspended` o `created`).
2. **Cuándo:**
   - **Al encolar** desde la API (preparar, redactar, publicar ya, reintentar, importar, Portal…): `wakingQueue` envuelve la cola y enciende el worker sin consultar la base. Un job con `startAfter` lejano solo adelanta la revisión.
   - **Con un temporizador en memoria** (cada 15 s mira el reloj, sin consultar nada):
     - con el worker encendido, solo pregunta a Fly cada 2 min si sigue así, sin tocar Neon;
     - con el worker detenido, consulta la base **una vez** para saber cuándo vence lo próximo (`createNextWorkAt`): el job que espera más temprano (`nextPendingJobAt` de `packages/queue`; uno activo cuenta como ya), la programada más temprana con la regla del disparo (`dueQuery`, las vencidas de hace menos de 12 h cuentan como ya) y el **mantenimiento diario**, a las 24 h del último latido del worker. Sin ningún latido, ya;
     - no vuelve a consultar la base hasta esa hora menos 5 min, salvo un aviso (abajo), y como máximo cada 3 h. A esa hora enciende el worker, y el worker, que mira 70 min adelante, se queda hasta publicar.
   - **Tras un pedido que escribe** (no `GET`/`HEAD`, sin error): `poke` adelanta la revisión a 10 s. Así una programada nueva entra en el cálculo, y Neon ya está despierto por el pedido.
   - **Al arrancar la API**, incluido un despliegue, hace una revisión. Así se corrige que el despliegue no encendía el worker.
3. **El mantenimiento diario:** los crons del worker (tokens, respaldo, Portal) solo corren con él encendido. Su arranque ya renueva los tokens, pide el respaldo si toca y sincroniza Portal, así que basta encenderlo una vez al día aunque no haya nada.
4. **La API queda siempre encendida:** `min_machines_running = 1` en `[http_service]`, que se cambia **junto con** `WORKER_IDLE_EXIT_MINUTES`. Un test (`apps/api/src/fly-toml.test.ts`) falla si el worker se apaga solo con la API en 0.
5. **Sin el token o sin `FLY_APP_NAME`** (local, tests, otra instancia), no hace nada y lo dice una vez en el log al arrancar.
6. **El token:**
   - nunca va en un log ni en un error: los errores dicen la operación y el estado HTTP, y nunca el cuerpo de la respuesta;
   - el worker lo quita de su entorno al arrancar (`withoutWorkerWakeToken`), porque en Fly los secretos llegan a todas las máquinas;
   - es un token `deploy` de la app (`fly tokens create deploy -a agentsales`). Fly no ofrece uno que solo encienda máquinas. NO VERIFICADO si `fly tokens attenuate` permite acotarlo más.
7. **`worker-schedule.yml` queda como respaldo** mientras se comprueba el encendido desde la API. El operador lo desactiva desde GitHub (**Disable workflow**) cuando vea en los logs que la API enciende el worker. No se borra: también sirve para «encender ahora» a mano (`workflow_dispatch`). Cada corrida suya enciende el worker unos 10 a 12 minutos.
8. Los errores de Fly o de la base no tumban la API. Se resumen en el log (`createErrorThrottle`) y se reintenta a los 2 min.

## Consecuencias
- **Lo programado sale a su hora:** el worker se enciende 5 min antes. Lo que se pide «ahora» espera solo el arranque del worker (segundos a un minuto), no la próxima revisión de GitHub.
- **Costo (estimación, sin medir):**
  - **La API siempre encendida** (shared-cpu-1x, 512 MB): unos US$ 3 a 4 al mes en Fly. No verificado el precio de `gru`.
  - **El worker:** cerca de 10 a 12 min por cada vez que hay trabajo, más el mantenimiento diario. Antes estaba 24/7: unos US$ 10 a 12 al mes con 2 GB.
  - **Neon por el temporizador:** con el worker detenido y nada que hacer, como mucho 8 consultas al día (una cada 3 h). Cada una lo despierta unos 5 min: unas 20 h al mes, ≈ 5 CU-h de 100. Las demás consultas caen cuando Neon ya está despierto: al apagarse el worker, tras un pedido o a la hora de algo programado.
  - **Transferencia:** tres consultas de una fila por revisión, menos de 1 MB al mes. El encendido de cada 2 min es una llamada a Fly, que no toca Neon.
- La API depende de la API de Machines. Si Fly la rechaza (token vencido a los 6 meses, o revocado), el log lo dice y lo programado espera. Siguen sirviendo la agenda («el worker está apagado y hay algo por vencer») y el respaldo de GitHub mientras esté activo.
- La agenda y `doctor` todavía hablan de «la próxima revisión del horario» (`nextWorkerCheck`, ADR-0037 punto 3), que ahora es solo el respaldo. Ver «Seguimiento».
- Si la API corre con `min_machines_running = 0` y el worker se apaga solo, nada lo enciende hasta el próximo pedido a la API. Lo impide el test de `fly.toml`. Otra instancia (`fly.<instancia>.toml`) necesita su propio secreto, y el test solo mira `fly.toml`.

## Alternativas descartadas
- **El cron de GitHub más seguido o con otro minuto:** GitHub no garantiza la hora ni que corra. Lo medido fue unas 3 corridas al día con «cada hora».
- **Un servicio de cron externo** (cron-job.org u otro) que llame a la API: otra cuenta y otro proveedor del que depender, y la API tendría que estar encendida igual.
- **Consultar la base cada pocos minutos desde la API:** con una consulta cada 5 min, Neon no se duerme nunca: el mismo costo de cómputo que el worker 24/7.
- **Solo despertar al encolar, sin temporizador:** lo programado no pasa por la cola hasta que el worker corre `publication.due`, así que no saldría.
- **`auto_start_machines` del proxy de Fly para el worker:** el worker no tiene servicio HTTP, y darle uno solo para despertarlo exigiría que alguien le haga un pedido a la hora, que es el mismo problema.

## Seguimiento
- Cuando el encendido desde la API esté comprobado en producción:
  - que la agenda y `doctor` dejen de hablar de «la próxima revisión del horario» y digan que el worker sale al vencer (`nextWorkerCheck`, `worker_off` y `wait_worker`, y la «Lista para publicar a diario» de `daily-readiness.ts`);
  - bajar `WORKER_STAY_AHEAD_MINUTES`, que hoy no puede ser menor que 60 por el periodo de la revisión de GitHub.
- Probar la dirección interna desde la máquina de la API. La doc la garantiza desde la red privada, pero no lo dice de una máquina: NO VERIFICADO. Si el log dice «no respondió», poner `FLY_MACHINES_API_URL = "https://api.machines.dev"` en `[env]`.
