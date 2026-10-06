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
- **Setup:** app en developers.facebook.com con el producto Instagram; agregar la cuenta de prueba como tester de la app. Con acceso estándar (el de por defecto) la app funciona con cuentas que tienen rol en ella, sin App Review (verificado). Para cuentas de terceros hace falta acceso avanzado: App Review y verificación del negocio (verificado); el plazo de "2–4 semanas" no figura en la doc (NO VERIFICADO). El `client_id` y el `client_secret` del OAuth son el **Instagram app ID e Instagram app secret** del panel (Instagram > API setup with Instagram login > Business login settings), distintos de los de Settings > Basic; el operador confirmó el 2026-10-05 que `INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET` son ese par (pasos en `integraciones/instagram.md`, sección 2.1).
- **Flujo de publicación (verificado 2026-10-04):**
  1. Crear un contenedor por medio (`POST /{ig-user-id}/media`; los hijos de un carrusel llevan `is_carousel_item=true` y no llevan caption).
  2. Para carrusel (de 2 a 10 ítems), crear el contenedor padre con `media_type=CAROUSEL`, `children` y `caption`.
  3. Para video o reel (`media_type=REELS`, `video_url`), consultar `status_code` hasta `FINISHED`; Meta recomienda una consulta por minuto durante un máximo de 5 minutos. Un contenedor vive 24 h.
  4. Publicar (`POST /{ig-user-id}/media_publish` con `creation_id`) y leer el `permalink` del medio publicado (`GET /{media-id}?fields=permalink`; en carruseles, del ID del carrusel, no de los hijos).
- **Medios:** deben estar en una **URL pública** (usamos URLs prefirmadas de Cloudflare R2, con `Content-Type` correcto en cada archivo). La doc de Meta no dice nada sobre query strings, redirecciones ni `HEAD`, y una URL prefirmada de R2 queda atada al método `GET`. **Verificado el 2026-10-06:** Instagram acepta las URLs prefirmadas de R2 para imágenes (`pnpm ig:smoke` y el carrusel de la prueba en `live`) y para el reel (`video_url`, en la prueba en `live`). El plan B (dominio público propio para un prefijo del bucket, o subida reanudable del reel con `upload_type=resumable`) no hizo falta. La URL debe seguir vigente hasta que el contenedor llega a `FINISHED`: generarla justo antes de crear el contenedor, con vencimiento de 1 hora. Imágenes en JPEG sRGB, hasta 8 MB, proporción entre 4:5 y 1,91:1, ancho entre 320 y 1440 px (verificado 2026-10-02, `integraciones/instagram.md`). El carrusel se recorta a la proporción de la primera imagen, así que todas van en 4:5 (1080×1350). **Hasta 10 ítems por carrusel vía API (verificado).** Reels: la API acepta MOV o MP4 (sin edit lists, `moov` al inicio), HEVC o H.264, AAC, 23 a 60 fps, máximo 1920 px en horizontal, VBR hasta 25 Mbps, de **3 s a 15 min**, hasta 300 MB, proporción recomendada 9:16 (verificado). El tope de 3 a 90 s (spec F3, D7) es una decisión de producto, no un límite de Meta.
- **Límites (2026-10-04):** la guía de Meta dice 100 posts publicados por API por cuenta en una ventana móvil de 24 h, pero la referencia de `content_publishing_limit` dice `quota_total` "currently 50": la doc se contradice, así que el sistema lee `config.quota_total` en vez de fijar la cifra. Tope aparte de **400 contenedores** por cuenta en 24 h (un carrusel de N imágenes gasta N + 1). Un carrusel cuenta como 1 post (verificado). `content_publishing_limit` responde con Instagram Login en `graph.instagram.com` (inferido de la prueba en `live` del 2026-10-06: el publisher no dejó nota de cupo); el valor de `quota_total` y si un reel cuenta como 1 post: NO VERIFICADO. Llamadas: `4800 × impresiones` de la cuenta en 24 h.
- **Tokens (verificado 2026-10-04):** OAuth en `https://www.instagram.com/oauth/authorize`; el código dura 1 hora y es de un solo uso; el token corto dura 1 hora; se canjea por uno largo de **60 días** (`graph.instagram.com/access_token`, `ig_exchange_token`) y se refresca con `refresh_access_token` (`ig_refresh_token`) solo si tiene **al menos 24 h** y **no ha vencido** (un token vencido obliga a reconectar). Se necesita un job periódico. La cuenta se identifica con el `user_id` de `/me`, no con `id` (app-scoped). **Redirect URI:** el panel de Meta rechaza `http://localhost` (2026-10-05). En F3 la cuenta se conecta con el token del botón Generate token, que sirvió para `/me`, crear contenedores y publicar (2026-10-06); el OAuth se prueba en F7 con HTTPS (`integraciones/instagram.md`, sección 3.6).
- **Errores:** 190 (token) y permisos (10, 200 a 299) no se reintentan; límites (4, 17, 80002, 2207042) en F3 dejan la publicación en `failed` con el aviso de cuándo reintentar (la reprogramación automática es de F6); errores de descarga de medios (2207003, 2207052) y transitorios (2207001, 2207032, 2207053) se reintentan con contenedor nuevo. Tabla completa en `integraciones/instagram.md`, sección 7.
- **Caption:** el texto se guarda sin los hashtags (`contents.body`) y los hashtags aparte (`contents.hashtags`). El publisher envía `instagramCaption(content)` (core), que los suma después de una línea en blanco; enviar solo `body` publicaría sin hashtags. Límites de Meta (verificado 2026-10-04): 2.200 caracteres, 30 hashtags y 20 menciones.
- **Despublicar (corregido 2026-10-04):** existe `DELETE /{media-id}` en la API de Instagram (novedad del 2025-12-03), pero la referencia de Meta lo limita a **Facebook Login** (host `graph.facebook.com`, permiso `instagram_manage_contents`); con Instagram Login no está documentado. Se asume que no se puede por API y se borra a mano desde la app. No se intentó en F3 (spec F3, D8): las publicaciones de la prueba se borraron a mano. "Cerrar" en Instagram = marcar como no disponible en el sistema y avisar al operador para archivarlo o borrarlo a mano.

## Portal Inmobiliario (vía Mercado Libre)

Detalle verificado en `docs/integraciones/mercadolibre.md` (2026-10-06, leyendo la doc oficial con el navegador) y diseño en el spec F4.

- Portal Inmobiliario está integrado a Mercado Libre. Se publica en el sitio **MLC** con la API de ML (`POST /items`).
- **Clave:** en Chile hay que incluir el atributo `CMG_SITE` con `value_name: "POI"` para que el aviso aparezca en Portal Inmobiliario además de Mercado Libre.
- **Cuenta y costo:** publicar un inmueble exige un **paquete de publicación** (`silver`) con cupo; no hay publicación gratis ni sandbox. La app se crea con los datos del titular validados.
- **Setup:** app en el DevCenter de Mercado Libre, OAuth 2.0 (authorization code) con redirect URI **HTTPS** (no necesita cargar). En F4 el operador pega la dirección de vuelta en la CLI, sin túnel (spec F4, D1).
- **Tokens:** `access_token` de unas 6 h (se lee `expires_in`); `refresh_token` de 6 meses, **de un solo uso** y que rota en cada refresco: se refresca con un candado por cuenta (ADR-0015).
- **Contacto:** desde el 01/10/2026, `seller_contact` con WhatsApp (`country_code2` y `phone2`) es obligatorio al crear y actualizar. La descripción no puede llevar teléfono, dirección ni sitio web (moderación).
- **Título y fotos:** el largo máximo lo da `settings.max_title_length` de cada categoría (la cifra de MLC se confirma con `ml:smoke`; AgentSales usa 60). Fotos JPG o PNG de hasta 10 MB, recomendado 1200 px, al menos 1 obligatoria (12 como objetivo de calidad en casas y departamentos). F4 las sube directo (`/pictures/items/upload`).
- **Categorías, atributos y ubicación:** se descubren por API con token (árbol desde `MLC1459`, atributos con `tags.required`, `classified_locations` de Chile) y se cachean en la base. No se escriben a mano.
- **Moneda:** UF es `CLF` (2 decimales); CLP sin decimales.
- **Estados:** `active`, `paused` (también por moderación o mientras procesa fotos), `under_review`, `closed` (definitivo; republicar crea otro id). En MLC, casas y departamentos vencen a los 180 días en venta y a los 45 en arriendo. Validar sin publicar: `POST /items/validate` (usado en `dry-run`, ADR-0016).
- **Consultas de interesados:** llegan como preguntas o leads (fase de respuestas, fuera del MVP).

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
