# Spec F5 · Facebook Marketplace

- **Estado:** **En curso** (lote A desde el 2026-10-09). Aprobado el 2026-10-09 (aprobación permanente del operador; D2, D8, D9 y D10 las respondió él)
- **Rama base:** `main`
- **Tag al cerrar:** `v0.5.0`
- **Referencias:** `docs/06-roadmap.md#f5--marketplace`, ADR-0004, ADR-0005, ADR-0011, ADR-0014, ADR-0015, ADR-0016 y ADR-0017 (nuevo), `docs/01-arquitectura.md`, `docs/02-modelo-datos.md`, `docs/03-plataformas.md`, `docs/04-formato-publicaciones.md`, `docs/integraciones/fb-marketplace.md` (consultada el 2026-10-09 sin sesión, desde EE. UU.: el formulario de propiedades solo se ve con la sesión del operador) y `docs/integraciones/uf.md` (valor de la UF, 2026-10-09)

## 1. Objetivo
El operador deja que AgentSales abra Facebook con su perfil, llene el formulario de una propiedad aprobada y suba sus fotos. Después revisa la ventana y hace él los clics de **Siguiente** y **Publicar**. AgentSales reconoce el aviso recién publicado o recibe el enlace que pega el operador, lo guarda y lo sigue hasta que se marca como retirado. Ante un captcha, una verificación o cualquier pantalla inesperada, AgentSales se detiene y avisa.

## 2. Alcance
- **Perfil de navegador por corredor** (ADR-0004, ADR-0017): carpeta fuera del repo, inicio de sesión a mano, sin guardar contraseñas ni códigos.
- **Conectar la cuenta:** `accounts connect marketplace --broker <slug>` abre la ventana, espera a que el operador inicie sesión y registra la cuenta (sin credenciales en la base).
- **`pnpm fb:smoke`** (lo corre el operador): revisa la sesión y guarda la captura y el árbol de accesibilidad del formulario, **sin llenar nada**; con `--listing` llena el formulario de un aviso real y se detiene. Es la forma de conocer el formulario real, que la nota no puede ver sin sesión.
- **Del aviso al formulario:** tabla de campos en core, `marketplaceReadiness` (lo que falta, antes de enviar, sin inventar datos) y la **UF convertida a pesos** con el valor oficial del día (D9).
- **Publisher de Marketplace** (`packages/publishers/src/marketplace/`): abre el perfil, revisa que la página sea la esperada (lista blanca), elige tipo y operación, llena los campos, sube las fotos, guarda evidencia y deja la ventana abierta.
- **Publicar en dos tiempos** (ADR-0017): `publishing` → `awaiting_manual_confirm` → `published`, con el enlace detectado en la ventana o pegado por el operador. "No lo publiqué" la deja en `failed` para reintentar o descartar.
- **Salvaguardas:** límite diario por cuenta (3), un formulario a la vez por cuenta, pausas entre acciones, detención ante cualquier pantalla fuera de la lista blanca, captura ante error y tope de espera.
- **Plan B en el panel** (ADR-0004): copiar el título y la descripción y abrir las fotos, para publicar a mano si el formulario cambia.
- API, CLI y panel para todo lo anterior. Retirar es "Marcar como retirada" (F3), después de borrar o marcar vendido a mano en Facebook.

## 3. Fuera de alcance
- **Hacer clic en Siguiente o Publicar** (D3), resolver o evadir captchas o verificaciones, o disfrazar la automatización: sin plugins "stealth" y sin cambiar la huella ni el user agent del navegador (D6).
- **Leer el estado de los avisos con el navegador** (sincronizar, "Necesita atención", vendidos): las Condiciones de Meta prohíben recolectar datos por medios automatizados (nota §9). Solo se lee la dirección de la pestaña del formulario, para reconocer el aviso recién publicado (D5).
- Editar, renovar, marcar vendido o pendiente, ocultar o borrar desde AgentSales: se hace a mano en Facebook (F6 evalúa recordatorios).
- Publicar en grupos u otros lugares que ofrezca la pantalla de Siguiente: lo decide el operador en la ventana.
- Video en Marketplace (solo fotos, `04-formato`).
- Marketplace en el calendario automático: según ADR-0004, solo como recordatorio (F6).
- Que cada corredor use AgentSales en su propio equipo con su perfil: F7 (D2).
- Volver a `published` una publicación marcada "No lo publiqué" (D14).

## 4. Diseño

### 4.1 Componentes
| Componente | Cambio |
|---|---|
| `packages/core` | `marketplaceAccountMetaSchema` y `marketplaceProgressSchema` (en `PUBLICATION_PROGRESS_SCHEMAS`); cuenta conectada sin credenciales (solo Marketplace); `Publisher.manualConfirm`, la variante `handoff` de `PublishResult`, `PublishContext.credentials` opcional y el resultado `awaiting_manual_confirm` en `PUBLISH_ATTEMPT_RESULTS`; `withDryRun` que copia `manualConfirm` y simula la espera; `publishPublication` con la conversión de la UF, el progreso del intento, la salida `awaiting_manual_confirm`, el límite diario y "un formulario a la vez"; casos de uso `connectMarketplaceAccount`, `confirmManualPublication` y `markNotPublished`; descartar, quitar la aprobación y desconectar bloqueados mientras se espera la confirmación (`MANUAL_CONFIRM_PENDING`); `marketplace/fields.ts`, `marketplaceReadiness` y `ufToClp` (aritmética entera, sin flotantes); puerto `UfValueSource`; `parseMarketplaceItemUrl`; dobles en `@agentsales/core/testing` |
| `packages/config` | `BROWSER_PROFILES_DIR` por defecto `~/.agentsales/browser-profiles` (`loadEnv` exige una ruta absoluta o con `~/`; `resolveBrowserProfilesDir`, el único camino para obtenerla, rechaza una dentro del workspace); `MARKETPLACE_CONFIRM_TIMEOUT_MIN` (30); `BCCH_API_TOKEN` (opcional: el token de la API BDE del Banco Central para la UF) |
| `packages/db` | `upsertConnected` sin credenciales solo en Marketplace; `PublicationRepository.updateProgress` condicional (en `awaiting_manual_confirm` y del mismo intento); `countLiveAttemptsSince` para el límite. **Sin migración** |
| `packages/publishers` | `marketplace/` (subruta `@agentsales/publishers/marketplace`, que solo importa el worker: la API no carga Playwright): perfil con candado, guardas de lista blanca, `selectors.ts` (el único módulo con textos y roles), llenado, evidencia, el publisher y el **manejador de la ventana** (`MarketplaceWindow`: vigilar la dirección, cerrar); `uf/` (subruta `@agentsales/publishers/uf`): el adaptador de la API BDE del Banco Central. `playwright` 1.63.0 (misma versión que `packages/media`) |
| `apps/worker` | Publisher de Marketplace registrado (desde T05, el esqueleto que permite simular); registro de ventanas abiertas (una por cuenta) que llama a core; job `marketplace.profile` (iniciar sesión y olvidar el perfil); barrido al arrancar y cierre al apagarse; limpieza de la evidencia; `pnpm fb:smoke` y `pnpm uf:smoke` |
| `apps/api` | `POST /accounts/marketplace/login`; `POST /publications/:id/confirm` y `/not-published`; `marketplaceReadiness` en la vista del contenido; la vista de la cuenta y de la publicación con lo de Marketplace; errores nuevos. No importa Playwright |
| `apps/cli` | `accounts connect marketplace`; `publish --platform marketplace` (espera el formulario listo y la confirmación); `publications confirm <id> --url-stdin` y `publications not-published <id>`; `approve --platform marketplace` con lo que falta |
| `apps/web` | Cuentas con Marketplace (iniciar sesión, desconectar); pestaña Marketplace con lo que falta, aprobar, publicar, "Formulario listo", pegar el enlace, "No lo publiqué", enlace del aviso, Marcar como retirada y el plan B |

### 4.2 Perfil y conexión de la cuenta (ADR-0017)
- **Perfil:** `BROWSER_PROFILES_DIR/<broker_id>/fb_marketplace`, con permisos `0700`. Por defecto `~/.agentsales/browser-profiles`; `loadEnv` exige una ruta absoluta o con `~/` y `resolveBrowserProfilesDir` rechaza una dentro del workspace, sin distinguir mayúsculas en macOS (así no lo ve git ni una herramienta que lea el proyecto; cierra la deuda de `BROWSER_PROFILES_DIR`, y `.env.example` se actualiza). Contiene las cookies de la sesión: **es un secreto**. Nunca va a git, R2, logs ni errores, y Claude no lo lee.
- **Navegador:** el Chromium que trae Playwright (ya instalado para el render de F2), con ventana visible, idioma `es-CL` y zona `America/Santiago`: son la configuración del contexto (que el formulario salga en español de Chile y las fechas en hora local), no un disfraz; no se cambia el user agent ni la huella. Nunca el perfil del Chrome del operador (D7).
- **Candado por perfil:** un proceso a la vez (Chromium no admite dos con la misma carpeta). Si está tomado, `MARKETPLACE_PROFILE_BUSY` sin abrir nada.
- **Conectar:** `accounts connect marketplace --broker <slug>` → `POST /accounts/marketplace/login { broker, label? }` encola `marketplace.profile { brokerId, action: "login", label?, requestedAt }` (202). El worker abre la ventana en `https://www.facebook.com/` y espera hasta 10 min a que haya sesión: la cookie `c_user` (el id numérico de la cuenta; es el único dato que se lee de las cookies, nunca se guarda otra) **y** una página de Facebook que no sea de inicio de sesión ni de verificación (lista blanca de §4.4). Que `c_user` sea el id y cuándo aparece (¿antes de terminar la verificación de dos pasos?) es NO VERIFICADO: lo confirma `fb:smoke`, y por eso se exigen las dos condiciones. El operador inicia sesión a mano, también su 2FA o una verificación pendiente: la ventana de conectar no automatiza nada, así que es el lugar para resolverlas. Con la sesión, `connectMarketplaceAccount` guarda la cuenta y la ventana se cierra.
  - La CLI espera mirando `GET /accounts` hasta que `meta.sessionCheckedAt` sea posterior a su pedido; si el login falla (tope o perfil tomado) y la cuenta existe, el worker guarda el motivo en `meta.lastLoginError` y la CLI lo muestra.
  - Si ya había sesión, conecta sin pedir nada.
  - Si había una ventana de publicar abierta en ese perfil, el login espera su turno (`MARKETPLACE_PROFILE_BUSY` si no se libera en 30 s).
  - **No mira `PUBLISH_MODE`** (excepción explícita, ADR-0017 punto 7): abre Facebook también en `dry-run`, porque no publica ni llena nada; lo pide siempre el operador.
- **Guardado:** `external_account_id` = el id de `c_user`; `display_name` = `label` o "Facebook de <corredor>"; `credentials_encrypted = null`; `token_expires_at = null`; `meta` (`marketplaceAccountMetaSchema`): `userId`, `connectedAt`, `sessionCheckedAt`, `lastLoginError?`. Una sola cuenta conectada por corredor (`revokeOthers`).
- **Sesión perdida:** si al publicar la página pide iniciar sesión, la publicación queda `failed` con `MARKETPLACE_SESSION_EXPIRED`, que se suma a los rechazos de acceso de `platform-auth.ts`: la cuenta pasa a `expired` y se reconecta con el mismo comando.
- **Desconectar** (`POST /accounts/:id/disconnect { confirmed: true }`): `disconnectAccount` cambia solo la base (`revoked`) y, en Marketplace, encola después `marketplace.profile { brokerId, action: "forget" }`: el worker cierra las ventanas de esa cuenta y borra la carpeta (idempotente, y solo dentro de `BROWSER_PROFILES_DIR`). Login y olvido van por la misma cola, exclusiva por corredor, así que un borrado nunca pisa un login posterior. Con una publicación de la cuenta en `awaiting_manual_confirm`, 409 `MANUAL_CONFIRM_PENDING` (caso de uso, T04). La sesión en los servidores de Facebook no se cierra: la guía lo explica.
- `tokens.refresh` y `POST /accounts/:id/refresh` siguen respondiendo `ACCOUNT_REFRESH_UNSUPPORTED` para Marketplace.

### 4.3 Publicar en dos tiempos (ADR-0017)
- **Contrato:**
  - `Publisher` suma `readonly manualConfirm?: true`. `withDryRun` copia la bandera.
  - `PublishResult` suma la variante `{ handoff: "manual_confirm"; simulated: boolean; notes?: string[] }`, sin datos: lo que se guarda lo arma core. Un publisher con `manualConfirm` nunca devuelve "publicado", y uno sin él nunca devuelve `handoff` (si pasa, `INTERNAL_ERROR`).
  - `PublishInput` de Marketplace suma `priceClp` (y `uf: { value, date } | null`), que calcula core (§4.6): el publisher no consulta la UF.
  - `PublishContext.credentials` pasa a opcional: el intento de Marketplace no llama a `getCredentials`.
- **El intento** (`publishPublication`):
  1. Para Marketplace, antes de llamar al publisher: revisa el límite diario y "un formulario a la vez" (§4.7; como el worker toma un `publication.publish` a la vez, ahí no hay carrera) y, si el aviso está en UF, pide el valor del día a `UfValueSource` y calcula `priceClp` (§4.6). Esto corre también en `dry-run`: es una lectura del Banco Central, no de Facebook, y así la simulación muestra el precio en pesos.
  2. Con `handoff`, transición `publishing` → `awaiting_manual_confirm` con `changes.progress` = el progreso de este intento, armado por core (`marketplaceProgressSchema`: `attempt` = `publications.attempts`, `simulated`, `formReadyAt` = ahora, `photos` = las fotos del input, `priceClp` y, si se convirtió, `ufValue` y `ufDate`). Así un `windowClosedAt` de un intento anterior nunca se arrastra.
  3. Deja el `publish_attempt` con el resultado nuevo `awaiting_manual_confirm` (se suma a `PUBLISH_ATTEMPT_RESULTS`) y devuelve la salida `{ outcome: "awaiting_manual_confirm" }`; el job la registra como "formulario listo" (no como publicada).
  4. Si esa transición falla, relanza `PUBLISH_RESULT_NOT_SAVED` (reintentable, como hoy) y el worker cierra la ventana pendiente. El reintento de la cola abre un formulario nuevo (no se publicó nada) y cuenta en el límite como cualquier intento (§4.7).
- **La ventana pasa al worker** sin viajar por core: el publisher recibe del worker un `onHandoff(publicationId, window)` al crearse. La deja "pendiente" en el registro; el worker la activa (empieza a vigilar) solo cuando `publishPublication` devolvió `awaiting_manual_confirm`, y la cierra en cualquier otra salida.
- **`withDryRun`:** con `manualConfirm`, corre `checkPublishInput` y devuelve `{ handoff: "manual_confirm", simulated: true, notes: ["Simulación: no se abrió Facebook"] }`. **Nunca abre el navegador** (D4); Marketplace no declara `preflight`.
- **Confirmar** (`confirmManualPublication`, `POST /publications/:id/confirm { url? }`): `awaiting_manual_confirm` → `published`, dentro del candado del aviso, condicional.
  - En `live`, `url` es obligatoria y pasa por `parseMarketplaceItemUrl`: `https://www.facebook.com/marketplace/item/<dígitos>` (acepta `m.` y `web.`, con o sin `/` final, sin consulta); `external_id` = el número y `external_url` = la forma limpia. Otra cosa: `MARKETPLACE_URL_INVALID` (400).
  - En `dry-run`, una URL se ignora: `external_id = dry-run:<id>`, `external_url = null`.
  - Ya `published` con la misma URL: 200 sin cambios; con otra: 409 `PUBLICATION_ALREADY_CONFIRMED`. Cualquier otro estado: `INVALID_TRANSITION` (el registro del worker lo ignora).
  - En `live` pasa el aviso de `ready` a `active` (como el intento). Actor: el operador, o `system` si lo detectó el worker.
- **No lo publiqué** (`markNotPublished`, `POST /publications/:id/not-published`): `awaiting_manual_confirm` → `failed` con `MARKETPLACE_NOT_PUBLISHED` ("no se publicó: reintenta para abrir el formulario de nuevo o descártala"). Reintentar (`POST /publications/:id/publish`) y Descartar (`/cancel`) son los de F3. La ventana, si sigue abierta, la cierra el registro del worker al ver que la publicación ya no espera (§4.5).
- **El sistema nunca da por publicado ni por no publicado lo que no vio (D11):** si la ventana se cierra o vence el tope sin ver el aviso, la publicación **sigue** en `awaiting_manual_confirm` y el panel pregunta "¿Lo publicaste?". Por lo mismo, en Marketplace **descartar, quitar la aprobación y desconectar** responden 409 `MANUAL_CONFIRM_PENDING` mientras haya una publicación esperando: primero se dice si salió o no. La máquina de estados sigue permitiendo `awaiting_manual_confirm → cancelled`, pero el caso de uso no lo deja (revisa lo que el spec de F3 dejó para F5).
- **Retirar:** "Marcar como retirada" de F3 (`published` → `unpublished`, en `live` con `removedByHand: true`; el texto dice "bórralo a mano en Facebook"). Pausar, reactivar, cerrar y sincronizar: `OPERATION_NOT_SUPPORTED`, como hoy.

### 4.4 El formulario (publisher de Marketplace)
- **Pasos** (`publish`, solo en `live`; tope de 5 min, la cola no espera el clic):
  1. Baja de R2 las fotos fijadas en la publicación (`pi_4x3`, las mismas de Portal) a `tmp/marketplace/<publicationId>/`. El precio en pesos ya viene en el input.
  2. Abre el perfil y va a la dirección del formulario (`MARKETPLACE_FORM_URL`, en `selectors.ts`; se supone `/marketplace/create/rental`, se confirma con `fb:smoke`). Si el perfil está tomado por la ventana de un intento anterior de la misma cuenta (por ejemplo, justo después de "No lo publiqué"), el registro del worker la cierra primero; si sigue tomado a los 30 s, `MARKETPLACE_PROFILE_BUSY`.
  3. **Lista blanca, antes de cada paso:** la dirección es la del formulario y el formulario está a la vista. Si no:
     - inicio de sesión → `MARKETPLACE_SESSION_EXPIRED`;
     - `/checkpoint/`, verificación de dos pasos, captcha o un texto de identidad o actividad inusual → `MARKETPLACE_VERIFICATION_REQUIRED`;
     - Marketplace no disponible o limitado → `MARKETPLACE_UNAVAILABLE`;
     - cualquier otra cosa, o un control que no aparece en su tope → `MARKETPLACE_FORM_CHANGED`.
  4. Elige operación y tipo de propiedad, y llena precio (en pesos), dormitorios, baños, superficie, ubicación, título y descripción con `marketplace/fields.ts`. Una pausa fija de 1 s entre controles: es ritmo, no imitación de una persona (sin variaciones al azar; D6).
  5. Sube las fotos con `setInputFiles` y espera a que se vean todas las miniaturas.
  6. Guarda la evidencia (captura y árbol de accesibilidad **solo del formulario**) en `tmp/marketplace/<publicationId>/`, entrega la ventana con `onHandoff` y devuelve `handoff`.
- **Ante cualquier error** (los `MARKETPLACE_*` y también uno de R2 o de la base): **cierra la ventana** y libera el perfil, y después lanza. La captura es **solo del formulario**: en una pantalla de inicio de sesión o de verificación no se captura nada (pueden mostrar el correo, el teléfono o el nombre del operador), solo se anota la ruta sin consulta. Las verificaciones y la sesión las resuelve el operador con `accounts connect marketplace`, que abre el perfil sin automatizar nada. Así un perfil nunca queda tomado por una ventana sin dueño, y nadie termina a mano un formulario que el sistema no vigila.
- **Sin reintentos automáticos** para los `MARKETPLACE_*`: no son reintentables y el operador reintenta. El robot nunca insiste ante una pantalla rara. R2 y la base siguen siendo reintentables.
- **Selectores:** solo en `selectors.ts`, por rol y nombre visible (`getByRole`, `getByLabel`), en español. Si el perfil está en otro idioma, `MARKETPLACE_FORM_CHANGED` lo dice. Se escriben con el árbol de accesibilidad que deja `fb:smoke` (T09).

### 4.5 La ventana abierta (worker)
- **`MarketplaceWindow`** (publishers, la única pieza que toca Playwright después del llenado): `watch({ onItemUrl, onClosed })` y `close()`.
  - **Reconocer el aviso:** solo vale la **primera** navegación de la misma pestaña del formulario desde `/marketplace/create/…` a `/marketplace/item/<id>` (lo que Facebook muestra después de Publicar: NO VERIFICADO). Cualquier otra dirección se ignora: si el operador abrió otro aviso, no se confunde. Si Facebook lleva a otro lado (por ejemplo, "Tus publicaciones"), no adivina: el operador pega el enlace.
  - **Cierre:** el operador cierra la ventana, o vence `MARKETPLACE_CONFIRM_TIMEOUT_MIN` (30 min) y la ventana se cierra.
- **Registro del worker** (`apps/worker/src/marketplace/windows.ts`, una ventana por cuenta):
  - con `onItemUrl`, llama a `confirmManualPublication` (actor `system`) y cierra la ventana;
  - con `onClosed`, anota `windowClosedAt` en el progreso (`updateProgress`, condicional en `awaiting_manual_confirm` y en `publications.attempts` igual al `attempt` de la ventana), sin cambiar el estado (D11);
  - cada 5 s relee la publicación: si ya no está en `awaiting_manual_confirm` (el operador pegó el enlace, marcó "No lo publiqué" o la confirmó otro proceso), cierra la ventana. Esto reemplaza un job de "cerrar ventana".
- **Apagado:** cierra las ventanas y anota `windowClosedAt` **antes** de cerrar la base. **Al arrancar:** anota `windowClosedAt` en las `awaiting_manual_confirm` que no lo tengan (sus ventanas ya no existen).
- **Limpieza:** la evidencia de `tmp/marketplace/` se borra a los 7 días, como `cleanContentTmp`.
- **Qué se lee de Facebook (D5):** antes de entregar la ventana, la lista blanca mira la dirección y los textos de la página solo para decidir si detenerse, y el árbol del formulario para la evidencia; después de entregarla, solo la dirección de la pestaña. Nunca listas de avisos, mensajes ni estados.

### 4.6 Del aviso al formulario
- **`marketplace/fields.ts`** (core): traduce `tipo` y `operacion` a las opciones del formulario y nombra qué campo del aviso va a cada control. Las opciones exactas salen del árbol de `fb:smoke` (T09), nunca supuestas.
  | AgentSales | Formulario (por confirmar con `fb:smoke`) | Nota |
  |---|---|---|
  | `operacion` | Venta o arriendo | Si Chile no tiene venta, un aviso en venta no va a Marketplace (`MARKETPLACE_OPERATION_UNSUPPORTED`) |
  | `tipo` | Tipo de propiedad | Sin opción: `MARKETPLACE_TYPE_UNSUPPORTED` |
  | `precio` + `moneda` | Precio en CLP (en arriendo, por mes) | `CLP`: tal cual. `UF`: convertido con el valor del día (D9) |
  | `dormitorios`, `banos` | Dormitorios, baños | Números |
  | `sup_util_m2` | Metros cuadrados | Si el formulario lo pide |
  | `region`, `comuna`, `direccion` | Ubicación | Comuna y región; la dirección solo con `show_exact_address = true` |
  | `contents.title`, `contents.body` | Título y descripción | El texto de Marketplace aprobado (F2), sin cambios |
  | fotos `pi_4x3` | Fotos | Hasta el máximo del formulario (por confirmar) |
- **UF a pesos (D9):** `priceClp = ufToClp(precioUf, valorUf)` (core) con aritmética entera (`BigInt` sobre centésimas, sin flotantes ni dependencias nuevas), redondeado al peso, con el valor oficial de la UF **del día de Santiago en que corre el intento** (la fecha la pone core con su reloj). La calcula `publishPublication` antes de llamar al publisher (§4.3), en los dos modos.
  - **Fuente** (`docs/integraciones/uf.md`): la API BDE del Banco Central (`GetSeries`, serie `F073.UFF.PRE.Z.D`, JSON), oficial y gratuita, con un token anual (`BCCH_API_TOKEN`) que pide el operador. Puerto `UfValueSource` en core: `valuesBetween(from, to, { signal }) → { date, value }[]`, con `value` como texto decimal; adaptador en `packages/publishers/src/uf/`.
  - El Banco Central publica cada valor por adelantado y no lo revisa, así que el adaptador guarda en memoria lo que ya leyó, por fecha (sin tabla nueva). No guarda los días sin dato (`NaN`/`ND`) ni los errores. Un valor de otra fecha nunca reemplaza al de hoy.
  - **Control de rango:** core pide ayer y hoy; si el valor de hoy se aleja más de 1 % del de ayer (la UF cambia mucho menos por día), `UF_VALUE_SUSPICIOUS` (no reintentable) y no se publica.
  - **El token va en la consulta** (`?token=`): el redactor ya lo oculta (`SENSITIVE_PARAM` y la clave `BCCH_API_TOKEN` en el logger; T07 lo prueba), la URL nunca va a logs ni errores, y los errores del adaptador no la llevan.
  - Sin token, un aviso en UF no puede ir a Marketplace: `marketplaceReadiness` lo dice (`UF_SOURCE_NOT_CONFIGURED`) y `doctor` avisa. Una falla de red o un 5xx: `UF_VALUE_UNAVAILABLE` (reintentable). La fuente responde pero no tiene el valor de hoy (por ejemplo, el día 10 antes de cargar el período): `UF_VALUE_MISSING` (no reintentable: el operador reintenta más tarde). Un token rechazado: `UF_SOURCE_AUTH_INVALID` (no reintentable). Nunca se usa un valor viejo ni uno escrito a mano. La forma de estos errores en la BDE es NO VERIFICADO: los tests con msw se ajustan después de `uf:smoke`.
  - El valor y la fecha quedan en el progreso y en la bitácora. El texto aprobado no cambia: sigue mostrando el precio en UF, como lo escribió F2.
  - `pnpm uf:smoke` (lo corre el operador una vez con su token): pide hoy y los próximos 31 días y confirma lo NO VERIFICADO de la nota (forma de `value`, fechas futuras, respuesta con token inválido).
- **`marketplaceReadiness(listing, broker, media, { ufConfigured })`** (core, pura; la app dice si hay token): fotos (al menos 1), operación y tipo con opción, precio (CLP, o UF con la fuente configurada), dormitorios y baños, comuna. La usan aprobar (como advertencia), la vista del contenido y publicar: `publishListing` **y** `startPublication` bloquean con `MARKETPLACE_NOT_READY` y la lista (`issues`, como `PORTAL_NOT_READY`) antes de `publishing`. `validate` del publisher sigue pura: plataforma, formato `post`, título de 1 a 60, de 1 a N fotos JPEG, que el input traiga el aviso y `priceClp`.
- **Texto:** el de F2 (`04-formato`), que termina con el WhatsApp del corredor. Si el formulario o la revisión de Facebook lo rechazan, una tarea chica lo cambia (§8). La regla de requisitos discriminatorios de `checkContent` suma "presencia de niños" (nota §9).
- **Lo aprobado no cambia:** Marketplace ya está en `PUBLISH_LISTING_PLATFORMS`: el aviso fijado (`listing_source_hash`) y `PUBLICATION_LISTING_CHANGED` de F4 aplican sin cambios.

### 4.7 Límite diario y un formulario a la vez
- **Límite** (`MARKETPLACE_DAILY_LIMIT`, 3 por cuenta y día de Santiago): cuentan los intentos en `live` de hoy de esa cuenta (eventos `publish_attempt`, que cada intento deja: también los reintentos de la misma publicación y los de la cola). El intento en curso todavía no dejó el suyo. Un intento que se detuvo ante una verificación también cargó la cuenta, así que cuenta; uno que falló antes de abrir el navegador (la UF caída, el perfil tomado) también cuenta: es más prudente y más simple. `dry-run` no cuenta. Lo que manda es la revisión del intento (§4.3); `publishListing` y `startPublication` la repiten como aviso temprano (409 `MARKETPLACE_DAILY_LIMIT`). En el intento, el error deja la publicación `failed` con el mismo código.
- **Un formulario a la vez por cuenta, en cualquier modo:** en `publishListing` y `startPublication`, si otra publicación de la cuenta está en `publishing` o `awaiting_manual_confirm`, 409 `MARKETPLACE_FORM_OPEN` ("termina o marca la anterior"). En el intento basta con mirar `awaiting_manual_confirm` (los `publishing` ya los serializa el worker); si hay una, `failed` con ese código.
- **Nunca el mismo aviso dos veces:** lo garantiza `planPublications` (una activa por aviso, cuenta y formato).

### 4.8 `pnpm fb:smoke` (lo corre el operador)
- `pnpm fb:smoke --broker <slug>`: abre el perfil con ventana (si no hay sesión, pide iniciarla a mano en la ventana y espera hasta 10 min), va al formulario y guarda en `tmp/fb-smoke/` la captura, el árbol de accesibilidad **del formulario**, la dirección final y, si aparecen, las opciones de operación y tipo. Anota además si existe la cookie `c_user` y si su valor es numérico (nunca el valor). **No llena nada** y no escribe en la base. Se detiene ante cualquier pantalla de §4.4, paso 3.
- **No mira `PUBLISH_MODE`** (excepción explícita, como `ig:smoke` y `ml:smoke`; ADR-0017 punto 7 y `CLAUDE.md`): lo corre solo el operador.
- Las opciones de un desplegable cerrado (operación, tipo) no salen en el árbol, y `fb:smoke` no hace clic. Si T09 las necesita, una segunda corrida con una pausa para que el operador abra el desplegable a mano antes de la captura.
- `--listing <id_propiedad>` (T10): llena el formulario con ese aviso y sus fotos (con el precio en pesos), como `publish`, y deja la ventana abierta hasta que el operador la cierre. Como sí escribe en Facebook (fotos y quizás un borrador), pide confirmación (`¿Llenar el formulario real de Facebook? s/N`, o `--yes`), dice cuántos intentos lleva la cuenta hoy y se niega si se llegó al límite. **Nunca hace clic en Siguiente ni Publicar** y no cambia estados ni deja eventos (por eso no suma al límite: lo corre el operador, una vez, a propósito). Al terminar, el operador revisa en "Tus publicaciones" si quedó un borrador y lo borra a mano.
- Los archivos de `tmp/fb-smoke/` pueden traer el nombre y la foto del operador: no se suben a git ni a R2. Claude lee solo el árbol del formulario, con el permiso del operador.

### 4.9 Datos
- **Sin migración.** `platform_accounts.credentials_encrypted` y `token_expires_at` ya permiten `null`; desde F5 una cuenta `connected` de Marketplace no tiene credenciales (ADR-0017).
- `meta` de Marketplace: `marketplaceAccountMetaSchema` (`userId`, `connectedAt`, `sessionCheckedAt`, `lastLoginError?`).
- `publications.progress` de Marketplace: `{ attempt, simulated, formReadyAt, photos, priceClp, ufValue?, ufDate?, windowClosedAt? }` (`marketplaceProgressSchema`), escrito por core en la transición a `awaiting_manual_confirm` y, después, solo con `updateProgress`.
- `PublicationRepository.updateProgress(id, { from: "awaiting_manual_confirm", attempts }, progress)` (nuevo, condicional: el `WHERE` exige el estado y el número de intento) y `countLiveAttemptsSince(accountId, since)` (lee los eventos `publish_attempt` en `live`).
- `PUBLISH_ATTEMPT_RESULTS` suma `awaiting_manual_confirm`. `docs/02-modelo-datos.md` suma la excepción de D9 a "nunca se convierte UF ↔ CLP": solo en el formulario de Marketplace, guardada en el progreso.

### 4.10 Contratos (API, ADR-0011)
| Método y ruta | Qué hace |
|---|---|
| `POST /accounts/marketplace/login` `{ broker, label? }` | Encola `marketplace.profile` con `action: "login"` (202, `{ queued, requestedAt }`) |
| `GET /accounts` | Marketplace con su vista propia: estado, `sessionCheckedAt`, `lastLoginError` |
| `POST /accounts/:id/disconnect` | En Marketplace exige `{ confirmed: true }` (`DISCONNECT_NOT_CONFIRMED`) y encola el borrado del perfil; `MANUAL_CONFIRM_PENDING` si hay una esperando |
| `GET /listings/:id/content` | La pestaña Marketplace suma `marketplaceReadiness` |
| `POST /listings/:id/publish` `{ platform: "fb_marketplace" }` y `POST /publications/:id/publish` | Como en F3 (202); `MARKETPLACE_NOT_READY`, `MARKETPLACE_DAILY_LIMIT` y `MARKETPLACE_FORM_OPEN` antes de pasar a `publishing` |
| `POST /publications/:id/confirm` `{ url? }` | `awaiting_manual_confirm` → `published` (200) |
| `POST /publications/:id/not-published` | `awaiting_manual_confirm` → `failed` (200) |
| `POST /publications/:id/cancel` y `POST /listings/:id/unapprove` | En Marketplace, `MANUAL_CONFIRM_PENDING` (409) si hay una esperando |

- La vista de una publicación suma `manual` (derivado del progreso: `formReadyAt`, `windowOpen`, `windowClosedAt`, `priceClp`, `ufValue`, `ufDate`), sin exponer el progreso crudo (seguimiento de ADR-0011).
- Códigos nuevos con su HTTP: `MARKETPLACE_NOT_READY` (409, con `issues`, donde puede ir `UF_SOURCE_NOT_CONFIGURED`), `ACCESS_TOKEN_UNAVAILABLE` (500: un error de programación, en `SERVER_INVALID`; por su sufijo hoy caería en 503), `MARKETPLACE_DAILY_LIMIT`, `MARKETPLACE_FORM_OPEN`, `MANUAL_CONFIRM_PENDING`, `PUBLICATION_ALREADY_CONFIRMED` y `DISCONNECT_NOT_CONFIRMED` (409), `MARKETPLACE_URL_INVALID` (400), `ACCOUNT_CREDENTIALS_REQUIRED` y `ACCOUNT_CREDENTIALS_NOT_ALLOWED` (500: errores del servidor). La API no consulta la UF: los errores de la UF (`UF_VALUE_UNAVAILABLE`, `UF_VALUE_MISSING`, `UF_VALUE_SUSPICIOUS`, `UF_SOURCE_AUTH_INVALID`) y los del navegador (`MARKETPLACE_SESSION_EXPIRED`, `MARKETPLACE_VERIFICATION_REQUIRED`, `MARKETPLACE_UNAVAILABLE`, `MARKETPLACE_FORM_CHANGED`, `MARKETPLACE_PROFILE_BUSY`, `MARKETPLACE_BROWSER_NOT_INSTALLED`, `MARKETPLACE_BROWSER_FAILED`, `MARKETPLACE_TYPE_UNSUPPORTED`, `MARKETPLACE_OPERATION_UNSUPPORTED`, `MARKETPLACE_NOT_PUBLISHED`) solo viajan en `last_error`.

### 4.11 Jobs nuevos (seguimiento de ADR-0005)
| Job | Política |
|---|---|
| `marketplace.profile` `{ brokerId, action: "login" \| "forget", label?, requestedAt? }` | `exclusive` por corredor (login y olvido nunca se cruzan), sin reintentos, expira a los 15 min (la espera del login es de 10); `forget` es idempotente |

### 4.12 CLI y panel
- **CLI:**
  - `accounts connect marketplace --broker <slug> [--label <nombre>]`: "Se abrió una ventana de Chromium: inicia sesión en Facebook. Espero hasta 10 min." `accounts disconnect <id>` pide confirmación en Marketplace (borra el perfil; `--yes`).
  - `publish <id> --platform marketplace`: espera el formulario listo y dice "Revisa la ventana, haz clic en Siguiente y Publicar". Después sigue esperando el enlace (lo detecta el worker) hasta el tope; si no llega, muestra los dos comandos siguientes. `--no-wait` para no esperar.
  - `pbpaste | pnpm -s cli publications confirm <id> --url-stdin` y `publications not-published <id>`.
  - `approve <id> --platform marketplace` muestra `marketplaceReadiness` como advertencia; `publications` muestra el enlace y, si se convirtió, el precio en pesos con la UF usada.
- **Panel:**
  - **Cuentas:** Marketplace por corredor, con estado, última revisión de sesión, el último error de login, "Iniciar sesión en Facebook" (encola el login) y Desconectar (con confirmación: borra el perfil).
  - **Contenido > Marketplace:** lo que falta, aprobar, publicar, y la publicación con su estado. En `awaiting_manual_confirm`: "Formulario listo: revisa la ventana de Chromium y publica" (o "Simulación" si `simulated`) o, con `windowClosedAt`, "La ventana se cerró: ¿lo publicaste?"; el precio en pesos con la UF usada; un campo para pegar el enlace con "Lo publiqué", y "No lo publiqué". Publicada: el enlace y Marcar como retirada. **Plan B:** Copiar título, Copiar descripción, el precio (en pesos si un intento lo calculó; si no, el del aviso, sin convertir: el panel no consulta la UF) y abrir cada foto.

### 4.13 Decisiones (aprobación permanente del operador; D2, D8, D9 y D10 las respondió él el 2026-10-09)
- **D1 · Sesión en un perfil propio por corredor, fuera del repo** (§4.2): Chromium de Playwright, carpeta `0700` fuera del workspace, se borra al desconectar. Solo se lee la cookie `c_user` (el id), nunca otra.
- **D2 · La cuenta de las pruebas es el perfil personal del operador** (respuesta del operador), en el corredor `agentsales-pruebas`, aceptando el riesgo de restricción (las Condiciones piden una sola cuenta por persona y no dar acceso a otros). Cuando se ofrezca a corredores (F7), cada uno inicia sesión y hace el clic en su propio equipo.
- **D3 · El operador hace Siguiente y Publicar:** la pantalla entre los dos (grupos, dónde se muestra) no está verificada y es decisión del corredor. El sistema llena y se detiene.
- **D4 · En `dry-run`, publicar no abre Facebook:** simula el formulario listo y la confirmación desde el panel o la CLI (con el precio en pesos: la UF es una lectura del Banco Central). El formulario real se prueba con `fb:smoke --listing` (operador) y en `live`. No hay `preflight` (no existe una validación sin efectos). Conectar la cuenta y `fb:smoke` sí abren Facebook en cualquier modo: los pide el operador y no publican (ADR-0017 punto 7).
- **D5 · Sin sincronizar estados:** de Facebook solo se lee lo necesario para detenerse y la evidencia del formulario mientras se llena, y después solo la dirección de la pestaña (§4.5). Retirar es a mano en Facebook más "Marcar como retirada".
- **D6 · Ritmo lento, sin disfraz:** una pausa fija entre acciones y el límite diario, para no cargar la cuenta; sin variaciones al azar que imiten a una persona (ADR-0017 cambia las "pausas aleatorias" de ADR-0004 por pausas fijas). Idioma y zona son configuración, no disfraz. Nunca se ocultan las señales de automatización ni se evaden verificaciones (CLAUDE.md, ADR-0004). Lista blanca: cualquier pantalla no esperada detiene.
- **D7 · Chromium de Playwright, no el Chrome instalado:** ya está instalado y fijado por versión; usar el Chrome del operador arriesga mezclar perfiles.
- **D8 · Límite diario: 3 por cuenta** (respuesta del operador).
- **D9 · La UF se convierte a pesos al llenar el formulario** (respuesta del operador): valor oficial del día, redondeado al peso, guardado en el progreso y la bitácora; el texto aprobado sigue con la UF. Un aviso en venta no va a Marketplace solo si el formulario de Chile no tiene venta (lo confirma `fb:smoke`).
- **D10 · La prueba en `live` llena 3 avisos sin publicarlos** (respuesta del operador): el sistema llena 3 formularios y el operador revisa cada uno y marca "No lo publiqué"; los publica de verdad solo si alguno es una propiedad real que quiere ofrecer. El criterio del roadmap ("publica 3 haciendo solo el clic final") se cumple hasta el clic; la confirmación con enlace se prueba con tests y, si el operador publica uno real, en vivo.
- **D11 · El sistema nunca da por publicado ni por no publicado lo que no vio** (§4.3): sin la dirección del aviso, espera la palabra del operador; descartar, quitar la aprobación y desconectar esperan esa palabra.
- **D12 · Un formulario abierto por cuenta, la ventana se cierra ante cualquier error y los errores del navegador no se reintentan solos** (§4.4, §4.7).
- **D13 · Plan B dentro de F5** (ADR-0004): copiar textos, el precio y abrir fotos desde el panel; cuesta poco y deja publicar a mano si el formulario cambia.
- **D14 · "No lo publiqué" no se deshace:** la máquina no permite `failed → published`. Si el operador se equivocó y el aviso sí salió, lo borra en Facebook y reintenta (o descarta). Cambiarlo exigiría un ADR.

### 4.14 Dependencias nuevas
`playwright` 1.63.0 en `packages/publishers` (ya está en el stack y en `packages/media`, misma versión; la CI ya instala su Chromium). Sin otras.

## 5. Tareas
ADR-0017 se registra con la aprobación del spec (en su mismo PR). Un PR por lote (orden al final).

### F5-T01 · Contrato y datos de Marketplace (ADR-0017)
- **Depende de:** —
- **Archivos:** `packages/core/src/{platform-account.ts,publication.ts,ports/publisher.ts,ports/platform-account-repository.ts,ports/publication-repository.ts,publish/dry-run.ts}`, `packages/core/src/marketplace/{progress.ts,url.ts}`, `packages/db/src/repositories/{platform-accounts.ts,publications.ts}` y sus dobles, `packages/config/src/env.ts`, `packages/publishers/package.json`, `.env.example`, `docs/01-arquitectura.md`, `docs/02-modelo-datos.md`
- **Descripción:** esquemas de `meta` y progreso (registrado en `PUBLICATION_PROGRESS_SCHEMAS`), `parseMarketplaceItemUrl`, `upsertConnected` sin credenciales solo en Marketplace (`ACCOUNT_CREDENTIALS_REQUIRED` en las demás), `updateProgress` condicional (estado e intento), `manualConfirm`, la variante `handoff`, `credentials` opcional en `PublishContext`, `withDryRun` que copia la bandera y simula, `BROWSER_PROFILES_DIR` (fuera del workspace) y `MARKETPLACE_CONFIRM_TIMEOUT_MIN`; `package.json` de publishers con la subruta `./marketplace` (la de `./uf` la suma T07). En `docs/01-arquitectura.md`, el contrato y las etiquetas del diagrama de estados (`awaiting_manual_confirm → failed` pasa a ser "No lo publiqué"; el captcha o la verificación detienen en `publishing`).
- **Hecho cuando:**
  - [x] Tests de esquemas, URL (formas válidas, `m.`, consulta, otras rutas rechazadas), repositorios en PGlite y en memoria (`updateProgress` no pisa otro intento), `withDryRun` (no llama a `publish` del envuelto, copia la bandera) y config (rechaza una ruta dentro del workspace)
  - [x] Docs 01 y 02 y `.env.example` al día; se cierra la deuda de `BROWSER_PROFILES_DIR` en ESTADO

### F5-T02 · Perfil, guardas y evidencia (navegador)
- **Depende de:** T01
- **Archivos:** `packages/publishers/src/marketplace/{profile.ts,guard.ts,evidence.ts,window.ts,selectors.ts,errors.ts}`, `packages/publishers/test/marketplace/fixtures/*.html`
- **Descripción:** abrir el perfil con candado (`MARKETPLACE_PROFILE_BUSY`), `0700`, idioma y zona; `sessionUserId` (la cookie `c_user`, NO VERIFICADO hasta `fb:smoke`); la lista blanca y sus errores (§4.4, paso 3); captura y árbol de un localizador (solo el formulario; nada en login ni verificación); `MarketplaceWindow` (`watch`, `close`) con la regla de la primera navegación desde el formulario.
- **Hecho cuando:**
  - [x] Tests con Playwright sin ventana sobre páginas locales (formulario, login, checkpoint, captcha, "no disponible", página desconocida), con **toda** la red fuera de las páginas locales bloqueada (`context.route`), y un test que falla si algo intenta salir a `facebook.com`
  - [x] Dos aperturas del mismo perfil: la segunda da `MARKETPLACE_PROFILE_BUSY`
  - [x] `watch`: reconoce `/marketplace/item/123` llegando desde el formulario; ignora otra pestaña, otra ruta y una segunda navegación; avisa el cierre

### F5-T03 · `pnpm fb:smoke` (sin llenar)
- **Depende de:** T02
- **Archivos:** `apps/worker/src/smoke/fb-smoke.ts`, `apps/worker/src/scripts/fb-smoke.ts`, `package.json`, `CLAUDE.md`, `docs/08-guia-operador.md`, `docs/07-checklist-cuentas.md`
- **Descripción:** §4.8 sin `--listing`. Lo corre el operador apenas se mergee el lote A: su árbol del formulario (`tmp/fb-smoke/formulario.aria.yml`) es la entrada de T09. `CLAUDE.md` suma el comando y la excepción a `PUBLISH_MODE` (como `ml:test-user`): conectar Marketplace y `fb:smoke` abren Facebook en cualquier modo, sin publicar, y los corre solo el operador.
- **Hecho cuando:**
  - [x] Tests sobre páginas locales: guarda la evidencia, no escribe en ningún control, se detiene ante cada pantalla de la lista, sin sesión espera y respeta el tope
  - [x] Guía, checklist y `CLAUDE.md` con el comando y el paso a paso del operador

### F5-T04 · Conectar y olvidar la cuenta (core y worker)
- **Depende de:** T01, T02
- **Archivos:** `packages/core/src/use-cases/{connect-marketplace-account.ts,disconnect-account.ts}`, `packages/core/src/jobs.ts`, `apps/worker/src/jobs/marketplace-profile.ts`, `apps/worker/src/marketplace/*`
- **Descripción:** `connectMarketplaceAccount` (§4.2), el job `marketplace.profile` (`login` y `forget`) con su política (§4.11), y desconectar que solo toca la base, encola el borrado y responde `MANUAL_CONFIRM_PENDING` si hay una publicación esperando. El borrado se lleva también el candado `<perfil>.lock`, solo si nadie lo tiene. El worker arma la carpeta raíz de los perfiles en un solo lugar, con `resolveBrowserProfilesDir`.
- **Hecho cuando:**
  - [ ] Tests del caso de uso (una conectada por corredor, reconectar la misma cuenta, otra cuenta en el mismo perfil revoca la anterior, `lastLoginError`, desconectar con una esperando da 409), del job con un navegador doble (tope, perfil tomado, sesión solo con `c_user` y una página que no es de verificación, login después de un olvido) y del borrado (idempotente, solo dentro de `BROWSER_PROFILES_DIR`, cierra antes las ventanas)

### F5-T05 · Publicar en dos tiempos (core)
- **Depende de:** T01
- **Archivos:** `packages/core/src/use-cases/{publish-publication.ts,confirm-manual-publication.ts,mark-not-published.ts,publish-listing.ts,start-publication.ts,publication-start.ts,cancel-publication.ts,unapprove-content.ts,retire-publication.ts,platform-auth.ts}`, `packages/core/src/publication.ts` (`PUBLISH_ATTEMPT_RESULTS`), `packages/db/src/repositories/publications.ts` (`countLiveAttemptsSince`) y su doble, `packages/publishers/src/marketplace/publisher.ts` (el esqueleto: `manualConfirm`, `formats` y `validate`; `publish` lanza `PUBLISHER_NOT_CONFIGURED` hasta T10), `apps/worker/src/worker.ts` (lo registra)
- **Descripción:** el intento con `handoff`, el progreso que arma core y su salida nueva (§4.3), confirmar y "no lo publiqué", el límite y un formulario a la vez en el intento y como aviso temprano (§4.7), `MANUAL_CONFIRM_PENDING` al descartar y quitar la aprobación, `MARKETPLACE_SESSION_EXPIRED` como rechazo de acceso, el texto de retirar por plataforma, y el esqueleto del publisher registrado en el worker (con él, la simulación funciona antes del lote E). La UF entra al intento en T07. El intento de Marketplace no llama a `getCredentials` (`usesSessionProfile`): hoy respondería `ACCOUNT_NOT_CONNECTED`.
- **Hecho cuando:**
  - [ ] Tests: `publishing` → `awaiting_manual_confirm` (nunca `published`) con un publisher doble con `manualConfirm`, con el progreso del intento (`attempt`, `simulated`, `photos`) y el `publish_attempt` nuevo; un `handoff` de otro publisher es error; la transición que falla da `PUBLISH_RESULT_NOT_SAVED`; confirmar en `live` exige URL válida, en `dry-run` la ignora, dos veces con la misma URL es idempotente y con otra 409; `not-published` deja `failed` y luego se reintenta con progreso nuevo; límite (hoy y ayer en Santiago; la misma publicación reintentada 3 veces y un cuarto intento de otro aviso da `MARKETPLACE_DAILY_LIMIT`; `dry-run` no cuenta) y formulario abierto (en cualquier modo), en el intento y en las dos rutas de publicar; descartar y quitar la aprobación con una esperando dan 409

### F5-T06 · Worker: la ventana abierta
- **Depende de:** T02, T04, T05
- **Archivos:** `apps/worker/src/marketplace/windows.ts`, `apps/worker/src/jobs/publication-publish.ts`, `apps/worker/src/worker.ts`, `apps/worker/src/content-tmp.ts` (limpieza)
- **Descripción:** §4.5: registro de ventanas pendientes y activas, activación solo con `awaiting_manual_confirm`, confirmación al ver el aviso, `windowClosedAt` al cerrarse o vencer, relectura cada 5 s, cierre al apagar antes de cerrar la base, barrido al arrancar, limpieza de la evidencia; el job registra "formulario listo".
- **Hecho cuando:**
  - [ ] Tests con una ventana doble: confirma con actor `system`; ignora `INVALID_TRANSITION`; cierre y tope anotan `windowClosedAt` del mismo intento sin cambiar el estado; cierra al ver que la publicación ya no espera; cierra la pendiente si el intento no terminó en espera; el apagado y el barrido

### F5-T07 · Lo que falta y la UF (core)
- **Depende de:** T01, T05 (va después en el lote: los dos tocan `publication-start.ts` y `publish-publication.ts`)
- **Archivos:** `packages/core/src/marketplace/{readiness.ts,price.ts}`, `packages/core/src/ports/uf-value-source.ts`, `packages/core/src/use-cases/{publish-publication.ts,publish-listing.ts,start-publication.ts,publication-start.ts,approve-content.ts,get-listing-content.ts}`, `packages/core/src/content/checks.ts`, `packages/publishers/src/uf/*`, `packages/config/src/env.ts`, `apps/cli/src/commands/doctor/*`, `apps/worker/src/{smoke,scripts}/uf-smoke.ts`, `apps/worker/src/worker.ts`, `.env.example`, `package.json`, `CLAUDE.md` (`pnpm uf:smoke`), `docs/01-arquitectura.md` (el puerto), `docs/02-modelo-datos.md` (la excepción de D9), `docs/08-guia-operador.md` (renovar el token), `docs/integraciones/uf.md` (caché en memoria en vez de tabla)
- **Descripción:** `marketplaceReadiness` con lo que no depende del formulario (fotos, precio, dormitorios, baños, comuna), cableado a aprobar, la vista del contenido y las dos rutas de publicar (`MARKETPLACE_NOT_READY` con `issues`); el puerto `UfValueSource`, el adaptador de la API BDE (`docs/integraciones/uf.md`), `ufToClp`, el control de rango y la conversión dentro del intento (también en `dry-run`), `BCCH_API_TOKEN` (con el aviso de `doctor`) y `pnpm uf:smoke`; "presencia de niños" en la regla de requisitos discriminatorios.
- **Hecho cuando:**
  - [ ] Tests de `marketplaceReadiness` (también sin token), de `ufToClp` (enteros, redondeo, sin flotantes), del intento con la UF (fecha de Santiago, el día 9 y el 10, control de rango, `dry-run` también convierte), del adaptador con msw (respuesta válida, día sin dato → `UF_VALUE_MISSING`, caída → `UF_VALUE_UNAVAILABLE`, token rechazado, nunca un valor viejo ni de otra fecha, no guarda los días sin dato, el token nunca en un error ni en un log) y de la regla nueva

### F5-T08 · API de Marketplace
- **Depende de:** T04, T05, T07
- **Archivos:** `apps/api/src/routes/{accounts.ts,publications.ts,content.ts,publication-views.ts}`, `apps/api/src/contracts/*`, `apps/api/src/errors.ts`
- **Descripción:** §4.10, con la vista propia de la cuenta de Marketplace y `manual` en la de la publicación.
- **Hecho cuando:**
  - [ ] Tests de cada ruta y código (también el login encolado, el desconectar con confirmación y con una esperando, y la URL pegada nunca en logs)

### F5-T09 · Opciones del formulario y llenado
- **Depende de:** T03 **corrido por el operador** (árbol real del formulario), T02, T07
- **Archivos:** `packages/core/src/marketplace/fields.ts` (y `readiness.ts`: tipo y operación), `packages/publishers/src/marketplace/{selectors.ts,fill.ts}`, `packages/publishers/test/marketplace/fixtures/form.html`
- **Descripción:** la tabla de §4.6 con las opciones reales; el formulario local de los tests se arma **desde el árbol real** (mismos roles y nombres); el llenado de §4.4, pasos 4 y 5, con pausas inyectables (cero en tests).
- **Hecho cuando:**
  - [ ] Tests de la tabla atada a las definiciones de campos (`packages/db`), del tipo y la operación en `marketplaceReadiness`, y sobre la página local: cada campo con su valor (el precio en pesos), las fotos subidas, la dirección solo con `show_exact_address`, un control que falta da `MARKETPLACE_FORM_CHANGED` con captura, y **ningún clic** en Siguiente ni Publicar (la página local registra cada clic)

### F5-T10 · Publisher de Marketplace y `fb:smoke --listing`
- **Depende de:** T05, T06, T09
- **Archivos:** `packages/publishers/src/marketplace/publisher.ts`, `apps/worker/src/worker.ts` (registro), `apps/worker/src/smoke/fb-smoke.ts`
- **Descripción:** `createMarketplacePublisher` completo (§4.4: fotos de R2 a temporal y su borrado, perfil (cerrando antes la ventana vieja de la cuenta), guardas, llenado, evidencia, cierre ante error, `onHandoff`); `--listing` de §4.8.
- **Hecho cuando:**
  - [ ] Prueba de punta a punta del job de publicar con la página local: termina en `awaiting_manual_confirm` con evidencia, el temporal se borra, un "Publicar" simulado en la página local lleva a `published` con su enlace, y un error cierra la ventana y libera el perfil
  - [ ] `--listing` pide confirmación, se niega con el límite alcanzado, no cambia estados ni deja eventos

### F5-T11 · CLI de Marketplace
- **Depende de:** T08
- **Archivos:** `apps/cli/src/commands/{accounts,publish,publications,approve}/*`
- **Descripción:** §4.12 (CLI).
- **Hecho cuando:**
  - [ ] Tests con el arnés de la CLI: conectar con espera (y con `lastLoginError`), publicar con las dos esperas, `confirm --url-stdin` (la URL no se imprime), `not-published`, confirmación al desconectar, `MANUAL_CONFIRM_PENDING`

### F5-T12 · Panel: Cuentas con Marketplace
- **Depende de:** T08
- **Archivos:** `apps/web/src/pages/Accounts*`, `apps/web/src/components/accounts/*`
- **Hecho cuando:**
  - [ ] Tests de componente: iniciar sesión encola y espera, el último error, desconectar pide confirmación

### F5-T13 · Panel: Marketplace en Contenido (con plan B)
- **Depende de:** T08
- **Archivos:** `apps/web/src/components/content/Marketplace*`
- **Hecho cuando:**
  - [ ] Tests de componente: lo que falta, formulario listo, ventana cerrada, pegar enlace (inválido y válido), "No lo publiqué", descartar bloqueado mientras espera, publicada con enlace y retirar, plan B (copiar textos, precio en pesos)

### F5-T14 · Cierre de fase
- **Depende de:** todas
- **Descripción:** `/fase-cerrar 5`.
- **Hecho cuando:**
  - [ ] Demo en simulación (§7, pasos 4 y 5) y, con la instrucción del operador, la de `live` (paso 6)
  - [ ] Nota de Marketplace con lo verificado; criterios de §6 con evidencia; auditoría del `arquitecto`
  - [ ] `CHANGELOG.md` `[0.5.0]`, spec cerrado, `docs/ESTADO.md` apuntando a F6; tag con permiso del operador

**Lotes y orden:**
- **Lote A** (T01, T02, T03): contrato, navegador y `fb:smoke`. Al mergearlo, el operador corre `fb:smoke` (§7, paso 2).
- **Lote B** (T04, T05, T06, T07): conectar, publicar en dos tiempos, la ventana abierta, lo que falta y la UF. No depende de `fb:smoke`: avanza mientras tanto.
- **Lote C** (T08, T11): API y CLI.
- **Lote D** (T12, T13): panel. Con B, C y D la demo en simulación (§7, pasos 4 y 5) ya se puede hacer: el esqueleto del publisher (T05) basta para `dry-run`, que no abre Facebook.
- **Lote E** (T09, T10): opciones reales, llenado y publisher. Necesita el árbol de `fb:smoke`; si llega antes, E va antes que C.
- **T14:** cierre.

## 6. Criterios de aceptación de la fase
- [ ] En `live`, el sistema abre el perfil del operador, llena el formulario de 3 propiedades aprobadas (con el precio en pesos si estaban en UF) y sube sus fotos, y el operador solo tiene que hacer Siguiente y Publicar (D10: los revisa y no los publica, salvo una propiedad real).
- [ ] Una publicación esperando pasa a `published` con su enlace, detectado en la ventana o pegado (tests de punta a punta con la página local; en vivo, si el operador publica una real), y "No lo publiqué" la deja lista para reintentar.
- [ ] Ante una sesión vencida, una verificación, un captcha o una página inesperada, el sistema se detiene sin tocar nada más, guarda una captura, cierra la ventana y la publicación queda `failed` con un motivo legible (tests con páginas locales; en vivo, si ocurre).
- [ ] El sistema nunca hace clic en Siguiente ni en Publicar (tests: la página local registra cada clic) y nunca da por publicado ni por no publicado lo que no vio.
- [ ] El límite diario y "un formulario a la vez" se cumplen (tests y demo).
- [ ] En `dry-run`, publicar no abre Facebook y el flujo completo se recorre en simulación desde el panel y la CLI, con el precio en pesos (demo). Solo conectar la cuenta y `fb:smoke`, que pide el operador, abren Facebook en cualquier modo.
- [ ] El perfil vive fuera del repo, no aparece en logs, errores ni respuestas, y se borra al desconectar (tests y demo).
- [ ] Ningún test llama a Facebook, Instagram, Mercado Libre, Anthropic ni al Banco Central; `pnpm check` y la CI de GitHub en verde.

## 7. Plan de demo
1. **Operador, desde el día uno:** revisar en Facebook (Perfil → Estado del perfil → Marketplace) que su cuenta tiene Marketplace sin restricciones; crear la cuenta de la BDE del Banco Central, activar la API y dejar el token en `.env` como `BCCH_API_TOKEN` (`docs/integraciones/uf.md` §3.1; con el lote B, `pnpm uf:smoke`); confirmar que `agentsales-pruebas` tiene al menos un arriendo (por si Chile no tiene venta).
2. **Operador, con el lote A:** `pnpm fb:smoke --broker agentsales-pruebas`: inicia sesión a mano en la ventana la primera vez; deja el árbol del formulario en `tmp/fb-smoke/` y avisa a Claude. Confirma ahí lo que la nota marcó NO VERIFICADO (venta en Chile, moneda, ubicación, fotos, borradores).
3. **Operador, con el lote B:** `pnpm -s cli accounts connect marketplace --broker agentsales-pruebas` (si la sesión del paso 2 sigue, conecta sin pedir nada).
4. **`dry-run` (la corre Claude, con aviso previo de `pnpm dev`):** en el panel, lo que falta para Marketplace en P001, aprobar y publicar: queda "Formulario listo" simulado sin abrir Facebook; publicar otro aviso de la misma cuenta da "formulario abierto"; descartar da "di si lo publicaste"; "Lo publiqué" lo deja `published` simulado; Marcar como retirada. Plan B: copiar textos.
5. **CLI:** `approve P002 --platform marketplace`, `publish P002 --platform marketplace`, `publications not-published <id>`, reintentar y descartar; `publications P002 --events`.
6. **`live`, solo con la instrucción del operador en el chat:** `fb:smoke --listing P001` primero; luego `PUBLISH_MODE=live pnpm dev` y publicar 3 avisos en Marketplace, de a uno: se abre la ventana, se llena (precio en pesos si era UF), el operador revisa y marca "No lo publiqué" (D10), o publica si es una propiedad real y ve el enlace en el panel. Como `fb:smoke --listing` no suma al límite, un cuarto intento el mismo día da `MARKETPLACE_DAILY_LIMIT`. Al terminar, el operador revisa en "Tus publicaciones" que no quedaron borradores. Apagar todo y arrancar sin la variable.

## 8. Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| Meta restringe la cuenta del operador por automatización | Clic humano en Siguiente y Publicar, límite de 3 por día, un formulario a la vez, pausas, sin lectura de estados, detención ante cualquier verificación; riesgo aceptado por el operador (D2) |
| El formulario real no es el supuesto (venta, moneda, campos) | `fb:smoke` antes de las opciones y los selectores; el formulario de los tests se arma desde el árbol real; nada se supone |
| Facebook cambia la página | Selectores por rol y nombre en un solo módulo; `MARKETPLACE_FORM_CHANGED` con captura; plan B en el panel |
| El perfil (cookies) se filtra | Fuera del workspace, `0700`, nunca en logs, R2 ni errores; se borra al desconectar; Claude no lo lee |
| Un aviso duplicado por reintentar uno que sí salió | Nunca se da por no publicado sin la palabra del operador (D11); descartar espera esa palabra; sin reintentos automáticos |
| El worker confirma un aviso ajeno que el operador abrió en la ventana | Solo vale la primera navegación desde el formulario en la misma pestaña (§4.5) |
| Un formulario abandonado queda como borrador en Facebook | El operador lo revisa en "Tus publicaciones" (guía); se confirma con `fb:smoke --listing` |
| La ventana no se abre desde el worker en macOS | Se prueba con `fb:smoke` (mismo código) y al conectar la cuenta (paso 3) |
| La fuente de la UF falla o cambia | `UF_VALUE_UNAVAILABLE` reintentable; nunca un valor viejo; tests con msw; `uf:smoke` confirma la forma real |
| El token de la UF vence (dura 1 año) o se filtra | `UF_SOURCE_AUTH_INVALID` lo dice; la guía anota renovarlo; el redactor lo oculta y la URL nunca va a logs |
| El precio en pesos no calza con la UF del texto días después | El valor y la fecha quedan en la bitácora; la descripción manda la UF |
| El WhatsApp en la descripción hace rechazar o se oculta | Se mira en la prueba en vivo; si molesta, una tarea chica lo quita del texto de Marketplace |
| Publicar un aviso falso infringe las políticas | D10: la prueba en vivo no publica, salvo propiedades reales |
| El idioma del perfil cambia los nombres de los controles | Selectores en español; otro idioma da `MARKETPLACE_FORM_CHANGED` con el motivo |

## 9. Preguntas abiertas
Respondidas por el operador el 2026-10-09:
- [x] D2: ¿con qué cuenta de Facebook? **Su perfil personal**, aceptando el riesgo; cada corredor el suyo en F7.
- [x] D9: ¿qué hacer con los avisos en UF? **Convertir a pesos** con el valor del día.
- [x] D10: ¿qué cuenta como la prueba en vivo? **Llenar 3 y no publicar**, salvo una propiedad real.
- [x] D8: ¿límite diario? **3**.

Pedido desde el día uno (terceros): revisar el estado de Marketplace de la cuenta, el token de la API BDE del Banco Central (gratis, inmediato) y correr `fb:smoke` apenas exista (§7, pasos 1 y 2).

Decididas por Claude con la aprobación permanente (preguntas técnicas de la nota `uf.md`): la fuente es la API BDE con token anual; si el valor falta o falla, la publicación se detiene (nunca un valor viejo); la descripción aprobada no cambia (muestra la UF) y el precio en pesos va solo en el campo del formulario. Sigue pendiente de F4: el usuario de prueba de Mercado Libre y su activación, `ml:smoke --listing P001` y la prueba en vivo de Portal.

## 10. Registro de cambios del spec
| Fecha | Cambio |
|---|---|
| 2026-10-09 | Borrador inicial (`/fase-plan 5`), con la nota `docs/integraciones/fb-marketplace.md` (leída sin sesión con el navegador integrado) |
| 2026-10-09 | Respuestas del operador: su perfil personal (D2), límite de 3 (D8), la UF convertida a pesos con el valor del día (D9, nota `uf.md`) y la prueba en vivo que llena 3 sin publicar (D10) |
| 2026-10-09 | Revisión del `arquitecto`: progreso escrito en la transición a la espera, con el intento, y `updateProgress` condicional; la ventana pasa al worker con `onHandoff` y se activa solo con la salida `awaiting_manual_confirm`; descartar, quitar la aprobación y desconectar esperan la palabra del operador (`MANUAL_CONFIRM_PENDING`); solo vale la primera navegación desde el formulario; el perfil lo borra el worker (`marketplace.profile`); el límite y "un formulario a la vez" en el intento (core) y como aviso en las dos rutas de publicar, contando las pasadas a `publishing`; la ventana se cierra ante cualquier error; T07 (lo que falta y la UF) pasa al lote B y las opciones reales del formulario a T09; `credentials` opcional, `withDryRun` copia la bandera, `MARKETPLACE_SESSION_EXPIRED` vence la cuenta, la relectura del worker reemplaza el job de cerrar ventana, el resultado del login en `meta`, el perfil rechazado dentro del workspace, vistas propias, confirmar dos veces, modos mezclados, orden del apagado, limpieza de la evidencia y el texto de retirar por plataforma |
| 2026-10-09 | Fuente de la UF (nota `uf.md`): API BDE del Banco Central con `BCCH_API_TOKEN`, valores en memoria por fecha, el token oculto por el redactor, `UF_SOURCE_NOT_CONFIGURED` y `UF_SOURCE_AUTH_INVALID`, y `pnpm uf:smoke` (operador) |
| 2026-10-09 | Spec **aprobado** (aprobación permanente del operador). ADR-0017 aceptado; `03-plataformas.md`, `06-roadmap.md`, `07-checklist-cuentas.md` y `docs/ESTADO.md` al día |
| 2026-10-09 | Revisión del PR #103 (`revisor` y `arquitecto`): la UF la convierte core en el intento (también en `dry-run`) y el progreso lo arma core; se quita la retoma con la ventana viva; el límite cuenta los `publish_attempt` en `live` (los reintentos de la misma publicación también); conectar y `fb:smoke` abren Facebook en cualquier modo como excepción explícita (ADR-0017 y `CLAUDE.md`), y `--listing` pide confirmación y respeta el límite; el esqueleto del publisher en T05 deja la simulación antes del lote E; `MANUAL_CONFIRM_PENDING` al desconectar con test en core; `c_user` NO VERIFICADO y la sesión exige además una página que no sea de verificación; errores de la UF separados (`UF_VALUE_MISSING`, `UF_VALUE_SUSPICIOUS`) y control de rango; D5 y D6 precisos (pausa fija, idioma y zona como configuración); un solo job `marketplace.profile` para login y olvido; `updateProgress` por intento; `awaiting_manual_confirm` en `PUBLISH_ATTEMPT_RESULTS`; `ufConfigured` en `marketplaceReadiness`; subrutas de publishers (la API no carga Playwright); sin capturas en pantallas de login o verificación; plan B sin consultar la UF |
| 2026-10-09 | Desde el lote A (F5-T01 a T03): `checkConnectedCredentials` suma `ACCOUNT_CREDENTIALS_NOT_ALLOWED` (una cuenta de Marketplace nunca guarda credenciales); `DirectPublisher` (Instagram y Portal devuelven solo "publicado") y `ACCESS_TOKEN_UNAVAILABLE` (pedir un token sin credenciales); `PUBLICATION_PROGRESS_STALE` para `updateProgress`; `BROWSER_PROFILES_DIR` ignora el valor viejo de `.env.example` (`./.browser-profiles`) y `loadEnv` rechaza una ruta relativa; el candado del perfil es un archivo `<perfil>.lock` con el pid (uno muerto se toma); el formulario se reconoce, hasta T09, por su control de fotos (`FORM_ROOT`, provisional); `fb:smoke` espera también si la página pide una verificación durante el inicio de sesión (es parte del inicio a mano), cierra la ventana al terminar y deja `summary.json` sin cookies ni consulta |
| 2026-10-09 | Revisión del lote A (#104, `revisor` y `arquitecto`, sin bloqueantes): la ventana vigilada no deja escapar errores de sus avisos (`onError`) y cerrar solo la pestaña suelta el perfil; si registrar el aviso falla, se avisa `onClosed` (sigue esperando la palabra del operador); el candado se toma con `link` sobre un temporal con el pid (nunca se ve vacío); una verificación gana a un inicio de sesión en la lista blanca; la evidencia prefiere el `form` al contenedor principal (que en Facebook puede traer el nombre del operador); el perfil expone `sessionCookie()` y `fb:smoke` no lee otras cookies ni escribe la dirección de Facebook; `fb:smoke` avisa si hay una verificación (se resuelve a mano en esa ventana), no gira en vacío si se cierra la ventana y su resumen guarda solo nombres de archivo; `resolveBrowserProfilesDir` no distingue mayúsculas en macOS; Biome prohíbe Playwright y `@agentsales/publishers/marketplace` en la API, la CLI y el panel, y Playwright en `packages/publishers` fuera de `marketplace/`; notas para T04, T05 y T08 |
