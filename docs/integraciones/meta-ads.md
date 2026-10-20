# Meta Ads: anuncios sobre publicaciones de Instagram (nota de integración, piloto F10)

Verificada el **2026-10-19**, solo lectura (sin llamadas a la API). Las páginas de `developers.facebook.com` se leyeron con un extractor que resume el texto; algunas del Centro de ayuda para empresas llegaron vacías. Antes de implementar hay que confirmar los puntos críticos en las referencias de campos.

Convención: **DOC** = página oficial leída; **SNIPPET** = visto solo en un resultado de búsqueda; **PISTA** = terceros; **INFERENCIA** = deducido; **NO VERIFICADO** = falta una prueba real.

## 1. Impulsar una publicación de Instagram por API
No hay un endpoint «boost»: un anuncio cuya creatividad apunta a una publicación existente es el equivalente.

| Tema | Hallazgo | Fuente |
|---|---|---|
| Creatividad | `POST /act_{id}/adcreatives` con `object_id` (id de la Página), `instagram_user_id` y `source_instagram_media_id`; opcional `call_to_action` | DOC ([use-posts-as-ads](https://developers.facebook.com/documentation/ads-commerce/instagram/ads-api/guides/use-posts-as-ads)) |
| Id de la cuenta de IG | `{ad_account}/connected_instagram_accounts` o `{business}/instagram_business_accounts` | DOC |
| Medios elegibles | foto, video, carrusel, Reel y Stories activas; no los que tienen música con copyright ni elementos interactivos; IGTV no | DOC |
| Elegibilidad | campo `boost_eligibility_info` y `boost_ads_list` del medio: **solo con Facebook Login**, no con Instagram Login | DOC ([instagram-media](https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media.md)) |
| Campos nuevos | `instagram_actor_id` fue reemplazado por `instagram_user_id`, e `instagram_story_id` por `source_instagram_media_id`; los ejemplos de Click-to-Instagram aún muestran `instagram_actor_id` en `object_story_spec` | DOC (aviso de agosto de 2025) |
| Efecto lateral | una creatividad con `instagram_user_id` crea además un «post de anuncio»; los comentarios orgánicos se leen con `source_instagram_media_id` y los del anuncio con `effective_instagram_media_id` | SNIPPET |
| Anuncio sin Página | todos los ejemplos pasan un id de Página | NO VERIFICADO |

**Objetivos y destinos (DOC):** `OUTCOME_TRAFFIC` (sitio, WhatsApp, Messenger, Instagram Direct), `OUTCOME_LEADS` (formulario instantáneo `ON_AD`, sitio, WhatsApp), `OUTCOME_ENGAGEMENT` (`ON_POST`, WhatsApp, Instagram Direct), `OUTCOME_AWARENESS`, `OUTCOME_SALES` (depende del píxel; poco útil aquí). Los destinos `ON_AD`, `ON_POST`, `ON_VIDEO`, `ON_PAGE` y `ON_EVENT` figuran «en beta limitada» en una referencia y como válidos en otra: probar. Click-to-WhatsApp usa el CTA `WHATSAPP_MESSAGE` y necesita un número vinculado a la Página; click-to-Instagram usa `INSTAGRAM_MESSAGE` con `billing_event=IMPRESSIONS`.

**Presupuesto y estados (DOC):** `daily_budget` o `lifetime_budget` en la campaña (CBO) o en el conjunto, no ambos; `daily_budget` solo vale para conjuntos de más de 24 h; `lifetime_budget` exige `end_time`; `spend_cap` de campaña con mínimo de unos 100 USD; los mínimos por moneda salen del edge `minimum_budgets`. Al crear solo valen `ACTIVE` y `PAUSED`; el `effective_status` suma `IN_PROCESS`, `WITH_ISSUES` y `PENDING_REVIEW`. Límites de estructura: 200 conjuntos por campaña, 5.000 por cuenta regular, 50 anuncios por conjunto, 6.000 por cuenta regular.

## 2. Permisos y acceso
**El Instagram Login que usa AgentSales hoy no sirve para anuncios** (DOC, [overview](https://developers.facebook.com/documentation/instagram-platform/overview)): no requiere Página, los anuncios de colaboración no están soportados, `boost_eligibility_info` y `boost_ads_list` son solo para Facebook Login, y todos los ejemplos usan `graph.facebook.com`, un token de Facebook y el `object_id` de una Página. Una app de Meta usa un login o el otro. INFERENCIA: hace falta una **segunda app** (Facebook Login for Business) y que el id de usuario y de medio coincidan entre ambos flujos (unificación de ids de enero de 2025; **NO VERIFICADO**, prueba A1).

| Caso de uso | Permisos (DOC) |
|---|---|
| Crear y gestionar anuncios | `ads_management`, `ads_read`, `business_management`, Ads Management Standard Access, `pages_read_engagement`, `pages_show_list`, `public_profile` (`pages_manage_ads` opcional) |
| Medir | los mismos, sin `pages_manage_ads` |
| Leads | los anteriores más `leads_retrieval` y `pages_manage_ads`; `pages_manage_metadata` para los webhooks |

**Niveles de acceso (DOC, [autorización](https://developers.facebook.com/docs/marketing-api/overview/authorization)):**
- **Tu propia cuenta o cuentas de personas con rol en tu app** (admin, developer, tester): basta el acceso estándar; el nivel *Limited* deja que admins y desarrolladores llamen en nombre de los administradores de las cuentas.
- **Cuentas de terceros sin rol en tu app:** acceso avanzado a `ads_read` o `ads_management` vía App Review. Para mantenerlo y subir a *Full*: al menos 500 llamadas exitosas en 15 días, con menos de 15% de error en las últimas 500. *Limited* «no es para anunciantes en vivo»; el sandbox no permite crear anuncios.
- **Verificación del negocio:** un portafolio sin verificar puede conectarse pero debe verificarse antes de correr anuncios. La **verificación de acceso (Tech Provider)** exige Business Verification sin restricciones y que un admin describa cómo usas datos de otros negocios; rige para apps con `ads_management` o `business_management` usadas por otros negocios y es independiente de App Review. Plazo ~5 días para apps nuevas (SNIPPET); hay reportes de verificaciones atascadas más de 2 semanas (PISTA).
- **Tokens (DOC, Facebook Login for Business):** de usuario (corto), BISU (system user del cliente, ligado a su portafolio, por defecto no expira; con *Limited* 1 system user, con *Full* 10) y de system user propio (no expira). Los pasos exactos de *Partner access* y asignación de activos: NO VERIFICADO.
- **Revisión de la app:** por permiso, con *Ongoing Review* anual; se suma a lo que ya se prepara para los permisos de contenido (`docs/11-app-review-meta.md`). INFERENCIA: son dos conjuntos de casos de uso y de videos.

## 3. Categorías especiales: vivienda
- `special_ad_categories` es obligatorio en toda campaña: `NONE`, `HOUSING`, `EMPLOYMENT`, `FINANCIAL_PRODUCTS_SERVICES`, `ISSUES_ELECTIONS_POLITICS`; `special_ad_category_country` es obligatorio si eliges una categoría (DOC).
- **Dónde se impone (DOC):** anunciantes de EE. UU. o que apunten a EE. UU., Canadá o «ciertas partes de Europa». **Chile no se menciona.** Fuera de esas zonas el anunciante puede elegir `NONE` o una categoría (opt-in/opt-out). INFERENCIA: no es obligatorio si se apunta solo a Chile; si el aviso se muestra a audiencia en EE. UU., Canadá o Europa, las restricciones sí aplican.
- **Con `HOUSING`:** edad fija 18-65+, todos los géneros, sin exclusión de ubicaciones, radio mínimo de 15 km o millas, sin códigos postales ni barrios, sin segmentación por comportamiento o demografía, sin lookalikes; sí audiencias personalizadas y Advantage+. Una categoría incorrecta puede pausar los anuncios (error duro `2909035`; el `2859024` pide que un admin acepte la política de no discriminación).
- No hay una política inmobiliaria específica de Chile (NO VERIFICADO); Meta dice aplicar las mismas políticas en todo el mundo.

## 4. Facturación y cuentas
- **Medios de pago en Chile (SNIPPET):** tarjetas Visa, Mastercard y Amex, PayPal y manuales (Redcompra, Mercado Pago). Los manuales exigen país Chile y moneda CLP y se eligen solo al crear la cuenta; no se puede cambiar entre automático y manual después. La **moneda se fija al crear la cuenta** (DOC): cambiarla implica una cuenta nueva.
- **IVA:** 19% sobre publicidad en redes (PISTA); qué entidad factura: NO VERIFICADO.
- **Límites de gasto (DOC):** `spend_cap` de cuenta, máximo 10 cambios al día; `spend_cap_action` acepta `reset` o `delete`. Meta pone un límite diario a cuentas nuevas que no se puede subir a pedido (PISTA).
- **Cuentas inhabilitadas (DOC):** 15 `disable_reason`, entre ellos `ADS_INTEGRITY_POLICY`, `RISK_PAYMENT`, `BUSINESS_INTEGRITY_RAR`, `COMPROMISED_AD_ACCOUNT`, `MISREPRESENTED_AD_ACCOUNT`. Cómo evitarlas (PISTA): evitar accesos desde muchas IP, cambios frecuentes de pago y saltos grandes de presupuesto; la página *Calidad de la cuenta* muestra el motivo. Máximo 25 cuentas por persona en un Business Manager.
- **IA y creatividades (DOC):** las funciones generativas de texto, expansión de imagen y fondo requieren `OPT_IN` y el anunciante revisa la vista previa; un anuncio con generación de texto se crea `PAUSED`; las imágenes muy editadas pueden llevar la etiqueta «AI info». Que sea obligatorio declarar contenido procesado con IA: NO VERIFICADO. INFERENCIA: guardar cómo se generaron las fotos y reels del pipeline.

## 5. Límites y operación
- **Cuota `ads_management` por cuenta y hora (DOC):** *Limited* 300 + 40 × anuncios activos; *Full* 100.000 + 40 × anuncios activos. Puntaje: lectura 1, escritura 3; *Limited* máximo 60 y *Full* 9.000, con decaimiento de 300 s. Insights: *Limited* 600 + 400 × anuncios activos; *Full* 190.000 + 400 × anuncios activos.
- **Mutaciones:** 100 por segundo por app y cuenta; una edición cada 30 s por objeto; 4 cambios de presupuesto por hora y conjunto. Errores de límite: `17/2446079`, `613/1487742`, `613/5044001`, `80000/80004`, `613/1487632`, `613/1487225` (límite de creación).
- **Revisión:** un cambio de creatividad o segmentación vuelve a revisión; presupuesto, puja y calendario no. Minutos a 24 h (PISTA).
- **Webhooks (DOC):** sobre `ad_account`: `effective_status`, `with_issues_ad_objects`, `in_process_ad_objects`, `creative_fatigue`, `ad_recommendations`.
- **Insights (DOC):** se refrescan cada 15 min y dejan de cambiar a los 28 días; se reportan en la zona horaria de la cuenta; jobs asíncronos de hasta 1 h. Retención de otros datos: NO VERIFICADO.

## 6. Lead Ads
- **Crear el formulario (DOC):** Página, `ads_management`, `pages_manage_ads`, `pages_read_engagement`, `pages_show_list` y un token de Página de alguien con la tarea ADVERTISE. Los formularios no se borran, solo se archivan.
- **Leer los leads (DOC):** `leads_retrieval`; límite 200 × 24 × leads de los últimos 90 días de la Página. **Webhook `leadgen`** del objeto Página: solo trae `leadgen_id`, `form_id` y `ad_id`; los datos se piden después (`field_data` con nombre, correo, teléfono y preguntas propias).
- **Modo desarrollo (DOC):** la app en desarrollo no recupera leads reales, solo los de usuarios con rol; en *Live* recupera todos. Pasa por App Review y después Business Verification.
- **Mensajes (DOC):** click-to-WhatsApp e Instagram Direct usan `destination_type` propio con optimización `CONVERSATIONS`; con objetivo Leads y WhatsApp solo vale `CONVERSATIONS`. La conversación llega a la bandeja de IG o WhatsApp; si ManyChat la sigue atendiendo no se verificó (`manychat.md`).
- **Privacidad:** los Términos de Lead Ads piden enlace a una política de privacidad y avisos adecuados (SNIPPET/PISTA; no se leyeron los términos oficiales). **Ley 21.719** en vigor el 2026-12-01 salvo postergación: confirmar con un abogado.

## 7. Riesgos de plataforma
- Meta prohíbe lo que imite comportamiento humano o evada la revisión (DOC; la política de evasión de sistemas no se pudo leer, 404) y no permite crear Páginas por API. Crear anuncios en cuentas nuevas con mucha frecuencia choca con el límite de creación (INFERENCIA).
- Un token de system user no queda ligado a una persona (DOC). Los términos sobre responsabilidad del gestor: NO VERIFICADO. INFERENCIA: si la cuenta del cliente cae, el cliente la pierde; conviene un contrato claro.
- **Meta Business Partner:** membresías y un nivel con insignia, con requisitos de gasto y certificaciones (PISTA, cifras contradictorias); sin datos oficiales para Chile.

## 8. Qué se puede ofrecer hoy con la API oficial
1. Impulsar un post o Reel ya publicado como anuncio (campaña, conjunto, anuncio y creatividad), empezando en `PAUSED`.
2. Objetivos: Tráfico (sitio, WhatsApp o Instagram Direct), Leads (formulario instantáneo) y Engagement; presupuesto diario o total; pausa y reanudación; métricas con Insights y webhook de estado.
3. Requisitos: segundo flujo de login (Facebook Login for Business), Página vinculada, cuenta publicitaria con pago y portafolio verificado.
4. **Piloto sin App Review:** la corredora y el operador como roles de la app (los leads reales de terceros no llegan en modo desarrollo). **Producción con varias oficinas:** acceso avanzado a `ads_management`, verificación de acceso y Business Verification, más las 500 llamadas en 15 días.
5. Vivienda en Chile: `NONE`, o `HOUSING` por opt-in. Se cobra a cada cuenta, sin intermediar el pago.

## 9. Pruebas a mano (prioridad)
1. En Ads Manager, impulsar a mano un post y un Reel de la cuenta de prueba; ver si el IG está vinculado a una Página y si el pago funciona en CLP.
2. Comprobar si se puede crear un anuncio sin Página vinculada.
3. **A1:** con Graph API Explorer y un token de Facebook, leer `boost_eligibility_info` de un post y de un Reel publicados por AgentSales; confirmar que el id del medio coincide con el que ve el flujo de Instagram Login. **Es la que más cambia el diseño.**
4. **A2:** comprobar si existe una validación sin efectos (`execution_options=["validate_only"]`) al crear un anuncio.
5. Crear una campaña con `special_ad_categories=[]` y otra con `HOUSING` dirigida a Chile y comparar qué segmentación queda.
6. Con presupuesto mínimo, crear por API creatividad, conjunto y anuncio `PAUSED` con `source_instagram_media_id`; probar tráfico, WhatsApp, Instagram Direct y formulario instantáneo; medir cuánto tarda la revisión y qué la reactiva.
7. Revisar los medios de pago, la moneda y el IVA en la factura; probar un lead de prueba con la app en desarrollo y un usuario con rol; mirar *Calidad de la cuenta*.

## 10. Fuentes
[use-posts-as-ads](https://developers.facebook.com/documentation/ads-commerce/instagram/ads-api/guides/use-posts-as-ads), [instagram-media](https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media.md), [aviso de campos (2025-08-11)](https://developers.facebook.com/blog/post/2025/08/11/instagram-marketing-api-update/), [unificación de ids (2025-01-21)](https://developers.facebook.com/blog/post/2025/01/21/making-it-easier-to-build-integrations-across-the-instagram-api-and-marketing-api/), [overview de Instagram](https://developers.facebook.com/documentation/instagram-platform/overview), [casos de uso](https://developers.facebook.com/documentation/development/create-an-app/marketing-api-use-cases.md), [autorización](https://developers.facebook.com/docs/marketing-api/overview/authorization), [Access Verification](https://developers.facebook.com/docs/development/release/access-verification), [Facebook Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business), [special-ad-category](https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/special-ad-category), [políticas de prácticas discriminatorias](https://transparency.meta.com/policies/ad-standards/unacceptable-content/discriminatory-practices/), [rate limiting](https://developers.facebook.com/documentation/ads-commerce/marketing-api/overview/rate-limiting), [webhooks de anuncios](https://developers.facebook.com/documentation/ads-commerce/marketing-api/ads-webhooks/ads-webhooks-overview), [best practices de insights](https://developers.facebook.com/docs/marketing-api/insights/best-practices), [crear Lead Ads](https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/create.md), [leer leads](https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving), [webhooks de Lead Ads](https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/quickstart/webhooks-integration.md), [IA generativa en anuncios](https://developers.facebook.com/documentation/ads-commerce/marketing-api/creative/generative-ai-features.md), [click-to-WhatsApp](https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/messaging-ads/click-to-whatsapp.md), [click-to-Instagram](https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/messaging-ads/click-to-instagram.md).
Mercado y precios de competidores (investigación del 2026-10-19, fuentes de terceros): Real Geeks, Ylopo, Adwerx, Madgicx, Birch, Metricool, Hootsuite, Sprout y Planable cobran suscripción plana; el hueco que AgentSales puede cubrir es el gobierno de franquicia (tope de gasto y aprobación por nivel con auditoría). Ver `docs/adr/0032-…` y `docs/specs/fase-9-contenido-de-marca.md` §4.17.
