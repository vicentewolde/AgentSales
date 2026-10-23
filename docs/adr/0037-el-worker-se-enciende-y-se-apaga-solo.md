# ADR-0037 · El worker se enciende y se apaga solo según el horario de publicación

- **Estado:** Aceptado (2026-10-22, F9.5-T24; decisión del operador del 2026-10-22: «que se encienda cuando tiene que publicar y cuando esté ok, se apaga»). Implementados los puntos 1, 2, 3 y 5; el 4 (el botón «encender ahora» del panel) queda para una tarea aparte (ver "Seguimiento").
- **Fecha:** 2026-10-22
- **Reemplaza a / Modifica a:** precisa D1 y el paso 11 de `docs/10-despliegue.md` (el worker nunca se apaga solo). Precisa **ADR-0018** (el disparo de lo programado): con el horario activado, un trabajo nuevo (una programada, publicar ahora, un reintento, preparar textos) puede atrasarse hasta la próxima revisión, unos 60 minutos de día, y de noche hasta la de las 06:50.

## Contexto
El worker publica, programa y prepara. Encendido todo el mes cuesta unos US$ 37 a 48 (servidor y Neon Launch); apagado, nada sale. El operador quiere pagar solo por el rato que hace falta, y que lo programado salga a su hora.

## Decisión
1. **El worker se apaga solo cuando no tiene nada que hacer** (`apps/worker/src/idle-exit.ts`). Cada minuto revisa si hay:
   - un job activo, o en cola que empieza en los próximos `WORKER_STAY_AHEAD_MINUTES`. Se mira en la tabla de pg-boss (`countPendingJobs` de `packages/queue`) y no cuentan los internos de pg-boss, `publication.due` (cada minuto) ni `publications.watch` (cada hora);
   - una programada que vence en ese margen o venció hace menos de 12 h (`dueQuery` de core, la misma regla del disparo);
   - un formulario de Marketplace abierto.

   Tras `WORKER_IDLE_EXIT_MINUTES` minutos seguidos sin nada, se apaga **sin cortar los jobs**: pg-boss deja de tomar trabajos y espera hasta 15 min a los activos (cortar un intento de publicar podría dejarlo `outcome_unknown`). Después sale con 0. Si llega una señal mientras tanto, corta como siempre. Si la revisión falla, no se apaga (el error se resume en el log). En Fly, `[[restart]] policy = "on-failure"` deja la máquina detenida.
   - **`WORKER_STAY_AHEAD_MINUTES` vale 70 por defecto**, y como mínimo 60, el periodo de la revisión: 60 hasta la revisión siguiente más 10 por el atraso de GitHub.
   - **`WORKER_IDLE_EXIT_MINUTES` vale 0 por defecto, es decir, nunca se apaga solo (como antes).** El `10` va comentado en `fly.toml`, y lo activa el operador después de probar el encendido: sin el workflow, nada programado saldría.
2. **Se enciende con una revisión cada hora:** `.github/workflows/worker-schedule.yml` corre a los :50 (`50 * * * *`). Chile va 3 o 4 horas atrás de UTC, así que también son los :50 allí, con cualquier horario.
   - Enciende las máquinas del grupo `worker` que estén apagadas, solo dentro de la franja del día: de 07:00 a 23:00 de Chile, con revisiones de 06:50 a 22:50 y 15 min de holgura por el atraso de GitHub. De noche no lo despierta: lo de madrugada sale a las 06:50.
   - Tiene `workflow_dispatch` para «encender ahora».
   - La franja y el minuto están en `packages/core/src/worker-schedule.ts` y en el workflow; un test compara los dos, incluida la cuenta de bash.
   - El secreto es **`FLY_WORKER_START_TOKEN`**: un token `deploy` de la app (`fly tokens create deploy -a agentsales`). Fly no ofrece uno que solo encienda máquinas, así que el token por sí solo podría desplegar. **El límite real lo pone el Environment `worker-schedule` de GitHub, restringido a `main`**: solo este workflow, en `main`, lo usa, y un test exige que de Fly solo llame a `machine list` y `machine start`.
   - El workflow lo prepara Claude; **el operador crea el secreto y lo activa** (CLAUDE.md: lo que habla con Fly.io es suyo, también `gh workflow run worker-schedule.yml`). Sin el secreto, el flujo avisa y termina sin error.
3. **Lo que espera al worker apagado** va en la agenda del administrador, en la clase `worker_off` («El worker está apagado y hay algo por vencer»).
   - **Con el horario activado** (la API lo sabe por `WORKER_IDLE_EXIT_MINUTES` > 0, el mismo entorno que el worker), entran las programadas que vencieron o vencen antes de la próxima revisión. Dice «sale en la próxima revisión» (acción `wait_worker`), y `doctor` dice cuándo es esa revisión.
   - **Sin horario**, entra lo que vence en 24 h. Dice «sin horario: el worker debe estar encendido» (acción `start_worker`).
4. **La preparación con IA (fotos, textos)** necesita el worker: al pedirla con el worker apagado, el panel avisa y ofrece «encender ahora» (solo un administrador; llama al mismo workflow).
5. Neon se duerme mientras el worker está apagado.

## Consecuencias
- **Costo (estimación, sin medir):** cada revisión deja el worker encendido unos 10 a 12 minutos aunque no haya nada: arranca, espera los 10 minutos y se apaga. Son 17 revisiones al día, unas 3 h de worker y de Neon despierto: unos US$ 1 a 3 al mes en Fly y unos 25 a 35 de los 100 CU-h gratis de Neon, más el rato de cada publicación.
- Con el worker apagado, todo lo que necesita al worker espera a la próxima revisión, hasta unos 60 minutos de día (ADR-0018 precisado): lo que se programa o se publica «ahora», los reintentos, las operaciones de Portal, preparar e importar. La CLI que espera un resultado queda esperando hasta su tope.
- GitHub puede atrasar o saltarse una corrida: el margen de 70 minutos y la revisión siguiente lo cubren. GitHub desactiva los workflows programados tras 60 días sin cambios en el repositorio. El token vence a los 6 meses.
- Si el workflow falla, nada sale: la agenda y `doctor` avisan que el worker está apagado y hay algo por vencer.

## Seguimiento
- **2026-10-22 · De ventanas fijas a una revisión por hora.** La primera versión de T24 encendía el worker solo antes de dos ventanas fijas (09:00 y 17:00) y lo apagaba si nada vencía en los 10 minutos siguientes. Así, un post a las 10:00 (la ranura por defecto de la cadencia, ADR-0034) salía recién a las 17:00, y lo programado entre las 17:10 y las 21:00 quedaba atrasado más de 12 h y no salía. La decisión de arriba ya es la nueva.
  - Se eligió mirar 70 minutos fijos y no «hasta la próxima revisión real»: a las 22:50 la próxima es la de las 06:50, y mirar hasta ahí dejaría el worker encendido toda la noche por un post de madrugada.
- **Que el worker informe si el apagado solo está activo:** hoy la API lo lee de su propio entorno, que comparte con el worker. Moverlo al latido (`worker_heartbeats`) necesita una migración, y se dejó para no chocar con la de F9.5-T22.
  - **2026-10-22 (F9.5-T27):** la «Lista para publicar a diario» también depende de ese dato: con el horario activo dice «revisa que el workflow tenga su secreto», y sin horario mira el latido. Si la API y el worker leen entornos distintos, la lista se equivoca: otro motivo para llevar el dato al latido.
- **Punto 4** (el panel avisa al preparar con el worker apagado y ofrece «encender ahora», que dispara el workflow): no estaba en T24. Necesita que la API pueda disparar el workflow, con un token de GitHub con `actions:write` en el servidor o un enlace a la página del workflow; se decide en su tarea.

## Alternativas descartadas
- **La API despierta al worker:** la API también se apaga sin tráfico, así que no puede despertarlo.
- **Un cron en la máquina del worker:** no existe un cron que encienda una máquina detenida en Fly sin un servicio aparte.
- **Ventanas fijas (dos al día):** la primera versión; ver "Seguimiento".
