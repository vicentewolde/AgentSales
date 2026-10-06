# ADR-0015 · Portal Inmobiliario: tokens que rotan con candado por cuenta, catálogo en la base, estado remoto y operaciones síncronas sobre publicaciones

- **Estado:** Aceptado
- **Fecha:** 2026-10-06
- **Modifica a:** ADR-0005 ("la API solo encola" y la cola `publication.sync`), ADR-0014 (punto 5, lo aprobado no cambia; punto 8, contrato de `Publisher`; punto 9, llamadas síncronas desde la API), `docs/01-arquitectura.md` y `docs/02-modelo-datos.md`

## Contexto
F4 publica en Portal Inmobiliario con la API de Mercado Libre (sitio MLC). La doc oficial (`docs/integraciones/mercadolibre.md`, verificada el 2026-10-06) muestra diferencias de fondo con Instagram:
- El `access_token` dura horas y el `refresh_token` dura 6 meses, sirve **una sola vez** y solo vale el último. Dos refrescos simultáneos (la API y el worker son procesos distintos) dejan la cuenta sin acceso. F3 guarda solo `{ accessToken }` y sus reglas de refresco (24 h mínimo, ventana de 30 días) están fijas para Instagram.
- Los ids de las categorías hoja, sus atributos obligatorios, sus `settings` (largo del título, monedas, fotos) y las ubicaciones de Chile solo se leen con token (sin token, 403) y cambian con el tiempo. No se pueden escribir a mano.
- El ítem tiene un estado propio que cambia sin nosotros: Mercado Libre lo pausa por moderación o mientras procesa las fotos, lo pasa a revisión y lo cierra al vencer (45 días en arriendo, 180 en venta).
- Pausar, reactivar y cerrar son una sola llamada corta (`PUT /items/{id}`) sobre algo que ya existe en la plataforma.
- El ítem lleva datos del aviso (precio, superficies, ubicación), no solo el texto aprobado. Una carga del Excel actualiza un aviso aunque tenga publicaciones pendientes.

## Decisión
1. **Credenciales:** `PlatformCredentials` pasa a `{ accessToken, refreshToken? }`, cifradas como hasta ahora (AES-256-GCM, AAD por cuenta).
2. **Dos vencimientos:** `platform_accounts.token_expires_at` es cuándo la cuenta deja de funcionar sin el operador (en Mercado Libre, el horizonte estimado del `refresh_token`: último refresco + 6 meses). El vencimiento del `access_token` va en `meta.accessTokenExpiresAt` (no es secreto). Cada plataforma tiene su **política de refresco** en core (Instagram sin cambios; Mercado Libre sin mínimo, `force` siempre refresca y el lote refresca lo que tenga más de 7 días desde el último refresco).
3. **Candado de credenciales:** `PlatformAccountRepository.withCredentialsLock(id, fn)` abre una transacción que bloquea la fila de la cuenta con `FOR NO KEY UPDATE` (no choca con las FK de `publications`) y `lock_timeout` de 10 s. Es la **única** excepción a "nada externo dentro de un candado": `fn` hace **una** llamada de refresco (tope de 10 s) y guarda el par nuevo antes de usarlo. **Nunca se anida con el `ListingLock`**, ni uno dentro del otro.
4. **`ensureAccessToken`** (core): devuelve el token sin bloquear si le quedan más de 30 min; si no, toma el candado, relee y refresca solo si sigue por vencer. Lo usan el intento de publicación, `preflight`, las operaciones, la sincronización, el catálogo y `ml:smoke`, siempre fuera del `ListingLock`. Un `invalid_grant` deja la cuenta `expired`.
5. **Tabla `platform_catalog`** (`platform`, `key`, `data jsonb`, `fetched_at`; llave `(platform, key)`): datos públicos de la plataforma, bajados a pedido con el token, con 7 días de vida y la copia vencida si falla la red. Puerto `PortalCatalog` en core.
6. **`publications.remote_state`** (`jsonb null`, `remoteStateSchema`): lo último que informó la plataforma (estado, subestado, vencimiento, cuándo se consultó). **`publications.listing_source_hash`** (`text null`): el `source_hash` del aviso al nacer la publicación; las plataformas cuyo input lleva el aviso (Portal; Marketplace en F5) no publican si cambió (`PUBLICATION_LISTING_CHANGED`). Extiende el punto 5 de ADR-0014 a los datos del aviso.
7. **Contrato `Publisher`:** `validate` sigue pura y síncrona. Se suman, opcionales, `preflight(input, ctx)` (lecturas y validación remota, ADR-0016), `pause`, `resume`, `close` y `getStatus(ref, ctx)`, con `ref = { externalId, progress }`. El contexto suma `accessToken(opts?)`, que arma core con `ensureAccessToken`: el publisher no conoce repositorios. `close` reemplaza el `unpublish` anunciado en ADR-0014. `PublishInput` suma `listing` (sin `internal_notes`) y `brokerContact`.
8. **Pausar, reactivar y cerrar son síncronos en la API**, con el criterio del punto 9 de ADR-0014: una llamada corta sobre algo que ya existe, cuyo resultado el operador espera en pantalla. La llamada va antes y fuera del `ListingLock`; la transición, dentro, es condicional. Con la API, tope de 10 s por llamada. Una publicación en `live` exige la API en `live` (`PUBLISH_MODE_MISMATCH`); una en `dry-run` se simula. Si guardar falla después de que la plataforma respondió, la sincronización lo corrige.
9. **`publication.sync`:** cola `exclusive` por publicación, 2 reintentos desde 60 s, expira a los 2 min. Corre a pedido, 2 min después de publicar en `live` y al arrancar el worker (el cron es de F6). Lee fuera del candado, y dentro descarta una lectura anterior al último cambio local (`updatedAt`) y cambia estados con actor `system`, de forma condicional.

## Consecuencias
- Dos procesos nunca refrescan el mismo token a la vez, y el par nuevo nunca se usa sin guardar. Queda un riesgo aceptado: si el proceso muere entre la rotación y la confirmación, hay que reconectar. Restaurar un respaldo o conectar la misma cuenta a otra base también obliga a reconectar.
- El panel y la CLI siguen leyendo `token_expires_at` como hasta ahora, sin mostrar una cuenta de Mercado Libre vencida cada 6 h.
- Una llamada externa dentro de una transacción es una excepción acotada (una llamada, 10 s, nunca con el candado del aviso). Hay que respetarla al sumar plataformas.
- El catálogo se baja solo cuando se usa, y un cambio de Mercado Libre se recoge en 7 días como máximo. La primera publicación de un tipo nuevo hace unas pocas llamadas más.
- El panel muestra el estado real del ítem sin leer la bitácora. Instagram no usa `remote_state`.
- Lo aprobado queda fijo también en los datos del aviso: una carga que cambia el precio obliga a descartar y aprobar de nuevo.
- La API hace más llamadas síncronas a plataformas (conectar, refrescar y ahora pausar, reactivar y cerrar). Todas son cortas y sobre algo que ya existe; publicar sigue encolado.
- Instagram no cambia: no implementa los opcionales, su `validate` y `checkPublishInput` siguen iguales y no revisa `listing_source_hash`.

## Alternativas descartadas
- **Refrescar sin candado o con un candado en memoria:** la API y el worker son procesos distintos y perderían el `refresh_token`.
- **Candado de sesión (`pg_advisory_lock`):** posible con la conexión directa, pero suma otra forma de bloquear; la fila de la cuenta ya sirve.
- **`token_expires_at` como vencimiento del `access_token`:** el lote marcaría la cuenta `expired` sin preguntar y el panel la mostraría vencida cada pocas horas.
- **Catálogo en memoria o en un archivo versionado:** se pierde al reiniciar o exige escribir ids a mano, que cambian.
- **Bajar el árbol entero de inmuebles:** muchas llamadas para usar unas pocas hojas.
- **Estado remoto solo en la bitácora:** el panel tendría que leer eventos para mostrar el estado.
- **Pausar y cerrar con un job y `202`:** obliga a un estado intermedio y a sondear por una sola llamada corta.
- **`validate` asíncrona para todos:** cambia `checkPublishInput` e Instagram sin necesidad.
- **Bloquear la carga del Excel con publicaciones pendientes:** frena una operación diaria del operador; es mejor detectarlo al publicar.
- **Copiar los datos del aviso en la publicación:** duplica datos para algo que basta con detectar.

## Seguimiento
- 2026-10-06 (revisión de F4-T01, `arquitecto`): el punto 9 compara el `updatedAt` de la publicación leído **antes** de consultar la plataforma con el que se relee dentro del candado, por igualdad: los dos salen de la base (`clock_timestamp()`), así un desfase entre el reloj de Neon y el del worker no deshace un cambio del operador. El publisher devuelve el estado sin `checkedAt` (lo pone core al guardar), y una publicación de Portal sin `listing_source_hash` no se publica (`PUBLICATION_LISTING_CHANGED`).
