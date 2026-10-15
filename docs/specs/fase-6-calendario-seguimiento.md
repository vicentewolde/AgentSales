# Spec F6 · Calendario + seguimiento

- **Estado:** **Aprobado** el 2026-10-15 (aprobación permanente del operador; D2 a D5 las respondió él)
- **Rama base:** `main`
- **Tag al cerrar:** `v0.6.0`
- **Referencias:** `docs/06-roadmap.md#f6--calendario--seguimiento`, ADR-0004, ADR-0005, ADR-0007, ADR-0014, ADR-0015, ADR-0016, ADR-0017, ADR-0018, ADR-0019 y ADR-0020 (nuevos), `docs/01-arquitectura.md` (máquina de estados, cola de trabajos, `publication.sync`, Marketplace en dos tiempos), `docs/02-modelo-datos.md`, `docs/integraciones/mercadolibre.md` (§4.3, §4.4 y §13: editar, republicar y vencimiento; ampliada el 2026-10-15 y releída con el navegador), `docs/integraciones/instagram.md` (límites) y `docs/integraciones/neon-backup.md` (nueva, 2026-10-15)

## 1. Objetivo
El operador deja programadas las publicaciones de una o varias propiedades ("estas 5 el lunes a las 10:00") y el sistema las publica a la hora mientras el worker está encendido, reintenta con espera lo que falla por algo pasajero y dice en palabras simples por qué falló lo demás. Cuando una propiedad se vende o se arrienda, un solo botón la cierra en Portal, descarta lo pendiente y le deja al operador la lista de lo que tiene que borrar a mano en Instagram y Marketplace. Una vista de seguimiento muestra cada propiedad en cada plataforma, con su estado, su enlace y lo que le toca hacer hoy. Además, la base se respalda sola en el equipo del operador.

## 2. Alcance
- **Programar** una publicación, un canal de una propiedad o un lote de propiedades para una fecha y hora (hora de Chile), desprogramar y reprogramar (ADR-0018).
- **Disparo a la hora:** el worker revisa cada minuto las programadas que vencieron y las publica; una atrasada más de 12 h espera la decisión del operador (D2).
- **Marketplace en el calendario solo como recordatorio** (ADR-0004): a la hora aparece en la agenda "te toca"; el operador aprieta Publicar y sigue el flujo de F5.
- **Reintentos con backoff exponencial** y **espera automática** ante los límites de Instagram (`IG_RATE_LIMITED`, `IG_PUBLISH_LIMIT`; deuda de F3, D10): la publicación vuelve a quedar programada para cuando se libere el cupo. `failed` con la causa y qué hacer, en palabras simples.
- **Vigilancia periódica** (`publications.watch`, cada hora mientras el worker corre): sincroniza los avisos de Portal en `live` y reencola las publicaciones que quedaron en `publishing` sin job (deuda de F3).
- **Portal:** actualizar un aviso publicado (título, precio, descripción y atributos), republicar uno vencido o cerrado, y avisar 7 días antes del vencimiento (spec F4 §3).
- **La propiedad manda** (ADR-0019; deuda de F3, `LISTING_MANUAL_TRANSITIONS`): pausar, reanudar, cerrar por **vendida**, **arrendada** o **retirada**, reabrir y archivar una propiedad orquestan sus publicaciones en todas las plataformas.
- **Vista de seguimiento:** una matriz propiedad × plataforma con estado y enlace, y una **agenda** con lo próximo, lo atrasado, los recordatorios de Marketplace, lo que vence, lo que falló y las tareas a mano.
- **`auto_publish` por corredor:** al terminar de preparar los textos, aprueba los que no tienen errores y los publica (D5).
- **Respaldo local de la base** (`pg_dump`): diario mientras el worker corre y a pedido (`pnpm db:backup`), fuera del proyecto, con los últimos 14.
- API, CLI y panel para todo lo anterior.

## 3. Fuera de alcance
- **Que Marketplace salga solo a la hora** (ADR-0004, ADR-0017): en el calendario es un recordatorio; el sistema nunca abre Facebook sin que el operador apriete Publicar.
- **Encender el worker solo** (launchd, un servidor 24/7): el worker sigue corriendo con `pnpm dev` (ADR-0007, cuota de Neon). Lo programado con el worker apagado se resuelve con la regla de atrasadas (D2). El despliegue es de F7.
- **Leer estados de Instagram o de Marketplace:** Instagram no se sincroniza (no hay nada que cambie solo) y Marketplace no se lee (spec F5, D5).
- **Borrar posts de Instagram o avisos de Marketplace desde el sistema:** no se puede por API (Instagram) o no se automatiza (Marketplace). Quedan como tareas a mano (D4).
- **Editar las fotos de un aviso publicado de Portal** o cambiarle la categoría (tipo u operación): se cierra y se republica. Editar un post de Instagram ya publicado: la API no lo permite.
- **Notificaciones fuera del sistema** (correo, WhatsApp, notificaciones de macOS): los avisos viven en la agenda del panel y en `agentsales agenda`.
- **"Vendida" desde el Excel:** la planilla no tiene una columna para eso y la carga nunca cambia el estado de una propiedad; se marca en el panel o la CLI.
- **Respaldar los archivos de R2** (fotos y videos originales, renders): el respaldo es solo de la base (nota `neon-backup.md` §5). Los originales siguen en las carpetas del operador, desde donde se volvieron a cargar; un respaldo de R2 se evalúa con el despliegue (F7).
- **Restaurar la base desde el sistema:** se documenta el paso a paso con `pg_restore` (lo hace el operador); el sistema solo respalda.
- **Métricas de desempeño** de las publicaciones (post-MVP).

## 4. Diseño

### 4.1 Componentes
| Componente | Cambio |
|---|---|
| `packages/core` | Máquina de estados con las transiciones nuevas (§4.2); casos de uso `schedulePublication`, `scheduleListings`, `unschedulePublication`, `startDuePublications`, `watchPublications`, `updatePortalPublication`, `relistPublication`, `changeListingStatus` reescrito (pausar, reanudar, cerrar, reabrir, archivar) y `autoPublishListing`; la espera ante límites en `publishPublication` (por una señal genérica del error, sin nombrar códigos de plataforma); reglas puras para la agenda y la matriz (`trackingRow`, `agendaItems`, `portalExpiry`, `scheduleState`) y para la causa legible (`publicationErrorAdvice`); `LISTING_MANUAL_TRANSITIONS` nueva; `JOB_NAMES` suma `publication.due`, `publications.watch` y `db.backup`; dobles en `@agentsales/core/testing` |
| `packages/db` | Migración `0008`: índice de las programadas y `publications.relisted_from` con su único parcial (§4.12); `PublicationRepository` suma `scheduledAt` en los cambios, `reschedule`, `replacePublishedSource`, `listDue`, `listForTracking` y `listStalePublishing`, y `create` acepta `relistedFrom`; `BrokerRepository.setAutoPublish`; `ListingRepository.changeStatus` con `closeReason`; `pnpm db:backup` (script del paquete) |
| `packages/publishers` | Cliente de ítems de Mercado Libre: `update` (`PUT /items/{id}` con `seller_contact`), `updateDescription` y `relist`; las operaciones de Portal suman `update` y el publisher republica cuando el input trae `relistOf` (ADR-0020). Instagram: los errores de límite llevan la señal de espera en `details` (`waitMinutes`) |
| `apps/worker` | Jobs `publication.due` (cada minuto y al arrancar), `publications.watch` (cada hora; al arrancar siguen las dos vueltas de hoy) y `db.backup` (diario y al arrancar si toca); `auto_publish` al terminar `content.prepare`; política de reintentos de `publication.publish` |
| `apps/api` | Programar (una publicación, o una o varias propiedades), desprogramar; `POST /listings/:id/status` (reemplaza el `PATCH` en T10); actualizar y republicar en Portal; `GET /tracking` y `GET /agenda`; `PATCH /brokers/:id` (`autoPublish`); `/health` con el último respaldo |
| `apps/cli` | `schedule`, `unschedule`, `agenda`, `tracking`, `listing pause|resume|close|reopen|archive`, `publications update|relist`, `brokers auto-publish`; el aviso de cola de `publish` (deuda de F3) |
| `apps/web` | Programar desde una publicación, un canal y la lista de propiedades (lote); página **Seguimiento** (agenda y matriz); acciones de la propiedad (pausar, reanudar, vendida, arrendada, retirada, reabrir, archivar); Portal con Actualizar, Republicar y "vence en N días"; `auto_publish` en Cuentas |

### 4.2 Máquina de estados (ADR-0018)
Transiciones nuevas de una publicación (las demás no cambian):

| Desde | Hacia | Cuándo |
|---|---|---|
| `failed` | `scheduled` | programar un reintento |
| `scheduled` | `approved` | desprogramar (el texto sigue aprobado) |
| `scheduled` | `failed` | a la hora no se pudo empezar (la propiedad no está lista, falta algo para Portal, cambió el aviso, la cuenta no está conectada) |
| `publishing` | `scheduled` | espera automática ante un límite de Instagram (§4.5) |

`approved → scheduled`, `scheduled → publishing` y `scheduled → cancelled` ya existían. Reprogramar (cambiar la hora de una `scheduled`) no es una transición: es un cambio condicional nuevo del repositorio, `reschedule(id, { expectedAt, at }, event)`, con un evento nuevo `schedule_changed` (`{ from, to }`) que se suma a `PUBLICATION_EVENT_TYPES`. Programar y la espera automática dejan `{ scheduledAt, reason }` en el `status_changed` (`reason`: `operator`, `batch`, `auto_publish`, `rate_limit`). `scheduled_at` se escribe solo con `scheduled` y se borra al salir de ese estado.

**El modo se fija al programar** (modifica ADR-0014 punto 7, ADR-0018): `PublicationChanges.dryRun` pasa a ser obligatorio también al pasar a `scheduled` (`PUBLICATION_MODE_REQUIRED`, como hoy al pasar a `publishing`), y el disparo usa `publication.dryRun`, nunca el modo del worker.

`publishing → scheduled` solo lo hace el intento ante un límite (§4.5). `transition()` no conoce la plataforma: es el caso de uso el que nunca lleva a `scheduled` por un límite a una de Marketplace.

### 4.3 Programar (ADR-0018)
- **Tres formas, una regla** (`schedule.ts`, core):
  - **Una publicación** (`schedulePublication`, `POST /publications/:id/schedule { at }`): `approved` o `failed` → `scheduled`; una `scheduled` se reprograma.
  - **Una o varias propiedades** (`scheduleListings`, `POST /schedule { listingIds, platforms?, at, spacingMinutes? }`; el canal de una propiedad es el mismo pedido con una sola y `platforms: [canal]`): para cada propiedad, en el orden recibido, cada canal con texto aprobado y cuenta conectada (o solo `platforms`). Como `publishListing`, abre las que faltan desde el texto aprobado (`planPublications`) y programa todas las pendientes de ese canal (carrusel y reel a la misma hora; el worker las publica de a una). Con `spacingMinutes` (0 por defecto, hasta 240), la propiedad i sale a `at + i × spacing`. Una propiedad que no se puede programar no corta el lote: el resultado dice, por propiedad y canal, `scheduled` o `skipped` con el código y el motivo.
- **Lo que se revisa al programar** es lo mismo que al publicar (`publication-start.ts`): la propiedad en `ready` o `active`, sin corridas activas, texto aprobado y sin errores, cuenta conectada, la versión del aviso (`PUBLICATION_LISTING_CHANGED`), lo que falta para Portal y Marketplace (`PORTAL_NOT_READY`, `MARKETPLACE_NOT_READY`) y el modo (`PUBLISH_MODE_LOCKED`). Todo dentro del candado del aviso, como publicar. **Salvo** en una plataforma con paso manual (Marketplace): el límite del día y "un formulario a la vez" (`requireMarketplaceStartable`) no se revisan al programar (son del día en que se aprieta Publicar), solo al publicar. A la hora se vuelve a revisar (§4.4).
- **La hora:** `at` en ISO con zona (la CLI y el panel la piden en hora de Chile y la convierten); al minuto (los segundos se descartan); al menos 2 min en el futuro y como mucho 60 días (`SCHEDULE_TOO_SOON`, `SCHEDULE_TOO_FAR`, 400). El recordatorio de `auto_publish` (§4.10) usa un camino interno sin ese margen (`at = ahora`).
- **El modo se fija al programar** (D11 de F3, §4.2): `dry_run` sale del `PUBLISH_MODE` de la API en ese momento, y la vista lo muestra ("programada en simulación" o "en vivo", en rojo). En vivo, programar pide la misma confirmación que publicar. Si a la hora el worker corre en el otro modo, la publicación pasa a `failed` con `PUBLISH_MODE_MISMATCH` (como hoy), sin publicar nada.
- **Desprogramar** (`unschedulePublication`, `POST /publications/:id/unschedule`): `scheduled` → `approved`. **Descartar** (`/cancel`) también vale para una `scheduled`.
- **Marketplace** se puede programar como recordatorio (ADR-0004): queda `scheduled`, el disparo no la toca y a la hora aparece en la agenda como "te toca" (§4.9), también si pasaron más de 12 h (un recordatorio nunca está "atrasado"). El operador aprieta Publicar (`STARTABLE_STATUSES` suma `scheduled`) y sigue el flujo de F5, con sus reglas (límite diario, un formulario a la vez). Por lo mismo, **publicar ahora** (una publicación o el canal con `publishListing`) arranca también las programadas: es la forma de adelantarlas. Adelantar usa el modo de la API en ese momento, como publicar (no el fijado al programar); si es distinto, la confirmación lo dice. Un lote que programa más de 3 recordatorios de Marketplace de la misma cuenta para el mismo día lo avisa (`notes`), sin impedirlo.
- **`attempts`** sube cuando la publicación pasa a `publishing`, como hoy, no al programar.

### 4.4 El disparo (job `publication.due`, ADR-0018)
- **Cron cada minuto** (`* * * * *`, `America/Santiago`) y una vez al arrancar el worker. Cola `exclusive` con clave fija, sin reintentos (el minuto siguiente es el reintento) y 2 min de vida.
- **`startDuePublications({ now })`** (core): las `scheduled` con `scheduled_at` entre `now − 12 h` y `now`, de plataformas **sin** paso manual (Marketplace queda fuera), en orden de hora, como mucho 20 por vuelta. El filtro de la hora y de la plataforma va **en la consulta** (`listDue({ now, since, excludePlatforms, limit })`): así las atrasadas y los recordatorios, que siguen `scheduled`, nunca ocupan los 20 lugares de las que sí hay que publicar. Para cada una, dentro del candado de su aviso, la misma revisión de `startPublication`:
  - si pasa: `scheduled` → `publishing` (`startOne` con el modo **de la publicación**: `attempts + 1`, borra `last_error`) y se encola `publication.publish` **después** del candado;
  - si no: `scheduled` → `failed` con el código y el motivo (por ejemplo `LISTING_NOT_READY` o `PORTAL_NOT_READY`), actor `system`.
- **Atrasadas (D2):** una con `scheduled_at` de hace más de **12 h** (`SCHEDULE_OVERDUE_MS`) no se dispara: queda `scheduled` y la vista la muestra **atrasada** (`scheduleState`, core: `upcoming`, `due`, `overdue`; sin escribir nada), con Publicar ahora, Reprogramar, Desprogramar y Descartar. Con 12 h o menos de atraso sale al encender el worker.
- **Una a la vez:** el worker sigue tomando un `publication.publish` a la vez, así que un lote a la misma hora sale en fila (en la demo de F3, ~1 min un carrusel y ~2 min un reel).
- Si la cola no está (`QUEUE_UNAVAILABLE`), las que pasaron a `publishing` quedan así y las recoge la vigilancia (§4.6).
- Mientras una publicación espera su turno en la fila (un lote grande), la agenda la muestra "publicando", no atascada: atascada es solo una `publishing` con `updated_at` de más de 70 min (§4.6; `agendaItems` es pura y no ve la cola).

### 4.5 Reintentos, espera ante límites y causa legible (ADR-0018)
- **Backoff exponencial:** `publication.publish` pasa a 3 reintentos desde 60 s con backoff (1, 2 y 4 min); el tope de 12 min por intento y los 15 min de vida no cambian. `publication.sync` sigue igual.
- **Espera automática ante un límite de Instagram:** core no nombra códigos de plataforma (como `publication-operations.ts`): espera cuando el error trae la señal genérica `details.waitMinutes` (un número), que solo ponen los errores de límite del publisher de Instagram. Con `IG_RATE_LIMITED` (espera = la de la cabecera de uso cuando la trae, o 60 min) o `IG_PUBLISH_LIMIT` (6 h: la API no dice cuándo se libera un cupo de su ventana móvil de 24 h, nota de Instagram §6.1; la nota sugiere calcularlo desde la publicación propia más antigua de las últimas 24 h, pero con un operador y pocas publicaciones el límite no se espera alcanzar, así que un plazo fijo es una simplificación consciente), el intento **no** deja `failed`: pasa `publishing` → `scheduled` con `scheduled_at = ahora + espera` y `reason: "rate_limit"`, y el `publish_attempt` registra `result: "rescheduled"` (se suma a `PUBLISH_ATTEMPT_RESULTS`) con `retryAt`. El progreso se conserva: el publisher de Instagram ya rehace los contenedores vencidos (`resume`, `EXPIRED` → nuevos). Como mucho **3 esperas seguidas** por publicación (contadas en la bitácora desde el último paso del operador); la cuarta deja `failed` con el código. A la hora vuelve a pasar por el disparo (§4.4), con la regla de atrasadas.
- `ML_RATE_LIMITED` sigue reintentándose con la cola (es reintentable). Marketplace nunca espera sola: sus errores no se reintentan (spec F5, D12).
- **Causa legible:** `publicationErrorAdvice(code)` (core, puro) da, para cada código que puede quedar en `last_error`, qué hacer en una frase ("reconecta la cuenta en Cuentas", "corrige la planilla y vuelve a cargarla", "espera y reintenta", "revisa la ventana de Facebook"…), y un texto genérico para los demás. El panel y la CLI lo muestran bajo el error, junto al mensaje que ya existe. Un test revisa que cada código de error de publicación conocido tenga su consejo o caiga a propósito en el genérico.

### 4.6 Vigilancia periódica (job `publications.watch`, ADR-0018)
- **Cron cada hora** (`0 * * * *`, `America/Santiago`). Cola `exclusive` con clave fija, 1 reintento, 5 min. Al arrancar siguen corriendo directo `enqueueLiveSyncs` y `requeuePublishingPublications` (que reencola todas, también Marketplace: es el comportamiento de F5 al encender el worker, cuando el operador está presente; D7 se refiere a la vigilancia periódica): con la clave fija, una vuelta del arranque encolada como job podría quedar absorbida por el cron.
- **`watchPublications({ now })`** (core):
  1. Encola `publication.sync` (`enqueueSync`, sin repetir) de cada publicación de Portal en `live`, `published` o `paused`, con la cuenta conectada.
  2. **Deuda de F3:** reencola (`enqueuePublication`, `exclusive` por publicación: si ya tiene job, no hace nada) las `publishing` cuyo `updated_at` tiene más de 70 min (`STALE_PUBLISHING_MS`: un intento legítimo con 3 reintentos puede durar unos 55 min), **salvo Marketplace**: un formulario no se reabre sin el operador; esas quedan **atascadas** en la agenda con "Volver a encolar" (que ya existe).
  3. Registra cuántas encoló de cada tipo, sin datos del aviso.
- El vencimiento de Portal no escribe nada: lo calcula la vista desde `remote_state.stopTime` (§4.7).

### 4.7 Portal: actualizar, republicar y vencimiento (ADR-0020)
- **Actualizar un aviso publicado** (`updatePortalPublication`, `POST /publications/:id/update { confirmed? }`): para una publicación de Portal `published` o `paused` cuando **la propiedad cambió** (`listing_source_hash` distinto del actual, por ejemplo un precio nuevo en la planilla) o **hay un texto de Portal aprobado más nuevo** que el suyo (una corrida nueva de textos, aprobada). No se edita el texto aprobado de una publicación activa (ADR-0014 sigue igual): se prepara un texto nuevo, se aprueba y se actualiza.
  - Arma el ítem con `buildPortalItem` (el texto aprobado vigente y la propiedad de hoy) y manda solo lo que cambió: título, precio y atributos con `PUT /items/{id}`, siempre con `seller_contact` completo y con los `id` de las **fotos actuales** del ítem (nota §13: desde el 12/03/2026 una actualización de un `silver` sin `pictures` se rechaza), y la descripción con `PUT /items/{id}/description?api_version=2`. Nunca cambia las fotos ni la categoría: si la hoja cambió (otro tipo u operación), `PORTAL_UPDATE_NEEDS_RELIST` (409: cerrar y republicar).
  - Como las operaciones de F4 (síncrona en la API, ADR-0020): la plataforma **fuera** del candado, con un solo tope de 15 s para todas las llamadas (`OPERATION_TIMEOUT_MS`) y las fotos de `progress.pictureIds` (sin leer el ítem antes); dentro, `replacePublishedSource` (nuevo, condicional en el estado y el `updatedAt` leídos) re-fija `content_id`, `listing_source_hash` y `progress.sellerContact` (pausar, reactivar y cerrar lo leen de ahí), con un evento `manual_edit` (`{ mode, fields, remote? }`, con su esquema). Es la única forma en que una publicación activa cambia lo fijado (modifica ADR-0014 punto 2). En `live` pide `confirmed` (`UPDATE_NOT_CONFIRMED`; un cambio de precio puede hacer que Mercado Libre lo pause por moderación) y pide un sync en 30 s; una respuesta perdida también pide el sync. Una publicación en `dry_run` se actualiza en simulación, sin llamar (ADR-0016); una en `live` con la API en `dry-run` es `PUBLISH_MODE_MISMATCH`, como pausar o cerrar.
- **Republicar** (`relistPublication`, `POST /publications/:id/relist`): para una publicación de Portal `unpublished`, con la propiedad en `ready` o `active` y el texto de Portal aprobado. En `live` (la API en vivo), una publicación en `live` cuyo ítem quedó cerrado o vencido (`remote_state`); a cualquier plazo (pasados 60 días solo se pierden las visitas, y la vista lo dice). En simulación, una publicación en `dry_run`, sin `remote_state`: la nueva también es una simulación. Nunca se republica una `dry_run` con la API en vivo (su ítem no existe: `RELIST_NOT_ALLOWED`) ni una `live` con la API en simulación (`PUBLISH_MODE_MISMATCH`). Crea una publicación **nueva** (`NewPublication.relistedFrom` = la anterior, que queda con su historia; un único parcial sobre `relisted_from`, sin contar las descartadas, impide republicar dos veces la misma) y la publica con el job de siempre: `buildPublishInput` suma al input de Portal `relistOf: { externalId }` (el ítem anterior; cambia `PublishInput`, contrato en `01-arquitectura.md`) y el publisher de Portal, dentro de `publish`, en vez de `POST /items`, llama a `POST /items/{id_anterior}/relist` con `{ price, quantity: 1, listing_type_id: "silver" }` (nota §13, DOC), guarda el id nuevo en el progreso **antes** de seguir, y después lee el ítem nuevo y repone lo que falte con `PUT` (como Actualizar: `seller_contact`, fotos, atributos) y la descripción (el ejemplo de la doc la trae vacía). Nunca repite el `relist` a ciegas: con `relistRequestedAt` y sin id nuevo, busca el ítem por `seller_custom_field` (como `POST /items` en F4) y, si no hay exactamente uno, `ML_PUBLISH_OUTCOME_UNKNOWN`. Solo se puede republicar **una vez por ítem padre**; si Mercado Libre lo rechaza de forma definitiva, el publisher guarda `relistRejected: true` en el progreso antes de lanzar, la publicación queda `failed` con la causa y "Reintentar" publica un ítem nuevo (`POST /items`). En `dry_run`, simulación sin llamar. En `live` pide confirmación (`RELIST_NOT_CONFIRMED`): usa un cupo del paquete (INFERENCIA fuerte de la nota). Lo NO VERIFICADO (si el `relist` exige `seller_contact`, qué copia del padre) se confirma en la prueba en vivo de Portal con el usuario de prueba (pendiente de F4, nota §13.5).
- **Vencimiento:** `portalExpiry(remoteState, now)` (core, puro) → días que le quedan según `stopTime`; con **7 días o menos** (`PORTAL_EXPIRY_NOTICE_DAYS`), la agenda y la tarjeta dicen "vence en N días"; vencido (el sync lo dejó `unpublished` con `expired`), "venció: republícalo". Un arriendo dura 45 días en Portal y una venta 180.

### 4.8 La propiedad manda (ADR-0019)
- **`LISTING_MANUAL_TRANSITIONS` nueva** (el operador; el sistema sigue moviendo `ready ↔ active` al publicar y al retirar):

  | Desde | Lista (`ready`) | Pausar | Reanudar | Cerrar (vendida, arrendada, retirada) | Reabrir | Archivar |
  |---|---|---|---|---|---|---|
  | `draft` | ✓ (con al menos una foto, como hoy) | — | — | — | — | ✓ |
  | `ready` | — | ✓ | — | ✓ | — | ✓ |
  | `active` | — | ✓ | — | ✓ | — | — (cerrar primero) |
  | `paused` | — | — | ✓ | ✓ | — | ✓ |
  | `closed` | — | — | — | — | ✓ | ✓ |
  | `archived` | — | — | — | — | ✓ | — |

  Reanudar y reabrir dejan la propiedad en `active` si le queda algo publicado en vivo (por ejemplo un post de Instagram que todavía no se borró) y si no, en `ready`.
- **Qué le pasa a cada publicación** (`changeListingStatus` reescrito; `POST /listings/:id/status { action, reason?, confirmed? }`):

  | Publicación | Pausar | Reanudar | Cerrar | Archivar |
  |---|---|---|---|---|
  | `approved`, `failed` | sigue | sigue | `cancelled` | `cancelled` |
  | `scheduled` | `approved` (desprogramada) | sigue | `cancelled` | `cancelled` |
  | `publishing` | 409 `PUBLICATION_IN_PROGRESS` | — | 409 | 409 |
  | `awaiting_manual_confirm` | 409 `MANUAL_CONFIRM_PENDING` | — | 409 | 409 |
  | Portal `published` | `paused` (con `byListing`) | `published` (solo las que pausó la propiedad) | cerrada (`unpublished`, D3) | 409 `LISTING_HAS_LIVE_PUBLICATIONS` |
  | Portal `paused` | sigue | sigue | cerrada | 409 |
  | Instagram o Marketplace `published` en `live` | sigue (no se pausan) | sigue | sigue `published` y pasa a la lista de **tareas a mano** (D4) hasta "Marcar como retirada" | 409 |
  | Instagram o Marketplace `published` en `dry_run` | sigue | sigue | `unpublished` (simulación: no hay nada que borrar a mano) | 409 |

- **Tres fases** (para no cerrar Portal y después descubrir que la propiedad no se podía cerrar):
  1. **Dentro del candado:** valida la acción contra la tabla, el motivo (`CLOSE_REASON_REQUIRED`), la confirmación (`LISTING_ACTION_NOT_CONFIRMED`) y el modo (una publicación en `live` con la API en `dry-run`: `PUBLISH_MODE_MISMATCH`, como las operaciones de F4); devuelve los 409 de la tabla; y desprograma o descarta las pendientes. Si no hay nada que hacer en Portal, aplica también la fase 3 en la misma transacción. Mientras corre la fase 2 la propiedad sigue `ready` o `active`, así que el operador, `auto_publish` o el disparo **pueden** abrir o empezar otra publicación en ese momento: la fase 3 lo revisa de nuevo.
  2. **Fuera del candado:** las llamadas a Portal (pausar, reactivar o cerrar) con las piezas de las operaciones de F4 (`operatePublication`, con una opción para **no** devolver la propiedad a `ready`: lo decide la fase 3). Si una falla, se detiene con su error: lo ya aplicado queda aplicado y repetir la acción lo salta; la propiedad no cambió.
  3. **Dentro del candado otra vez:** **relee** la propiedad y sus publicaciones, vuelve a validar la acción contra el estado actual (si apareció una `publishing` o `awaiting_manual_confirm`, 409 como en la fase 1; si apareció una pendiente nueva, la desprograma o descarta igual que la fase 1) y aplica el cambio (con `close_reason` al cerrar) y las publicaciones simuladas de Instagram y Marketplace. Si la propiedad cambió en medio, `INVALID_TRANSITION` y el operador repite. Desde aquí la propiedad ya no está en `ready` ni `active` (salvo reanudar y reabrir), así que nada nuevo puede empezar.
  El resultado dice qué cambió, qué quedó como tarea a mano y qué no se pudo.
- **Marca `byListing`:** va en el `payload` del `status_changed` de pausar (`{ mode, operation, remote?, byListing: true }`, se documenta en `02-modelo-datos.md`); reanudar busca esas.
- **Confirmación:** cerrar pide `confirmed` siempre (cerrar en Portal es definitivo en `live`); pausar y archivar, solo si hay algo que cambiar (Portal en vivo, o pendientes que se descartan o desprograman). Las publicaciones en `dry_run` se cambian en simulación, sin llamar.
- **Tareas a mano** (derivadas, sin tabla): publicaciones de Instagram o Marketplace `published` en `live` de una propiedad `closed`. "Marcar como retirada" (F3) las cierra, con la confirmación de que se borró a mano; con la última, la propiedad sigue `closed`.
- **Reabrir** borra `close_reason` y no publica nada: se vuelve a publicar o se republica Portal (§4.7).
- La carga (Excel) sigue sin tocar el estado: una propiedad cerrada que vuelve en la planilla sigue cerrada.
- **Hasta T10** la ruta `PATCH /listings/:id/status` sigue funcionando sobre el caso de uso nuevo (T08 la adapta), para que el panel no se rompa entre lotes: `ready` desde `draft` es la acción "lista", desde `paused` es reanudar y desde `archived` es reabrir; `paused` es pausar y `archived` es archivar; siempre sin `confirmed`, así que lo que pide confirmación responde `LISTING_ACTION_NOT_CONFIRMED` (409) hasta los botones nuevos de T13, y cerrar no existe por esa ruta.

### 4.9 Seguimiento y agenda
- **`GET /tracking?broker=`**: una fila por propiedad (no archivada, salvo `?archived=1`) con su estado, `close_reason`, portada y, por plataforma (Instagram, Portal, Marketplace), una celda: el estado de cada formato, el modo, el enlace (`https`), la hora programada y si está atrasada, el vencimiento de Portal, el error con su consejo y si hay una tarea a mano. La arma `trackingRow` (core, pura) con `PublicationRepository.listForTracking` (las activas y las terminales de los últimos 30 días, de los avisos del corredor).
- **`GET /agenda?broker=`**: `agendaItems` (core, pura), en este orden: **atrasadas**, **te toca** (Marketplace con la hora vencida, a cualquier atraso), **atascadas** (`publishing` con `updated_at` de más de 70 min), **falladas**, **tareas a mano**, **por vencer** (Portal, 7 días), **próximas** (programadas en los próximos 7 días), y, desde T14, el estado del **respaldo** (último y si tiene más de 48 h). Cada ítem trae la propiedad, la plataforma, el formato y la acción sugerida.
- **Panel:** página **Seguimiento** en el menú (`/seguimiento`): la agenda arriba y la matriz abajo (filas por propiedad, columnas Instagram, Portal y Marketplace; cada celda enlaza al detalle de la propiedad, pestaña del canal). Lee al abrir y cada 60 s solo con la pestaña a la vista (ADR-0007).
- **CLI:** `agentsales agenda` (la misma lista, con los comandos para cada acción) y `agentsales tracking` (la matriz en una tabla compacta; `--json`).

### 4.10 `auto_publish` por corredor (D5, ADR-0019)
- **Activarlo:** `PATCH /brokers/:id { autoPublish }` (`BrokerRepository.setAutoPublish`), `agentsales brokers auto-publish <slug> on|off` (pregunta siempre; `--yes`) y un interruptor por corredor en **Cuentas**, que al activarlo avisa en rojo si la API está en vivo: "publicará sin tu revisión".
- **Qué hace** (`autoPublishListing`, core; lo llama el worker cuando `content.prepare` termina bien con textos): si el corredor tiene `auto_publish` y la propiedad está en `ready` o `active`, por cada canal con cuenta conectada:
  - aprueba el texto vigente **si su revisión no tiene errores** (`approveContent`, actor `system`); con errores, nada (queda para el operador y la agenda lo muestra como "espera tu revisión");
  - Instagram y Portal: publica de inmediato (`publishListing`, actor `system`, con el modo **del worker**: es el único camino en que el worker fija el modo). **Advertencia en vivo:** con `pnpm dev` la API y el worker reciben el mismo `PUBLISH_MODE` (`05-convenciones.md`), así que la API lo usa como el del worker: `/health` suma `autoPublishBrokers` (los corredores con `auto_publish`) y, si la lista no está vacía y el modo es `live`, `status` y `doctor` (T11) y el panel (T13) lo dicen en rojo: "publica sin tu revisión"; si falta algo para Portal, solo aprueba y la agenda lo dice; `NOTHING_TO_PUBLISH` (ya publicada) es "nada que hacer", no un fallo;
  - Marketplace: aprueba y lo deja **programado como recordatorio** para ahora, por el camino interno sin margen (§4.3; aparece en "te toca"); nunca abre Facebook.
- Un fallo de `auto_publish` no hace fallar la corrida de contenido: se registra (código, sin datos del aviso) y la agenda lo muestra.

### 4.11 Respaldo local (seguimiento de ADR-0007)
- **`pnpm db:backup`** (lo puede correr el operador; no necesita `pnpm dev`) y el job **`db.backup`** (cron diario a las 13:00 de Chile y al arrancar si el último tiene más de 20 h; `exclusive`, 1 reintento, 15 min): corre `pg_dump` del sistema con formato propio (`-Fc`), `--no-owner`, `--no-acl` y `--exclude-schema=pgboss` (la cola entera fuera: con pg-boss 12 las colas son particiones y el worker las recrea al arrancar sobre una base restaurada; así tampoco vuelven a correr jobs viejos). Escribe a `<nombre>.dump.partial`, corre `pg_restore --list` para comprobar que se lee y recién entonces lo renombra a `.dump`; un volcado que falla se borra y no cuenta.
- **Dónde:** `BACKUP_DIR` (por defecto `~/.agentsales/backups`; como `BROWSER_PROFILES_DIR`, absoluta y **fuera del proyecto**: trae datos de clientes y tokens cifrados), carpeta `0700` y archivos `0600`, `agentsales-AAAAMMDD-HHMM.dump`. Se guardan los **últimos 14**; los más viejos se borran solo después de un respaldo exitoso (solo archivos con ese nombre), así un volcado roto nunca desplaza a los buenos.
- **Seguridad:** la conexión va por variables de entorno del proceso (`PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE=verify-full` y `PGSSLROOTCERT=system`, que libpq 16 o más necesita para usar los certificados del sistema), nunca en los argumentos ni en el log. Un error se resume (código y salida de `pg_dump` pasada por el redactor).
- **Requisito:** `pg_dump` y `pg_restore` del cliente de Postgres con versión mayor o igual a la de Neon (nota `neon-backup.md`: probablemente Postgres 18; `pg_dump` se niega a volcar un servidor más nuevo). Homebrew `libpq` (18.6) no queda en el `PATH` (keg-only): `PG_BIN_DIR` (opcional) apunta a su carpeta y, si falta, se busca en el `PATH` y en `/opt/homebrew/opt/libpq/bin`. `doctor` (que corre en la CLI y no abre la base) compara la versión del cliente con la del servidor que informa `/health` (`database.serverVersion`, nuevo); `/health` y la agenda muestran la hora del último respaldo.
- **Restaurar:** paso a paso en `docs/08-guia-operador.md` con `pg_restore` a una base nueva (lo hace el operador), con la advertencia de que las credenciales guardadas solo se leen con la **misma** `APP_ENCRYPTION_KEY`.

### 4.12 Datos
- **Migración `0008`:** índice parcial `publications_scheduled_due` `(scheduled_at) WHERE status = 'scheduled'`; columna `publications.relisted_from uuid null` (FK a `publications`, sin cascada) con el único parcial `publications_relisted_from_unique` `(relisted_from) WHERE relisted_from IS NOT NULL AND status <> 'cancelled'` (descartar una republicación antes de que salga permite intentarlo de nuevo) (una sola republicación por publicación, como Mercado Libre: una por ítem padre). Sin tipos nuevos: `scheduled` (estado de la publicación) y `closed` (estado de la propiedad) ya existen.
- `PublicationChanges` suma `scheduledAt` (se escribe con `scheduled` y se borra al salir) y exige `dryRun` también al pasar a `scheduled`. `PublicationRepository` suma `reschedule` y `replacePublishedSource` (condicionales; §4.2 y §4.7). `content_id` y `listing_source_hash` se pueden re-fijar en una publicación de Portal publicada, solo por Actualizar (ADR-0020). `status_changed` suma `byListing?` y `reason?`. `PUBLICATION_EVENT_TYPES` suma `schedule_changed`; `manual_edit` estrena su esquema; `PUBLISH_ATTEMPT_RESULTS` suma `rescheduled`. Todos los campos nuevos de los eventos son opcionales: las filas anteriores se siguen leyendo.
- `listings.close_reason` se escribe por primera vez (al cerrar) y se borra al reabrir. `brokers.auto_publish` se escribe por primera vez.
- `.env.example`: `BACKUP_DIR` y `PG_BIN_DIR`.

### 4.13 Contratos (API, ADR-0011)
| Método y ruta | Cuerpo | Respuesta |
|---|---|---|
| `POST /publications/:id/schedule` | `{ at }` | 200, la publicación |
| `POST /publications/:id/unschedule` | — (JSON vacío) | 200, la publicación |
| `POST /schedule` | `{ listingIds, platforms?, at, spacingMinutes? }` | 200, `{ results: [{ listingId, platform, outcome, code?, message? }], notes? }` |
| `POST /listings/:id/status` | `{ action: "ready" \| "pause" \| "resume" \| "close" \| "reopen" \| "archive", reason?: "sold" \| "rented" \| "withdrawn", confirmed? }` | 200, `{ listing, changed, manualTasks, skipped }` (reemplaza `PATCH /listings/:id/status` en T10) |
| `POST /publications/:id/update` | `{ confirmed? }` | 200, la publicación |
| `POST /publications/:id/relist` | `{ confirmed? }` | 202, la publicación nueva |
| `GET /tracking` | `?broker=&archived=` | 200, filas |
| `GET /agenda` | `?broker=` | 200, ítems |
| `PATCH /brokers/:id` | `{ autoPublish }` | 200, el corredor |

Errores nuevos: `SCHEDULE_TOO_SOON`, `SCHEDULE_TOO_FAR` y `CLOSE_REASON_REQUIRED` (400; no calzan con ningún patrón de la tabla: van con fila propia, como `MARKETPLACE_URL_REQUIRED`); `LISTING_HAS_LIVE_PUBLICATIONS`, `PORTAL_UPDATE_NEEDS_RELIST`, `PORTAL_NOTHING_TO_UPDATE`, `RELIST_NOT_ALLOWED`, `LISTING_ACTION_NOT_CONFIRMED`, `UPDATE_NOT_CONFIRMED` y `RELIST_NOT_CONFIRMED` (409, como `CLOSE_NOT_CONFIRMED`); `PUBLISH_MODE_MISMATCH` también al cambiar la propiedad; `BACKUP_TOOL_NOT_INSTALLED` y `BACKUP_FAILED` (no llegan a la API; 503 y 500 por si llegaran). Los códigos nacen en core con su tarea (T02, T07, T08, T14) y T10 los suma a `apps/api/src/errors.ts` y a la tabla de `05-convenciones.md`.

### 4.14 Jobs (seguimiento de ADR-0005)
| Cola | Unicidad | Reintentos | Expira | Cron |
|---|---|---|---|---|
| `publication.publish` | sin cambios (`exclusive` por publicación) | **3**, desde 60 s con backoff | 15 min | — |
| `publication.due` | `exclusive`, clave fija | 0 | 2 min | cada minuto, y al arrancar |
| `publications.watch` | `exclusive`, clave fija | 1 | 5 min | cada hora (al arrancar corren directo las dos vueltas de hoy) |
| `db.backup` | `exclusive`, clave fija | 1, desde 5 min | 15 min | 13:00 de Chile, y al arrancar si el último tiene más de 20 h |

Los tres crons usan `missed: "skip"` (como `tokens.refresh`): lo perdido con el worker apagado lo cubre lo que corre al arrancar.

### 4.15 Decisiones (aprobación permanente del operador; D2 a D5 las respondió él el 2026-10-15)
- **D1 · Lo programado vive en la base y un reloj por minuto lo despierta** (ADR-0018): no se encola un job con `startAfter` por cada programada. Así desprogramar, reprogramar o cerrar la propiedad son cambios de estado sin jobs huérfanos, y la regla de atrasadas se aplica en un solo lugar. El costo es una consulta por minuto mientras el worker corre (Neon ya está despierto con el worker).
- **D2 · Atrasadas (respuesta del operador):** si el worker estaba apagado a la hora, una programada sale al encenderlo si el atraso es de **12 h o menos**; si es mayor, queda **atrasada** y el operador elige.
- **D3 · Vendida o arrendada cierra el aviso de Portal (respuesta del operador):** cerrar es definitivo; si el negocio se cae, se reabre la propiedad y se republica. Para una propiedad reservada está "Pausar propiedad".
- **D4 · Instagram y Marketplace quedan como tareas a mano (respuesta del operador):** al cerrar la propiedad, sus posts siguen publicados (no se pueden borrar por API, y Marketplace no se automatiza) y aparecen en la agenda hasta que el operador los borra y marca como retirados.
- **D5 · `auto_publish` aprueba y publica de inmediato (respuesta del operador):** solo los textos sin errores, en Instagram y Portal; Marketplace queda como recordatorio. Con la API en vivo, publica de verdad sin revisión: por eso se activa con confirmación y el panel lo advierte.
- **D6 · Espera automática solo ante los límites de Instagram,** con un tope de 3 esperas seguidas (§4.5). Los demás errores no reintentables siguen dejando `failed`.
- **D7 · La vigilancia nunca reabre un formulario de Marketplace:** una `publishing` de Marketplace atascada espera al operador (§4.6).
- **D8 · Actualizar Portal no edita el texto aprobado** (ADR-0020): usa un texto nuevo ya aprobado o la propiedad cambiada, y re-fija lo que la publicación tiene fijado en el mismo paso que lo envía (la única excepción a ADR-0014 punto 2). Las fotos y la categoría no se editan.
- **D9 · Republicar es una publicación nueva** que recuerda la anterior (`relisted_from`): la historia de la vieja queda como estaba.
- **D10 · Avisos solo dentro del sistema** (agenda del panel y de la CLI), con 7 días para el vencimiento de Portal.
- **D11 · El respaldo vive fuera del proyecto y del bucket:** en el disco del operador, con los últimos 14; no se sube a R2 (sería sacar datos de clientes a otro servicio) ni a git.
- **D12 · El lote se programa a la misma hora por defecto,** con espaciado opcional (`spacingMinutes`); el worker igual publica de a una.
- **D13 · Publicar ahora adelanta lo programado:** publicar una publicación o el canal arranca también las `scheduled` (§4.3).
- **D14 · La propiedad se cambia en tres fases** (§4.8): validar y soltar lo pendiente, llamar a Portal fuera del candado, y releer antes de aplicar.

### 4.16 Dependencias nuevas
Ninguna de npm. **`pg_dump` y `pg_restore`** del sistema (cliente de Postgres, Homebrew `libpq`), como ffmpeg: los revisa `doctor` y los instala el operador. La CI no los necesita (los tests usan un ejecutable falso, como el de ffmpeg y el de la CLI de Claude).

## 5. Tareas
ADR-0018, ADR-0019 y ADR-0020 se registran con la aprobación del spec (en su mismo PR). Un PR por lote (orden al final).

### F6-T01 · Máquina, datos y repositorios del calendario (ADR-0018)
- **Depende de:** —
- **Archivos:** `packages/core/src/{publication-state.ts,publication.ts,jobs.ts,ports/publication-repository.ts,enums.ts}`, `packages/core/src/testing/`, `packages/db/src/{schema.ts,repositories/publications.ts}`, `packages/db/drizzle/0008_*.sql`, `docs/01-arquitectura.md`, `docs/02-modelo-datos.md`
- **Descripción:** las transiciones nuevas (§4.2), `scheduledAt` en `PublicationChanges` (solo con `scheduled`; se borra al salir) y `dryRun` obligatorio al pasar a `scheduled`, `schedule_changed` y su esquema, `rescheduled` en los resultados del intento, `byListing` y `reason` en `status_changed`, `relisted_from` (con `NewPublication.relistedFrom` y su único parcial), `reschedule`, `replacePublishedSource`, `listDue({ now, since, excludePlatforms, limit })`, `listStalePublishing(before)` y `listForTracking(brokerId, since)` en los dos repositorios, la migración `0008` y los nombres de jobs `publication.due` y `publications.watch` con sus esquemas (`db.backup` lo suma T14).
- **Hecho cuando:**
  - [x] Tests de la máquina (cada transición nueva y que las viejas no cambien), de los esquemas de eventos (filas viejas siguen leyéndose) y de los repositorios en PGlite y en memoria con los mismos fixtures (`scheduled_at` se borra al salir; `dryRun` exigido al programar; `listDue` en orden, con tope, sin las de más de 12 h ni las de las plataformas excluidas; `reschedule` y `replacePublishedSource` no pisan un cambio que llegó antes; el único de `relisted_from`)
  - [x] `pnpm db:generate` sin diferencias después de la migración; docs 01 y 02 al día

### F6-T02 · Programar, reprogramar y desprogramar (core)
- **Depende de:** T01
- **Archivos:** `packages/core/src/use-cases/{schedule-publications.ts,publication-start.ts}`, `packages/core/src/schedule.ts`
- **Descripción:** `schedulePublication`, `scheduleListings` (una o varias propiedades, espaciado, resultado por propiedad y canal, aviso de más de 3 recordatorios de Marketplace por día), `unschedulePublication`, `scheduleState`, los límites de la hora y el camino interno sin margen para `auto_publish` (§4.3); la revisión compartida con publicar, sin el límite del día ni el formulario abierto para Marketplace; `STARTABLE_STATUSES` suma `scheduled` (publicar ahora adelanta lo programado, D13).
- **Hecho cuando:**
  - [x] Tests con el escenario de core: cada forma, cada rechazo (los mismos de publicar, más `SCHEDULE_TOO_SOON` y `SCHEDULE_TOO_FAR`), el modo fijado al programar, reprogramar deja `schedule_changed`, un lote con una propiedad que falla sigue con las demás, Marketplace se programa como recordatorio aunque hoy haya un formulario abierto o se haya alcanzado el límite, publicar ahora arranca una programada
  - [x] Docs 01 al día

### F6-T03 · El disparo (`publication.due`)
- **Depende de:** T02
- **Archivos:** `packages/core/src/use-cases/start-due-publications.ts`, `apps/worker/src/jobs/publication-due.ts`, `apps/worker/src/worker.ts`
- **Descripción:** `startDuePublications` (§4.4) con la regla de atrasadas (12 h), Marketplace fuera, el modo de cada publicación, el tope de 20 y el encolado después del candado; el job con su cron y la vuelta del arranque.
- **Hecho cuando:**
  - [x] Tests: una vencida pasa a `publishing` con su propio modo (no el del worker) y se encola; una atrasada más de 12 h no se toca; con 20 o más atrasadas y recordatorios de Marketplace vencidos, una vencida normal igual sale en la primera vuelta; una de Marketplace no se toca; una que ya no se puede publicar queda `failed` con su motivo; dos vueltas seguidas no la empiezan dos veces; la cola caída deja `publishing`
  - [x] Test del job con reloj falso; docs 01 (cola de trabajos) al día

### F6-T04 · Reintentos, espera ante límites y causa legible
- **Depende de:** T01
- **Archivos:** `packages/core/src/use-cases/publish-publication.ts`, `packages/core/src/publish/error-advice.ts`, `packages/publishers/src/instagram/errors.ts`, `apps/worker/src/jobs/publication-publish.ts`
- **Descripción:** la política nueva de `publication.publish` (3 reintentos); la espera por la señal genérica `details.waitMinutes` → `scheduled` con el tope de 3 (§4.5), que solo ponen `IG_RATE_LIMITED` (con la cabecera de uso o 60 min) e `IG_PUBLISH_LIMIT` (6 h) en el publisher de Instagram (la transición a `scheduled` pasa `publication.dryRun`, que la regla nueva exige); `publicationErrorAdvice`.
- **Hecho cuando:**
  - [ ] Tests: un límite deja `scheduled` con la hora correcta y el evento `rescheduled`; la cuarta espera seguida deja `failed`; un paso del operador reinicia la cuenta; Marketplace y Portal no esperan; el progreso se conserva; cada código conocido tiene su consejo
  - [ ] Docs 01 y nota de Instagram (§7) al día

### F6-T05 · Vigilancia periódica (`publications.watch`)
- **Depende de:** T01
- **Archivos:** `packages/core/src/use-cases/watch-publications.ts`, `apps/worker/src/jobs/publications-watch.ts`, `apps/worker/src/worker.ts`
- **Descripción:** `watchPublications` (§4.6): el sync de Portal en vivo y el reencolado de las `publishing` de más de 70 min (salvo Marketplace); el job con su cron. Las dos vueltas del arranque siguen como están. Cierra la deuda de F3 en ESTADO.
- **Hecho cuando:**
  - [ ] Tests: encola los syncs sin repetir; reencola una `publishing` de más de 70 min y no una reciente; nunca una de Marketplace; un fallo en una no corta las demás
  - [ ] Docs 01 al día; deuda de F3 cerrada en ESTADO

### F6-T06 · Mercado Libre: editar y republicar (cliente)
- **Depende de:** — (nota de Mercado Libre ampliada)
- **Archivos:** `packages/publishers/src/mercadolibre/{items.ts,errors.ts}`, `packages/publishers/test/`
- **Descripción:** `update` (`PUT /items/{id}` con título, precio, atributos, `seller_contact` completo y los `id` de las fotos actuales), `updateDescription` (`PUT /items/{id}/description?api_version=2`) y `relist` (`POST /items/{id}/relist` con `price`, `quantity: 1` y `listing_type_id`), con sus errores (los `seller_contact.*` de la nota, en español) y el 409 de bloqueo optimista, que se reintenta.
- **Hecho cuando:**
  - [ ] Tests de contrato con msw (cuerpos enviados, `seller_contact` y `pictures` siempre en `update`, ids validados sin llamar, errores y causas en español sin datos del aviso)
  - [ ] Nota de Mercado Libre y docs 01 al día

### F6-T07 · Portal: actualizar, republicar y vencimiento (core)
- **Depende de:** T01, T06
- **Archivos:** `packages/core/src/use-cases/{update-portal-publication.ts,relist-publication.ts}`, `packages/core/src/publish/input.ts` (`relistOf`), `packages/core/src/ports/publisher.ts`, `packages/core/src/portal/expiry.ts`, `packages/publishers/src/mercadolibre/{publisher.ts,operations.ts}`, `apps/worker/src/portal.ts`, `apps/api/src/portal.ts`
- **Descripción:** §4.7: actualizar (qué cambió, `PORTAL_UPDATE_NEEDS_RELIST`, un tope de 15 s para todas las llamadas, `replacePublishedSource` con `sellerContact`, `manual_edit`, sync en 30 s, simulación), republicar (publicación nueva con `relistedFrom`; `PublishInput` de Portal suma `relistOf`; `portalProgressSchema` suma `relistRequestedAt` y `relistRejected`, opcionales; el publisher retoma sin repetir el `relist` y repone lo que falte) y `portalExpiry`.
- **Hecho cuando:**
  - [ ] Tests: actualizar solo lo que cambió, nada que actualizar (`PORTAL_NOTHING_TO_UPDATE`), categoría distinta, simulación sin llamar, la respuesta perdida pide un sync; republicar (`relist` y reposición de la descripción), un `relist` rechazado que deja `failed` y cuyo reintento publica un ítem nuevo, republicar en simulación una `dry_run` sin `remote_state`, una `dry_run` con la API en vivo (`RELIST_NOT_ALLOWED`), actualizar una `live` con la API en simulación (`PUBLISH_MODE_MISMATCH`), el reintento que no repite el `relist`, y republicar dos veces la misma (`RELIST_NOT_ALLOWED`); los días al vencimiento en hora de Chile
  - [ ] Docs 01 (contrato del Publisher y `PublishInput`) y 02 al día; seguimiento de ADR-0015

### F6-T08 · La propiedad manda (core, ADR-0019)
- **Depende de:** T01
- **Archivos:** `packages/core/src/{listing.ts,use-cases/change-listing-status.ts,use-cases/publication-operations.ts}`, `packages/core/src/tracking/manual-tasks.ts`, `packages/core/src/testing/` (dobles), `packages/db/src/repositories/listings.ts`, `apps/api/src/routes/listings.ts` (el `PATCH` sobre el caso de uso nuevo, hasta T10)
- **Descripción:** `LISTING_MANUAL_TRANSITIONS` nueva y `changeListingStatus` que orquesta en tres fases (§4.8): validar y soltar lo pendiente dentro del candado, Portal fuera (`operatePublication` sin devolver la propiedad a `ready`), y releer y aplicar dentro (`close_reason`); las pausas `byListing`, las confirmaciones, el modo, las tareas a mano y los 409. La ruta `PATCH` actual sigue funcionando.
- **Hecho cuando:**
  - [ ] Tests por fila de las dos tablas de §4.8 (cada acción × cada estado de publicación), una falla de Portal a mitad que no cambia la propiedad y se puede repetir, un cambio de la propiedad y una publicación nueva que llegan entre la fase 1 y la 3, la simulación sin llamar (Instagram simulada pasa a `unpublished`), reanudar solo lo que pausó la propiedad, reabrir con un post en vivo deja `active`, reabrir borra el motivo; la ruta `PATCH` sigue pasando sus tests
  - [ ] Docs 01 y 02 al día; deuda de F3 (`LISTING_MANUAL_TRANSITIONS`) cerrada

### F6-T09 · `auto_publish` (core y worker)
- **Depende de:** T02 (recordatorio de Marketplace), T08
- **Archivos:** `packages/core/src/use-cases/auto-publish-listing.ts`, `packages/core/src/ports/broker-repository.ts`, `packages/core/src/testing/` (dobles), `packages/db/src/repositories/brokers.ts`, `apps/worker/src/jobs/content-prepare.ts`
- **Descripción:** §4.10: aprobar los textos sin errores, publicar Instagram y Portal, Marketplace como recordatorio, nunca hacer fallar la corrida; `setAutoPublish`.
- **Hecho cuando:**
  - [ ] Tests: corredor sin `auto_publish` no hace nada; con errores solo deja la revisión; Portal con lo que falta solo aprueba; ya publicada no es un fallo; el modo es el del worker; Marketplace queda programado para ahora y el disparo no lo toca; un fallo no cambia la corrida; repositorios en PGlite y memoria
  - [ ] Docs 01 y 02 al día

### F6-T10 · API del calendario, la propiedad, Portal y el seguimiento
- **Depende de:** T02, T05, T07, T08, T09, T14
- **Archivos:** `apps/api/src/routes/{publications.ts,listings.ts,schedule.ts,tracking.ts,brokers.ts}`, `apps/api/src/contracts/`, `apps/api/src/errors.ts`, `packages/core/src/tracking/{row.ts,agenda.ts}`, `apps/web/src/queries/listings.ts` (solo la llamada del cambio de estado)
- **Descripción:** las rutas de §4.13 sobre sus casos de uso, `trackingRow` y `agendaItems` (core, puras, para el panel y la CLI; la agenda con el estado del respaldo de T14), los errores nuevos con su HTTP (filas propias para `SCHEDULE_TOO_SOON`, `SCHEDULE_TOO_FAR` y `CLOSE_REASON_REQUIRED`), `autoPublishBrokers` en `/health` (§4.10). `POST /listings/:id/status` reemplaza el `PATCH`: la llamada del panel pasa a la ruta nueva en el mismo PR (los botones nuevos son de T13).
- **Hecho cuando:**
  - [ ] Tests de rutas con la API en proceso (cada ruta, el modo fijado por la API, confirmaciones, CSRF de los `POST` sin cuerpo) y de las reglas puras de la agenda y la matriz
  - [ ] Docs 01 y 05 (tabla de errores) al día

### F6-T11 · CLI del calendario y el seguimiento
- **Depende de:** T10
- **Archivos:** `apps/cli/src/commands/{schedule.ts,unschedule.ts,agenda.ts,tracking.ts,listing.ts,publications.ts,brokers.ts,publish.ts}`, `CLAUDE.md`
- **Descripción:** `schedule <id_propiedad…> --at "2026-10-19 10:00" [--platform] [--spacing <min>]` (hora de Chile; en vivo pide confirmación), `schedule --publication <id>`, `unschedule <id>`, `agenda`, `tracking [--json]`, `listing pause|resume|reopen|archive <id>` y `listing close <id> --reason vendida|arrendada|retirada` (confirmación donde corresponda, `--yes`), `publications update|relist <id>`, `brokers auto-publish <slug> on|off`; la advertencia en rojo de `auto_publish` en vivo en `status` y `doctor` (§4.10). Deuda de F3: el aviso de cola de `publish` dice "en cola o esperando su turno".
- **Hecho cuando:**
  - [ ] Tests contra la API en proceso (hora de Chile ida y vuelta, cambio de horario, confirmaciones, salida de la agenda con los comandos, la advertencia de `auto_publish` en vivo)
  - [ ] `CLAUDE.md` (comandos) y guía del operador al día

### F6-T12 · Panel: programar y Portal
- **Depende de:** T10
- **Archivos:** `apps/web/src/components/publications/`, `apps/web/src/pages/ListingsPage.tsx`, `apps/web/src/queries/`
- **Descripción:** Programar, Reprogramar y Desprogramar en cada publicación y en el canal (selector de fecha y hora de Chile, modo visible, confirmación en vivo); lote desde la lista de propiedades (casillas, canales, hora y espaciado, resultado por propiedad); "atrasada" con sus acciones; Marketplace "te toca"; Portal con Actualizar, Republicar y "vence en N días"; el consejo bajo cada error.
- **Hecho cuando:**
  - [ ] Tests de componentes con el arnés (cada acción, las confirmaciones, el lote con una propiedad que falla, hora de Chile)
  - [ ] Docs 01 (panel) al día

### F6-T13 · Panel: Seguimiento, acciones de la propiedad y `auto_publish`
- **Depende de:** T10
- **Archivos:** `apps/web/src/pages/TrackingPage.tsx`, `apps/web/src/routes.tsx`, `apps/web/src/pages/ListingDetailPage.tsx`, `apps/web/src/pages/AccountsPage.tsx`
- **Descripción:** la página Seguimiento (§4.9: agenda y matriz, relectura cada 60 s con la pestaña a la vista); en el detalle de la propiedad, Pausar, Reanudar, Vendida, Arrendada, Retirada, Reabrir y Archivar con su confirmación y el resultado (qué cambió y las tareas a mano); el interruptor de `auto_publish` en Cuentas con su advertencia, y el aviso en rojo en el panel cuando hay `auto_publish` con la API en vivo (§4.10).
- **Hecho cuando:**
  - [ ] Tests de componentes (la agenda en su orden, la matriz con cada estado, cada acción de la propiedad, el interruptor y su confirmación, el aviso en vivo)
  - [ ] Docs 01 (panel) y guía del operador al día

### F6-T14 · Respaldo local (`pg_dump`)
- **Depende de:** —
- **Archivos:** `packages/db/src/backup/`, `packages/db/src/scripts/backup.ts`, `packages/config/src/env.ts` (`BACKUP_DIR`, `PG_BIN_DIR`), `packages/core/src/jobs.ts`, `apps/worker/src/jobs/db-backup.ts`, `packages/core/src/health.ts` (esquema de `/health`), `packages/db/src/health.ts` (la versión del servidor), `apps/api/src/health.ts`, `apps/cli/src/commands/doctor/`, `docs/08-guia-operador.md`, `docs/adr/0007-neon-y-cloudflare-r2.md`
- **Descripción:** §4.11: `pnpm db:backup`, el job (con su nombre en `JOB_NAMES`), `BACKUP_DIR` y `PG_BIN_DIR`, permisos, retención de 14, la exclusión del esquema `pgboss`, el archivo `.partial` que se renombra solo si se lee, la comprobación con `pg_restore --list`, el estado del último respaldo (un archivo de estado en `BACKUP_DIR`, sin tabla) en `/health` junto con `database.serverVersion`, `doctor` (versión de `pg_dump` frente a la del servidor, leída de `/health`) y la guía de restauración (con la misma `APP_ENCRYPTION_KEY`).
- **Hecho cuando:**
  - [ ] Tests con un `pg_dump` falso (argumentos sin la contraseña, entorno con la conexión y `PGSSLROOTCERT=system`, permisos, retención solo después de un éxito, un volcado que no se lee no desplaza a los buenos, un archivo que no se lee, `BACKUP_TOOL_NOT_INSTALLED`), config (rechaza una carpeta dentro del proyecto)
  - [ ] Seguimiento de ADR-0007 (respaldo y la cifra vigente del plan gratis: 1 GB por proyecto, nota `neon-backup.md`), guía, `doctor` y `.env.example` al día

### F6-T15 · Cierre de fase
- **Depende de:** todas
- **Descripción:** `/fase-cerrar 6`.
- **Hecho cuando:**
  - [ ] Demo en simulación (§7, pasos 2 a 7) y, con la instrucción del operador, el paso en vivo (§7, paso 8)
  - [ ] Criterios de §6 con evidencia; auditoría del `arquitecto`
  - [ ] `CHANGELOG.md` `[0.6.0]`, spec cerrado, `docs/ESTADO.md` apuntando a F7; tag con permiso del operador

**Lotes y orden:**
- **Lote A** (T01, T02, T03): el calendario en core y el disparo.
- **Lote B** (T04, T05): reintentos, espera ante límites y vigilancia.
- **Lote C** (T06, T07): Portal (actualizar, republicar y vencimiento).
- **Lote D** (T08, T09): la propiedad manda y `auto_publish` (T08 deja el `PATCH` funcionando).
- **Lote E** (T14): respaldo. No depende de nada: puede ir antes si conviene, pero antes de F.
- **Lote F** (T10, T11): API y CLI (la llamada del panel pasa a la ruta nueva aquí). Con A a F la demo por CLI ya se puede hacer.
- **Lote G** (T12, T13): panel.
- **T15:** cierre.

Cada lote deja `main` en verde por sí solo: ninguna ruta ni llamada del panel cambia de forma antes del lote que la usa.

## 6. Criterios de aceptación de la fase
- [ ] El operador programa 5 propiedades para una hora (lote) y, con el worker encendido, salen a esa hora en simulación, de a una; desprograma y reprograma una (demo).
- [ ] Con el worker apagado a la hora, una programada sale al encenderlo si el atraso es de 12 h o menos, y si es mayor queda "atrasada" esperando su decisión (tests con reloj falso y demo).
- [ ] Marketplace programado aparece como "te toca" a la hora y nunca abre Facebook solo (tests y demo).
- [ ] Un límite de Instagram deja la publicación programada para cuando se libere, hasta 3 veces; los demás fallos quedan `failed` con la causa y qué hacer (tests; en la demo, un fallo simulado).
- [ ] La vigilancia sincroniza Portal en vivo cada hora y recoge una publicación que quedó en `publishing` sin job (tests; deuda de F3 cerrada).
- [ ] Marcar una propiedad como vendida o arrendada cierra su aviso de Portal, descarta lo pendiente y deja Instagram y Marketplace en vivo como tareas a mano; pausar y reanudar la propiedad pausan y reactivan Portal (demo en simulación; tests de cada combinación).
- [ ] En Portal se actualiza un aviso publicado después de cambiar el precio en la planilla, se republica uno vencido o cerrado y la agenda avisa 7 días antes del vencimiento (simulación y tests; en vivo, cuando exista el usuario de prueba con paquete, pendiente de F4).
- [ ] La página Seguimiento y `agentsales agenda` muestran cada propiedad en cada plataforma con su estado y enlace, y lo que toca hacer (demo).
- [ ] Con `auto_publish` activado para `agentsales-pruebas`, preparar una propiedad termina publicada en simulación en Instagram y Portal y con Marketplace como recordatorio (demo).
- [ ] El respaldo diario queda en `~/.agentsales/backups`, se puede leer con `pg_restore --list` y la guía explica cómo restaurarlo (demo con el `pg_dump` del operador).
- [ ] Ningún test llama a Instagram, Mercado Libre, Facebook, Anthropic, al Banco Central ni a Neon (el respaldo usa un `pg_dump` falso); `pnpm check` y la CI de GitHub en verde.

## 7. Plan de demo
1. **Operador, antes:** instalar el cliente de Postgres (`brew install libpq`, nota `neon-backup.md`; queda en `/opt/homebrew/opt/libpq/bin`) y revisar con `doctor` que `pg_dump` sirve y que su versión alcanza a la de Neon.
2. **Simulación, CLI (la corre Claude, con aviso previo de `pnpm dev`):** `agentsales schedule P002 P004 P005 --at "<en 3 min>"` y `--spacing 2` en un segundo lote; `agentsales agenda` muestra las próximas; a la hora salen de a una; `unschedule` y reprogramar una; `publications --events` con `schedule_changed`.
3. **Atrasadas:** programar una para dentro de 3 min, apagar `pnpm dev` (Ctrl+C: apaga la API, el worker y el panel juntos), esperar que pase la hora y encenderlo de nuevo: sale. Una atrasada de más de 12 h se arma con un test (no se espera 12 h en la demo) y se muestra en la agenda con sus acciones.
4. **Marketplace:** programar P004 en Marketplace; a la hora aparece "te toca" en la agenda y en Seguimiento; Publicar sigue el flujo de F5 en simulación.
5. **La propiedad manda:** con P002 publicada en simulación en Instagram y Portal: Pausar propiedad (Portal pausada), Reanudar, después "Arrendada": Portal cerrada, pendientes descartadas e Instagram retirada en simulación (en vivo quedaría como tarea a mano: lo muestran los tests y, si el operador lo autoriza, el paso 8); Reabrir.
6. **Portal y `auto_publish`:** cambiar un precio en la planilla de demo, recargar y "Actualizar" en Portal (simulación); "Republicar" uno cerrado; activar `auto_publish` en `agentsales-pruebas` (Claude con `--yes`, con la API en simulación: no publica nada de verdad), preparar una propiedad y verla publicada en simulación; desactivarlo.
7. **Respaldo:** `pnpm db:backup`, ver el archivo en `~/.agentsales/backups` y `pg_restore --list` (lo corre el operador o Claude con su aviso; solo habla con Neon, como `db:migrate`).
8. **`live`, solo con la instrucción del operador en el chat:** programar una publicación de Instagram de P002 en vivo para dentro de unos minutos y verla salir sola; marcar P002 como arrendada: Instagram aparece en las tareas a mano; el operador la borra a mano, la marca como retirada y reabre P002. Portal en vivo, cuando exista el usuario de prueba con paquete (pendiente de F4).

## 8. Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| El worker está apagado a la hora y lo programado no sale | Regla de atrasadas (D2) y la agenda lo muestra; el operador sabe que el calendario necesita `pnpm dev` (guía) |
| Lo programado en simulación sale en vivo, o al revés | El modo se fija al programar y se muestra; el worker en otro modo deja `failed` con `PUBLISH_MODE_MISMATCH` sin publicar |
| Una programada sale dos veces | El disparo pasa a `publishing` dentro del candado de forma condicional y el job es `exclusive` por publicación |
| Un cambio de hora (horario de verano de Chile) mueve lo programado | Se guarda en UTC; la CLI y el panel convierten con `America/Santiago`; tests en las fechas del cambio |
| La espera ante límites se repite sin fin | Tope de 3 esperas seguidas; después `failed` |
| La vigilancia reabre un formulario de Marketplace sin el operador | Marketplace nunca se reencola en la vigilancia (D7) |
| Cerrar la propiedad a medias (Portal falla) | Portal primero; si falla, la propiedad no cambia y repetir salta lo ya hecho |
| Actualizar el precio en Portal hace que Mercado Libre lo pause | Confirmación que lo advierte y un sync a los 30 s que muestra la pausa con su motivo |
| `relist` no se comporta como dice la doc (cuerpo, `seller_contact`, qué copia) | Se lee el ítem nuevo y se repone lo que falte; si Mercado Libre rechaza el `relist`, Reintentar publica un ítem nuevo; lo NO VERIFICADO se prueba con el usuario de prueba (pendiente de F4, nota §13.5) |
| La regla de fotos del 12/03/2026 alcanza también a pausar, reactivar y cerrar (F4), que hoy no mandan `pictures` | NO VERIFICADO (prueba 7 de la nota §13.5): si se confirma, una tarea chica suma los `id` de las fotos a esos `PUT`; mientras, el error de Mercado Libre se muestra con su causa |
| `auto_publish` publica en vivo algo que el operador no revisó | Apagado por defecto, se activa con confirmación, el panel lo advierte en rojo, solo textos sin errores, Marketplace nunca |
| El respaldo filtra datos de clientes | Fuera del proyecto y del bucket, `0700`/`0600`, nunca en git; la contraseña nunca en los argumentos ni en el log |
| `pg_dump` más viejo que el servidor de Neon | `doctor` compara versiones; el job falla con un mensaje claro |
| Una consulta por minuto agota la cuota de Neon | El worker ya lo mantiene despierto mientras corre; la consulta usa el índice de las programadas |

## 9. Preguntas abiertas
Respondidas por el operador el 2026-10-15:
- [x] D2: ¿qué pasa con lo programado si el worker estaba apagado? **Sale si el atraso es de 12 h o menos; si no, espera su decisión.**
- [x] D3: vendida o arrendada en Portal: **cerrar el aviso**.
- [x] D4: Instagram al vender: **tarea a mano** hasta marcarla retirada.
- [x] D5: `auto_publish`: **aprueba y publica de inmediato** los textos sin errores (Marketplace como recordatorio).

Decididas por Claude con la aprobación permanente: D1, D6 a D12, el aviso de vencimiento a 7 días, la vigilancia cada hora, 3 reintentos con backoff, los 14 respaldos y que la planilla no marque vendida.

## 10. Registro de cambios del spec
| Fecha | Cambio |
|---|---|
| 2026-10-15 | Borrador inicial (`/fase-plan 6`), con el mapa del código actual y las respuestas del operador (D2 a D5) |
| 2026-10-15 | Notas verificadas: Mercado Libre §13 (releídas con el navegador `re-publica`, `actualiza-tus-publicaciones` y el ciclo de vida: cuerpo del `relist`, una vez por padre, 60 días solo para las visitas, `seller_contact` completo y **fotos en cada actualización** de un `silver` desde el 12/03/2026), Instagram §6.1 (sin hora de liberación del cupo) y `neon-backup.md` (Postgres 18 probable, `libpq` fuera del `PATH`) |
| 2026-10-15 | Revisión del `arquitecto` (6 bloqueantes, todos aplicados): ADR-0020 para actualizar y republicar Portal (re-fija `content_id`, `listing_source_hash` y `sellerContact` con `replacePublishedSource`, tope único de 15 s, fotos del progreso); cambiar la propiedad en tres fases (validar y soltar lo pendiente, Portal fuera del candado sin devolver la propiedad a `ready`, releer y aplicar); `dryRun` obligatorio al programar y el disparo con el modo de cada publicación (modifica ADR-0014 punto 7); Marketplace se programa sin revisar el límite del día ni el formulario abierto, y `auto_publish` sin el margen de 2 min; `reschedule`, `relistedFrom` con su único, `relistOf` en el input y `relistRejected`; orden de lotes que deja `main` en verde (el `PATCH` sigue hasta T10, el respaldo antes de la API). No bloqueantes aplicados: las vueltas del arranque siguen directas, atascadas a los 70 min y "en cola", la espera por una señal genérica (`waitMinutes`), publicar ahora adelanta lo programado (D13), `NOTHING_TO_PUBLISH` no es fallo en `auto_publish` y su advertencia en vivo, reabrir con algo en vivo deja `active`, tareas a mano solo en vivo y de propiedades cerradas, `byListing` en el evento, errores de confirmación, `PGSSLROOTCERT=system`, sin filas de `pgboss` en el respaldo, la misma `APP_ENCRYPTION_KEY` al restaurar, `doctor` lee la versión del servidor de `/health`, una sola ruta para programar propiedades |
| 2026-10-15 | Spec **aprobado** (aprobación permanente del operador). ADR-0018, ADR-0019 y ADR-0020 aceptados; `03-plataformas.md`, `06-roadmap.md`, `07-checklist-cuentas.md` ("Antes de F6": el cliente de Postgres) y `docs/ESTADO.md` al día |
| 2026-10-15 | `/revisar` del PR #119 (`revisor` y `arquitecto`; 7 bloqueantes, todos aplicados): la fase 3 de cambiar la propiedad relee también las publicaciones (una nueva que apareció mientras se llamaba a Portal); republicar en simulación (una `dry_run` sin `remote_state`) y en vivo a cualquier plazo, nunca cruzando modos; `listDue` filtra en la consulta las atrasadas y Marketplace (no ocupan los 20 lugares); la advertencia de `auto_publish` en vivo con dueño (`/health` con `autoPublishBrokers`, T10, T11 y T13); nombres reales de archivos (`publish/input.ts`, `apps/api/src/health.ts`, `core` y `db` `health.ts`, dobles en T08 y T09); el respaldo sin el esquema `pgboss` (el worker recrea las colas), con `.partial` y retención solo tras un éxito. No bloqueantes: adelantar usa el modo de ese momento, actualizar `live` con la API en simulación es `PUBLISH_MODE_MISMATCH`, el `PATCH` hasta T10 traduce cada estado a su acción, el único de `relisted_from` no cuenta las descartadas, Marketplace siempre es "te toca", atascada solo por `updated_at`, confirmación de pausar y archivar solo si hay algo que cambiar, `CLOSE_REASON_REQUIRED` y `SCHEDULE_*` con fila propia (400), la espera fija de Instagram como simplificación consciente, `db.backup` solo en T14, sintaxis de `listing close`, la demo de atrasadas con `pnpm dev`, y las líneas de Estado de ADR-0005, ADR-0014 y ADR-0015 |
