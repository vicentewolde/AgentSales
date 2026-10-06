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
- [ ] (Para terceros, en F7) Verificación del negocio y App Review de `instagram_business_content_publish`

## En paralelo, antes de F4 (Portal Inmobiliario)

- [ ] Crear tu cuenta en Portal Inmobiliario / Mercado Libre Chile y revisar qué plan o créditos exige publicar un inmueble
- [ ] Crear una app en el portal de developers de Mercado Libre Chile
- [ ] Anotar `ML_APP_ID` y `ML_CLIENT_SECRET` en `.env`
- [ ] Instalar `cloudflared` por si el redirect OAuth exige HTTPS público

## Antes de F5 (Marketplace)

- [ ] Perfil de Facebook personal con Marketplace habilitado (sin restricciones previas)
- [ ] Definir el límite diario de publicaciones con el que te sientas cómodo (sugerido: 3)

## Antes de F7 (terceros)

- [ ] API key de Anthropic en console.anthropic.com, con límite de gasto mensual
- [ ] Textos simples de términos de uso y privacidad
- [ ] Primer corredor piloto confirmado
