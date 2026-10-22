# ADR-0037 · El worker se enciende y se apaga solo según el horario de publicación

- **Estado:** Aceptado (2026-10-22, F9.5-T24; decisión del operador del 2026-10-22: «que se encienda cuando tiene que publicar y cuando esté ok, se apaga»). Implementados los puntos 1, 2, 3 y 5; el 4 (el botón «encender ahora» del panel) queda para una tarea aparte (ver "Seguimiento").
- **Fecha:** 2026-10-22
- **Reemplaza a / Modifica a:** precisa D1 y el paso 11 de `docs/10-despliegue.md` (el worker nunca se apaga solo)

## Contexto
El worker publica, programa y prepara. Encendido todo el mes cuesta unos US$ 37 a 48 (servidor y Neon Launch); apagado, nada sale. El operador publica a horas fijas (por ejemplo 09:00 y 17:00 de Chile) y quiere pagar solo por el rato que hace falta.

## Decisión
1. **El worker se apaga solo cuando no tiene nada que hacer:** si no hay jobs activos ni publicaciones que venzan en los próximos `WORKER_IDLE_EXIT_MINUTES` (10 por defecto), cierra limpio (`SIGTERM` propio, los 45 s de gracia de hoy) y la máquina de Fly queda detenida. Nunca se apaga con un job en curso ni con algo por vencer.
2. **Se enciende por horario con un workflow de GitHub** (`.github/workflows/worker-schedule.yml`, `cron`) que arranca la máquina del worker unos minutos antes de cada ventana de publicación (las horas se editan en el propio archivo; desde el seguimiento del 2026-10-22, una revisión cada hora de día) y un `workflow_dispatch` para «encender ahora». Usa un token de Fly **solo de esa app y de máquinas**, guardado como secreto por el operador. El workflow lo prepara Claude; **el operador crea el secreto y lo activa** (CLAUDE.md: lo que habla con Fly.io es suyo).
3. **Lo programado a una hora fuera de ventana** se anota en la agenda («sale cuando se encienda el worker») y el panel dice la próxima ventana.
4. **La preparación con IA (fotos, textos)** necesita el worker: al pedirla con el worker apagado, el panel avisa y ofrece «encender ahora» (solo un administrador; llama al mismo workflow).
5. Neon se duerme entre ventanas, así que el plan gratis alcanza mientras el worker esté encendido pocas horas al día.

## Consecuencias
- El costo baja a lo que el worker esté encendido; las ventanas hay que mantenerlas en un solo archivo.
- Si el workflow falla, nada sale: la agenda y `doctor` avisan que el worker está apagado fuera de horario.

## Cómo quedó (F9.5-T24)
- **Punto 1:** `apps/worker/src/idle-exit.ts`. Cada minuto revisa si hay un job activo, o en cola que empieza dentro de `WORKER_STAY_AHEAD_MINUTES` (70 por defecto; en la tabla de pg-boss, sin `publication.due`, que corre cada minuto), una publicación programada que vence dentro de ese margen o venció hace menos de 12 h (`listDue`, sin los recordatorios de Marketplace), o un formulario de Marketplace abierto. Tras `WORKER_IDLE_EXIT_MINUTES` seguidos sin nada, el mismo apagado de `SIGTERM` y `exit 0`; si la revisión falla, no se apaga. **Por defecto `WORKER_IDLE_EXIT_MINUTES` vale 0 (nunca se apaga solo, como antes)**, no 10: el 10 va en `fly.toml`, comentado, y lo activa el operador después de probar el encendido (sin el workflow, nada programado saldría). En Fly, `[[restart]] policy = "on-failure"` deja la máquina detenida al salir con 0.
- **Punto 2:** `.github/workflows/worker-schedule.yml` corre **cada hora a los :50** (`50 * * * *`: Chile va 3 o 4 horas atrás de UTC, así que también a los :50 allí, sin importar el cambio de horario) y enciende el worker si está apagado, dentro de la franja de 07:00 a 23:00 de Chile (revisiones de 06:50 a 22:50): de noche no lo despierta. Busca las máquinas del grupo `worker` con `fly machine list --json` (sin guardar su id) y enciende las detenidas. El secreto es **`FLY_WORKER_START_TOKEN`**, en un **Environment `worker-schedule` que solo acepta `main`** (como el de desplegar, paso 3 de `docs/10-despliegue.md`), no en los secretos del repositorio. Fly no ofrece hoy un token solo de máquinas: se usa uno `deploy` de la app (NO VERIFICADO si se puede acotar más). Sin el secreto, el flujo avisa y termina sin error.
- **Punto 3:** la agenda del administrador tiene la clase `worker_off` («El worker está apagado y hay algo por vencer», acción `start_worker`): con el worker apagado según su latido, cada programada que ya venció (sin pasar las 12 h) o vence antes de la próxima revisión del horario (`nextWorkerCheck`), con cómo encenderlo. `doctor` contra el servidor dice la próxima revisión. El minuto y la franja viven en `packages/core/src/worker-schedule.ts` (`WORKER_CHECK_MINUTE`, `WORKER_ACTIVE_HOURS`) y en el workflow; un test falla si no calzan.

## Seguimiento
- **2026-10-22 · De ventanas fijas a una revisión por hora.** La primera versión de T24 encendía el worker solo antes de dos ventanas fijas (09:00 y 17:00) y lo apagaba si nada vencía en los 10 minutos siguientes. Así, un post a las 10:00 (la ranura por defecto de la cadencia, ADR-0034) salía recién a las 17:00, y lo programado entre las 17:10 y las 21:00 quedaba atrasado más de 12 h y no salía. No cumplía lo pedido («que se encienda cuando tiene que publicar»). Ahora el workflow revisa cada hora, de día, y el worker no se apaga mientras algo venza antes de la próxima revisión más un margen (`WORKER_STAY_AHEAD_MINUTES` = 70: 60 hasta la revisión siguiente y 10 por el atraso de GitHub). Lo de día sale a su hora; lo de madrugada (después de las 00:00) sale a las 06:50. Se eligió mirar 70 minutos fijos y no «hasta la próxima revisión real»: a las 22:50 la próxima es la de las 06:50, y mirar hasta ahí dejaría el worker encendido toda la noche por un post de madrugada.
- **Punto 4** (el panel avisa al preparar con el worker apagado y ofrece «encender ahora», que dispara el workflow): no estaba en T24. Necesita que la API pueda disparar el workflow (un token de GitHub con `actions:write` en el servidor, o un enlace a la página del workflow): se decide en su tarea.

## Alternativas descartadas
- **La API despierta al worker:** la API también se apaga sin tráfico, así que no puede despertarlo.
- **Un cron en la máquina del worker:** no existe un cron que encienda una máquina detenida en Fly sin un servicio aparte.
