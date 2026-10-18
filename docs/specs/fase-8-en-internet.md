# Spec F8 · En internet

- **Estado:** **Aprobado** el 2026-10-18 (D1, D2, D4 y D5 las respondió el operador; el resto, con su aprobación permanente)
- **Rama base:** `main`
- **Tag al cerrar:** `v1.0.0`
- **Referencias:** `docs/06-roadmap.md#f8--en-internet`, `docs/ESTADO.md` (deuda "Para F8"), `docs/07-checklist-cuentas.md` ("Antes de F8"), ADR-0005, ADR-0007, ADR-0017, ADR-0021, ADR-0022 y ADR-0023, ADR-0024 a ADR-0026 (nuevos), `docs/01-arquitectura.md` (Seguridad, Cola de trabajos, almacenamiento), `docs/integraciones/hosting.md` (nueva), `docs/integraciones/instagram.md` y `docs/integraciones/anthropic-terminos.md` (nueva)

## 1. Objetivo
AgentSales queda en internet, en `https://agentsales.agentpey.com` (D2), primero **en modo demo** (D1: el servidor se enciende los días en que se muestra la herramienta, casi sin costo) y listo para quedar siempre encendido cuando decidas pagar el plan: el operador y los corredores entran al panel desde cualquier lugar, la CLI del operador habla con el servidor, las cargas suben directo a R2, el calendario y los respaldos corren en el servidor con el Mac apagado, y un corredor conecta su Instagram con el inicio de sesión de Instagram de verdad (con la app enviada a revisión de Meta). El login se endurece para internet. Es el MVP completo (`v1.0.0`).

## 2. Alcance
- **Un servidor en internet** en Fly.io, São Paulo (D1: encendido solo los días de demo, con Neon gratis), en el subdominio `agentsales.agentpey.com` (D2) con HTTPS automático: la API y el worker en la nube, en una sola imagen (D7); el panel compilado lo sirve la API en el mismo dominio, con la API bajo `/api` (D6). `NODE_ENV=production`; el host, el panel y los orígenes salen de una sola variable, `PUBLIC_URL` (§4.2).
- **Producción y desarrollo separados** (D3): producción usa la base de Neon de hoy; el desarrollo en el Mac pasa a una rama de Neon y a un bucket de R2 propios, para que `pnpm dev` nunca toque lo real ni compita por los trabajos.
- **Desplegar a pedido del operador** (D8): un flujo de GitHub Actions que él dispara, solo desde `main` con la CI en verde; aplica las migraciones antes de arrancar la versión nueva. Claude nunca despliega.
- **Subidas directas a R2** (ADR-0025, deuda de F1): el panel y la CLI suben la planilla y los medios con URLs prefirmadas; la carga guarda claves de R2; se quitan `POST /imports/local`, la subida `multipart` por la API y el disco compartido entre la API y el worker. Tope del tamaño descomprimido del xlsx.
- **La CLI contra el servidor** (D11): `agentsales login --api https://<dominio>` guarda la dirección con la sesión; `import` sube a R2; `status` y `doctor` revisan el servidor. Los scripts que hablan directo con la base eligen su archivo de entorno (`ENV_FILE`, D12).
- **Respaldos fuera del Mac** (D13): el worker de la nube vuelca la base cada día a un bucket de R2 aparte, los verifica y deja los últimos 14; `/health` y `doctor` muestran el último.
- **Login para internet** (ADR-0026): límites por IP en entrar, aceptar invitaciones y la API en general; doble factor opcional con una app de códigos (TOTP), sin dependencias nuevas; cookie `__Host-` con `Secure`; cabeceras de seguridad. RLS evaluado y no adoptado (D16).
- **Instagram de verdad** (D5, D18): el administrador conecta el Instagram de un corredor con el botón del panel (OAuth en el dominio); el `state` sirve una vez; las vueltas de Meta para quitar la app y para borrar los datos; el operador envía la app a App Review con lo que pide Meta.
- **Páginas públicas** (D19): términos de uso, política de privacidad e instrucciones para borrar los datos, en el dominio y sin login (borradores que el operador revisa y aprueba).
- **Mercado Libre** (D20): la vuelta automática del OAuth en el dominio (el pegado de la dirección queda para desarrollo).
- **Marketplace en producción** (D4, tu respuesta): **a mano para todos**, también tus corredores (ADR-0023). En producción el formulario automático queda apagado y las cuentas de perfil pasan a "a mano"; el formulario automático sigue para el desarrollo en tu Mac.
- **Deuda que se cierra** (detalle en §4.13): CORS, cookie `__Host-` y el inicio del OAuth en el mismo host (F7); el `state` de Instagram de un solo uso, el inicio tras un prefijo y el tope de `tokens.refresh` (F3); `NODE_ENV=production`, subidas a R2, sin `/imports/local` ni staging compartido, el tope del xlsx descomprimido (F1); el `auto_publish` cortado por un reinicio y la pausa sin `byListing` (F6); el build de producción sin tests; Playwright en la API; `--broker` con `slugify` solo en la CLI (desaparece con `/imports/local`).

## 3. Fuera de alcance
- **Correo saliente** (invitaciones, recuperar contraseña): sigue el enlace que copia el operador.
- **Varias instancias de la API o del worker**, balanceo y escalado automático: una de cada una alcanza para el piloto (los límites por IP viven en memoria, ADR-0026).
- **Monitoreo con alertas** (correo o teléfono cuando algo falla): los logs del proveedor y `agenda`/`doctor`; un monitor externo gratis queda como opción del operador (§4.9).
- **Cobrar a los corredores**, planes y facturación.
- **Campos propios por corredor** y la marca `ai_visible` (después del MVP, spec F7 D7).
- **Iniciar sesión con Google** u otro proveedor; doble factor por SMS o llave física.
- **La prueba en vivo de Portal** (D15 de F4) y la de F6: siguen como pendientes tuyos, solo con tu instrucción en el chat. Con ellas se cierra la deuda de `relist` y `pictures`.
- **Publicar en vivo** en cualquier plataforma: F8 deja todo listo en simulación; pasar a `live` es una instrucción tuya (D9).
- **Partir el bundle del panel** (512 kB, 157 kB comprimido): aceptable en internet; queda en la deuda.
- **Respaldo de los medios en R2** (F6 lo dejó para el despliegue): R2 guarda los archivos con su propia durabilidad; una copia a otro lugar queda para después del MVP.
- **`publications` sin propiedad con un listado global** (deuda de la CLI) y lo menor de F5: siguen en la deuda.

## 4. Diseño

### 4.1 Componentes
| Componente | Cambio |
|---|---|
| `packages/config` | `PUBLIC_URL`, `API_HOST`, `CLIENT_IP_HEADER`, `ENV_FILE`, `BACKUP_TARGET` y las reglas de producción (§4.2); el TOTP (RFC 6238 con `node:crypto`) y base32; el propósito `totp` en la derivación de claves |
| `packages/core` | La carga con entradas en R2 (`requestImportUpload`, `startImport`) y el estado `awaiting_upload`; el doble factor (`enableTotp`, `confirmTotp`, `disableTotp`, el login en dos pasos, códigos de recuperación); el borrado de datos que pide Meta (`handleDataDeletion`, `handleDeauthorize`); el `auto_publish` pendiente al arrancar; la pausa con `byListing` (F6) |
| `packages/db` | Migraciones `0010` (cargas), `0011` (doble factor y pedidos de borrado de Meta) y `0012` (el latido del worker) (§4.12); `db:dev-scrub` (borra las credenciales de una base que no es la de producción, §4.6); repositorios; `runBackup` sigue volcando a una carpeta (la subida a R2 es del job, §4.9) |
| `packages/storage` | `signedUploadUrl` (PUT prefirmado con tamaño, tipo y sha256), `list` por prefijo; `pnpm storage:check` revisa también el CORS del bucket |
| `packages/importers` | Leer la planilla y los medios desde R2 (zip o carpeta subida archivo por archivo); el tope del xlsx descomprimido antes de exceljs |
| `apps/api` | Sirve el panel (`apps/web/dist`) y monta la API bajo `/api`; `hostGuard`, orígenes y cookies desde `PUBLIC_URL`; cabeceras de seguridad; límites por IP (`rate-limit.ts`, en memoria: no es de core); rutas de subida a R2; el login en dos pasos y el doble factor; las vueltas de Meta; la vuelta de Mercado Libre; escucha en `API_HOST` |
| `apps/worker` | Lee las cargas desde R2; sube el respaldo a R2 (una segunda instancia de `MediaStorage`); en producción no registra el formulario automático de Marketplace (D4); reintenta el `auto_publish` cortado; el presupuesto de `tokens.refresh` |
| `apps/cli` | `login --api`, la dirección guardada con la sesión; `import` con subida a R2; `status`/`doctor` contra el servidor; el código del doble factor al entrar |
| `apps/web` | Subida a R2 con avance; doble factor (activar, entrar, códigos); conectar Instagram y Mercado Libre con un botón; páginas públicas de términos, privacidad y borrado de datos |
| Raíz | `Dockerfile`, `.dockerignore`, `tsconfig.build.json` por app, configuración del proveedor (D1), `.github/workflows/deploy.yml` (a pedido), `docs/10-despliegue.md` (guía del operador) |

### 4.2 Configuración para internet (D6, D12)
- **`PUBLIC_URL`** (por ejemplo `https://agentsales.cl`): la dirección pública, sin ruta ni barra final. Con `NODE_ENV=production` es obligatoria y `https://`; en desarrollo no se usa (todo sigue como hoy, con `localhost`).
- De ella salen, sin otra variable:
  - `allowedHosts` = su host (y nada más: `hostGuard` rechaza cualquier otro, también la IP del servidor);
  - `allowedOrigins` = ella misma (el `Origin` del panel);
  - `panelUrl` = ella misma (el enlace de invitación, la vuelta de los OAuth);
  - `INSTAGRAM_REDIRECT_URI` y `ML_REDIRECT_URI` por defecto: `<PUBLIC_URL>/api/oauth/instagram/callback` y `…/mercadolibre/callback` (se pueden fijar a mano; en producción deben empezar con `PUBLIC_URL`).
- **`API_HOST`**: `127.0.0.1` por defecto; en producción `0.0.0.0` (el proxy del proveedor termina el HTTPS y reenvía).
- **`CLIENT_IP_HEADER`**: la cabecera con la IP del cliente que pone el proxy del proveedor (D1). Sin ella, la IP es la del socket. Solo la usan los límites por IP; nunca se confía en `X-Forwarded-For` sin configurarla.
- **`ENV_FILE`** (D12): los scripts que hablan directo con la base (`auth:admin`, `db:migrate`, `db:backup`, `ig:smoke`, `ml:smoke`, `ml:test-user`, `uf:smoke`, `eval:content`, `fb:smoke`) leen `.env` o el archivo que diga `ENV_FILE` (por ejemplo `ENV_FILE=.env.production pnpm auth:admin --email …`). `.env.production` vive en el Mac del operador, fuera de git, y Claude no lo lee (como `.env`).
- **Reglas de producción** (`loadEnv` las revisa al arrancar): `PUBLIC_URL` con `https://`, `API_HOST` explícito, `LLM_PROVIDER` distinto de `claude-cli` (los términos del plan Max no permiten usarlo en un servidor que atiende a terceros, D4), `BACKUP_TARGET=r2` y sus credenciales (D13), y sin `BROWSER_PROFILES_DIR` (el formulario automático de Marketplace no corre en producción, D4). `/health` informa el ambiente (`environment`: `production` o `development`) para que `doctor` avise si la CLI apunta a otro que el esperado, sin leer archivos de entorno.

### 4.3 La API en internet (D6, D7, ADR-0024)
- **Un solo origen y el prefijo `/api`:** hoy la API no tiene prefijo (Vite lo quita con `rewrite` y la CLI llama sin él). Desde T02, `server.ts` monta `new Hono().route("/api", createApp(…))` **en los dos modos** (sin cambiar `AppType`); Vite deja de quitar el prefijo; la CLI llama a `<dirección>/api`; la tabla de permisos (`access.ts`) quita el prefijo antes de comparar (así `/api/auth/login` y `/api/health` siguen públicas), con un test. En producción, además, la API sirve `apps/web/dist`. Una ruta del panel (`/corredores`, `/entrar`…) que no es archivo devuelve `index.html`; `/api/*` nunca cae ahí (un `/api/x` que no existe es 404 JSON). Los archivos con hash del build van con caché larga e `immutable`; `index.html`, sin caché.
- **Sin CORS** (cierra la deuda de F7): la API no responde `Access-Control-Allow-*` a nadie. El panel es del mismo origen y la CLI no es un navegador. Un test fija que un `OPTIONS` de un origen ajeno no recibe permisos, y que `Authorization` nunca aparece en `Access-Control-Allow-Headers`.
- **Cookies:** con `PUBLIC_URL` `https://`, la sesión es `__Host-agentsales_session` (`Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, sin `Domain`), y una cookie de `state` por proveedor, `__Host-agentsales_oauth_ig` y `__Host-agentsales_oauth_ml` (`Lax`, `Path=/`: hoy la de Instagram usa `Path=/oauth`, que el prefijo no admite), para que dos conexiones no se pisen. La de Mercado Libre la pone `authorize-url` (hoy no pone ninguna). El nombre de la cookie de sesión se configura en un solo lugar y lo usan `authenticate` y `originGuard`. En desarrollo, los nombres de hoy.
- **El inicio del OAuth** sale de la ruta de la URI de retorno (cierra "tras un prefijo", F3): `/api/oauth/instagram/start` en el mismo host que el panel, así la cookie `Strict` viaja (cierra la deuda de ADR-0022).
- **Cabeceras de seguridad** (`secureHeaders` de Hono, sin dependencias): `Strict-Transport-Security` (1 año), `Content-Security-Policy` propia del panel (`default-src 'self'`; imágenes y videos también desde el dominio de R2 de las URLs prefirmadas; `connect-src 'self'` más R2 para la subida; `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` (ninguna dirección del panel sale en el `Referer` hacia otros sitios). El origen de R2 de la CSP (`https://<bucket>.<cuenta>.r2.cloudflarestorage.com`, la forma de las URLs prefirmadas) sale de la configuración, porque cambia entre desarrollo y producción, y cubre `img-src`, `media-src` y `connect-src`.
- **`hostGuard` y el chequeo del proveedor:** el chequeo de salud puede llegar con otro `Host` (NO VERIFICADO): `GET /api/health` queda fuera de `hostGuard` (sin sesión no revela nada), y se prueba al desplegar.
- **Vueltas de servidor a servidor:** `/api/meta/*` y `GET /api/oauth/*/callback` quedan fuera de `csrfGuard` y `originGuard` (Meta manda un formulario sin `Origin`; las protege su firma o su `state`), con un test.
- **`/health`** para el proveedor: sin sesión, solo `status`, `publishMode` y `environment` (§4.2) (como desde F7; la versión de Postgres ya es solo del administrador: la deuda de F6 queda cerrada).
- **Un solo proceso de la API** (§3): los límites por IP en memoria lo suponen (ADR-0026).

### 4.4 Subidas directas a R2 (ADR-0025)
- **Flujo:**
  1. `POST /api/imports/uploads` (sesión) con el nombre y tamaño de la planilla y, si hay, de los medios: un zip, o la lista de archivos de una carpeta (ruta relativa y tamaño), más `dryRun` si es una simulación. La planilla y los archivos de una carpeta de hasta 100 MB llevan su sha256; el zip, solo su tamaño (el navegador no puede calcular el sha256 de 4 GB sin tenerlo entero en memoria; el worker valida el zip al abrirlo). La API crea la carga en `awaiting_upload` con su corredor y su `broker` (como F7) y responde una URL prefirmada de PUT por archivo (válida 6 h, firmada con su tamaño y, si lo trae, su sha256; 1 h no alcanzaba para un zip grande o 500 archivos en una conexión lenta). Que R2 respete el sha256 en un PUT prefirmado quedó verificado con `storage:check` (T03, 2026-10-18: 400 con otro contenido).
  2. El panel o la CLI suben cada archivo directo a R2 (`imports/<importRunId>/xlsx/<nombre>`, `…/media.zip` o `…/media/<ruta>`).
  3. `POST /api/imports/:id/start`: la API lista `imports/<id>/` en R2 (una llamada, en vez de un `head` por archivo), revisa que estén todos con su tamaño y encola `import.run` (`queued`). Si falta uno: `IMPORT_UPLOAD_INCOMPLETE` con los que faltan. Empezar una carga ya en cola la vuelve a encolar con la misma `singletonKey` (repara una que quedó sin job por un corte).
- **Topes:** `MAX_IMPORT_UPLOAD_MB` por archivo, también el zip (hoy 512; nunca más de 4 GB, que es además el tope descomprimido del zip, como F1, y el de la suma de una carpeta); una carpeta hasta 500 archivos. La planilla, hasta 10 MB comprimida y **50 MB descomprimida** (se revisan las entradas del zip con yauzl antes de abrirla con exceljs: `IMPORT_XLSX_TOO_LARGE`). Un archivo de la carpeta con una ruta con `..`, absoluta o con caracteres de control se rechaza al pedir la subida.
- **El worker** lee la planilla y los medios desde R2 (en streaming, a su carpeta temporal), con los lectores de hoy (zip y carpeta); al terminar la carga (bien o mal) borra `imports/<id>/`. Una carga que queda en `awaiting_upload` más de 24 h se cierra como `failed` (`IMPORT_UPLOAD_ABANDONED`) y se borran sus objetos (`publications.watch`, cada hora).
- **Simulación:** `--dry-run` de la CLI usa el mismo flujo con `dryRun` (el worker lee y valida sin escribir, como hoy); no hay un segundo camino en la CLI.
- **Se quitan** `POST /imports` (`multipart`), `POST /imports/local`, `uploads` de la API y el staging compartido (`tmp/imports`). La CLI siempre sube (también contra la API local), así hay un solo camino.
- **Las cargas de antes** (`input` con `xlsxPath` y `mediaDir`) se siguen leyendo: `importRunInputSchema` (core) es una unión de las dos formas, y las viejas nunca se reintentan.
- **R2:** el bucket necesita una regla de CORS que acepte `PUT` desde `PUBLIC_URL` (y desde el panel local en el bucket de desarrollo). La configura el operador (checklist); `pnpm storage:check` la revisa.

### 4.5 La CLI contra el servidor (D11)
- `agentsales login --email <correo> --api https://<dominio>` guarda la dirección junto al token en `~/.agentsales/cli-session.json` (`0600`); sin `--api`, la local de hoy. Toda llamada usa esa dirección más `/api`. Solo `https://`, salvo `localhost` y `127.0.0.1`.
- `AGENTSALES_API_URL` manda sobre la guardada (para una prueba puntual); `whoami` muestra a qué servidor está conectada.
- `import <xlsx> --media <carpeta|zip>` sube con §4.4 y muestra el avance; `--dry-run` sube y simula en el worker (§4.4).
- `status` y `doctor`: con un servidor remoto, `doctor` revisa lo del servidor (`/health` con el detalle del administrador) y del Mac solo lo que la CLI usa; lo que es del worker (ffmpeg, Chromium, `pg_dump`) lo reporta el servidor.
- El doble factor: si la cuenta lo tiene, `login` pide el código (§4.8).

### 4.6 Producción y desarrollo (D3)
- **Producción:** la base de Neon de hoy (tiene los corredores, las cuentas con sus tokens cifrados con `APP_ENCRYPTION_KEY` y la bitácora), el bucket `agentsales-media` y la misma `APP_ENCRYPTION_KEY` (sin ella, los tokens no se pueden leer).
- **Desarrollo:** una rama de Neon (`dev`, copia de la de hoy al crearla) y un bucket `agentsales-media-dev` con su token. El `.env` del Mac apunta a ellos; `.env.production` (solo para los scripts, D12) a producción. Así `pnpm dev` no compite con el worker de la nube por los trabajos ni toca lo real.
- **Los tokens de la rama:** la rama copia las cuentas con sus tokens cifrados. Si el worker del Mac los leyera, `tokens.refresh` rotaría el token de Mercado Libre e invalidaría el de producción (ADR-0015). Por eso el desarrollo usa **otra `APP_ENCRYPTION_KEY`** y, al crear la rama, se borran las credenciales de `platform_accounts` en ella (paso del checklist, con un script `db:dev-scrub` que solo corre contra una base que no es la de producción).
- **Neon sigue en el plan gratis** mientras el servidor esté en modo demo (D1): con el worker apagado, el cómputo de Neon se duerme. Los 100 CU-h del mes los comparten producción y la rama de desarrollo (son del proyecto): el worker de la nube encendido todo el día gasta unos 6 al día.

### 4.7 Desplegar (D7, D8)
- **Una imagen** (`Dockerfile` en la raíz, Node 26 sobre Debian): ffmpeg estático fijado por versión y sha256 (el mismo de la CI), Chromium de Playwright, `pg_dump` del cliente de Postgres de la versión de Neon (PGDG), y las apps compiladas sin tests (`tsconfig.build.json`, deuda de F1). Dos procesos de la misma imagen: `api` y `worker`. Así la dependencia de la API en `@agentsales/media` deja de importar (deuda de F7).
- La imagen lleva `pnpm-workspace.yaml` (lo busca `findWorkspaceRoot`) y `data/plantillas/` (la planilla de cada corredor).
- `.dockerignore` deja afuera `.env*`, `data/muestras/`, `tmp/`, `node_modules/` y los perfiles.
- **La CI** construye la imagen en cada PR (sin publicarla) para que un cambio que la rompa no llegue a `main`.
- **Desplegar** (`.github/workflows/deploy.yml`, `workflow_dispatch`): lo dispara el operador desde GitHub o con `gh workflow run deploy`; solo corre desde `main` con el último `CI / check` en verde; construye, aplica `db:migrate` (las migraciones son aditivas: la versión anterior sigue funcionando mientras arranca la nueva) y reemplaza la API y el worker. El token del proveedor vive en los secretos de GitHub (lo pone el operador).
- **Secretos del servidor:** los pone el operador en el proveedor (nunca en git ni en la imagen); `docs/10-despliegue.md` lista cuáles.
- **Apagado:** el proveedor manda SIGTERM y espera al menos 45 s (el worker espera 30 s a sus trabajos, §4.10).

### 4.8 Login para internet (ADR-0026)
- **Límites por IP** (puerto `RateLimiter`, en memoria): `POST /auth/login` y el segundo paso, 10 por minuto y 50 por hora por IP; `POST /auth/invitations/accept`, 10 por hora por IP; toda la API, 300 por minuto por IP (con sesión, además por usuario). Al pasarse: 429 `RATE_LIMITED` con `Retry-After`. El bloqueo por usuario de F7 (10 fallos, 15 min) sigue.
- **Doble factor (TOTP)** opcional por usuario, recomendado para el administrador (`doctor` avisa si el administrador no lo tiene):
  - Activar: el panel muestra la clave (base32) y el enlace `otpauth://` (se abre en la app de claves del teléfono o se copia a mano; sin código QR, que pediría una dependencia), y el usuario confirma con un código. Recibe 10 códigos de recuperación una vez (se guardan solo sus hashes).
  - Entrar: con la contraseña correcta y el doble factor activo, la API responde `totp_required` con un desafío de un solo uso (5 min, solo su hash en la base); `POST /auth/login/totp` con el código (o uno de recuperación) crea la sesión. Un código ya usado no sirve otra vez (se guarda el último paso). Los fallos del segundo paso cuentan para el bloqueo.
  - La clave se guarda cifrada con `SecretBox` (propósito `totp`). Desactivarlo pide un código. Restablecer el acceso de un usuario (F7) también le quita el doble factor; `pnpm auth:admin` se lo quita al administrador (tiene la base: es la salida si pierde el teléfono).
- **Sesiones:** sin cambios (30 días, 7 sin uso). Cambiar la contraseña o el doble factor cierra las demás sesiones.

### 4.9 Respaldos fuera del Mac (D13)
- **El job `db.backup`** del worker de la nube: `runBackup` hace el mismo `pg_dump -Fc` y `pg_restore --list` de F6 en una carpeta temporal, y el job lo sube con una segunda instancia de `MediaStorage` a un bucket aparte (`agentsales-backups`, con un token "Object Read & Write" limitado a ese bucket que solo tiene el worker; R2 no tiene tokens de solo escritura y borrar los viejos pide listar), con su sha256; deja los últimos 14. El estado (`estado-respaldo.json`, el mismo esquema) va al bucket principal, en `system/`, que la API ya lee. `BACKUP_TARGET=r2|local` (en producción, `r2`). Así `packages/db` no depende del almacenamiento.
- `/health` (detalle del administrador) y `doctor` leen el estado (con caché de 1 min); `stale` a las 48 h, como hoy.
- **En modo demo** (D1) el cron diario solo corre con el servidor encendido; al arrancar, el worker ya pide un respaldo si el último tiene más de 20 h (F6), así que cada día de demo deja uno.
- **`pnpm db:backup`** sigue en el Mac, siempre a la carpeta local aunque el archivo de entorno diga `BACKUP_TARGET=r2` (con `ENV_FILE=.env.production`, respalda producción).
- **Restaurar:** `docs/10-despliegue.md` explica bajar el último y comprobarlo (`pg_restore --list`), y restaurarlo en una rama nueva de Neon. Se prueba una vez en la demo.
- El historial de Neon (depende del plan, D1) es la primera línea; el volcado diario, la segunda.
- **Aviso de fallas:** `agenda` y `doctor` ya muestran un respaldo viejo o fallido; un monitor externo de `/health` (gratis, opcional) avisa si el servidor se cae.

### 4.10 El worker en la nube
- Las colas, los trabajos y el reloj (`publication.due`, `publications.watch`, `tokens.refresh`, `db.backup`) corren sin cambios con el Mac apagado, mientras el servidor esté encendido. En modo demo (D1), lo programado mientras estaba apagado sale al encenderlo si el atraso es de 12 h o menos (F6, D2), y el refresco de tokens corre al arrancar: un token de Instagram vence si pasan 60 días sin encenderlo (`doctor` y la agenda avisan antes).
- **Reinicios** (cada despliegue reinicia el worker): un `auto_publish` cortado por el apagado se retoma al arrancar (las corridas `succeeded` con `auto_publish` pendiente y sin publicaciones nuevas; deuda de F6); lo demás ya se reencola al arrancar (F3 y F6).
- **`tokens.refresh`** con presupuesto de tiempo (deuda de F3): deja de empezar cuentas nuevas pasados 4 min y las que faltan van en la siguiente corrida.
- **La IA:** todos los corredores usan la API de Anthropic en producción (D4), con el gasto anotado y el tope de F7.
- **Chromium y ffmpeg** en la imagen; el `Chromium` del renderizador se abre al primer render, como hoy.
- **Marketplace a mano para todos** (D4): en producción el worker no registra el formulario automático (sin perfiles ni Chromium con ventana); `marketplaceAutomationAllowed` (core) también exige que el ambiente lo permita, así que conectar un perfil, `marketplace.profile` y publicar con una cuenta de perfil responden `MARKETPLACE_AUTOMATION_NOT_ALLOWED`. Las cuentas de perfil que ya existen en la base (por ejemplo, `agentsales-pruebas`) no se migran (una migración también correría en la rama de desarrollo, donde el perfil sigue sirviendo): en producción el panel las muestra como "activa Marketplace a mano" y el administrador las cambia con el botón de F7 (T21); reemplazar un perfil en producción no intenta borrar una carpeta que no existe. En desarrollo todo sigue como en F7.

### 4.11 Instagram y Meta (D5, D18)
- **Conectar con el botón:** en Cuentas, el administrador elige "Conectar Instagram" para un corredor; se abre el inicio de sesión de Instagram (la persona entra con su cuenta, en su teléfono o computador, sin estar en el Mac del operador) y vuelve a `<PUBLIC_URL>/api/oauth/instagram/callback`. Mientras la app de Meta siga en desarrollo, solo funciona con cuentas de evaluadores (Instagram Tester).
- **El `state` de un solo uso** (deuda de F3): el nonce usado va a `oauth_states_used` (como Mercado Libre desde F7).
- **Vueltas de Meta:**
  - *Quitar la app* (`POST /api/meta/deauthorize`, pública, `signed_request` firmado con la clave de la app): la cuenta de ese usuario de Instagram queda `disconnected` y se borran sus credenciales.
  - *Borrar los datos* (`POST /api/meta/data-deletion`, pública, firmada igual): además de lo anterior, borra los datos de esa cuenta de Instagram (`external_account_id`, nombre de usuario, y el enlace y el id externo de sus publicaciones, **sin cambiar su estado**: "retirada" significa borrada en la plataforma, y no lo está), con un evento en la bitácora de cada publicación; anota el pedido en `meta_deletion_requests` y responde `{ url, confirmation_code }`. `GET /api/meta/data-deletion/:code` (pública) muestra una página corta con su estado.
  - Si el `user_id` (con alcance de la app; si coincide con el de `/me` es NO VERIFICADO) no calza con ninguna cuenta, se responde igual con un código y no se borra nada.
  - Una firma inválida responde 400 sin tocar nada. La verificación de la firma (`node:crypto`) va en `packages/config` y la inyecta `server.ts` (la ruta no puede importar `node:*`, por `AppType`). El detalle de lo que pide Meta está en `docs/integraciones/instagram.md` (actualizada el 2026-10-18).
- **La firma de las vueltas:** se acepta con la clave de la app de Instagram o con la de la app de Meta (cuál firma con Instagram Login es NO VERIFICADO, nota §13.4); se prueba quitando la app desde tu cuenta.
- **App Review** (nota §13.1 y §13.5): lo tramita el operador (checklist "Antes de F8"). Del lado del sistema: privacidad, borrado de datos y las dos vueltas en HTTPS; el botón de Instagram con sus pautas de marca; un canal de ayuda y de seguridad visible; un **corredor y un usuario de demostración para el revisor** (creados con la invitación de F7, sin registro público; si Meta rechaza una app cerrada, se decide entonces); una llamada exitosa por permiso en los 30 días previos; el video de cada permiso con el flujo real en el dominio.

### 4.12 Datos (migraciones `0010` a `0012`)
- **`0010` (cargas):** `import_run_status` suma `awaiting_upload` (`ALTER TYPE … ADD VALUE` va en su propia migración, sin usar el valor en la misma transacción); `import_runs.input` (jsonb) suma la forma `{ broker?, dryRun, xlsx: { key, name, size, sha256 }, media: { kind: "zip", key, name, size } | { kind: "folder", prefix, name, files } | null }` (el `name` del zip y de la carpeta, para mostrarlos; `dryRun` repite la columna `dry_run`, que es la que manda), y `importRunInputSchema` (core) es una unión con la de hoy (`xlsxPath`, `mediaDir`, `broker`), que se sigue leyendo y nunca se reintenta. Índice por `status, created_at` para cerrar las abandonadas.
- **`0012` (el worker, T12):** tabla `worker_heartbeats` (proceso y último latido).
- **`0011` (doble factor y Meta):** `users.totp_secret_encrypted`, `users.totp_enabled_at`, `users.totp_last_step`; tabla `user_recovery_codes` (usuario, hash, `used_at`); tabla `login_challenges` (hash, usuario, vence, `used_at`), con borrado de las vencidas en `publications.watch` (como las sesiones); tabla `meta_deletion_requests` (código, `meta_user_id` con su hash, recibido, estado, cuentas afectadas).
- `docs/02-modelo-datos.md` al día en cada tarea.

### 4.13 Deuda que se cierra
| Deuda (de `docs/ESTADO.md`) | Dónde |
|---|---|
| CORS y `Authorization` (F7, ADR-0021) | §4.3, T02 |
| Cookie `__Host-` y `Secure` (F7) | §4.3, T02 |
| `/oauth/instagram/start` en el mismo host que el panel (F7, ADR-0022) | §4.3, T02 |
| Playwright en la API (F7) | §4.7, T10 (una imagen) |
| Vuelta de Mercado Libre con el dominio real (F4/F7) | D20, T19 |
| `panelUrl` y `allowedHosts` fijos en `localhost` (F3/F7) | §4.2, T01 |
| `state` de Instagram de un solo uso (F3) | §4.11, T17 |
| Inicio del OAuth tras un prefijo (F3) | §4.3, T02 |
| Tope de `tokens.refresh` con muchas cuentas (F3) | §4.10, T12 |
| `/health` y la versión de Postgres (F6) | Ya solo del administrador desde F7: se cierra sin código (§4.3) |
| `auto_publish` cortado por el apagado (F6) | §4.10, T12 |
| Pausa de un sync sin `byListing` (F6) | T12 |
| Subidas a R2, sin `/imports/local` ni staging compartido, `NODE_ENV=production` (F1) | §4.4, T03–T09 |
| Tamaño descomprimido del xlsx (F1) | §4.4, T05 |
| `tsc -b` compila tests a `dist` (F1) | §4.7, T10 |
| Hono lee el `multipart` en memoria (F1) | Desaparece con §4.4 |
| `--broker` con `slugify` solo en la CLI (F1) | Desaparece con `/imports/local` (§4.4) |

### 4.14 Contratos (API, ADR-0011)
- `POST /api/imports/uploads` (`{ broker?, dryRun, xlsx, media }`) → `201 { importRun, uploads: [{ kind, name, url, headers }] }` (`kind`: `xlsx`, `zip` o `file`); `POST /api/imports/:id/start` → `202` con la carga en `queued`.
- `POST /api/auth/login` → como hoy, o `{ status: "totp_required", challenge }`; `POST /api/auth/login/totp` `{ challenge, code }`; `POST /api/auth/totp/setup` → `{ secret, otpauthUrl }`; `POST /api/auth/totp/confirm` `{ code }` → `{ recoveryCodes }`; `POST /api/auth/totp/disable` `{ code }`.
- `POST /api/meta/deauthorize` y `POST /api/meta/data-deletion` (públicas, `application/x-www-form-urlencoded` con `signed_request`, fuera del CSRF); `GET /api/meta/data-deletion/:code` (pública, HTML corto).
- `GET /api/oauth/mercadolibre/callback` (pública, la protege el `state` y su cookie, como Instagram).
- Se quitan `POST /imports` (`multipart`) y `POST /imports/local`.
- Códigos nuevos: `IMPORT_UPLOAD_INCOMPLETE` (409), `IMPORT_UPLOAD_ABANDONED`, `IMPORT_XLSX_TOO_LARGE` (413), `RATE_LIMITED` (429), `AUTH_TOTP_INVALID` (401), `AUTH_CHALLENGE_INVALID` (401), `TOTP_ALREADY_ENABLED` (409), `META_SIGNATURE_INVALID` (400).
- Toda ruta nueva entra en la tabla de permisos (`access.ts`, ADR-0022).

### 4.15 Hosting y costos (D1, D2; `docs/integraciones/hosting.md`, 2026-10-18)
- **Neon gratis no alcanza:** el worker consulta la cola sin parar, así que el cómputo de Neon nunca se duerme: unas 182 horas de cómputo al mes contra 100 del plan gratis (se acabarían a los 17 días). **Neon Launch** cobra por uso, sin mínimo: unos **US$ 20 al mes** así, con 7 días de restauración instantánea.
- **Costo mensual estimado** (API de 512 MB y worker de 1 a 2 GB siempre encendidos):

| Opción | Servidor | Total con Neon Launch | Región |
|---|---|---|---|
| **Fly.io** (gestionado, una app con dos procesos) | US$ 17 a 28 | **US$ 37 a 48** | São Paulo (la misma que Neon) |
| **VPS Vultr** (Docker Compose y Caddy; tú lo mantienes) | US$ 20 | **US$ 40** | Santiago |
| VPS Vultr con Postgres en la misma máquina (sin Neon; ADR nuevo que cambia ADR-0007) | US$ 20 | **US$ 21** | Santiago |
| Railway / Render | US$ 10 a 32 | US$ 30 a 52 | Sin región en Sudamérica |
| Cloud Run Santiago | US$ 85 a 90 | US$ 105 a 110 | Santiago |

- **Elegida para F8 (D1, tu respuesta): modo demo en Fly.io** (São Paulo, con Neon gratis): la API y el worker se encienden los días en que muestras la herramienta y se apagan después. Cuesta unos **US$ 0,56 por día encendido** (unos US$ 2 al mes con 4 días de demo) más el disco de las máquinas apagadas (centavos). Pide tarjeta. Encender y apagar son dos comandos tuyos (`docs/10-despliegue.md`), y la API se apaga sola sin tráfico (`auto_stop_machines`; arranca con el primer pedido en unos segundos), así que lo único que hay que acordarse de apagar es el worker. Fuera de los días de demo, nadie puede usar la herramienta.
- **Después (fuera de F8, cuando decidas pagar):** dejar las dos máquinas siempre encendidas y pasar Neon a Launch: es la opción recomendada de la tabla, con la misma imagen y sin cambiar código (un seguimiento de ADR-0007 en ese momento).
- **Por qué no Oracle gratis:** es la única opción de US$ 0, pero hay que administrar la máquina, Oracle puede reclamarla si queda 7 días ociosa (lo que pasa con una demo esporádica), es Arm64 y migrar después cuesta más (`hosting.md` §13).
- **Cuando se pague, la recomendada:** Fly.io en São Paulo con Neon Launch. HTTPS y certificado automáticos, secretos, la migración antes de arrancar (`release_command`), sin sistema operativo que parchear, y la base al lado. El tamaño del worker (1 o 2 GB) se elige midiendo el pico de una preparación con reel (T10).
- **Con Fly:** `CLIENT_IP_HEADER=Fly-Client-IP`; el worker sin servicio HTTP (no se apaga solo); `kill_timeout` de 45 s; el despliegue con `flyctl` y un token en los secretos de GitHub.
- **Dominio (D2, tu respuesta):** `agentpey.com` es tuyo y lo usa otro proyecto: AgentSales va en el subdominio **`agentsales.agentpey.com`**, con un registro `CNAME` (o `A`/`AAAA`) en el DNS de Vercel que apunta a Fly, y el certificado de Fly para ese nombre. No cuesta nada y no toca el otro proyecto: las cookies `__Host-` de AgentSales no tienen `Domain`, así que nunca llegan a `agentpey.com`. Una ruta como `agentpey.com/agentsales` no sirve: el sitio del otro proyecto tendría que reenviar el tráfico, y el login, las cookies y las vueltas de los OAuth necesitan la raíz del nombre. Sirve también para App Review (es un dominio tuyo, no de una plataforma ajena).
- **R2, certificados y el reloj de los trabajos:** US$ 0 (R2 dentro del plan gratis; el cron es el de pg-boss, que ya existe).
- `pg_dump` 18 en la imagen sale del repositorio PGDG (Debian solo trae el 17).

### 4.16 Decisiones
- **D1 (tu respuesta, 2026-10-18):** por ahora algo gratis para mostrar la herramienta y después un plan pagado → **Fly.io en modo demo** (encendido los días de demo, unos US$ 2 al mes) con **Neon gratis** (§4.15). Pasar a siempre encendido con Neon Launch (unos US$ 37 a 48 al mes) queda para cuando decidas pagar.
- **D2 (tu respuesta, 2026-10-18):** un nombre bajo `agentpey` → **`agentsales.agentpey.com`** (subdominio de tu dominio; §4.15).
- **D3:** producción en la base y el bucket de hoy; desarrollo en una rama de Neon y un bucket aparte (§4.6). Compartir la base entre `pnpm dev` y el servidor haría que dos workers se roben los trabajos.
- **D4 (tu respuesta, 2026-10-18):** Marketplace **a mano para todos** en producción, también tus corredores (ADR-0023); sin worker en tu Mac (§4.10). La IA de tus corredores pasa a la API en producción en cualquier caso: los términos del plan Max permiten `claude -p` solo para uso propio y no en un servidor que atiende a terceros (`docs/integraciones/anthropic-terminos.md` §6); `claude-cli` queda para el desarrollo en tu Mac.
- **D5 (tu respuesta, 2026-10-18):** F8 se cierra **con la app enviada** a App Review; la aprobación queda como pendiente tuyo. Meta pide tres trámites en cadena (verificación del negocio, hasta 14 días hábiles; verificación como proveedor técnico, unos 5 días; App Review, una semana): unas 5 semanas sin rechazos, y puede exigir una empresa o un inicio de actividades (NO VERIFICADO para una persona natural en Chile). Mientras, los corredores del piloto que publican en Instagram son evaluadores de la app.
- **D6:** mismo origen con la API bajo `/api` en los dos modos: sin CORS, la cookie `Strict` viaja al inicio del OAuth, y el panel no cambia sus llamadas (Vite deja de quitar el prefijo).
- **D7:** una imagen para la API y el worker: un solo build, y la API puede arrastrar Playwright sin costo.
- **D8:** desplegar es del operador (a pedido, desde `main` en verde); Claude prepara y nunca dispara un despliegue (es hablar con una plataforma real).
- **D9:** `PUBLISH_MODE=dry-run` en el servidor hasta que digas lo contrario en el chat; el cambio es una variable del servidor que pones tú.
- **D10:** subidas directas a R2 por un solo camino (panel y CLI, también en local).
- **D11:** la CLI guarda la dirección del servidor con su sesión.
- **D12:** `ENV_FILE` para los scripts que hablan con la base (un `.env.production` en tu Mac).
- **D13:** respaldo diario desde la nube a un bucket aparte con su propio token (solo del worker); el estado en el bucket principal; el de tu Mac sigue.
- **D14:** límites por IP en memoria, en la API (una sola instancia; no es un puerto de core porque core no lo usa).
- **D15:** TOTP sin dependencias y sin QR; códigos de recuperación.
- **D16:** sin RLS (ADR-0026): la separación sigue en la API y los repositorios con sus pruebas; RLS obligaría a envolver cada consulta en una transacción con el corredor fijado, cambiar los 15 repositorios y los jobs, y no protege de un error en la tabla de permisos. Se revisa si llegan muchos corredores o un segundo desarrollador.
- **D17:** cabeceras de seguridad con `secureHeaders` de Hono.
- **D18:** las vueltas de Meta (quitar la app y borrar los datos) con la firma verificada.
- **D19:** términos y privacidad en español como borradores que tú revisas; no son asesoría legal (la nota sugiere que un abogado los revise por la Ley 21.719). La privacidad dice qué datos se guardan y para qué, cómo pedir el borrado, y los proveedores que los procesan (Neon, R2, el hosting y Anthropic); los términos dicen que los textos de la IA se revisan antes de publicar (Anthropic lo pide, `anthropic-terminos.md` §4) y dan el contacto de ayuda y de seguridad.
- **D20:** la vuelta automática de Mercado Libre en el dominio; el pegado de la dirección queda para desarrollo.

### 4.17 ADRs
- **ADR-0024 · En internet:** un dominio, una imagen, la API sirve el panel bajo el mismo origen, la configuración desde `PUBLIC_URL`, producción y desarrollo separados, desplegar a pedido del operador, el respaldo en la nube, y Marketplace a mano para todos en producción (D4). **Modifica a:** ADR-0005 (el worker deja de encenderse solo al desarrollar) y ADR-0017 (punto 8); ADR-0007 sigue (Neon gratis en modo demo) y suma un seguimiento: siempre encendido exige Neon Launch; además cambia la D11 del spec F6 (el respaldo sí va a R2) y la §4.7 del spec F7 (el plan del operador ya no atiende a sus corredores en producción).
- **ADR-0025 · Subidas directas a R2:** URLs prefirmadas, la carga en `awaiting_upload` y sin staging compartido (seguimiento de la enmienda de F1 a ADR-0005).
- **ADR-0026 · Login para internet y sin RLS:** límites por IP en memoria, TOTP opcional, cookie `__Host-`, cabeceras; RLS evaluado y no adoptado (modifica ADR-0021 y el punto 7 de ADR-0022).

### 4.18 Dependencias nuevas
Ninguna en el código: `secureHeaders` y `serveStatic` vienen con Hono, el TOTP con `node:crypto` y el PUT prefirmado con `@aws-sdk/s3-request-presigner`, que ya está (lo usan las URLs de lectura). En la imagen: ffmpeg estático, Chromium de Playwright y `postgresql-client` (no son dependencias de npm).

## 5. Tareas
Lotes (una rama y un PR por lote). Cada lote deja `main` usable en el Mac:
- **A** · configuración y la API en internet: T01–T02 (con el prefijo `/api` también en la CLI)
- **Antes del lote B (tú):** la rama `dev` de Neon, el bucket `agentsales-media-dev` con su token y su regla de CORS, una `APP_ENCRYPTION_KEY` distinta para desarrollo y `pnpm db:dev-scrub` (checklist "Antes de F8")
- **B** · subidas a R2: T03–T07 y T09 (la CLI sube en el mismo lote que quita `/imports/local`, así `main` no queda con la CLI rota)
- **C** · la CLI contra el servidor: T08
- **D** · desplegar: T10–T12
- **E** · respaldos fuera del Mac: T13
- **F** · login para internet: T14–T16
- **G** · Instagram, Meta y páginas públicas: T17–T18
- **H** · Mercado Libre y Marketplace en producción: T19–T20
- T21: primera puesta en marcha (contigo) · T22: cierre

### F8-T01 · Configuración de producción
- **Depende de:** —
- **Archivos:** `packages/config/src/{env.ts,env-file.ts}`, `apps/api/src/{server.ts,security.ts}`, `apps/worker/src/worker.ts`, `.env.example`, `docs/05-convenciones.md`
- **Descripción:** `PUBLIC_URL`, `API_HOST`, `CLIENT_IP_HEADER`, `ENV_FILE` y las reglas de producción (§4.2); `allowedHosts`, `allowedOrigins`, `panelUrl` y las URIs de retorno salen de `PUBLIC_URL` (`internetAccess`, junto a `localAccess`).
- **Hecho cuando:**
  - [ ] Tests: producción sin `PUBLIC_URL`, con `http://`, con ruta o con barra final se rechaza; una URI de retorno de otro host se rechaza; `claude-cli` en producción se rechaza; los hosts y orígenes derivados; desarrollo sin cambios
  - [ ] `ENV_FILE` elige el archivo de los scripts (y uno que no existe da un error claro)

### F8-T02 · La API sirve el panel, con cookies y cabeceras para HTTPS
- **Depende de:** T01
- **Archivos:** `apps/api/src/{app.ts,server.ts,server-app.ts,auth.ts,access.ts,security.ts}`, `apps/api/src/routes/oauth.ts`, `apps/web/vite.config.ts` (sin `rewrite`), `apps/web/src/components/accounts/ConnectBox.tsx`, `apps/web/test/harness.tsx`, `apps/cli/src/api-client.ts` (`/api`), `docs/01-arquitectura.md` (Seguridad)
- **Descripción:** §4.3: el prefijo `/api` en los dos modos (API, Vite, CLI y la tabla de permisos) y el panel estático con su caché en producción, sin CORS, `__Host-` con `Secure` y `Path=/` (una cookie de `state` por proveedor), el inicio del OAuth desde la ruta de la URI de retorno, `secureHeaders` con la CSP del panel, `/api/health` fuera de `hostGuard` y las vueltas fuera del CSRF.
- **Hecho cuando:**
  - [ ] Tests: una ruta del panel devuelve `index.html`, un `/api/x` inexistente 404 JSON, un archivo con hash con `immutable`; `OPTIONS` ajeno sin permisos de CORS; las cookies con `__Host-` y sus atributos con `https://` y las de hoy sin él; las cabeceras presentes; el `Host` ajeno (y la IP) rechazado salvo en `/api/health`; el inicio del OAuth con un prefijo; las rutas públicas bajo `/api` siguen públicas en la tabla de permisos; un `POST /api/meta/*` sin `Origin` no lo frena el CSRF
  - [ ] `pnpm dev` y la CLI local siguen funcionando con el prefijo

### F8-T03 · R2: subida prefirmada y CORS
- **Depende de:** —
- **Archivos:** `packages/storage/src/{r2-storage.ts,index.ts}`, `packages/core/src/ports/` (contrato `MediaStorage`), `packages/core/src/testing/`, `packages/storage/src/scripts/check.ts`, `docs/01-arquitectura.md` (almacenamiento)
- **Descripción:** `signedUploadUrl(path, { contentType, contentLength, sha256, ttlSeconds })` y `list(prefix)`; el doble en memoria; `storage:check` sube con una URL prefirmada (y comprueba que R2 rechaza un contenido con otro sha256: verificado el 2026-10-18) y revisa la regla de CORS del bucket.
- **Hecho cuando:**
  - [x] Tests (sin R2, con el firmador): la URL firma el tamaño y el sha256; `list` pagina; el doble rechaza un contenido distinto
  - [x] `storage:check` lo verifica contra R2 (2026-10-18, bucket de desarrollo: 400 con otro contenido, 403 con otro largo, CORS 204)

### F8-T04 · La carga con entradas en R2 (core y base)
- **Depende de:** T03
- **Archivos:** `packages/core/src/{import-run.ts,use-cases/request-import.ts,use-cases/run-import.ts}`, `packages/db/src/schema.ts`, `packages/db/drizzle/0010_*.sql`, `packages/db/src/repositories/import-runs.ts`, `docs/02-modelo-datos.md`
- **Descripción:** `requestImportUpload` (valida nombres, rutas, tamaños y topes; crea la carga en `awaiting_upload` con su `broker` y `dryRun`), `startImport` (revisa con `list` y encola), cerrar las abandonadas; `importRunInputSchema` como unión con la forma de hoy; la migración `0010` (sin la parte de Marketplace, que es de T20).
- **Hecho cuando:**
  - [x] Tests: rutas con `..`, absolutas o con control rechazadas; topes; falta un archivo (`IMPORT_UPLOAD_INCOMPLETE`); empezar dos veces; abandonada a las 24 h; el corredor de la carga como en F7; una fila de la forma vieja se sigue leyendo

### F8-T05 · El worker lee las cargas desde R2
- **Depende de:** T04
- **Archivos:** `packages/importers/src/{staging.ts,media-folder.ts,zip.ts,xlsx-reader.ts}`, `apps/worker/src/jobs/{import-run.ts,publications-watch.ts}`, `apps/worker/src/worker.ts`
- **Descripción:** bajar la planilla y los medios desde R2 a la carpeta temporal del intento (zip o carpeta), el tope descomprimido del xlsx, borrar `imports/<id>/` al terminar y las abandonadas; se quita el staging compartido.
- **Hecho cuando:**
  - [x] Tests: carga de punta a punta con el doble de R2 (zip y carpeta); un xlsx que se descomprime en más de 50 MB (`IMPORT_XLSX_TOO_LARGE`) sin abrirlo con exceljs; los objetos borrados al terminar y al abandonar; reintento después de un corte

### F8-T06 · La API: pedir la subida y empezar
- **Depende de:** T04
- **Archivos:** `apps/api/src/routes/imports.ts`, `apps/api/src/{access.ts,contracts/,errors.ts}`, `apps/api/src/server.ts`
- **Descripción:** `POST /api/imports/uploads` y `POST /api/imports/:id/start` (§4.14) con el alcance; se quitan el `multipart` y `/imports/local`.
- **Hecho cuando:**
  - [x] Tests: el corredor solo para lo suyo (matriz de F7); la URL y sus cabeceras; empezar con un archivo faltante; las rutas viejas ya no existen; inventario de permisos

### F8-T07 · Panel: subir a R2 con avance
- **Depende de:** T06
- **Archivos:** `apps/web/src/pages/ImportPage.tsx`, `apps/web/src/api/upload.ts` (nuevo)
- **Descripción:** el panel calcula el sha256 (Web Crypto) de la planilla y de los archivos de carpeta de hasta 100 MB (el zip va solo con su tamaño), pide las URLs, sube con avance y reintento por archivo, y empieza la carga.
- **Hecho cuando:**
  - [x] Tests: avance, un archivo que falla se reintenta, cancelar, el error de un archivo faltante
  - [ ] Con `pnpm dev` y el bucket de desarrollo, una carga real de prueba (aviso antes): pendiente (2026-10-18, el primer intento no llegó a subir; la de la CLI, T09, sí pasó contra R2 real)

### F8-T08 · CLI: la dirección del servidor
- **Depende de:** T02
- **Archivos:** `apps/cli/src/{api-client.ts,session.ts,context.ts}`, `apps/cli/src/commands/{login.ts,status.ts,doctor/}`
- **Descripción:** §4.5: `login --api`, la dirección en la sesión, `AGENTSALES_API_URL`, `/api`, solo `https://` salvo local; `doctor` y `status` contra un servidor remoto.
- **Hecho cuando:**
  - [ ] Tests: `http://` remoto rechazado; la dirección guardada y la del entorno; una sesión de F7 (sin dirección) sigue siendo local; `doctor` remoto no revisa ffmpeg en el Mac

### F8-T09 · CLI: `import` sube a R2
- **Depende de:** T06
- **Archivos:** `apps/cli/src/commands/import.ts`, `apps/cli/src/upload.ts`
- **Descripción:** sha256 (de la planilla y de los archivos de carpeta) y subida en streaming de la planilla y del zip, o de cada archivo de la carpeta, con avance; empezar la carga y esperar como hoy; `--dry-run` por el mismo flujo con `dryRun`.
- **Hecho cuando:**
  - [x] Tests (la API en proceso y un R2 en memoria; el `PUT` real contra un servidor local en vez de msw): carpeta y zip; un archivo que falla se reintenta; `--dry-run` pide la carga con `dryRun`

### F8-T10 · Build de producción e imagen
- **Depende de:** T02
- **Archivos:** `Dockerfile` (con `pnpm-workspace.yaml` y `data/plantillas/`), `.dockerignore`, `apps/*/tsconfig.build.json`, `package.json` (`build`), `.github/workflows/ci.yml`
- **Descripción:** §4.7: compilar sin tests, la imagen con ffmpeg (sha256), Chromium y `pg_dump`; la CI construye la imagen y la arranca para pedir `/health` (sin secretos: falla la base y eso se espera, pero el proceso arranca y responde).
- **Hecho cuando:**
  - [ ] `dist` sin archivos de test ni `testing`; la imagen sin `.env` ni `data/muestras`
  - [ ] El panel compilado, servido por `createServerApp` desde la imagen, carga en un navegador sin errores de la CSP en la consola (en el Mac la CSP no se ve: Vite sirve el panel)
  - [ ] La CI construye la imagen en cada PR
  - [ ] El pico de memoria del worker (con ffmpeg y Chromium) medido en una preparación con reel en el Mac, para elegir 1 o 2 GB (aviso antes de `pnpm dev`)

### F8-T11 · El proveedor y el flujo de despliegue
- **Depende de:** T10, D1
- **Archivos:** configuración del proveedor (D1), `.github/workflows/deploy.yml`, `docs/10-despliegue.md`, `CLAUDE.md` (comandos)
- **Descripción:** `fly.toml` con dos procesos (la API con `auto_stop_machines` y el worker sin servicio HTTP), el chequeo de `/api/health`, la migración antes de arrancar (`release_command`), `kill_timeout`, la región `gru`; el flujo a pedido (solo `main` en verde); la guía del operador: crear la app, los secretos, el `CNAME` de `agentsales.agentpey.com` en Vercel y el certificado, desplegar, **encender y apagar para una demo**, ver los logs, volver a la versión anterior, restaurar un respaldo y pasar a siempre encendido con Neon Launch.
- **Hecho cuando:**
  - [ ] El flujo se niega a correr fuera de `main` o con la CI en rojo (probado en una rama de prueba sin el secreto)
  - [ ] La guía revisada por el operador

### F8-T12 · El worker ante reinicios y la deuda de F6
- **Depende de:** —
- **Archivos:** `packages/db/drizzle/0012_*.sql` (la tabla del latido), `apps/worker/src/{worker.ts,jobs/content-prepare.ts,jobs/tokens-refresh.ts}`, `packages/core/src/use-cases/{auto-publish-listing.ts,refresh-account-tokens.ts,change-listing-status.ts,publication-operations.ts}`
- **Descripción:** §4.10: retomar el `auto_publish` cortado, el presupuesto de `tokens.refresh`, la pausa de un sync con `byListing` (spec F6 §4.8), y el latido del worker (`worker_heartbeats`, cada minuto mientras corre) que `/health` (administrador), `doctor` y el panel muestran como "worker encendido desde…" o "apagado".
- **Hecho cuando:**
  - [ ] Tests: un `auto_publish` cortado se retoma una vez y no duplica; `tokens.refresh` corta a los 4 min y sigue en la siguiente; una pausa del sync seguida de la pausa de la propiedad queda con `byListing` y reanudar la reactiva; el latido y su lectura (encendido y apagado)

### F8-T13 · Respaldo a R2
- **Depende de:** T03
- **Archivos:** `packages/db/src/backup/`, `apps/worker/src/jobs/db-backup.ts`, `apps/api/src/server.ts` (estado), `apps/cli/src/commands/doctor/`, `docs/01-arquitectura.md` (`db.backup`)
- **Descripción:** §4.9: `runBackup` a una carpeta temporal y el job que sube con una segunda `MediaStorage` (su bucket y su token), el estado en `system/` del bucket principal, dejar 14, `/health` y `doctor`; `pnpm db:backup` siempre local.
- **Hecho cuando:**
  - [ ] Tests (doble de R2 y un `pg_dump` falso): un volcado que no se lee no se sube; 14 y no más; el estado bueno y la falla; el token de respaldos no lo tiene la API
  - [ ] `pnpm db:backup` local sigue igual, también con `BACKUP_TARGET=r2` en el archivo de entorno
  - [ ] Una restauración probada: el último respaldo bajado se lee con `pg_restore --list` y se restaura en una rama de prueba de Neon (en la demo)

### F8-T14 · Límites por IP
- **Depende de:** T01
- **Archivos:** `apps/api/src/{rate-limit.ts,app.ts,server.ts}`
- **Descripción:** §4.8: los límites y el 429 con `Retry-After`, la IP desde `CLIENT_IP_HEADER`.
- **Hecho cuando:**
  - [ ] Tests: cada límite, la ventana que se renueva, la IP de la cabecera configurada y que sin configurarla se ignora `X-Forwarded-For`

### F8-T15 · Doble factor (core, base y API)
- **Depende de:** T14
- **Archivos:** `packages/config/src/totp.ts`, `packages/core/src/use-cases/auth/totp.ts`, `packages/db/drizzle/0011_*.sql`, `packages/db/src/repositories/{users,login-challenges,recovery-codes}.ts`, `apps/api/src/routes/auth.ts`, `packages/db/src/auth-admin.ts`
- **Descripción:** §4.8: activar, confirmar, entrar en dos pasos, recuperación, desactivar; restablecer y `auth:admin` lo quitan.
- **Hecho cuando:**
  - [ ] Tests: los vectores del RFC 6238; la ventana de ±30 s; un código repetido rechazado; el desafío vencido o usado; un código de recuperación sirve una vez; los fallos cuentan para el bloqueo; la clave nunca sale en logs ni errores

### F8-T16 · Doble factor en el panel y la CLI
- **Depende de:** T15
- **Archivos:** `apps/web/src/pages/{LoginPage.tsx,AccountPage.tsx}`, `apps/cli/src/commands/login.ts`
- **Descripción:** activar en "Mi cuenta" (la clave, el enlace y los códigos una vez), el segundo paso al entrar; la CLI pide el código.
- **Hecho cuando:**
  - [ ] Tests del panel y de la CLI para cada paso; los códigos de recuperación no quedan en la caché del panel

### F8-T17 · Instagram de verdad y las vueltas de Meta
- **Depende de:** T02
- **Archivos:** `apps/api/src/routes/{oauth.ts,meta.ts}`, `packages/core/src/use-cases/meta-data-deletion.ts`, `packages/config/src/signed-request.ts` (la firma, inyectada desde `server.ts`), `packages/db/src/repositories/meta-deletion-requests.ts`, `apps/web/src/pages/AccountsPage.tsx`, `docs/integraciones/instagram.md`, `docs/01-arquitectura.md`
- **Descripción:** §4.11: el botón "Conectar Instagram" del administrador, el `state` de un solo uso, quitar la app y borrar los datos con la firma verificada.
- **Hecho cuando:**
  - [ ] Tests (msw, sin Meta): el `state` usado dos veces; la firma buena, mala y de otra app; borrar deja la cuenta sin credenciales y las publicaciones sin enlace ni id externo pero en su estado, con su evento; un `user_id` desconocido responde un código sin borrar; la página del código

### F8-T18 · Páginas públicas
- **Depende de:** T02
- **Archivos:** `apps/web/public/legal/{terminos,privacidad,eliminacion-de-datos}.html` (el único texto fuente: HTML estático, porque el revisor de Meta no corre JavaScript), `apps/web/src/pages/LoginPage.tsx` (los enlaces)
- **Descripción:** las tres páginas sin login, enlazadas desde la página de entrar; el texto en español con lo que pide Meta (`docs/integraciones/instagram.md`), marcado como borrador hasta tu aprobación.
- **Hecho cuando:**
  - [ ] Tests: se sirven sin sesión y sin JavaScript, con la CSP
  - [ ] Tú apruebas los textos

### F8-T19 · Mercado Libre: la vuelta automática
- **Depende de:** T02
- **Archivos:** `apps/api/src/routes/oauth.ts`, `apps/web/src/pages/AccountsPage.tsx`, `docs/integraciones/mercadolibre.md`, `docs/07-checklist-cuentas.md`
- **Descripción:** D20: `GET /api/oauth/mercadolibre/callback` con el `state` (de un solo uso desde F7) y su cookie `__Host-`, un botón "Conectar Mercado Libre" en el panel; el pegado de la dirección sigue en desarrollo.
- **Hecho cuando:**
  - [ ] Tests: la vuelta buena, el `state` ajeno o usado, sin cookie; la cookie la pone `authorize-url`
  - [ ] La dirección registrada en la app de Mercado Libre (tú; checklist)

### F8-T20 · Marketplace en producción
- **Depende de:** T01
- **Archivos:** `packages/core/src/marketplace*` (`marketplaceAutomationAllowed`), `apps/worker/src/worker.ts`, `apps/api/src/server.ts`, `apps/worker/src/jobs/marketplace-profile.ts`, `apps/web/src/pages/AccountsPage.tsx`
- **Descripción:** D4 y §4.10: en producción el formulario automático queda apagado (el worker no lo registra y la regla de core lo niega) y una cuenta de perfil se ofrece para pasar a mano.
- **Hecho cuando:**
  - [ ] Tests: en producción, conectar un perfil, `marketplace.profile` y publicar con una cuenta de perfil dan `MARKETPLACE_AUTOMATION_NOT_ALLOWED` sin abrir nada; una cuenta de perfil en producción se muestra para pasar a mano y el cambio no toca el disco; en desarrollo todo sigue como en F7

### F8-T21 · Primera puesta en marcha (contigo)
- **Depende de:** T01–T20
- **Descripción:** tú creas la app en el proveedor, el dominio y los secretos, y disparas el primer despliegue con la guía; Claude te acompaña leyendo lo que le cuentas (nunca los secretos). Después: `ENV_FILE=.env.production pnpm auth:admin`, entrar, activar el doble factor, conectar las cuentas de nuevo donde haga falta (la vuelta de Instagram y Mercado Libre cambia de dirección), pasar a mano las cuentas de Marketplace de perfil, y crear el corredor y el usuario de demostración para el revisor de Meta.

### F8-T22 · Cierre de fase
- **Depende de:** todas
- **Descripción:** `/fase-cerrar 8`: criterios, demo en el dominio, auditoría del `arquitecto`, `CHANGELOG [1.0.0]` y tag `v1.0.0` con tu permiso.

## 6. Criterios de aceptación de la fase
- [ ] Con el servidor encendido, `https://agentsales.agentpey.com` abre el panel con un certificado válido; el operador y un corredor entran desde otra red (por ejemplo, el teléfono con datos móviles).
- [ ] La CLI del Mac entra al servidor, y `status`, `doctor` e `import` (carpeta y zip) funcionan contra él; ningún archivo de la carga pasa por la API.
- [ ] En el servidor, con el Mac apagado: una carga desde el panel, preparar con la IA por API (fotos, portada, reel y textos), aprobar y publicar en simulación Instagram y Portal (la validación de Mercado Libre sin publicar), y Marketplace según D4.
- [ ] Con el servidor encendido y el Mac apagado, el calendario dispara lo programado y el respaldo aparece en R2; un respaldo bajado se lee con `pg_restore --list`.
- [ ] El operador conecta un Instagram con el botón en el dominio (OAuth de verdad) y la app queda enviada a App Review (D5).
- [ ] Las páginas de términos, privacidad y borrado de datos se ven sin login; las vueltas de Meta responden bien con una firma válida y rechazan una inválida (tests).
- [ ] El administrador entra con doble factor; demasiados intentos dan 429; la cookie es `__Host-` y `Secure`; las cabeceras de seguridad están (tests y revisión en el navegador).
- [ ] `pnpm dev` en el Mac usa la rama y el bucket de desarrollo y no toca producción.
- [ ] Encender y apagar el servidor con la guía funciona, y apagado no gasta el cupo de Neon (su cómputo se duerme).
- [ ] El servidor sigue en `dry-run`; nada se publicó de verdad sin tu instrucción.
- [ ] Ningún test llama a Instagram, Mercado Libre, Facebook, Anthropic, el Banco Central, R2 ni al proveedor de hosting; `pnpm check` y la CI en verde.

## 7. Plan de demo
1. **Tú, antes:** checklist "Antes de F8" (cuenta de Fly con tarjeta, el `CNAME` de `agentsales.agentpey.com` en Vercel, rama de Neon y buckets, CORS de R2, secretos) y el primer despliegue (T21).
2. **Tú, con el servidor encendido, en el teléfono con datos móviles:** abrir `https://agentsales.agentpey.com`, entrar con doble factor; ver Propiedades y Seguimiento.
3. **CLI:** `agentsales login --api https://agentsales.agentpey.com`, `status`, `doctor`, `import` de una carpeta de prueba.
4. **Como el corredor de demo (otra ventana):** cargar P001 desde el panel, prepararla, aprobar, publicar en simulación y Marketplace según D4.
5. **Mac apagado, servidor encendido:** programar una publicación de prueba en simulación para dentro de 10 minutos y ver que sale; el respaldo del día en R2 (`doctor`). Al terminar, apagar el servidor con la guía.
6. **Instagram:** conectar tu Instagram con el botón (eres evaluador de la app); grabar el video para App Review con ese flujo y enviarla (D5).
7. **Respaldo:** bajar el último y `pg_restore --list`.
8. Nada en vivo sin tu instrucción.

## 8. Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| Un secreto termina en la imagen o en git | `.dockerignore` y `.gitignore` con `.env*`; la CI revisa que la imagen no tenga `.env`; secretos solo en el proveedor |
| `pnpm dev` y el servidor comparten la base y se roban trabajos | D3: rama de Neon, bucket y `APP_ENCRYPTION_KEY` de desarrollo, y las credenciales borradas en la rama (`db:dev-scrub`); `/health` dice el ambiente y `doctor` avisa si no es el esperado |
| Se olvida el worker encendido y se agota el cupo gratis de Neon (unos 17 días): la base, también la de desarrollo, queda suspendida hasta el mes siguiente | La API se apaga sola sin tráfico; la guía termina cada demo apagando el worker; `doctor` y el panel del administrador dicen si el worker está encendido; revisar el uso en el panel de Neon. Si pasa, Neon no borra datos |
| Una demo sin aviso: el servidor está apagado | Encenderlo toma un comando y unos segundos; la página de entrar no existe con todo apagado (Fly arranca la API con el primer pedido) |
| Romper producción con un despliegue | Despliegue a pedido desde `main` en verde, la imagen construida en cada PR, migraciones aditivas y volver a la versión anterior en la guía |
| Adivinar contraseñas desde internet | Límites por IP, bloqueo por usuario, 12 caracteres, doble factor para el administrador |
| Un corredor ve lo de otro | Lo de F7 (tabla de permisos, matriz de 404, filtro en SQL) sigue; las rutas nuevas entran en la matriz |
| Meta tarda o rechaza la revisión | D5: F8 no espera la aprobación para cerrar; mientras, los corredores que publican en Instagram son evaluadores |
| La verificación del negocio de Meta pide una empresa | Lo dice la nota de Instagram; si hace falta, queda como trámite tuyo y no bloquea el resto de F8 |
| Los textos legales no cubren lo necesario | Borradores con lo que pide Meta; los revisas y apruebas tú (no es asesoría legal) |
| El costo mensual sube | D1 con el costo total estimado; el tope de IA por corredor y el límite de gasto de la consola de Anthropic (hoy no hay; checklist) |
| El worker se queda sin memoria con un reel (ffmpeg y Chromium a la vez) | Medir el pico antes de elegir el tamaño (T10); swap en el servidor; un reel a la vez (`content.prepare` ya procesa de a uno) |
| El disco temporal del servidor no alcanza para un zip grande | El tope del zip en producción se fija con lo que ofrezca el proveedor (NO VERIFICADO, nota §2.1); si no alcanza, un volumen o un tope menor |
| Se pierde la `APP_ENCRYPTION_KEY` | Vive en tu gestor de claves y en los secretos del servidor; sin ella hay que reconectar todas las cuentas (la guía lo advierte) |

## 9. Preguntas abiertas
- [x] D1: hosting → **Fly.io en modo demo con Neon gratis**; siempre encendido con Neon Launch cuando decidas pagar (2026-10-18).
- [x] D2: el dominio → **`agentsales.agentpey.com`** (2026-10-18).
- [x] D4: Marketplace en producción → **a mano para todos** (2026-10-18).
- [x] D5: ¿F8 se cierra con App Review enviado o aprobado? → **enviado** (2026-10-18).

## 10. Registro de cambios del spec
| Fecha | Cambio |
|---|---|
| 2026-10-18 | Borrador (`/fase-plan 8`), con las notas de `integraciones` del mismo día: `hosting.md` (nueva), `anthropic-terminos.md` (nueva) e `instagram.md` §13 |
| 2026-10-18 | Revisión del `arquitecto` (12 bloqueantes, aplicados): ADR-0024 modifica también ADR-0005 y ADR-0007 y cambia F6 D11 y F7 §4.7; el prefijo `/api` en los dos modos (Vite, CLI y la tabla de permisos) en el lote A; cookies `__Host-` con `Path=/` y una de `state` por proveedor; las vueltas de Meta fuera del CSRF, con su tabla y su página, sin cambiar el estado de las publicaciones; `import_runs.input` como unión que conserva `broker`; `--dry-run` por el mismo flujo; el sha256 del zip no lo calcula el navegador; el respaldo sube desde el job y su estado va al bucket principal; otra `APP_ENCRYPTION_KEY` y credenciales borradas en la rama de desarrollo; `/api/health` fuera de `hostGuard`; T20 con D4; T09 al lote B y un paso tuyo antes del lote B. Además: el límite por IP sin puerto en core, la CSP con el origen de R2 de la configuración, `Referrer-Policy: same-origin`, `/health` con el ambiente, páginas legales en HTML estático, la firma de Meta inyectada, nombres de archivos reales, `db:backup` siempre local, la imagen con `pnpm-workspace.yaml` y `data/plantillas`, sin `act`, el respaldo de medios fuera de alcance, y `--broker` con `slugify` cerrado |
| 2026-10-18 | Respuestas del operador: D4 (Marketplace a mano para todos) y D5 (cerrar con App Review enviado). D1: por ahora algo **gratis** para mostrar la herramienta y después un plan pagado; D2: un dominio con "agentpey" |
| 2026-10-18 | Segunda nota de hosting (`hosting.md` §13, opciones gratis) y respuestas: D1 = **Fly.io en modo demo** con Neon gratis (frente a Oracle gratis, que hay que administrar y puede reclamarse); D2 = **`agentsales.agentpey.com`** (`agentpey.com` es del operador y lo usa otro proyecto). Criterios y demo con el servidor encendido; riesgo del cupo de Neon |
| 2026-10-18 | **Aprobado** por el operador. ADR-0024, ADR-0025 y ADR-0026 registrados; seguimientos en ADR-0005, ADR-0007, ADR-0017, ADR-0021, ADR-0022 y ADR-0023; roadmap y checklist "Antes de F8" al día |
| 2026-10-18 | Lote B (F8-T03 a T07 y T09). Precisiones: `pnpm db:dev-scrub` (§4.6) solo usa `.env` y se niega si la base o la clave son las de `.env.production` o si la clave de `.env` abre alguna credencial; la entrada de R2 guarda también el `name` del zip y de la carpeta (para mostrarlos); `startImport` revisa los archivos con `list` (una llamada) en vez de un `head` por archivo; una carga de antes de F8 se cierra con `IMPORT_INPUT_LEGACY`; la limpieza de cada hora borra también lo que quedó en R2 de cargas terminadas; códigos nuevos `IMPORT_UPLOAD_INVALID` (400), `IMPORT_UPLOAD_TOO_LARGE` (413), `IMPORT_INPUT_LEGACY`; la respuesta de `POST /api/imports/uploads` (201) es `{ importRun, uploads }` (la carga completa, no solo su id) y lleva `kind` por URL; tras la revisión (`revisor` y `arquitecto`, sin bloqueantes): las URLs duran 6 h, empezar una carga en cola la vuelve a encolar, `db:dev-scrub` se niega sin `.env.production` y deja las credenciales que abre la clave de desarrollo, el zip tiene el tope por archivo (nunca más de 4 GB); `storage:check --origin`; `MAX_IMPORT_UPLOAD_MB` sigue en 512 por archivo (el zip, además, hasta 4 GB). Pendiente del operador: la carga real de prueba de T07 |
| 2026-10-18 | Verificado por el operador: `pnpm db:dev-scrub` borró las 2 credenciales copiadas en la rama dev, y `pnpm storage:check` pasó en el bucket de desarrollo (PUT prefirmado 200; otro contenido 400 `BadDigest`; otro largo 403; CORS desde `http://localhost:5173` 204). Falta el CORS del bucket de producción (`--origin https://agentsales.agentpey.com`) |
| 2026-10-18 | Lote A (F8-T01 y T02, PR #140) y su revisión (`revisor` y `arquitecto`; un bloqueante, aplicado: `.gitignore` ignora `.env.*` salvo `.env.example`, para que `.env.production` nunca entre a git). Precisiones: en producción la IA debe ser `anthropic-api` (tampoco `fake`); la vuelta de Instagram del ejemplo de antes (sin `/api`) se ignora y se usa la nueva; `panelUrlOf` (config) da el panel también a `pnpm auth:admin`; la API y el worker rechazan `ENV_FILE` (`loadAppEnvFile`: es solo para los scripts, D12); `hostGuard` también cubre el panel compilado (salvo `GET /api/health`); `server-app.ts` reemplaza al `static.ts` de la lista; el mensaje de error habla del archivo de entorno. **Postergado:** la regla de producción de `BACKUP_TARGET` llega con T13, la de `BROWSER_PROFILES_DIR` con T20 y la cookie `__Host-agentsales_oauth_ml` con T19; la CSP en un navegador se revisa en T10 (en el Mac, Vite sirve el panel sin ella) |
