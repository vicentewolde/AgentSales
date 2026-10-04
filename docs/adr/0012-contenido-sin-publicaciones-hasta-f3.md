# ADR-0012 · El contenido se prepara sin publicaciones hasta F3, en corridas por aviso

- **Estado:** Aceptado
- **Fecha:** 2026-10-02
- **Modifica a:** ADR-0005 (no se crea el job `media.process`: el procesamiento de medios es una etapa de `content.prepare`), `docs/06-roadmap.md` (criterio de aceptación de F2) y el flujo "Preparación de contenido" de `docs/01-arquitectura.md`

## Contexto
- El roadmap pide que F2 deje el contenido de las 3 propiedades de muestra en `pending_approval`, y el flujo 2 de `01-arquitectura.md` dice que `content.prepare` "crea contents y publications en estado pending_approval".
- `pending_approval` es un estado de `publications`, no de `contents` (`contents.status` es `draft`, `edited` o `approved`).
- `publications.platform_account_id` es obligatorio, y su único parcial `(listing_id, platform_account_id)` evita dos publicaciones activas del mismo aviso en la misma cuenta. Las cuentas se conectan en F3.
- Preparar el contenido es lento (procesar fotos y video, renderizar, llamar a la IA) y puede fallar a medias. El panel y la CLI necesitan ver el avance y el error, como con las cargas (`import_runs`).
- F2 también agrega datos a `media` (variantes y renders) y rangos a `field_definitions`.

## Decisión
1. **Sin publicaciones en F2.** F2 crea solo `contents` (en `draft`, o `edited` si el operador los corrige). Las publicaciones nacen en F3, cuando hay una cuenta conectada, a partir del contenido vigente. El criterio de F2 pasa a "contenido listo para revisar".
2. **Corridas de contenido (`content_runs`).** Cada "preparar contenido" es una corrida del job `content.prepare`, con `status` (`queued`, `running`, `succeeded`, `failed`), etapa, reporte, error y fechas, igual que `import_runs`. Hay una sola corrida activa por aviso (único parcial); pedir una corrida mientras hay otra activa devuelve la activa y, si está en `queued`, la vuelve a encolar; además, el worker reencola las `queued` al arrancar. Así un job perdido no bloquea el aviso. Una corrida terminal nunca se vuelve a procesar.
3. **Contenido vigente.** `contents` suma `content_run_id` (único con `platform`). El contenido vigente de un aviso en un canal es su fila más reciente. Una corrida que solo rehace imágenes (`texts = false`) no crea filas y conserva el contenido anterior con sus ediciones. Las filas viejas quedan como historial.
4. **Derivados de medios.** Un derivado vigente por original y variante (`role = processed`) y un render vigente por aviso y variante (`role = rendered`), con únicos parciales. Si cambian la versión del procesamiento o los datos de la plantilla, la fila se reemplaza y el objeto viejo se borra de R2.
5. **Rangos de los campos numéricos.** `field_definitions` suma `min_value` y `max_value` (`numeric null`), que aplica el validador.

Las tres migraciones se generan en cadena, en las tareas T01, T02 y T03 del spec F2. Detalle en el spec (§4.2 a §4.4) y en `docs/02-modelo-datos.md`.

## Consecuencias
- F2 no depende de las cuentas de Meta ni de Mercado Libre, y no hay datos falsos que limpiar en F3.
- La aprobación sigue siendo de F3, sobre `publications`, con su máquina de estados intacta.
- F3 debe definir cómo nace una publicación desde el contenido vigente (por ejemplo, al conectar la cuenta o al aprobar), y si `contents.status = approved` se marca junto con ella.
- Una tabla más (`content_runs`) y tres migraciones. El patrón de corrida (estado, reintentos, abandonadas al arrancar, sondeo con topes) se repite del de las cargas, así que la CLI y el panel lo reutilizan.
- El historial de contenidos crece con cada regeneración; es texto y no pesa.
- Un derivado o un render se reemplaza **en su lugar** (misma fila, clave nueva). Cuando F3 guarde los medios usados en `publications.media_ids`, una publicación ya hecha apuntará a la fila actualizada: F3 debe decidir si guarda una copia de las claves publicadas o si congela los medios de una publicación activa.

## Alternativas descartadas
- **Sembrar una cuenta falsa en `dry-run`** para crear publicaciones en F2: datos inventados en `platform_accounts` que F3 tendría que reemplazar, y publicaciones atadas a una cuenta que no existe.
- **Hacer opcional `publications.platform_account_id`:** publicaciones sin destino que se podrían aprobar sin poder publicarse, y el único parcial deja de proteger (en Postgres, `null` no choca con `null`).
- **Guardar el estado de la preparación en `listings`:** mezcla el estado comercial del aviso con el de un proceso técnico, y no deja historial ni reporte.
- **Un job aparte `media.process` (ADR-0005) más `content.prepare`:** dos avances que coordinar. Las etapas idempotentes de una sola corrida dan el mismo reintento parcial.

## Seguimiento
- 2026-10-03 (F2-T10 a F2-T15, cierre de F2): implementado como se decidió, con estos ajustes:
  - pedir una corrida activa la reencola también si está en `running` (un corte en el último intento la dejaba sin job; la cola `exclusive` no duplica un job vivo), y el worker cierra como `failed` (`CONTENT_RUN_ABANDONED`) las `running` de más de 2 h al arrancar;
  - un corte por apagado deja la corrida en `running` y sube como `CONTENT_RUN_ABORTED` (reintentable);
  - mientras hay una corrida que genera textos, editar responde `CONTENT_RUN_ACTIVE` (409), y regenerar sobre una edición a mano exige `replaceEdits` (`CONTENT_EDITED`);
  - las publicaciones siguen sin crearse: nacen en F3 desde el contenido vigente.
- 2026-10-04 (spec F3): ADR-0014 modifica la consecuencia "la aprobación sigue siendo de F3, sobre `publications`, con su máquina de estados intacta". Se aprueba el texto de cada canal y las publicaciones nacen aprobadas, por formato, con `content_id` y `media_ids` fijos; mientras haya publicaciones pendientes no se vuelve a preparar el contenido, así que los derivados que se reemplazan en su lugar no afectan lo aprobado.
