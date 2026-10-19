# ADR-0031 · Los anuncios de Meta son un agregado propio, con una segunda app y dos tiempos

- **Estado:** Propuesto (borrador del piloto, F10; se aprueba con su spec)
- **Fecha:** 2026-10-19
- **Reemplaza a / Modifica a:** — (extiende ADR-0016 y ADR-0029; `docs/00-vision.md` hoy deja fuera la publicidad pagada)

## Contexto
La corredora del piloto quiere empezar con Meta Ads y que un aviso o un post ya publicado en Instagram pueda impulsarse. Por la Marketing API un anuncio es una cadena de objetos (campaña → conjunto de anuncios → anuncio → creatividad) cuya creatividad apunta a una publicación existente (`source_instagram_media_id`). Tiene presupuesto, gasta dinero mientras corre y pasa por la revisión de Meta (`docs/integraciones/meta-ads.md`).

El Instagram Login que usa AgentSales no sirve para anuncios: se necesita Facebook Login for Business, una Página vinculada y permisos de Marketing API (`ads_management`, `ads_read`, `business_management`). Una app de Meta usa un login o el otro, no ambos.

## Decisión
1. **Un anuncio no es una `Publication`.** Es un agregado propio: `ad_campaigns` (cuelga del sujeto, aviso o post, como ADR-0029), `ads` (con `source_publication_id`, la publicación orgánica de Instagram, y los ids de Meta: campaña, conjunto, creatividad, anuncio), `ad_events` (bitácora inmutable) y `ad_spend_daily`. Reutiliza el sujeto, `platform_accounts`, la cola, el candado y el patrón de progreso y `outcome_unknown`.
2. **Una segunda app de Meta** (Facebook Login for Business y Marketing API) en el mismo portafolio, para anuncios. La app de Instagram (`AgentSales-IG`) no cambia sus dos permisos de contenido. La conexión es una cuenta de plataforma con valor propio (`meta_business`) que **no** entra a la lista de plataformas que publican contenido (no es un canal con textos). Guarda `pageId`, `igUserId` (el del login de Facebook), `adAccountId` y `currency` en `meta`.
3. **Token sin vencimiento:** de system user del cliente (BISU) o propio. Se marca como «no vence» y no entra al refresco periódico.
4. **Dos tiempos.** En `dry-run` no se escribe nada en Meta (crear un anuncio, aunque nazca pausado, es una escritura): el preflight solo lee `boost_eligibility_info` y valida con una llamada sin efectos si existe. En `live`: *crear pausado* (escribe en Meta, sin gasto) y *activar* (gasto), cada uno con su modo fijado en la publicación.
5. **Cadena de varios POST con progreso.** Cada id se guarda antes del paso siguiente. Un POST sin respuesta se reconcilia leyendo por `name` (que lleva el id de AgentSales, como `relistOf` en Portal) y, si no aparece, queda `outcome_unknown` (ADR-0029). Activar y pausar son idempotentes.
6. **La categoría Vivienda es una configuración por cuenta publicitaria** (`NONE` o `HOUSING`): en Chile Meta la deja optativa y declararla restringe mucho la segmentación. Se revisa con la corredora antes del piloto.
7. Ningún test llama a la Marketing API; `pnpm` de humo para anuncios, si existe, lo corre solo el operador.

## Consecuencias
- Cada concepto queda en su lugar: el estado orgánico de una publicación no se mezcla con el de un gasto, y un anuncio activo 30 días no bloquea regenerar el contenido del aviso.
- Más código y tablas nuevas; una segunda app y su propia revisión de Meta (acceso avanzado, verificación del negocio, verificación de acceso/Tech Provider y 500 llamadas exitosas en 15 días para pasar de Limited a Full).
- El piloto funciona sin esa revisión si la corredora y el operador tienen rol en la app; con terceros sin rol, no.
- Se mantienen dos flujos de login (Instagram para publicar, Facebook para anuncios). Que el id de un medio publicado con Instagram Login sirva como `source_instagram_media_id` es NO VERIFICADO (prueba A1).

## Alternativas descartadas
- **Anuncio como `Publication` con `platform = meta_ads`:** nace de un medio ya publicado y no de un texto aprobado, tiene presupuesto y estados que corren solos, rompería `PENDING_PUBLICATION_STATUSES` y el único activo por formato.
- **Híbrido** (`Publication` para crear y tabla aparte para el dinero): dos verdades sobre el mismo anuncio que pueden contradecirse.
- **Pasar todo a Facebook Login:** obliga a rehacer la conexión y la revisión de Instagram que ya está en marcha.

## Seguimiento (opcional)
