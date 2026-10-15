# ADR-0018 · Calendario: lo programado vive en la base, un reloj por minuto lo despierta y los límites de Instagram se esperan reprogramando

- **Estado:** Aceptado
- **Fecha:** 2026-10-15
- **Modifica a:** la máquina de estados de una publicación (`docs/01-arquitectura.md`), ADR-0005 (jobs `publication.due` y `publications.watch`; política de `publication.publish`), ADR-0014 (punto 4: transiciones nuevas desde y hacia `scheduled`; punto 7: el modo se fija también al programar)

## Contexto
- El roadmap de F6 pide programar por publicación y por lote ("estas 5 el lunes a las 10:00"), reintentos con backoff y que Marketplace participe del calendario solo como recordatorio (ADR-0004).
- `scheduled` y `publications.scheduled_at` existen desde la migración inicial, pero ningún caso de uso los usa. La máquina ya tiene `approved → scheduled`, `scheduled → publishing` y `scheduled → cancelled`.
- El worker corre solo con `pnpm dev` (ADR-0007: la cuota de Neon). Los jobs con `startAfter` vencido corren al arrancar y los cron del período apagado se pierden (`missed: "skip"`).
- Hoy `IG_RATE_LIMITED` e `IG_PUBLISH_LIMIT` no son reintentables y dejan `failed` con "reintenta en N minutos" (spec F3, D10). La API de Instagram no dice cuándo se libera un cupo de su ventana móvil de 24 h (`docs/integraciones/instagram.md` §6.1).
- Una publicación que quedó en `publishing` sin job (`PUBLISH_ABORTED`, `PUBLISH_RESULT_NOT_SAVED` en el último intento, la cola caída) se recupera solo al arrancar el worker (deuda de F3). `publication.sync` corre solo a pedido, después de publicar y al arrancar.

## Decisión
1. **Lo programado vive en la base:** programar es `approved` o `failed` → `scheduled` con `scheduled_at`, dentro del candado del aviso y con la misma revisión que publicar. No se encola un job por programada.
2. **Un reloj por minuto** (`publication.due`, cron `* * * * *` en `America/Santiago`, y una vuelta al arrancar) pasa a `publishing` las `scheduled` vencidas, de a una por aviso dentro de su candado, y encola `publication.publish` después. Las de plataformas con paso manual (Marketplace) **nunca** las dispara: a la hora son un recordatorio en la agenda y el operador aprieta Publicar.
3. **Atrasadas:** una programada con más de 12 h de atraso (`SCHEDULE_OVERDUE_MS`) no se dispara sola: queda `scheduled` y la vista la marca atrasada (regla pura, sin escribir) hasta que el operador decida (respuesta del operador, spec F6 D2).
4. **Transiciones nuevas:** `failed → scheduled` (programar un reintento), `scheduled → approved` (desprogramar), `scheduled → failed` (a la hora no se pudo empezar: la revisión de publicar falló) y `publishing → scheduled` (espera ante un límite). Reprogramar cambia `scheduled_at` sin transición, con un evento `schedule_changed`. `scheduled_at` solo tiene valor en `scheduled`.
5. **El modo se fija al programar** (`dry_run` con el `PUBLISH_MODE` de la API en ese momento; obligatorio al pasar a `scheduled`), como al publicar (ADR-0014 punto 7): el disparo usa el modo de la publicación, nunca el del worker, y el worker en otro modo deja `failed` con `PUBLISH_MODE_MISMATCH`.
6. **Espera ante los límites de Instagram:** core espera ante una señal genérica del error (`details.waitMinutes`), sin nombrar códigos de plataforma; hoy solo la ponen `IG_RATE_LIMITED` (la espera de la cabecera de uso, o 60 min) e `IG_PUBLISH_LIMIT` (6 h), que pasan la publicación de `publishing` a `scheduled` con la hora de reintento, conservando el progreso, con un tope de 3 esperas seguidas; la cuarta deja `failed`. El intento registra `result: "rescheduled"`.
7. **Reintentos:** `publication.publish` pasa a 3 reintentos desde 60 s con backoff exponencial (1, 2 y 4 min).
8. **Vigilancia** (`publications.watch`, cada hora): encola el sync de Portal en vivo y reencola las `publishing` de más de 70 min (sin job: `exclusive` por publicación no duplica), **salvo Marketplace**, que nunca se reabre sin el operador. Al arrancar siguen las dos vueltas directas de hoy (también Marketplace).
9. **Marketplace se programa sin el límite del día ni "un formulario a la vez"** (se revisan al apretar Publicar), y **publicar ahora** adelanta lo programado (`STARTABLE_STATUSES` suma `scheduled`).

## Consecuencias
- Desprogramar, reprogramar, descartar o cerrar la propiedad son cambios de estado en la base: no quedan jobs huérfanos que haya que buscar y borrar en pg-boss.
- La regla de atrasadas vive en un solo lugar (el disparo) y en una regla pura para las vistas.
- Mientras el worker corre hay una consulta por minuto (con un índice parcial). Neon ya está despierto con el worker, así que no cambia la cuota.
- El calendario solo funciona con el worker encendido; con el worker apagado la regla de atrasadas evita que salga de golpe algo de hace días. Encender el worker solo es de F7.
- Un límite de Instagram ya no exige que el operador vuelva a mano, pero tampoco reintenta para siempre.
- La deuda de F3 de las `publishing` sin job se cierra sin un job nuevo por publicación.
- Más estados de entrada a `scheduled` y `failed` que explicar en el panel y la CLI.

## Alternativas descartadas
- **Encolar `publication.publish` con `startAfter` al programar:** pg-boss lo guarda, pero desprogramar o reprogramar obliga a cancelar el job por id, un job vencido corre al arrancar sin la regla de atrasadas, y la verdad queda repartida entre la base y la cola.
- **Un cron por publicación** (`schedule` de pg-boss): pg-boss guarda una fila por cola; no está pensado para miles de horas puntuales.
- **Revisar cada 5 o 15 min:** ahorra poco (el worker ya mantiene Neon despierto) y atrasa lo que el operador pidió a una hora exacta.
- **Disparar Marketplace a la hora:** abriría Facebook sin el operador presente (ADR-0004, ADR-0017).
- **Reintentar los límites de Instagram con la cola:** la espera puede ser de horas y pg-boss mantendría el job vivo o lo agotaría; reprogramar deja la espera a la vista y cancelable.
