# 03 · Plataformas

Resumen de cómo se integra cada canal. Antes de implementar un publisher, el subagente `integraciones` verifica esta información contra la documentación oficial vigente y deja las notas en `docs/integraciones/<plataforma>.md`. **Todo lo marcado (verificar) debe confirmarse antes de codificar.**

| Plataforma | Mecanismo | Fase | Riesgo |
|---|---|---|---|
| Instagram | API oficial (Instagram API with Instagram Login) | F3 | Bajo |
| Portal Inmobiliario | API de Mercado Libre (sitio MLC) | F4 | Medio |
| Facebook Marketplace | Navegador automatizado + clic final humano | F5 | Alto |
| Yapo | Por definir (sin API pública conocida) | Post-MVP | Alto |
| TikTok | Content Posting API | Post-MVP | Medio |

## Instagram

- **API:** Instagram API with Instagram Login (host `graph.instagram.com`). **No requiere Página de Facebook** (verificado 2026-10-04); sí requiere cuenta profesional (Empresa o Creador) y una app de tipo Business.
- **Permisos:** `instagram_business_basic`, `instagram_business_content_publish` (nombres vigentes, verificados 2026-10-04; los scopes antiguos quedaron deprecados el 2025-01-27).
- **Setup:** app en developers.facebook.com con el producto Instagram; agregar la cuenta de prueba como tester de la app. Con acceso estándar (el de por defecto) la app funciona con cuentas que tienen rol en ella, sin App Review (verificado). Para cuentas de terceros hace falta acceso avanzado: App Review y verificación del negocio (verificado); el plazo de "2–4 semanas" no figura en la doc (NO VERIFICADO). El `client_id` y el `client_secret` del OAuth son el **Instagram app ID e Instagram app secret** del panel (Instagram > API setup with Instagram login > Business login settings), distintos de los de Settings > Basic; el operador confirma en F3 que `META_APP_ID` y `META_APP_SECRET` son ese par (pasos en `integraciones/instagram.md`, sección 2.1).
- **Flujo de publicación (verificado 2026-10-04):**
  1. Crear un contenedor por medio (`POST /{ig-user-id}/media`; los hijos de un carrusel llevan `is_carousel_item=true` y no llevan caption).
  2. Para carrusel (de 2 a 10 ítems), crear el contenedor padre con `media_type=CAROUSEL`, `children` y `caption`.
  3. Para video o reel (`media_type=REELS`, `video_url`), consultar `status_code` hasta `FINISHED`; Meta recomienda una consulta por minuto durante un máximo de 5 minutos. Un contenedor vive 24 h.
  4. Publicar (`POST /{ig-user-id}/media_publish` con `creation_id`) y leer el `permalink` del medio publicado (`GET /{media-id}?fields=permalink`; en carruseles, del ID del carrusel, no de los hijos).
- **Medios:** deben estar en una **URL pública** (usamos URLs prefirmadas de Cloudflare R2, con `Content-Type` correcto en cada archivo). La doc de Meta no dice nada sobre query strings, redirecciones ni `HEAD`, y una URL prefirmada de R2 queda atada al método `GET`: **verificar en F3** que Instagram las acepta (NO VERIFICADO); plan B: dominio público propio para un prefijo del bucket, o subida reanudable del reel (`upload_type=resumable`, documentada, sin probar). La URL debe seguir vigente hasta que el contenedor llega a `FINISHED`: generarla justo antes de crear el contenedor, con vencimiento de 1 hora. Imágenes en JPEG sRGB, hasta 8 MB, proporción entre 4:5 y 1,91:1, ancho entre 320 y 1440 px (verificado 2026-10-02, `integraciones/instagram.md`). El carrusel se recorta a la proporción de la primera imagen, así que todas van en 4:5 (1080×1350). **Hasta 10 ítems por carrusel vía API (verificado).** Reels: la API acepta MOV o MP4 (sin edit lists, `moov` al inicio), HEVC o H.264, AAC, 23 a 60 fps, máximo 1920 px en horizontal, VBR hasta 25 Mbps, de **3 s a 15 min**, hasta 300 MB, proporción recomendada 9:16 (verificado). El tope de "5 a 90 s" que usábamos es una decisión de producto, no un límite de Meta.
- **Límites (2026-10-04):** la guía de Meta dice 100 posts publicados por API por cuenta en una ventana móvil de 24 h, pero la referencia de `content_publishing_limit` dice `quota_total` "currently 50": la doc se contradice, así que el sistema lee `config.quota_total` en vez de fijar la cifra. Tope aparte de **400 contenedores** por cuenta en 24 h (un carrusel de N imágenes gasta N + 1). Un carrusel cuenta como 1 post (verificado). Si un reel cuenta como 1 post y si `content_publishing_limit` responde con Instagram Login en `graph.instagram.com`: NO VERIFICADO (se prueba en la demo de F3). Llamadas: `4800 × impresiones` de la cuenta en 24 h.
- **Tokens (verificado 2026-10-04):** OAuth en `https://www.instagram.com/oauth/authorize`; el código dura 1 hora y es de un solo uso; el token corto dura 1 hora; se canjea por uno largo de **60 días** (`graph.instagram.com/access_token`, `ig_exchange_token`) y se refresca con `refresh_access_token` (`ig_refresh_token`) solo si tiene **al menos 24 h** y **no ha vencido** (un token vencido obliga a reconectar). Se necesita un job periódico. La cuenta se identifica con el `user_id` de `/me`, no con `id` (app-scoped). **Redirect URI:** la doc no dice si `http://localhost` se acepta (NO VERIFICADO; si no, usar el token del panel, HTTPS local o un túnel; ver `integraciones/instagram.md`, sección 3.6).
- **Errores:** 190 (token) y permisos (10, 200 a 299) no se reintentan; límites (4, 17, 80002, 2207042) se reprograman; errores de descarga de medios (2207003, 2207052) y transitorios (2207001, 2207032, 2207053) se reintentan con contenedor nuevo. Tabla completa en `integraciones/instagram.md`, sección 7.
- **Caption:** el texto se guarda sin los hashtags (`contents.body`) y los hashtags aparte (`contents.hashtags`). El publisher envía `instagramCaption(content)` (core), que los suma después de una línea en blanco; enviar solo `body` publicaría sin hashtags. Límites de Meta (verificado 2026-10-04): 2.200 caracteres, 30 hashtags y 20 menciones.
- **Despublicar (corregido 2026-10-04):** existe `DELETE /{media-id}` en la API de Instagram (novedad del 2025-12-03), pero la referencia de Meta lo limita a **Facebook Login** (host `graph.facebook.com`, permiso `instagram_manage_contents`); con Instagram Login no está documentado. Se asume que no se puede por API y se borra a mano desde la app. Se puede intentar una vez en la demo de F3 (NO VERIFICADO). "Cerrar" en Instagram = marcar como no disponible en el sistema y avisar al operador para archivarlo o borrarlo a mano.

## Portal Inmobiliario (vía Mercado Libre)

- Portal Inmobiliario está integrado a Mercado Libre. Se publica en el sitio **MLC** con la API de ML.
- **Clave:** en Chile hay que incluir el atributo `CMG_SITE` en el body del ítem para que el aviso aparezca en Portal Inmobiliario además de Mercado Libre.
- **Setup:** app en el portal de developers de Mercado Libre Chile, OAuth 2.0 (authorization code), redirect URI **HTTPS** (en local puede requerir un túnel como cloudflared o ngrok; verificar si acepta `https://localhost`).
- **Tokens:** el access token es de corta duración (horas) y se renueva con el refresh token.
- **Título y fotos (parcialmente verificado 2026-10-02, `integraciones/mercadolibre.md`):** el largo máximo del título de inmuebles en MLC sería **60 caracteres** (antes 200) y la doc recomienda evitar adjetivos y abreviaturas; las fotos: mínimo 500×500 px, recomendado 1200×1200 px, máximo 1920×1920 px, hasta 10 MB, JPG, JPEG o PNG. Ambos datos salen de resúmenes de buscador porque la doc de ML respondió 403; confirmar en el navegador o con la cuenta de prueba (verificar). Leer el máximo real de `settings.max_title_length` de la categoría (verificar).
- **Categorías y atributos:** se descubren por API (árbol de categorías de inmuebles MLC y atributos requeridos por categoría). No se escriben a mano en el código: se consultan y se cachean.
- **Moneda:** UF probablemente como `currency_id` `CLF` (verificar).
- **Tipos de publicación:** los inmuebles usan listing types pagados o con cupos según el plan del corredor (verificar costo en la cuenta de prueba). Con `requires_picture: true` se exige al menos 1 imagen.
- **Seguimiento:** el API permite consultar estado, pausar (`paused`) y cerrar (`closed`) ítems.
- **Consultas de interesados:** llegan como preguntas o contactos (fase de respuestas, fuera del MVP).

## Facebook Marketplace

- **Sin API pública** para publicar avisos de particulares en Chile.
- **Mecanismo:** Playwright con un **perfil de navegador persistente por corredor**. El corredor inicia sesión a mano una vez; el sistema nunca ve su contraseña.
- **Flujo:** el worker abre el formulario de "Propiedad en venta o alquiler", llena campos, sube fotos y deja todo listo. El estado pasa a `awaiting_manual_confirm` y el operador hace el **clic final**. Luego pega la URL o el sistema la detecta.
- **Riesgos:** cambia el HTML sin aviso (los selectores se rompen), y Meta puede restringir cuentas por automatización. Mitigaciones:
  - Clic final humano.
  - Ritmo lento, con pausas aleatorias.
  - Máximo N avisos por día (configurable).
  - Selectores centralizados en un solo archivo.
  - Capturas de pantalla ante errores.
- **Nunca** resolver captchas ni evadir verificaciones: si aparece una, se detiene y avisa al operador.

## Yapo (post-MVP)

Sin API pública conocida. Evaluar el mismo enfoque que Marketplace y revisar sus términos de uso antes.

## TikTok (post-MVP)

Content Posting API. Las apps no auditadas solo pueden publicar en modo privado (verificar); requiere auditoría para publicar en público.

## Checklist para agregar una plataforma nueva

1. Nota de integración en `docs/integraciones/<plataforma>.md`: auth, límites, formatos y riesgos.
2. ADR si el mecanismo es nuevo (ej. primera integración por navegador).
3. Agregar el valor al enum `platform` con una migración.
4. Implementar `Publisher` en `packages/publishers/<plataforma>/` con tests de contrato (HTTP simulado con msw).
5. Plantilla de contenido y variantes de medios para la plataforma.
6. Probar en `dry-run`, luego en `live` con cuenta de prueba.
