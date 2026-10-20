# 10 · Desplegar en Fly.io (guía del operador)

Guía paso a paso para poner AgentSales en internet, en `https://agentsales.agentpey.com`. Decisiones: spec F8 (§4.7 y §4.15, D1, D2, D8 y D9) y ADR-0024. Lo verificado de Fly está en `docs/integraciones/hosting.md` §14, con lo que todavía no se pudo comprobar marcado como NO VERIFICADO.

**Cuándo:** la primera puesta en marcha es la tarea T21 de F8, después del lote E (el respaldo a R2, que producción exige para arrancar) y del resto de los lotes de F8.

**Quién hace qué:** todo lo de esta guía lo haces tú en tu terminal o en el navegador: crear la cuenta, poner los secretos, desplegar, encender y apagar. Claude prepara el código y los archivos (`Dockerfile`, `fly.toml`, `.github/workflows/deploy.yml`) y nunca despliega (D8). Los secretos nunca se pegan en el chat.

## Cómo queda armado

- **Una app de Fly** (`agentsales`, en São Paulo, junto a Neon) con **dos procesos** de la misma imagen:
  - **`api`**: el panel y la API. Se apaga sola cuando nadie la usa y se enciende con el primer pedido (tarda unos segundos).
  - **`worker`**: prepara, publica y corre lo programado. **No se apaga solo**: lo enciendes y lo apagas tú (paso 8).
- **Modo demo (D1):** las máquinas se encienden los días de demo y se apagan después. Cuesta unos US$ 0,56 por día encendido, más centavos por el disco de las máquinas apagadas. Con el worker apagado, Neon se duerme y no gasta su cupo gratis.
- **Simulación (D9):** el servidor corre con `PUBLISH_MODE=dry-run` (en `fly.toml`). Pasarlo a `live` es una decisión tuya, que pides en el chat.
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
grep -E '^(DATABASE_URL|R2_ACCOUNT_ID|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_BUCKET|APP_ENCRYPTION_KEY|ANTHROPIC_API_KEY|INSTAGRAM_APP_ID|INSTAGRAM_APP_SECRET|FACEBOOK_APP_SECRET|ML_APP_ID|ML_CLIENT_SECRET|BCCH_API_TOKEN|BACKUP_R2_ACCESS_KEY_ID|BACKUP_R2_SECRET_ACCESS_KEY)=' .env.production | fly secrets import --stage -a agentsales
```

- `--stage` guarda los secretos sin encender nada; los toman las máquinas al arrancar.
- Fly toma cada línea tal cual (`NOMBRE=valor`). Si en `.env.production` algún valor está entre comillas, quítaselas en el archivo antes de correr el comando.
- `FACEBOOK_APP_SECRET` es opcional (las vueltas de Meta, F8-T17): si no está en `.env.production`, el comando simplemente no la copia.
- `DATABASE_URL` es la de la base de producción de Neon (no la rama `dev`), `R2_BUCKET` es `agentsales-media`, y `APP_ENCRYPTION_KEY` es la de producción (sin ella no se pueden leer los tokens de las cuentas conectadas).
- `BACKUP_R2_ACCESS_KEY_ID` y `BACKUP_R2_SECRET_ACCESS_KEY` son el token del bucket `agentsales-backups` (checklist, "Antes del primer despliegue"), **no** el de `agentsales-media`: el servidor no arranca si son el mismo. Fly le da los secretos a los dos procesos: la API no los usa, los quita de su configuración y de su entorno al arrancar (así ningún proceso que abra los hereda) y nunca abre el bucket de respaldos; solo el worker sube los respaldos. No es un aislamiento total (el sistema guarda el entorno con que arrancó cada proceso), pero la API ya no puede usarlo por error. Sin ellos, el servidor no arranca (producción exige el respaldo a R2).
- **`INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET` son el par de la app de Instagram, no el de la app general de Meta.** Están en Meta, `AgentSales-IG` → **Casos de uso → Administrar mensajes y contenido en Instagram → Personalizar → Configuración de la API con el inicio de sesión de Instagram** (el *Instagram app ID* y el *Instagram app secret*, con el botón Mostrar), no en Configuración → Información básica. Si la clave no es la de Instagram, el botón Conectar Instagram vuelve con "Instagram no aceptó la conexión (el código venció o ya se usó)": compara los 4 primeros y los 4 últimos caracteres con tu `.env.production`, sin copiarla. `FACEBOOK_APP_SECRET` (opcional) sí es la de Información básica.
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

Debe mostrar una máquina `api` y una `worker`. **Después de cada despliegue en modo demo, revisa que el worker quedó como querías** (un despliegue puede encenderlo: NO VERIFICADO, `hosting.md` §14.2). Si no es día de demo, apágalo (paso 8).

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

Volver atrás **no deshace migraciones** (por eso son siempre aditivas: la versión anterior sigue funcionando con la base nueva) ni cambios de secretos.

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
   - `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` y `FACEBOOK_APP_SECRET` de **su** app de Meta (punto 8).
   - `ANTHROPIC_API_KEY`: mejor otra clave, para ver el gasto de cada instancia por separado. `BCCH_API_TOKEN` puede ser el mismo. `ML_APP_ID` y `ML_CLIENT_SECRET`, solo si esa instancia usa Portal (punto 8).
   - Las direcciones de vuelta de los OAuth no van: salen de `PUBLIC_URL`.

   Revisa el bucket y su CORS (habla con R2, no con la base):
   ```bash
   ENV_FILE=.env.<instancia> pnpm storage:check --origin https://<dominio>
   ```
5. **Los secretos en Fly:** el mismo comando del paso 2, con el archivo y la app nuevos (si se suman variables de otras redes, como las de TikTok o X, su tarea las agrega a esta lista y a la del paso 2):
   ```bash
   grep -E '^(DATABASE_URL|R2_ACCOUNT_ID|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|R2_BUCKET|APP_ENCRYPTION_KEY|ANTHROPIC_API_KEY|INSTAGRAM_APP_ID|INSTAGRAM_APP_SECRET|FACEBOOK_APP_SECRET|ML_APP_ID|ML_CLIENT_SECRET|BCCH_API_TOKEN|BACKUP_R2_ACCESS_KEY_ID|BACKUP_R2_SECRET_ACCESS_KEY)=' .env.<instancia> | fly secrets import --stage -a <app>
   ```
   ```bash
   fly secrets list -a <app>
   ```
6. **El dominio y su certificado:** el paso 5 completo, con `<app>` y `<dominio>` (en Vercel, el registro `A` y el `AAAA` con el nombre del subdominio nuevo).
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
   - **TikTok y X:** una app propia en cada una, con la dirección de vuelta en `https://<dominio>/api/oauth/…`; la dirección exacta la fija la tarea de cada red (por ejemplo T26 para TikTok) y queda en su nota de `docs/integraciones/`.
   - **Mercado Libre** (si esa instancia usa Portal): mejor una app propia; con la de hoy también funciona, agregando `https://<dominio>/api/oauth/mercadolibre/callback` en **Redirect URIs** (el panel acepta varias), pero entonces comparten la app.

### B · Los archivos de la instancia (Claude, con un PR)

Pídele a Claude "la instancia `<instancia>` con la app `<app>` y el dominio `<dominio>`". El PR trae:

- **`fly.<instancia>.toml`:** una copia de `fly.toml` con cuatro valores cambiados: `app = "<app>"`, `PUBLIC_URL = "https://<dominio>"`, el `Host` del chequeo (`<dominio>`) y `BACKUP_R2_BUCKET = "<app>-backups"`. Todo lo demás igual, también `PUBLISH_MODE = "dry-run"` (pasarlo a `live` en esa instancia es otra decisión tuya, en el chat).
- **`.github/workflows/deploy.yml`:** `<instancia>` agregada a las opciones de la entrada `instance`.

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
2. El paso 6 con `https://<dominio>` (salud, entrar, activar el doble factor) y la CLI contra ella:
   ```bash
   pnpm -s cli login --email tu@correo.cl --api https://<dominio>
   ```
   La CLI recuerda un servidor a la vez: para volver a la principal, entra de nuevo con su `--api`.
3. El corredor de pruebas (`agentsales-pruebas`) no se crea solo; si lo quieres en esa instancia: `ENV_FILE=.env.<instancia> pnpm db:seed`. Los corredores reales se crean desde el panel o con `brokers create`.

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
| `doctor` dice que el worker está apagado | Si es día de demo, enciéndelo (paso 8) |
| `doctor` dice que el respaldo está atrasado o que falló | Con el worker encendido, respalda al arrancar (si el último tiene más de 20 h) y cada día a las 13:00. El código del error está en los logs del worker (paso 7). `STORAGE_ERROR`: el token o el bucket de respaldos no calzan (paso 2); `STORAGE_UNAVAILABLE`: R2 no respondió y se reintenta a los 5 min |
| Se agotó el cupo de Neon | Quedó el worker encendido. Neon no borra datos: vuelve el mes siguiente o pasa a Launch (paso 11) |
| El flujo dice "Falta `fly.<instancia>.toml` en main" o "tiene el mismo … que la instancia principal" | Otra instancia sin su archivo, o con un valor copiado de `fly.toml`: pídele a Claude el PR del paso B de "Una segunda instancia" |
| "Falta el secreto FLY_API_TOKEN en el Environment `production-<instancia>`" | El Environment de esa instancia no tiene su token (o lo creó GitHub vacío): punto 7 de "Una segunda instancia" |
