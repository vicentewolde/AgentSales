# 07 · Checklist de cuentas y trámites (tareas del operador)

Cosas que **solo tú puedes hacer** (cuentas, aprobaciones, datos reales). Claude Code no las hace. Marca cada una al completarla. Las primeras son necesarias para F0; las demás pueden avanzar en paralelo mientras se desarrolla.

## Antes de F0

- [x] Node.js 26 instalado (`node -v`; ADR-0008)
- [x] pnpm 11 instalado (`npm i -g pnpm@11` o `brew install pnpm`; Node 26 ya no trae corepack)
- [x] Git configurado con tu nombre y correo
- [x] ffmpeg instalado (`ffmpeg -version`). Desde F2 debe ser **8.1 o más nuevo**, con ffprobe (viene con él): arma las fotos HEIC del iPhone. `pnpm -s cli doctor` lo revisa; si es viejo, `brew upgrade ffmpeg` (verificado 9.0.1 el 2026-10-03)
- [x] Claude Code instalado y con sesión iniciada con tu plan Max (`claude` → `/status`)
- [x] Repositorio en GitHub: `AgentSales`. Público desde 2026-09-30, con protección de `main`: el merge exige el check `check` de la CI
- [x] Proyecto en Neon (plan gratis, región AWS São Paulo) — pasos en `docs/09-alta-neon-r2.md`
  - [x] Copiar a `.env`: `DATABASE_URL` (conexión **directa**, sin `-pooler`, terminada en `?sslmode=require`)
- [x] Cuenta de Cloudflare con R2 activado (pide tarjeta: retención temporal de US$5, sin cobro dentro del plan gratis)
  - [x] Bucket privado `agentsales-media`
  - [x] Token S3 con permiso "Object Read & Write" limitado a ese bucket
  - [x] Copiar a `.env`: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
- [x] Generar `APP_ENCRYPTION_KEY`: 44 caracteres aleatorios alfanuméricos con tu gestor de contraseñas (o `openssl rand -base64 32`)

## Antes de F1

Hecho el 2026-10-02: 3 propiedades de muestra (P001, P002 y P003, corredor `agentsales-pruebas`), usadas en las demos de F1.

- [x] Llenar `data/plantillas/plantilla_propiedades.xlsx` con 3 propiedades distintas y guardarla como `data/muestras/propiedades.xlsx`
- [x] Fotos y videos en `data/muestras/medios/P001/`, `P002/` y `P003/` (al menos una con video)
- [x] Llenar la hoja **Corredor** con tu marca de prueba, y poner el logo PNG en `data/muestras/medios/_marca/logo.png`

## Antes de F2 (contenido)

- [x] La CLI de Claude con sesión de tu plan (2026-10-03, con `claude auth login`): `claude auth status` debe decir `"loggedIn": true` (si no, abre `claude` y usa `/login`). `pnpm -s cli doctor` también lo revisa.
- [x] Una vez, en tu terminal: `pnpm llm:smoke` (2026-10-03: salida estructurada correcta, modelo `claude-sonnet-5`). Hace una sola llamada corta con un aviso inventado (descuenta del plan) y confirma que la CLI responde la salida estructurada. Cuéntale a Claude el resultado que imprime.
- [x] El Chromium de Playwright (instalado el 2026-10-03; desde F2-T09; una descarga de ~150 MB a `~/Library/Caches/ms-playwright`): `pnpm --filter @agentsales/media exec playwright install chromium`. Hay que repetirlo cuando se actualice Playwright; `pnpm -s cli doctor` lo marca como error si falta

## En paralelo, antes de F3 (Instagram) — empieza pronto, es lo más lento

- [x] Confirmar que tu Instagram es cuenta **profesional** (Empresa o Creador): lo es, categoría Emprendedor y vinculada a la página de Facebook AgentSales (2026-10-02)
- [x] Crear cuenta de desarrollador en developers.facebook.com
- [x] Crear una app de tipo **Empresa** y agregar el producto **Instagram** (API con inicio de sesión de Instagram): app `AgentSales-IG`
- [x] Agregar tu cuenta de Instagram como **tester** de la app y aceptar la invitación desde Instagram (aceptada el 2026-10-02). En la web en inglés: *Settings → App website permissions → Apps and websites → Tester Invites* (atajo: instagram.com/accounts/manage_access/)
- [x] Anotar el ID y la clave de la app de Instagram en `.env` (2026-10-03); renombrados a `INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET` (2026-10-05). Son el "Identificador de la aplicación de Instagram" y su clave (Casos de uso > Administrar mensajes y contenido en Instagram > Personalizar > Configuración de la API con el inicio de sesión de Instagram), no el identificador general de la app
- [x] Agregar al caso de uso los permisos `instagram_business_basic` e `instagram_business_content_publish` (pestaña "Permisos y funciones"; quedan "Listo para prueba", 2026-10-05)
- [x] Probar la dirección de retorno local: Meta rechaza `http://localhost` (2026-10-05). En F3 la cuenta se conecta con el token del botón **Generate token** (paso 2 de esa pantalla, con tu cuenta como tester de Instagram)
- [x] (2026-10-06: `✓`, Meta descargó la portada de P001 al instante; cuenta @vicentewoldec conectada con el token de Generate token) Antes de la prueba en `live` (demo de F3): con la cuenta conectada, `pnpm ig:smoke` en tu terminal. Le pide a Instagram que prepare una portada desde un enlace temporal de R2 y espera, **sin publicar nada** (lo preparado vence solo en 24 h). Cuéntale a Claude lo que imprime: `✓` o el código del error
- [x] Prueba en `live` de la demo de F3 (2026-10-06): P002 publicada en @vicentewoldec (carrusel y reel), borrada a mano y marcada como retirada
- [ ] Desde el 2026-10-07 a las 16:31 (hora de Chile): el refresco del token (cuéntale a Claude y lo corre contigo); falta también confirmar si la portada del reel fue el cuadro del segundo 1
- [ ] (Para terceros, en F8) Verificación del negocio y App Review de `instagram_business_content_publish`: ver "Antes de F8"

## En paralelo, antes de F4 (Portal Inmobiliario)

Detalle en `docs/integraciones/mercadolibre.md` (§2, §3 y §8) y en el spec F4 (§4.2, D15). Nada de esto bloquea empezar F4: hasta T09 todo se prueba con simulaciones; T10 (`ml:smoke`) necesita la cuenta conectada.

- [x] Crear tu cuenta en Mercado Libre Chile (mercadolibre.cl) con tus datos reales: la app solo se puede crear con los datos del titular validados
- [x] Crear una app en el DevCenter de Mercado Libre (developers.mercadolibre.cl > Mis aplicaciones > Crear nueva aplicación; antes pide **vincular** la cuenta). Hecho el 2026-10-08: "AgentSales VW Portal", con Refresh Token marcado y las unidades Mercado Libre y VIS (detalle en la nota, §3.2.1):
  - [x] Dirección de retorno (redirect URI): el panel **rechaza** `https://localhost/oauth/mercadolibre/callback`; quedó `https://agentsales.test/oauth/mercadolibre/callback` (`.test` no existe en internet), anotada también en `ML_REDIRECT_URI`. `http://` no sirve (Mercado Libre lo exige y `.env` la rechaza)
  - [x] **PKCE desactivado** (si se activa, Mercado Libre lo exige y F4 no lo usa)
  - [x] Scopes de lectura, escritura y `offline_access` (el flujo "Refresh Token"), y el permiso funcional "Publicación y sincronización" en lectura y escritura (se comprueba al conectar: sin `write` y `offline_access` la conexión falla con `ML_PERMISSION_DENIED`)
  - [x] Unidades Mercado Libre y VIS (Vehículos, Inmuebles y Servicios), sin Mercado Pago
- [x] Anotar `ML_APP_ID` y `ML_CLIENT_SECRET` en `.env`, y `ML_REDIRECT_URI` solo si registraste otra dirección que la de por defecto (`https://agentsales.test/oauth/mercadolibre/callback` desde el 2026-10-08) (nunca se pegan en el chat). `pnpm -s cli doctor` avisa si falta el par y muestra la dirección de retorno que usa. `ML_SITE_ID` ya no se usa (el sitio es fijo, Chile): si la tienes con `MLC` se ignora, y con otro valor `.env` da error; puedes borrarla
- [x] Revisar el precio del paquete de publicación de inmuebles (`silver`): `ml:smoke` (2026-10-08) leyó 31 paquetes de 30 días, desde 5 publicaciones a 1,32 (precio sin moneda, probablemente UF) hasta 24.000; tu cuenta no tiene ninguno (nota §12.4). **No se paga** (tu decisión, 2026-10-08): la simulación lo toma como advertencia (D14) y la prueba real usa un usuario de prueba (D15)
- [ ] Confirmar que el corredor `agentsales-pruebas` tiene WhatsApp en la hoja Corredor: Mercado Libre lo exige y sale en el aviso (D5). La copia de Google Sheets lo tiene; falta que llegue a la base (reimportar la planilla con la hoja Corredor completa)
- [x] Conectar la cuenta (2026-10-08: `VICENTEWOLDE`, cuenta `normal`, al corredor `agentsales-pruebas`, con `offline_access`, `read`, `write` y `urn:ml:{all,mktp,vis}:publish-sync:/read-write`): `pnpm -s cli accounts connect mercadolibre --broker <slug>` (con `pnpm dev` corriendo), autorizar con la cuenta administradora, copiar la dirección que queda con error de conexión y correr `pbpaste | pnpm -s cli accounts connect mercadolibre --broker <slug> --url-stdin`
- [ ] Usuario de prueba de Mercado Libre para la prueba en `live` (D15). Paso a paso revisado en la doc el 2026-10-09 (detalle en la nota, §8 punto 2). La clave del usuario de prueba va **solo a tu gestor de claves**: nunca al chat, al repo ni a los logs.
  1. [ ] **Crear el usuario.** Mercado Libre lo crea con el token de tu cuenta real, que AgentSales guarda cifrado. Córrelo en la terminal de tu Mac, desde `~/dev/AgentSales` (no necesita `pnpm dev`): `pnpm ml:test-user --broker agentsales-pruebas`. Primero vacía tu portapapeles (así revisa que funciona). Muestra el id y el apodo (`TESTUSER…`) y deja la clave en el portapapeles. Pega de inmediato la clave, el id y el apodo en tu gestor de claves. No se pueden recuperar: si los pierdes, se crea otro (hasta 10 por cuenta). Si pasa 60 días sin uso, Mercado Libre lo borra
  2. [ ] **Entrar con el usuario de prueba** a mercadolibre.cl en una **ventana privada** (así no se mezcla con tu cuenta real). Si pide verificar el correo, el código son los últimos 6 dígitos del id (si no sirve, los últimos 4)
  3. [ ] **Registrarlo como inmobiliaria**, en esa ventana: Ayuda > Configuración de mi cuenta > Registrarme como empresa, concesionaria e inmobiliaria > Como inmobiliaria
  4. [ ] **Pedir la activación a soporte** en su formulario (el enlace está en la nota, §10): tu correo y tu nombre (ahí llega la respuesta), organización "AgentSales (pruebas, Chile MLC)", Requerimiento **"Activar usuario"**, "ID de usuario a activar" = el id del usuario de prueba y "¿Registraste este usuario como inmobiliaria?" = Sí. La doc no dice cuánto tarda. Cuéntale a Claude la fecha para anotarla en ESTADO
  5. [ ] **Contratar el paquete sin cargo**, cuando soporte confirme: con el usuario de prueba (ventana privada), Mi perfil > Ventas > Resumen > Paquetes de publicación > Contratar (o mercadolibre.cl/seller-packs/publications). Elige uno chico de "Publicaciones Plata" y confirma; sin destaques. Con el usuario de prueba no se cobra: **confirma que el total sea $0; si aparece un precio, detente.** **Nunca lo hagas con tu cuenta real: ahí sí cobra.** Si no ves la sección, la activación aún no llega
  6. [ ] **Conectarlo al corredor `agentsales-pruebas`** (reemplaza tu cuenta real en ese corredor; para volver, la reconectas igual). Con `pnpm dev` corriendo: `pnpm -s cli accounts connect mercadolibre --broker agentsales-pruebas`. Si el enlace se abre solo en tu navegador de siempre, ciérralo sin autorizar y pégalo en la ventana privada del usuario de prueba. Autoriza, copia la dirección completa que queda con error de conexión (vale 10 min) y corre `pbpaste | pnpm -s cli accounts connect mercadolibre --broker agentsales-pruebas --url-stdin`
  7. [ ] **Verificar** en **Cuentas** del panel (o `pnpm -s cli accounts`): Mercado Libre de `agentsales-pruebas` conectada con el apodo `TESTUSER…`, no `VICENTEWOLDE`. Después, `pnpm ml:smoke --listing P001`: con el paquete, Mercado Libre ya revisa el aviso completo (cuéntale a Claude lo que imprime)
- [x] `pnpm ml:smoke` (F4-T10), corrido el 2026-10-08: no publica nada; lo leído quedó en la nota de Mercado Libre (§12). El aviso de prueba usó un contacto de muestra porque el corredor aún no tiene WhatsApp

## Antes de F5 (Marketplace)

- [ ] Perfil de Facebook personal con Marketplace habilitado (sin restricciones previas): en Facebook, Perfil → Estado del perfil → Marketplace. Es tu propia cuenta (spec F5, D2): Meta pide una sola cuenta por persona y no dar acceso a otros, y si restringe la automatización, la restricción cae sobre ella
- [x] Límite diario de publicaciones: 3 por cuenta (spec F5, D8; 2026-10-09)
- [ ] Token de la API BDE del Banco Central para el valor de la UF (gratis, inmediato; `docs/integraciones/uf.md` §3.1): crear la cuenta en la BDE, en la página de la API aceptar los términos y pulsar "Activar el uso de la API", copiar el token en "Mi Cuenta" → "Apikey Token" y dejarlo en `.env` como `BCCH_API_TOKEN` (con `pbpaste`; no me lo muestres). Dura 1 año: anota cuándo vence. Con el lote B, `pnpm uf:smoke`
- [ ] Que el corredor `agentsales-pruebas` tenga **3 arriendos de casa o departamento** en la planilla: el formulario de Marketplace es solo de arriendo y solo ofrece los tipos Casa y Apartamento o piso (entre los tuyos). Las ventas no van a Marketplace: Facebook en Chile solo tiene el formulario de arriendo (confirmado el 2026-10-13)
- [x] `pnpm fb:smoke --broker agentsales-pruebas --menus` (2026-10-13): guardó el formulario real ("Nueva vivienda", solo de arriendo, sin menú de operación) y el menú de tipos que abriste a mano
- [x] Con el lote C (la CLI, con `pnpm dev` corriendo): `pnpm -s cli accounts connect marketplace --broker agentsales-pruebas` (conectada el 2026-10-14 como "Facebook de Vinny"). Se abre una ventana de Chromium: inicias sesión a mano (también la verificación, si la pide) y la CLI espera hasta ver la sesión (hasta unos 11 min). Abre Facebook aunque estés en simulación: no publica nada

## Antes de F6 (calendario y seguimiento)

- [ ] Cliente de Postgres para el respaldo local de la base (spec F6 §4.11, nota `docs/integraciones/neon-backup.md`): `brew install libpq`. Queda en `/opt/homebrew/opt/libpq/bin` (no entra solo al `PATH`); con el lote del respaldo, `doctor` dice si sirve y si su versión alcanza a la de Neon
- [ ] Saber que el calendario funciona **con el worker encendido** (`pnpm dev`): lo programado con el worker apagado sale al encenderlo si el atraso es de 12 h o menos; si no, queda "atrasado" esperando tu decisión (spec F6, D2)

## Antes de F7 (terceros)

- [x] API key de Anthropic en console.anthropic.com, en `.env` como `ANTHROPIC_API_KEY` (2026-10-17; vence el 2026-12-31). Al crearla: sin vencimiento, o anota la fecha y renuévala antes (una clave vencida da `LLM_AUTH_REQUIRED` en la IA de los corredores). Después, `pnpm llm:smoke --provider anthropic-api` (gasta centavos)
- [ ] **Límite de gasto mensual en la consola de Anthropic** (Settings → Limits): el tope por corredor de AgentSales solo cubre lo que AgentSales anota; el de la consola corta todo si algo se dispara
- [ ] **Un corredor en Instagram (D16, evaluador de Meta):** en developers.facebook.com, tu app `AgentSales-IG` → Roles de la app → Roles → agregar a la persona como **Instagram Tester** con su usuario de Instagram (su cuenta debe ser profesional). Ella acepta en Instagram (web: *Configuración → Permisos de apps y sitios web → Invitaciones de evaluador*, atajo instagram.com/accounts/manage_access/). Después, **en persona y en tu Mac**, abre en el panel de Meta la pantalla de **Generate token**, que la persona inicie sesión con su Instagram, copia el token y córrelo como hoy: `pbpaste | pnpm -s cli accounts connect instagram --broker <slug> --token-stdin`. Antes de publicar en vivo, `pnpm ig:smoke --broker <slug>` (que Meta acepte la cuenta de un evaluador es NO VERIFICADO)
- [ ] Primer corredor piloto confirmado

## Antes de F8 (en internet)

Spec: `docs/specs/fase-8-en-internet.md` (modo demo en Fly.io con Neon gratis, en `agentsales.agentpey.com`). Ningún secreto va al chat: los pegas tú con `pbpaste` o en el panel de cada servicio.

**Antes del lote B (desarrollo separado de producción, §4.6):**
- [x] **Rama `dev` en Neon** (2026-10-18) (consola de Neon → Branches → New branch, desde la principal) y su `DATABASE_URL` directa en el `.env` del Mac. La de hoy pasa a `.env.production` (archivo nuevo en la raíz, fuera de git)
- [x] **Otra `APP_ENCRYPTION_KEY` para desarrollo** en `.env` (2026-10-18) (la de hoy se queda en `.env.production` y en tu gestor de claves: sin ella no se leen los tokens de producción)
- [x] **`pnpm db:dev-scrub`** (2026-10-18: borró las 2 credenciales copiadas, Instagram y Portal) (con la rama y la clave nueva en `.env`, **antes de cualquier `pnpm dev`**): borra las credenciales copiadas en la rama y deja esas cuentas desconectadas, así el Mac nunca renueva el token de Mercado Libre de producción. Usa solo `.env` (con `ENV_FILE` se niega), compara con `.env.production` sin mostrarlo y se niega si la base o la clave son las mismas, o si la clave de `.env` abre alguna credencial (sería producción). Muestra la base (sin contraseña) y cuántas cuentas borra, y pregunta (`--yes` para no preguntar). Correrlo dos veces no hace nada la segunda. Para usar una cuenta en desarrollo, se conecta de nuevo (con la clave de desarrollo)
- [x] **Bucket `agentsales-media-dev`** (2026-10-18; `pnpm storage:check` pasó; la regla de CORS: solo `PUT`, con las cabeceras `content-type` y `x-amz-checksum-sha256`) en R2 con su token "Object Read & Write" limitado a él, en `.env`; y en los dos buckets una **regla de CORS** que acepte `PUT` desde el panel (`http://localhost:5173` en el de desarrollo y `https://agentsales.agentpey.com` en el de producción). `pnpm storage:check` la revisa

**Al terminar el lote B (subidas directas a R2):**
- [x] `pnpm db:dev-scrub` (arriba), y después **`pnpm storage:check`** de nuevo (2026-10-18: pasó entero; R2 rechazó el contenido alterado con 400, otro largo con 403, y el CORS respondió 204): ahora también sube con una URL prefirmada, comprueba que R2 rechaza un archivo alterado (lo NO VERIFICADO de la nota de R2) y revisa la regla de CORS desde `http://localhost:5173`
- [ ] **El bucket de producción:** `ENV_FILE=.env.production pnpm storage:check --origin https://agentsales.agentpey.com` (revisa su CORS con el dominio; no toca la base)
- [ ] **Una carga real de prueba desde el panel** (F8-T07, con `pnpm dev` y el bucket de desarrollo): Claude avisa antes de levantar `pnpm dev`

**Antes del primer despliegue (T21):**
- [ ] **Cuenta de Fly.io** con tarjeta (cobra por segundo encendido: unos US$ 0,56 por día de demo) y su token de despliegue en los secretos de GitHub (`FLY_API_TOKEN`)
- [ ] **El subdominio:** en el DNS de `agentpey.com` (Vercel → Domains) el registro que pida Fly para `agentsales.agentpey.com` (`CNAME` o `A`/`AAAA`, y el de validación del certificado). No toca tu otro proyecto
- [ ] **Bucket `agentsales-backups`** en R2 con su token propio limitado a él (solo lo tiene el worker)
- [ ] **Los secretos del servidor** en Fly (`fly secrets set`, la lista está en `docs/10-despliegue.md`): los de `.env.production`, `PUBLIC_URL=https://agentsales.agentpey.com` y `LLM_PROVIDER=anthropic-api`. `PUBLISH_MODE` queda en `dry-run`
- [ ] **Direcciones de vuelta:** en la app de Meta `AgentSales-IG`, `https://agentsales.agentpey.com/api/oauth/instagram/callback`, y las de quitar la app y borrar datos (`…/api/meta/deauthorize` y `…/api/meta/data-deletion`); en la app de Mercado Libre, `https://agentsales.agentpey.com/api/oauth/mercadolibre/callback` como segunda dirección
- [ ] **Límite de gasto mensual en la consola de Anthropic** (Billing → Spend limits; hoy no hay)

**Meta (para el App Review; F8 cierra con la solicitud enviada, D5):** detalle en `docs/integraciones/instagram.md` §13
- [ ] **Verificación del negocio** en Business Manager (hasta 14 días hábiles). Si puedes hacerla como persona natural es NO VERIFICADO: crea el negocio con tus datos reales y pulsa "Iniciar verificación" para ver qué documentos pide para Chile (quizás inicio de actividades en el SII)
- [ ] **Verificación de acceso como proveedor técnico** (Tech Provider, unos 5 días), después de la anterior
- [ ] **App Review** de `instagram_business_basic` e `instagram_business_content_publish`: ícono de 1024x1024, categoría, correo de contacto, la URL de privacidad, un video por permiso con el flujo real en el dominio, una llamada exitosa por permiso en los 30 días previos, y el corredor y el usuario de demostración para el revisor
- [ ] **Términos de uso y política de privacidad** revisados y aprobados por ti (los borradores los deja T18; conviene que un abogado los revise por la Ley 21.719)

**Anthropic:**
- [x] Términos comerciales revisados por el subagente (`docs/integraciones/anthropic-terminos.md`): tu clave puede atender a los clientes de tu producto, sin revender el servicio. Opcional: escribirle a Anthropic para confirmar el cobro por aviso y si una persona natural puede ofrecerlo a terceros
