# ADR-0034 · El código agenda las ideas del plan; la IA propone qué y en qué orden

- **Estado:** Aceptado
- **Fecha:** 2026-10-22
- **Reemplaza a / Modifica a:** ADR-0030, punto 2 (la IA ya no sugiere fecha ni hora) y su seguimiento de F9-T20 (las redes de la idea ya no son exactamente las que sugiere la IA: son las que quedan tras asignar la ranura)

## Contexto
En F9 la IA propone cada idea con sus redes, formato, fecha y hora, y el código solo valida y descarta lo que cae fuera del período o de la cadencia (`checkPlanIdeas`). Al usarlo, el operador vio fechas y redes raras: la IA no respeta bien los días, las horas, los posts por semana ni lo ya planificado, y lo que el código descarta se pierde aunque la idea fuera buena. Las ideas además se parecen entre sí. Para la demo con la oficina (F9.5, `docs/specs/fase-9.5-lista-para-mostrar.md`), el plan debe verse ordenado.

## Decisión
1. La IA devuelve las ideas **en orden de preferencia**, cada una con tema, línea de contenido, formato, **redes preferidas** y el porqué. **No** devuelve fecha ni hora.
2. El código agenda idea por idea, en ese orden (spec F9.5, D7):
   - **redes candidatas** = preferidas ∩ pedidas en el plan ∩ las que sirven al formato (`kindProblem`);
   - **ranuras** de cada red, según su cadencia (días, horas, posts por semana y espacio) dentro del período, sin chocar con lo ya planificado ni con lo asignado antes en el mismo plan; una red sin cadencia, o con días u horas vacíos, usa días hábiles a las 10:00 (hora de Chile) con un post por semana;
   - la **ranura de la idea** es la más temprana libre entre las candidatas, repartiendo primero en las semanas con menos ideas; las redes de la idea son las candidatas que tienen esa ranura libre, y las demás se le quitan (al reporte);
   - **sin ranura**, la idea se descarta con `NO_SLOT`.
3. Antes de agendar, una idea con 60 % o más de palabras de tema en común con otra anterior del mismo plan se descarta con `IDEA_TOO_SIMILAR`.
4. `PLAN_DISCARD_CODES` solo crece (los reportes guardados se leen con `z.enum`); `PLAN_PROMPT_VERSION` sube.
5. Todo lo demás de ADR-0030 sigue: el perfil editorial como única fuente de hechos, aceptar, aprobar y programar a mano, y sin `auto_publish` para posts.

## Consecuencias
- El calendario del plan respeta siempre la cadencia: el operador ya no ve fechas fuera de lo que configuró.
- Se pierden menos ideas buenas por fechas mal elegidas; se descartan las repetidas.
- La IA ya no puede proponer «este tema conviene el jueves por X»: el porqué sigue, pero la fecha es mecánica. Si hace falta, el operador mueve la fecha al editar la idea.
- `eval:social` deja de contar descartes por fecha (no ocurren) y cuenta `IDEA_TOO_SIMILAR` y `NO_SLOT`.

## Alternativas descartadas
- **Mejorar el prompt para que la IA respete la cadencia:** ya lo pide (regla 6 del prompt de F9) y no lo cumple de forma fiable; validar y descartar pierde ideas.
- **Que la IA elija la fecha y el código la corrija a la ranura más cercana:** dos fuentes de verdad para lo mismo y resultados difíciles de explicar.

## Seguimiento
- **F9.5-T23 (2026-10-22), punto 4:** `PLAN_DISCARD_CODES` suma `FIRST_PERSON_PLURAL` al final. Además, desde ahora el reporte guardado se lee con tolerancia (`readPlanRunReport`): cada descarte se valida por separado y uno con un código que la versión no conoce se deja fuera, en vez de anular el reporte entero. Así una versión anterior a un código nuevo (desde T23 en adelante) sigue mostrando las ideas, sus notas y los demás descartes. Las versiones anteriores a T23 no tienen este lector: con un reporte que traiga `FIRST_PERSON_PLURAL` muestran las ideas, pero no los descartes (`docs/10-despliegue.md`, volver atrás).
