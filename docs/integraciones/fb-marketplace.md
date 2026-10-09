# Facebook Marketplace (Chile): publicar propiedades con Playwright y clic final humano

Nota para planificar F5, **consultada el 2026-10-09**. Responde cómo se publica hoy una propiedad en Marketplace en Chile, qué permite Meta y qué parte se puede automatizar sin cruzar la línea del ADR-0004 (el sistema llena y sube fotos; **el operador hace siempre el clic final**; ante captcha o verificación, el sistema se detiene).

## Cómo leer esta nota (importante)

Convención: **DOC** = leído en una página oficial de Meta o de Playwright (URL en la sección 10), o **observado en una página pública** de facebook.com sin sesión (se dice "observado"); **INFERENCIA** = deducido de lo leído; **NO VERIFICADO** = no lo dice ninguna fuente oficial o solo se ve con sesión iniciada; se confirma con la sesión del operador (sección 8).

**Método y límites:**

- Se leyeron unas 40 páginas con el navegador integrado (texto de la página), **sin iniciar sesión** en Facebook, sin escribir en formularios y sin aceptar nada. Blogs y foros se usaron solo como pista y se marcan como tal.
- **El navegador salió a internet desde EE. UU.** (Marketplace mostró "San Francisco, California" como ubicación por defecto). El Centro de ayuda adapta los artículos a la región: uno ("Facebook Marketplace listing limits") dijo que no aplica a la región, y otro solo aplica a India. **Lo leído es la versión que Meta muestra en EE. UU.**; la versión para Chile (y en español) puede diferir: NO VERIFICADO.
- El formulario de "Propiedad en venta o alquiler" **solo se ve con sesión**: sin sesión, `https://www.facebook.com/marketplace/create/rental` redirige a `/marketplace/` con el cuadro de login (observado). Todo lo del formulario (campos, obligatorios, límites) queda NO VERIFICADO.

## 1. Resumen

- **No hay API para un corredor (DOC + INFERENCIA).** La única API de Marketplace es el **Marketplace Partnership Program**: socios "elegibles" suben un catálogo (`POST /{product-catalog-id}/items_batch`, con `partner_listing_type` que admite `rental` y `real_estate`) y el comprador termina la operación **en el sitio del socio**, solo "en ciertos países" (DOC). No hay inscripción abierta ni lista de países. La doc de anuncios inmobiliarios (actualizada en 2022) remite a "socios de Marketplace" y aclara que es solo en ciertos países (DOC). Un corredor independiente en Chile no entra a ese programa (INFERENCIA). Blogs del rubro dicen que desde el 13-09-2021 Marketplace dejó de mostrar arriendos y ventas que llegan por catálogos de socios, y que desde el 30-01-2023 las Páginas de empresa ya no pueden crear avisos de vehículos ni de inmuebles, solo los perfiles personales (pista; NO VERIFICADO en fuente oficial). Conclusión: el ADR-0004 sigue vigente.
- **Chile tiene Marketplace (DOC)** y una categoría **Property Rentals** activa en Santiago (observado): precios en **CLP** ("CLP500,000 / Month"), filtros de precio, dormitorios, baños, tipo de arriendo, metros cuadrados y "solo avisos de particulares", y subcategorías departamentos, condominios, casas y townhouses en arriendo.
- **Venta en Chile: NO VERIFICADO.** El menú muestra "Home Sales" (`/marketplace/santiago/propertyforsale/`), pero sin sesión esa dirección redirigió dos veces a `/marketplace/` (observado). En el feed de arriendos aparecen avisos que parecen de venta (precios de CLP 120.000.000) (observado), lo que sugiere que Home Sales podría no estar habilitada en Chile (INFERENCIA débil).
- **Flujo (DOC, artículo de "Item for sale"):** Marketplace → *Create new listing* → tipo → *Add photos* → datos → *Next* (gris si falta un obligatorio) → *Publish*. Para propiedades el tipo es "Property for sale or rent" (pista de blogs; NO VERIFICADO).
- **Después de publicar:** Meta revisa avisos cuando sus sistemas detectan una posible infracción o alguien los denuncia; los rechazados aparecen en *Needs attention* y se puede pedir revisión (DOC).
- **Vigencia:** el aviso sigue activo mientras se venda; uno **inactivo por 2 años** puede borrarse; *Renew* o editar reinicia el plazo (DOC). El "renovar cada 7 días" de los blogs no lo respalda la doc leída.
- **Términos:** las Condiciones prohíben el acceso o la recolección de datos "por medios automatizados" sin permiso, y **dar acceso a la cuenta a otras personas** (DOC). Llenar un formulario con Playwright en la sesión del propio dueño no está nombrado como tal (sección 9), pero el riesgo de restricción de la cuenta es real. Riesgo: **alto**, como dice `03-plataformas.md`.
- **Playwright** (doc 1.64, el proyecto fija 1.63.0): `launchPersistentContext` con un directorio propio por corredor; un perfil no admite dos navegadores a la vez; no apuntar al perfil de Chrome del usuario (DOC). `setInputFiles` no exige que el input sea visible (DOC).

## 2. Requisitos de cuenta

| Requisito | Dato | Fuente |
|---|---|---|
| País | Chile está en la lista de países con Marketplace | DOC |
| Edad | Adulto (en EE. UU., 18 años); si se bloquea por error, se confirma la edad desde la app (ID o selfie) | DOC |
| Perfil | Cuenta activa; **el perfil principal**, no un perfil adicional | DOC |
| Causas de acceso restringido | No ser adulto, cuenta **nueva o inactiva**, usar un perfil adicional, haber infringido las Condiciones o las Políticas de comercio, no tener sesión | DOC |
| Una persona, una cuenta | Las Condiciones piden usar el nombre real, crear **una sola cuenta propia** y no compartir la clave ni **dar acceso a la cuenta a otros** (sin permiso de Meta) | DOC |
| Página de empresa | Los avisos de inmuebles se crean desde el perfil personal; las Páginas ya no pueden | Pista (blogs, 2023); NO VERIFICADO |
| Vendedor comercial | Las Políticas de comercio restringen a empresas y a personas que actúan como empresa **solo en el EEE, Filipinas e India**; Chile no figura | DOC |
| "Consumer sellers" | El asistente de IA del Centro de ayuda resume que Marketplace es para "consumer sellers" (vendedores particulares) | DOC (resumen automático, no el artículo); alcance para un corredor: NO VERIFICADO |
| Estado de Marketplace | Perfil → *Profile status* → *Marketplace* (bajo *Extra features*): avisos, advertencias y apelaciones | DOC |

**Implicación (INFERENCIA):** cada corredor publica con **su** perfil personal y es quien inicia sesión en su perfil de navegador. Que Vinny (operador) inicie sesión con la cuenta de un corredor o la maneje por él choca con "no dar acceso a la cuenta a otros". En las pruebas, Vinny usa su propia cuenta.

## 3. Autenticación (sesión, sin tokens)

- **Sin OAuth ni tokens:** la "credencial" es la sesión de Facebook guardada en un **perfil de navegador persistente** por corredor (cookies y almacenamiento local) (ADR-0004).
- **Primer inicio de sesión:** a mano, por el corredor, en la ventana visible que abre el sistema; el sistema nunca ve ni guarda la contraseña ni los códigos de 2FA.
- **Playwright (DOC):** `chromium.launchPersistentContext(userDataDir, options)` lanza un navegador con almacenamiento persistente en `userDataDir` y devuelve **el único contexto**; cerrar ese contexto cierra el navegador. `headless` es `true` por defecto: hay que pasar `headless: false`. Los navegadores **no permiten dos instancias con el mismo `userDataDir`**. Por cambios de política de Chrome, automatizar el perfil por defecto de Chrome no está soportado, y apuntar al directorio "User Data" principal de Chrome puede dejar páginas sin cargar o cerrar el navegador: se usa una carpeta propia y vacía.
- **El perfil es un secreto (DOC + INFERENCIA):** la doc de autenticación de Playwright advierte que el estado del navegador puede contener cookies que sirven para **suplantar** la cuenta, y recomienda dejarlo fuera de git. El perfil va fuera del repo (por ejemplo `~/Library/Application Support/AgentSales/fb-profiles/<broker>`), nunca en R2, nunca en logs, y se borra al desconectar la cuenta (INFERENCIA).
- **Sesión vencida o ausente (observado):** sin sesión, `/marketplace/create/rental` redirige a `/marketplace/` y aparece el formulario de login (campos de correo o teléfono y contraseña). Con sesión, que la URL del formulario se mantenga: NO VERIFICADO.
- **`PlatformAccount` (INFERENCIA):** `ACCOUNT_REFRESH_UNSUPPORTED` ya está previsto para Marketplace (`01-arquitectura.md`). La cuenta se identificaría por el nombre del perfil que se ve con sesión (NO VERIFICADO dónde leerlo sin tocar nada).

## 4. Operaciones

### 4.1 Publicar

- **Tipos de aviso:** *Item for sale* (DOC); vehículo y propiedad (pista de blogs y observado indirectamente por las categorías Vehicles, Property Rentals y Home Sales). El nombre exacto del tipo para inmuebles en la interfaz en español de Chile ("Propiedad en venta o alquiler" o similar): NO VERIFICADO.
- **URL del formulario:** *Create new listing* apunta a `/marketplace/create/` (observado). Que `/marketplace/create/rental` sea el de propiedades: INFERENCIA (blogs y la redirección observada); con sesión, NO VERIFICADO.
- **Pasos (DOC, artículo de artículos):** fotos → datos → *Next* (gris si falta algo obligatorio) → *Publish*. Para propiedades, el paso entre *Next* y *Publish* (elegir dónde publicar, grupos o vista previa): NO VERIFICADO.
- **Campos para propiedades (todo NO VERIFICADO, pistas de blogs de EE. UU., Brasil y Nicaragua):** venta o arriendo; tipo de propiedad (departamento, casa, habitación, townhouse…); dormitorios; baños; precio (en arriendo, mensual); dirección o ubicación; descripción; m²; en EE. UU. también fecha de disponibilidad, mascotas, lavandería, estacionamiento, aire acondicionado y calefacción. Un blog brasileño menciona gastos comunes como opcionales. Obligatorios: según los blogs, tipo, dormitorios, baños, precio y dirección.
- **Lo que confirma la página pública de un arriendo (observado):** título, precio con "/ Month", "Rental Location" con comuna y región y la marca **"Location is approximate"**, descripción, y un enlace para denunciar el aviso por discriminación. Los filtros de búsqueda (dormitorios, baños, tipo de arriendo, m²) indican que el formulario pide esos datos (INFERENCIA).
- **Moneda:** los precios se ven en CLP (observado). **No se vio UF.** Un aviso muestra "CLP310", lo que sugiere que hay quien escribe valores en UF en un campo en pesos (INFERENCIA débil). Si hay selector de moneda: NO VERIFICADO. Implicación: convertir UF a CLP al publicar o poner la UF en el texto (pregunta al operador).
- **Teléfono en la descripción:** sin sesión, el número de WhatsApp de un aviso aparece como "[hidden information]" (observado). Si un usuario con sesión lo ve, y si poner teléfonos en la descripción afecta la revisión: NO VERIFICADO. Importa porque `04-formato` termina la descripción con el WhatsApp.
- **Revisión de Meta:** sus sistemas revisan cuando detectan una posible infracción o cuando alguien denuncia; los avisos que no cumplen se rechazan (DOC). El estado "pendiente" o "en revisión" justo después de publicar: NO VERIFICADO.

### 4.2 Aviso publicado

- URL: `https://www.facebook.com/marketplace/item/<id>/` (observado), con título de página `"<título> - Property Rentals - Santiago, Chile | Facebook Marketplace"` (observado). Cómo llega el usuario a esa URL después de *Publish* (redirección, aviso emergente o la lista *Your listings*): NO VERIFICADO.

### 4.3 Editar (DOC)

Marketplace → *Selling* → *Your listings* → *Options* (⋯) del aviso → *Edit listing* → cambiar → *Update*. Editar reinicia el plazo de 2 años de inactividad (DOC). Qué campos de una propiedad se pueden editar después: NO VERIFICADO.

### 4.4 Marcar como vendido, pendiente o disponible (DOC)

Un aviso se marca como *Sold*, *Pending* o *Available* (y *Shipped* en envíos). Al marcarlo vendido deja de verse en Marketplace y los interesados que escribieron reciben un mensaje; *Pending* avisa a los interesados y a los nuevos; volver a *Available* lo reactiva. En arriendos, si la etiqueta es "arrendado": NO VERIFICADO. **Este es el equivalente a "cerrar" o "pausar"** (INFERENCIA): no hay pausa documentada.

### 4.5 Ocultar (DOC)

*Hide from friends* (oculta el aviso de los amigos, que igual pueden encontrarlo) **solo existe para artículos: no para departamentos, casas ni vehículos**. *Hide listing* es la opción del comprador para no ver un aviso ajeno. **No hay forma de ocultar o pausar una propiedad propia** (INFERENCIA).

### 4.6 Eliminar (DOC)

*Selling* → *Your listings* → *Options* → *Delete* → *Delete*. Se puede si el aviso está disponible y sin órdenes pendientes ni etiqueta de envío. Restaurar un aviso borrado durante 30 días: pista de blogs, NO VERIFICADO. Borrar y republicar seguido puede verse como manipulación (pista de blogs; la política de spam sí menciona contenido repetitivo, sección 6).

### 4.7 Renovar y vigencia (DOC)

Activo mientras se venda; los inactivos por **2 años o más** pueden borrarse de forma permanente (título, descripción, fotos y precio no se recuperan). *Selling* → *Your listings* → *Renew*. Renovar o editar reinicia los 2 años. Si el botón *Renew* aparece solo pasado un tiempo (blogs dicen 7 días): NO VERIFICADO.

### 4.8 Consultar estado

- No hay API de lectura. Lo que se podría leer de la página: la lista *Your listings* (activo, vendido, pendiente, *Needs attention*) y *Profile status* (advertencias) (DOC: existen esas vistas).
- **Leer la página con un robot es "acceso automatizado"** (sección 9). Recomendación (INFERENCIA): en F5, **no sincronizar estados con el navegador**; el operador marca "vendido/arrendado" o pega la URL, y el sistema solo lee la URL del aviso recién publicado en la ventana que el operador tiene abierta.

## 5. Medios

- **Fotos:** *Add photos* sube desde el computador (DOC). Máximo de fotos por propiedad: los blogs dicen **50** (pista; NO VERIFICADO). Formatos, peso y proporción: NO VERIFICADO (la doc de socios pide JPEG o PNG de al menos 500×500 y hasta 8 MB, pero es para catálogos de socios, no para el formulario: no aplica directo).
- **Video:** no se mencionó en la doc leída. AgentSales ya decide usar solo fotos en Marketplace (`04-formato`).
- **Cómo subir con Playwright (DOC):** `locator.setInputFiles(rutas)` sobre un `<input type=file>` (acepta varias rutas o un buffer en memoria con `name`, `mimeType` y `buffer`). La tabla de "actionability" dice que `setInputFiles` **no hace ninguna comprobación** (ni visible ni habilitado), así que sirve sobre un input oculto (INFERENCIA). Si el input se crea solo al hacer clic, se espera el evento: `const fc = page.waitForEvent('filechooser')` antes del clic y luego `(await fc).setFiles(rutas)`.
- **Origen de los archivos (INFERENCIA):** el worker descarga de R2 las fotos fijadas en la publicación (las mismas 4:3 de Portal) a una carpeta temporal y las sube desde el disco; se borran al terminar.

## 6. Límites

- **Avisos por día:** el artículo "Facebook Marketplace listing limits" **no se mostró** (no aplica a la región de la consulta, EE. UU.). La cifra para Chile: NO VERIFICADO. Los blogs hablan de límites para cuentas nuevas y de bloqueos temporales (pista).
- **Spam (DOC, Normas comunitarias):** no se permite publicar ni crear contenido, **de forma manual o automática, con frecuencia muy alta**; Meta puede restringir cuentas que actúan con menos frecuencia si hay otras señales, como **contenido repetitivo**.
- **Integridad de la cuenta (DOC):** Meta puede pedir información adicional sobre una cuenta (verificación) cuando se usa **por medios automatizados, como scripts**, salvo que sea por vías autorizadas.
- **Títulos y descripción:** largos máximos del formulario: NO VERIFICADO. (En la API de socios: título 200 y descripción 9.999, de la que se muestran 256 caracteres; no aplica directo.)
- **Implicación (INFERENCIA):** el "máximo N avisos por día" del ADR-0004 va con un valor bajo por defecto (por ejemplo 3 por corredor y día) y **nunca** el mismo aviso dos veces; una sola publicación por aviso y cuenta (ya lo garantiza `planPublications`).

## 7. Errores comunes y señales de detención

El sistema solo **detecta y se detiene**: deja la publicación en `failed` con el motivo, guarda una captura y avisa. Nunca reintenta solo, nunca resuelve, nunca espera a que "se pase".

| Señal | Cómo se reconoce (para detenerse) | Fuente |
|---|---|---|
| Sin sesión | La URL del formulario redirige a `/marketplace/` o a `/login…`; aparece un campo de contraseña | Observado (redirección y formulario de login sin sesión); `/login` en la URL: INFERENCIA |
| Checkpoint o verificación | La URL contiene `/checkpoint/`, `two_step_verification`, `/two_factor/`, `/recover/` o `/confirmemail`; o el texto habla de confirmar identidad, actividad inusual o cuenta bloqueada | NO VERIFICADO (no hay doc oficial de esas URLs; los textos son pistas de foros) |
| Captcha | Un `iframe` de captcha o un texto que pide demostrar que no es un robot | NO VERIFICADO |
| Marketplace no disponible | El formulario no aparece y la página dice que Marketplace no está disponible o que el acceso está limitado | DOC (existen esos estados); el texto exacto, NO VERIFICADO |
| Formulario distinto | No se encuentra un control esperado por rol y nombre en el tiempo previsto (Meta cambió la página) | INFERENCIA |
| Aviso rechazado | Aparece en *Needs attention* después de publicar | DOC |
| Ventana cerrada | El evento `close` de la página o del contexto antes de terminar | DOC (Playwright) |

Regla de diseño (INFERENCIA): **lista blanca, no lista negra**. Antes de cada paso se comprueba que la URL sea la esperada (`/marketplace/create/…`) y que el formulario esté presente; cualquier otra cosa detiene el flujo, aunque no calce con ningún patrón conocido.

## 8. Cómo probar sin riesgo

- **No hay sandbox de Marketplace** (INFERENCIA: ninguna doc lo menciona).
- **Usuarios de prueba de Meta (DOC):** Meta **suspendió temporalmente** la creación de usuarios de prueba (página actualizada el 2026-04-17); además, un usuario de prueba solo interactúa con otros usuarios de prueba y con personas con rol en la app, y lo que genera solo lo ven ellos. La doc no menciona Marketplace; que un usuario de prueba pueda usar Marketplace: NO VERIFICADO y poco probable (Marketplace pide adulto, cuenta activa y no nueva, sección 2). **No sirven** para F5.
- **Borradores:** si el formulario guarda borradores (automáticamente o con un botón): NO VERIFICADO (solo pistas de baja calidad). Es clave: un formulario lleno y abandonado podría quedar como borrador en la cuenta.
- **Propuesta: `pnpm fb:smoke --broker <slug>` (lo corre el operador con su sesión; no publica):**
  1. Abre el perfil persistente del corredor con ventana visible. Si no hay sesión, se detiene y le pide al operador iniciarla a mano en esa ventana; no sigue hasta que vuelva a correrlo.
  2. Va a `/marketplace/create/` y luego al formulario de propiedad; guarda captura (`page.screenshot({ fullPage: true })`) y el **snapshot de accesibilidad** (`page.ariaSnapshot()`, o `locator.ariaSnapshot({ mode: 'ai' })` del formulario) en `tmp/fb-smoke/`. Esto basta para escribir los selectores por rol y nombre **sin llenar nada**.
  3. Con `--fill` (segunda corrida, opcional): llena el formulario con datos **inventados** de una propiedad de prueba y sube 2 fotos sintéticas; guarda captura y snapshot de nuevo, **sin hacer clic en *Next* ni en *Publish***.
  4. Espera a que el operador cierre la ventana (`context.on('close')`). Si aparece cualquier señal de la sección 7, guarda captura y termina.
  5. El operador revisa si quedó un borrador en *Selling* y lo borra a mano.
- **Primera publicación real:** con la cuenta de Vinny, un aviso de prueba claramente marcado, hecho con el flujo de F5 y el clic final del operador; se borra al terminar (como en F3 y F4). Solo con instrucción explícita en el chat.

## 9. Riesgos y términos

- **Condiciones del servicio (DOC, vigentes desde el 2025-01-01):** "You may not access or collect data from our Products using automated means" (sin permiso previo), aunque se haga con sesión iniciada. Además prohíben intentar eludir medidas técnicas que Meta usa para controlar el acceso, y Meta puede suspender o deshabilitar cuentas por ello. Las **Condiciones de recolección automatizada de datos** exigen permiso escrito expreso de Meta para cualquier recolección automatizada (DOC).
- **Lectura del riesgo (INFERENCIA, no es asesoría legal):** el texto apunta a acceder y **recolectar datos** con robots. Llenar un formulario propio con la sesión del dueño, a ritmo humano y con el clic final humano, no está nombrado de forma explícita, pero Playwright **sí es un medio automatizado** que accede a la página y Meta se reserva restringir cuentas por automatización (Integridad de la cuenta, sección 6). Leer estados de la página con el robot cae más claramente dentro de "recolectar". **El riesgo recae sobre la cuenta personal del corredor**: advertencia, verificación, Marketplace limitado o cuenta deshabilitada. Por eso: clic final humano, pocos avisos por día, sin lectura automática de estados, y detención ante cualquier verificación.
- **Acceso de terceros (DOC):** no compartir la clave ni dar acceso a la cuenta a otros. El modelo "Vinny opera la cuenta del corredor" (F7, ofrecerlo a corredores) es un riesgo propio: lo correcto es que el corredor inicie sesión y haga el clic final en su máquina (INFERENCIA). Pregunta para el operador.
- **Políticas de comercio (DOC):** prohíben la **discriminación**, incluida la de **avisos de vivienda** (raza, nacionalidad, religión, edad, sexo, orientación sexual, identidad de género, situación familiar, estado civil, discapacidad, entre otras); los avisos que no ofrecen nada en venta; y los servicios (salvo excepciones). Incumplir puede rechazar avisos y suspender el acceso a Marketplace; reincidir, medidas sobre la cuenta. El artículo de discriminación en Marketplace lista además la **presencia de niños** (DOC). Implicación: los `requisitos_arriendo` no pueden decir "sin niños", "no se aceptan extranjeros" ni nada parecido; la revisión editorial ya lo pide (`04-formato`), conviene reforzarlo para Marketplace.
- **Aviso rechazado (DOC):** se puede pedir revisión desde *Profile status* hasta 180 días después; con la primera infracción a veces se puede quitar la advertencia (sin recuperar el aviso).
- **Cambios de la página:** el HTML cambia sin aviso. Mitigación (DOC, Playwright): localizadores por rol, etiqueta y texto (`getByRole`, `getByLabel`, `getByText`), que la doc recomienda frente a CSS y XPath, que "se atan a la estructura del DOM". Los nombres visibles dependen del **idioma de la cuenta** (INFERENCIA): los selectores van por idioma, en un solo módulo.
- **Datos personales:** las capturas y snapshots pueden contener el nombre del corredor, su foto y mensajes de Messenger visibles en la barra. Van a `tmp/` (fuera de git) y no se suben a R2 (INFERENCIA).

## 10. Fuentes (consultadas el 2026-10-09)

Centro de ayuda de Facebook (versión que se muestra en EE. UU., sin sesión):

- Cómo funciona Marketplace — https://www.facebook.com/help/1889067784738765
- Marketplace (portada del tema) — https://www.facebook.com/help/1713241952104830
- Sell something on Facebook Marketplace — https://www.facebook.com/help/561376580709359
- Edit your Facebook Marketplace listing — https://www.facebook.com/help/514314075439323
- Mark an item as sold — https://www.facebook.com/help/1680504982210398
- Delete your Facebook Marketplace listing — https://www.facebook.com/help/811868760104511
- How long do my Facebook Marketplace listings stay active? — https://www.facebook.com/help/976748741431731
- Facebook Marketplace listing limits ("no aplica a tu región") — https://www.facebook.com/help/811082570742714
- Who can use Facebook Marketplace (incluye la lista de países, con Chile) — https://www.facebook.com/help/1968285150185577
- What to do if your listing is rejected — https://www.facebook.com/help/2193854224216494
- Marketplace access at risk, limited or suspended — https://www.facebook.com/help/972392066266648
- Things that can't be listed for sale — https://www.facebook.com/help/130910837313345
- Discrimination policies for listings — https://www.facebook.com/help/393315407906249
- Hide my listings from my friends (no aplica a inmuebles) — https://www.facebook.com/help/1096431074294038
- Hide listings (lado del comprador) — https://www.facebook.com/help/555063762810811
- Buy and sell responsibly — https://www.facebook.com/help/1156544111079919
- Need help with Facebook Marketplace — https://www.facebook.com/help/826051554426654

Políticas y condiciones de Meta:

- Commerce Policies — https://www.facebook.com/policies_center/commerce/
- Terms of Service (vigentes desde el 2025-01-01) — https://www.facebook.com/terms.php
- Automated Data Collection Terms (vigentes desde el 2024-10-07) — https://www.facebook.com/legal/automated_data_collection_terms
- Community Standards: Spam — https://transparency.meta.com/policies/community-standards/spam/
- Community Standards: Account Integrity — https://transparency.meta.com/policies/community-standards/account-integrity/

Meta for Developers:

- Marketplace Platform — https://developers.facebook.com/docs/marketplace/
- Marketplace Partnerships — https://developers.facebook.com/docs/marketplace/partnerships/
- Marketplace Partner Item API — https://developers.facebook.com/docs/marketplace/partnerships/itemAPI
- Real Estate Ads (actualizada el 2022-06-29) — https://developers.facebook.com/docs/marketing-api/real-estate-ads
- Test Users (actualizada el 2026-04-17) — https://developers.facebook.com/docs/development/build-and-test/test-users

Páginas públicas de Marketplace (observadas sin sesión):

- Property Rentals en Santiago — https://www.facebook.com/marketplace/santiago/propertyrentals/
- Home Sales en Santiago (redirige a `/marketplace/` sin sesión) — https://www.facebook.com/marketplace/santiago/propertyforsale/
- Formulario de propiedad (redirige a `/marketplace/` sin sesión) — https://www.facebook.com/marketplace/create/rental
- Un aviso de arriendo público (estructura, sin datos personales en esta nota) — `https://www.facebook.com/marketplace/item/<id>/`

Playwright (doc vigente: 1.64; el proyecto usa 1.63.0):

- BrowserType (`launchPersistentContext`) — https://playwright.dev/docs/api/class-browsertype
- BrowserContext (evento `close`) — https://playwright.dev/docs/api/class-browsercontext
- Page (`waitForURL`, `waitForEvent`, eventos `close` y `filechooser`, `screenshot`) — https://playwright.dev/docs/api/class-page
- Locator (`setInputFiles`, `ariaSnapshot`) — https://playwright.dev/docs/api/class-locator
- Auto-waiting (comprobaciones por acción) — https://playwright.dev/docs/actionability
- Input (subir archivos) — https://playwright.dev/docs/input
- Locators — https://playwright.dev/docs/locators
- Aria snapshots — https://playwright.dev/docs/aria-snapshots
- Browsers (canal `chrome`) — https://playwright.dev/docs/browsers
- Authentication (el estado del navegador es sensible) — https://playwright.dev/docs/auth
- Release notes — https://playwright.dev/docs/release-notes

Pistas (no oficiales, solo orientan; nada de la nota descansa solo en ellas sin decirlo): guías de RentRedi, Rentec Direct, Landlord Studio, ButterflyMX y DoorLoop sobre arriendos en Marketplace (campos, 50 fotos, dirección pública o privada); Olhar Digital (2020, campos en Brasil); Substack "cómo vender en Marketplace" (tipos de aviso en español); Realcomp, AutoSweet y Auction123 (fin de los catálogos de socios en 2021 y de las Páginas en 2023).

## 11. Playwright: lo que usará F5 (DOC salvo que se diga)

- **Perfil persistente:** `chromium.launchPersistentContext(dir, { headless: false })`. Un proceso por perfil a la vez (los navegadores no permiten dos instancias con el mismo directorio): el worker toma un **candado por corredor** antes de abrir (INFERENCIA). Nunca el perfil del Chrome del usuario.
- **Canal:** por defecto, el Chromium que trae Playwright (la doc dice que suele ser la mejor opción; ya está instalado para el render de F2). `channel: 'chrome'` usa el Chrome instalado; la doc lo recomienda para códecs de medios o políticas de empresa, que aquí no aplican (INFERENCIA). Decisión del operador, no un recurso para "parecer humano".
- **Localizadores:** `getByRole`, `getByLabel`, `getByText`, `getByPlaceholder`; la doc prioriza los de rol y desaconseja CSS y XPath.
- **Subir fotos:** `setInputFiles` (sin comprobaciones de visibilidad) o `waitForEvent('filechooser')` + `setFiles`.
- **Esperar al operador:** `page.waitForURL(/\/marketplace\/item\/\d+/, { timeout })` para detectar el aviso publicado (que sea esa la URL de destino: NO VERIFICADO), o `page.waitForEvent('close')` / `context.on('close')`. `waitForURL` y `waitForEvent` **no tienen tope por defecto** ("Defaults to 0 - no timeout", salvo que se fije uno) y aceptan `signal` (`AbortSignal`, desde 1.62). `waitForEvent` **falla si la página se cierra antes** del evento. Hay que fijar un tope (por ejemplo 30 minutos) y tratar el cierre como "el operador abandonó" (INFERENCIA).
- **Si el operador cierra la ventana:** el contexto emite `close` (también si el navegador se cae); el navegador del contexto persistente se cierra con él. La publicación vuelve a un estado que permita reintentar o cancelar, sin publicar nada (INFERENCIA; encaja con `awaiting_manual_confirm → failed/cancelled` de `01-arquitectura.md`).
- **Evidencia:** `page.screenshot({ fullPage: true })` y `page.ariaSnapshot()` / `locator.ariaSnapshot({ mode: 'ai' })` (en 1.63 existe además `ariaSnapshotJSON()`; `page.getByRef()` llega en 1.64).
- **macOS:** la doc leída no trae advertencias sobre el modo con ventana en macOS ni sobre perfiles persistentes más allá de las citadas. NO VERIFICADO: permisos de macOS (por ejemplo, que la ventana se abra desde el worker en segundo plano).

## 12. Implicaciones para F5

**Qué automatizar (INFERENCIA, dentro del ADR-0004):**

1. Abrir el perfil del corredor con ventana visible, con un candado por corredor y un límite diario bajo.
2. Comprobar la sesión: ir al formulario de propiedad y verificar URL y formulario (lista blanca). Cualquier otra cosa → detener, captura, `failed` con motivo y aviso al operador.
3. Elegir tipo de propiedad y operación, y llenar precio, dormitorios, baños, m², ubicación (comuna, o dirección solo si `show_exact_address`), título y descripción, con pausas cortas entre campos.
4. Subir las fotos fijadas de la publicación (descargadas de R2 a un temporal).
5. Pasar a `awaiting_manual_confirm`, guardar captura y snapshot, y **soltar el control**.

**Dónde termina la automatización:** el sistema **no** hace clic en *Publish*. Recomendación: tampoco en *Next*, porque la pantalla siguiente (dónde publicar, grupos) es una decisión del corredor y no está verificada; el operador revisa, hace *Next* y *Publish*. El sistema espera la URL `/marketplace/item/<id>` con tope; si no la ve, el operador pega el enlace (`03-plataformas.md` ya lo prevé). Editar, marcar arrendado o vendido, renovar y borrar quedan **a mano** en F5, con recordatorios en el panel.

**Lo que el operador debe confirmar con su sesión (`fb:smoke`):**

1. Que existe el tipo "propiedad" y su URL (`/marketplace/create/rental`?), y si en Chile hay **venta** además de arriendo.
2. Campos, opciones de tipo de propiedad, obligatorios y textos de cada control (snapshot de accesibilidad), en el idioma de su cuenta.
3. Moneda (¿solo CLP?), cómo se ingresa la ubicación (¿comuna o dirección?, ¿se puede ocultar?), largo máximo de título y descripción, y máximo de fotos.
4. Qué hay entre *Next* y *Publish* (grupos, vista previa, "también en tu perfil").
5. Si el formulario guarda borradores, y si un formulario abandonado deja algo en *Selling*.
6. Adónde lleva *Publish* (¿URL del aviso?), si el aviso queda "en revisión", y cómo se ve en *Your listings*.
7. Si un teléfono de WhatsApp en la descripción se ve con sesión o hace rechazar el aviso.

**Preguntas para el operador:**

1. **¿Quién inicia sesión?** Las Condiciones prohíben dar acceso a la cuenta a otros. ¿En F5 se prueba solo con tu cuenta y, al ofrecerlo a corredores (F7), cada corredor inicia sesión y hace el clic en su propio equipo?
2. **UF:** si Marketplace solo acepta CLP, ¿se convierte la UF a pesos al publicar (con qué valor de la UF), o el precio va en pesos y la UF en el texto?
3. **Venta:** si en Chile no hay "Home Sales", ¿las propiedades en venta se omiten en Marketplace o se publican de otra forma?
4. **Clic en *Next*:** ¿lo hace el sistema o el operador? (Recomendación: el operador.)
5. **Límite diario por corredor** (recomendación: 3) y si se acepta no sincronizar estados de forma automática.
6. **Navegador:** ¿Chromium de Playwright (recomendado, ya instalado) o el Chrome instalado (`channel: 'chrome'`)?
7. **WhatsApp en la descripción:** ¿se mantiene al final del texto de Marketplace mientras no se confirme cómo lo trata Facebook?
