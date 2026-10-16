# ADR-0020 · Portal: actualizar re-fija lo aprobado de una publicación publicada, y republicar es una publicación nueva con `relist`

- **Estado:** Aceptado
- **Fecha:** 2026-10-15
- **Modifica a:** ADR-0014 (punto 2: `content_id` fijo mientras la publicación está activa; punto 5, la versión del aviso fijada por ADR-0015), ADR-0015 (punto 6: la versión del aviso fijada; punto 7: contrato de `Publisher` y `PublishInput`; punto 8: operaciones síncronas desde la API)

## Contexto
- F4 dejó para F6 editar un aviso publicado de Portal y republicar uno vencido o cerrado (spec F4 §3). Un arriendo vence a los 45 días (`stop_time`) y queda `closed` con `expired`; no hay forma de extenderlo, solo `POST /items/{id}/relist`, que crea un ítem nuevo con otro `id`, una sola vez por ítem padre (`docs/integraciones/mercadolibre.md` §13, releída el 2026-10-15).
- Mercado Libre permite cambiar título, precio, descripción y atributos con `PUT /items/{id}`, siempre con `seller_contact` completo y, desde el 12/03/2026, con las fotos (`pictures`) en cada actualización de un `silver` (nota §13).
- Hoy una publicación fija su texto (`content_id`), sus medios y la versión del aviso (`listing_source_hash`) al nacer, y nada los cambia mientras está activa (ADR-0014 punto 2, ADR-0015 punto 6). Un texto con una publicación activa no se edita (`CONTENT_LOCKED`).
- Pausar, reactivar y cerrar son operaciones síncronas desde la API, con un tope de 15 s (ADR-0015 punto 8), y leen el `sellerContact` guardado en el progreso.

## Decisión
1. **Actualizar** (`updatePortalPublication`, síncrona en la API, como las operaciones de F4): para una publicación de Portal `published` o `paused`, cuando la propiedad cambió (otra versión) o hay un texto de Portal aprobado más nuevo que el suyo. Manda solo lo que cambió (título, precio, atributos y descripción), con `seller_contact` completo y los `id` de las fotos guardados en el progreso, sin leer el ítem antes, con **un solo tope de 15 s para todas las llamadas**. No cambia fotos ni categoría (`PORTAL_UPDATE_NEEDS_RELIST`).
2. **Re-fijar lo aprobado:** después de que Mercado Libre aceptó el cambio, dentro del candado del aviso, un cambio condicional (`replacePublishedSource`) re-fija `content_id`, `listing_source_hash` y `progress.sellerContact` de esa publicación, con un evento `manual_edit`. Es la **única** forma en que una publicación activa cambia lo fijado; ADR-0014 sigue valiendo para todo lo demás (el texto aprobado de una publicación activa no se edita: se prepara y aprueba uno nuevo).
3. **Republicar** (`relistPublication`): crea una publicación **nueva** con `relisted_from` = la anterior (único parcial, sin contar las descartadas: una sola republicación por publicación) desde el texto aprobado y la propiedad de hoy, y la publica con el job de siempre. `PublishInput` de Portal suma `relistOf: { externalId }`, y el publisher de Portal, dentro de `publish`, llama a `relist` en vez de `POST /items`, guarda el progreso antes de cada paso, nunca repite el `relist` a ciegas (si no sabe cómo terminó, lo busca por el `seller_custom_field` del ítem **anterior**, que el nuevo hereda, y su `parent_item_id`) y repone lo que falte con `PUT` y la descripción, con una marca (`relistRestocked`) para terminar de reponer si un corte lo deja a medias. Solo un rechazo del aviso o de la petición marca `relistRejected`, y el reintento publica un ítem nuevo; un problema de la cuenta o del paquete deja republicar de nuevo.
4. En `dry_run`, las dos acciones son simulaciones sin llamar (ADR-0016); nunca se cruzan los modos (una `live` con la API en simulación es `PUBLISH_MODE_MISMATCH`, y una `dry_run` no se republica con la API en vivo). En `live` piden confirmación: actualizar puede hacer que Mercado Libre pause el aviso por moderación, y republicar usa un cupo.

## Consecuencias
- El operador mantiene al día un aviso publicado (un precio nuevo en la planilla, un texto mejor) sin cerrarlo ni gastar otro cupo.
- Lo que la publicación tiene fijado sigue siendo exactamente lo que está en Mercado Libre: se re-fija en el mismo paso en que se envía, y la bitácora guarda qué campos cambiaron.
- Una acción síncrona más con varias llamadas desde la API; el tope único de 15 s la mantiene bajo los 30 s de la CLI, y una respuesta perdida pide un sync, como pausar o cerrar.
- La publicación republicada tiene su propio enlace e historia; la anterior queda `unpublished` y la vista las enlaza.
- Con `relist`, las fotos del ítem nuevo son las del anterior: pueden no coincidir con las `media_ids` de la publicación nueva (si no trae fotos, se suben las de la publicación).
- Lo NO VERIFICADO del `relist` (si exige `seller_contact`, qué copia del padre) y si la regla de fotos alcanza a pausar y cerrar se confirma con el usuario de prueba de Mercado Libre (pendiente de F4).

## Alternativas descartadas
- **Editar el texto aprobado de una publicación publicada:** rompe "lo aprobado no cambia" y la bitácora dejaría de describir lo enviado.
- **Actualizar desde el worker (job):** el operador espera ver el resultado en pantalla, como al pausar o cerrar; la acción es corta.
- **Republicar sobre la misma publicación** (cambiar su `external_id`): mezcla dos ítems de Mercado Libre en una historia y rompe `unpublished` como estado terminal.
- **Republicar siempre con `POST /items`:** más simple, pero pierde las visitas y preguntas del aviso anterior, que es lo que el `relist` conserva (60 días).
- **Leer el ítem antes de cada actualización para tomar sus fotos:** una llamada más dentro del tope; las fotos ya están en el progreso.

## Seguimiento
- 2026-10-15 (F6-T06 y T07): `relistOf` lleva también la publicación anterior (`{ externalId, publicationId }`): sin el id nuevo guardado, el publisher busca el ítem republicado por el `seller_custom_field` de la anterior y su `parent_item_id`. El progreso de Portal suma `relistRequestedAt`, `relistRejected` y `relistRestocked`, para no repetir el `relist` a ciegas y terminar de reponer el ítem nuevo tras un corte.
- 2026-10-16 (cierre de F6): la regla de cuándo se puede republicar (`canRelist` y `relistedIds`, core: cerrada, sin una republicación viva y la propiedad lista o activa) la comparten la agenda y el panel. Lo NO VERIFICADO (si el `relist` exige `seller_contact`, qué copia del padre, si gasta cupo) se confirma en la prueba en vivo de Portal con el usuario de prueba (D15 de F4).

