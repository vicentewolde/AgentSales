# ADR-0014 · Se aprueba el texto de cada canal; las publicaciones nacen aprobadas, por formato y con lo aprobado fijo

- **Estado:** Aceptado
- **Fecha:** 2026-10-04
- **Modifica a:** ADR-0012 (consecuencia "la aprobación sigue siendo de F3, sobre `publications`, con su máquina de estados intacta"), la máquina de estados y el contrato de `Publisher` de `docs/01-arquitectura.md`, y `publications` en `docs/02-modelo-datos.md`

## Contexto
- ADR-0012 dejó que las publicaciones nacieran en F3 "desde el contenido vigente cuando hay una cuenta conectada", y pidió decidir cuándo, si `contents.status = approved` se marca junto con ellas, y si una publicación guarda copia de sus medios o los congela (los derivados se reemplazan en su lugar).
- Lo que el operador revisa y corrige es el **texto de un canal** (`contents`, F2-T15), no una publicación.
- En Instagram, una propiedad con video sale como **dos** publicaciones: el carrusel y el reel. El único parcial `(listing_id, platform_account_id)` permite una sola activa por cuenta.
- Un texto de Portal o de Marketplace se puede revisar antes de que exista su cuenta (F4 y F5).
- Publicar en Instagram es de varios pasos (contenedores, sondeo y `media_publish`), y un reintento a ciegas puede publicar dos veces (`docs/integraciones/instagram.md` §7).
- Una corrida de contenido puede reemplazar los textos y los medios de un aviso mientras hay una publicación aprobada; y en F2 quedó una ventana en que un pedido de textos no ve una edición recién guardada (spec F2, §8).

## Decisión
1. **La aprobación es del texto vigente de un canal** (`contents.status = approved`). Quitarla lo deja en `edited`. Editar un texto aprobado sin publicaciones activas también lo deja en `edited`.
2. **Las publicaciones nacen en `approved`**, desde el texto aprobado y por cada cuenta conectada del canal: al aprobar si la cuenta existe, o al publicar si se conectó después. Fijan `content_id` y `media_ids` al nacer.
3. **Una publicación por formato:** `publications.format` (`post` o `reel`, `PUBLICATION_FORMATS`) y el único parcial pasa a `(listing_id, platform_account_id, format)` para las activas.
4. **Estados:** se quitan `draft` y `pending_approval` de `publication_status`; `INITIAL_PUBLICATION_STATUSES = ["approved"]`. El resto de la máquina no cambia. `PENDING_PUBLICATION_STATUSES` = `approved`, `scheduled`, `publishing`, `failed` y `awaiting_manual_confirm` (las activas que aún no están en la plataforma).
5. **Lo aprobado no cambia:**
   - sin corridas de contenido (de textos ni de imágenes) mientras el aviso tenga publicaciones pendientes;
   - un texto con una publicación activa no se edita;
   - un texto aprobado cuenta como editado para regenerar (`replaceEdits`);
   - las escrituras que dependen del estado del aviso (pedir corrida, editar, aprobar, quitar la aprobación y abrir publicaciones) corren con un **candado por aviso** (`ListingLock`: transacción que bloquea la fila del aviso y entrega repositorios de esa transacción).
6. **Progreso en la plataforma:** `publications.progress` (`jsonb null`) guarda lo que el publisher ya creó (en Instagram, los contenedores) antes del paso que publica, para que un reintento retome sin publicar dos veces.
7. **El modo lo decide la publicación:** `publications.dry_run` se fija al pasar a `publishing`, y el worker lo respeta: simula una publicación pedida en `dry-run` aunque esté en `live`, y no publica una pedida en `live` si está en `dry-run` (`PUBLISH_MODE_MISMATCH`).
8. **Contrato de `Publisher`:** `validate(input)` y `publish(input, ctx)`, donde `ctx` trae la cuenta, las credenciales descifradas, el progreso y `saveProgress`; `formats` reemplaza las banderas de carrusel y video. `unpublish` y `getStatus` se suman cuando un canal los use (F4 y F6). En `dry-run`, `withDryRun` (core) valida y registra sin llamar al publisher envuelto.

9. **Conectar una cuenta es la única llamada síncrona a una plataforma desde la API** (el OAuth de Instagram: canje del código y `/me`), una excepción acotada a "la API solo encola" (ADR-0005): el navegador espera la respuesta y el código vence en 1 hora.

Detalle en el spec F3 (§4.2 a §4.7). Migración `0006` en F3-T01.

## Consecuencias
- Se aprueba una vez por canal, aunque Instagram dé dos publicaciones, y un texto se puede aprobar sin cuenta.
- Lo que se publica es exactamente lo aprobado: la publicación apunta a una fila de `contents` que ya no cambia y a medios que no se reemplazan mientras está pendiente. No hace falta copiar textos ni claves de R2. Después de publicada, una corrida nueva sí puede reemplazar los medios: la bitácora (`publish_attempt`) guarda las rutas y el caption enviados.
- Carrusel y reel tienen estado, enlace y reintentos propios. El glosario pasa a "publicación (aviso × cuenta × formato)".
- Para regenerar contenido con publicaciones pendientes hay que publicarlas o descartarlas antes. Es una regla más que explicar en el panel.
- La ventana de edición de F2 se cierra.
- Un cambio de `PUBLISH_MODE` a medio camino no publica de verdad nada pedido como simulación.
- La migración recrea el tipo `publication_status`; es posible porque `publications` está vacía (ADR-0012), y la migración falla a propósito si no lo está.
- `draft` y `pending_approval` dejan de existir para las publicaciones: si F6 necesitara una cola de revisión por publicación, sería un ADR nuevo.

## Alternativas descartadas
- **Aprobar la publicación** (máquina intacta, nace en `pending_approval`): dos aprobaciones del mismo texto en Instagram, publicaciones que hay que mantener apuntando al texto vigente mientras cambia, y ninguna forma de aprobar un texto sin cuenta.
- **Crear las publicaciones al conectar la cuenta:** publicaciones de avisos que nunca se van a publicar y que hay que actualizar con cada corrida.
- **Una sola publicación de Instagram con el carrusel y el reel:** dos `external_id`, un estado para dos resultados, y un reintento que puede repetir el que ya salió.
- **Copiar el texto y las claves en la publicación:** duplica datos para resolver algo que basta con no cambiar mientras está pendiente.
- **Revisar la condición sin candado** (antes de escribir): deja la ventana de F2 y suma otra entre aprobar y regenerar.
- **Dejar `draft` y `pending_approval` sin uso:** estados que nadie alcanza, en la base, en las etiquetas y en los tests.
