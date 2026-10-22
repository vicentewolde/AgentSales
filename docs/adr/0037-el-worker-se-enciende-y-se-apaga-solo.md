# ADR-0037 · El worker se enciende y se apaga solo según el horario de publicación

- **Estado:** Propuesto (decisión del operador del 2026-10-22: «que se encienda cuando tiene que publicar y cuando esté ok, se apaga»)
- **Fecha:** 2026-10-22
- **Reemplaza a / Modifica a:** precisa D1 y el paso 11 de `docs/10-despliegue.md` (el worker nunca se apaga solo)

## Contexto
El worker publica, programa y prepara. Encendido todo el mes cuesta unos US$ 37 a 48 (servidor y Neon Launch); apagado, nada sale. El operador publica a horas fijas (por ejemplo 09:00 y 17:00 de Chile) y quiere pagar solo por el rato que hace falta.

## Decisión
1. **El worker se apaga solo cuando no tiene nada que hacer:** si no hay jobs activos ni publicaciones que venzan en los próximos `WORKER_IDLE_EXIT_MINUTES` (10 por defecto), cierra limpio (`SIGTERM` propio, los 45 s de gracia de hoy) y la máquina de Fly queda detenida. Nunca se apaga con un job en curso ni con algo por vencer.
2. **Se enciende por horario con un workflow de GitHub** (`.github/workflows/worker-schedule.yml`, `cron`) que arranca la máquina del worker unos minutos antes de cada ventana de publicación (las horas se editan en el propio archivo) y un `workflow_dispatch` para «encender ahora». Usa un token de Fly **solo de esa app y de máquinas**, guardado como secreto por el operador. El workflow lo prepara Claude; **el operador crea el secreto y lo activa** (CLAUDE.md: lo que habla con Fly.io es suyo).
3. **Lo programado a una hora fuera de ventana** se anota en la agenda («sale cuando se encienda el worker») y el panel dice la próxima ventana.
4. **La preparación con IA (fotos, textos)** necesita el worker: al pedirla con el worker apagado, el panel avisa y ofrece «encender ahora» (solo un administrador; llama al mismo workflow).
5. Neon se duerme entre ventanas, así que el plan gratis alcanza mientras el worker esté encendido pocas horas al día.

## Consecuencias
- El costo baja a lo que el worker esté encendido; las ventanas hay que mantenerlas en un solo archivo.
- Si el workflow falla, nada sale: la agenda y `doctor` avisan que el worker está apagado fuera de horario.

## Alternativas descartadas
- **La API despierta al worker:** la API también se apaga sin tráfico, así que no puede despertarlo.
- **Un cron en la máquina del worker:** no existe un cron que encienda una máquina detenida en Fly sin un servicio aparte.
