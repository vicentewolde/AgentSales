# 10 · Desplegar en Fly.io (guía del operador)

Guía paso a paso para poner AgentSales en internet, en `https://agentsales.agentpey.com`. Decisiones: spec F8 (§4.7 y §4.15, D1, D2, D8 y D9) y ADR-0024. Lo verificado de Fly está en `docs/integraciones/hosting.md` §14, con lo que todavía no se pudo comprobar marcado como NO VERIFICADO.

**Cuándo:** la primera puesta en marcha es la tarea T21 de F8, después del lote E (el respaldo a R2, que producción exige para arrancar) y del resto de los lotes de F8.

**Quién hace qué:** todo lo de esta guía lo haces tú en tu terminal o en el navegador: crear la cuenta, poner los secretos, desplegar, encender y apagar. Claude prepara el código y los archivos (`Dockerfile`, `fly.toml`, `.github/workflows/deploy.yml`) y nunca despliega (D8). Los secretos nunca se pegan en el chat.

## Cómo queda armado

- **Una app de Fly** (`agentsales`, en São Paulo, junto a Neon) con **dos procesos** de la misma imagen:
  - **`api`**: el panel y la API. Se apaga sola cuando nadie la usa y se enciende con el primer pedido (tarda unos segundos).
  - **`worker`**: prepara, publica y corre lo programado. Hoy **no se apaga solo**: lo enciendes y lo apagas tú (paso 8). Con el **horario activado** (paso 8, "El worker con horario", F9.5-T24, ADR-0037) lo enciende una revisión cada hora (a los :50, de 06:50 a 22:50 hora de Chile) y se apaga solo cuando no le queda nada que hacer ni nada que venza antes de la próxima revisión.
- **Modo demo (D1):** las máquinas se encienden los días de demo y se apagan después. Cuesta unos US$ 0,56 por día encendido, más centavos por el disco de las máquinas apagadas. Con el worker apagado, Neon se duerme y no gasta su cupo gratis.
- **Simulación (D9):** el servidor corre con `PUBLISH_MODE=dry-run` (en `fly.toml`). Pasarlo a `live` es una decisión tuya, que pides en el chat.
- **Dos llaves (F9.5-T22, ADR-0036):** el servidor en `live` solo **permite** publicar de verdad. Cada marca, además, tiene su propio interruptor (`brokers live <slug> on|off`, o en su ficha del panel) y solo las marcas propias del operador pueden encenderse. Una publicación sale de verdad solo con las dos llaves abiertas; si falta cualquiera, es simulación. Todas las marcas nacen apagadas y el seed no enciende ninguna. Encender o apagar una marca, igual que cambiar `PUBLISH_MODE`, lo decides tú, en el chat.
- **Las migraciones** se aplican solas en cada despliegue, antes de reemplazar nada. Si fallan, el despliegue se detiene y queda la versión anterior.
- **Una sola instancia por ahora (D19 de F9):** esta guía es la de la instancia de hoy (`principal`). Cuando haga falta otra del mismo código, con sus propios datos y cuentas, sigue "Una segunda instancia", al final.
- **Lo que no corre en el servidor:** el formulario automático de Marketplace (D4: en producción, Marketplace es a mano para todos; el worker no registra su publisher ni el job `marketplace.profile`, y `BROWSER_PROFILES_DIR` no va en el entorno: si está en tu `.env.production`, quítala, porque `loadEnv` la rechaza con `NODE_ENV=production`) y la CLI de Claude (la IA va por la API de Anthropic).

## Antes de empezar (una vez)

1. **Cuenta de Fly con tarjeta:** entra a **fly.io** → **Sign up** y agrega una tarjeta en **Billing** (Fly la pide aunque gastes poco).
2. **flyctl en el Mac:**
   ```bash
   brew install flyctl
   ```
   ```bash
   fly auth login
   ```
   Se abre el navegador para entrar.
3. **El bucket de respaldos** (`agentsales-backups`) y la regla de CORS de producción ya están en el checklist (`docs/07-checklist-cuentas.md`, "Antes de F8").

## Paso 1 · Crear la app

```bash
fly apps create agentsales
```

Si Fly dice que el nombre está ocupado, usa otro (por ejemplo `agentsales-agentpey`) y avísale a Claude: hay que cambiar la línea `app = "agentsales"` de `fly.toml` con un PR antes de desplegar. En los comandos de esta guía, reemplaza `agentsales` por ese nombre.

## Paso 2 · Los secretos

Son los valores de producción de tu `.env.production`. Este comando, corrido en la carpeta del proyecto (donde está `.env.production`), copia **solo** los que necesita el servidor, sin mostrarlos en pantalla:

```bash
grep -E '^(DATABASE_URL|R2_ACCOUNT_ID|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_BUCKET|APP_ENCRYPTION_KEY|ANTHROPIC_API_KEY|INSTAGRAM_APP_ID|INSTAGRAM_APP_SECRET|FACEBOOK_APP_SECRET|ML_APP_ID|ML_CLIENT_SECRET|LINKEDIN_CLIENT_ID|LINKEDIN_CLIENT_SECRET|BCCH_API_TOKEN|BACKUP_R2_ACCESS_KEY_ID|BACKUP_R2_SECRET_ACCESS_KEY)=' .env.production | fly secrets import --stage -a agentsales
```

- `--stage` guarda los secretos sin encender nada; los toman las máquinas al arrancar.
- Fly toma cada línea tal cual (`NOMBRE=valor`). Si en `.env.production` algún valor está entre comillas, quítaselas en el archivo antes de correr el comando.
- `FACEBOOK_APP_SECRET` es opcional (las vueltas de Meta, F8-T17): si no está en `.env.production`, el comando simplemente no la copia.
- `DATABASE_URL` es la de la base de producción de Neon (no la rama `dev`), `R2_BUCKET` es `agentsales-media`, y `APP_ENCRYPTION_KEY` es la de producción (sin ella no se pueden leer los tokens de las cuentas conectadas).
- `BACKUP_R2_ACCESS_KEY_ID` y `BACKUP_R2_SECRET_ACCESS_KEY` son el token del bucket `agentsales-backups` (checklist, "Antes del primer despliegue"), **no** el de `agentsales-media`: el servidor no arranca si son el mismo. Fly le da los secretos a los dos procesos: la API no los usa, los quita de su configuración y de su entorno al arrancar (así ningún proceso que abra los hereda) y nunca abre el bucket de respaldos; solo el worker sube los respaldos. No es un aislamiento total (el sistema guarda el entorno con que arrancó cada proceso), pero la API ya no puede usarlo por error. Sin ellos, el servidor no arranca (producción exige el respaldo a R2).
- **`INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET` son el par de la app de Instagram, no el de la app general de Meta.** Están en Meta, `AgentSales-IG` → **Casos de uso → Administrar mensajes y contenido en Instagram → Personalizar → Configuración de la API con el inicio de sesión de Instagram** (el *Instagram app ID* y el *Instagram app secret*, con el botón Mostrar), no en Configuración → Información básica. Si la clave no es la de Instagram, el botón Conectar Instagram vuelve con "Instagram no aceptó la conexión (el código venció o ya se usó)": compara los 4 primeros y los 4 últimos caracteres con tu `.env.production`, sin copiarla. `FACEBOOK_APP_SECRET` (opcional) sí es la de Información básica.
- **Las redes de los posts (F9), en resumen:** LinkedIn ya va en el comando de arriba (`LINKEDIN_CLIENT_ID` y `LINKEDIN_CLIENT_SECRET`; si no están en `.env.production`, no se copian y conectar LinkedIn dice `LINKEDIN_NOT_CONFIGURED`). X y TikTok se suben aparte, cuando vayas a usarlos (abajo). Discord no tiene variables: cada webhook se guarda cifrado en la base al conectarlo. Las direcciones de vuelta de las tres salen de `PUBLIC_URL` (`https://<dominio>/api/oauth/linkedin|x|tiktok/callback`) y se registran igual en la app de cada red. Fly entrega los secretos a los dos procesos: la API los usa para conectar y el worker, en X y TikTok, para renovar el token (sin el par, una cuenta por renovar falla con `TOKEN_REFRESH_NOT_CONFIGURED` sin cambiarla). Cada red publica de verdad solo después de su prueba de entrada (S1 a S6, `docs/07-checklist-cuentas.md`, "F9 · Contenido de marca").
- **X (F9-T16), cuando vayas a conectarlo:** el par OAuth 2.0 de la app de X (`X_CLIENT_ID` y `X_CLIENT_SECRET`, de console.x.com) no está en el comando de arriba; súmalo con `grep -E '^(X_CLIENT_ID|X_CLIENT_SECRET)=' .env.production | fly secrets import --stage -a agentsales`. La dirección de retorno es `<PUBLIC_URL>/api/oauth/x/callback` (regístrala igual en la app de X). Antes de publicar de verdad en X va la prueba S4 (`docs/integraciones/x.md` §0).
- **TikTok (F9-T26):** `TIKTOK_CLIENT_KEY` y `TIKTOK_CLIENT_SECRET` (el par del **Sandbox**) no van en la lista de arriba: súbelos **antes de la prueba S6**, porque TikTok exige `https` y S6 solo se hace desde el servidor (en el Mac no se puede conectar; `docs/integraciones/tiktok.md` §0). Hasta S6, TikTok se usa solo en `dry-run`. Súbelos con el comando de "Cambiar un solo secreto" (uno por línea del `grep -E`); la vuelta es `https://<dominio>/api/oauth/tiktok/callback` (sin `TIKTOK_REDIRECT_URI`, sale de `PUBLIC_URL`) y se registra igual en la app de TikTok.
- **Imágenes de los posts (F9.5-T25, ADR-0038), cuando vayas a usarlas:** `PIXABAY_API_KEY` (la biblioteca) y `GEMINI_API_KEY` (crear con IA) no van en el comando de arriba; súbelos con `grep -E '^(PIXABAY_API_KEY|GEMINI_API_KEY)=' .env.production | fly secrets import --stage -a agentsales`. Sin ellos, «Conseguir imagen» ofrece solo las tarjetas de la marca y dice qué falta. `IMAGE_AI_MODEL`, `IMAGE_AI_PRICE_USD` e `IMAGE_AI_MONTHLY_CAP_USD` (por defecto, `gemini-nano-banana-2.1`, US$0,034 y US$2 al mes por marca) no son secretos: se cambian igual si Google cambia el modelo o el precio. Fly los da a los dos procesos: la API busca en la biblioteca y revisa el tope, el worker descarga y genera.
- **Cambiar un solo secreto después**, sin desplegar: `grep -E '^NOMBRE=' .env.production | fly secrets import -a agentsales` (sin `--stage`, Fly lo aplica y reinicia las máquinas). Con `--stage` queda pendiente hasta el próximo despliegue.
- Revisa que quedaron los nombres (sin valores):
  ```bash
  fly secrets list -a agentsales
  ```
- Lo que no es secreto (`PUBLIC_URL`, `PUBLISH_MODE`, el puerto…) ya está en `fly.toml`.

## Paso 3 · El token para GitHub

El despliegue corre en GitHub Actions y necesita un token de Fly que solo sirve para esta app. El token se guarda en un **Environment** de GitHub que solo acepta la rama `main`: así nadie puede usarlo desde otra rama, aunque cambie el flujo.

1. **El Environment** (una vez; **ya está creado**, 2026-10-18): en GitHub, el repositorio → **Settings** → **Environments** → **`production`**. Tiene **Deployment branches and tags** en **Selected branches and tags** con la regla **`main`**, y **Allow administrators to bypass configured protection rules** desmarcado (la regla vale también para ti). Si algún día hay que crearlo de nuevo: **New environment** → `production` → **Configure environment** y lo mismo.
2. **Crear el token de Fly** (vence en 6 meses); queda en el portapapeles, sin mostrarse:
   ```bash
   fly tokens create deploy -a agentsales -n github-deploy -x 4380h | pbcopy
   ```
3. **Guardarlo en el Environment**, sin que pase por la pantalla:
   ```bash
   pbpaste | gh secret set FLY_API_TOKEN --env production
   ```
   (O en la web, en el Environment `production` → **Environment secrets** → **Add environment secret**, nombre `FLY_API_TOKEN`, y pegar.) No lo pongas como secreto del repositorio: ahí lo vería cualquier rama.

Anota en tu calendario renovarlo antes de que venza (el creado el 2026-10-19 dura 6 meses).

## Paso 4 · Desplegar

Solo se puede desplegar `main` con la CI en verde (el flujo se niega si no). **Es la CI del commit exacto de `main`**: al mezclar un PR, `main` recibe un commit nuevo y su CI (`check` e `image`) tarda unos minutos; si despliegas antes, el primer paso falla con "La CI (check) no está en verde sobre … sin resultado" sin tocar Fly. Espera a que termine (`gh run list --branch main --limit 3`) y repite. Elige una de estas dos formas:

- **En GitHub:** el repositorio → **Actions** → **Desplegar** → **Run workflow** → rama `main` (deja **Instancia** en `principal`) → **Run workflow**.
- **En la terminal:**
  ```bash
  gh workflow run deploy.yml --ref main
  ```
  Y para seguirlo:
  ```bash
  gh run watch
  ```

Tarda varios minutos (Fly construye la imagen). Al terminar:

```bash
fly status -a agentsales
```

Debe mostrar una máquina `api` y una `worker`. **Al actualizar, primero se despliega el servidor y después se usa la CLI nueva contra él** (`login --api`): la CLI nueva exige campos que un servidor viejo no manda (por ejemplo, `connect.x`, `connect.linkedin` y `connect.tiktok` en `GET /accounts`, desde F9-T19) y rechaza su respuesta. **Después de cada despliegue en modo demo, revisa que el worker quedó como querías** (un despliegue puede encenderlo: NO VERIFICADO, `hosting.md` §14.2). Si no es día de demo, apágalo (paso 8).

## Paso 5 · El dominio y su certificado

1. **Asigna las direcciones IP públicas de la app** (una app nueva no tiene ninguna, y sin ellas el dominio no apunta a nada). La IPv4 compartida y la IPv6 no cuestan; **no pidas una IPv4 dedicada** (unos US$ 2 al mes):
   ```bash
   fly ips allocate-v4 --shared -a agentsales
   ```
   ```bash
   fly ips allocate-v6 -a agentsales
   ```
2. Pide el certificado:
   ```bash
   fly certs add agentsales.agentpey.com -a agentsales
   ```
3. Pide los registros DNS que debes crear:
   ```bash
   fly certs setup agentsales.agentpey.com -a agentsales
   ```
   Usa la opción **A y AAAA** (la recomendada): un registro `A` con la IPv4 y uno `AAAA` con la IPv6 que mostró el paso 1. **Copia los valores exactos que muestra Fly.** (Un `CNAME` hacia `<código>.agentsales.fly.dev` también sirve; el `_acme-challenge` solo hace falta para emitir el certificado antes de dirigir el tráfico, y el `_fly-ownership` si la app no tiene IPv6 o hay un CDN o proxy delante.)
4. En **vercel.com** → tu equipo → **Domains** → `agentpey.com` → **DNS Records**, agrega dos registros:
   - Name **agentsales**, Type **A**, Value la IPv4, y **Add**.
   - Name **agentsales**, Type **AAAA**, Value la IPv6, y **Add**.
5. Espera unos minutos y revisa:
   ```bash
   fly certs check agentsales.agentpey.com -a agentsales
   ```
   Debe decir `Status = Issued` y "Certificate is verified and active". Si sigue pendiente, espera y repite.

Esto no toca el otro proyecto de `agentpey.com`: es otro nombre, y las cookies de AgentSales no salen de `agentsales.agentpey.com`. (Hecho el 2026-10-19: la IPv4 compartida `66.241.124.18` y la IPv6 `2a09:8280:1::1be:1d46:0`; el certificado quedó emitido en un minuto.)

## Paso 6 · Comprobar que funciona

1. Abre `https://agentsales.agentpey.com/api/health`: debe responder con `"environment":"production"` y `"publishMode":"dry-run"`.
2. Abre `https://agentsales.agentpey.com`: debe aparecer la página **Entrar**. Entra con tu correo.
3. La CLI contra el servidor:
   ```bash
   pnpm -s cli login --email tu@correo.cl --api https://agentsales.agentpey.com
   ```
   ```bash
   pnpm -s cli doctor
   ```
   `doctor` debe decir el servidor, "Ambiente: producción" y si el worker está encendido. Para volver a la API del Mac, entra de nuevo sin `--api`.
4. **Registrar la dirección de vuelta en Mercado Libre, antes de conectar:** en developers.mercadolibre.cl → tu app → **Editar** (pide verificarte con el QR de tu app de Mercado Libre), en **Redirect URIs** agrega con **Agregar Redirect URI** `https://agentsales.agentpey.com/api/oauth/mercadolibre/callback` (deja la de `agentsales.test` para desarrollo); al final, acepta los términos, marca "No soy un robot" y pulsa **Editar**. Sin ella, Mercado Libre responde "Lo sentimos, la aplicación no puede conectarse a tu cuenta".
5. **Conectar Mercado Libre con el botón** (con el servidor en su dominio y la dirección registrada en la app de Mercado Libre, `docs/07-checklist-cuentas.md`): en el panel, **Cuentas**, el corredor y **Conectar Mercado Libre**. Entra con la cuenta administradora y autoriza; vuelve solo a Cuentas con "Cuenta de Mercado Libre conectada". Desde la CLI no se conecta en el servidor: `accounts connect mercadolibre` te manda al botón.
6. **Portal Inmobiliario pide el WhatsApp del corredor** (aunque sea en simulación): en el panel, **Corredores** → el corredor → **WhatsApp**, con código de país. Sin él, la pestaña Portal dice "Mercado Libre exige el WhatsApp del corredor". Y sin un paquete con cupo en Mercado Libre, la simulación de Portal lo anota (`ML_NO_QUOTA`) y sigue con las revisiones de AgentSales.
7. **Una demo en producción** parte del historial que ya trae la base (publicaciones simuladas de antes): para repetir el flujo en una propiedad, retira primero sus publicaciones simuladas ("Marcar como retirada"), quita la aprobación y vuelve a aprobar; para ver que el calendario corre sin tu Mac, programa unos minutos adelante y míralo desde el teléfono en **Seguimiento**.
8. **Pasar a mano las cuentas de Marketplace de perfil** que quedaron en la base (por ejemplo `agentsales-pruebas`): en **Cuentas**, el corredor, **Activar Marketplace a mano** (no pregunta nada ni toca archivos: en el servidor no hay perfil). Sin esto esas cuentas siguen "conectadas" pero publicar con ellas da `MARKETPLACE_AUTOMATION_NOT_ALLOWED`.
9. **Tus marcas (F9), una vez y solo en esta instancia:** `ENV_FILE=.env.production pnpm db:seed --operator-brands` crea `vinny` y `agentpey` con su perfil vacío (no duplica ni pisa nada si lo repites). Después llenas su perfil editorial y conectas sus redes (`docs/08-guia-operador.md`). Las migraciones de F9 (`0014` a `0018`) se aplican solas al desplegar.

## Paso 7 · Ver los logs

```bash
fly logs -a agentsales
```

Muestra los logs en vivo de la API y del worker (Ctrl+C para salir). Los logs nunca llevan tokens ni contraseñas.

## Paso 8 · Encender y apagar para una demo

La API se apaga sola sin tráfico. **El worker hay que apagarlo a mano al terminar**: encendido, Neon no se duerme y gasta su cupo gratis (unos 6 de los 100 CU-h del mes por día).

1. Los ids de las máquinas (anota el del worker y el de la API):
   ```bash
   fly machine list -a agentsales
   ```
2. **Encender** el worker al empezar la demo:
   ```bash
   fly machine start <id_worker> -a agentsales
   ```
3. **Apagar** el worker al terminar (le da 45 s para terminar lo que está haciendo):
   ```bash
   fly machine stop <id_worker> -a agentsales --signal SIGTERM --timeout 45
   ```
4. Para apagar también la API de inmediato (si no, se apaga sola):
   ```bash
   fly machine stop <id_api> -a agentsales --signal SIGTERM --timeout 45
   ```

`pnpm -s cli doctor` (con la CLI apuntando al servidor) y la página **Estado** del panel dicen si el worker está encendido y desde cuándo. No uses `fly scale count worker=0`: borra la máquina y obliga a desplegar de nuevo.

### El worker con horario (F9.5-T24, ADR-0037)

En vez de encenderlo y apagarlo tú, el worker puede **encenderse solo** cada hora y **apagarse solo** cuando no tiene nada que hacer ni nada por vencer. Pagas solo el rato que está encendido y Neon se duerme mientras está apagado.

**Cómo funciona:**
- **La revisión de cada hora:** el flujo `.github/workflows/worker-schedule.yml` ("Encender el worker") corre **cada hora a los :50** y enciende la máquina del worker si está apagada, solo **dentro de la franja de 07:00 a 23:00 de Chile**. La primera revisión es la de las 06:50 y la última la de las 22:50, con 15 minutos de holgura si GitHub la atrasa. De noche no lo despierta. GitHub puede atrasar un cron varios minutos (nunca lo adelanta) y, con mucha carga, **saltarse una corrida**: entonces lo enciende la revisión siguiente. El repositorio es público: los minutos de Actions no se cobran.
- **El worker se apaga solo** cuando lleva `WORKER_IDLE_EXIT_MINUTES` minutos seguidos (10) sin jobs activos, sin un formulario de Marketplace abierto y sin publicaciones programadas que venzan en los próximos `WORKER_STAY_AHEAD_MINUTES` (70 por defecto: la próxima revisión llega en 60 o menos, más el atraso de GitHub). Cierra limpio **sin cortar nada**: deja de tomar trabajos y espera hasta 15 min a los que están en curso. Después la máquina queda detenida (`[[restart]]` con `on-failure`: una salida sin error no la reinicia). Lo vencido hace menos de 12 h también lo mantiene encendido, para que salga.
- **Así, lo programado de día sale a su hora:** por ejemplo, un post a las 10:00 lo ve la revisión de las 08:50 o la de las 09:50, que deja el worker encendido hasta publicarlo y se apaga unos 10 minutos después.
- **Lo programado de madrugada** (después de las 00:00, cuando ya no lo ve la revisión de las 22:50) **sale a las 06:50**, con la primera revisión de la mañana. La agenda lo muestra en **"El worker está apagado y hay algo por vencer"** con cómo encenderlo ya, y `doctor` dice la próxima revisión. Lo que pasa **más de 12 h** sin salir queda atrasado y no sale solo (D2 de F6): con la franja de 07:00 a 23:00 eso no pasa.
- **Lo que pides con el worker apagado espera a la próxima revisión, hasta unos 60 minutos de día** (de noche, hasta las 06:50). Eso incluye:
  - lo que programas para dentro de poco, o lo que publicas «ahora»;
  - un `retry`;
  - las operaciones de Portal (pausar, cerrar, actualizar, sincronizar);
  - preparar textos y fotos, importar y pedir un plan.

  La CLI que espera un resultado (`publish`, `prepare`, `import`) queda esperando hasta su tope. Si no quieres esperar, enciéndelo a mano (abajo).
- **El costo (estimación, sin medir):** cada revisión deja el worker encendido unos 10 a 12 minutos aunque no haya nada (arranca, espera los 10 minutos y se apaga). Son 17 revisiones al día, unas 3 h de worker y de Neon despierto: unos US$ 1 a 3 al mes en Fly y unos 25 a 35 de los 100 CU-h gratis de Neon, más el rato de cada publicación. Siempre encendido serían unos US$ 37 a 48 (paso 11).
- **Dos cosas vencen solas:** el token de Fly vence a los 6 meses (renuévalo, abajo), y GitHub desactiva los workflows programados después de 60 días sin cambios en el repositorio (abajo, "Volver atrás", cómo reactivarlo). En los dos casos el worker deja de encenderse, y la agenda y `doctor` lo avisan.
- **Cambiar la franja o el minuto:** pídele a Claude el cambio; van en el flujo (`ACTIVE_FROM`, `ACTIVE_UNTIL`, `LEAD_MINUTES`, `GRACE_MINUTES` y el `cron`) y en `packages/core/src/worker-schedule.ts`, y un test revisa que calcen. `WORKER_STAY_AHEAD_MINUTES` (en `fly.toml`, de 60 a 1440, 70 si no está) es cuánto mira hacia adelante; menos de 60 se rechaza, porque lo que vence justo antes de la revisión siguiente esperaría a esa revisión.

**Activarlo (lo haces tú, una vez):**

1. **El Environment de GitHub** que guarda el token (como el de desplegar, paso 3): el repositorio → **Settings** → **Environments** → **New environment** → `worker-schedule` → **Configure environment**. En **Deployment branches and tags**, **Selected branches and tags** con la regla **`main`**, y **Allow administrators to bypass configured protection rules** desmarcado. Así ninguna otra rama puede usar el token. (Si el flujo corrió antes, GitHub ya creó el Environment sin regla: ábrelo y ponle la regla.)
2. **El token de Fly** (vence en 6 meses, queda en el portapapeles sin mostrarse). Es un token de la app `agentsales` y nada más: no sirve para otras apps ni para la organización.
   ```bash
   fly tokens create deploy -a agentsales -n github-worker-schedule -x 4380h | pbcopy
   ```
   Fly no ofrece hoy un token que solo encienda máquinas (NO VERIFICADO si `fly tokens` permite acotarlo más: revisa `fly tokens create --help`; si ofrece uno de solo máquinas para la app, úsalo). El flujo solo lo usa para `fly machine list` y `fly machine start` del grupo `worker`.
3. **Guardarlo en el Environment**, sin que pase por la pantalla:
   ```bash
   pbpaste | gh secret set FLY_WORKER_START_TOKEN --env worker-schedule
   pbcopy </dev/null
   ```
   La segunda línea limpia el portapapeles para que el token no quede ahí. (O en la web: el Environment `worker-schedule` → **Environment secrets** → **Add environment secret**, nombre `FLY_WORKER_START_TOKEN`, pegar, y después `pbcopy </dev/null`.) No lo pongas como secreto del repositorio: ahí lo vería cualquier rama. El token por sí solo podría desplegar la app (es de tipo `deploy`); **lo que lo limita es el Environment**: solo este flujo, desde `main`, lo usa, y solo para listar y encender la máquina del worker.
4. **Probar el encendido a mano:** con el worker apagado, en GitHub → **Actions** → **Encender el worker** → **Run workflow** (rama `main`). Debe decir "Encendiendo el worker …" y, al minuto, `pnpm -s cli doctor` (contra el servidor) debe decir "Worker: encendido". NO VERIFICADO hasta esa primera corrida: la forma del JSON de `fly machine list --json` que lee el flujo (el grupo en `config.metadata.fly_process_group` y el estado en `state`).
5. **Que se apague solo:** pídele a Claude quitar el `#` de `WORKER_IDLE_EXIT_MINUTES = "10"` en `fly.toml` y despliega (paso 4). Desde ahí, el worker se apaga a los 10 minutos sin nada que hacer. Compruébalo con `pnpm -s cli doctor` unos 15 minutos después de que termine lo programado: "Worker: apagado desde …".

**Sin el secreto, el flujo no hace nada:** cada corrida programada termina en verde con el aviso "Falta el secreto FLY_WORKER_START_TOKEN" (el horario queda escrito, pero apagado). Y sin el paso 5, el worker nunca se apaga solo (como hoy).

**Encender ya** (para preparar o publicar sin esperar la revisión, o de noche): **Actions** → **Encender el worker** → **Run workflow**, o `fly machine start <id_worker> -a agentsales` (arriba). Con el paso 5 hecho, se vuelve a apagar solo; no hace falta apagarlo.

**Para una demo** con el horario activado: enciéndelo a mano al empezar. Si la demo tiene pausas de más de 10 minutos sin nada que hacer, el worker se apaga; vuelve a encenderlo o, para ese día, sube `WORKER_IDLE_EXIT_MINUTES` (`fly machine update <id_worker> -a agentsales --env WORKER_IDLE_EXIT_MINUTES=120 --yes`; un despliegue lo devuelve al valor de `fly.toml`).

**Volver atrás:** pídele a Claude volver a poner el `#` en `WORKER_IDLE_EXIT_MINUTES` y despliega (el worker deja de apagarse solo); para que deje de encenderse, en GitHub → **Actions** → **Encender el worker** → **⋯** → **Disable workflow**, o borra el secreto. GitHub también desactiva solo los flujos programados de un repositorio sin cambios en 60 días: si pasa, el mismo menú tiene **Enable workflow**.

**Renovar el token** antes de que venza (6 meses): repite los pasos 2 y 3.

### En vivo solo durante una demo (F9.5)

El servidor corre en simulación (`PUBLISH_MODE = "dry-run"` en `fly.toml`). Para publicar de verdad durante una demo, **tú** cambias el modo de las dos máquinas, la API y el worker, que deben quedar iguales (si no, publicar da `PUBLISH_MODE_MISMATCH`). Es una decisión tuya, por esa vez, y la dices en el chat.

**Desde F9.5-T22 ese cambio es la primera de dos llaves** (ADR-0036): después de pasar el servidor a `live`, solo publican de verdad las marcas encendidas. Con el servidor en `live` y ninguna marca encendida, todo sigue saliendo en simulación. La segunda llave se abre por marca, con tu instrucción en el chat:

```bash
pnpm -s cli brokers live <slug> on --confirm <slug>
```

`--yes` no basta para encender: repites el identificador de la marca con `--confirm`. En el panel, la ficha del corredor (**Corredores**) tiene el interruptor «Modo en vivo» y pide escribir el identificador. Para apagar: `pnpm -s cli brokers live <slug> off`. `pnpm -s cli status` y `doctor` dicen el modo del servidor y qué marcas están encendidas; el banner del panel dice el modo de la marca elegida. Para dejar una marca encendida y el servidor apagado (por ejemplo, entre demos) no hay que apagarla: con el servidor en `dry-run`, todo es simulación.

1. Pasar a vivo (cada comando reinicia esa máquina, unos segundos):
   ```bash
   fly machine update <id_api> -a agentsales --env PUBLISH_MODE=live --yes
   ```
   ```bash
   fly machine update <id_worker> -a agentsales --env PUBLISH_MODE=live --yes
   ```
2. Comprobar: `pnpm -s cli status` dice `PUBLISH_MODE: live`, y el panel muestra la franja roja «En vivo».
3. **Al terminar, volver a simulación** con los mismos dos comandos y `PUBLISH_MODE=dry-run`, y comprobar de nuevo. Antes, mira en **Hoy** o en `pnpm -s cli agenda` que no quede nada programado en vivo: lo programado en vivo conserva su modo y, con el servidor ya en simulación, a su hora falla con `PUBLISH_MODE_MISMATCH` (sin publicar nada) y queda fallida en la agenda. Desprográmalo antes con `pnpm -s cli unschedule <id>` (lo mismo si apagas una marca: lo suyo programado en vivo también falla así).
4. Un despliegue nuevo deja las dos máquinas otra vez en `dry-run` (el valor de `fly.toml`). Las marcas encendidas quedan encendidas (es un dato de la base), pero sin el servidor en `live` no publican de verdad.

NO VERIFICADO: que `fly machine update --env` conserve el resto del entorno y los secretos de la máquina (así lo describe Fly). Compruébalo con `pnpm -s cli status` y `pnpm -s cli doctor` después del primer cambio, en el ensayo del jueves.

**Un secreto llamado `PUBLISH_MODE` anula este cambio (visto el 2026-10-24).** Los dos `fly machine update --env PUBLISH_MODE=live` dijeron «updated successfully» y `fly machine status --display-config` mostró `"PUBLISH_MODE": "live"`, pero `/api/health` seguía en `dry-run`: había un **secreto** `PUBLISH_MODE` (visto con `fly secrets list -a agentsales`) y los secretos pisan el valor de la máquina. Se quitó con `fly secrets unset PUBLISH_MODE -a agentsales` (reinicia las dos máquinas) y entonces `status` y `/api/health` dijeron `live`. **Si `status` no cambia después de `--env`, mira primero `fly secrets list`**: el modo no debe ser un secreto (vive en `fly.toml`). Un `--env` con un secreto del mismo nombre no avisa de nada.

## Paso 9 · Volver a una versión anterior

Cada despliegue queda con la etiqueta de su commit (`sha-…`).

1. Las versiones, con su imagen:
   ```bash
   fly releases -a agentsales --image
   ```
2. Desplegar una anterior sin reconstruir (cambia la etiqueta por la que elegiste):
   ```bash
   fly deploy -a agentsales --image registry.fly.io/agentsales:sha-<los 12 primeros caracteres del commit>
   ```

Volver atrás **no deshace migraciones** ni cambios de secretos. Por eso las migraciones son aditivas: la versión anterior sigue funcionando con la base nueva. La excepción es la `0015` (F9), que además quita el `NOT NULL` de `listing_id` en textos, corridas y publicaciones y cambia el único de `contents`: es compatible hacia atrás solo mientras no haya filas de posts (abajo).

**Ojo con los valores nuevos de F9 (migración `0014`).** La migración solo agrega (las redes `x`, `linkedin`, `discord` y `tiktok`, el estado `outcome_unknown` y la columna `brokers.kind`), así que volver a una versión anterior a F9 funciona **mientras ninguna fila use esos valores**. En cuanto exista una cuenta, un texto o una publicación de X, LinkedIn, Discord o TikTok, o una publicación que haya pasado por `outcome_unknown`, el código viejo no sabe leer esa fila: valida lo que lee y responde un error (`PLATFORM_ACCOUNT_ROW_INVALID`, `CONTENT_ROW_INVALID`, `PUBLICATION_ROW_INVALID` o `PUBLICATION_EVENT_ROW_INVALID`) en las pantallas y los trabajos que la tocan. Una marca (`kind = brand`) no da error, pero el código viejo no conoce la columna y la trata como un corredor más (le muestra Propiedades e Importar y deja activar su publicación automática). Antes de volver atrás a una versión sin F9, pásale a Claude qué versión quieres y te dirá qué filas revisar; lo normal es arreglar hacia adelante con una versión nueva.

**Y con los posts (migración `0015`).** La `0015` suma las tablas de los posts (`posts`, `plan_runs`, `post_uploads`, `editorial_profiles`) y deja nulo `listing_id` en textos, corridas y publicaciones, con un `CHECK` de un solo sujeto. Mientras no exista ningún post con texto, corrida, medio o publicación, la versión anterior a F9 sigue funcionando. Apenas exista uno, el código viejo falla al leer esa fila (`listing_id` nulo → `CONTENT_ROW_INVALID`, `CONTENT_RUN_ROW_INVALID` o `PUBLICATION_ROW_INVALID`) en las pantallas y los trabajos que la tocan, y un trabajo que lista todas las corridas en cola o las publicaciones que vencen se detiene en ella. **Las migraciones `0016` a `0018` (F9-T16, T17 y T20)** solo agregan: `posts.x_link_allowed`, el valor `uploaded` de `post_upload_status`, `posts.platforms` y el índice único de un plan activo por marca. Una versión que no las conoce ignora las columnas nuevas, pero falla al leer una subida en `uploaded` (`POST_UPLOAD_ROW_INVALID`) en lo que la toque, como la limpieza de cada hora, mientras exista.

**La `0021` (F9.5-T25, las imágenes de los posts)** solo agrega la tabla `post_image_runs` y sus dos tipos: una versión anterior la ignora y no hay nada que deshacer al volver atrás.

**La `0020` (F9.5-T22, el modo en vivo por marca)** solo agrega `brokers.live_enabled` (booleano, `false` por defecto): una versión anterior la ignora y no hay nada que deshacer. **Pero `v1.5.0` y las anteriores no conocen esa llave**: con el servidor en `PUBLISH_MODE=live`, publicarían de verdad en **todas** las marcas, estén o no encendidas. **Antes de volver atrás a `v1.5.0` (o anterior), pon `PUBLISH_MODE=dry-run` en las dos máquinas** (API y worker) y comprueba con `pnpm -s cli status`; desprograma además lo programado en vivo (`pnpm -s cli agenda`): con el servidor en simulación, a su hora fallaría con `PUBLISH_MODE_MISMATCH` (sin publicar nada) y quedaría fallida, y si alguien vuelve a poner `PUBLISH_MODE=live` con el código viejo saldría de verdad aunque su marca esté apagada.

**La `0019` (F9.5-T19, la música de los reels)** solo agrega `listings.music_track_id` y `posts.music_track_id` (texto nulo): una versión anterior las ignora y no hay nada que deshacer al volver atrás. Las pistas viven en R2 (`assets/musica/`), fuera de la base: se suben una vez por bucket con `pnpm music:upload <carpeta>` (con `ENV_FILE=.env.production`, el de producción; `docs/integraciones/musica-reels.md`).

**Los planes con `FIRST_PERSON_PLURAL` (F9.5-T23, sin migración).** Al volver a una versión anterior a T23, un plan que tenga un descarte `FIRST_PERSON_PLURAL` muestra sus ideas pero no sus descartes ni sus advertencias (el código viejo no conoce ese código y deja el reporte en blanco). Desde T23 el reporte se lee con tolerancia y un código desconocido solo se salta.

**Y con el video para Discord (F9.5-T10, sin migración).** `discord_video` es un valor nuevo de `media.variant` (texto en la base). Volver atrás a `v1.3.0` o antes funciona mientras no exista ninguna fila con ese valor; apenas `post.media` arme una (un post que va a Discord con un video de más de 20 MiB), el código viejo falla al leer los medios de ese post (`MEDIA_ROW_INVALID`) en el panel, la CLI y los trabajos que lo tocan. Para volver atrás igual, primero mira qué publicaciones de Discord usan esos medios y cancélalas o resuélvelas (las que no terminaron: `cli publications cancel <id>`, o `resolve` si quedaron en resultado dudoso), porque una publicación que apunta a un medio borrado no se puede volver a intentar:

```sql
SELECT p.id, p.status
FROM publications p
JOIN media m ON m.id = ANY (p.media_ids)
WHERE m.variant = 'discord_video'
  AND p.status NOT IN ('published', 'cancelled', 'unpublished');
```

Después borra esas filas (`DELETE FROM media WHERE variant = 'discord_video';`) y, aparte, sus archivos de R2 bajo `posts/…/processed/discord_video/`. La versión vieja publica en Discord el texto solo, como antes. Lo normal es arreglar hacia adelante.

**Revertir los posts a mano** deshace la `0015` a la `0018` **juntas** (en producción las cuatro están aplicadas), en este orden: una guarda que se detiene si la última migración registrada no es la `0018`; borrar lo de los posts (publicaciones con su bitácora, textos, corridas y medios de post; los archivos de R2 bajo `posts/` quedan y se borran aparte); deshacer la `0018`, la `0017` y la `0016`; después la `0015` (los `CHECK`, el único de antes de `contents`, las columnas, tablas y tipos nuevos, y `SET NOT NULL` en `listing_id`); y borrar los **cuatro** registros del migrador. Los cuatro, porque el migrador de Drizzle mira solo el último registro y aplica las migraciones con un `when` mayor: si quedara el de la `0018`, al redesplegar F9 la `0015` no se volvería a aplicar y las tablas de los posts no existirían, sin ningún error. Lo normal es arreglar hacia adelante.

> **Solo a mano, con un respaldo previo (paso 10) y probado antes en una rama de Neon; lo decide el operador.** Borra para siempre los posts, sus textos y sus publicaciones. Es la referencia de cómo deshacer la `0015` a la `0018`, no un paso del despliegue: un test lo corre sobre una copia en memoria, vuelve a aplicar las migraciones con la regla del migrador y comprueba que el esquema queda igual al de una base nueva. Si la guarda se detiene porque hay una migración posterior a la `0018`, este bloque ya no sirve tal cual: pídele a Claude el que corresponde.
>
> **En orden:**
> 1. **Anota lo que ya salió a las redes.** Lo publicado en Instagram, X, LinkedIn, Discord o TikTok se queda allá, pero el bloque borra su enlace y su registro. Antes, guarda los enlaces (`pnpm -s cli publications`) y, si hace falta, bórralos a mano en cada red, como los archivos de R2 bajo `posts/`.
> 2. **Apaga el worker y la API** (paso 8). Con el worker de F9 encendido, un post podría estar saliendo mientras el bloque borra su publicación: llegaría a la red sin dejar registro.
> 3. **Corre el bloque** con `psql "<cadena de la rama>" -v ON_ERROR_STOP=1 -f revertir.sql` o en el SQL Editor de Neon sobre la rama. Es una sola transacción: si la guarda se detiene, no cambia nada.
> 4. **Despliega la versión anterior.** Los trabajos de posts que quedaron en cola (`post.draft`, `post.media`, `content.plan` y los `publication.publish` de posts) fallan al no encontrar su fila, y eso no hace daño.

<!-- revertir-0015-0018: el test packages/db/test/f9-posts-migration.test.ts lee este bloque -->
```sql
BEGIN;
-- 0. Guarda: la última migración registrada debe ser la 0018 (su "when" en
--    packages/db/drizzle/meta/_journal.json). Si no, se detiene sin cambiar nada.
DO $$
BEGIN
  IF (SELECT max(created_at) FROM drizzle.__drizzle_migrations) IS DISTINCT FROM 1792529761221 THEN
    RAISE EXCEPTION 'La última migración registrada no es la 0018: este bloque no sirve tal cual';
  END IF;
END $$;
-- 1. Lo de los posts (la bitácora de sus publicaciones se borra en cascada).
DELETE FROM publications WHERE post_id IS NOT NULL;
DELETE FROM contents WHERE post_id IS NOT NULL;
DELETE FROM content_runs WHERE post_id IS NOT NULL;
DELETE FROM media WHERE post_id IS NOT NULL;
-- 2. La 0018: el índice de un plan activo por marca y las redes del post.
DROP INDEX plan_runs_one_active_per_broker;
ALTER TABLE posts DROP COLUMN platforms;
-- 3. La 0017: Postgres no quita un valor de un enum. 'uploaded' se va con el tipo
--    post_upload_status entero, que se borra en el paso 6 (con post_uploads).
-- 4. La 0016: la marca del enlace en X.
ALTER TABLE posts DROP COLUMN x_link_allowed;
-- 5. La 0015: los CHECK de un solo sujeto.
ALTER TABLE publications DROP CONSTRAINT publications_one_subject;
ALTER TABLE contents DROP CONSTRAINT contents_one_subject;
ALTER TABLE content_runs DROP CONSTRAINT content_runs_one_subject;
ALTER TABLE media DROP CONSTRAINT media_at_most_one_subject;
-- 6. La 0015: el único de antes, un texto por corrida y canal.
ALTER TABLE contents DROP CONSTRAINT contents_run_platform_language_unique;
ALTER TABLE contents ADD CONSTRAINT contents_run_platform_unique UNIQUE (content_run_id, platform);
-- 7. La 0015: las columnas (con sus llaves e índices), las tablas y los tipos nuevos.
ALTER TABLE publications DROP COLUMN post_id, DROP COLUMN language, DROP COLUMN cost_usd;
ALTER TABLE contents DROP COLUMN post_id, DROP COLUMN language;
ALTER TABLE content_runs DROP COLUMN post_id;
ALTER TABLE media DROP COLUMN post_id;
DROP TABLE post_uploads, posts, plan_runs, editorial_profiles;
DROP TYPE post_upload_status, post_status, post_source, post_kind, plan_run_status, brief_origin;
-- 8. La 0015: listing_id vuelve a ser obligatorio.
ALTER TABLE publications ALTER COLUMN listing_id SET NOT NULL;
ALTER TABLE contents ALTER COLUMN listing_id SET NOT NULL;
ALTER TABLE content_runs ALTER COLUMN listing_id SET NOT NULL;
-- 9. Los registros de la 0015, 0016, 0017 y 0018 (sus "when" en _journal.json): así, al
--    redesplegar F9, el migrador vuelve a aplicar las cuatro.
DELETE FROM drizzle.__drizzle_migrations
WHERE created_at IN (1792463061827, 1792508198594, 1792511001808, 1792529761221);
COMMIT;
```

Después de correrlo, la base queda como tras la `0014`: una versión anterior a los posts la lee igual, y redesplegar F9 aplica de nuevo la `0015` a la `0018`.

## Paso 10 · Restaurar un respaldo

Hazlo siempre primero en una **rama nueva de Neon**, nunca encima de la base de producción, y cámbiate a ella solo cuando hayas revisado que está bien.

- **Con la restauración de Neon** (lo más simple): en **console.neon.tech** → el proyecto → **Restore**: elige la base de producción y la hora, y Neon la restaura a una rama nueva. El plan gratis guarda poco historial (horas); con Neon Launch, 7 días.
- **Con un volcado del bucket de respaldos** (el worker deja uno por día encendido, los últimos 14):
  1. En **dash.cloudflare.com** → **R2** → `agentsales-backups` → carpeta `db/`, descarga el más reciente (`agentsales-AAAAMMDD-HHMM.dump`, la hora es de Chile) y muévelo a `~/.agentsales/backups` (nunca a la carpeta del proyecto: trae datos de clientes).
  2. Comprueba que se lee (lista su contenido sin tocar ninguna base):
     ```bash
     /opt/homebrew/opt/libpq/bin/pg_restore --list ~/.agentsales/backups/<archivo>.dump | head
     ```
  3. Sigue con los pasos de abajo desde el 1, con ese archivo (probado el 2026-10-19: se restauró sin errores en una base nueva).
- **Con un volcado de `pnpm db:backup`** (en `~/.agentsales/backups`):
  1. En Neon, crea una rama sin datos (**Create child branch** → **Branch schema only**; ponle borrado automático) y, dentro de ella, una base nueva (**Databases** → **Add database**, por ejemplo `restauracion`). En **Connect** elige esa base y copia su cadena de conexión: el host debe ser el de la rama nueva, no el de producción.
  2. Restaura el volcado en ella (necesita `brew install libpq`):
     ```bash
     /opt/homebrew/opt/libpq/bin/pg_restore --no-owner --no-acl -d "<cadena de la rama nueva>" ~/.agentsales/backups/<archivo>.dump
     ```
  3. Revisa los datos con el panel de Neon. Si están bien, cambia `DATABASE_URL` en Fly a la rama nueva (esto reinicia las máquinas encendidas):
     ```bash
     printf 'DATABASE_URL=%s\n' "<cadena de la rama nueva>" | fly secrets import -a agentsales
     ```

Si tienes dudas en este paso, pídele ayuda a Claude antes de cambiar la base del servidor (sin pegar la cadena en el chat).

### Borrar un corredor de verdad (F9.5-T14, ADR-0035)

Para limpiar los corredores de prueba antes de una demo (o cuando un cliente se va y pide borrar sus datos). Se lleva **todo lo suyo**: propiedades, fotos y videos (en la base y en R2), textos, publicaciones con su historial, posts, planes, perfil editorial, cargas, cuentas conectadas con sus credenciales y usuarios con sus sesiones. **No se puede deshacer**: la única vuelta atrás es restaurar un respaldo (arriba). No borra nada en las redes: lo publicado sigue allá (para eso está retirar).

1. **Respaldo antes**, desde tu Mac (deja el volcado en `~/.agentsales/backups`):
   ```bash
   ENV_FILE=.env.production pnpm db:backup
   ```
   Si no tienes `.env.production` a mano, revisa en R2 (`agentsales-backups` → `db/`) que el respaldo de hoy del worker esté ahí.
2. **Mira el resumen** (con la sesión del administrador en el servidor: `pnpm -s cli login --api https://<dominio>`): sin `--confirm` no borra nada.
   ```bash
   pnpm -s cli brokers delete <slug>
   ```
   Dice cuántas propiedades, medios, publicaciones, posts, usuarios, cuentas y cargas se van. Si alguna publicación está publicándose, programada, esperando tu clic o con resultado dudoso, se niega y lista cuáles: desprográmalas o cancélalas, confirma o di «no lo publiqué» en las que esperan y resuelve las dudosas.
3. **Borra**, repitiendo el identificador (`--yes` no sirve aquí):
   ```bash
   pnpm -s cli brokers delete <slug> --confirm <slug>
   ```
   El resumen también dice cuántas publicaciones están publicadas o pausadas: **seguirán publicadas en las redes** (si quieres bajarlas, retíralas antes de borrar). Al final dice cuántas filas y cuántos archivos de R2 se borraron. Si R2 no pudo borrar alguno, la base ya quedó borrada igual y la lista sale en la terminal (y completa en los logs: busca «R2 no borró un archivo del corredor borrado» en `fly logs -a agentsales`); bórralos a mano en **dash.cloudflare.com** → **R2** → el bucket de medios, por su clave.

**Trabajos del worker en cola de un corredor borrado** (revisado en el código, F9.5-T14): cada job recarga su fila al empezar, y si ya no existe falla con un error **no reintentable** (`CONTENT_RUN_NOT_FOUND` para preparar textos o pedir los de un post, `PLAN_RUN_NOT_FOUND` para un plan, `IMPORT_RUN_NOT_FOUND` para una carga, `PUBLICATION_NOT_FOUND` para publicar o leer el estado en Portal). El worker lo anota **una vez** en el log («job falló sin reintento (error no reintentable)») y lo cierra: pg-boss no lo reintenta. Procesar los medios de un post borrado se salta sin error (`skipped`, con un aviso informativo). Un trabajo que ya estaba corriendo y escribe después del borrado choca con una FK (`DB_QUERY_FAILED`, también no reintentable); si alcanzó a subir un archivo a R2 después de la limpieza, queda suelto bajo `brokers/<id>/` o `posts/<id>/` y se borra a mano. Por eso conviene borrar sin preparaciones ni cargas en curso de ese corredor (el borrado no lo exige). Los trabajos periódicos (publicar lo programado, vigilar publicaciones, renovar tokens) buscan por estado y no ven nada del corredor borrado. Ninguna publicación programada o publicándose puede quedar en cola: el borrado se niega con ellas.

## Paso 11 · Pasar a siempre encendido (cuando decidas pagar)

Fuera de F8. Cuando quieras que los corredores usen la herramienta cualquier día:

1. Neon: **Billing** → **Launch** (unos US$ 20 al mes con el worker siempre encendido; el plan gratis no alcanza: se agota en unos 17 días).
2. Pídele a Claude el cambio de `fly.toml` (la API sin apagarse sola y el worker siempre encendido) y despliega.
3. El costo total queda en unos US$ 37 a 48 al mes (spec F8 §4.15).

## Una segunda instancia (D19 de F9)

**Cuándo:** mientras solo la uses tú, hay **una instancia** (la de esta guía). Según la D19 del spec F9, se arma una segunda **del mismo código** cuando ocurra lo primero de esto: entra el primer dato real de un cliente, la oficina firma el piloto, o un incidente con una red amenaza la app compartida. Cada instancia tiene lo suyo: app de Fly, dominio, base, buckets, secretos, Environment de GitHub y apps de Meta, TikTok y X. Lo único que comparten es el código (y tus cuentas de Fly, Neon, Cloudflare y GitHub).

**Los nombres:** en el flujo de despliegue, la de hoy se llama **`principal`** (usa `fly.toml` y el Environment `production`) y **no cambia en nada**. La nueva necesita un nombre corto en minúsculas, por ejemplo `clientes` o `personal`. Cuál queda para tus clientes y cuál para tu marca lo decides tú: si la de hoy pasa a ser la de clientes, no hay que moverla. Abajo, reemplaza:

- `<instancia>`: el nombre corto (por ejemplo `clientes`).
- `<app>`: su app de Fly (por ejemplo `agentsales-clientes`).
- `<dominio>`: su dirección (por ejemplo `clientes.agentpey.com`), otro nombre que el de la principal.

**Quién hace qué:** los archivos los prepara Claude con un PR (paso B). Todo lo demás lo haces tú, en tu terminal o en el navegador. Como siempre, ningún secreto pasa por el chat ni queda en un archivo del proyecto que vaya a git.

### A · Las cuentas y los servicios (tú)

1. **La app de Fly y sus direcciones IP** (la IPv4 compartida y la IPv6 no cuestan; no pidas una IPv4 dedicada):
   ```bash
   fly apps create <app>
   ```
   ```bash
   fly ips allocate-v4 --shared -a <app>
   ```
   ```bash
   fly ips allocate-v6 -a <app>
   ```
2. **La base de Neon:** un **proyecto nuevo** en **console.neon.tech** → **New project**, en la misma región que el de hoy (AWS São Paulo), y sigue `docs/09-alta-neon-r2.md` (parte A: la cadena **sin** `-pooler`). Un proyecto aparte, y no una rama del de hoy, deja separados los datos, el cupo gratis y los respaldos de Neon. Cuántos proyectos permite el plan gratis es NO VERIFICADO: si Neon no te deja crear otro, avísale a Claude antes de usar una rama del proyecto de hoy.
3. **Los dos buckets de R2** (`docs/09-alta-neon-r2.md`, parte B), cada uno con **su propio token** "Object Read & Write" limitado a él:
   - `<app>-media`, con la misma regla de CORS que `agentsales-media` pero desde el dominio nuevo: solo `PUT`, origen `https://<dominio>`, cabeceras `content-type` y `x-amz-checksum-sha256`.
   - `<app>-backups`, para el respaldo diario (su token no puede ser el del bucket de medios: el servidor no arranca si son el mismo).
4. **El archivo `.env.<instancia>`** en la carpeta del proyecto (git ya lo ignora, como `.env.production`; Claude no lo lee). Lleva los mismos nombres que `.env.production`, con los valores de la instancia nueva:
   - `PUBLIC_URL=https://<dominio>` (la usan los scripts como `auth:admin`).
   - `DATABASE_URL` del proyecto nuevo de Neon; `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` y `R2_BUCKET=<app>-media`; `BACKUP_R2_ACCESS_KEY_ID` y `BACKUP_R2_SECRET_ACCESS_KEY` del token de `<app>-backups`.
   - **Una `APP_ENCRYPTION_KEY` nueva** (44 caracteres aleatorios con tu gestor de contraseñas, o `openssl rand -base64 32 | pbcopy`, que la deja en el portapapeles sin mostrarla), guardada también en tu gestor: sin ella no se leen los tokens de las cuentas que conectes en esa instancia.
   - `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` y `FACEBOOK_APP_SECRET` de **su** app de Meta (punto 8), y los pares de sus apps de LinkedIn, X y TikTok si los usa (punto 8).
   - `ANTHROPIC_API_KEY`: mejor otra clave, para ver el gasto de cada instancia por separado. `BCCH_API_TOKEN` puede ser el mismo. `ML_APP_ID` y `ML_CLIENT_SECRET`, solo si esa instancia usa Portal (punto 8).
   - Las direcciones de vuelta de los OAuth no van: salen de `PUBLIC_URL`.

   Revisa el bucket y su CORS (habla con R2, no con la base):
   ```bash
   ENV_FILE=.env.<instancia> pnpm storage:check --origin https://<dominio>
   ```
5. **Los secretos en Fly:** el mismo comando del «Paso 2 · Los secretos» de arriba, con el archivo y la app nuevos (los pares de X y TikTok de esa instancia se suben aparte, como en el paso 2, cuando la instancia vaya a usarlos):
   ```bash
   grep -E '^(DATABASE_URL|R2_ACCOUNT_ID|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_BUCKET|APP_ENCRYPTION_KEY|ANTHROPIC_API_KEY|INSTAGRAM_APP_ID|INSTAGRAM_APP_SECRET|FACEBOOK_APP_SECRET|ML_APP_ID|ML_CLIENT_SECRET|LINKEDIN_CLIENT_ID|LINKEDIN_CLIENT_SECRET|BCCH_API_TOKEN|BACKUP_R2_ACCESS_KEY_ID|BACKUP_R2_SECRET_ACCESS_KEY)=' .env.<instancia> | fly secrets import --stage -a <app>
   ```
   ```bash
   fly secrets list -a <app>
   ```
6. **El dominio y su certificado:** el «Paso 5 · El dominio y su certificado» de arriba, completo, con `<app>` y `<dominio>` (en Vercel, el registro `A` y el `AAAA` con el nombre del subdominio nuevo).
7. **El Environment de GitHub `production-<instancia>`, antes del primer despliegue:** el repositorio → **Settings** → **Environments** → **New environment** → `production-<instancia>` → **Configure environment**: **Deployment branches and tags** en **Selected branches and tags** con la regla **`main`**, y **Allow administrators to bypass configured protection rules** desmarcado (lo mismo que `production`, paso 3). Después, su token de Fly, que solo sirve para `<app>`:
   ```bash
   fly tokens create deploy -a <app> -n github-deploy -x 4380h | pbcopy
   ```
   ```bash
   pbpaste | gh secret set FLY_API_TOKEN --env production-<instancia>
   ```
   Si un despliegue de esa instancia corre antes de crearlo, GitHub crea el Environment vacío y **sin la regla de `main`**: el flujo se corta por la falta del token, pero configúralo igual (la regla y el token) antes de seguir. Anota en tu calendario renovar este token (6 meses), aparte del de `production`.
8. **Las apps propias de cada red:** la instancia nueva no usa las apps de la principal (D19), así un problema con una red en una no toca a la otra.
   - **Meta:** una app nueva como `AgentSales-IG`, con el caso de uso de Instagram y, en *Business login settings* (`docs/07-checklist-cuentas.md`, "Direcciones de vuelta de Meta"): la vuelta `https://<dominio>/api/oauth/instagram/callback`, la de cancelar la autorización `https://<dominio>/api/meta/deauthorize` y la de eliminación de datos `https://<dominio>/api/meta/data-deletion`. Su revisión de Meta (App Review) y la verificación de la empresa van por separado (`docs/11-app-review-meta.md`).
   - **TikTok y X:** una app propia en cada una, con su dirección de vuelta: `https://<dominio>/api/oauth/tiktok/callback` y `https://<dominio>/api/oauth/x/callback` (sus notas: `docs/integraciones/tiktok.md` y `x.md`). Sus pares (`TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `X_CLIENT_ID`, `X_CLIENT_SECRET`) van en `.env.<instancia>`.
   - **LinkedIn** (si esa instancia publica en LinkedIn): mejor una app propia, con `https://<dominio>/api/oauth/linkedin/callback`; sus pares van en el comando del punto 5. **Discord** no tiene app: cada marca conecta su webhook.
   - **Mercado Libre** (si esa instancia usa Portal): mejor una app propia; con la de hoy también funciona, agregando `https://<dominio>/api/oauth/mercadolibre/callback` en **Redirect URIs** (el panel acepta varias), pero entonces comparten la app.

### B · Los archivos de la instancia (Claude, con un PR)

Pídele a Claude "la instancia `<instancia>` con la app `<app>` y el dominio `<dominio>`". El PR trae:

- **`fly.<instancia>.toml`:** una copia de `fly.toml` con cuatro valores cambiados: `app = "<app>"`, `PUBLIC_URL = "https://<dominio>"`, el `Host` del chequeo (`<dominio>`) y `BACKUP_R2_BUCKET = "<app>-backups"`. Todo lo demás igual, también `PUBLISH_MODE = "dry-run"` (pasarlo a `live` en esa instancia es otra decisión tuya, en el chat).
- **`.github/workflows/deploy.yml`:** `<instancia>` agregada a las opciones de la entrada `instance`.
- **Sin el apagado solo:** en `fly.<instancia>.toml`, `WORKER_IDLE_EXIT_MINUTES` queda comentado. El flujo que enciende el worker (`worker-schedule.yml`, paso 8) solo enciende la app principal (`FLY_APP` está fijo), así que el worker de otra instancia que se apagara solo no volvería a encenderse y nada programado saldría. Para activarlo en esa instancia hace falta su propio horario (otro flujo o una entrada de instancia en este, con su Environment y su token): pídelo antes.

El flujo se niega a desplegar otra instancia si falta su archivo o si repite la app, el dominio, el `Host` o el bucket de respaldos de la principal: una copia a medio cambiar nunca despliega encima de la instancia de hoy.

### C · Desplegar esa instancia (tú)

Igual que el paso 4 (solo `main`, con la CI en verde), eligiendo la instancia:

- **En GitHub:** **Actions** → **Desplegar** → **Run workflow** → rama `main` → **Instancia** `<instancia>` → **Run workflow**.
- **En la terminal:**
  ```bash
  gh workflow run deploy.yml --ref main -f instance=<instancia>
  ```

Sin `-f instance=…` (o con **Instancia** en `principal`), el flujo despliega la de hoy, como siempre. En la base nueva, el `release_command` aplica todas las migraciones desde cero. Después:

1. Tu administrador en esa instancia (el enlace queda en el portapapeles):
   ```bash
   ENV_FILE=.env.<instancia> pnpm auth:admin --email tu@correo.cl
   ```
2. El «Paso 6 · Comprobar que funciona» de arriba con `https://<dominio>` (salud, entrar, activar el doble factor) y la CLI contra ella:
   ```bash
   pnpm -s cli login --email tu@correo.cl --api https://<dominio>
   ```
   La CLI recuerda un servidor a la vez: para volver a la principal, entra de nuevo con su `--api`.
3. El corredor de pruebas (`agentsales-pruebas`) no se crea solo; si lo quieres en esa instancia: `ENV_FILE=.env.<instancia> pnpm db:seed`, **sin** `--operator-brands`: tus marcas (`vinny` y `agentpey`, spec F9 D19) van solo en tu instancia, con `pnpm db:seed --operator-brands`, nunca en la de clientes. Los corredores reales se crean desde el panel o con `brokers create`.

### D · El día a día con dos instancias

- **Cada comando de `fly` lleva el `-a` de su instancia** (logs, máquinas, secretos, versiones): `fly logs -a <app>`, `fly machine list -a <app>`… El modo demo (paso 8) y el cupo de Neon van por separado en cada una.
- **Volver atrás en la otra instancia, siempre con su archivo:**
  ```bash
  fly deploy -c fly.<instancia>.toml --image registry.fly.io/<app>:sha-<los 12 primeros caracteres del commit>
  ```
  Con `-a <app>` y sin `-c`, `fly deploy` toma `fly.toml`, el de la principal (su dominio y su bucket), y arrancaría la otra instancia mal configurada.
- **Cada instancia se despliega por separado:** un `main` en verde puede ir a una y no a la otra, y cada una aplica sus migraciones al desplegarse (por eso siguen siendo aditivas). El flujo hace un despliegue a la vez, también entre instancias, y GitHub deja **uno solo esperando**: si lanzas un tercero mientras uno corre y otro espera, el que esperaba se cancela (aunque sea de la otra instancia). Lanza el siguiente cuando termine el anterior.
- **Si cambia `fly.toml`** (memoria, procesos, chequeos…), el mismo cambio va en cada `fly.<instancia>.toml`, en el mismo PR.
- **El `.env` del Mac nunca apunta a la base de la otra instancia:** `pnpm db:dev-scrub` reconoce producción solo por `.env.production` (la misma base o clave), así que no protegería la base de `<instancia>`, cuya clave es otra.

## Problemas comunes

| Qué ves | Qué hacer |
|---|---|
| GitHub dice "Branch … is not allowed to deploy to production due to environment protection rules", o el flujo dice "Solo se despliega desde main" | Lo lanzaste desde otra rama: lánzalo desde `main` (en GitHub, elige la rama `main` en **Run workflow**). Es la protección del Environment (paso 3), probada el 2026-10-18 |
| "La CI no está en verde sobre …" | Espera a que termine la CI de ese commit en `main`, o arréglala antes de desplegar |
| "Falta el secreto FLY_API_TOKEN" | Paso 3: el secreto va en el Environment `production`, no en los del repositorio |
| El despliegue falla en `release_command` | Falló una migración: `fly logs -a agentsales` muestra el error. La versión anterior sigue corriendo. Pásale el error a Claude (sin secretos) |
| La API no arranca y los logs dicen `PUBLIC_URL`, `API_HOST`, `CLIENT_IP_HEADER`, `LLM_PROVIDER` (debe ser `anthropic-api`), `BACKUP_TARGET` (debe ser `r2`, con las credenciales del bucket de respaldos), `BROWSER_PROFILES_DIR` (no debe estar) o un secreto que falta | Falta un secreto (paso 2) o cambió `fly.toml`. `fly secrets list -a agentsales` muestra los nombres |
| `https://agentsales.agentpey.com` no abre | `fly certs check agentsales.agentpey.com -a agentsales` (paso 5) y que la máquina `api` exista (`fly status`) |
| `doctor` dice que el worker está apagado | Si es día de demo, enciéndelo (paso 8). Con el horario activado es lo normal sin nada por vencer: `doctor` dice la próxima revisión |
| La agenda dice "El worker está apagado y hay algo por vencer" | Sale en la próxima revisión del horario; para que salga ya, **Actions** → **Encender el worker** → **Run workflow** (paso 8, "El worker con horario") |
| Una corrida de "Encender el worker" dice "Falta el secreto FLY_WORKER_START_TOKEN" | El horario no está activado: paso 8, "El worker con horario", puntos 1 a 3 |
| `doctor` dice que el respaldo está atrasado o que falló | Con el worker encendido, respalda al arrancar (si el último tiene más de 20 h) y cada día a las 13:00. El código del error está en los logs del worker (paso 7). `STORAGE_ERROR`: el token o el bucket de respaldos no calzan (paso 2); `STORAGE_UNAVAILABLE`: R2 no respondió y se reintenta a los 5 min |
| Se agotó el cupo de Neon | Quedó el worker encendido. Neon no borra datos: vuelve el mes siguiente o pasa a Launch (paso 11) |
| El flujo dice "Falta `fly.<instancia>.toml` en main" o "tiene el mismo … que la instancia principal" | Otra instancia sin su archivo, o con un valor copiado de `fly.toml`: pídele a Claude el PR del paso B de "Una segunda instancia" |
| "Falta el secreto FLY_API_TOKEN en el Environment `production-<instancia>`" | El Environment de esa instancia no tiene su token (o lo creó GitHub vacío): punto 7 de "Una segunda instancia" |
