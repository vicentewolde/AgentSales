# Portal Inmobiliario y Mercado Libre (MLC)

Nota **verificada el 2026-10-06 leyendo la doc oficial con el navegador** (developers.mercadolibre.cl, versión `es_ar`), para planificar F4: publicar en Portal Inmobiliario con la API de Mercado Libre, sitio MLC. Reemplaza la versión anterior del mismo día, que se basaba en resúmenes del buscador.

## Cómo leer esta nota (importante)

Convención: **DOC** = leído en la página oficial (la URL y su fecha de "Última actualización" están en la sección 10); **INFERENCIA** = deducido de lo leído; **NO VERIFICADO** = la doc no lo dice o lo dice solo con ejemplos de otro país; se confirma con la cuenta de prueba.

**Método y límites:**

- Se leyeron 34 páginas de developers.mercadolibre.cl con el navegador integrado (texto de la página, no resúmenes). Todas existían en la versión `.cl`; no hizo falta ir a otro sitio.
- **No se llamó a `api.mercadolibre.com`** (exige token). Por eso **ningún `settings` de una categoría de MLC se leyó**: la doc trae casi todos los ejemplos de Argentina (MLA). Lo que es de MLA se dice.
- Las páginas de inmuebles son de nov-2025 y algunas se actualizaron en 2026; cuando dos páginas se contradicen, se dice y se prefiere la más reciente.

## 1. Resumen

- **Mecanismo:** API de Mercado Libre (`https://api.mercadolibre.com`), sitio **MLC**. Se publica con `POST /items`; en Chile el atributo `CMG_SITE` con `value_name: "POI"` hace que el aviso salga también en Portal Inmobiliario (DOC).
- **Madurez:** alta: hay una guía completa de inmuebles (categorías, atributos, ubicación, paquetes, publicar, actualizar, ciclo de vida, calidad, leads). **Riesgo: medio**, por la cuenta, no por la técnica: hace falta un **paquete de publicación `silver`** con cupo (no hay publicación gratis de inmuebles) y, en la cuenta de prueba, pedir a soporte la activación del usuario (sección 2).
- **Autenticación:** OAuth 2.0 authorization code; `access_token` de **6 horas** según el texto (los ejemplos traen `expires_in` 10800 y 21600: leer `expires_in`); `refresh_token` de **6 meses, de un solo uso** y que rota en cada refresco (DOC).
- **Redirect URI:** **HTTPS obligatorio** al crear la app (DOC); la guía de inmuebles dice que se puede poner **una URL de prueba "incluso si no existe"** (DOC). `localhost`: VERIFICADO el 2026-10-08, el panel lo rechaza; quedó `https://agentsales.test/oauth/mercadolibre/callback` (§3.3).
- **Probar sin pagar:** usuarios de prueba (`POST /users/test_user`); con un usuario de prueba **se puede contratar cualquier paquete sin cargo** (DOC). `POST /items/validate` valida el body sin publicar y responde `204` (DOC). No hay sandbox (DOC).
- **Desde el 01/10/2026** (ya vigente), `seller_contact` con `country_code2` y `phone2` (WhatsApp) es **obligatorio al crear y al actualizar** cualquier inmueble (DOC).
- **Fotos por URL:** el ítem queda `paused` o `not_yet_active` con `sub_status` `picture_download_pending` y **se activa solo** cuando ML descarga las fotos; si fallan, pasa a `under_review` (DOC). ML **no sigue redirecciones** (DOC).
- **Vigencia en MLC:** casas y departamentos en venta **180 días**, en arriendo **45 días**; después el ítem pasa a `closed` / `expired` (DOC).
- **Cerrar es definitivo:** un `closed` no se reactiva; se republica con `relist` y queda con **id nuevo** (DOC).
- **Sigue NO VERIFICADO (lo más importante):** los ids MLC de las categorías hoja (solo se conoce `MLC1459` = Inmuebles), los `settings` de esas categorías (`max_title_length`, `max_pictures_per_item`, `currencies`), si `CLF` se acepta en cada hoja, el precio real del paquete para un corredor y si ML descarga bien una URL prefirmada de R2 (que `https://localhost` no se acepta como redirect quedó verificado el 2026-10-08, §3.3).

## 2. Requisitos de cuenta y app

| Requisito | Dato | Fuente |
|---|---|---|
| Crear la app | En el DevCenter, "Crear nueva aplicación". En Argentina, México, Brasil y **Chile** solo se puede crear tras **incluir y validar los datos del titular**, que deben ser exactamente los del registro de la cuenta. Se recomienda que la cuenta dueña de la app sea la del propietario de la solución, idealmente una entidad legal | DOC |
| Apps separadas ML / Mercado Pago | Desde el 30/08/2026 cada app debe ser de una sola unidad (ML o MP); las que no se adecuen pierden acceso. Revisar con `GET /applications/$APP_ID` que no haya scopes `urn:mp:...` | DOC |
| Datos de la app | Nombre único, descripción (hasta 150 caracteres, se muestra al pedir autorización), logo, **URIs de redirect (HTTPS obligatorio)**, opción **PKCE** (opcional, recomendada), opción Device Grant, scopes, tópicos y URL de notificaciones | DOC |
| Scopes | Lectura (GET) y escritura (PUT, POST, DELETE). `offline_access` da el `refresh_token` para actuar con el usuario desconectado. Valores aceptados en `scope`: `offline_access`, `write`, `read` | DOC |
| Permisos funcionales | Se marcan en la app. Para F4 hace falta **"Publicación y sincronización"** (items, pictures, prices) además de "Usuarios" (activo por defecto). "Comunicación pre y postventa" solo si se quisieran preguntas o leads | DOC |
| Client Secret | Se puede "renovar ahora" (el anterior caduca al instante) o "programar renovación" (hasta 7 días; conviven dos secrets). Renovarlo **invalida los tokens** de los usuarios | DOC |
| Quién autoriza | El **administrador** de la cuenta del corredor. Si autoriza un operador o colaborador, el grant falla con `invalid_operator_user_id` | DOC |
| Paquete de publicación | **Obligatorio**: "sin este paquete, no es posible crear ningún anuncio". Listing type `silver` = paquete de publicación (cada aviso descuenta un cupo); `gold` y `gold_premium` = paquetes de destaque, opcionales | DOC |
| Cupo | Si se agota, no se pueden crear avisos nuevos y los existentes "pueden ser despublicados". Los cupos tardan minutos en liberarse: cerrar y reactivar rápido puede **perder cupos** | DOC |
| Consultar paquetes | Disponibles para contratar: `GET /categories/MLC1459/classifieds_promotion_packs`. Contratados por el usuario: `GET /users/$USER_ID/classifieds_promotion_packs?package_content=publications&status=active` (trae `remaining_listings`, `date_expires`). Por tipo: `GET /users/$USER_ID/classifieds_promotion_packs/silver?categoryId=MLC1459` | DOC |
| Contratar | En el sitio (no por API): Mi perfil > Ventas > Resumen > "Paquetes de publicación" > Contratar. La sección **solo aparece si el usuario está activado** por soporte | DOC |
| Activación del usuario | Se pide a soporte con un formulario ("activar usuario"). Registrarse como inmobiliaria es **opcional** y da acceso a paquetes para inmobiliarias | DOC |
| Costo del paquete en Chile | El único dato es un **ejemplo** de respuesta para `MLC1459`: "10000 Publicaciones Plata", marca `PORTALINMOBILIARIO`, `price: 345.1`, `duration: 30` días, sin moneda. No sirve como precio real. **Precio y cupo del plan de cada corredor: NO VERIFICADO** | DOC (ejemplo) / NO VERIFICADO |
| `CMG_SITE` | No se documenta costo adicional | NO VERIFICADO |
| Tipo de usuario | `GET /users/me` trae `user_type` (por ejemplo `real_estate_agency`) y `tags`. La doc de moderaciones distingue inmuebles de `user_type` `normal` y `real_estate_agency`, así que un vendedor que no es inmobiliaria también publica inmuebles | DOC; lo de "normal": INFERENCIA |
| Revisión de la app | No hay un proceso de revisión previo como el de Meta. Existe una certificación opcional (DPP) que se muestra al vendedor al autorizar | DOC (no se encontró revisión obligatoria) |

**Pregunta abierta para el operador:** si el corredor ya tiene un plan pagado de Portal Inmobiliario, ¿ese plan aparece como `classifieds_promotion_packs` con cupo `silver` para la API? Se responde con `GET /users/$USER_ID/classifieds_promotion_packs` una vez conectada su cuenta (NO VERIFICADO).

## 3. Autenticación

### 3.1 Flujo (DOC)

Authorization code "server side":

1. El usuario abre `https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=$APP_ID&redirect_uri=$REDIRECT_URI&state=$STATE` (más `code_challenge` y `code_challenge_method` si PKCE está activo). La doc usa Argentina y dice **cambiar `.com.ar` por el dominio del país**: para Chile, `https://auth.mercadolibre.cl/authorization` (DOC la regla; el host exacto se confirma al probar).
2. El usuario vincula la app y ML redirige a `https://REDIRECT_URI?code=$CODE` (y `state` si se envió).
3. Canje: `POST https://api.mercadolibre.com/oauth/token` con `content-type: application/x-www-form-urlencoded`, **parámetros en el cuerpo**: `grant_type=authorization_code`, `client_id`, `client_secret`, `code`, `redirect_uri` y, con PKCE, `code_verifier`.
4. Respuesta: `access_token` (`APP_USR-...`), `token_type` (`bearer` o `Bearer` según el ejemplo), `expires_in`, `scope` (`offline_access read write`), `user_id`, `refresh_token` (`TG-...`).

| Parámetro | Obligatorio | Nota (DOC) |
|---|---|---|
| `response_type` | sí | `code` |
| `client_id` | sí | App ID |
| `redirect_uri` | sí | **Idéntica** a la registrada, sin información variable; lo variable va en `state` |
| `state` | no, pero recomendado | Único por intento (la doc sugiere SecureRandom) |
| `code_challenge`, `code_challenge_method` | solo con PKCE activo, y entonces obligatorios | `S256` recomendado; `plain` existe pero no se recomienda |

- **Vida del `code`:** no figura (NO VERIFICADO). La guía dice que cada access token nuevo necesita un code nuevo: canjearlo de inmediato.
- **Token siempre por header** `Authorization: Bearer ...`, nunca en la URL (DOC).
- **"La aplicación no puede conectarse a tu cuenta":** redirect distinto, token o grant inválido, el vendedor entró con un colaborador, o el vendedor o el dueño de la app tienen **datos pendientes de validación** o una inhabilitación (DOC).
- Se puede autorizar con un **usuario de prueba** (DOC).

### 3.2 Tokens

| Dato | Valor | Fuente |
|---|---|---|
| Vida del `access_token` | **6 horas** según el texto de dos páginas; los ejemplos traen `expires_in: 10800` (autenticación) y `21600` (guía de inmuebles). **Usar `expires_in`** | DOC (ejemplos contradictorios) |
| Cuándo refrescar | La página de autenticación sugiere renovar "únicamente cuando pierda validez"; la guía de seguridad sugiere refrescar antes de vencer, "por ejemplo a las 5 horas". Se puede seguir la segunda | DOC (dos criterios) |
| `refresh_token` | Vale **6 meses**; luego expira y hay que volver a autorizar | DOC |
| Uso único | **Sí.** Solo sirve el **último** generado, una sola vez y solo con su `client_id`; cada refresco entrega uno nuevo que hay que guardar | DOC |
| Refresco | `POST /oauth/token` con `grant_type=refresh_token`, `client_id`, `client_secret`, `refresh_token` (en el cuerpo) | DOC |
| Qué invalida los tokens | Cambio de contraseña del usuario; renovación del Client Secret; el usuario revoca los permisos; **4 meses sin ninguna llamada** a `api.mercadolibre.com`; revocaciones internas de ML (borrado de sesión, desvinculación de dispositivos, detección de fraude) | DOC |
| `invalid_grant` | HTTP 400, `"error": "invalid_grant"`, mensaje "Error validating grant. Your authorization code or refresh token may be expired or it was already used". Causas: code o refresh inválido, revocado, vencido o ya usado; flujo equivocado; de otro cliente; **`redirect_uri` distinto**; o el vendedor tiene datos o documentos pendientes | DOC |
| Otros errores | `invalid_client`, `invalid_scope`, `invalid_request`, `unsupported_grant_type`, `forbidden` (403), `local_rate_limited` (429), `unauthorized_client`, `unauthorized_application` (app bloqueada) | DOC |
| Si el refresco falla | Pedir al vendedor que autorice de nuevo; si el vendedor desconecta la app, borrar sus tokens | DOC |
| Guardar tokens | La guía de seguridad pide **cifrarlos en reposo** (AES-256, clave fuera de la base), no loguearlos, enviarlos solo por header | DOC |
| Identificar la cuenta | `GET /users/me` (trae `id`, `nickname`, `site_id`, `user_type`); el `user_id` ya viene en el canje | DOC |

**Consecuencia de diseño (INFERENCIA, por la rotación):** el refresco va **serializado por cuenta** (un candado) y el par nuevo se **guarda antes** de usar el access token nuevo; dos refrescos simultáneos dejarían la cuenta en `needs_reconnect`. Un job de refresco periódico evita también la regla de 4 meses sin uso.

### 3.2.1 Crear la app en el DevCenter (VERIFICADO el 2026-10-08)

- Antes de "Mis aplicaciones", el DevCenter pide **vincular** la cuenta de Mercado Libre ("¿Deseas vincular tu cuenta de Mercado Libre para trabajar con nuestra API?"); sin eso no aparece la lista de apps.
- **Paso 1 (información básica):** nombre (hasta 50 caracteres), nombre corto (letras, números y guion bajo), descripción (hasta 150), propósito, rango de usuarios y **logo PNG obligatorio** (hasta 1 MB). El aviso rojo "La app ya está creada, por favor elija otro nombre" aparece con **cualquier** nombre (`/devcenter/internal/validate-app` responde `true` siempre): no bloquea, "Continuar" avanza igual.
- **Paso 2 (configuración y scopes):** redirect URIs (`https`, ver §3.3), flujos OAuth (Authorization Code y Client Credentials vienen marcados; **Refresh Token hay que marcarlo**), PKCE (desmarcado), unidades de negocio (**Mercado Libre** y **VIS**, la de Vehículos, Inmuebles y Servicios), permisos (cada uno con su nivel: "Publicación y sincronización" en lectura y escritura; "Usuarios" viene fijo en lectura y escritura), tópicos y URL de notificaciones (opcionales, vacíos).
- **Crear:** aceptar los términos y un **reCAPTCHA** (lo resuelve el operador). Después, ver o editar la app (y el Client Secret) pide una **verificación por QR** con la app de Mercado Libre del teléfono.

### 3.3 Redirect URI

- **DOC (crear app, 06/08/2026):** "es obligatorio utilizar el protocolo HTTPS en su URI de redireccionamiento". Se pueden registrar varias URIs ("Completa con la raíz del dominio").
- **DOC (requisitos previos de inmuebles):** "Puedes ingresar una URL de prueba (incluso si no existe)". Es decir, ML no exige que la URL responda.
- **`localhost` (VERIFICADO el 2026-10-08, al crear la app de AgentSales):** el panel rechaza `https://localhost/oauth/mercadolibre/callback` ("La dirección debe ser válida"). Acepta `https://agentsales.test/oauth/mercadolibre/callback`: `.test` es un dominio reservado que nunca resuelve en internet, así que el código de autorización no llega a ningún servidor ajeno; el navegador muestra un error y el operador copia la dirección, como estaba previsto con `localhost`. Es la que quedó registrada y la que va en `ML_REDIRECT_URI`.
- Coincidencia **exacta** con la registrada, sin partes variables (DOC).

### 3.4 Conectar la cuenta en local sin túnel (de menos a más esfuerzo)

> **Superado por el spec F4** (D1 y D3, implementado en F4-T06): se registra una dirección `https` que no necesita servidor (al final `https://agentsales.test/oauth/mercadolibre/callback`, porque el panel rechazó `localhost`, §3.3), PKCE desactivado, y la CLI recibe la **dirección completa** pegada (`--url-stdin`), no el `code` suelto. Lo que sigue es la investigación previa.

1. **Redirect HTTPS que no necesita cargar** (respaldado por la doc: "incluso si no existe"): registrar `https://localhost:8787/oauth/mercadolibre/callback` (o, si el panel rechaza `localhost`, cualquier URL HTTPS del operador). Tras autorizar, el navegador queda en esa dirección con `?code=...&state=...`; el operador copia el `code` y lo pega en la CLI (`accounts connect mercadolibre --code`), que lo canjea en seguida.
2. **`https://localhost` con certificado local (mkcert)** servido por Hono: el callback carga y canjea solo. Sin dependencias de producción.
3. **Túnel** (cloudflared o ngrok): último recurso; la URL cambia y obliga a re-registrar.

No existe un "Generate token" en el panel como el de Meta (no aparece en ninguna página leída).

## 4. Operaciones

Todas con `Authorization: Bearer <access_token>`, host `https://api.mercadolibre.com`.

### 4.1 Publicar (DOC)

`POST /items`. Ejemplo oficial (publica-inmueble, 28/08/2026, con datos de MLA): `title`, `category_id` (hoja), `price`, `currency_id`, `available_quantity: 1` (siempre 1 en inmuebles), `buying_mode: "classified"`, `listing_type_id: "silver"`, `condition: "not_specified"` (también `new` o `used`), `channels: ["marketplace"]`, `description: { "plain_text": "..." }`, `pictures: [{ "source": "<url>" }]`, `video_id`, `location`, `seller_contact` y `attributes`.

**`CMG_SITE` (DOC):** en MLC, agregar a `attributes`:

```json
{ "id": "CMG_SITE", "name": "Site de origen", "value_id": null, "value_name": "POI", "value_struct": null, "attribute_group_id": "OTHERS", "attribute_group_name": "Otros" }
```

Con eso el ítem lleva `listing_source: portalinmobiliario` y se ve en Mercado Libre y en Portal Inmobiliario. Si basta con `{ "id": "CMG_SITE", "value_name": "POI" }`: NO VERIFICADO (probar con `validate`).

**Respuesta (DOC, ejemplo MLA):** `id`, `permalink`, `status` (`active` en el ejemplo, con la imagen "procesando"), `sub_status`, `start_time`, `stop_time`, `end_time`, `expiration_time`, `pictures` (con `id`), `tags` (`test_item` en un ítem de prueba), `domain_id`, `listing_source` y los atributos `PROPERTY_TYPE`, `OPERATION`, `OPERATION_SUBTYPE` **completados desde la categoría** (no se enviaron; INFERENCIA de que los pone la categoría).

**Descripción: dos indicaciones distintas (DOC):** el ejemplo de publica-inmueble (2026) manda `description.plain_text` dentro del `POST /items`; la página de atributos (2025) dice crear el aviso sin descripción y luego `POST /items/{id}/description` con `{ "plain_text": "..." }`. Se prueba con `validate`; el camino seguro es el segundo. Reglas: solo texto plano, saltos con `\n`, sin HTML ni emojis (error `item.description.type.invalid`, `cause_id` 398, con la posición en `references`); hacer `POST` sobre un ítem que ya tiene descripción da error: para cambiarla, `PUT /items/{id}/description?api_version=2`. Largo máximo: `settings.max_description_length` (50.000 en el ejemplo MLA).

**Validar sin publicar (DOC):** `POST /items/validate` con el mismo body: `204 No Content` si está bien; si no, `400` con `cause[]`. No es obligatorio. **No hay sandbox ni preproducción**: lo publicado en pruebas es visible para todos.

### 4.2 Contacto del vendedor (`seller_contact`) (DOC)

- **Desde el 01/10/2026**, `country_code2` y `phone2` (WhatsApp) son **obligatorios en todas las publicaciones de inmuebles, para todo tipo de usuario, al crear y al actualizar**. "El objeto `seller_contact` debe enviarse completo en el cuerpo de la solicitud"; las actualizaciones sin estos datos se rechazan con 400.
- Campos: `contact`, `other_info`, `country_code`, `area_code`, `phone`, `email`, `webpage` (opcionales) y `country_code2`, `phone2` (obligatorios). Solo dígitos: sin `+`, espacios, paréntesis ni guiones; en `country_code2` solo el código de país (`56`) y el resto en `phone2`.
- Errores 400: `seller_contact.required`, `seller_contact.country_code2.required`, `seller_contact.phone2.required`, `seller_contact.country_code2.invalid`, `seller_contact.phone2.invalid`.
- Las preguntas de los compradores llegan al `seller_contact.email` (o al correo de la cuenta).
- La página de atributos (2025) dice que `seller_contact` es opcional: **quedó superada** por la regla del 01/10/2026.
- Si un `PUT` que solo cambia `status` también exige `seller_contact` completo: el texto dice "actualizaciones", sin excepción (NO VERIFICADO; enviarlo siempre es lo seguro).

### 4.3 Editar un aviso activo (DOC)

`PUT /items/{id}` con solo los campos a cambiar (los omitidos no cambian); responde 200 con el ítem completo. Campos modificables: **título, precio, video, fotos, descripción, ubicación, atributos y categoría**. Restricciones documentadas:

- `seller_contact` completo en cada actualización desde el 01/10/2026 (sección 4.2).
- Desde el 12/03/2026, un `PUT` sobre ítems `silver`, `gold`, `gold_special` o `gold_premium` con `requires_picture: true` que deje el ítem **sin imágenes** se rechaza con 400.
- Fotos: para agregar, enviar los `id` de las que se conservan más los `source` nuevos, en el orden deseado; para borrar, enviar solo los `id` que quedan. **Reutilizar la misma URL con otro contenido no actualiza la foto**: cada versión necesita una URL nueva.
- No se encontró ninguna restricción para cambiar el título o el precio de un inmueble (la regla de "título editable solo con `sold_quantity` 0" es de productos). Un cambio de precio inusual puede **pausar** el ítem por moderación (sección 4.4).
- **Destacar:** `POST /items/{id}/listing_type` con `{ "id": "gold" }` o `gold_premium`; sin cargo por la llamada, pero exige paquete de destaque contratado; revertir devuelve el cupo. No se usará en F4.

### 4.4 Estados, pausar, reactivar, cerrar, republicar y borrar (DOC)

| Acción | Llamada | Notas |
|---|---|---|
| Pausar | `PUT /items/{id}` con `{ "status": "paused" }` | No visible, no genera contactos; se reactiva cuando se quiera |
| Reactivar | `PUT /items/{id}` con `{ "status": "active" }` | También para salir de una pausa por moderación |
| Cerrar | `PUT /items/{id}` con `{ "status": "closed" }` | **Definitivo**; valores en minúsculas exactas |
| Republicar | `POST /items/{id}/relist` con `price`, `quantity` y `listing_type_id` | Crea un ítem **con id nuevo** (`parent_item_id` apunta al anterior). Conserva visitas si se hace hasta **60 días** después de cerrar. Si está activo, primero cerrarlo |
| Borrar | Tras cerrar, `PUT /items/{id}` con `{ "deleted": true }` | Irreversible; `sub_status` queda `["deleted", ...]`. Si responde **409** "item optimistic locking error", esperar unos segundos y reintentar |

**Ciclo de vida (DOC):** el aviso sigue activo mientras (1) su paquete tenga cupo y esté vigente y (2) no pase su `stop_time`. Vigencias:

| Sitio | Propiedad | Operación | Días |
|---|---|---|---|
| MLC | Casas | Venta | 180 |
| MLC | Casas | Arriendo | 45 |
| MLC | Departamentos | Venta | 180 |
| MLC | Departamentos | Arriendo | 45 |
| Todos | Resto de categorías | — | 354 |

- `start_time` = creación; `stop_time` = fin de la vigencia según categoría y operación; `expiration_time` = vencimiento del **paquete** que cubre el ítem. Al llegar a `stop_time` el ítem pasa a `closed` con `sub_status` `expired` (DOC). Renovar = `relist` (INFERENCIA: no hay otra forma documentada de extender `stop_time`; gasta un cupo nuevo, INFERENCIA).
- Arriendo temporal y las demás propiedades (oficinas, terrenos, parcelas, bodegas, estacionamientos, locales) caen en "resto": 354 días (DOC por la tabla; que aplique así en MLC: INFERENCIA).

**Estados que aparecen en la doc:** `active`, `paused`, `closed`, `under_review`, `not_yet_active` y, en `sub_status`, `picture_download_pending`, `expired`, `deleted`, `pack_quota_assigned` (DOC).

**Pausas por moderación (DOC, moderaciones-con-pausado, 12/06/2026):** ML pausa preventivamente por cambio inusual de precio, ítems sin ventas o visitas, fotos por URL aún no procesadas e **inmueble reportado como no disponible** (disponible en MLC; se activa con la primera señal: denuncia en la vista o respuesta negativa en la encuesta posterior al contacto). Se buscan con `GET /users/{id}/items/search?tags=moderation_penalty&status=paused`, el motivo se lee con `GET /moderations/last_moderation/{ITEM_ID}-ITM` (`REASON` y `REMEDY`) y se reactivan con `PUT status: active`. Si la propiedad ya no está disponible, la doc recomienda cerrar en vez de reactivar. La moderación llega también como notificación del topic `items`.

### 4.5 Consultar estado (DOC)

- `GET /items/{id}` (con `?attributes=campo1,campo2` para traer solo lo necesario). Campos útiles: `status`, `sub_status`, `permalink`, `start_time`, `stop_time`, `expiration_time`, `last_updated`, `tags`, `listing_source`.
- Calidad: `GET /items/{id}/health` (porcentaje y objetivos pendientes: fotos con mínimo, ficha técnica, video) y `GET /items/{id}/health/actions`; niveles por sitio en `GET /sites/MLC/health_levels`. Solo para ítems activos sin penalización.
- Multiget: `GET /items?ids=...` (hasta 20) **se depreca**: desde octubre de 2026 se usa `GET /items/bulk?ids=...` (`code` pasa a `status_code` y los campos se piden con `attributes=body.<campo>`); los endpoints conviven hasta el 25/10/2026 (DOC, items-y-busquedas, leída el 2026-10-07).
- **Buscar los ítems del vendedor** (DOC, items-y-busquedas): `GET /users/{id}/items/search` devuelve `{ seller_id, paging: { limit, offset, total }, results: ["MLA…"] }` (solo ids; 50 por defecto, `limit` hasta 100). Por `seller_custom_field`: `?sku=<valor>` (por el atributo `SELLER_SKU` es `?seller_sku=`). Por estado: `?status=active`; los estados del filtro son `pending`, `not_yet_active`, `programmed`, `active`, `paused` y `closed`. Qué estados trae sin `status`: NO VERIFICADO (el publisher busca sin filtro, F4-T04).
- **Notificaciones:** topic `items` a la URL de callback de la app (DOC). Exige URL pública; **en F4, sondeo** (como en Instagram).

### 4.6 Categorías y atributos (DOC)

**Árbol de categorías:** Inmuebles > tipo de propiedad > operación > subtipo (nuevo o usado). Se baja con `GET /categories/{id}` por `children_categories` hasta una categoría **sin hijos**: esa es la hoja que va en `category_id` (publicar en una que no es hoja da el error 126 `item.category_id.invalid`, `listing_allowed: false`). Los tres niveles definen `PROPERTY_TYPE`, `OPERATION` y `OPERATION_SUBTYPE`. Listado del sitio: `GET /sites/MLC/categories`.

**Ids de MLC encontrados en la doc:**

| Id | Qué es | Confianza |
|---|---|---|
| `MLC1459` | Inmuebles (Chile) | DOC (ejemplo de paquetes para "la categoría de inmuebles de Chile"; mismo sufijo que `MLA1459`) |
| `MLC157520` | Usado en el ejemplo de publicación de prueba, "**asumiendo** que este ID corresponde a Propiedades Usadas dentro de Venta de Casas en Chile" | **NO VERIFICADO**: la propia doc lo da como supuesto |
| `MLC5628` | Ejemplo hipotético de hoja ("si no hubiera children_categories al consultar MLC5628") | NO VERIFICADO; no usar |

Los ids de departamentos, casas, oficinas, terrenos, parcelas, bodegas, estacionamientos y locales, por venta, arriendo y arriendo temporal, **no figuran** para MLC: se obtienen con el token (sección 8). Como referencia, MLA usa nombres de operación "Alquiler", "Alquiler Temporario" y "Venta", y subtipos "Propiedades Individuales" y "Emprendimientos" (DOC, MLA). Los nombres en MLC (por ejemplo "Arriendo", "Propiedades Usadas"): NO VERIFICADO.

**Atributos:** `GET /categories/{hoja}/attributes`. Cada uno trae `id`, `name`, `tags`, `hierarchy`, `relevance`, `value_type`, `value_max_length`, `allowed_units`, `default_unit` y el grupo. **Obligatorio = `tags.required: true`**; también existen los obligatorios condicionales (`conditional_required: true`, error 7810 `item.attribute.missing_conditional_required`). Faltar uno requerido da el error 147 `item.attributes.missing_required`.

La guía de atributos de inmuebles marca como **obligatorios**:

| Atributo | Qué es | Cómo se envía (DOC) |
|---|---|---|
| `MAINTENANCE_FEE` | Gastos comunes mensuales | Valor monetario en la moneda del país (forma exacta del valor: NO VERIFICADO) |
| `IS_SUITABLE_FOR_PETS` | Acepta mascotas | Lista "Sí" o "No" con su `value_id` |
| `PARKING_LOTS` | Estacionamientos | Número (`value_name: "1"`) |
| `WAREHOUSES` | Bodegas | Número |
| `FULL_BATHROOMS` | Baños completos | Número |
| `FURNISHED` | Amoblado | Lista "Sí" o "No" con su `value_id` |
| `BEDROOMS` | Dormitorios | Número; `required: true` en el ejemplo MLA |
| `COVERED_AREA` | Superficie útil | `number_unit`: `value_name: "30 m²"` (o `value_struct: { "number": 30, "unit": "m²" }`); `required: true` en el ejemplo MLA |
| `TOTAL_AREA` | Superficie total | `number_unit`, igual que la anterior |

Además son obligatorios en el body: precio, moneda (`currency_id` entre las de la categoría), `listing_type_id`, `available_quantity: 1` y `condition`. El ejemplo MLA usa también `ROOMS` (ambientes). **Piso, orientación y año de construcción** no aparecen en la doc leída: sus ids y si son requeridos se leen de `/attributes` (NO VERIFICADO). Los valores con `value_id` (Sí/No, listas) se copian de la respuesta de `/attributes`.

### 4.7 Ubicación (DOC)

- **Obligatoria** en clasificados. Cuatro niveles: `country`, `state`, `city`, `neighborhood`; **mínimo `city` o `neighborhood`**. Se envían por `id`.
- Ids: `GET /classified_locations/countries/CL` (trae `states`), `GET /classified_locations/states/{id}` (trae `cities`), `GET /classified_locations/cities/{id}` (trae `neighborhoods`), `GET /classified_locations/neighborhoods/{id}` (trae `subneighborhoods`). En Chile una "ciudad" puede ser una zona con varias comunas o pueblos (DOC: "pueden representar regiones menores").
- Ejemplo chileno de la doc: `state` `TUxDUE9IUzFjODg` ("Libertador B. O'Higgins"), `city` `TUxDQ0xBWmE0Y2Zm` ("La Estrella"), `neighborhood` vacío, `zip_code` vacío, `address_line`, `latitude` y `longitude`. Cómo se mapean regiones y comunas chilenas a `state`, `city` y `neighborhood` (por ejemplo Santiago): NO VERIFICADO.
- **Código postal:** para Chile ML no entrega códigos por API (DOC, ubicación y monedas); el ejemplo chileno lo deja vacío.
- **Ocultar la dirección exacta:** `PUT /items/{id}/address_line_by_reference` (sin body) la oculta; `DELETE` al mismo recurso la vuelve a mostrar. La doc agrega que, aun oculta, "la publicación siempre incluirá la localización y el número de la propiedad"; qué se ve exactamente en Portal Inmobiliario: NO VERIFICADO. Es una llamada aparte, después de crear (INFERENCIA). Las categorías traen `settings.rounded_address` (sin explicación).
- Cambiar la ubicación de un ítem: `PUT /items/{id}` con `location` (DOC).

### 4.8 Moneda y precio (DOC)

- **`CLF` = Unidad de Fomento**, símbolo `UF`, **2 decimales**; `CLP` = Peso Chileno, 0 decimales (`GET /currencies`).
- Las monedas permitidas por categoría están en `settings.currencies` (el ejemplo MLA de Inmuebles trae `["USD", "ARS"]`). Que las hojas de MLC acepten `CLF`: muy probable (Portal Inmobiliario publica en UF) pero **NO VERIFICADO**; el ejemplo chileno usa `CLP`.
- Precio mínimo y máximo: `settings.minimum_price` y error 129 si `price` supera 9.999.999.999.

## 5. Medios

| Requisito | Dato | Fuente |
|---|---|---|
| Formatos | JPG, JPEG, PNG; RGB mejor que CMYK | DOC |
| Peso máximo | 10 MB | DOC |
| Tamaño | Recomendado 1200x1200; máximo 1920x1920 (si es mayor se reduce); mínimo 500x500 (si es menor queda igual). La doc de moderaciones dice válida si mide al menos 250 px por lado y un lado de más de 500; el error 3703 pide 500 px en al menos un lado | DOC (criterios algo distintos; 1600x1200 cumple todos) |
| Zoom | Ancho mayor de 800 px activa zoom; recomendado para inmuebles | DOC |
| Al menos 1 foto | Obligatorio al crear con `silver` (rechazo 400, error 173). La fecha difiere entre páginas (20/01/2026 o 23/02/2026), ambas pasadas. Ya no se puede crear sin fotos y agregarlas después | DOC |
| Máximo por ítem | `settings.max_pictures_per_item` de la categoría (30 en el ejemplo MLA de Inmuebles); superarlo da el error 201. Valor en MLC: NO VERIFICADO | DOC / NO VERIFICADO |
| Mínimo de calidad | **12** fotos para casas, departamentos, oficinas y parcelas; **6** para locales, agrícolas, sitios, terrenos, bodegas y loteos; **4** para estacionamientos. Es un objetivo de calidad (`health`), no un rechazo | DOC |
| Por URL | `pictures: [{ "source": "<url>" }]` en `POST` y `PUT` | DOC |
| Subida directa | `POST /pictures/items/upload`, solo `multipart/form-data` (`file=@...`); devuelve `{ id, variations: [{ size, url, secure_url }] }` (id como `123-MLA456_112021`); el `id` se usa en `pictures: [{ "id": "..." }]` o se vincula con `POST /items/{id}/pictures` `{ "id": "..." }`. El endpoint limita peticiones por minuto por app: **400** "Bad_request" (la doc no da el cuerpo; F4-T04 trata como ese límite un 400 sin causas que bloqueen y con `error` vacío o `bad_request`). Un `id` de foto en estado `ERROR` o más chico que el mínimo da **400 `validation_error` con `cause_id` 508 o 509** al usarlo en un ítem (re-leída el 2026-10-07) | DOC |
| Errores de una foto | `GET /pictures/{picture_id}/errors` muestra por qué no se descargó (403, 404, timeout, etc.) | DOC |
| Video | `video_id` = `<id>;youtube` (solo videos) o `<id>;matterport` (solo tours); uno solo y sin parámetros extra | DOC |

**Fotos por URL: qué pasa después de crear (DOC, moderaciones-con-pausado, 12/06/2026):**

- Mientras ML descarga y valida: inmuebles de usuario `normal` quedan `status: paused`; de `real_estate_agency`, `status: not_yet_active`; en ambos casos `sub_status: picture_download_pending`. Rollout en MLC desde el "01 de agosto" (sin año en la página; INFERENCIA: 2026, ya vigente).
- **Activación automática** cuando las fotos se descargan y cumplen: `status: active`. No hace falta `PUT`.
- Si no se pueden descargar en un plazo definido (no dice cuál) o quedan bajo el mínimo: `status: under_review` con `sub_status` `picture_download_pending` (en un párrafo aparece `picture_downloading_pending`: copiar el valor real de una respuesta). Remedio: cargar otra foto.
- La versión anterior de esta nota decía que había que reactivar con `PUT`: **la doc dice que se activa sola**.

**URLs prefirmadas de R2 (sigue NO VERIFICADO), con lo que sí dice la doc:**

- ML **no trabaja con redirecciones**: la URL debe ser la final (DOC). Una URL prefirmada de R2 responde directo, sin redirección (INFERENCIA).
- Si el servidor bloquea, la foto falla con 403 o 401; la doc pide habilitar sus IPs si hay lista blanca (DOC). R2 no filtra por IP salvo configuración (INFERENCIA).
- Ante problemas de certificado TLS la doc sugiere usar HTTP (DOC); con R2 no debería ocurrir (INFERENCIA).
- Las query strings: el ejemplo oficial usa una URL con `?square=false` (DOC), así que una URL con parámetros no se rechaza por forma (INFERENCIA); que acepte la firma larga de R2 y cuánto tarda la descarga: NO VERIFICADO. Como la descarga es asíncrona y el plazo no está documentado, la URL debe durar horas (propuesta: 6 a 24 h).
- **Plan B robusto:** subir por `multipart` a `/pictures/items/upload` desde el worker y publicar con los `id`: no requiere URL pública y el error se sabe al instante (DOC el mecanismo; preferirlo es decisión del spec).
- La variante `pi_4x3` de F2 (1600x1200) cumple tamaño y peso.

## 6. Límites

| Límite | Valor | Fuente |
|---|---|---|
| Rate limit | 429 por exceso de peticiones en poco tiempo; se controla **por Client ID y por endpoint**; el tamaño del body no cuenta. **No hay cifra publicada** | DOC |
| Ante 429 | Backoff exponencial con jitter, menos concurrencia, agrupar llamadas; se pueden pedir cupos mayores con evidencia de uso | DOC |
| Subida de fotos | RPM limitado por `app_id` (400 al superarlo) | DOC |
| Título | `settings.max_title_length` de la categoría. En el ejemplo de Inmuebles de **MLA** es **200**; en una categoría de productos de MLA es 60. **En MLC: NO VERIFICADO** | DOC / NO VERIFICADO |
| Descripción | `settings.max_description_length` (50.000 en los ejemplos MLA) | DOC |
| Fotos por ítem | `settings.max_pictures_per_item` (30 en el ejemplo MLA de Inmuebles) | DOC / NO VERIFICADO en MLC |
| Valor de un atributo | `value_max_length` (255 en general; 18 en `BEDROOMS`) | DOC |
| Precio | Menor que 9.999.999.999 | DOC |
| Usuarios de prueba | Hasta 10 por cuenta; vencen; se borran tras 60 días sin actividad | DOC |
| Cupo | El del paquete contratado | DOC |

## 7. Errores comunes

**Estructura (DOC, validaciones):** `message`, `error`, `status` y `cause[]`; cada causa trae `department`, `cause_id`, **`type`** (`warning` no bloquea, `error` bloquea), `code`, `references` (dónde está el problema) y `message`. Un body mal formado responde `body.invalid_field_types` con el detalle de tipos en `error`.

| Situación | Código | Reintentable |
|---|---|---|
| Categoría que no es hoja | 400, 126 `item.category_id.invalid` | No |
| Falta un atributo requerido | 400, 147 `item.attributes.missing_required` | No |
| Falta un atributo condicional | 400, 7810 `item.attribute.missing_conditional_required` | No |
| Sin fotos en `silver` | 400, 173 (`item.listing_type_id.requiresPictures`; publica-inmueble lo llama `LTP_PICTURE_REQUIRED`) | No |
| Demasiadas fotos | 400, 201 `item.pictures.max` | No |
| Foto chica o con error | 400, 3703 `item.pictures.invalid_size`; 508 y 509 al usar un `id` de foto inválido o pequeño | No |
| Precio bajo el mínimo o sobre el máximo | 400, 109 / 129 `item.price.invalid` | No |
| `seller_contact` faltante o mal formado | 400, `seller_contact.*` (sección 4.2) | No |
| Descripción con caracteres no aceptados | 400, 398 `item.description.type.invalid` | No |
| Token vencido o inválido | 401 | Una vez, tras refrescar; si el refresco falla, `needs_reconnect` |
| Token de otro usuario, IP bloqueada o faltan scopes | 403 `forbidden` | No |
| App bloqueada | `unauthorized_application` | No |
| Conflicto al borrar | 409 "item optimistic locking error" | Sí, tras unos segundos |
| Demasiadas solicitudes | 429 (`local_rate_limited` en OAuth) | Sí, con backoff y jitter |
| Error del servidor | 5xx | Sí con backoff, **pero** si un `POST /items` se cortó no repetirlo a ciegas: buscar si ya se creó con `GET /users/{id}/items/search` (INFERENCIA: riesgo de duplicado y de gastar dos cupos) |
| `invalid_grant` en el refresco | 400 | No: reconectar |

Los títulos demasiado largos, la moneda no permitida y los `cause_id` específicos de inmuebles no figuran en la tabla de validaciones leída: se completan con `items/validate` en la cuenta de prueba.

## 8. Cómo probar sin riesgo

- **No hay sandbox** (DOC): lo publicado se ve. La protección es combinar lo siguiente.
- **1. Validar sin publicar:** `POST /items/validate` con el body armado (`204` = válido). No crea nada ni gasta cupo (INFERENCIA). Confirma categorías, atributos, `CMG_SITE`, moneda, ubicación, `seller_contact` y largo del título.
- **2. Usuario de prueba (DOC):** con el token de la app, `POST /users/test_user` con `{ "site_id": "MLC" }`; devuelve `id`, `nickname`, `password` y `site_status` **una sola vez** (no hay forma de recuperarlas). Hasta 10; vencen; se borran tras 60 días sin actividad; solo operan con otros usuarios de prueba; el código de verificación de correo son los últimos 4 o 6 dígitos del user id. Las cuentas personales no deben usarse para pruebas.
  - Para inmuebles (pasos rápidos, 05/01/2026): entrar a mercadolibre.cl con el usuario de prueba, registrarse como inmobiliaria (opcional), **pedir a soporte la activación del usuario** con el formulario, y luego **contratar un paquete**: "Al utilizar tu cuenta de test, podrás elegir cualquier paquete **sin que se te cobre**" (DOC, contratación de paquetes). Cuidado: contratar con el token o la sesión de la cuenta real **sí cobra** (DOC).
  - Autorizar la app con el usuario de prueba, verificar con `GET /users/me` que el token es suyo y publicar.
  - Reglas de los ítems de prueba (realiza-pruebas, general de ML): título "Item de Prueba - Por favor, NO OFERTAR" (el ejemplo de inmuebles usa "Propiedad de Test por favor no contactar"), **nunca** `gold` ni `gold_premium`; ML los borra periódicamente. La respuesta trae `tags: ["test_item"]` (DOC). Si un ítem de prueba se ve en el buscador de Portal Inmobiliario: NO VERIFICADO.
- **3. Cuenta real (último recurso):** solo con autorización explícita del operador; gasta cupo del paquete real.
- **`ml:smoke` (propuesta para F4):** como `pnpm ig:smoke`: con el token, recorre `GET /sites/MLC/categories` y `/categories/MLC1459` hasta las hojas, baja `/attributes` de las hojas que usa AgentSales, lee `settings` (`max_title_length`, `max_pictures_per_item`, `currencies`) y llama a `items/validate` con un aviso de muestra, sin publicar. Deja los ids reales en esta nota.
- **Pruebas pendientes, de menor a mayor riesgo:**
  1. ~~Panel de la app: registrar `https://localhost:8787/oauth/mercadolibre/callback`~~ Hecho el 2026-10-08: el panel rechaza `localhost`; quedó `https://agentsales.test/…` (§3.3).
  2. Autorizar con `auth.mercadolibre.cl`, copiar el `code`, canjear; anotar `expires_in` y `scope`.
  3. `GET /users/me`; refrescar y confirmar que el `refresh_token` cambia y que el anterior da `invalid_grant`.
  4. Con token: árbol de `MLC1459` hasta las hojas de departamentos y casas (venta y arriendo) y de las demás propiedades; `/attributes` de esas hojas; `GET /sites/MLC/listing_types`; `GET /categories/MLC1459/classifieds_promotion_packs`.
  5. `items/validate` con: título largo, `CLF`, sin `CMG_SITE`, `CMG_SITE` mínimo, descripción dentro del body, `seller_contact` incompleto, y una URL prefirmada de R2 en `pictures`.
  6. Usuario de prueba activado y con paquete: publicar con fotos por URL (R2) y medir cuánto tarda en pasar de `paused`/`not_yet_active` a `active`; ocultar la dirección; pausar, reactivar, editar precio (con `seller_contact`), cerrar y borrar.
  7. Con la cuenta del corredor (solo lectura): `GET /users/{id}/classifieds_promotion_packs` para ver si su plan de Portal Inmobiliario da cupo `silver` por API.

## 9. Riesgos y términos de uso relevantes

- **Título:** el largo lo fija `settings.max_title_length` de la hoja; **no hay cifra para MLC en la doc** (en Inmuebles de MLA el ejemplo dice 200). La afirmación anterior "60 caracteres en inmuebles de MLC" **no la respalda la doc**: se quita. Validar contra el valor leído de la categoría antes de enviar. Formato recomendado por la guía de inmuebles: **Operación + Tipo de propiedad + Ambientes + Barrio**, sin adjetivos ni abreviaturas (ejemplo de la doc: "Venta Departamento 4 ambientes Recoleta"). El `3D 2B` de `docs/04` contradice la recomendación de no abreviar.
- **Datos de contacto en el texto:** la guía de inmuebles dice que la descripción **no debe incluir información de contacto (teléfono, dirección, sitio web)**; hacerlo lleva a **moderación o penalización** (DOC, atributos-inmuebles). Esto **corrige** la nota anterior, que citaba una excepción para inmuebles de la política general (no leída en esta ronda). El contacto va solo en `seller_contact`. Que el título tampoco lleve contactos: INFERENCIA (la guía de títulos no lo menciona, pero la lógica es la misma).
- **Dirección:** la descripción no debe traer la dirección (DOC, mismo punto); la ubicación va en `location`, y si el corredor no quiere mostrarla exacta, `address_line_by_reference` (sección 4.7).
- **WhatsApp obligatorio:** sin `country_code2` y `phone2` no se puede crear ni actualizar (DOC). El corredor debe tener un número de WhatsApp cargado en AgentSales.
- **Moderación:** ML pausa por precio inusual, por reportes de "no disponible" y por fotos no procesadas; pasa a `under_review` si las fotos fallan. Sincronizar por sondeo, nunca suponer `active`.
- **Cerrar es irreversible:** pide confirmación y se prefiere **pausar**. Un cierre por error obliga a `relist` (id nuevo, nuevo `permalink`).
- **Cupos:** cerrar y reactivar rápido puede perder cupos (los cupos tardan minutos en liberarse) (DOC). Evitar ciclos rápidos de cierre y republicación.
- **Vencimiento:** arriendos en MLC duran 45 días; el sistema debe mostrar `stop_time` y avisar antes de que el aviso se cierre solo.
- **Rotación del refresh token** y **4 meses sin uso**: ver 3.2.
- **Seguridad de tokens:** ML pide cifrarlos en reposo (DOC). Hoy AgentSales guarda tokens de Instagram en la base: revisar si se cifran (decisión de spec o ADR).
- **Cambios frecuentes:** en 2026 se agregaron obligaciones con fecha (fotos en enero/febrero, PUT con fotos en marzo, WhatsApp en octubre, apps separadas en agosto). Las constantes van en un solo archivo y los límites se leen de la API.
- **Términos y condiciones** de desarrolladores: hay enlace en el pie de la doc; no se leyeron en esta nota. Leerlos antes de ofrecer el sistema a terceros (F7).

## 10. Fuentes

Leídas con el navegador el **2026-10-06**. Entre paréntesis, la fecha de "Última actualización" que muestra cada página. Todas en `https://developers.mercadolibre.cl/es_ar/`.

Autenticación y app:

- autenticacion-y-autorizacion (15/07/2026): flujo, PKCE, state, tokens, errores, `invalid_grant`.
- crea-una-aplicacion-en-mercado-libre-es (06/08/2026): datos del titular, redirect HTTPS, PKCE, scopes, Client Secret, apps ML/MP.
- obtencion-del-access-token (05/11/2025): canje, `expires_in` 21600.
- configuracion-o-requisitos-previos (06/11/2025): redirect "incluso si no existe", `/users/me`.
- permisos-funcionales (04/03/2026): permiso "Publicación y sincronización".
- gestion-de-identidades-y-accesos-oauth-y-tokens (30/03/2026): refresco a las 5 h, cifrado de tokens.
- realiza-pruebas (30/12/2025): usuarios de prueba.
- validador-de-publicaciones (30/12/2025): `POST /items/validate`, sin sandbox.
- validaciones (29/12/2025): estructura del error y códigos.
- rate-limit-error-429 (05/05/2026).

Guía de inmuebles:

- introduccion-guia-de-inmuebles (06/11/2025), primeros-pasos-inmuebles (05/11/2025), glosario-inmuebles (06/11/2025): contexto; soporte `vis-support@mercadolibre.com`; PI = Portal Inmobiliario.
- pasos-rapidos-para-publicar-un-inmueble-de-prueba (05/01/2026): usuario de prueba, activación, paquete, ejemplo chileno (`MLC157520`, ids de O'Higgins y La Estrella).
- consulta-de-usuarios (06/11/2025): registrarse como inmobiliaria, `user_type`.
- categorias-atributos-inmuebles (06/11/2025), categorias-inmuebles (06/11/2025): árbol y `settings` (ejemplo MLA).
- atributos-inmuebles (24/11/2025): atributos obligatorios, título, descripción sin contactos, ubicación mínima, fotos.
- localizar-inmuebles (08/11/2025): `classified_locations`, ocultar dirección.
- gestionar-paquetes-de-inmuebles (24/11/2025): silver, gold, cupos, `classifieds_promotion_packs`, `MLC1459`.
- contratacion-de-paquetes-de-publicacion (08/11/2025): contratación y "sin que se te cobre" en la cuenta de prueba.
- publica-inmueble (28/08/2026): body, respuesta, `seller_contact` obligatorio, `CMG_SITE`, error 173.
- actualiza-tus-publicaciones (28/08/2026): campos editables, estados, borrar, destacar.
- ciclo-de-vida-de-las-publicaciones-de-inmuebles (08/11/2025): vigencias por sitio, `stop_time`, `expiration_time`.
- calidad-de-las-publicaciones-inmuebles (19/06/2026): `health`, fotos mínimas, video.
- leads-inmuebles (07/05/2026): solo contexto.

Generales:

- tipos-de-publicacion-y-actualizaciones-de-articulos (01/06/2026): listing types, `available_listing_types`.
- trabajar-con-imagenes (24/03/2026; re-leída el 2026-10-07): formatos, tamaños, upload (respuesta), errores (400 por minuto, 508 y 509 como `cause_id`), sin redirecciones, IPs.
- items-y-busquedas (10/09/2026; leída el 2026-10-07): búsqueda de ítems del vendedor (`?sku=` para `seller_custom_field`, `?status=`), `/items/bulk`.
- moderaciones-con-pausado (12/06/2026): fotos por URL, pausas por moderación, inmueble no disponible.
- ubicacion-y-monedas (27/03/2025): `CLF`, zip codes en Chile.
- dominios-y-categorias (30/12/2025): `settings` (ejemplo de producto con `max_title_length` 60).
- publica-productos (09/01/2026): el largo del título lo fija la categoría.
- descripcion-de-articulos (13/03/2026): `plain_text`, `PUT ?api_version=2`.
- re-publica (29/12/2025): `relist`, 60 días.

Pista no oficial (no se usa como fuente final): issue del SDK .NET de ML con `https://localhost:44300/...` registrado: https://github.com/mercadolibre/net-sdk/issues/16

**Leads, en dos líneas:** un lead es un contacto de un interesado (WhatsApp, pregunta, llamada, visita agendada o cotización). Se consultan con `GET /vis/users/{USER_ID}/leads/buyers` (filtros por fecha, tipo e ítem); útil para una fase posterior, no para F4.

## 11. Implicaciones para el spec de F4

> Propuestas previas al spec: varias quedaron superadas (D1: dirección pegada sin puerto; D3: sin PKCE; variables `ML_APP_ID`, `ML_CLIENT_SECRET` y `ML_REDIRECT_URI`, F4-T02). Manda el spec F4.

1. **Conectar la cuenta:** registrar `https://localhost:<puerto>/oauth/mercadolibre/callback` (primero probar en el panel). `accounts connect mercadolibre` imprime la URL de `auth.mercadolibre.cl` con `state` y PKCE `S256`, y acepta el `code` pegado (`--code`); el callback con mkcert es opcional. Sin túnel.
2. **App:** permiso "Publicación y sincronización", scopes `read`, `write`, `offline_access`, PKCE activo. La app debe ser solo de ML (no MP).
3. **Variables:** `MERCADOLIBRE_APP_ID`, `MERCADOLIBRE_APP_SECRET`, `MERCADOLIBRE_REDIRECT_URI`; dominio de autorización por país en configuración.
4. **Tokens:** guardar `access_token`, `refresh_token`, `expires_at` (de `expires_in`); refresco con margen (por ejemplo a las 5 h), **con candado por cuenta**, guardando el par nuevo antes de seguir; `needs_reconnect` ante `invalid_grant`. Evaluar cifrarlos en reposo (ML lo pide). `external_id` = `user_id`.
5. **Datos nuevos que AgentSales necesita:** número de WhatsApp del corredor (`country_code2` + `phone2`, solo dígitos), ids de ubicación de ML (región, ciudad y barrio), y los atributos obligatorios que hoy quizás no captura el Excel: **gastos comunes, mascotas, bodegas, amoblado**, además de estacionamientos, baños, dormitorios y superficies. Revisar `FieldDefinition` y la plantilla.
6. **Categorías:** tarea previa `ml:smoke` que descubre las hojas de MLC y sus atributos y `settings` y los guarda en una tabla o archivo de configuración versionado; el publisher valida contra eso antes de enviar. No usar `MLC157520` sin confirmarlo.
7. **Body:** `buying_mode: classified`, `listing_type_id: silver`, `condition: not_specified` (o `used`/`new` si se conoce), `available_quantity: 1`, `channels: ["marketplace"]`, `CMG_SITE: POI`, `seller_contact` completo, `location` por ids, fotos y video opcional (YouTube o Matterport). Descripción: `POST /items/{id}/description` tras crear, salvo que `validate` confirme que va dentro del body.
8. **Operaciones del `Publisher`:** `publish` (crear, descripción, sondear hasta `active` o `under_review`), `pause`, `reactivate`, `close` (con confirmación; irreversible), `getStatus`, y `hideAddress` si `show_exact_address` es falso. **Todo `PUT` lleva `seller_contact` completo.** `edit` (precio, título, descripción, fotos) y `relist` según alcance del spec.
9. **Fotos:** recomendación: **subida `multipart` a `/pictures/items/upload`** desde el worker y publicar con los `id` (sin depender de que ML descargue R2). Si se usa URL prefirmada, vencimiento de 6 a 24 h y URL nueva por cada versión de foto. Mínimo 1, objetivo de calidad 12 en casas y departamentos, máximo según la categoría.
10. **Moneda:** UF → `CLF` (2 decimales) si `settings.currencies` de la hoja lo incluye; si no, decisión del operador.
11. **Título:** generar según la regla de ML (operación + tipo + ambientes/dormitorios + barrio, sin abreviaturas) y validar contra `max_title_length` leído de la hoja. Ajustar `docs/04` para Portal.
12. **Descripción:** sin teléfonos, correos, sitios web ni dirección; texto plano sin emojis. Reforzar en el prompt de Portal y en la revisión automática.
13. **Estado por sondeo**, sin webhooks: reflejar `paused` (moderación con su `REASON`), `under_review`, `not_yet_active`, `closed`/`expired` y mostrar `stop_time` (45 días en arriendo).
14. **`dry-run`:** el publisher arma el body; llamar a `items/validate` en dry-run toca la API real aunque no publica: decisión del operador.
15. **Preguntas para el operador:** (a) ¿el corredor de prueba tiene plan de Portal Inmobiliario y aparece como cupo `silver` por API?; (b) ¿se crea un usuario de prueba MLC y se pide su activación a soporte antes de empezar F4?; (c) ¿multipart o URL de R2 para las fotos?; (d) ¿`items/validate` cuenta como "no publicar" en `dry-run`?
