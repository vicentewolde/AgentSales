# ManyChat y la mensajería de Instagram (nota de integración, piloto F10)

Verificada el **2026-10-19**, solo lectura (sin llamadas). Las páginas oficiales de ManyChat (precios, ayuda y documentación de la API) dieron 403 o un desafío de Cloudflare que no se intentó saltar: **todo lo de ManyChat es SNIPPET o PISTA**. Lo de Meta sí se leyó en su documentación.

Convención: **DOC** = página oficial leída; **SNIPPET**; **PISTA** = terceros; **INFERENCIA**; **NO VERIFICADO**.

## 1. Qué es y cómo lo usan las inmobiliarias
- ManyChat conecta Instagram, Messenger, WhatsApp, SMS y TikTok. Disparadores: comentarios en posts y reels, respuestas a historias, palabras clave en DM, menciones, Live, anuncios y enlaces con `ref` (PISTA). Caso típico: «comenta PENTHOUSE y te envío el plano», captura de correo y lead al CRM (PISTA). Una configuración mala genera spam o restricciones de la cuenta (PISTA).
- **Precios (PISTA, Featurebase 2026-10-07 y Kanal 2026-10-11; modelo nuevo desde 2026-03-02):** Free $0 (25 contactos, 4 automatizaciones); Essential $17 mensual o $14 anual (250); Pro $39 o $29 (2.500); Business $99 o $69 (7.500); Advanced $199 o $139 (25.000). Las cuentas anteriores a marzo de 2026 pueden seguir con el esquema viejo: mirar el plan real de la corredora. Los mensajes de WhatsApp y SMS se cobran aparte (Meta y los operadores). Los *External Request* requieren Pro o superior (un moderador de la comunidad, mayo de 2026).
- **Socio:** dice ser Meta Business Partner (blog propio, SNIPPET) y renovó la certificación técnica de WhatsApp en febrero de 2026 (PISTA). Hay un *Agency Partner Program* visto solo en ofertas de empleo. Que sea «Tech Provider» con ese nombre exacto: NO VERIFICADO.
- **«RE/MAX usa ManyChat»: no está verificado.** La única fuente es un listado de datos (Landbase, 2025-08-17) que pone a RE/MAX EE. UU. en una tabla de muestra; no hay casos publicados de RE/MAX, Keller Williams, Century 21 ni de corredoras chilenas. Cada franquicia decide sus herramientas. Lo verificable: la corredora del piloto lo usa hoy, según el operador.

## 2. API e integración (PISTA: espejos de terceros, no la doc oficial)
- Clave por página (Settings → API), `Authorization: Bearer` a `api.manychat.com`. Pro o superior para la API: PISTA débil.
- **Endpoints:** página (`getInfo`, `getTags`, `createTag`, `getCustomFields`, `createCustomField`, `getBotFields`, `setBotField(s)`, `getFlows`, `getGrowthTools` solo lectura); suscriptor (`getInfo`, `findByName`, `findByCustomField`, `findBySystemField`, `createSubscriber`, `updateSubscriber`, `addTag`/`removeTag`, `setCustomField(s)` máx. 20 por llamada); envío (`sendContent`, `sendContentByUserRef`, `sendFlow`, máx. 100 por suscriptor por hora).
- **Límites (PISTA):** 10 consultas por segundo por chatbot en suscriptor, 100 por segundo en lecturas de página, 20 en `sendFlow`, 25 en `sendContent`.
- **Entrada y salida:** acción *External Request* (Pro) que llama a una URL, y *Dynamic Block* que devuelve JSON v2. Zapier tiene 6 disparadores y 9 acciones; Make tiene «Send a flow».
- **Lo que AgentSales podría hacer (INFERENCIA):** crear la etiqueta y el campo con el id de un aviso; recibir el lead por un *External Request* hacia un webhook propio; leer etiquetas y campos de un lead; disparar un flujo con `sendFlow` dentro de la ventana de 24 h.
- **Lo que no (INFERENCIA por ausencia):** crear o editar flujos, crear disparadores de comentarios (los *growth tools* son solo lectura), leer el historial de mensajes, suscribirse a eventos por API (la salida es por *External Request*, Zapier o Make), enviar fuera de la ventana sin un tag válido. **ManyChat no expone el `ad_id`** (comunidad, 2026-06); la solución es una automatización por anuncio con el disparador «Instagram Ads» que ponga una etiqueta o un campo.

## 3. Mensajería de Instagram por la API de Meta (DOC)
| Tema | Dato |
|---|---|
| Permisos | `instagram_business_basic` + `instagram_business_manage_messages` (DM); `instagram_business_manage_comments` (respuestas privadas) |
| Ventana | 24 h desde el mensaje del usuario; hasta 7 días tras el primer mensaje de un anuncio a Direct; el tag `HUMAN_AGENT` da 7 días, solo con respuesta humana y no promocional |
| Respuestas privadas | un solo mensaje por comentario, dentro de 7 días; después solo si la persona responde, dentro de 24 h |
| *Ice breakers* | máximo 4 preguntas, por `messenger_profile`; no disponibles en escritorio |
| Límites | Send API 100 por segundo (texto y enlaces), 10 por segundo (audio y video); respuestas privadas a posts y reels 750 por hora |
| Acceso | **Estándar:** «negocio que posees o administras», sin App Review. **Avanzado:** para servir a otras cuentas, con App Review y Business Verification |
| *Human Agent* | función aparte de App Review; solo con bandeja propia para escalar a un humano |
| Bots | responder en 30 s; declararse bot cuando la ley lo exija |

**¿Puede AgentSales hacer su propio «comentario a DM»?** Técnicamente sí. Necesitaría un webhook HTTPS firmado para `comments` y `messages`, una cola con tope de 750 respuestas por hora, manejo de duplicados, estado de conversación, política de privacidad y borrado de datos, y —si atiende más de una cuenta— acceso avanzado con App Review, Business Verification y un video de cada permiso (plazos no documentados). Como Tech Provider procesaría datos a nombre de cada cliente y debería separarlos y mantener la lista de clientes (Platform Terms 5.b). Para una sola corredora, el acceso estándar evita App Review, pero si es un negocio ajeno el encaje exacto con «posees o administras» es INFERENCIA. **No verificado:** cómo conviven dos apps (ManyChat y AgentSales) suscritas a los mensajes de una misma cuenta.

## 4. Anuncios «clic a mensaje»
- Se crean con `destination_type=INSTAGRAM_DIRECT`, objetivo Engagement, Sales o Traffic, y optimización `CONVERSATIONS`; requieren `ads_management`, `pages_manage_ads` y un `instagram_actor_id` (DOC). Un flujo de una app *partner* se enlaza con `partner_app_welcome_message_flow_id` (DOC); que ManyChat esté registrado como esa app partner para crear anuncios por API: NO VERIFICADO.
- El webhook del clic trae `referral` con `ref`, `ad_id`, `source=ADS`, `type=OPEN_THREAD` y `ads_context_data` (DOC). Los enlaces `ig.me/m/<usuario>?ref=<ref>` pasan el `ref` (hasta 2.083 caracteres, solo `A-Z a-z 0-9 - _ =`).
- **Si AgentSales crea el anuncio ya conoce `ad_id`, `ref` y el aviso**, así que puede atribuir el lead sin depender de ManyChat.
- **Medición:** la Conversions API for Business Messaging permite enviar eventos como `LeadSubmitted` y `QualifiedLead`; está pensada para *Business Messaging Partners* y, para Instagram, requiere `instagram_manage_events` en acceso avanzado (DOC).

## 5. WhatsApp Business Platform en Chile (DOC)
Cobro por mensaje desde 2025-07-01; ventana de servicio de 24 h; 1.000 mensajes de servicio gratis por número al mes, y desde el 1 de octubre de 2026 se cobra desde el 1.001; los mensajes de utilidad dentro de la ventana, antes gratis, también se cobran desde esa fecha. Un clic desde un anuncio a WhatsApp abre una ventana de entrada gratis de hasta **7 días** (otras fuentes dicen 72 h: contradicción). Chile tiene tarifa propia y facturación en CLP desde 2026-04-01. Cifras de julio de 2026 (PISTA): marketing US$0,0889, utilidad US$0,0200, autenticación US$0,0200; confirmar la tarifa oficial en el Billing Hub. Que los avisos de Portal usen el WhatsApp del corredor es una coincidencia de canal; si se pasa a la API, ese número deja de usarse con la app móvil de la forma habitual (INFERENCIA).

## 6. Alternativas
Chatfuel (desde ~US$20), Botpress (para desarrolladores), Respond.io y Kommo (bandejas con CRM; Kommo tiene Conversions API conectada a etapas del embudo). Los CRM inmobiliarios de la región (Tokko Broker, EasyBroker, Cliengo) no tienen datos de adopción en Chile que cambien la decisión.

## 7. Normas y riesgos
- **Meta:** una respuesta pública repetitiva o muchos DM rápidos pueden restringir la cuenta, y ManyChat no puede revertirlo (PISTA). El primer mensaje privado no abre la ventana de 24 h: la persona debe responder o tocar un botón. Los tags no sirven para promoción.
- **Ley 21.719:** vigente desde 2026-12-01 salvo que se apruebe el proyecto 18.623-07 que la posterga un año; no se pudo leer el texto oficial. Lo que sale de las fuentes (PISTA): deber de informar y finalidad específica, derecho de oposición al marketing directo, plazos de respuesta de 30 más 30 días, consentimiento previo, informado y específico, multas hasta 20.000 UTM. Lo prudente: consentimiento específico y aviso de privacidad. Ver `docs/adr/0033-…`.

## 8. Estrategias frente a ManyChat
| Estrategia | Pros | Contras |
|---|---|---|
| **Integrarse** (ManyChat atiende; AgentSales origina avisos y anuncios) | poco código; aprovecha lo que la corredora ya paga; sin App Review de mensajes | depende del plan Pro, de una API limitada y no oficial en lo leído, y de que `ad_id` no se expone |
| **Reemplazar** (comentario a DM y bandeja propios) | control total y atribución exacta | App Review y mantenimiento; riesgo de Meta sobre automatización; se pierde lo que la corredora ya armó; no aporta valor propio hoy |
| **Convivir** (separados, vínculos mínimos) | riesgo cero; entrega rápida | duplicación manual; medición parcial |

**Decisión del operador (2026-10-19): convivir con integración ligera, con una interfaz propia (`LeadSource`) que permita reemplazar ManyChat si se cumple alguna condición** (`docs/adr/0033-los-leads-se-atribuyen-y-manychat-convive.md`).

## 9. Pruebas a mano
1. En ManyChat, ver en Settings → API si el plan permite generar una clave; anotar el plan exacto.
2. Crear un flujo de prueba con un *External Request* a un webhook de prueba (no producción) y ver qué llega.
3. Hacer un anuncio «clic a Instagram Direct» pequeño y ver en Ads Manager si el flujo aparece como *Partner App*.
4. En un mensaje que llegue de un anuncio, ver qué campos de `referral` aparecen y si ManyChat guarda el `ad_id` o el `ref`.
5. Probar un `ig.me/m/<usuario>?ref=prueba` y ver si ManyChat lo reconoce como disparador.
6. Confirmar con Meta si dos apps pueden estar suscritas a los mensajes de la misma cuenta.
7. Confirmar en el Billing Hub la tarifa de WhatsApp para Chile y la moneda de facturación.

## 10. Preguntas
**Para el operador:** ¿qué plan de ManyChat tiene la corredora y cuántos contactos activos?, ¿de quién es la cuenta de ManyChat (la corredora o una agencia)?, ¿hay consentimiento escrito de los leads para guardar sus datos en AgentSales?, ¿cuántos leads al mes se esperan?
**Para un contacto de RE/MAX:** ¿usan ManyChat (u otra herramienta) a nivel de red, de franquicia o de cada corredor?, ¿qué flujo de comentario a DM usan y a qué CRM llegan los leads?, ¿tienen una política o un proveedor autorizado de mensajería?, ¿cómo miden hoy los leads de anuncios?, ¿tienen lineamientos de privacidad para la Ley 21.719?

## 11. Fuentes
Meta (DOC): [Messaging API](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api), [Private Replies](https://developers.facebook.com/docs/instagram-platform/private-replies), [Ice Breakers](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/ice-breakers), [límites](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/overview), [App Review](https://developers.facebook.com/docs/instagram-platform/app-review), [apps para otros negocios](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/app-review/apps-for-other-businesses), [apps para tu negocio](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/app-review/apps-for-your-own-business), [Platform Terms](https://developers.facebook.com/terms/), [política de Messenger](https://developers.facebook.com/docs/messenger-platform/policy/policy-overview), [Click to Instagram](https://developers.facebook.com/docs/marketing-api/ad-creative/messaging-ads/click-to-instagram), [flujos de bienvenida de anuncios](https://developers.facebook.com/documentation/business-messaging/messenger-platform/ads/ads-welcome-message-flows), [webhooks de Instagram](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/webhooks), [Conversions API for Business Messaging](https://developers.facebook.com/documentation/ads-commerce/conversions-api/business-messaging), [precios de WhatsApp](https://developers.facebook.com/docs/whatsapp/pricing).
ManyChat (PISTA): [Featurebase](https://www.featurebase.app/blog/manychat-pricing), [Kanal](https://getkanal.com/blog/manychat-instagram), [comunidad: External Requests](https://community.manychat.com/general-q-a-43/external-requests-10114), [comunidad: ad_id](https://community.manychat.com/general-q-a-43/track-the-ad-id-for-my-dm-ads-campaign-10466), [Zapier](https://zapier.com/apps/manychat/integrations), [Landbase](https://data.landbase.com/technology/manychat/).
