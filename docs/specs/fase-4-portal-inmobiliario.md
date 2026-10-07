# Spec F4 · Portal Inmobiliario

- **Estado:** Aprobado (2026-10-06, aprobación permanente del operador; D2, D5 y D6 respondidas por él)
- **Rama base:** `main`
- **Tag al cerrar:** `v0.4.0`
- **Referencias:** `docs/06-roadmap.md#f4--portal-inmobiliario`, ADR-0005, ADR-0006, ADR-0007, ADR-0011, ADR-0014, ADR-0015 y ADR-0016 (nuevos), `docs/01-arquitectura.md`, `docs/02-modelo-datos.md`, `docs/03-plataformas.md`, `docs/04-formato-publicaciones.md`, `docs/integraciones/mercadolibre.md` (verificada el 2026-10-06 leyendo la doc oficial con el navegador)

## 1. Objetivo
El operador conecta la cuenta de Mercado Libre de un corredor, aprueba el texto de Portal de una propiedad ya preparada y la publica en Portal Inmobiliario (y Mercado Libre) desde el panel o la CLI. Después la pausa, la reactiva o la cierra, y ve su estado real en la plataforma (procesando fotos, activa, en revisión, pausada por Mercado Libre, vencida) y cuándo vence. Todo se prueba primero en `dry-run`, que pregunta a Mercado Libre si aceptaría el aviso sin publicarlo (ADR-0016), y la demo en `live` usa la cuenta real del operador con un paquete pagado, con el aviso cerrado al final.

## 2. Alcance
- **Conectar Mercado Libre** (OAuth authorization code, sitio MLC) sin túnel: el operador autoriza en el navegador, copia la dirección de vuelta (que no necesita cargar) y la pega en la CLI.
- **Tokens que rotan** (ADR-0015): `access_token` de horas y `refresh_token` de un solo uso, cifrados y refrescados de a uno por cuenta.
- **Catálogo de Mercado Libre** (las categorías hoja de inmuebles que se usan, sus atributos y las ubicaciones de Chile), leído con el token y guardado en la base con vencimiento.
- **Del aviso al ítem:** categoría hoja por tipo y operación, atributos, precio en UF (`CLF`) o CLP, ubicación, contacto del corredor (`seller_contact` con WhatsApp, obligatorio desde el 01/10/2026) y `CMG_SITE` para salir en Portal. Lo que falta se informa **antes** de enviar, en el panel y en la CLI, sin inventar datos.
- **Lo aprobado no cambia también en los datos del aviso:** la publicación fija la versión del aviso al nacer (`listing_source_hash`).
- **Reglas del texto de Portal:** sin datos de contacto ni dirección en la descripción (Mercado Libre modera).
- **Publisher de Portal** en `packages/publishers/mercadolibre`: sube las fotos, crea el ítem, retoma sin duplicar, pausa, reactiva, cierra y consulta el estado.
- **Sincronizar** el estado con Mercado Libre (job `publication.sync`): a pedido, después de publicar y al arrancar el worker.
- API, CLI y panel para todo lo anterior.
- `pnpm ml:smoke`: lee el catálogo real y valida un aviso con `POST /items/validate`, **sin publicar** (lo corre el operador).

## 3. Fuera de alcance
- Editar un aviso ya publicado en Mercado Libre (precio, texto, fotos): se cierra y se vuelve a publicar. Pasa a F6, junto con la sincronización periódica.
- Republicar un aviso vencido o cerrado (`relist`, con id nuevo) y avisar antes del vencimiento: F6. En F4 el panel muestra la fecha de vencimiento.
- Borrar el ítem (`deleted: true`): cerrar basta.
- Destacar (`gold`, `gold_premium`), video (`video_id` de YouTube o Matterport) y proyectos o desarrollos inmobiliarios: solo `silver` y propiedades individuales.
- Preguntas, leads y solicitudes de visita (fase de respuestas, post-MVP).
- Notificaciones de Mercado Libre (topic `items`): exigen una URL pública; F4 consulta y F7 las evalúa con el despliegue.
- Mapeo configurable de campos propios del corredor a atributos: F4 mapea los campos globales de la plantilla con una tabla en core; la configuración por corredor es de F7.
- OAuth con vuelta automática (`/oauth/mercadolibre/callback` con cookie) y PKCE: F7, con HTTPS y despliegue.
- Pausar o cerrar un aviso y que eso orqueste sus publicaciones en todas las plataformas (`LISTING_MANUAL_TRANSITIONS`): sigue en F6. En F4 se pausa o cierra **la publicación de Portal**.
- Usuarios de prueba de Mercado Libre: exigen una activación de soporte; la demo usa la cuenta real (D6).

## 4. Diseño

### 4.1 Componentes
| Componente | Cambio |
|---|---|
| `packages/core` | Credenciales con `refreshToken` opcional; `meta` de Mercado Libre y política de refresco por plataforma; `MERCADOLIBRE_SITE_ID = "MLC"`; tabla de campos de Portal (`portal/fields.ts`) y `portalReadiness`; `PublishInput` con el aviso y el contacto; `Publisher` con `preflight`, `pause`, `resume`, `close` y `getStatus` opcionales; `PublishContext.accessToken`; `remoteState`; puertos `MercadoLibreAuth` y `PlatformCatalogRepository` (`PortalCatalog` quedó en publishers desde F4-T09); las formas del catálogo (`portal/catalog.ts`); casos de uso para conectar, asegurar el token, pausar, reactivar, cerrar y sincronizar; reglas nuevas de `checkContent`; dobles en `@agentsales/core/testing` |
| `packages/config` | `ML_APP_ID`, `ML_CLIENT_SECRET` y `ML_REDIRECT_URI` (`https://`); se quita `ML_SITE_ID` (es fijo) |
| `packages/db` | Migración `0007` (`platform_catalog`, `publications.remote_state` y `publications.listing_source_hash`); repositorio del catálogo; `withCredentialsLock`; `setRemoteState` |
| `packages/publishers` | `mercadolibre/`: cliente HTTP (OAuth, usuario, ítems, fotos, categorías, atributos, ubicaciones y `validate`), errores `ML_*`, catálogo con caché (`PortalCatalog`, desde F4-T09), `buildPortalItem` y el publisher de Portal |
| `apps/worker` | Publisher de Portal registrado; job `publication.sync`; `tokens.refresh` con Mercado Libre; `pnpm ml:smoke` |
| `apps/api` | Conectar Mercado Libre; pausar, reactivar, cerrar y sincronizar; `portalReadiness` en la vista del contenido |
| `apps/cli` | `accounts connect mercadolibre`, `publications pause|resume|close|sync`, `publish --platform portal` |
| `apps/web` | Cuentas con Mercado Libre; pestaña Portal con lo que falta, aprobar, publicar, estado en Mercado Libre, vencimiento, Pausar, Reactivar, Cerrar y Actualizar |

### 4.2 Conectar la cuenta (sin túnel, D1)
- **Por qué así:** Mercado Libre exige una dirección de vuelta `https` y no menciona `localhost` (nota §3.3), pero acepta registrar una URL "incluso si no existe". No hay un botón "Generate token" como el de Meta (nota §3.4). En vez de HTTPS local o un túnel, el operador copia la dirección de la barra después de autorizar.
- **Variables:** `ML_APP_ID`, `ML_CLIENT_SECRET` y `ML_REDIRECT_URI` (por defecto `https://localhost/oauth/mercadolibre/callback`: el puerto 443, donde no escucha nada; `loadEnv` rechaza una que no sea `https://` o que lleve usuario, clave o fragmento). El operador registra **esa misma** URI en la app (la comparación es exacta, nota §3.1) y deja **PKCE desactivado** (si se activa, Mercado Libre lo exige; D3). `doctor` avisa si falta el par (`ML_APP_ID` y `ML_CLIENT_SECRET`) y muestra la dirección de retorno. **Sin el par** no se conecta la cuenta ni se refresca su token (a diferencia de Instagram, el refresco de Mercado Libre exige `client_id` y `client_secret`): conectar responde `MERCADOLIBRE_NOT_CONFIGURED` sin llamar a Mercado Libre, y `ensureAccessToken` y el lote tampoco llaman ni cambian la cuenta. El sitio es fijo: `MERCADOLIBRE_SITE_ID = "MLC"` en core.
- **Pasos:**
  1. `agentsales accounts connect mercadolibre --broker <slug>` pide a la API la URL de autorización (`POST /accounts/mercadolibre/authorize-url { broker }`): `https://auth.mercadolibre.cl/authorization?response_type=code&client_id=…&redirect_uri=…&state=…`, con un `state` firmado (`createStateSigner` de F3) que lleva nonce, **plataforma**, corredor y vencimiento de 10 min. La CLI la imprime y la abre en el navegador.
  2. El operador autoriza con la cuenta **administradora** (un colaborador falla, nota §2). El navegador queda en `https://localhost/…?code=…&state=…` con un error de conexión: es lo esperado.
  3. Copia la dirección completa y la pega: `pbpaste | pnpm -s cli accounts connect mercadolibre --broker <slug> --url-stdin`. La CLI extrae `code` y `state` y llama a `POST /accounts/mercadolibre/connect { broker, code, state }`. La dirección nunca va a un argumento, un log ni un error (como `--token-stdin` de F3).
  4. La API verifica el `state` (firma, vencimiento, plataforma y corredor: `OAUTH_STATE_INVALID`), canjea el código **de inmediato** (`POST /oauth/token`, con los parámetros en el cuerpo), lee `GET /users/me` y guarda la cuenta con `connectMercadoLibreAccount` (core), que comparte con Instagram el guardado (`upsertConnected` con `revokeOthers`: una cuenta conectada por corredor y plataforma).
- **Guardado:** `external_account_id` = `user_id`; `display_name` = `nickname`; credenciales `{ accessToken, refreshToken }` cifradas; `token_expires_at` = conexión + 6 meses (el horizonte del `refresh_token`, estimado; §4.3); `meta` (`mercadoLibreAccountMetaSchema`): `userId`, `nickname`, `siteId` (si no es `MLC`, `ML_SITE_MISMATCH`), `userType`, `scopes` (exige `offline_access` y `write`: `ML_PERMISSION_DENIED`), `testUser` (si `tags` trae `test_user`), `connectedAt`, `tokenRefreshedAt`, `accessTokenExpiresAt` (ahora + `expires_in`: se lee, no se fija en 6 h, porque la doc se contradice) y `tokenExpiryEstimated: true`.
- Es una llamada síncrona a la plataforma desde la API, cubierta por ADR-0014 punto 9 y su seguimiento (conectar una cuenta).

### 4.3 Tokens que rotan (ADR-0015)
- `PlatformCredentials` pasa a `{ accessToken, refreshToken? }`: Instagram no lo usa; Mercado Libre siempre lo tiene.
- **Dos vencimientos:** `token_expires_at` sigue siendo "cuándo la cuenta deja de funcionar sin que el operador haga algo" (lo que muestran el panel y la CLI): en Mercado Libre, el horizonte del `refresh_token` (último refresco + 6 meses, estimado). El vencimiento del `access_token` (horas) va en `meta.accessTokenExpiresAt`, que no es secreto. Así el panel no muestra la cuenta vencida entre un uso y otro, y el lote no la marca `expired` sin preguntar.
- **El `refresh_token` sirve una sola vez y solo vale el último** (nota §3.2). Dos refrescos simultáneos dejarían la cuenta sin acceso. Por eso:
  - **`PlatformAccountRepository.withCredentialsLock(id, fn)`**: transacción que bloquea la fila de la cuenta con `FOR NO KEY UPDATE` (como `upsertConnected` y el candado por aviso: no choca con las FK de `publications`) y `lock_timeout` de 10 s; descifra y entrega a `fn` las credenciales, la cuenta y `save(update)`. Es la **única** excepción a "nada externo dentro de un candado": `fn` hace **una** llamada de refresco (tope de 10 s) y guarda el par nuevo **antes** de que se use. **Nunca se anida con el `ListingLock`** (ni uno dentro del otro). El doble en memoria serializa por cuenta.
  - **`ensureAccessToken(deps, accountId)`** (core): si a `meta.accessTokenExpiresAt` le quedan más de 30 min, devuelve el token sin bloquear; si no, entra al candado, **vuelve a leer** (otro proceso pudo refrescarlo mientras esperaba) y refresca solo si sigue por vencer. Después de un 401, quien llama pasa el token rechazado (`{ rejectedToken }`): se refresca aunque parezca vigente, pero solo si el guardado sigue siendo ese (si otro ya lo cambió, se usa el nuevo; así un proceso con un token viejo no rota el par de nuevo). El núcleo (`refreshMercadoLibreToken`, con su propio `shouldRefresh`) lo comparte con el refresco por plataforma de T08. Lo usan el intento de publicación, `preflight`, las operaciones, el sync, el catálogo y `ml:smoke`, siempre **fuera** del `ListingLock`.
  - `invalid_grant` (vencido, revocado, cambio de contraseña, 4 meses sin uso) deja la cuenta en `expired` y el error `ML_AUTH_INVALID` pide reconectar. Un corte de red no cambia la cuenta.
  - El refresco del cliente tiene un tope de **10 s** aunque el cliente tenga uno mayor (`MERCADOLIBRE_REFRESH_TIMEOUT_MS`), y de la respuesta **solo exige el par**: Mercado Libre ya invalidó el `refresh_token` anterior, así que un `user_id` o un `expires_in` que falte no la descarta (vencimiento supuesto de 1 h).
  - **Qué deja la cuenta `expired`:** cualquier `ML_AUTH_INVALID` que lance `refresh()` (`invalid_grant`, 401 o el refresh guardado mal formado), o un 401 de un recurso que se repite después de refrescar una vez. No la cambian: `ML_APP_CREDENTIALS_INVALID`, `ML_PERMISSION_DENIED`, la red, el tope ni `MERCADOLIBRE_NOT_CONFIGURED`. El primer 401 de un recurso se reconoce con `isMercadoLibreTokenRejected` (core).
  - Riesgo aceptado: si Mercado Libre rotó el token y el par nuevo no se guarda (el proceso muere antes de confirmar, el guardado o el `COMMIT` fallan, o la respuesta se pierde por el tope de 10 s), el par nuevo se pierde y el próximo refresco da `invalid_grant`: hay que reconectar (§8). Por eso la señal (Ctrl-C, una pestaña cerrada, el apagado del worker) no corta un refresco ya enviado: solo evita empezarlo (`ML_ABORTED`), y lo acota el tope de 10 s (desde F4-T08).
- **Política de refresco por plataforma** (core; hoy las reglas de Instagram están fijas en `refreshAccountToken`): Instagram sigue igual (24 h mínimo, ventana de 30 días). Mercado Libre: sin mínimo, el refresco a pedido (`force`) siempre refresca (con `refreshMercadoLibreToken` y `shouldRefresh` que siempre dice sí), y el lote (`tokens.refresh`, al arrancar el worker y a diario) refresca las que tienen 7 días o más desde el último refresco, para que el `refresh_token` no venza (6 meses) ni caiga por 4 meses sin uso. `POST /accounts/:id/refresh` acepta Mercado Libre.

### 4.4 Catálogo de Mercado Libre (ADR-0015)
- **Por qué:** la API de Mercado Libre exige token también para leer categorías (`GET /sites/MLC/categories` sin token dio 403 el 2026-10-06). Los ids de las hojas de MLC, sus atributos obligatorios, el largo máximo del título, las monedas y las ubicaciones solo se conocen con la cuenta conectada (nota §4.6 a §4.8). Nunca se escriben ids a mano: cambian.
- **Tabla `platform_catalog`** (migración `0007`): llave `(platform, key)`, `data jsonb`, `fetched_at`. Claves: `category:<id>` (una categoría con sus hijas y `settings`), `attributes:<hoja>` y `location:<id>` (Chile con sus estados, un estado con sus ciudades, una ciudad con sus barrios). Se guarda la **forma normalizada** del cliente de T05, no la respuesta cruda; una entrada que ya no calce con su esquema se vuelve a bajar. Son datos públicos de Mercado Libre, sin secretos ni datos del corredor.
- **`PortalCatalog`** (puerto y `createPortalCatalog` en `publishers/mercadolibre`, desde F4-T09: ningún caso de uso de core lo usa): lee de la tabla y, si falta, no calza con su esquema o tiene 7 días o más, consulta a Mercado Libre con el token (un proveedor `accessToken(opts?)` que arma core con `ensureAccessToken`: el catálogo no conoce repositorios, ADR-0015 punto 7) y la guarda. **Baja solo lo que usa:** desde `MLC1459` (Inmuebles) baja por los nombres hasta la hoja del tipo y la operación pedidos, no el árbol entero. Si Mercado Libre falla por algo reintentable (no un corte pedido, `ML_ABORTED`) y hay una copia vencida, la usa y avisa (`onNote`).
- **Resolución:**
  - **Categoría hoja:** una tabla en core (`portal/fields.ts`) traduce `Departamento`/`Casa`/`Oficina`/`Local comercial`/`Terreno`/`Parcela`/`Bodega`/`Estacionamiento` y `Venta`/`Arriendo` a los **nombres** del árbol (con el subtipo de propiedad individual o usada), y el catálogo da el id. Sin hoja, `PORTAL_CATEGORY_NOT_FOUND`. Los nombres exactos los fija `ml:smoke` (T10) antes de escribir el mapeo (T11).
  - **Ubicación:** la región se busca entre los estados de Chile y la comuna entre las ciudades de ese estado, sin mayúsculas ni tildes; un alias en core cubre lo que no calce por nombre (por ejemplo, comunas agrupadas en una "ciudad" de Mercado Libre, con el barrio si la comuna es un barrio de esa ciudad). Los barrios solo se usan por alias: no se recorren todas las ciudades de la región (desde F4-T09). Sin calce, `PORTAL_LOCATION_NOT_FOUND` con la comuna.

### 4.5 Del aviso al ítem (mapeo y revisión previa)
- **Dos revisiones antes de enviar:**
  1. **`portalReadiness(listing, broker)`** (core, pura, sin catálogo): lo que AgentSales sabe que Mercado Libre pide para inmuebles (nota §4.6), con la tabla de `portal/fields.ts`. La usan aprobar (como advertencia: el texto se aprueba igual), la vista del contenido (el panel la muestra en la pestaña Portal) y publicar (bloquea con `PORTAL_NOT_READY` y la lista de lo que falta, antes de pasar a `publishing`).
  2. **`buildPortalItem(input, catalog)`** (`publishers/mercadolibre`, pura dada la hoja y sus atributos): arma el cuerpo y revisa los obligatorios y condicionales **de la hoja real**, el largo del título (`settings.max_title_length`), las fotos (`max_pictures_per_item`) y la moneda (`settings.currencies`). Corre en `publish` (en `live`) y en `preflight` (en `dry-run`); si algo falla, `PUBLISH_INPUT_INVALID` con los motivos.
- **`validate` del publisher sigue pura y síncrona** (contrato de F3): plataforma, formato `post`, título de 1 a 60 caracteres, de 1 a 30 fotos JPEG (`pi_4x3`) y que el input traiga el aviso y el contacto. `checkPublishInput` e Instagram no cambian.
- **Campos** (la tabla vive en `packages/core/src/portal/fields.ts`, la usan las dos revisiones; ADR-0006: si se renombra un campo global, `portalReadiness` lo informa):
  | AgentSales | Mercado Libre | Nota |
  |---|---|---|
  | `contents.title` | `title` | El título de Portal de F2 (≤ 60; nunca más que el máximo de la hoja) |
  | `contents.body` | `description.plain_text` | Texto plano, sin emojis (ya lo garantiza F2) |
  | `tipo` + `operacion` | `category_id` | Hoja del catálogo (§4.4) |
  | `precio` + `moneda` | `price` + `currency_id` | `UF` → `CLF` con 2 decimales; `CLP` → `CLP` entero. La moneda debe estar en `settings.currencies` (`PORTAL_CURRENCY_NOT_ALLOWED`); nunca se convierte (doc 02) |
  | `dormitorios` | `BEDROOMS` | Número |
  | `banos` | `FULL_BATHROOMS` | Número |
  | `estacionamientos` | `PARKING_LOTS` | Número |
  | `bodegas` | `WAREHOUSES` | Número |
  | `sup_util_m2` | `COVERED_AREA` | `"72,5 m²"` con `value_struct` |
  | `sup_total_m2` | `TOTAL_AREA` | Obligatorio en Mercado Libre: si falta, se pide (copiar la útil sería inventar, D8) |
  | `gastos_comunes_clp` | `MAINTENANCE_FEE` | Obligatorio: si falta, se pide (`0` vale si no tiene) |
  | `amoblado` | `FURNISHED` | Sí o No (con su `value_id` del catálogo) |
  | `acepta_mascotas` | `IS_SUITABLE_FOR_PETS` | Sí o No; "A consultar" no existe en Mercado Libre: se pide elegir (D8) |
  | `piso`, `orientacion`, `ano_construccion` | El atributo de la hoja con ese nombre, si existe | Opcionales: si la hoja no lo tiene, no se envía |
  | `region`, `comuna` | `location.state`, `location.city`, `location.neighborhood` | Por id (§4.4) |
  | `direccion`, `numero_unidad` | `location.address_line` | Solo con `show_exact_address = true` (D7) |
  | corredor | `seller_contact` | `contact` = nombre, `email`, y **`country_code2` + `phone2` del WhatsApp** (solo dígitos; `+56 9 1234 5678` → `56` y `912345678`). Sin WhatsApp, `PORTAL_WHATSAPP_MISSING` |
  | — | `CMG_SITE` = `POI`, `listing_type_id: "silver"`, `buying_mode: "classified"`, `available_quantity: 1`, `condition: "not_specified"`, `channels: ["marketplace"]`, `seller_custom_field` = id de la publicación | Fijos |
- `seller_contact` va completo en cada escritura del ítem (la regla del 01/10/2026 dice "actualizaciones" sin excepción, nota §4.2). Para que un cambio de WhatsApp del corredor no impida cerrar un ítem (cerrar es irreversible), el progreso guarda el `sellerContact` enviado al crear y las operaciones reutilizan ese. Si un `PUT` de solo `status` no lo exige, `ml:smoke` lo dice y se simplifica.

### 4.6 Lo aprobado no cambia: también el aviso (seguimiento de ADR-0014)
- El texto aprobado y los medios ya quedan fijos (ADR-0014, punto 5), pero Portal también envía **datos del aviso** (precio, superficies, ubicación). Hoy una carga del Excel actualiza un aviso aunque tenga publicaciones pendientes: el ítem saldría con un precio distinto del de la descripción aprobada.
- **`publications.listing_source_hash`** (migración `0007`): el `source_hash` del aviso al nacer la publicación (todas las plataformas). `buildPublishInput` lo compara con el actual (`ListingRepository.getSourceHash(id)`, nuevo en T13; la entidad `Listing` no lo trae) para las plataformas cuyo input lleva el aviso (Portal; Marketplace en F5): si cambió **o falta** (`null`), `PUBLICATION_LISTING_CHANGED` (no reintentable; el mensaje dice que se descarte la publicación y se apruebe de nuevo). Así un olvido al abrir publicaciones nunca deja pasar un aviso cambiado. Instagram no cambia: su caption ya es lo aprobado.
- **`PublishInput`** suma `listing` (tipo, operación, precio, moneda, región, comuna, dirección, unidad, `showExactAddress` y `attributes`, nunca `internal_notes`) y `brokerContact` (nombre, correo y WhatsApp), armados en `buildPublishInput`. `publishAttemptRecord` registra los campos del ítem enviados, con el WhatsApp enmascarado (`+56 9 ****5678`).

### 4.7 Reglas del texto de Portal
- Mercado Libre modera una descripción con **teléfono, dirección o sitio web** (nota §9). Hoy `checkContent` marca la dirección solo si `show_exact_address = false`, y el prompt no distingue canales.
- **Cambios:** en Portal, `ADDRESS_EXPOSED` aplica **siempre** (la dirección va en la ubicación del ítem, no en el texto), y una regla nueva `CONTACT_IN_TEXT` (error) marca teléfonos, correos y URLs en el título o la descripción de Portal. El prompt pasa a `listing-content-v2`: "en Portal no escribas la dirección". `pnpm eval:content` se corre de nuevo (con `--provider fake` en la CI; con Claude, el operador).
- **Título:** el formato de F2 (`Departamento en venta 3 dormitorios 2 baños en Ñuñoa`) ya sigue la recomendación de Mercado Libre (operación, tipo, dormitorios y comuna, sin abreviar). El tope de 60 se mantiene; el máximo real de la hoja puede ser mayor (en Argentina, 200) y `buildPortalItem` lo revisa igual.

### 4.8 Publisher de Portal (`packages/publishers/mercadolibre`)
- **Contrato** (ADR-0015, extiende el de ADR-0014):
  ```ts
  interface Publisher {
    readonly platform: Platform;
    readonly formats: readonly PublicationFormat[];
    validate(input: PublishInput): PublishValidation;                  // pura, como en F3
    publish(input: PublishInput, ctx: PublishContext): Promise<PublishResult>;
    preflight?(input: PublishInput, ctx: PlatformContext): Promise<PublishValidation>; // solo lee y valida (ADR-0016)
    pause?(ref: PublishedRef, ctx: PlatformContext): Promise<RemoteStatus>;
    resume?(ref: PublishedRef, ctx: PlatformContext): Promise<RemoteStatus>;
    close?(ref: PublishedRef, ctx: PlatformContext): Promise<RemoteStatus>;
    getStatus?(ref: PublishedRef, ctx: PlatformContext): Promise<RemoteStatus>;
  }
  type PlatformContext = { account: PlatformAccount; accessToken: AccessTokenProvider; signal?: AbortSignalLike };
  type PublishContext = PlatformContext & { progress: unknown | null; saveProgress(progress: unknown): Promise<void> };
  type PublishedRef = { externalId: string; progress: unknown | null };
  type RemoteStatus = Omit<RemoteState, "checkedAt">;              // core agrega `checkedAt` al guardar
  ```
  `accessToken` (`AccessTokenProvider`, `(opts?: { rejectedToken?, signal? }) => Promise<string>`, el mismo que recibe el catálogo) lo arma core con `accessTokenProvider` (`ensureAccessToken`), sin estado: después de un 401, quien llama pasa el token rechazado (desde la revisión de F4-T09). El publisher no conoce repositorios. `PublishContext.credentials` se mantiene para Instagram. `close` reemplaza el `unpublish` anunciado en ADR-0014. Instagram no implementa los opcionales.
- **`withDryRun`:** `publish` corre `checkPublishInput` y, si el publisher tiene `preflight`, lo llama (ADR-0016: lecturas y `POST /items/validate`; nunca subir fotos, crear ni cambiar estados). Un `ok: false` de `preflight` (el rechazo de `validate`, con sus `issues` de código y motivo) se trata como en `live`: `PUBLISH_INPUT_INVALID` con los motivos, y la publicación queda `failed` (core no nombra códigos `ML_*`). Las advertencias van a la bitácora: T13 suma `notes?: string[]` a `{ ok: true }` de `PublishValidation`. Nunca llama a `publish`, `pause`, `resume` ni `close` del envuelto. En `dry-run` las fotos van a `validate` como `source` con su URL firmada (no se suben); lo que esto no cubre (que Mercado Libre descargue y acepte cada foto) se anota. Un `ML_UNAVAILABLE` en `preflight` es reintentable, como en `live`.
- **Fotos por subida directa** (D4): el worker baja de R2 cada `pi_4x3` fijada en la publicación y la sube a `POST /pictures/items/upload` (`multipart`); con los `id` arma `pictures`. No depende de que Mercado Libre descargue una URL firmada (asíncrono y sin plazo documentado), y un error de foto se conoce al instante. El límite por minuto de esa subida responde 400 "Bad_request" sin más detalle: un 400 sin causas que bloqueen y con `error` vacío o `bad_request` se clasifica `ML_RATE_LIMITED` (reintentable); con causas u otro código sigue la tabla general, para que una foto mala no gaste los reintentos. Una foto vacía o que no es JPEG ni PNG no se sube (`ML_PICTURE_INVALID`).
- **Pasos y progreso** (`portalProgressSchema` en core):
  1. Sube las fotos que falten y guarda `pictureIds` en orden **después de cada foto** (un límite a mitad de camino no obliga a subirlas todas de nuevo). Si un intento posterior recibe 508 o 509 (id de foto inválido; `hasMercadoLibreCause`), las vuelve a subir una vez (`picturesReuploaded`, campo opcional que suma T14 al progreso).
  2. Guarda `sellerContact` y `createRequestedAt`, y crea el ítem (`POST /items`, con `seller_custom_field` = id de la publicación); guarda `itemId` apenas responde.
  3. Si la descripción no puede ir en el `POST` (la doc se contradice; `ml:smoke` lo confirma), `POST /items/{id}/description` y guarda `descriptionDone`. Al retomar sin `descriptionDone`, primero la lee (`GET /items/{id}/description`, `getDescription`): un `POST` sobre una descripción que ya existe falla, y un corte justo después de cargarla dejaría la publicación `failed` con el ítem vivo. No se usa `PUT …/description` (sería editar, §3).
  4. Si `show_exact_address = false` y Mercado Libre exige `address_line` (D7), `PUT /items/{id}/address_line_by_reference` y guarda `addressHidden`.
  5. Resultado: `externalId` = id del ítem, `externalUrl` = `permalink`.
- **Retoma sin duplicar:** con `itemId`, sigue desde el paso que falte. **¿Se creó o no?** (`itemCreationOutcome`): si Mercado Libre respondió un 4xx (salvo 408 y 425) o el pedido no salió (cuerpo o token inválidos), el ítem **no se creó** y se puede crear de nuevo (por ejemplo, después de refrescar el token ante un 401 o de volver a subir las fotos ante 508/509). En lo demás (5xx, 408, 425, red, tope, señal, o un 2xx con otra forma) **no se sabe**. Con `createRequestedAt` y sin `itemId` en ese caso **nunca repite `POST /items` solo**: busca el ítem del vendedor con ese `seller_custom_field` (`GET /users/{id}/items/search?sku=`, sin filtro de estado; si trae los `paused` o `not_yet_active` recién creados, NO VERIFICADO: lo revisa T10); si encuentra exactamente uno y `get` confirma su `seller_custom_field`, retoma; si encuentra más de uno, `ML_PUBLISH_OUTCOME_UNKNOWN`; si la búsqueda vuelve vacía o falla (el índice puede tardar), `ML_PUBLISH_OUTCOME_UNKNOWN` (no reintentable), con el mensaje de Instagram: revisar en Mercado Libre y, si no salió, descartar y volver a publicar; si salió, cerrarlo a mano antes. Crear dos ítems gastaría dos cupos.
- **Estado inicial:** el ítem puede nacer `active` o quedar `paused`/`not_yet_active` mientras Mercado Libre procesa las fotos (nota §5). La publicación queda `published` (el ítem existe y tiene enlace) con el `remote_state` que devolvió la creación; el sync de los 2 min lo actualiza.
- **Operaciones:** `pause` (`status: paused`), `resume` (`status: active`), `close` (`status: closed`, irreversible) y `getStatus` (`GET /items/{id}`: `status`, `sub_status`, `permalink`, `stop_time`, `expiration_time`, `tags`, `listing_source`), con el `seller_contact` del progreso. Tope de 10 s por llamada cuando las usa la API (§4.9).
- **Errores** (`AppError`, nota §7):
  | Código | Casos | Reintentable |
  |---|---|---|
  | `ML_AUTH_INVALID` | 401 (el primero llega con `httpStatus: 401` y quien llama refresca una vez y repite; si vuelve, la cuenta pasa a `expired`), `invalid_grant`, un token guardado mal formado | No (la cuenta pasa a `expired`, §4.3) |
  | `ML_PERMISSION_DENIED` | 403 `forbidden`, scopes faltantes, `unauthorized_application`, `invalid_operator_user_id` (autorizó un colaborador) | No |
  | `ML_APP_CREDENTIALS_INVALID` | `invalid_client` o `unauthorized_client` en el canje o el refresco (el par de la app mal copiado o renovado en el panel) | No; la cuenta **no** pasa a `expired`: se corrige `.env` y se reintenta |
  | `MERCADOLIBRE_NOT_CONFIGURED` | Falta `ML_APP_ID` o `ML_CLIENT_SECRET` (lo lanzan la API, `ensureAccessToken` y el lote antes de llamar) | No; la cuenta no cambia |
  | `ML_ITEM_REJECTED` | 400 con `cause[]` de tipo `error` (126, 147, 7810, 173, 201, 3703, 109/129, 398, `seller_contact.*`) | No; el mensaje lista las causas en español, sin datos del aviso |
  | `ML_NO_QUOTA` | Sin cupo `silver` en el paquete | No |
  | `ML_RATE_LIMITED` | 429, y el 400 por límite de subida de fotos | Sí (backoff de la cola) |
  | `ML_UNAVAILABLE` | 5xx, 408, 425, red, tope de tiempo | Sí |
  | `ML_CONFLICT` | 409 "optimistic locking" | Sí |
  | `ML_PUBLISH_OUTCOME_UNKNOWN` | `POST /items` sin respuesta y sin poder encontrarlo | No |
  | `ML_UNEXPECTED_RESPONSE` | Otra forma de respuesta | No |
  | `ML_ID_INVALID` | Un id (ítem, usuario, categoría o ubicación) que va en la ruta y no tiene la forma de Mercado Libre: no se llama | No |
  | `ML_BODY_INVALID` | Un cuerpo que no se puede convertir a JSON: no se envía (el ítem no se creó) | No |
  | `ML_PICTURE_INVALID` | Una foto vacía o que no es JPEG ni PNG: no se sube | No |
  | `ML_STATUS_NOT_ALLOWED` | Un cambio de estado que no es pausar, reactivar ni cerrar (nunca se envía `deleted`) | No |
  | `ML_REQUEST_REJECTED` | Otro 4xx sin causas que bloqueen (`invalid_request`, `invalid_scope`, `not_found`, …): el mensaje nombra el código de Mercado Libre o el status | No |
  | `ML_ABORTED` | La señal cortó la llamada (apagado del worker) | Sí |
  `ML_NO_QUOTA` todavía no se reconoce: la doc no dice con qué código responde Mercado Libre sin cupo; hasta que `ml:smoke` o la demo lo muestren (T10, T23), llega como `ML_ITEM_REJECTED` o `ML_REQUEST_REJECTED` con el código tal cual. Las advertencias (`cause[].type = "warning"`) no bloquean y van a la bitácora. Ningún error lleva el token, el refresh, el secret, el código ni el WhatsApp.

### 4.9 Pausar, reactivar, cerrar y sincronizar
- **Estados** (la máquina de F3 ya los tiene): `published` → `paused` (pausar) → `published` (reactivar); `published` o `paused` → `unpublished` (cerrar). Una `paused` cuenta como activa, no como pendiente: no bloquea preparar contenido.
- **Pausar, reactivar y cerrar son síncronos en la API** (ADR-0015, con el criterio del punto 9 de ADR-0014: una llamada corta sobre algo que ya existe en la plataforma, cuyo resultado el operador espera en pantalla). El caso de uso: revisa el estado (`INVALID_TRANSITION` si no corresponde), obtiene el token y llama a Mercado Libre **antes y fuera** del `ListingLock`, y después, dentro del candado, aplica la transición **condicional** desde el estado leído con su evento y el `remote_state` que devolvió Mercado Libre. Si Mercado Libre respondió bien y falla guardar, el sync lo corrige. Los topes (10 s del candado de credenciales, 10 s por llamada) dejan el total bajo los 30 s de la CLI y los 35 s del panel.
- **El modo (D11 de F3):** una publicación de `dry-run` se pausa, reactiva o cierra en simulación, sin llamar a Mercado Libre (queda en la bitácora). Una de `live` exige la API en `live`; si no, `PUBLISH_MODE_MISMATCH` (409): nunca se cambia algo real estando en simulación.
- **Cerrar** pide confirmación en `live` en el panel y la CLI (`{ confirmed: true }`; sin ella, `CLOSE_NOT_CONFIRMED`, como `REMOVAL_NOT_CONFIRMED` de F3): es irreversible, y volver a publicar crea un ítem nuevo y gasta otro cupo. Al cerrar la última publicación en `live` publicada o pausada del aviso, este vuelve a `ready` (como al retirar en F3). Pausar no cambia el aviso.
- **Marcar como retirada** (F3) no aplica a Portal: se cierra por la API (`RETIRE_NOT_SUPPORTED`, con el mensaje de usar Cerrar).
- **Sincronizar (`syncPublication`, job `publication.sync`):** solo actúa sobre publicaciones de Portal `published` o `paused` en `live`; guarda el `updatedAt` de la publicación **antes** de leer `getStatus` (es solo lectura: corre en cualquier modo de la API y el worker). Dentro del candado del aviso:
  - si el `updatedAt` releído no es igual al guardado (la publicación cambió mientras se leía; por ejemplo, el operador la pausó), no aplica nada y se reencola. Se compara por igualdad entre dos valores de la base (`clock_timestamp()`), nunca contra el reloj del worker;
  - guarda `remote_state` (`status`, `subStatus`, `stopTime`, `expirationTime`, `checkedAt`) con un evento `sync` (`syncPayloadSchema`: lo leído, sin secretos);
  - y ajusta el estado con actor `system`, condicional desde el estado leído: `closed` (también `expired` o `deleted`) → `unpublished` (y el aviso a `ready` si era la última); `paused` en Mercado Libre desde `published` → `paused` (moderación, con el motivo en `remote_state`); `active` desde `paused` → `published`. `under_review`, `not_yet_active`, `picture_download_pending` o un estado desconocido (`inactive`, `payment_required`…) solo se guardan en `remote_state` y se muestran ("en revisión", "procesando fotos").
- **Cuándo corre:** a pedido (`POST /publications/:id/sync`, CLI `publications sync <id>`, botón Actualizar), 2 min después de cada publicación en `live` (`startAfter`, encolado después de guardar `published`) y al arrancar el worker para las de Portal `published` o `paused` en `live`. La sincronización periódica (cron) es de F6. Cola `exclusive` por `publicationId`, 2 reintentos desde 60 s, expira a los 2 min (reemplaza la fila objetivo de `01-arquitectura.md`).

### 4.10 Datos (migración `0007`, ADR-0015)
- **`platform_catalog`:** `platform` (enum `platform`), `key text`, `data jsonb`, `fetched_at timestamptz`, `created_at`, `updated_at`; llave primaria `(platform, key)`.
- **`publications.remote_state jsonb null`:** lo último que informó la plataforma (`remoteStateSchema` en core); `null` hasta el primer dato y en Instagram. Lo escribe `PublicationRepository.setRemoteState` (solo, con su evento `sync`) o una transición (`changes.remoteState`). El esquema solo se amplía con campos opcionales. El motivo de una pausa de Mercado Libre (`GET /moderations/last_moderation/{id}-ITM`, nota §4.4) se suma como campo opcional cuando T17 lo guarde (la llamada la suma T15 al cliente).
- **`publications.listing_source_hash text null`:** el `source_hash` del aviso al nacer (§4.6); `null` en las publicaciones anteriores a la migración (Instagram no lo revisa).
- `publications.progress` de Portal: `{ pictureIds, sellerContact?, createRequestedAt?, itemId?, descriptionDone?, addressHidden? }` (`portalProgressSchema`).
- `platform_accounts` no cambia de columnas: el `refresh_token` va dentro de `credentials_encrypted`, y `token_expires_at` de Mercado Libre es el horizonte del `refresh_token` (§4.3).

### 4.11 Contratos (API, ADR-0011)
| Método y ruta | Qué hace |
|---|---|
| `POST /accounts/mercadolibre/authorize-url` `{ broker }` | La URL de autorización con el `state` firmado (§4.2) |
| `POST /accounts/mercadolibre/connect` `{ broker, code, state }` | Conecta con el código pegado; nunca devuelve tokens |
| `POST /accounts/:id/refresh` | Acepta Mercado Libre (§4.3) |
| `GET /accounts` | `connect.mercadolibre` con lo que el panel necesita para mostrar los pasos |
| `GET /listings/:id/content` | La pestaña Portal suma `portalReadiness` (lo que falta, en español) |
| `POST /listings/:id/publish` `{ platform: "portal_inmobiliario" }` | Como en F3 (202); `PORTAL_NOT_READY` antes de pasar a `publishing` |
| `POST /publications/:id/pause`, `/resume` y `/close` (`{ confirmed: true }` para cerrar en `live`) | Síncronos (200), con la publicación y su `remoteState` |
| `POST /publications/:id/sync` | Encola la sincronización (202) |

La vista de una publicación suma `remoteState`. Códigos nuevos con su HTTP en `apps/api/src/errors.ts`: `PORTAL_NOT_READY`, `PORTAL_WHATSAPP_MISSING`, `PORTAL_CATEGORY_NOT_FOUND`, `PORTAL_LOCATION_NOT_FOUND`, `PORTAL_CURRENCY_NOT_ALLOWED`, `RETIRE_NOT_SUPPORTED`, `CLOSE_NOT_CONFIRMED` y `PUBLISH_MODE_MISMATCH` (409); `ML_SITE_MISMATCH`, `ML_AUTH_INVALID`, `ML_PERMISSION_DENIED` y `ML_REQUEST_REJECTED` (400 al conectar); `OAUTH_STATE_INVALID` (400); `MERCADOLIBRE_NOT_CONFIGURED` y `ML_APP_CREDENTIALS_INVALID` (503: la configuración de la API); `ML_ID_INVALID`, `ML_BODY_INVALID` y `ML_PICTURE_INVALID` (500: datos del servidor); `ML_UNAVAILABLE` (503), `ACCOUNT_LOCK_TIMEOUT` (503: otro proceso renueva el acceso de la cuenta), `ML_RATE_LIMITED` (429), `ML_UNEXPECTED_RESPONSE` (502), `ML_ITEM_REJECTED` y `ML_CONFLICT` (409 en las operaciones). Los `ML_*` de publicar y `PUBLICATION_LISTING_CHANGED` viajan en `last_error`.

### 4.12 CLI y panel
- **CLI:**
  - `accounts connect mercadolibre --broker <slug>` (imprime y abre la URL) y `--url-stdin` (lee la dirección de vuelta por tubería; no la muestra).
  - `publish <id> --platform portal`; `publications pause|resume|close|sync <id>` (`close` pregunta en `live`; `--yes`); `publications` muestra el estado en Mercado Libre y el vencimiento.
- **Panel:**
  - **Cuentas:** Mercado Libre por corredor, con su `nickname` (tal cual, sin `@`), estado, vencimiento estimado y los dos pasos para conectar (el comando que abre la URL y el que pega la dirección).
  - **Contenido > Portal:** lo que falta para Portal (`portalReadiness`), aprobar, publicar, y la publicación con su estado, el estado en Mercado Libre ("procesando fotos", "en revisión", "pausada por Mercado Libre"), el vencimiento (`stopTime`), el enlace y los botones Pausar, Reactivar, Cerrar (con confirmación) y Actualizar.

### 4.13 Decisiones (aprobación permanente del operador; D2, D5 y D6 las respondió él)
- **D1 · Conectar pegando la dirección de vuelta** (§4.2): sin túnel ni HTTPS local. El `state` firmado se verifica igual. La vuelta automática queda para F7.
- **D2 · `dry-run` en Portal lee de Mercado Libre y valida sin publicar** (ADR-0016; respuesta del operador): baja el catálogo, refresca el token si hace falta y llama a `POST /items/validate`, que no crea nada ni gasta cupo. Nunca sube fotos, crea ítems ni cambia estados. Los tests siguen sin llamar a Mercado Libre (msw).
- **D3 · Sin PKCE en F4:** el canje es del servidor, con el secret.
- **D4 · Fotos por subida directa** (`/pictures/items/upload`), no por URL firmada de R2.
- **D5 · El WhatsApp del aviso es el del corredor** (hoja Corredor); sin él no se publica. En la demo sale el del corredor `agentsales-pruebas` (respuesta del operador).
- **D6 · La demo en `live` usa la cuenta real del operador con un paquete pagado** (respuesta del operador, en vez de un usuario de prueba, que exige una activación de soporte sin plazo conocido). El aviso es real y se cierra al final; cerrar es irreversible y el cupo usado no vuelve. Antes de contratar, el operador revisa el precio y si su cuenta necesita activación para verlo (nota §2).
- **D7 · `show_exact_address`:** con `true`, `address_line` con calle, número y unidad; con `false`, solo región, comuna y barrio por id. Si `ml:smoke` muestra que `address_line` es obligatoria, se envía y se oculta con `address_line_by_reference`.
- **D8 · Nada se inventa para cumplir con Mercado Libre:** si falta la superficie total o los gastos comunes, o mascotas dice "A consultar", `portalReadiness` lo pide y el operador lo completa en la planilla.
- **D9 · Pausar, reactivar y cerrar son síncronos en la API** (§4.9, ADR-0015).
- **D10 · Sin editar avisos publicados en F4:** se cierra y se vuelve a publicar (F6).
- **D11 · Catálogo en la base con 7 días de vida**, bajado a pedido y nunca con ids escritos a mano (§4.4, ADR-0015).
- **D12 · Una sola cuenta de Mercado Libre por corredor** (como Instagram) y solo `silver`.
- **D13 · La publicación fija la versión del aviso** (`listing_source_hash`, §4.6).

### 4.14 Dependencias nuevas
Ninguna. `fetch`, `FormData` y `Blob` de Node para el cliente y la subida de fotos; `msw` en los tests.

## 5. Tareas
ADR-0015 y ADR-0016 se registran con la aprobación del spec (en su mismo PR), antes de T01.

### F4-T01 · Esquema y entidades (migración `0007`)
- **Depende de:** —
- **Archivos:** `packages/core/src/{platform-account.ts,publication.ts,platform-catalog.ts}`, `packages/core/src/portal/progress.ts`, `packages/db/src/schema.ts`, `packages/db/drizzle/0007_*.sql`, `packages/db/src/repositories/publications.ts` (`setRemoteState`, `listing_source_hash` al crear), el doble de publicaciones, `docs/02-modelo-datos.md`
- **Descripción:** `platform_catalog`, `publications.remote_state` y `publications.listing_source_hash`; `PlatformCredentials` con `refreshToken` opcional; `mercadoLibreAccountMetaSchema`, `portalProgressSchema`, `remoteStateSchema` y `syncPayloadSchema`; `MERCADOLIBRE_SITE_ID`.
- **Hecho cuando:**
  - [x] La migración se aplica en PGlite y `pnpm db:generate` no genera nada después
  - [x] Tests de los esquemas (las credenciales de Instagram siguen válidas sin `refreshToken`) y de `setRemoteState` en los dos repositorios
  - [x] Probada en Neon con `BEGIN … ROLLBACK` antes del merge (2026-10-06: tabla y columnas creadas, las 5 publicaciones existentes con las columnas nuevas en `null`, sin dejar cambios)
  - [x] Aplicada en Neon justo después del merge (2026-10-06, `pnpm db:migrate`: `platform_catalog` y las dos columnas de `publications` creadas; las 5 publicaciones de Instagram intactas)
  - [x] Doc 02 al día (tablas, `token_expires_at` de Mercado Libre y `credentials_encrypted`)

### F4-T02 · Variables de Mercado Libre y redactor
- **Depende de:** —
- **Archivos:** `packages/config/src/env.ts`, `packages/core/src/redact.ts`, `apps/cli/src/commands/doctor/*`, `.env.example`
- **Descripción:** `ML_APP_ID`, `ML_CLIENT_SECRET` y `ML_REDIRECT_URI` (`https://`, por defecto el de §4.2); se quita `ML_SITE_ID`; `doctor` avisa si falta el par y muestra la dirección de retorno; el redactor oculta `refresh_token`, `APP_USR-…` y `TG-…`.
- **Hecho cuando:**
  - [x] Tests del entorno (una URI `http://` se rechaza) y de `doctor`
  - [x] Tests del redactor con un token y un refresh de Mercado Libre en una URL, un formulario y un JSON

### F4-T03 · Cliente de Mercado Libre: OAuth, usuario y errores
- **Depende de:** T01, T02
- **Archivos:** `packages/publishers/src/mercadolibre/{auth.ts,http.ts,errors.ts,constants.ts}`, `packages/core/src/ports/mercadolibre-auth.ts`
- **Descripción:** `createMercadoLibreAuth` (puerto `MercadoLibreAuth`): URL de autorización, canje y refresco (parámetros en el cuerpo), `GET /users/me`; base HTTP con `Bearer`, tope configurable (30 s en el worker, 10 s en la API), señal, y la tabla de errores `ML_*` (§4.8) con `cause[]` traducido.
- **Hecho cuando:**
  - [x] Tests con msw: canje, refresco que rota, `invalid_grant`, `invalid_client` y `unauthorized_client` (`ML_APP_CREDENTIALS_INVALID`), 401, 403, 429, 5xx, red, tope y forma inesperada
  - [x] Ningún error ni log lleva el token, el refresh, el secret ni el código (test)

### F4-T04 · Cliente de Mercado Libre: ítems y fotos
- **Depende de:** T03
- **Archivos:** `packages/publishers/src/mercadolibre/{items.ts,pictures.ts}`
- **Descripción:** `POST /items`, `GET /items/{id}`, `PUT /items/{id}` (estado, con `seller_contact`), `POST /items/{id}/description`, `PUT /items/{id}/address_line_by_reference`, `GET /users/{id}/items/search` por `seller_custom_field` (todos los estados) y `POST /pictures/items/upload` (`multipart`; el 400 por límite es `ML_RATE_LIMITED`). La base de T03 (`mercadoLibreRequest`) suma el cuerpo JSON (`Content-Type: application/json`), el `multipart` (`FormData`, sin fijar el `Content-Type`) y un `classify?(info)` que se consulta antes de `mercadoLibreError` (para el 400 por límite de fotos); `usePlatformServer` registra el cuerpo crudo y su tipo. 508 y 509 llegan como `cause_id` de un 400 `validation_error` (doc de imágenes, re-leída el 2026-10-07): son `ML_ITEM_REJECTED` y T14 los reconoce por la causa para volver a subir las fotos una vez.
- **Hecho cuando:**
  - [x] Tests con msw de cada llamada, con advertencias en `cause[]` y la forma del `multipart`
  - [x] El cliente no tiene ninguna llamada que borre ítems (test)

### F4-T05 · Cliente de Mercado Libre: catálogo y `validate`
- **Depende de:** T03
- **Archivos:** `packages/publishers/src/mercadolibre/{catalog-api.ts,validate.ts}`
- **Descripción:** `GET /categories/{id}`, `GET /categories/{id}/attributes`, `classified_locations` (país, estado y ciudad) y `POST /items/validate` (`204` o las causas).
- **Hecho cuando:**
  - [x] Tests con msw de cada llamada, incluida la respuesta de `validate` con errores y advertencias

### F4-T06 · Conectar Mercado Libre
- **Depende de:** T03
- **Archivos:** `packages/core/src/use-cases/connect-mercadolibre-account.ts` (y lo compartido con `connect-account.ts`), `apps/api/src/routes/accounts.ts`, `apps/api/src/contracts/*`
- **Descripción:** `connectMercadoLibreAccount`; `POST /accounts/mercadolibre/authorize-url` y `/connect` (§4.2); `state` con la plataforma; `GET /accounts` con `connect.mercadolibre`.
- **Hecho cuando:**
  - [x] Tests: `state` vencido, de otra plataforma, de otro corredor o alterado; sitio que no es `MLC`; scopes sin `offline_access`; un canje sin `refresh_token` (`ML_UNEXPECTED_RESPONSE`, sin el valor en el error); un `user_id` del canje distinto del de `/users/me` (`ML_UNEXPECTED_RESPONSE`); reconectar; una cuenta por corredor; sin el par de la app, `authorize-url` y `/connect` responden `MERCADOLIBRE_NOT_CONFIGURED` sin llamar a Mercado Libre
  - [x] Ninguna respuesta ni log lleva el código ni los tokens (test)

### F4-T07 · Candado de credenciales y `ensureAccessToken`
- **Depende de:** T06
- **Archivos:** `packages/core/src/use-cases/ensure-access-token.ts`, `packages/core/src/ports/platform-account-repository.ts`, `packages/core/src/testing/*`, `packages/db/src/repositories/platform-accounts.ts`
- **Descripción:** `withCredentialsLock` en los dos repositorios (`FOR NO KEY UPDATE`, `lock_timeout` de 10 s) y `ensureAccessToken` (§4.3). Lee `meta.accessTokenExpiresAt` aparte del resto de la `meta` (como `refreshClockSchema` de F3: una `meta` incompleta no deja la cuenta sin poder refrescarse) y exige `refreshToken` en las credenciales de Mercado Libre (sin él, `CREDENTIALS_INVALID` sin el valor). El guardado del refresco no reutiliza el de Instagram (que escribe `tokenExpiryEstimated: false` y solo `{ accessToken }`).
- **Hecho cuando:**
  - [x] Test de concurrencia: dos `ensureAccessToken` a la vez refrescan una sola vez (memoria y PGlite)
  - [x] `invalid_grant` deja la cuenta `expired`; un corte de red, `ML_APP_CREDENTIALS_INVALID` o la falta del par de la app (`MERCADOLIBRE_NOT_CONFIGURED`, sin llamar) no la cambian; el par nuevo se guarda antes de usarse (test con un guardado que falla)
  - [x] Test de que aprobar (con la FK a la cuenta) no espera a un refresco en curso: PGlite tiene una sola conexión y pone en fila todas las transacciones, así que el test revisa el SQL del candado (`SET LOCAL lock_timeout` y `FOR NO KEY UPDATE`, nunca `FOR UPDATE`), y se comprobó en Neon el 2026-10-07 con dos conexiones y `ROLLBACK`: con `FOR NO KEY UPDATE` tomado, el `FOR KEY SHARE` de la FK pasó en 64 ms; con `FOR UPDATE`, esperó y venció (`55P03`)

### F4-T08 · Refresco por plataforma: lote y a pedido
- **Depende de:** T07
- **Archivos:** `packages/core/src/use-cases/refresh-account-tokens.ts`, `apps/worker/src/jobs/tokens-refresh.ts`, `apps/worker/src/worker.ts`, `apps/api/src/routes/accounts.ts`, `apps/api/src/errors.ts`, `apps/cli/src/commands/accounts.ts`
- **Descripción:** la política de refresco por plataforma (§4.3); `tokens.refresh` y `POST /accounts/:id/refresh` con Mercado Libre. Reutiliza el núcleo de T07 (`refreshMercadoLibreToken` con su propio `shouldRefresh`: la regla de 7 días, revisada otra vez dentro del candado, o siempre con `force`), sin copiar el guardado; `outcome: "kept"` es "otro ya lo había refrescado". El refresco de Mercado Libre escribe `tokenRefreshedAt`, `accessTokenExpiresAt` y `token_expires_at` = ahora + `MERCADOLIBRE_REFRESH_TOKEN_DAYS` (en `platform-account.ts`), y conserva `tokenExpiryEstimated: true` (el esquema no acepta `false`). Un rechazo al refrescar (`ML_AUTH_INVALID`) es un resultado: `200` con `outcome: "expired"` y `token_rejected`, como el 190 de Instagram (`ML_AUTH_INVALID` sigue en 400 solo al conectar).
- **Hecho cuando:**
  - [x] `ACCOUNT_LOCK_TIMEOUT` es 503 en la API (reintentable: "se reintenta en un momento"), con su test en `errors.test.ts`
  - [x] Tests de las dos políticas con reloj falso (Instagram sin cambios) y del lote con cuentas de las dos plataformas; sin el par de Mercado Libre, el lote se salta esas cuentas sin cambiarlas y sigue con Instagram
  - [x] El refresco de Mercado Libre guarda el par completo (`refreshToken` incluido; hoy `refreshAccountToken` guarda solo `{ accessToken }`) (la vista de la cuenta ya lee la `meta` de Mercado Libre desde T06)
  - [x] Seguimiento en ADR-0005

### F4-T09 · Catálogo con caché
- **Depende de:** T01, T05, T07
- **Archivos:** `packages/core/src/ports/platform-catalog-repository.ts`, `packages/core/src/portal/catalog.ts`, `packages/core/src/testing/platform-catalog.ts`, `packages/db/src/repositories/platform-catalog.ts`, `packages/publishers/src/mercadolibre/{catalog.ts,catalog-api.ts}` (el puerto `PortalCatalog` quedó en publishers: ningún caso de uso de core lo usa)
- **Descripción:** repositorio (PGlite y memoria) y `createPortalCatalog` (§4.4): hoja por tipo y operación bajando por nombres (una hoja es la que tiene `listingAllowed === true`, no solo la que no tiene hijas), atributos de una hoja y ubicación por región y comuna, con 7 días de vida y la copia vencida si falla la red. Las formas guardadas (categoría, atributo, ubicación) pasan a ser esquemas zod en core (`packages/core/src/portal/catalog.ts`), que son los tipos del puerto `PortalCatalog` y sirven para leer `data` de vuelta; el cliente de T05 devuelve esos tipos. Si T09 confirma que ningún caso de uso de core usa `PortalCatalog`, moverlo a `publishers` va como seguimiento de ADR-0015.
- **Hecho cuando:**
  - [x] Tests con un árbol, atributos y ubicaciones de muestra (msw): resuelve, baja solo lo necesario, cachea, vence y usa la copia
  - [x] Comunas con tildes, mayúsculas y alias

### F4-T10 · `pnpm ml:smoke`: catálogo y `validate`
- **Depende de:** T05, T07, T09
- **Archivos:** `apps/worker/src/scripts/ml-smoke.ts`, `apps/worker/src/smoke/ml-smoke.ts`, `package.json`, `CLAUDE.md`
- **Descripción:** con la cuenta conectada, baja las hojas de cada tipo y operación con sus `settings` y obligatorios y las imprime, y valida un cuerpo armado a mano con `POST /items/validate` y sus variantes (sin `address_line`, descripción en el cuerpo, `CMG_SITE` corto, `CLF`). También imprime los tags de los atributos obligatorios (`read_only`, `fixed`, `hidden`: cuáles aparecen en MLC) y revisa con ids reales que las ubicaciones calcen con el patrón de `catalog-api.ts` (base64 sin `+` ni `/`). Además (solo lectura) consulta `GET /users/{id}/items/search` sin `status` y con `include_filters=true` para anotar qué estados trae por defecto (la retoma de T14 necesita encontrar un ítem `paused` o `not_yet_active`); si no los trae, T14 busca con `status=` en esos estados. **Nunca** sube fotos, crea ni modifica ítems. **Sí escribe en la base:** el catálogo y, si refresca, el par de tokens (con el candado). Lo corre el operador.
- **Hecho cuando:**
  - [ ] Test con msw que verifica que nunca se sube una foto ni se crea o modifica un ítem
  - [ ] Salida sin tokens; `CLAUDE.md` (Comandos) al día
  - [ ] Los nombres e ids reales y las respuestas de `validate` quedan en la nota de Mercado Libre (operador + Claude), antes de T11
  - [ ] `PORTAL_LOCATION_ALIASES` (core) completo con los nombres reales de los estados y de las comunas que no calcen con una ciudad, y verificado que Chile no exige `neighborhood` (la búsqueda de T09 usa barrios solo por alias)
  - [ ] `ml:smoke` no marca la cuenta `expired` ante un 401 repetido: lo informa y sale con 1

### F4-T11 · Mapeo y revisión previa
- **Depende de:** T09, T10
- **Archivos:** `packages/core/src/portal/{fields.ts,readiness.ts}`, `packages/publishers/src/mercadolibre/item.ts`
- **Descripción:** la tabla de campos, tipos y alias (core), `portalReadiness` (core, pura) y `buildPortalItem` (§4.5). Los atributos con tag `read_only`, `fixed` o `hidden` (los que completa la categoría, como `PROPERTY_TYPE` u `OPERATION`) no se exigen ni se envían; `currencies: null` es "sin dato" (no bloquea) y `[]`, "ninguna permitida".
- **Hecho cuando:**
  - [ ] Tests por tipo y operación, UF con decimales, CLP, cada obligatorio faltante, "A consultar", sin WhatsApp, `show_exact_address` en los dos valores y una hoja con un obligatorio que no está en la tabla
  - [ ] El cuerpo nunca lleva `internal_notes` ni campos sin mapeo (test)

### F4-T12 · Reglas del texto de Portal
- **Depende de:** —
- **Archivos:** `packages/core/src/content/{check.ts,check-terms.ts,prompt.ts}`, `docs/04-formato-publicaciones.md`
- **Descripción:** `ADDRESS_EXPOSED` siempre en Portal, `CONTACT_IN_TEXT` y el prompt `listing-content-v2` (§4.7).
- **Hecho cuando:**
  - [ ] Tests de las reglas (teléfono, correo, URL, dirección con `show_exact_address = true`) sin falsos positivos en precios, superficies ni el cierre de Portal
  - [ ] `pnpm eval:content --provider fake` en verde; el operador corre la evaluación con Claude
  - [ ] Doc 04 al día

### F4-T13 · Contrato `Publisher` ampliado y el aviso en el input
- **Depende de:** T01
- **Archivos:** `packages/core/src/ports/{publisher.ts,listing-repository.ts}`, `packages/core/src/publish/{dry-run.ts,input.ts}`, `packages/core/src/testing/*`, `packages/db/src/repositories/listings.ts` (`getSourceHash`), `docs/01-arquitectura.md`
- **Descripción:** `preflight`, `pause`, `resume`, `close` y `getStatus` opcionales, `PlatformContext` con `accessToken` (§4.8), que core arma con `accessTokenProvider` (sin estado: quien recibió el 401 pasa `rejectedToken`); `withDryRun` con `preflight`; `buildPublishInput` con `listing`, `brokerContact` y `PUBLICATION_LISTING_CHANGED` (§4.6); `publishAttemptRecord` con los campos del ítem y el WhatsApp enmascarado; el publisher falso con las operaciones.
- **Hecho cuando:**
  - [ ] Tests de `withDryRun`: llama a `preflight` y nunca a `publish`, `pause`, `resume` ni `close` del envuelto
  - [ ] Tests de `buildPublishInput` (aviso cambiado, publicación de Portal sin versión, sin `internal_notes`) y del registro (WhatsApp enmascarado); `getSourceHash` en los dos repositorios de avisos
  - [ ] Instagram sigue igual (sus tests pasan sin cambios); doc 01 al día (contrato y `withDryRun`)

### F4-T14 · Publisher de Portal: publicar
- **Depende de:** T04, T11, T13
- **Archivos:** `packages/publishers/src/mercadolibre/publisher.ts`
- **Descripción:** `createPortalPublisher` con `validate` y `publish` (§4.8): fotos, ítem, descripción, dirección oculta, progreso y retoma.
- **Hecho cuando:**
  - [ ] Tests con un Mercado Libre simulado con estado: publica, retoma desde cada paso del progreso sin duplicar (también con la descripción ya cargada y sin `descriptionDone`), vuelve a subir fotos ante 508/509, guarda `pictureIds` por foto, crea de nuevo solo si `itemCreationOutcome` dice `not_created`, encuentra el ítem por `seller_custom_field` y da `ML_PUBLISH_OUTCOME_UNKNOWN` si no lo encuentra o si encuentra más de uno (nunca repite `POST /items` a ciegas)
  - [ ] Un 401 refresca una vez con `accessToken({ rejectedToken })`; ese reintento cubre solo las llamadas del publisher al cliente: un error del catálogo marcado `rejected_after_refresh` no se reintenta (test)

### F4-T15 · Publisher de Portal: operaciones y `preflight`
- **Depende de:** T14
- **Archivos:** `packages/publishers/src/mercadolibre/{publisher.ts,operations.ts}`
- **Descripción:** `pause`, `resume`, `close` y `getStatus` con el `seller_contact` del progreso (`getStatus` también lee el motivo de una pausa por moderación, `GET /moderations/last_moderation/{id}-ITM`: el cliente lo suma aquí y T17 lo guarda); `preflight` con el catálogo y `POST /items/validate` (fotos como `source` firmado, sin subirlas).
- **Hecho cuando:**
  - [ ] Tests de cada operación y del `remote_state` que devuelven
  - [ ] `preflight` nunca sube fotos ni crea o modifica ítems (test)

### F4-T16 · Intento, publicar y aprobar con Portal
- **Depende de:** T07, T11, T13
- **Archivos:** `packages/core/src/use-cases/{publish-publication.ts,publish-listing.ts,publication-start.ts,approve-content.ts,open-publications.ts}`, `packages/core/src/ports/publication-repository.ts` (`listingSourceHash` obligatorio), `packages/core/src/labels.ts`
- **Descripción:** el intento arma `accessToken` con `ensureAccessToken` (fuera del candado) y trata `ML_AUTH_INVALID` como `IG_AUTH_INVALID` (la cuenta a `expired`); `listing_source_hash` al abrir publicaciones (pasa a obligatorio en `NewPublication`: una de Portal sin versión no debe nacer); `PORTAL_NOT_READY` antes de pasar a `publishing`; la advertencia de `portalReadiness` al aprobar; el `remote_state` de la creación; textos para el operador del estado en Mercado Libre.
- **Hecho cuando:**
  - [ ] Tests del intento con el publisher falso de Portal (en `live` y `dry-run`), de `PORTAL_NOT_READY` y de `PUBLICATION_LISTING_CHANGED`
  - [ ] Un `ML_AUTH_INVALID` que llega al intento (también el 401 repetido, `rejected_after_refresh`, del catálogo o del publisher) deja la cuenta `expired` (test)
  - [ ] Instagram sigue igual

### F4-T17 · Pausar, reactivar, cerrar y sincronizar en core
- **Depende de:** T13, T16
- **Archivos:** `packages/core/src/use-cases/{pause-publication.ts,resume-publication.ts,close-publication.ts,sync-publication.ts,retire-publication.ts}`
- **Descripción:** casos de uso de §4.9: la llamada fuera del candado y la transición condicional dentro; el modo (`PUBLISH_MODE_MISMATCH`); cerrar con confirmación y el aviso a `ready` con la última; `RETIRE_NOT_SUPPORTED`; el sync con la hora de lectura y su tabla.
- **Hecho cuando:**
  - [ ] Tests de cada transición, `dry-run` sin llamadas, `live` con la API en `dry-run`, confirmación al cerrar y la tabla de estados remotos (incluido uno desconocido)
  - [ ] Un `ML_AUTH_INVALID` en `preflight`, las operaciones o el sync (también `rejected_after_refresh`) deja la cuenta `expired` (test)
  - [ ] Un sync que leyó antes de que el operador pausara no deshace la pausa (test, comparando el `updatedAt` leído antes con el releído); si Mercado Libre respondió bien y falló guardar, el sync lo corrige (test)

### F4-T18 · Worker: publicar y sincronizar Portal
- **Depende de:** T08, T15, T17
- **Archivos:** `apps/worker/src/jobs/{publication-sync.ts,publication-publish.ts}`, `apps/worker/src/worker.ts`, `packages/core/src/jobs.ts`, `docs/01-arquitectura.md`
- **Descripción:** el publisher de Portal registrado en los dos modos (con el catálogo y el token); job `publication.sync` con su política (§4.9); el sync 2 min después de publicar en `live` y al arrancar.
- **Hecho cuando:**
  - [ ] Tests del job (idempotente, solo `live`) y del registro
  - [ ] Tabla de colas del doc 01 y seguimiento en ADR-0005 al día

### F4-T19 · API de Portal
- **Depende de:** T06, T16, T17
- **Archivos:** `apps/api/src/routes/{publications.ts,content.ts}`, `apps/api/src/contracts/*`, `apps/api/src/errors.ts`, `apps/api/src/server.ts`
- **Descripción:** rutas de §4.11, `portalReadiness` en la vista del contenido y `remoteState` en la de la publicación; la API compone el publisher de Portal con el tope de 10 s. Revisar el peor caso de una operación con refresco (10 s de candado + 10 s de refresco + 10 s de la llamada, más un 401 con su reintento) frente a los 30 s de la CLI: quizá un tope menor para el candado desde la API.
- **Hecho cuando:**
  - [ ] Tests de cada ruta, CSRF y `hostGuard`; cerrar en `live` sin `confirmed` es `CLOSE_NOT_CONFIRMED`; `PUBLISH_MODE_MISMATCH`
  - [ ] Ninguna respuesta lleva tokens; seguimiento en ADR-0011

### F4-T20 · CLI de Portal
- **Depende de:** T19
- **Archivos:** `apps/cli/src/commands/{accounts.ts,publications.ts,publish.ts}`
- **Descripción:** comandos de §4.12; `--url-stdin` exige tubería y no muestra la dirección.
- **Hecho cuando:**
  - [ ] Tests de cada comando, de la confirmación de `close` y de `--url-stdin`
  - [ ] `CLAUDE.md` (Comandos) al día

### F4-T21 · Panel: Cuentas con Mercado Libre
- **Depende de:** T19
- **Archivos:** `apps/web/src/components/accounts/*`, `apps/web/src/pages/Accounts*`
- **Descripción:** la cuenta de Mercado Libre por corredor y los pasos para conectar (§4.12).
- **Hecho cuando:**
  - [ ] Tests de los estados y del comando para copiar
  - [ ] Revisión visual en el navegador

### F4-T22 · Panel: Portal en Contenido
- **Depende de:** T19
- **Archivos:** `apps/web/src/components/{content,publications}/*`
- **Descripción:** lo que falta para Portal, aprobar, publicar y la publicación con su estado en Mercado Libre, vencimiento y los botones Pausar, Reactivar, Cerrar y Actualizar (§4.12).
- **Hecho cuando:**
  - [ ] Tests de los botones (Cerrar con confirmación en `live`), lo que falta y el estado en Mercado Libre
  - [ ] Revisión visual en el navegador

### F4-T23 · `pnpm ml:smoke --listing`
- **Depende de:** T15, T16
- **Archivos:** `apps/worker/src/smoke/ml-smoke.ts`
- **Descripción:** `--listing <id_propiedad>` arma el cuerpo de un aviso real con `buildPortalItem` y corre `preflight` (`validate`), sin publicar. Lo corre el operador antes de la prueba en `live`.
- **Hecho cuando:**
  - [ ] Test con msw que verifica que nunca se sube una foto ni se crea o modifica un ítem

### F4-T24 · Cierre de fase
- **Depende de:** todas
- **Descripción:** `/fase-cerrar 4`.
- **Hecho cuando:**
  - [ ] Demos del plan (§7); la prueba en `live`, con la instrucción del operador en el chat
  - [ ] Nota de Mercado Libre con lo verificado; criterios de §6 con evidencia; auditoría del `arquitecto`
  - [ ] `CHANGELOG.md` `[0.4.0]`, spec cerrado, `docs/ESTADO.md` apuntando a F5
  - [ ] Tag `v0.4.0`, con permiso del operador

Orden: T01, T02 y T12 primero (independientes). T03 después de T01 y T02; T04, T05 y T06 después de T03; T07 después de T06 y T08 después de T07. T09 cuando estén T05 y T07, y T10 después (el operador lo corre apenas exista: fija los nombres de las categorías y la ubicación). T11 cuando estén T09 y T10. T13 después de T01. T14 cuando estén T04, T11 y T13, y T15 después. T16 cuando estén T07, T11 y T13; T17 después de T16. T18 cuando estén T08, T15 y T17. T19 cuando estén T06, T16 y T17; luego T20, T21 y T22. T23 cuando estén T15 y T16. Al final, T24. Si la cuenta de Mercado Libre no está lista para T10, T11 se escribe con los nombres de la nota y T10 se corre después (T11 se ajusta en un PR chico).

## 6. Criterios de aceptación de la fase
- [ ] Una propiedad de muestra aprobada queda visible en Portal Inmobiliario desde la cuenta del operador, y el sistema guarda su enlace (roadmap).
- [ ] Se pausa y se reactiva desde el panel, y el estado en Mercado Libre cambia (roadmap).
- [ ] Se cierra desde el panel o la CLI con confirmación, y la sincronización refleja cambios hechos en Mercado Libre (pausa, cierre, vencimiento).
- [ ] Lo que Mercado Libre pide y falta en el aviso se informa antes de enviar, sin inventar datos.
- [ ] En `dry-run` no se crea ni se modifica nada en Mercado Libre, y no se cambia nada real con la API en `dry-run` (tests y demo).
- [ ] Los tokens se guardan cifrados, rotan sin perder la cuenta y no aparecen en logs, errores ni respuestas (tests y demo).
- [ ] Un reintento nunca crea dos ítems (tests de retoma).
- [ ] Ningún test llama a Mercado Libre, Instagram, Facebook ni Anthropic; `pnpm check` en verde.

## 7. Plan de demo
1. **Operador, sin publicar:** cuenta de Mercado Libre Chile; app de developers con la URI `https://localhost/oauth/mercadolibre/callback`, PKCE desactivado y el permiso "Publicación y sincronización"; `ML_*` en `.env`. El paquete se contrata recién antes del paso 6.
2. Conectar la cuenta del operador al corredor `agentsales-pruebas` (§4.2). Ver el `nickname` y el vencimiento en la CLI y en **Cuentas**.
3. `pnpm ml:smoke` y `pnpm ml:smoke --listing P001` (operador): hojas, obligatorios y `validate` en `204`.
4. **`dry-run`:** en el panel, ver lo que falta para Portal en P001, completarlo en la planilla si hace falta (reimportar), aprobar Portal y publicar: queda `published` en simulación, con lo que se habría enviado y la validación de Mercado Libre en la bitácora. Pausar, reactivar y cerrar en simulación.
5. CLI: `approve P002 --platform portal`, `publish P002 --platform portal`, `publications P002 --events`.
6. **`live`, solo con la instrucción del operador en el chat y con el paquete `silver` contratado:** `PUBLISH_MODE=live pnpm dev`, publicar P001 en Portal, abrir el enlace y buscarlo en Portal Inmobiliario; ver "procesando fotos" y luego "activa" (Actualizar); pausar y reactivar desde el panel; cerrar con confirmación; ver `unpublished` y P001 de vuelta en "Lista". Apagar todo y volver a arrancar sin la variable.
7. Refresco: `pnpm -s cli accounts refresh <id> --force` y ver la última renovación (el `refresh_token` rotó sin perder la cuenta).

## 8. Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| La prueba en `live` gasta un cupo pagado y deja un aviso real (D6) | Todo antes se prueba con msw y `validate` (`dry-run` y `ml:smoke`); una sola publicación en la demo, cerrada al final; el paquete se contrata recién antes del paso 6 |
| La cuenta necesita activación de soporte para contratar paquetes (la doc lo dice para usuarios de prueba; para cuentas reales no está claro) | El operador lo revisa al crear la cuenta; si hace falta, se pide de inmediato |
| El panel de la app rechaza `https://localhost` | Cualquier URL `https` del operador sirve (la página no necesita cargar); solo cambia `ML_REDIRECT_URI` |
| Perder el `refresh_token` por dos refrescos o un corte a mitad de camino | Candado por cuenta, relectura dentro del candado y el par guardado antes de usarse; si igual se pierde, reconectar (dos pasos) |
| Restaurar un respaldo de la base (F6) o usar la misma cuenta desde un clon con otra base | El `refresh_token` guardado queda viejo y hay que reconectar; una cuenta de Mercado Libre se conecta a una sola base |
| El candado de credenciales bloquea aprobar o publicar | `FOR NO KEY UPDATE`, `lock_timeout` de 10 s, nunca anidado con el candado por aviso (test en T07) |
| Crear dos ítems y gastar dos cupos | Progreso antes de `POST /items`, búsqueda por `seller_custom_field` y `ML_PUBLISH_OUTCOME_UNKNOWN` sin repetir el `POST` |
| El sync deshace lo que hizo el operador | Hora de lectura, transición condicional y reencolar si la publicación cambió (T17) |
| Una carga del Excel cambia el aviso después de aprobar | `listing_source_hash` y `PUBLICATION_LISTING_CHANGED` (§4.6) |
| Los nombres de categorías o comunas no calzan | `ml:smoke` antes del mapeo, alias en core y errores con lo que no calzó |
| Mercado Libre modera el texto (contacto o dirección) | Reglas de §4.7 y `validate` antes de publicar |
| Cambios de reglas con fecha (fotos, WhatsApp) | Constantes en un archivo, obligatorios leídos del catálogo y `validate` en `dry-run` |
| `CLF` no aceptada en alguna hoja | `PORTAL_CURRENCY_NOT_ALLOWED` antes de enviar; nunca se convierte UF a CLP |
| Cerrar por error (irreversible) | Confirmación en el panel y la CLI; Pausar como opción por defecto |
| El aviso de arriendo vence a los 45 días | El panel muestra el vencimiento; republicar es de F6 |
| Publicar o cambiar algo real sin querer | `dry-run` por defecto, `PUBLISH_MODE_MISMATCH` en las operaciones, confirmación en `live` y la prueba solo con la instrucción del operador |
| El WhatsApp del corredor aparece en el aviso de la demo | Decidido por el operador (D5); el aviso se cierra al final |

## 9. Preguntas abiertas
Respondidas por el operador el 2026-10-06:
- [x] D2: ¿`dry-run` puede leer de Mercado Libre y llamar a `POST /items/validate`? Sí, sin publicar (ADR-0016).
- [x] D5: ¿qué WhatsApp sale en el aviso de prueba? El del corredor `agentsales-pruebas`.
- [x] D6: ¿usuario de prueba o cuenta real? La cuenta real del operador con un paquete pagado; el aviso se cierra al final.
- [x] ¿Cuenta de Mercado Libre y app de developers? Todavía no: quedan en `docs/07-checklist-cuentas.md` y no bloquean empezar (hasta T09 todo usa msw).

## 10. Registro de cambios del spec
| Fecha | Cambio |
|---|---|
| 2026-10-06 | Borrador inicial (`/fase-plan 4`), con la nota `docs/integraciones/mercadolibre.md` verificada leyendo la doc oficial con el navegador (WebFetch y curl dan 403; la API exige token también para leer categorías) |
| 2026-10-06 | Respuestas del operador: `dry-run` valida contra Mercado Libre sin publicar (D2), el WhatsApp del corredor de pruebas (D5) y la demo con su cuenta real y un paquete pagado (D6) |
| 2026-10-06 | Revisión del `arquitecto`: el input lleva el aviso y el contacto, y la publicación fija la versión del aviso (`listing_source_hash`, §4.6); `validate` sigue pura y lo que necesita el catálogo va en `publish` y en `preflight` (ADR-0016 aparte); `token_expires_at` de Mercado Libre es el horizonte del `refresh_token` y el del `access_token` va en `meta`, con política de refresco por plataforma; candado de credenciales con `FOR NO KEY UPDATE`, `lock_timeout` y nunca anidado con el del aviso, y topes de 10 s en la API; el sync no deshace lo del operador; `PUBLISH_MODE_MISMATCH` en las operaciones; `seller_contact` guardado en el progreso; nunca repetir `POST /items`; 508/509 y el límite de fotos; tabla de campos en core; sin `ML_SITE_ID`, sin `portal catalog`; `state` con la plataforma y ruta propia para conectar; URI en el puerto 443; `ml:smoke` partido (T10 y T23) y declarado como que escribe en la base; T04, T06, T11 y T16 partidas; tarea nueva de core (T16); 24 tareas |
| 2026-10-06 | Spec **aprobado** (aprobación permanente del operador). ADR-0015 y ADR-0016 aceptados; seguimientos en ADR-0005 y ADR-0014; `03-plataformas.md`, `06-roadmap.md`, `07-checklist-cuentas.md` y `docs/ESTADO.md` al día |
| 2026-10-06 | Desde F4-T01: `remoteStateSchema` acepta fechas con zona horaria (`stop_time` de Mercado Libre) y un `reason` opcional; `checkRemoteState` (`PUBLICATION_REMOTE_STATE_INVALID`); `syncPayloadSchema` = `{ remote }` (el cambio de estado va en su propio `status_changed`); `setRemoteState(id, remoteState, event?)` guarda en cualquier estado; `NewPublication.listingSourceHash` es opcional hasta T16; `portalSellerContactSchema` con el WhatsApp solo en dígitos; la llave de `platform_catalog` acepta `=` (ids de ubicación en base64) y `data` es JSON |
| 2026-10-06 | Revisión de F4-T01 (#76, `revisor` y `arquitecto`): sin `reason` en `remoteStateSchema` hasta que T17 tenga su fuente; el publisher devuelve `RemoteStatus` (sin `checkedAt`, que pone core); `setRemoteState` solo con eventos `sync`; `listingSourceHash` vacío queda en `null`, pasa a obligatorio en T16, y `buildPublishInput` trata un `null` de Portal como `PUBLICATION_LISTING_CHANGED`; `ListingRepository.getSourceHash` en T13; el sync compara `updatedAt` por igualdad con el leído antes (dos valores de la base, nunca el reloj del worker); T06 y T07 exigen `refreshToken` y T07 lee el vencimiento del `access_token` aparte; `tokenExpiryEstimated` siempre `true` en Mercado Libre; la llave del catálogo solo exige `tipo:id`; T08 conserva el par completo al refrescar |
| 2026-10-06 | Desde F4-T02: un `ML_SITE_ID` que quede en `.env` se ignora si dice `MLC` (el valor que traía `.env.example`) y es un error de `.env` con cualquier otro sitio (se publicaría igual en Chile); `doctor` revisa el par (`ML_APP_ID` y `ML_CLIENT_SECRET`, advertencia) y muestra la dirección de retorno, que siempre tiene valor; el redactor oculta `APP_USR-…` y `TG-…` también fuera de un parámetro o una clave sensible |
| 2026-10-06 | Revisión de F4-T02 (#77, `revisor` y `arquitecto`): `ML_REDIRECT_URI` sin usuario, clave ni fragmento; el redactor oculta `TG-…` sin mirar qué viene antes (también codificado: `%3D`, `\n`); **sin el par de la app** no se conecta ni se refresca (Mercado Libre lo exige también para refrescar): `MERCADOLIBRE_NOT_CONFIGURED` en T06, y T07 y T08 no llaman ni cambian la cuenta; `invalid_client` y `unauthorized_client` son `ML_APP_CREDENTIALS_INVALID` (T03), que no deja la cuenta `expired`; `doctor` lo dice en su advertencia |
| 2026-10-06 | Desde F4-T03: `MercadoLibreAuth` devuelve el vencimiento del `access_token` (`accessTokenExpiresAt`), los permisos y el `user_id`; en el canje `refreshToken` es `null` si no vino (T06 lo explica con los permisos) y en el refresco es obligatorio; `/users/me` devuelve `userId`, `nickname`, `siteId`, `userType` y `tags`. Errores nuevos en la tabla: `ML_REQUEST_REJECTED` (otro 4xx) y `ML_ABORTED` (la señal); `ML_NO_QUOTA` espera el código real (T10, T23). Un 401 es `ML_AUTH_INVALID` con `httpStatus: 401`, para que quien llama refresque una vez. Las causas de un rechazo se guardan solo con `code`, `cause_id` y `type` (nunca el `message` de Mercado Libre) |
| 2026-10-06 | Revisión de F4-T03 (#78, `revisor` y `arquitecto`): el refresco tiene un tope de 10 s y solo exige el par (§4.3); qué errores dejan la cuenta `expired` (§4.3 y seguimiento de ADR-0015) y `isMercadoLibreTokenRejected` en core para el primer 401; `invalid_operator_user_id` → `ML_PERMISSION_DENIED`; 408 y 425 → `ML_UNAVAILABLE`; sin seguir redirecciones; del cuerpo no se guarda nada con forma de token y como máximo 20 causas; T04 extiende la base (JSON, `multipart`, `classify`); T06 compara el `user_id` del canje con el de `/users/me` |
| 2026-10-07 | Desde F4-T04 (doc re-leída con el navegador): la búsqueda por `seller_custom_field` es `GET /users/{id}/items/search?sku=<valor>` (solo ids; sin filtro de estado, y si trae los cerrados queda NO VERIFICADO); 508 y 509 son `cause_id` de un 400 y no status; el límite de la subida de fotos es un 400 sin código documentado, que se trata como `ML_RATE_LIMITED` si no trae causas que bloqueen; la respuesta de un ítem puede traer advertencias (`warnings` o `cause[]` con `type: warning`, INFERENCIA) que se devuelven sin bloquear; errores nuevos `ML_ID_INVALID` y `ML_STATUS_NOT_ALLOWED`; `/items?ids=` se depreca en favor de `/items/bulk` (no se usa en F4) |
| 2026-10-07 | Revisión de F4-T04 (#79, `revisor` y `arquitecto`): el límite de la subida de fotos se reconoce solo con `error` vacío o `bad_request` y sin causas que bloqueen, y una foto vacía o de otro tipo no se sube (`ML_PICTURE_INVALID`); `itemCreationOutcome` (4xx salvo 408/425 o pedido no enviado → no se creó; lo demás → no se sabe) y `hasMercadoLibreCause` para T14; `getDescription` para no repetir el `POST` de la descripción al retomar (§4.8 paso 3); `pictureIds` se guardan por foto; la búsqueda sin filtro de estado queda NO VERIFICADA y la revisa T10; con más de un resultado, `ML_PUBLISH_OUTCOME_UNKNOWN`; el motivo de una pausa por moderación lo lee T15; el cliente valida las fechas (ISO con zona), conserva advertencias sin `type`, rechaza la respuesta de otro ítem y un cuerpo que no se puede armar (`ML_BODY_INVALID`); un `cause_id` solo manda sobre un código desconocido en 508 y 509 |
| 2026-10-07 | Desde F4-T05: el cliente del catálogo devuelve formas propias (`MercadoLibreCategory` con `childrenCategories` y los `settings` que usa el mapeo; `MercadoLibreAttribute` con `required`, `conditionalRequired`, valores y unidades; `MercadoLibreLocation` con `children`), sin inventar límites (lo que no se entiende queda `null` o vacío) y rechazando la respuesta de otro id; `validate` devuelve el rechazo del aviso como resultado (`valid: false`, causas, advertencias y motivos en español) y lanza los demás errores (token, permiso, red, 5xx, un 400 sin causas que bloqueen) |
| 2026-10-07 | Revisión de F4-T05 (#80, `revisor` y `arquitecto`): el cliente del catálogo es estricto donde importa (las hijas de una categoría, los estados de un país y las ciudades de un estado tienen que venir y entenderse; los atributos también, con `tags` como objeto de booleanos y una lista no vacía) y tolerante en los `settings` (`null` sin inventar); `currencies: null` (sin dato) distinto de `[]`; los atributos guardan sus `tags` en `true` para que T11 no exija ni envíe los que completa la categoría; una hoja es `listingAllowed === true`; el país solo acepta `[A-Z]{2}` y la categoría, `MLC…`; `validate` solo toma como rechazo un 400 o 422, no declara válido un 2xx con causas de error, y devuelve `issues` con código y motivo (forma de `PublishIssue`); el catálogo guarda la forma normalizada (doc 02) y sus esquemas pasan a core en T09; un rechazo de `preflight` es `PUBLISH_INPUT_INVALID` y las advertencias, `notes` (T13) |
| 2026-10-07 | Desde F4-T06: la plataforma de la cuenta es `portal_inmobiliario` (el enum de F0; las rutas siguen diciendo `mercadolibre`); el `state` de Mercado Libre lleva `platform: "mercadolibre"` y el de Instagram, desde ahora, `platform: "instagram"` (cada vuelta rechaza el de la otra); `GET /accounts` suma `connect.mercadolibre` (`configured` y `redirectUri`, solo `https`); `accountView` lee la `meta` de Mercado Libre (`userType` como tipo de cuenta y `scopes` como permisos), que T08 tenía pendiente, porque sin eso la cuenta recién conectada saldría vacía en el panel; `MERCADOLIBRE_NOT_CONFIGURED` y `ML_APP_CREDENTIALS_INVALID` son 503, y los `ML_*` de datos del servidor, 500 |
| 2026-10-07 | Revisión de F4-T06 (#81, `revisor` y `arquitecto`): `display_name` de Mercado Libre es el `nickname` tal cual (sin `@`; §4.12 y la demo decían `@nickname`); el `state` de Mercado Libre vale sus 10 min y **no es de un solo uso** (el de Instagram se amarra a una cookie; el código de Mercado Libre sí se canjea una vez): con la vuelta automática de F7 se amarra a una cookie o a un nonce de un solo uso (deuda en ESTADO); una sola función verifica el `state` de las dos plataformas (`verifyOAuthState`, con el nombre del proveedor del OAuth, no el del enum); al conectar, `ML_AUTH_INVALID` pide el enlace de nuevo y `ML_REQUEST_REJECTED` sugiere revisar `ML_REDIRECT_URI`; `MERCADOLIBRE_REFRESH_TOKEN_DAYS` pasa a `platform-account.ts` para T08, que precisa qué guarda el refresco; tras un rechazo al conectar (permisos o sitio) la autorización queda dada en Mercado Libre aunque AgentSales no guarde nada: el operador puede quitarla desde su cuenta |
| 2026-10-07 | Desde F4-T07: `withCredentialsLock(id, fn)` entrega `{ account, credentials, save }` releídos con la fila bloqueada, exige la cuenta `connected` y fija el tope con `SET LOCAL lock_timeout`; el tope vencido (`55P03`) es `ACCOUNT_LOCK_TIMEOUT`, reintentable (su HTTP lo fija T08 con el refresco a pedido). `ensureAccessToken(deps, accountId, { force?, signal? })` solo es de Portal (`ACCOUNT_REFRESH_UNSUPPORTED` en otra plataforma); recibe `mercadoLibre: null` si falta el par de la app; con `force`, refresca solo si el token guardado sigue siendo el que tenía quien llama (así dos `force` a la vez refrescan una vez); credenciales ilegibles o sin `refreshToken` dejan la cuenta en `error`, y un refresco que responde por otro `user_id`, también (`ML_UNEXPECTED_RESPONSE`); el refresco guarda el par, `tokenRefreshedAt`, `accessTokenExpiresAt` y `token_expires_at` = ahora + 180 días, y conserva `tokenExpiryEstimated: true` |
| 2026-10-07 | Revisión de F4-T07 (#82, `revisor` y `arquitecto`): `force` de `ensureAccessToken` pasa a ser `rejectedToken` (el token que recibió el 401): se refresca solo si el guardado sigue siendo ese, también si el rechazo llega después de que otro refrescó; el núcleo `refreshMercadoLibreToken(deps, id, { shouldRefresh, signal })` queda aparte para T08 (resultado `refreshed` o `kept`); `expired` y `error` se marcan **dentro** del candado (`LockedCredentials.markProblem`), así quien esperaba ya no llama a Mercado Libre y una reconexión que esperaba la fila no queda vencida; `LockedRepositories.platformAccounts` no expone `withCredentialsLock` (nunca se anida con el `ListingLock`); `onWarning` (`ACCOUNT_STATUS_NOT_SAVED`); el riesgo aceptado suma el guardado o el `COMMIT` que fallan y la respuesta perdida por el tope; T08 fija el HTTP de `ACCOUNT_LOCK_TIMEOUT` (503), T09 recibe un proveedor de token, T13 arma `accessToken` con `rejectedToken` y T19 revisa el presupuesto de tiempo |
| 2026-10-07 | Desde F4-T08: la política de refresco vive en `refreshAccountToken` (core), con `refreshInstagram` (sin cambios) y `refreshMercadoLibre`; sin `force`, Mercado Libre usa `not_due` (lo salta `force`) con `refreshableAt` a los 7 días (`MERCADOLIBRE_REFRESH_AGE_MS`), y la misma regla a pedido sin `--force`; un rechazo al refrescar (`ML_AUTH_INVALID`) es un resultado, `200` con `outcome: "expired"` y `token_rejected` (como el 190 de Instagram), así que `ML_AUTH_INVALID` sigue siendo 400 solo al conectar; `token_expires_at` de Mercado Libre (estimado) no deja la cuenta `expired` sin preguntar; sin el par de la app, el lote deja esas cuentas en `failed` (`MERCADOLIBRE_NOT_CONFIGURED`, no reintentable) sin cambiarlas y el worker lo avisa; `CREDENTIALS_INVALID` es 500 en la API (credenciales guardadas que no sirven, como `CREDENTIALS_UNREADABLE`); la CLI (`accounts refresh`) dice la plataforma y los 7 días |
| 2026-10-07 | Revisión de F4-T08 (#83, `revisor` y `arquitecto`): la señal ya no corta un refresco de Mercado Libre enviado (perdería el par ya rotado): con la señal disparada antes de llamar, `ML_ABORTED` sin llamar ni cambiar la cuenta; una vez enviado, lo acota el tope de 10 s (también en `ensureAccessToken`); la regla de 7 días es "7 días o más" (§4.3); una fecha de refresco futura espera como mucho 7 días desde ahora; la política se elige con un `switch` exhaustivo por plataforma; prueba del candado ocupado en el lote (`TOKENS_REFRESH_INCOMPLETE`); seguimiento de T08 en ADR-0015; la guía del operador avisa que la cuenta de Mercado Libre muere con 4 meses sin abrir el worker |
| 2026-10-07 | Desde F4-T09: el puerto `PortalCatalog` y `createPortalCatalog` quedan en `publishers/mercadolibre/catalog.ts` (ningún caso de uso de core lo usa; seguimiento de ADR-0015); en core quedan las formas (`portal/catalog.ts`: esquemas, normalización, alias, TTL y raíces), `PlatformCatalogRepository` y `accessTokenProvider`; cada llamada recibe `{ accessToken, signal }`; `leafCategory(path)` baja por los nombres y exige `listingAllowed === true` (`PORTAL_CATEGORY_NOT_FOUND` con `reason`: `missing`, `ambiguous`, `not_leaf`, `empty`); `location({ region, commune })` busca la comuna entre las ciudades del estado y un barrio solo por alias (`PORTAL_LOCATION_NOT_FOUND` con el nivel); la copia vencida solo con un error reintentable que no sea un corte pedido (`PORTAL_CATALOG_STALE`), y si guardar falla se usa lo bajado (`PORTAL_CATALOG_NOT_SAVED`); después de un 401 se pide otro token una vez, y marcar la cuenta `expired` tras el segundo le toca a quien arma el proveedor (T13); los alias de regiones y comunas se completan con `ml:smoke` (T10); `PLATFORM_CATALOG_ROW_INVALID` (500) |
| 2026-10-07 | Revisión de F4-T09 (#84, `revisor` y `arquitecto`): `PlatformContext.accessToken` es el mismo `AccessTokenProvider` del catálogo, sin estado (`rejectedToken`; §4.8, T13 y T14); el 401 que se repite tras refrescar sube marcado (`details.reason: "rejected_after_refresh"`) y `isMercadoLibreTokenRejected` ya no lo reconoce, así nadie más arriba vuelve a refrescar; lo deja `expired` el caso de uso que lo recibe (criterios en T16 y T17; `ml:smoke` no la marca, T10); T10 completa `PORTAL_LOCATION_ALIASES` y verifica que Chile no exige `neighborhood`; `MLC1459` y `CL` pasan a las constantes de publishers (`MERCADOLIBRE_REAL_ESTATE_CATEGORY_ID`, `MERCADOLIBRE_COUNTRY_ID`); una fecha de bajada futura cuenta como vencida; los alias solo con llaves propias de la tabla; "7 días o más" (§4.4 y doc 02); §4.1 y §4.4 ponen el puerto en publishers |
