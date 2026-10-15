# ADR-0019 · La propiedad manda: pausar, cerrar y archivar una propiedad orquestan sus publicaciones, y `auto_publish` aprueba y publica

- **Estado:** Aceptado
- **Fecha:** 2026-10-15
- **Modifica a:** `LISTING_MANUAL_TRANSITIONS` (spec F1 §4.4 y spec F3 §3), ADR-0014 (punto 1: con `auto_publish` el texto se aprueba solo), ADR-0014 (punto 7: con `auto_publish` el modo lo fija el worker), ADR-0015 (cerrar el aviso vendido, que quedó para F6)

## Contexto
- Hoy el operador cambia el estado de una propiedad con `changeListingStatus` (`PATCH /listings/:id/status`) entre `draft`, `ready`, `paused` y `archived`; `active` y `closed` no se tocan a mano. El cambio **no toca las publicaciones**: una propiedad pausada sigue publicada en Portal, y nada escribe `close_reason` (`sold`, `rented`, `withdrawn`).
- El roadmap pide que "vendida o arrendada" despublique o pause en todas las plataformas, y la deuda de F3 pide redefinir los cambios manuales para que orquesten sus publicaciones.
- Cada plataforma retira distinto: Portal se pausa, reactiva y cierra por API (ADR-0015); Instagram no se puede borrar con Instagram Login (se borra a mano y se marca retirada); Marketplace no se lee ni se automatiza fuera del formulario (ADR-0017).
- `brokers.auto_publish` existe desde la migración inicial y ningún caso de uso lo lee. La visión dice que nada se publica sin aprobación "hasta que el operador active la publicación automática por corredor".

## Decisión
1. **Acciones de la propiedad** (`LISTING_MANUAL_TRANSITIONS` nueva): pausar (`ready`/`active` → `paused`), reanudar (`paused` → `active` si queda algo publicado en vivo, si no `ready`), cerrar con motivo `sold`, `rented` o `withdrawn` (`ready`/`active`/`paused` → `closed`), reabrir (`closed`/`archived` → `active` si queda algo publicado en vivo, si no `ready`) y archivar (`draft`/`ready`/`paused`/`closed` → `archived`, solo sin nada publicado). `draft → ready` se mantiene. El sistema sigue moviendo `ready ↔ active` al publicar y retirar.
2. **Cada acción orquesta sus publicaciones:** pausar desprograma las `scheduled` y pausa Portal; reanudar reactiva solo lo que pausó la propiedad; cerrar descarta las pendientes, **cierra Portal** (respuesta del operador, spec F6 D3) y deja Instagram y Marketplace publicados como **tareas a mano** hasta "Marcar como retirada" (D4); archivar descarta las pendientes y se niega si hay algo publicado. Con una publicación `publishing` o `awaiting_manual_confirm`, la acción se niega (409) hasta que termine o el operador diga si publicó.
3. **Tres fases:** (a) dentro del candado, validar la acción, devolver los 409 y desprogramar o descartar las pendientes; (b) fuera del candado, las llamadas a Portal con las piezas de las operaciones de F4, sin que cerrar devuelva la propiedad a `ready`; si una falla, la propiedad no cambia y repetir salta lo ya aplicado; (c) dentro del candado, releer la propiedad **y sus publicaciones** (durante (b) la propiedad sigue publicable, así que pudo empezar o abrirse otra), volver a validar (409 si hay una en curso; soltar las pendientes nuevas) y aplicar el cambio, condicional. Las publicaciones en `dry_run` se cambian en simulación (una de Instagram o Marketplace simulada pasa a `unpublished`: no hay nada que borrar a mano).
4. **Las tareas a mano se derivan** (publicaciones `published` en `live` de Instagram o Marketplace de una propiedad cerrada); no hay tabla nueva. Archivar exige que no quede nada publicado.
5. **`auto_publish`** (respuesta del operador, spec F6 D5): al terminar bien una corrida de contenido con textos, si el corredor lo tiene activo y la propiedad está en `ready` o `active`, el sistema aprueba (actor `system`) cada texto **sin errores** de los canales con cuenta conectada y publica Instagram y Portal de inmediato con el modo del worker (el único camino en que el worker fija el modo: por eso `auto_publish` encendido con el worker en vivo se advierte en `status`, `doctor` y el panel); Marketplace queda aprobado y programado como recordatorio (ADR-0018). Se activa por corredor, con confirmación, y nunca hace fallar la corrida.

## Consecuencias
- "Vendida" es un solo paso para el operador, y el sistema le dice exactamente qué quedó por hacer a mano.
- Pausar o cerrar una propiedad ya no deja avisos de Portal visibles por olvido.
- `changeListingStatus` deja de ser un cambio simple: pasa a llamar a la plataforma y puede fallar a medias (por eso Portal va primero y es repetible).
- Reabrir no republica: Portal cerrado se republica a mano (relist, spec F6 §4.7), con su cupo.
- Con `auto_publish` y la API en vivo, se publica de verdad sin revisión humana: es la decisión del operador por corredor, apagada por defecto y advertida en el panel. La regla "sin errores" usa la misma revisión editorial que aprobar a mano.

## Alternativas descartadas
- **Que cerrar la propiedad solo cambie su estado y el operador cierre cada publicación:** es lo que hay hoy, y es lo que el roadmap pide resolver.
- **Pausar Portal al vender** (en vez de cerrar): mantiene el cupo ocupado y el aviso existente; el operador eligió cerrar (D3) y usar "pausar propiedad" para una reservada.
- **Marcar Instagram como retirado sin borrarlo:** el post seguiría invitando a escribir por algo que ya no está; el operador eligió la tarea a mano (D4).
- **Llamar a Portal dentro del candado:** retiene la fila del aviso mientras se espera a Mercado Libre (hasta 15 s por llamada), como ya evitaron las operaciones de F4.
- **`auto_publish` que solo aprueba, o que programa para el día siguiente:** más seguro, pero el operador eligió publicar de inmediato (D5).
