# Hosting para F8 (precios y límites), dominio y respaldos fuera del Mac

Nota **consultada el 2026-10-18** en las páginas oficiales de precios y documentación de cada proveedor, para decidir el despliegue de F8 (`docs/06-roadmap.md`, "F8 · En internet"). Solo documentación pública: no se leyó `.env`, `data/muestras` ni la carpeta de perfiles del navegador, no se creó ninguna cuenta y no se hizo ninguna llamada autenticada. La única llamada "de API" fue la lectura sin clave de los endpoints públicos `regions` y `plans` de Vultr (no necesitan cuenta).

Convención: **DOC** = leído en la página oficial (URL y fecha en la sección 10); **INFERENCIA** = deducido de lo leído o cálculo mío (la fórmula va al lado); **NO VERIFICADO** = la doc no lo dice o no pude abrir la página; se cierra con una prueba (sección 8). Los precios están en USD por mes de 30 días, sin impuestos, salvo que se indique otra cosa.

Las secciones 3 (OAuth) y 5 (Medios) de la plantilla se reinterpretan: la 3 trata de cómo se configuran dominio, certificado y secretos; la 5, del peso de los archivos y la salida de datos.

## 1. Resumen

- **Mecanismo:** dos procesos siempre encendidos (`api` y `worker`) en un proveedor de contenedores o en un VPS, con Neon (base) y Cloudflare R2 (archivos) como hasta hoy. La CLI y el panel hablan con la API por HTTPS. El worker de Marketplace queda en el Mac.
- **Precio mensual de api (512 MB) + worker (1 a 2 GB), solo cómputo** (detalle en la sección 2.9): Railway ≈ 10–15 (por uso), Fly.io `gru` ≈ 17 a 28, VPS Vultr Santiago 2 vCPU/4 GB = 20, Lightsail São Paulo 4 GB = 24, Render = 32, Cloud Run Santiago ≈ 85–90.
- **Hay región en Sudamérica solo en:** Fly.io (`gru`, São Paulo; **Santiago no figura** en la lista actual), Cloud Run (`southamerica-east1` y `southamerica-west1` = Santiago, ambas "Tier 2"), Vultr (São Paulo **y Santiago**), AWS Lightsail (`sa-east-1`, São Paulo) y Akamai/Linode (São Paulo; Santiago sin confirmar). **Railway y Render no tienen ninguna** (EE. UU., Europa y Singapur). Hetzner y DigitalOcean tampoco (DOC).
- **Hallazgo que cambia el presupuesto: Neon gratis no alcanza con el worker 24/7.** Un cómputo de 0,25 CU encendido todo el mes gasta ≈ 182 CU-horas y el plan gratis da 100 (DOC, fórmula de Neon; ADR-0007 ya lo advertía). El plan **Launch** no tiene mínimo mensual y cobra US$0,106 por CU-hora: ≈ **US$19–20 al mes** con el cómputo siempre despierto (INFERENCIA). Esto pesa tanto como el hosting.
- **Dominio:** `.cl` en NIC Chile = **$9.990 CLP por año, exento de IVA** (DOC); Cloudflare Registrar **no ofrece `.cl`** (no figura en su lista de TLDs, DOC) pero sí `.com` a precio de costo (≈ US$10,5; sube cerca de US$0,7 el 2026-11-01 según fuentes secundarias).
- **Respaldos:** `pg_dump` desde el worker a un prefijo `backups/` de R2 con regla de expiración. El plan gratis de R2 (10 GB, 1 M clase A, 10 M clase B, salida gratis) sobra (DOC). Debian trixie solo trae `postgresql-client-17`; para Neon 18 hay que instalar `postgresql-client-18` desde PGDG (existe para Debian 12 y 13, amd64 y arm64; DOC).
- **Cron:** basta con `pg-boss schedule` en el worker (ya lo usa `db.backup`). Con el worker 24/7 desaparece el problema de ADR-0007 de los cron perdidos mientras estaba apagado.
- **Demo gratis (sección 13, 2026-10-18):** lo único gratis que aguanta el worker es una VM Oracle Always Free Ampere A1 (hoy **2 OCPU/12 GB**, no 4/24) en Santiago, con Postgres en la misma VM; Render, Koyeb, Cloud Run, e2-micro de Google y Hugging Face (Docker exige plan de pago) no sirven, y Fly.io no tiene nada gratis. De `agentpey`, `.cl`, `.app`, `.dev` y `getagentpey.com` están libres; **`agentpey.com` ya está inscrito** (2026-09-13).
- **Despliegue en Fly (sección 14, 2026-10-18):** `fly.toml` completo, comandos de `flyctl`, la acción de GitHub fijada por SHA, la etiqueta y el digest de `node`, PGDG y ffmpeg dentro de la imagen, con lo NO VERIFICADO al final (14.8).
- **Riesgo principal:** el worker pica ≈ 1 GB al hacer un reel con ffmpeg y Chromium a la vez; en máquinas de 1 GB la falta de memoria (OOM) es probable. Medirlo antes de elegir tamaño (sección 8).

## 2. Requisitos de cuenta y app (por proveedor)

Se asume: `api` 512 MB y `worker` 1–2 GB siempre encendidos, imágenes Docker (`node:26-trixie-slim` existe como etiqueta oficial, DOC Docker Hub; Playwright soporta Node 26 y Debian 12/13 en x86-64 y arm64, DOC), HTTPS con dominio propio, secretos y logs.

### 2.1 Fly.io

- **Cuenta y tarjeta:** no hay plan gratis. "No free tier or a monthly free usage allowance"; prueba de **hasta 2 horas de máquina o 7 días**, sin tarjeta para empezar, pero **se exige tarjeta después** para seguir usando recursos de pago (DOC).
- **Regiones:** 17 en la lista de la doc. Sudamérica: solo `gru` (São Paulo). **`scl` (Santiago) no aparece** (DOC; la propia doc manda a correr `fly platform regions` para la lista viva: NO VERIFICADO con la CLI, que requiere cuenta).
- **Precios** (DOC, página de precios; las cifras de `iad` están en la doc y las de `gru` salen de su selector de región): `gru` aplica un multiplicador **×1,615** sobre `iad` (cálculo: 3,54 / 2,19 = 1,616). `shared-cpu-1x` 256 MB cuesta US$2,19 (`iad`) y US$3,54 (`gru`, listado). RAM adicional: US$6,00 por GB-mes en `iad` (≈ US$9,69 en `gru`, INFERENCIA: el multiplicador afecta CPU y RAM según la página, pero no hay tarifa `gru` de RAM publicada). Combinaciones de `iad` en la doc: 1x/512 MB US$3,69; 1x/1 GB US$6,70; 2x/2 GB US$13,39. En `gru` (INFERENCIA, × 1,615): **api 512 MB ≈ US$5,96; worker 1 GB (1x) ≈ US$10,82; worker 2 GB (2x) ≈ US$21,63.** La calculadora oficial (`fly.io/calculator`) da la cifra exacta: NO VERIFICADO (no pude abrirla).
- **Otros cobros (DOC):** volúmenes US$0,15/GB-mes; instantáneas US$0,08/GB-mes (10 GB gratis); salida a internet hacia Sudamérica **US$0,04/GB**, entrada gratis; IPv4 compartida e IPv6 gratis; IPv4 dedicada US$2/mes (opcional); certificados: **10 de un solo nombre gratis**, luego US$0,10/mes cada uno.
- **Límites relevantes:** las máquinas son de cobro por tiempo encendido; una detenida solo cobra el disco raíz a US$0,15/GB-mes (DOC). Los procesos `api` y `worker` pueden vivir en **una sola app** con `[processes]` y tamaños distintos por grupo (`[[vm]]` con `processes = ["worker"]`), y `swap_size_mb` crea swap para absorber picos breves (DOC). El auto-stop se configura en `[http_service]`/`[[services]]`, así que un proceso sin servicio HTTP (el worker) no se apaga por eso; que el worker **nunca** se detenga: NO VERIFICADO en la práctica (hay que declararlo sin sección de servicio y probarlo).
- **Docker:** sí (se despliega una imagen; `fly deploy` construye con el Dockerfile). `[deploy] release_command` corre las migraciones en una máquina temporal con red y secretos (DOC).
- **Duermen:** solo si se configura auto-stop. Los discos raíz son efímeros por defecto (`persist_rootfs = never`, DOC); el tamaño del disco efímero para `tmp/` de ffmpeg: NO VERIFICADO (la doc leída no lo dice; si hace falta, un volumen de US$0,15/GB).

### 2.2 Railway

- **Planes (DOC):** Free Trial = US$5 de crédito único válido 30 días, **sin tarjeta**, hasta 1 GB RAM y 2 vCPU por servicio. Free = US$1 al mes de crédito, **0,5 GB RAM y 1 vCPU por servicio** (no sirve para el worker). **Hobby = US$5 al mes que incluyen US$5 de uso** (la cuota se cobra siempre, aunque no se use; el uso extra se suma). Pro = US$20 por espacio. Hobby permite hasta 48 GB y 48 vCPU por servicio. "Requires the use of a post-paid card": no hay prepago desde el 30 de marzo.
- **Precio por uso** (DOC): RAM US$10/GB-mes (US$0,00000386 por GB-s), vCPU US$20/vCPU-mes, volumen US$0,15/GB-mes, salida US$0,05/GB. **Se cobra lo consumido, no lo reservado**, así que un contenedor ocioso cuesta poco. Estimación (INFERENCIA): api ≈ 0,2 GB medios (US$2) + worker ≈ 0,6 GB medios con Chromium residente (US$6) + CPU ≈ 0,1 vCPU medio (US$2) ≈ US$10 de uso; con Hobby, factura ≈ **US$10** (5 de cuota + 5 de uso extra), y **US$13–15** en un mes con muchos reels. Si Chromium no queda residente, baja.
- **Regiones (DOC):** US West (California), US East (Virginia), EU West (Ámsterdam), Southeast Asia (Singapur). **Ninguna en Sudamérica.**
- **Docker:** detecta un `Dockerfile` en la raíz (o `RAILWAY_DOCKERFILE_PATH`). Varios servicios desde un mismo repo y raíz de monorepo: NO VERIFICADO (la página leída no lo cubre).
- **Duermen:** no, salvo que se active la opción de servicios serverless (no leída).

### 2.3 Render

- **Planes del espacio de trabajo (DOC):** Hobby US$0 + cómputo, Pro US$25 + cómputo (cambio del 2026-04-23: antes Professional US$19 por miembro, DOC changelog), Scale US$499. Ancho de banda incluido: Hobby 5 GB, Pro 25 GB; exceso **US$0,15/GB**.
- **Instancias (DOC, página de precios):** Free (solo web, 512 MB, **se duerme a los 15 min**, sin workers); `0.5c-512mb` (Starter) **US$7** con 512 MB; `1c-2g` (Standard) **US$25** con 1 CPU y 2 GB; `2c-4g` **US$85**. Los *background workers* parten en Starter (no hay worker gratis, DOC).
- **Regiones (DOC):** Oregón, Ohio, Virginia, Frankfurt, Singapur. **Ninguna en Sudamérica.**
- **Dominio y certificado:** Hobby incluye 2 dominios personalizados; TLS automático y renovación, con redirección HTTP a HTTPS; hay que **quitar los registros AAAA** porque Render usa IPv4 (DOC). Si el dominio tiene CAA, permitir `letsencrypt.org` y `pki.goog`.
- **Docker:** sí, con Dockerfile (BuildKit) o imagen ya construida. Los workers con Docker y el soporte de monorepo: NO VERIFICADO (la página no los trata).
- **Tarjeta:** no leí la exigencia explícita para instancias de pago: NO VERIFICADO (se asume que sí, INFERENCIA).

### 2.4 Google Cloud Run (Santiago)

- **Regiones (DOC):** `southamerica-west1` (Santiago) y `southamerica-east1` (São Paulo), ambas en **precio Tier 2**; Google recomienda considerar Tier 1 para ahorrar (DOC).
- **Facturación:** con CPU solo durante pedidos (por defecto) la CPU no existe fuera de ellos. Con **facturación por instancia** ("CPU always allocated") la CPU está asignada todo el ciclo de vida, sirve para trabajo en segundo plano, exige al menos 512 MiB y se paga también ociosa (DOC). Un `worker` con pg-boss no recibe pedidos HTTP: en servicio normal necesitaría escuchar un puerto, y Cloud Run puede apagar instancias ociosas, salvo con mínimo de instancias.
- **Worker pools:** existen y están "diseñados para trabajo continuo en segundo plano", **sin endpoint balanceado ni autoescala** (DOC). Su precio exacto y su etapa (GA o previa) no aparecen en las páginas que pude leer: NO VERIFICADO. Un blog de terceros dice que cuestan ≈ 40 % menos que un servicio (no oficial).
- **Precios (INFERENCIA, no pude abrir la página de precios de Google, solo un extracto):** facturación por instancia en Tier 2 ≈ **US$0,0000216 por vCPU-segundo** y **US$0,00000240 por GiB-segundo**. Cálculo del worker 1 vCPU / 2 GiB siempre encendido, 2.592.000 s: CPU 55,99 + memoria 12,44 = **US$68,4**; con 0,5 vCPU / 1 GiB ≈ US$34 (si Cloud Run permite esa combinación: NO VERIFICADO). La API con facturación por pedido y escala a cero ≈ US$0–5 (INFERENCIA; arranque en frío de varios segundos).
- **Dominio:** la asignación directa de dominios es "preview", **no recomendada para producción y no disponible en `southamerica-west1`** (DOC). Lo recomendado es un balanceador de carga HTTP(S) global externo: reglas de reenvío **US$0,025 por hora** las primeras 5 (≈ **US$18,25 al mes**, cálculo × 730 h; DOC según el extracto de la página de precios de balanceo), más datos procesados.
- **Docker:** sí (es su modelo). **Tarjeta:** sí, cuenta de facturación (INFERENCIA). Hay una capa gratuita mensual (240.000 vCPU-s y 450.000 GiB-s a precios Tier 1 según un extracto; NO VERIFICADO), irrelevante frente al costo del worker.

### 2.5 VPS con Docker Compose + Caddy

**Vultr (tiene Santiago).**
- **Regiones (DOC, endpoint público `v2/regions`):** 33, entre ellas `sao` (São Paulo) y **`scl` (Santiago, CL)**.
- **Planes `vc2` (DOC, endpoint público `v2/plans`; el sitio web me dio 403):** 1 vCPU/1 GB/25 GB = US$5; **1 vCPU/2 GB/55 GB = US$10**; **2 vCPU/2 GB = US$15**; **2 vCPU/4 GB/80 GB = US$20**; 4 vCPU/8 GB = US$40. Transferencia incluida: 1 TB, 2 TB, 3 TB, 3 TB, 4 TB (el campo trae 1024/2048/3072/4096 sin unidad; se lee como GB, INFERENCIA). **`scl` usa el precio base; `sao` cuesta 50 % más** (US$7,5 / 15 / 22,5 / 30 / 60). Los planes de 0,5 GB no se ofrecen ni en `sao` ni en `scl`.
- Cobro por hora con tope mensual (DOC, el campo `hourly_cost`); exceso de transferencia ≈ US$0,01/GB según fuentes de terceros: NO VERIFICADO.

**AWS Lightsail (São Paulo, `sa-east-1`; sin Santiago).**
- **Planes Linux con IPv4 pública (DOC):** 0,5 GB US$5; 1 GB US$7; **2 GB US$12 (2 vCPU, 3 TB)**; **4 GB US$24 (2 vCPU, 80 GB SSD, 4 TB)**; 8 GB US$44. Solo IPv6: 4 GB = US$20. **En São Paulo la transferencia incluida es la mitad** (DOC): 4 GB = 2 TB. Instantáneas US$0,05/GB-mes. Exceso: la página no da una tarifa por GB (el ejemplo usa US$0,09 en Ohio).
- Misma región que Neon (`aws-sa-east-1`): latencia a la base mínima (INFERENCIA).
- Prueba gratis: la página la menciona sin plazo: NO VERIFICADO.

**Akamai/Linode.** `Nanode` 1 GB US$5, 2 GB US$12, 4 GB US$24 (DOC, página de precios de CPU). "El precio de algunos planes difiere por región" y no hay tarifa de São Paulo publicada en la página: NO VERIFICADO. El mapa de su infraestructura menciona São Paulo y Santiago como regiones de cómputo (DOC, texto de un pie de mapa; confirmar en el selector de la cuenta).

**Hetzner y DigitalOcean:** sin ubicación en Sudamérica (DOC). No se evalúan.

**Caddy (DOC):** HTTPS automático con Let's Encrypt (y ZeroSSL de respaldo) si el dominio apunta por A/AAAA al servidor y los puertos **80 y 443** están abiertos; renueva solo; guarda certificados en su directorio de datos (que debe ser persistente: un volumen de Docker).

### 2.6 Neon (la base, en cualquier opción)

DOC, consultado el 2026-10-18 (la nota `neon-backup.md` tiene el detalle de respaldo de 2026-10-15; no hay cambios de cifras):

| Plan | Precio | Cómputo | Almacenamiento | Se duerme | Historial de restauración | Salida incluida |
|---|---|---|---|---|---|---|
| Free | US$0 (sin tarjeta) | 100 CU-h por proyecto | 1 GB por proyecto (20 GB en total) | A los 5 min, **no se puede desactivar** | 6 h (tope 1 GB de cambios) | 5 GB/proyecto |
| Launch | Sin mínimo; **US$0,106 por CU-hora** | Hasta 16 CU | US$0,35/GB-mes | A los 5 min, **se puede desactivar** | Hasta 7 días (US$0,20/GB-mes) | 500 GB, luego US$0,10/GB |
| Scale | US$0,222 por CU-hora | Hasta 16 CU (o fijo hasta 56) | US$0,35/GB-mes | Configurable (1 min a siempre) | Hasta 30 días | 500 GB |

- **Versión de Postgres:** Neon soporta 14 a 18; los últimos menores son 18.6, 17.11, 16.15, 15.19 y 14.24 (DOC). La nota `neon-backup.md` concluye que lo más probable es **18** para nuestro proyecto (INFERENCIA); se confirma con `show server_version`. PostgreSQL 18 recibe actualizaciones hasta el 2030-11-14 (DOC).
- **Cuenta del gasto en 24/7:** CU-horas = tamaño × horas encendido (DOC). 0,25 CU × 730 h = **182,5 CU-h** > 100 de Free; el propio Neon da ese ejemplo (180 CU-h). Con el worker conectado a pg-boss el cómputo no se suspende (ADR-0007: "el worker mantiene el cómputo despierto mientras corre"). En Launch: 182,5 × 0,106 = **US$19,3** + almacenamiento (< 1 GB × US$0,35) ≈ **US$19,7 al mes** (INFERENCIA; que 0,25 CU sea el tamaño mínimo en Launch: la página no da el piso, NO VERIFICADO).
- **Alternativas** para no pagar Neon: (a) Free con el worker solo en horario de oficina; 12 h × 30 d × 0,25 CU = 90 CU-h, casi todo el cupo y sin margen para la API ni los respaldos (frágil); (b) mover Postgres al propio VPS, con respaldo a R2 (cambia ADR-0007; ver sección 11); (c) Postgres gestionado de otro proveedor (no evaluado).

### 2.7 Cloudflare R2 (archivos y respaldos)

- **Plan gratis mensual (DOC):** 10 GB-mes de almacenamiento Standard, **1 millón de operaciones clase A**, **10 millones de clase B**, salida gratis. Solo para Standard (no Infrequent Access).
- **De pago (DOC):** US$0,015/GB-mes, clase A US$4,50 por millón, clase B US$0,36 por millón, salida gratis. Se redondea hacia arriba a la unidad de cobro (1,1 GB-mes se cobra 2).
- **Expiración de objetos (DOC):** existen reglas de ciclo de vida por días y prefijo (por ejemplo "borrar a los 90 días"), máximo 1.000 reglas; la eliminación ocurre en torno a un día después de vencer. Sirve para podar `backups/` sin código. Requiere un token con permiso *Workers R2 Storage Write* (DOC).
- Un respaldo diario de unos pocos MB, 30 copias, son < 1 GB y ≈ 100 operaciones al mes: **US$0** (INFERENCIA).

### 2.8 Dominio

- **`.cl` en NIC Chile (DOC, tarifas vigentes desde 2023-11-01):** inscripción, renovación y restauración = **$9.990 CLP por año, exento de IVA**; por años: 2 = $19.980, 5 = $49.950, 10 = $99.900. Transferencia desde otro registrador $9.990. Revocación $46.000. El equivalente en USD es una tabla aparte de NIC (no leída); a un tipo de cambio de $950–1.000 por dólar serían ≈ US$10–10,5 (INFERENCIA; tipo de cambio no verificado).
- **Quién puede registrar (DOC, Reglamentación n.º 7):** "toda persona natural o jurídica, nacional o extranjera"; hay que designar un contacto administrativo; NIC puede pedir pruebas de identidad de forma excepcional.
- **¿Pide RUT?** La página de procedimientos indica, como datos del titular, **RUT, RUN o pasaporte** (los extranjeros usan pasaporte) y **Clave Única** para crear la cuenta; el reglamento no habla de RUT (DOC en conjunto). Es decir, un chileno con RUT y Clave Única puede registrarlo; la regla exacta para quien no la tiene: NO VERIFICADO (la página es un resumen).
- **Pago (DOC):** Webpay (CLP y USD; tarjetas chilenas o extranjeras), PayPal (USD), Servipag (solo pagadores en Chile), cupón Servipag, TGR (hoy no disponible).
- **Cloudflare Registrar:** soporta "más de 430" TLDs a precio de costo, sin recargo, con renovación al mismo valor y redacción de WHOIS gratis (DOC). **`.cl` no figura en su lista** (`tld-policies`, DOC); `.com` sí (registro Verisign). La página de Cloudflare **no publica el precio** de `.com`: un agregador de terceros reporta **US$10,46 al año** (mayo de 2026; equivale a la tarifa mayorista de Verisign US$10,26 + US$0,20 de ICANN; INFERENCIA). Fuentes secundarias (Openprovider, OSIR) anuncian que la tarifa mayorista de `.com` sube a **US$10,97 el 2026-11-01**, o sea ≈ US$11,17 con ICANN: NO VERIFICADO en Verisign (su documento dio 403).
- **Usar un `.cl` con DNS de Cloudflare:** posible en teoría delegando los servidores de nombres desde NIC (INFERENCIA; no leído el procedimiento de delegación). No hace falta para ningún hosting de arriba, que piden registros A/AAAA/CNAME en cualquier DNS.

### 2.9 Costo mensual total aproximado (USD, api + worker, siempre encendidos)

| Opción | Configuración | Cómputo / mes | Con Neon Launch (≈ +19,7) | Notas |
|---|---|---|---|---|
| Railway (Hobby) | api y worker por uso | ≈ 10–15 | ≈ 30–35 | Sin región en Sudamérica; la base en São Paulo queda lejos (ver 9) |
| Fly.io `gru` | api 512 MB + worker 1 GB (1x) | ≈ 16,8 | ≈ 36,5 | Worker de 1 GB: justo; con swap de 512 MB |
| Fly.io `gru` | api 512 MB + worker 2 GB (2x) | ≈ 27,6 | ≈ 47,3 | Margen para el pico de ≈ 1 GB |
| Vultr Santiago | 1 VM 2 vCPU/4 GB (`vc2-2c-4gb`) | **20** | ≈ 39,7 | Compose con api, worker y Caddy; yo mantengo el servidor |
| Vultr Santiago | 1 VM 1 vCPU/2 GB (`vc2-1c-2gb`) + swap | 10 | ≈ 29,7 | Muy justo con Chromium + ffmpeg |
| Lightsail São Paulo | 2 vCPU/4 GB | 24 | ≈ 43,7 | Misma región que Neon; 2 TB de transferencia |
| Akamai/Linode | 4 GB | 24 (precio de São Paulo NO VERIFICADO) | ≈ 43,7 | Sin tarifa regional publicada |
| Render | api Starter (7) + worker Standard (25) | 32 | ≈ 51,7 | Sin región en Sudamérica; (api y worker juntos en un Standard = 25, INFERENCIA) |
| Cloud Run Santiago | api por pedido (≈ 0–5) + worker 1 vCPU/2 GiB (≈ 68) + balanceador (≈ 18) | ≈ 85–90 | ≈ 105–110 | Cifras de Google por extracto; el más caro por mucho |

Más fijos: dominio `.cl` ≈ US$0,85 al mes ($9.990 al año), R2 US$0 dentro del plan gratis, certificados US$0.

## 3. Autenticación (dominio, certificado, secretos, redirect URIs)

- **Redirect URIs:** Instagram y Mercado Libre exigen una dirección HTTPS propia registrada en cada app (deuda ya anotada en `docs/ESTADO.md`: "F8, vuelta de Mercado Libre" y "F8, OAuth"). Cualquier opción de esta nota entrega HTTPS con dominio propio.
- **Fly.io:** `fly certs add <dominio>`; registros A y AAAA (recomendados) hacia las IP de la app, o CNAME hacia el destino `.fly.dev`; Let's Encrypt automático (TLS-ALPN, HTTP-01 o DNS-01); `fly certs check` vigila el avance. Si la app no tiene IPv4/IPv6, se asignan con `fly ips allocate` (la IPv4 compartida es gratis, la dedicada US$2). Secretos: `fly secrets set` (INFERENCIA; la página de secretos no se leyó, NO VERIFICADO el detalle).
- **Railway:** botón "Custom Domain" en el servicio; un CNAME más un TXT de verificación (sin el TXT da 404); Let's Encrypt automático (válido 90 días, renueva a los 30); hasta 2 dominios por servicio en Hobby; un apex requiere CNAME flattening o mover los NS a Cloudflare; con el proxy naranja de Cloudflare, usar SSL "Full" (no "Full strict") (DOC).
- **Render:** dominio en Settings, registros DNS sin AAAA, "Verify"; TLS automático (DOC).
- **Cloud Run:** en Santiago no hay asignación directa de dominio: balanceador global con certificado administrado, o Firebase Hosting (que no queda cubierto por los términos de Google Cloud, DOC). La asignación directa tarda ≈ 15 min a 24 h y no admite comodines.
- **VPS:** registro A (y AAAA) del dominio hacia la IP; Caddy emite y renueva el certificado solo; puertos 80 y 443 abiertos (DOC). Secretos: un archivo `.env` de Compose con permiso 600 fuera de git, o secretos de Docker (INFERENCIA).
- **Registro de las variables:** en todas las opciones, `APP_ENCRYPTION_KEY` y las demás viajan como variables del proveedor; nunca en la imagen ni en los logs (regla de `CLAUDE.md`).

## 4. Operaciones (despliegue, logs y cron)

- **Construcción y despliegue:** una imagen para `api` (Node + panel compilado, sin Chromium) y otra para `worker` (Node + ffmpeg + Chromium + `postgresql-client-18`). Base sugerida: `node:26-trixie-slim` (DOC: existen `26-trixie-slim` y `26-bookworm-slim`) y `npx playwright install --with-deps chromium` (Playwright soporta Node 26 y Debian 12/13, DOC). La imagen oficial `mcr.microsoft.com/playwright:v1.64.0-noble` es Ubuntu 24.04 y **no incluye el paquete de Playwright ni se confirma que incluya Node** (DOC); no es Alpine (Playwright no soporta musl, DOC). Con Chromium en contenedor, Playwright recomienda `--ipc=host` y `--init` (DOC); en plataformas donde no se pasan flags de Docker, el argumento de Chromium `--disable-dev-shm-usage` es la salida habitual (INFERENCIA, no leído en esta consulta).
- **Logs:** Railway guarda 7 días en Hobby (30 en Pro; límite de 500 líneas por segundo por réplica); Render 7 días en Hobby (14 en Pro, 30 en Scale) con envío por syslog/HTTPS; Fly muestra los logs en vivo (`fly logs`), la búsqueda de Grafana retiene 7 días y el envío a otro destino va con el *Log Shipper*; en un VPS son los de Docker (hay que limitar el tamaño con `max-size`/`max-file`, INFERENCIA) o un servicio externo; Cloud Run envía a Cloud Logging (no leído). `pino` ya escribe a la salida estándar.
- **Cron:** con el worker siempre encendido **basta con `pg-boss schedule`**, que el worker ya usa (`apps/worker/src/jobs/registry.ts`). Qué ofrece cada proveedor, por si hiciera falta:
  - Fly: `--schedule` solo `hourly`, `daily`, `weekly` o `monthly`, con ciclo "difuso", para máquinas que corren y salen (DOC). No sirve para "a las 13:00 de Chile".
  - Railway: cron en UTC, con al menos 5 minutos entre corridas, y el servicio debe terminar; si la corrida anterior sigue activa, se salta la siguiente; la hora puede desfasarse unos minutos (DOC).
  - Render: servicio *cron job* aparte, cobrado por segundo, **mínimo US$1 al mes por cron**, máximo 12 horas por corrida, acepta Docker (DOC).
  - Cloud Run: jobs más Cloud Scheduler (no leído en esta consulta: NO VERIFICADO).
  - VPS: `cron` o `systemd timer` del servidor.
  - pg-boss (INFERENCIA, de fuente secundaria): solo una instancia evalúa los cron en un momento dado, y hay opción de zona horaria (`tz`). No leí la doc oficial: NO VERIFICADO (el repo ya lo usa con hora de Chile).
- **Dos workers en la misma cola:** el worker del Mac (Marketplace) y el de la nube leerían las mismas colas de pg-boss si comparten base; hay que separar qué colas toma cada uno antes de F8 (INFERENCIA; es una decisión de diseño para un ADR, no de esta nota).

## 5. Medios (peso de los archivos y salida de datos)

- **Los archivos nunca pasan por el servidor al publicar:** Instagram y Mercado Libre leen las URLs prefirmadas de R2; la salida de R2 es gratis (DOC). La salida del servidor es poca: respuestas de la API, imágenes del panel y las descargas que haga el worker (que son entrada para el servidor, gratis en Fly y Railway por lo leído).
- **Salida de datos por proveedor:** Fly US$0,04/GB hacia Sudamérica (DOC); Railway US$0,05/GB (DOC); Render 5 GB incluidos en Hobby y US$0,15/GB de exceso (DOC); Vultr 2–3 TB incluidos en los planes de 2–4 GB (DOC); Lightsail São Paulo la mitad de la tabla (DOC). Con decenas de propiedades al mes, ninguna pasa de pocos GB: no es un factor de decisión (INFERENCIA).
- **Disco temporal:** ffmpeg y la importación escriben en `tmp/` (ADR-0007 y arquitectura). En Fly y Railway el disco raíz es efímero y su tamaño no se leyó (Railway: 1 GB en Free, 100 GB en Hobby por servicio, DOC); en un VPS el disco es el del plan (80 GB en `vc2-2c-4gb`, DOC). La deuda "F8: subida directa a R2" (`ESTADO.md`) reduce el uso de disco de la API.

## 6. Límites

| Límite | Valor | Fuente |
|---|---|---|
| Fly: tamaños disponibles | `shared-cpu` hasta 2 GB en la tabla leída; RAM extra US$6/GB (iad); `performance-1x` 2 GB = US$33 (iad) | DOC |
| Fly: vigencia de la prueba | 2 h de máquina o 7 días; tarjeta obligatoria después | DOC |
| Railway: Free | 0,5 GB y 1 vCPU por servicio, US$1/mes | DOC |
| Railway: Hobby | 48 GB y 48 vCPU por servicio, 6 réplicas, 5 GB de volumen por servicio, 2 dominios por servicio | DOC |
| Render: Hobby | Dominios: 2 incluidos (US$0,25/mes cada uno extra); 5 GB de banda incluida | DOC |
| Render: Free | Se duerme a los 15 min; 750 h al mes; sin workers; Postgres gratis expira a los 30 días | DOC |
| Cloud Run | Domain mapping no disponible en `southamerica-west1`; facturación por instancia exige ≥ 512 MiB | DOC |
| Vultr: planes en Santiago | Solo planes `vc2` de 1 GB o más (no los de 0,5 GB) | DOC |
| Lightsail São Paulo | Transferencia incluida a la mitad de la tabla | DOC |
| Neon Free | 100 CU-h; 1 GB; 5 GB de salida; 6 h de historial; suspende a los 5 min sin poder desactivarlo | DOC |
| R2 gratis | 10 GB, 1 M clase A, 10 M clase B, salida gratis | DOC |
| NIC Chile | `.cl` $9.990 CLP/año exento de IVA | DOC |

## 7. Errores comunes

| Situación | Causa | Reintento / acción |
|---|---|---|
| Worker muerto con código 137 o "OOM" | Pico de ffmpeg + Chromium sobre un límite de 512 MB–1 GB | Los jobs de pg-boss se reintentan; subir la memoria o añadir swap (Fly: `swap_size_mb`) (INFERENCIA) |
| Chromium cae al iniciar o a media renderización en contenedor | Memoria compartida (`/dev/shm`) pequeña | Playwright recomienda `--ipc=host`; si no se puede pasar, `--disable-dev-shm-usage` (INFERENCIA) |
| Neon deja de responder a mitad de mes | Se agotaron las 100 CU-h del plan gratis (el worker 24/7 las gasta en ≈ 17 días) | No reintentable hasta el siguiente período; pasar a Launch (DOC, `neon-backup.md`) |
| `pg_dump: aborting because of server version mismatch` | Cliente `postgresql-client-17` (el de Debian trixie) contra un servidor 18 | No: instalar `postgresql-client-18` de PGDG (sección 8) |
| Certificado no se emite | DNS aún no apunta; puertos 80/443 cerrados; CAA que no permite Let's Encrypt; proxy naranja de Cloudflare | Corregir y reintentar; Caddy reintenta con espera creciente (hasta un día entre intentos) (DOC) |
| Render: dominio no verifica | Quedó un registro AAAA | Quitarlo (DOC) |
| Railway: 404 en el dominio propio | Falta el TXT de verificación | Agregarlo (DOC) |
| Fly: error al arrancar una máquina programada | El host no tiene capacidad en ese momento | Reintentar; diseñar con redundancia (DOC) |
| Cloud Run: dominio no se puede mapear en Santiago | La función de asignación no está en `southamerica-west1` | Balanceador global (DOC) |

## 8. Cómo probar sin riesgo

Todo en `PUBLISH_MODE=dry-run` y sin credenciales reales de corredores. Las pruebas las corre el operador; ninguna clave pasa por el chat.

1. **Medir el pico real del worker** antes de elegir tamaño: en el Mac, `docker run` de la imagen del worker con límite de memoria de 1 GB y luego 2 GB, preparar un reel de muestra (ffmpeg) con el render de Chromium a la vez y mirar `docker stats`. Cierra el NO VERIFICADO del pico de ≈ 1 GB.
2. **Cuenta de prueba por proveedor:** Fly (2 h/7 días), Railway (US$5 por 30 días sin tarjeta; Trial limitado a 1 GB), Vultr y Lightsail cobran por hora y una VM de prueba cuesta centavos si se destruye el mismo día (DOC de los planes con cobro por hora en Vultr).
3. **Entorno `staging`:** desplegar con una rama de Neon (hasta 10 por proyecto en Free, DOC) y un bucket de R2 aparte; así no se toca la base de producción.
4. **Certificado:** probar primero con un subdominio y, en Caddy, con la CA de pruebas de Let's Encrypt para evitar límites de emisión (DOC).
5. **`pg_dump` del worker:** comprobar `pg_dump --version` dentro de la imagen y volcar la rama de prueba de Neon (rol de la app, conexión directa sin `-pooler`) hacia R2; restaurarlo en una base local descartable (flujo de `neon-backup.md`, sección 8).
6. **Neon:** mirar en la consola el consumo de CU-horas tras 48 h con el worker encendido y comparar con el cálculo (≈ 0,25 CU × horas).
7. **Latencia:** medir el tiempo de `/health` desde Chile contra la región elegida, y el tiempo de una consulta API→Neon (cada consulta cruza de la región del servidor a São Paulo).
8. **Primera semana:** con un corredor de prueba, revisar `doctor`, reintentos de la cola y reinicios del proceso.

**Instalar `pg_dump` 18 en la imagen del worker (DOC, wiki de PostgreSQL y listado de PGDG):**

- Debian estable (trixie) solo trae `postgresql-client-17` (17.11-0+deb13u1); no existe `postgresql-client-18` en los repositorios de Debian (DOC, packages.debian.org). `pg_dump` se niega a volcar un servidor de versión mayor (DOC, `neon-backup.md`).
- Hay que añadir el repositorio PGDG: `apt install -y postgresql-common ca-certificates` y luego `/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh`, o a mano con la clave `https://www.postgresql.org/media/keys/ACCC4CF8.asc` y un `pgdg.sources` con la suite `trixie-pgdg` (o `bookworm-pgdg`). Luego `apt-get install postgresql-client-18`.
- El paquete existe para Debian 12 (`pgdg12`) y Debian 13 (`pgdg13`), en **amd64 y arm64**: la última versión estable listada es `18.6-3.pgdg13+1` (2026-08-15); el 2026-10-17 aparece además un build `18.6-4~20261017…` con pinta de instantánea nocturna (no fijarse en él, INFERENCIA). PostgreSQL 18 está vigente hasta 2030-11-14 (DOC).
- Instalar solo `postgresql-client-18`, no el servidor.

## 9. Riesgos y términos de uso relevantes

- **Latencia entre el servidor y Neon (São Paulo).** Un servidor en EE. UU. (Railway, Render) haría cada consulta a la base cruzar un continente; muchas consultas por pedido se sumarían (INFERENCIA, no medido). Remedios: mover el proyecto de Neon a una región de EE. UU. (se recrea con `pg_dump`/`pg_restore`, flujo de `neon-backup.md`), o elegir un servidor sudamericano. Fly `gru` y Lightsail `sa-east-1` quedan en la misma ciudad y región que Neon `aws-sa-east-1`; Vultr Santiago queda a otra ciudad (INFERENCIA).
- **Coste oculto de Neon** (sección 2.6): el worker 24/7 convierte "plan gratis" en ≈ US$20 al mes, salvo que Postgres se mueva al VPS.
- **Servidor propio (VPS) = el operador administra el sistema.** Parches de seguridad, SSH solo con llaves, firewall con solo 80/443/22 abiertos, reinicios y actualización de Docker. La VM puede ser desechable (el estado vive en Neon y R2), lo que reduce el riesgo (INFERENCIA). La recuperación tras un fallo del VPS es reconstruir con Compose, no restaurar disco.
- **Datos personales de corredores y clientes de ellos.** Quedan en servidores fuera de Chile (Brasil, EE. UU.): revisar el aviso de privacidad y los términos de cada proveedor antes de ofrecer el servicio a terceros. La nueva ley chilena de protección de datos personales (Ley 21.719) podría entrar en vigencia a fines de 2026: NO VERIFICADO, no leí el texto; consultar a un abogado antes de cobrar (esta nota no da asesoría legal).
- **Respaldos con datos reales:** el volcado contiene datos de clientes y tokens cifrados. Subirlo a un prefijo privado de R2 (el bucket ya es privado, ADR-0007), con expiración a 30 días, y la clave `APP_ENCRYPTION_KEY` guardada aparte, nunca junto al respaldo (`neon-backup.md`).
- **Dependencia de varios proveedores:** el despliegue sumaría 4 cuentas (hosting, Neon, R2, dominio). Cada una con tarjeta o RUT.
- **Fly.io y precios:** el multiplicador regional de `gru` (×1,615) es el más alto de la tabla; si Fly cambia las tarifas, el costo sube sin aviso. Los términos de servicio de ningún proveedor se revisaron.
- **Marketplace:** sigue en el Mac del operador (ADR-0017, ADR-0023); el servidor no debe abrir Facebook ni guardar su sesión. Los términos de uso de los centros de datos frente a la automatización de Facebook no se evaluaron.
- **Cloud Run:** la asignación de dominios en preview "no se recomienda para producción" (DOC); depende de un balanceador de pago.

## 10. Fuentes (consultadas el 2026-10-18)

Fly.io:

- Precios (sin plan gratis, prueba 2 h/7 días, tarjeta, precios de `iad`, RAM extra, volúmenes, salida, certificados): https://docs.fly.io/about/pricing
- Calculadora y multiplicador regional (`gru` ×1,615, salida por destino): https://fly.io/pricing
- Regiones (17; Sudamérica: `gru`; sin `scl`): https://docs.fly.io/reference/regions
- `fly.toml` (`[processes]`, `[[vm]]`, `swap_size_mb`, `release_command`): https://docs.fly.io/reference/configuration/
- Dominio propio y certificados: https://docs.fly.io/networking/custom-domain/
- `fly machine run --schedule`: https://docs.fly.io/machines/flyctl/fly-machine-run
- Logs: https://docs.fly.io/monitoring/logging-overview/

Railway:

- Precios: https://railway.com/pricing
- Planes y límites por servicio: https://docs.railway.com/reference/pricing/plans
- Regiones: https://docs.railway.com/reference/regions
- Dominios y SSL: https://docs.railway.com/networking/domains/working-with-domains
- Cron: https://docs.railway.com/reference/cron-jobs
- Dockerfile: https://docs.railway.com/builds/dockerfiles
- Logs: https://docs.railway.com/observability/logs

Render:

- Precios (instancias, planes, banda, cron): https://render.com/pricing.md y https://render.com/pricing
- Planes nuevos desde 2026-04-23: https://render.com/changelog/updated-plans-for-render-workspaces
- Nombres de planes y sin cambio de precio: https://render.com/docs/compute-plans-update y https://render.com/docs/compute-plans.md
- Plan gratis: https://render.com/docs/free
- Regiones: https://render.com/docs/regions
- Dominios y TLS: https://render.com/docs/custom-domains
- Docker: https://render.com/docs/docker
- Cron: https://render.com/docs/cronjobs
- Logs: https://render.com/docs/logging

Google Cloud Run y balanceo:

- Regiones y niveles de precio: https://docs.cloud.google.com/run/docs/locations
- Asignación de dominios (preview, regiones, balanceador recomendado): https://docs.cloud.google.com/run/docs/mapping-custom-domains
- Facturación por instancia o por pedido: https://docs.cloud.google.com/run/docs/configuring/billing-settings
- Mínimo de instancias: https://docs.cloud.google.com/run/docs/configuring/min-instances
- Worker pools: https://docs.cloud.google.com/run/docs/deploy-worker-pools y https://docs.cloud.google.com/run/docs/configuring/workerpools/workerpools-cost-optimization
- Precios de Cloud Run (leída solo mediante extractos del buscador; mi lector no abrió la tabla): https://cloud.google.com/run/pricing
- Precios del balanceador: https://cloud.google.com/load-balancing/pricing

VPS:

- Vultr, regiones (endpoint público, sin clave): https://api.vultr.com/v2/regions?per_page=500
- Vultr, planes y precios (endpoint público, sin clave): https://api.vultr.com/v2/plans?type=vc2&per_page=100
- AWS Lightsail, precios: https://aws.amazon.com/lightsail/pricing/
- AWS Lightsail, regiones: https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-regions-and-availability-zones-in-amazon-lightsail.html
- Akamai/Linode, planes: https://www.akamai.com/cloud/pricing/cpu
- Akamai, infraestructura: https://www.akamai.com/why-akamai/global-infrastructure
- Hetzner, ubicaciones: https://www.hetzner.com/cloud/regions
- DigitalOcean, regiones: https://docs.digitalocean.com/platform/regional-availability/
- Caddy, HTTPS automático: https://caddyserver.com/docs/automatic-https

Neon, R2, PostgreSQL y runtime:

- Neon, planes: https://neon.com/docs/introduction/plans y https://neon.com/pricing
- Neon, medición de CU-horas: https://neon.com/docs/introduction/usage-metrics
- Neon, versiones de Postgres: https://neon.com/docs/postgresql/postgres-version-support
- Neon, automatizar `pg_dump` hacia S3: https://neon.com/docs/manage/backup-pg-dump-automate
- Nota previa del proyecto (respaldo y versión): `docs/integraciones/neon-backup.md` (2026-10-15)
- R2, precios: https://developers.cloudflare.com/r2/pricing/
- R2, expiración de objetos: https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- PostgreSQL, versiones y fin de vida: https://www.postgresql.org/support/versioning/
- PGDG en Debian: https://wiki.postgresql.org/wiki/Apt y https://www.postgresql.org/download/linux/debian/
- Paquetes `postgresql-client-18` en PGDG (listado): https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-18/
- Debian trixie, `postgresql-client`: https://packages.debian.org/search?keywords=postgresql-client&searchon=names&suite=stable&section=main
- Node.js, versiones: https://nodejs.org/en/about/previous-releases
- Imagen `node` (etiquetas 26): https://hub.docker.com/_/node
- Playwright, requisitos y Docker: https://playwright.dev/docs/intro y https://playwright.dev/docs/docker
- pg-boss (sitio oficial; sin detalle de cron/polling en las páginas leídas): https://pgboss.io/

Dominio:

- NIC Chile, tarifas: https://www.nic.cl/dominios/tarifas.html y https://nic.cl/anuncios/20231031-tarifas-eng.html
- NIC Chile, reglamentación: https://www.nic.cl/normativa/reglamentacion.html
- NIC Chile, procedimientos: https://www.nic.cl/normativa/procedimientos.html
- NIC Chile, formas de pago: https://www.nic.cl/dominios/pago.html
- Cloudflare Registrar: https://www.cloudflare.com/products/registrar/ y lista de TLDs https://www.cloudflare.com/tld-policies
- Precio de `.com` y alza de Verisign (fuentes secundarias, no oficiales): https://domainoffer.net/tld/com/cloudflare , https://www.openprovider.com/blog/com-price-increase-domain-resellers , https://osir.com/en/blog/verisign-com-price-update-2026/

Método: las páginas se leyeron con una herramienta que extrae y resume texto; no se usó el navegador integrado. Donde un proveedor devolvió 403 (Vultr sitio web, documento de Verisign) o la página no cargó (precios de Cloud Run y calculadora de Fly) se anota NO VERIFICADO o se usó una fuente alternativa marcada como tal.

## 11. Recomendación para F8

**Principal: Fly.io en `gru` (una sola app con dos procesos `api` y `worker`) + Neon Launch + R2 + dominio `.cl`.**

- **Costo mensual total estimado: ≈ US$37 a US$48** = Fly ≈ 16,8 (worker de 1 GB con swap) a 27,6 (worker de 2 GB) + Neon Launch ≈ 19,7 + dominio ≈ 0,85 + R2 y certificados US$0. Empezar con el worker de 2 GB si la medición de la sección 8 pasa de ≈ 900 MB de pico, y bajar a 1 GB si no.
- **Por qué:** cumple de fábrica todo lo pedido (HTTPS y certificado automático, secretos, imágenes Docker, proceso siempre encendido, logs, migraciones con `release_command`); `gru` (São Paulo) queda en la misma región que Neon `aws-sa-east-1`, así que las consultas a la base son rápidas, y a los corredores de Chile les queda una latencia razonable (INFERENCIA, no medida); no hay sistema operativo que parchear; se paga por segundo y se puede subir o bajar la memoria por proceso sin reconstruir nada. El multiplicador ×1,615 de `gru` lo encarece, pero sigue por debajo de Render y de Cloud Run.
- **Cron:** `pg-boss schedule` en el worker (ya existe); no se usa el cron de Fly (solo cada hora o día, difuso).
- **Respaldos:** `pg_dump` 18 desde el worker a `backups/` de R2 con expiración a 30 días; en Launch, además, 7 días de restauración instantánea. La imagen del worker instala `postgresql-client-18` desde PGDG. Estimación de costo extra: US$0.

**Alternativa: un VPS Vultr en Santiago (`vc2-2c-4gb`, US$20 al mes) con Docker Compose (api, worker y Caddy).**

- **Costo mensual total estimado: ≈ US$40** con Neon Launch (20 + 19,7 + 0,85), o **≈ US$21** si además se mueve Postgres a la misma VM con `pg_dump` diario a R2 (requiere un ADR nuevo que modifique ADR-0007, copia de seguridad más cuidada y ya no hay restauración instantánea).
- **Por qué:** precio fijo y predecible, 4 GB de memoria con margen para ffmpeg + Chromium, región de Santiago (la más cercana a los usuarios) y la mejor relación precio/memoria de la tabla. Cuesta menos que Fly con un worker de 2 GB (US$27,6 solo el cómputo) y da el doble de RAM en total, con 2 vCPU para ffmpeg.
- **Contras:** el operador mantiene el servidor (parches, firewall, Compose, rotación de logs) y el despliegue es menos directo (`git pull` + `docker compose up --build` o CI hacia un registro). Santiago queda a otra ciudad que la base (INFERENCIA).

**Descartadas:** Railway (la más barata, ≈ US$30–35 con Neon Launch, pero sin región sudamericana; solo con la base movida a EE. UU.), Render (US$32 de cómputo, sin región sudamericana) y Cloud Run (≈ US$85–90 de cómputo más Neon: el worker 24/7 con CPU siempre asignada y el balanceador obligatorio en Santiago lo hacen el más caro). Lightsail es válido si se prefiere AWS (misma región que Neon, US$24 por 4 GB) pero cuesta más que Vultr.

**Qué hace falta decidir antes del spec de F8** (preguntas para el operador):
1. ¿Se acepta pagar Neon Launch (≈ US$20/mes) para tener el worker 24/7, o se prefiere mover Postgres a la VM (menos costo, más trabajo y un ADR nuevo)?
2. ¿Fly gestionado (más cómodo, ≈ US$17–28) o VPS propio (≈ US$20, más control y trabajo)?
3. ¿Dominio `.cl` en NIC Chile (necesita RUT y Clave Única del titular) o `.com` en Cloudflare (≈ US$10,5–11 al año)?
4. ¿El worker de la nube toma todas las colas excepto Marketplace, y el del Mac solo Marketplace? (diseño de colas para un ADR)

## 12. NO VERIFICADO

- Que `scl` (Santiago) no exista hoy en Fly.io: la doc lista 17 regiones sin `scl`; confirmar con `fly platform regions` al crear la cuenta.
- Precios exactos de Fly en `gru` (las cifras de la sección 2.1 son el precio de `iad` × 1,615); confirmar en `fly.io/calculator`.
- Que el worker en Fly no se detenga solo (sin sección de servicio HTTP) y que 1 GB alcance con swap; el tamaño del disco efímero para `tmp/`.
- Cifras de Cloud Run en Tier 2 (vCPU-segundo y GiB-segundo), el precio y la etapa (GA o previa) de las *worker pools*, combinaciones mínimas de CPU y memoria, Cloud Scheduler, y la capa gratuita exacta.
- Que 0,25 CU sea el tamaño mínimo del cómputo en Neon Launch y que el cómputo con el worker conectado no se suspenda nunca (el cálculo de US$19–20 al mes lo da por hecho); hay que mirar el consumo real tras 48 h.
- La versión de Postgres de nuestro proyecto de Neon (lo más probable es 18; se lee con `show server_version`).
- Precios de Linode/Akamai en São Paulo, y que Akamai tenga cómputo en Santiago.
- Unidades del campo de transferencia de Vultr (se asume GB), tarifa por exceso (≈ US$0,01/GB de terceros) y exigencia de tarjeta; prueba gratis de Lightsail.
- Que Render exija tarjeta para instancias de pago y cómo se comportan los workers con Docker y monorepos; que Railway permita varios servicios desde un mismo repositorio y su opción de servicios que se duermen.
- Precio exacto de `.com` en Cloudflare Registrar (la página no lo muestra) y la subida del 2026-11-01 de Verisign (solo fuentes secundarias).
- La regla exacta de NIC Chile para quien no tiene RUT o Clave Única (la página de procedimientos es un resumen) y el procedimiento para delegar un `.cl` a los servidores de nombres de Cloudflare.
- Que la Ley 21.719 de protección de datos personales de Chile aplique y desde cuándo; consultar a un abogado.
- Valores por defecto de polling y evaluación de cron en pg-boss 12.35 (la doc oficial que pude leer no los trae); la afirmación de que solo una instancia evalúa los cron viene de una fuente secundaria.
- Tipo de cambio CLP/USD usado en la conversión del `.cl` (≈ $950–1.000).
- Que `--disable-dev-shm-usage` sea la solución en plataformas sin `--ipc=host`, y los tamaños de `/dev/shm` en Fly/Railway.
- Lo pendiente de la demo gratis está en la sección 13.7.

## 13. Opciones gratis para una demo

Ronda del **2026-10-18** (segunda del día), pedida por el operador: algo **gratis** para mostrar la herramienta con pocos usuarios y uso esporádico, y pasar más adelante a un plan pagado (sección 11: Fly.io + Neon Launch). Misma convención DOC / INFERENCIA / NO VERIFICADO; fuentes en 13.6. Sin cuentas, sin llamadas autenticadas; las consultas de dominio fueron lecturas públicas (WHOIS de NIC Chile y RDAP de los registros).

**Corrección a 2.4:** la capa gratis de Cloud Run con facturación por pedido es de **2 millones de pedidos, 180.000 vCPU-segundos y 360.000 GiB-segundos al mes, y 1 GB de salida desde Norteamérica** (DOC, página de capas gratis de Google, 2026-10-18). Las cifras de 240.000 y 450.000 que cité en 2.4 eran del extracto de facturación por instancia y no cambian el costo del worker.

### 13.1 Cómputo gratis: tabla comparativa

Necesidad: `api` (512 MB) y `worker` (ffmpeg + Chromium, pico ≈ 1 GB), uno de ellos siempre encendido para que pg-boss tome los jobs.

| Opción | Qué da gratis hoy | ¿Duerme? | ¿Sirve el worker 24/7? | Docker con ffmpeg y Chromium | Veredicto |
|---|---|---|---|---|---|
| **Oracle Cloud Always Free, Ampere A1** | **2 OCPU y 12 GB** (1.500 OCPU-h y 9.000 GB-h al mes) en la región de casa; 200 GB de disco; 10 TB de salida al mes (DOC) | No, pero Oracle **puede recuperar** las ociosas (13.2) | **Sí** (VM normal) | Sí: es una VM; Arm64 (Playwright soporta arm64 en Debian 12/13, DOC; imagen multi-arquitectura: INFERENCIA) | **La única gratis que aguanta el worker** |
| Oracle Always Free, `VM.Standard.E2.1.Micro` | Hasta 2 VM de 1/8 OCPU y 1 GB; 50 Mbps (DOC) | No | No: 1 GB y 1/8 de CPU no alcanzan para ffmpeg + Chromium (INFERENCIA) | x86 | Solo para algo liviano |
| Koyeb | **1 servicio web** `free`: 512 MB, 0,1 vCPU, 2 GB de disco, en Frankfurt o Washington (DOC) | **Sí: a la hora sin tráfico, no se puede desactivar** (DOC) | No: es un servicio web y el worker no se menciona | NO VERIFICADO (no leído) | No sirve |
| Render (plan gratis) | Servicio web de 512 MB y 0,1 CPU (DOC) | **Sí: a los 15 min; tarda ≈ 1 min en despertar; 750 h al mes** (DOC) | **No: los background workers no tienen plan gratis** (DOC) | Docker sí (DOC, 2.3); disco efímero | No sirve |
| Google Cloud Run (capa gratis) | Pedidos 2 M, 180.000 vCPU-s, 360.000 GiB-s (DOC) | Escala a cero | **No:** con facturación por pedido la CPU existe solo mientras se procesa un pedido y las instancias ociosas pueden cerrarse en cualquier momento (DOC) | Sí (contenedores) | Sirve la API; el worker exige rediseño (13.1.1) |
| Google Compute Engine `e2-micro` | **1 VM al mes en `us-west1`, `us-central1` o `us-east1`**; 30 GB de disco; **1 GB de salida** desde Norteamérica (DOC) | No | No: 1 GB de RAM, sin región sudamericana | Sí | Descartada |
| Fly.io | **Nada.** "No free tier"; prueba de 2 h o 7 días (DOC) | — | — | Sí | Descartada (ver la alternativa, 13.8) |
| Railway Free | US$1 al mes; **0,5 GB y 1 vCPU por servicio** (DOC) | No | No: el worker pide más de 0,5 GB | Dockerfile sí | Descartada |
| Railway Trial | **US$5 únicos por 30 días, sin tarjeta**; tope de 1 GB y 2 vCPU por servicio (DOC) | No | Sí, mientras dure el crédito: a ≈ US$10 de uso al mes (2.2, INFERENCIA) alcanza para ≈ 2 semanas | Sí | Puente de 2 semanas |
| Northflank (Developer Sandbox) | 2 servicios, 2 jobs y 1 addon; cómputo "siempre encendido" (DOC); **tarjeta obligatoria**; "no debe usarse en producción" (DOC) | No | NO VERIFICADO: no encontré el tamaño máximo por servicio ni las regiones del plan gratis | NO VERIFICADO | Candidata, sin datos para decidir |
| Zeabur Free | 0 dominios y "1 servidor propio" (DOC): no es hosting gratis | — | — | — | Descartada |
| Hugging Face Spaces | El hardware "CPU Basic" (2 vCPU, 16 GB) figura como gratis, pero **crear un Space Docker exige plan de pago (PRO o equipo)**; en hardware gratis el Space se duerme; el disco no persiste (DOC) | Sí | No | Docker sí, pero no gratis | Descartada |

#### 13.1.1 Cloud Run: ¿el worker dentro de un pedido?

- **No funciona con el worker actual (DOC):** con facturación por pedido, "CPU is only allocated during request processing"; la CPU fuera de pedidos exige facturación por instancia, que se cobra siempre (2.4). pg-boss es un bucle de consultas fuera de cualquier pedido.
- **Patrón posible (INFERENCIA, exige código que hoy no existe):** que la API, al encolar un job, dispare una ejecución de **Cloud Run Job** (o un pedido HTTP largo) que corra el worker hasta vaciar la cola y termine. Gasta CPU solo mientras hay trabajo, cabe en la capa gratis para uso esporádico y deja que Neon duerma. Es un rediseño del worker (modo "vaciar y salir") más una pieza de disparo; no se recomienda para una demo (cambia el contrato de ADR-0005). La doc de Google recomienda Cloud Tasks para trabajo asíncrono (DOC); su límite gratis no se leyó.
- Santiago (`southamerica-west1`) existe, pero sin dominio propio sin balanceador (2.4); para una demo sirve la URL `*.run.app` (DOC: HTTPS y estable).

### 13.2 Oracle Cloud Always Free (detalle)

- **Cupo de Ampere A1 hoy: 2 OCPU y 12 GB, no 4 OCPU y 24 GB (DOC).** La página oficial de recursos Always Free (consultada hoy) dice "first 1,500 OCPU hours and 9,000 GB hours per month … equivalent to 2 OCPUs and 12 GB"; la de la prueba gratuita pide, para conservar las A1 existentes, "no más de 2 OCPU y 12 GB entre todas las instancias". InfoQ (secundaria) cuenta que el recorte rige desde el 2026-06-15 sin anuncio de Oracle, que otras fuentes ubican el 2026-08-18, que las cuentas de pago por uso podrían conservar 4/24 sin confirmación y que una instancia terminada quizá no se pueda recrear sobre el nuevo límite. Para nuestra demo, 2 OCPU/12 GB alcanzan (INFERENCIA: el worker pica ≈ 1 GB).
- **Regiones de Sudamérica (DOC):** Chile Central (Santiago, `sa-santiago-1`), Brasil Este (São Paulo, `sa-saopaulo-1`) y Brasil Sureste (Vinhedo, `sa-vinhedo-1`), cada una con **1 dominio de disponibilidad**. Que A1 se ofrezca en Santiago: NO VERIFICADO (la lista de regiones no dice qué formas hay).
- **Región de casa:** la eligen al crear la cuenta y **no se puede cambiar** ("It is not changeable after your tenancy is provisioned", DOC). Los recursos Always Free de cómputo y de volumen solo se crean en la región de casa (DOC). Se pueden suscribir otras regiones, pero no darse de baja, y lo gratis no corre allí (DOC). Por lo tanto: **elegir Santiago o São Paulo en el registro**, sin vuelta atrás.
- **Tarjeta:** "la mayoría de los usuarios necesitan un teléfono móvil y una tarjeta de crédito"; no se cobra si no se mejora la cuenta (DOC). Prueba gratuita de US$300 por hasta 30 días; al terminar, lo Always Free sigue (DOC).
- **Falta de capacidad:** el error "out of host capacity" indica falta temporal de formas Always Free en la región de casa; las salidas son otro dominio de disponibilidad (Santiago tiene solo 1), esperar y reintentar, o pasar a cuenta de pago por uso, que **no cobra lo Always Free** y solo lo que exceda (DOC). Que Santiago sufra esto con A1: NO VERIFICADO.
- **Recuperación de instancias ociosas (DOC):** Oracle "may reclaim" una instancia Always Free ociosa durante **7 días** si se cumplen a la vez: CPU en el percentil 95 < 20 %, red < 20 % y, en A1, memoria < 20 %. **Una demo esporádica con 12 GB cae en esas tres condiciones** (INFERENCIA): el worker en reposo usa menos del 20 % de 12 GB. Hay que asumir que la VM puede ser reclamada: tenerla reproducible con Compose y con la base respaldada en R2. Que una cuenta de pago por uso esté exenta, el aviso previo y el destino de los datos: NO VERIFICADO (la página no los describe).
- **Salida de datos:** 10 TB al mes (DOC).
- **IP pública:** la doc de recursos habla de una IP pública por VNIC en las Micro; para A1 y para IP reservada no lo dice (NO VERIFICADO). Una IP efímera se mantiene mientras exista la instancia (INFERENCIA).
- **Términos:** Oracle sugiere el uso para "run small-scale applications or perform proof-of-concept testing" (DOC); si una app comercial o de demo con terceros está permitida: NO VERIFICADO (no leí los términos de servicio). Una cuenta por persona y el cierre por inactividad: NO VERIFICADO.
- **Base de datos gratis en Oracle:** hay Autonomous Database (Oracle DB, 20 GB) y MySQL HeatWave; **no hay PostgreSQL gestionado** (DOC). Para nuestro stack, Postgres iría en un contenedor de la misma VM.
- **Límite práctico:** es una VM Arm64. Las imágenes de api y worker deben construirse para `linux/arm64` (sharp, Playwright y `postgresql-client-18` existen para arm64: DOC de Playwright y de PGDG). Fly.io corre normalmente x86-64; que acepte arm64 no lo verifiqué (NO VERIFICADO). Para pasar de una a otra conviene publicar una imagen multi-arquitectura (`linux/amd64,linux/arm64`, INFERENCIA).

### 13.3 Base de datos gratis

**Cómo quedarse dentro de las 100 CU-horas de Neon.** (DOC) CU-horas = tamaño × horas con el cómputo activo; un cómputo suspendido no suma. En Free la suspensión llega a los 5 minutos sin actividad y no se puede desactivar. 100 CU-h = 400 horas activas a 0,25 CU, es decir, **≈ 16,7 días de 24 h**.

- **Qué cuenta como actividad (NO VERIFICADO en la doc):** la página de escalado a cero no define "actividad" ni dice si una conexión abierta e inactiva cuenta. Lo seguro es lo contrario: cualquier consulta lo despierta (DOC: se reactiva "within a few hundred milliseconds" al consultar). Un worker de pg-boss consulta la base cada pocos segundos (sondeo, supervisión, mantenimiento) y **la mantiene despierta mientras haya consultas** (INFERENCIA; ADR-0007 ya lo registró: "el worker mantiene el cómputo despierto mientras corre"). No leí el intervalo de sondeo de pg-boss 12 (NO VERIFICADO).
- **Qué hacer, de más a menos seguro:**
  1. **Encender el worker solo cuando se demuestra** (o mientras hay pocas horas de uso). Con 100 CU-h alcanzan ≈ 16 días de 24 h al mes, o 12 h al día todo el mes (≈ 90 CU-h, sin margen). Es la opción más simple (INFERENCIA, cálculo).
  2. **Subir los intervalos de pg-boss** a 10–15 minutos para que el cómputo duerma entre sondeos: con un sondeo cada 15 min el cómputo estaría activo ≈ 5 de cada 15 min (≈ 33 %), es decir ≈ 61 CU-h al mes (INFERENCIA, cálculo). El costo es que un job puede tardar hasta 15 min en empezar, lo que arruina una demo. Los nombres de las opciones de pg-boss 12 y su efecto: NO VERIFICADO.
  3. **Apagar el sondeo de `/health` del panel** cuando nadie lo mira (hoy cada sondeo hace `select 1`; ADR-0007) y no dejar pestañas abiertas.
  4. **Vigilar el consumo en la consola de Neon** (cierra el NO VERIFICADO).
- **Al agotarlas:** el cómputo se suspende hasta el siguiente período y no se borran datos (DOC, `neon-backup.md`); la demo quedaría caída. Otros límites del plan gratis: 1 GB por proyecto, 5 GB de salida al mes, 6 h de historial (DOC, 2.6).

**Alternativas con plan gratis de Postgres** (todas consultadas hoy):

| Opción | Gratis | Pausa o límite | Para nosotros |
|---|---|---|---|
| Neon Free | 100 CU-h, 1 GB, sin tarjeta | Suspende a los 5 min; sin CU-h, se cae | La actual; la mejor si el worker no está 24/7 |
| **Postgres en la misma VM de Oracle** | US$0 (contenedor `postgres:18`, volumen en el disco de 200 GB) | Sin pausa; si Oracle recupera la VM se pierde el disco | Requiere `pg_dump` diario a R2 y un ADR (cambia ADR-0007); sin restauración instantánea |
| Supabase Free | 500 MB de base, 500 MB de RAM compartida, 5 GB de salida (DOC) | **Se pausa a la semana sin actividad**; máximo **2 proyectos activos** (los 2 del operador ya están en uso, ADR-0007); sin respaldos automáticos (DOC) | Mala: sin cupo de proyectos y sin respaldos |
| Aiven Free PostgreSQL | 1 CPU, 1 GB de RAM, 1 GB de disco, sin tarjeta, sin plazo (DOC) | Apaga los servicios sin uso, con aviso por correo; "no recomendado para producción"; regiones sin nombrar (puede no haber Sudamérica) (DOC) | Posible; latencia y regiones NO VERIFICADAS |
| Render Postgres Free | 1 GB (DOC) | **Expira a los 30 días** (+14 de gracia); sin respaldos (DOC) | Descartada |
| Koyeb Postgres Free | 0,25 vCPU, 1 GB RAM y 1 GB de disco (DOC) | **5 horas de cómputo activo**; escala a cero | Descartada |
| Xata | No hay plan gratis en la nube (solo código abierto autogestionado y 14 días de prueba) (DOC) | — | Descartada |

Compatibilidad con pg-boss (conexión directa, `SKIP LOCKED`, bloqueos de sesión) de Supabase y Aiven: NO VERIFICADO.

### 13.4 Dominio "agentpey" (disponibilidad pública, 2026-10-18)

Lecturas públicas, sin cuenta: WHOIS web de NIC Chile para `.cl`; RDAP de Verisign para `.com`; RDAP del registro de Google para `.app` y `.dev`. Control: el mismo RDAP devolvió datos para `google.dev` y para `agentsales.com`, de modo que un 404 significa "sin inscripción" (INFERENCIA). Disponible solo significa que no estaba inscrito al consultar; puede cambiar antes de comprar.

| Dominio | Resultado | Precio anual |
|---|---|---|
| `agentpey.cl` | **Disponible** ("Nombre de dominio no existe", DOC, WHOIS de NIC Chile) | **$9.990 CLP**, exento de IVA (DOC, 2.8); ≈ US$10 (tipo de cambio NO VERIFICADO) |
| `agentpey.com` | **Ocupado.** Inscrito el **2026-09-13** en Name.com, vence 2027-09-13, servidores de nombres de Vercel (RDAP, DOC) | — |
| `agentpey.app` | **Disponible** (RDAP 404) | ≈ US$14,2 en Cloudflare (precio de terceros, julio de 2026; Cloudflare no lo publica en la página leída: NO VERIFICADO) |
| `agentpey.dev` | **Disponible** (RDAP 404) | ≈ US$12,2 en Cloudflare (misma salvedad) |
| `agentpey-app.cl` | **Disponible** (WHOIS) | $9.990 CLP |
| `getagentpey.com` | **Disponible** (RDAP 404) | ≈ US$10,46 en Cloudflare (terceros; sube cerca de US$0,7 el 2026-11-01 según fuentes secundarias, 2.8) |

- **Atención con `agentpey.com`:** fue inscrito hace cinco semanas, con DNS de Vercel y sin redacción visible del titular. **Si lo compraste tú, ya lo tienes** y solo falta apuntarlo; si no, es de un tercero (el RDAP no lo muestra) y no hay forma de saberlo desde acá.
- **`.app` y `.dev`** están en la lista de HSTS precargado del registro de Google, es decir, el navegador exige HTTPS siempre (INFERENCIA de memoria; no leído hoy). No molesta: Caddy y las plataformas dan HTTPS.
- Para un `.cl` con la VM de Oracle basta un registro A hacia la IP (13.5).

### 13.5 Subdominios gratis con HTTPS y su uso para OAuth y App Review

| Proveedor | Subdominio incluido | Fuente |
|---|---|---|
| Render | `<servicio>.onrender.com`, se mantiene aunque se agregue dominio propio; HTTPS automático | DOC (`custom-domains`) |
| Koyeb | `<app>.koyeb.app` con TLS automático | DOC |
| Cloud Run | `https://SERVICIO-NÚMERO.REGIÓN.run.app`, HTTPS por defecto y estable | DOC |
| Railway | `*.up.railway.app` (la doc de dominios lo menciona como certificado por defecto) | DOC (indirecto) |
| Fly.io | `<app>.fly.dev` (no leído hoy; Fly no tiene plan gratis) | INFERENCIA |
| Hugging Face | `<usuario>-<space>.hf.space` (solo con plan de pago para Docker) | DOC |
| **Oracle (VM)** | **Ninguno.** Hace falta un dominio propio o un DNS dinámico gratis como DuckDNS (`*.duckdns.org`: "free dynamic DNS", ingreso con Google/GitHub; registros A y límites no leídos); Caddy emite el certificado por HTTP-01 si el nombre apunta a la IP y los puertos 80/443 están abiertos (DOC de Caddy, 2.5) | DOC / NO VERIFICADO |

**OAuth e App Review con un subdominio de plataforma:**

- **Mercado Libre (redirect):** exige HTTPS y se puede registrar una URL "incluso si no existe" (DOC, `mercadolibre.md` §3.3). Un `https://….onrender.com/oauth/mercadolibre/callback` sirve como redirect (INFERENCIA). La dirección debe coincidir exacta; cambiarla al migrar de dominio exige registrar la nueva en la app (ESTADO.md ya lo prevé: "registra en la app una segunda dirección").
- **Instagram (redirect):** debe coincidir exactamente con una de las "OAuth redirect URIs" del panel; la doc de Instagram no restringe el dominio (DOC, `instagram.md` §13.3). Una URL `https://….onrender.com/oauth/instagram/callback` debería aceptarse (INFERENCIA; no hay prueba con el panel). En modo desarrollo (acceso estándar) la app funciona con las cuentas con rol, sin revisión (DOC, `instagram.md`), que es todo lo que necesita una demo con el operador y un par de testers.
- **App Review y Business verification:** piden política de privacidad pública, estable y con HTTPS, y la URL de eliminación de datos (DOC, `instagram.md` §13.4). Eso se publica en cualquier dominio. En cambio **no encontré que Meta permita o prohíba subdominios de plataformas ajenas** en "App Domains" ni cómo se verifica un dominio que no controlas el DNS (la página de configuración básica de apps no lo trata): NO VERIFICADO. Recomendación (INFERENCIA): para **App Review usar un dominio propio** (`.cl` o `.com`), porque la verificación del negocio y la persistencia de la URL de privacidad se ligan al dominio; el subdominio gratis queda para la demo en modo desarrollo.
- **Cambio de dirección después:** cada vez que cambie el dominio hay que actualizar las URIs de Instagram y de Mercado Libre, la URL de privacidad y las de eliminación y desautorización. Mantener ambas URIs registradas durante el traslado evita cortar a los corredores (INFERENCIA).

### 13.6 Fuentes de la sección 13 (consultadas el 2026-10-18)

Oracle:

- Recursos Always Free (2 OCPU/12 GB, Micro, 200 GB, 10 TB, reclamación de ociosas, región de casa, falta de capacidad): https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- Prueba gratuita y cuenta Always Free (tarjeta, US$300 por 30 días, tope de 2 OCPU/12 GB): https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm
- Regiones (Santiago, São Paulo, Vinhedo): https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm
- Región de casa no cambiable: https://docs.oracle.com/en-us/iaas/Content/Identity/Tasks/managingregions.htm
- Recorte del cupo A1 (secundaria): https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/ (las páginas oracle.com/cloud/free y su FAQ dieron 403)

Otros cómputos gratis:

- Koyeb, planes y plan gratis: https://www.koyeb.com/pricing y https://www.koyeb.com/docs/faqs/pricing ; escalado a cero: https://www.koyeb.com/docs/run-and-scale/scale-to-zero ; dominios: https://www.koyeb.com/docs/run-and-scale/domains
- Render, plan gratis y planes de cómputo: https://render.com/docs/free y https://render.com/docs/compute-plans.md
- Google, capas gratis (Cloud Run, e2-micro, prueba de US$300): https://docs.cloud.google.com/free/docs/free-cloud-features
- Cloud Run, CPU fuera de pedidos: https://docs.cloud.google.com/run/docs/configuring/billing-settings ; URL `run.app`: https://docs.cloud.google.com/run/docs/triggering/https-request
- Fly.io, sin plan gratis: https://docs.fly.io/about/pricing
- Railway, planes: https://docs.railway.com/reference/pricing/plans
- Northflank: https://northflank.com/pricing , https://northflank.com/docs/v1/application/billing/pricing-on-northflank , https://northflank.com/docs/v1/application/billing/project-types , https://northflank.com/docs/v1/application/billing/resource-plans-and-quotas.md ; resumen de terceros: https://freetier.co/directory/products/northflank
- Zeabur: https://zeabur.com/pricing
- Hugging Face Spaces: https://huggingface.co/docs/hub/spaces-overview y https://huggingface.co/docs/hub/spaces-sdks-docker
- DuckDNS: https://www.duckdns.org/

Base de datos:

- Neon, escalado a cero, latencia y guía: https://neon.com/docs/introduction/scale-to-zero , https://neon.com/docs/connect/connection-latency , https://neon.com/docs/guides/scale-to-zero-guide ; medición: https://neon.com/docs/introduction/usage-metrics
- Supabase: https://supabase.com/pricing
- Aiven: https://aiven.io/free-postgresql-database
- Xata: https://xata.io/pricing
- Render Postgres gratis y Koyeb Postgres: https://render.com/docs/free y https://www.koyeb.com/pricing
- Notas del proyecto: `docs/integraciones/instagram.md` (§13), `docs/integraciones/mercadolibre.md` (§3.3), `docs/integraciones/neon-backup.md`

Dominio:

- WHOIS de NIC Chile: https://www.nic.cl/registry/Whois.do?d=agentpey.cl y `…?d=agentpey-app.cl`
- RDAP `.com` (Verisign): https://rdap.verisign.com/com/v1/domain/agentpey.com , `…/getagentpey.com` y `…/agentsales.com` (control)
- RDAP `.app` y `.dev` (Google Registry): https://pubapi.registry.google/rdap/domain/agentpey.app , `…/agentpey.dev` y `…/google.dev` (control)
- Precios de `.app` y `.dev` en Cloudflare (terceros, no oficiales): https://domainoffer.net/tld/app/cloudflare y https://domainoffer.net/tld/dev/cloudflare
- Meta, configuración básica de la app (App Domains, política de privacidad): https://developers.facebook.com/docs/development/create-an-app/app-dashboard/basic-settings/

### 13.7 NO VERIFICADO (demo gratis)

- Que Oracle ofrezca A1 en Santiago hoy y la frecuencia de "out of host capacity" allí.
- Si una cuenta de pago por uso está exenta de la reclamación de instancias ociosas, y con qué aviso se reclaman.
- Si el recorte a 2 OCPU/12 GB aplica igual a cuentas de pago por uso y desde qué fecha exacta (InfoQ dice 2026-06-15; otras fuentes, 2026-08-18).
- Los términos de Oracle sobre uso comercial o de demo con terceros, cuentas por persona y cierre por inactividad; IP reservada gratis para A1.
- Que Fly.io acepte imágenes `linux/arm64` (la VM de Oracle es Arm64).
- Tamaño por servicio y regiones del plan gratis de Northflank; si Koyeb admite Docker con ffmpeg y Chromium en su plan gratis.
- Qué cuenta como actividad en Neon (conexiones inactivas) y los nombres y valores por defecto de los intervalos de pg-boss 12 (sondeo, supervisión, mantenimiento).
- Regiones del plan gratis de Aiven y compatibilidad de Supabase y Aiven con pg-boss.
- Registros y límites de DuckDNS; que Meta acepte un subdominio de plataforma ajena en App Domains y en la verificación del negocio; que el panel de Instagram acepte la redirect de un `*.onrender.com`.
- Precios de `.app` y `.dev` de Cloudflare (fuente de terceros), el tipo de cambio del `.cl`, y que `.app`/`.dev` sigan libres al comprar.
- Si `agentpey.com` es del operador.

### 13.8 Recomendación para la demo gratis

**Principal: una VM de Oracle Cloud Always Free (Ampere A1, 2 OCPU/12 GB, región Santiago) con Docker Compose (api, worker, Postgres 18 y Caddy), dominio `agentpey.cl`.**

- **Costo:** **US$0 de cómputo y de base**; dominio $9.990 CLP al año (≈ US$0,85 al mes); R2 US$0.
- **Por qué:** es lo único gratis que mantiene un proceso encendido con 12 GB de RAM (sobra para ffmpeg + Chromium), tiene región en Santiago, salida de 10 TB al mes y deja la base en la misma máquina sin contar CU-horas de Neon. Un `.cl` da HTTPS con Caddy y sirve luego para OAuth y App Review (13.5).
- **Qué se pierde frente al plan pagado:** (1) Oracle puede **reclamar la VM por inactividad** (13.2) y hay que poder reconstruirla; (2) no hay restauración instantánea de Neon: la base vive en un disco de la VM, con `pg_dump` diario a R2 (es un ADR nuevo sobre ADR-0007); (3) puede haber falta de capacidad al crearla y **la región de casa no se cambia**; (4) el operador administra el servidor; (5) es Arm64, así que hay que construir imágenes multi-arquitectura; (6) los términos para una app comercial no están verificados.
- **Pasar después a Fly.io + Neon Launch:** fácil si desde ya se publican **las mismas imágenes** de api y worker en `linux/amd64` y `linux/arm64`, con toda la configuración en variables de entorno. El traslado es: `pg_dump`/`pg_restore` de la base de la VM a Neon (flujo de `neon-backup.md`), cargar las variables en `fly secrets`, `fly deploy` con las imágenes, apuntar el DNS del dominio y registrar la nueva dirección en Instagram y Mercado Libre (mantener la vieja unos días). Sin cambio de código (INFERENCIA); la única dependencia es que Fly acepte la arquitectura de la imagen (por eso conviene construirla en amd64 también).

**Alternativa: Fly.io `gru` con las máquinas encendidas solo los días de demo, más Neon Free.**

- **Costo:** no es US$0 pero casi: Fly cobra por segundo de máquina encendida y una detenida cuesta solo el disco raíz (US$0,15/GB al mes, DOC). Api 512 MB + worker 1 GB ≈ US$16,8 por 30 días, o **≈ US$0,56 por día de demo** (INFERENCIA, 16,8 / 30), de modo que 4 días al mes son ≈ US$2,2, más el dominio. Neon Free alcanza porque el cómputo duerme cuando el worker está apagado (13.3, opción 1). Pide tarjeta.
- **Por qué:** cero administración, región `gru` junto a Neon, **la misma imagen y la misma plataforma que la fase paga**; no hay riesgo de reclamación ni de capacidad.
- **Qué se pierde:** hay que encender y apagar las máquinas a mano (`fly machine start/stop`, INFERENCIA) y nadie puede usar la herramienta fuera de esas ventanas; el subdominio `*.fly.dev` sirve para la demo, no para App Review.
- **Puente de US$0 de 2 semanas:** Railway Trial (US$5, 30 días, sin tarjeta) con Neon Free alcanza ≈ 14 días de worker 24/7 (≈ 84 CU-h), con la API en Virginia y la base en São Paulo (latencia, 9).

**Descartadas para la demo:** Render, Koyeb, Hugging Face y Zeabur (no hay worker gratis o no hay Docker gratis), Cloud Run (el worker no corre fuera de pedidos sin rediseño), e2-micro de Google (sin región sudamericana y 1 GB) y Supabase (sin cupo de proyectos).

**Preguntas para el operador:**
1. ¿Aceptas una tarjeta de crédito en Oracle y elegir ya la región de casa (Santiago) sin poder cambiarla?
2. ¿Prefieres administrar una VM propia (US$0, más trabajo, riesgo de reclamación) o pagar centavos por día de demo en Fly (sin administración)?
3. ¿`agentpey.com`, inscrito el 2026-09-13 en Name.com con DNS de Vercel, es tuyo? Si no, ¿te sirve `agentpey.cl`?
4. ¿Autorizas un ADR para dejar Postgres en la VM de la demo (distinto de ADR-0007)?

## 14. Fly.io para el despliegue (F8-T10 y T11)

Ronda del **2026-10-18** (tercera del día) para escribir el `Dockerfile` (T10) y el `fly.toml` con el flujo de despliegue (T11), spec `docs/specs/fase-8-en-internet.md` §4.7 y §4.15. Misma convención: **DOC** = leído en la página oficial (o en la API pública del registro: Docker Hub, GitHub, índice de PGDG); **INFERENCIA** = deducido; **NO VERIFICADO** = no lo dice la doc o no se pudo comprobar sin cuenta. Sin cuentas ni llamadas autenticadas: solo lecturas públicas. Fuentes y fecha en 14.9. Lo que ya estaba verificado en las secciones 1 a 13 no se repite.

### 14.0 Correcciones a secciones anteriores

- **`swap_size_mb` es una clave de la raíz de `fly.toml`, no de `[[vm]]`** (DOC). Aplica a las máquinas de toda la app, no por grupo de procesos (INFERENCIA: la doc no permite indicarlo por grupo). La sección 2.1 lo dejaba ambiguo.
- **El `shared-cpu-1x` admite hasta 2 GB** (DOC: la memoria máxima es `2 GB × tamaño compartido` y la mínima `256 MB × tamaño`, en múltiplos de 256 MB). Un worker de 2 GB puede ser `cpus = 1` y no hace falta pasar a `2x` como suponía la tabla 2.9; el precio de 1x/2 GB no está verificado (calculadora).
- **La versión de `postgresql-client-18` en `trixie-pgdg` es `18.6-1.pgdg13+2`**, no `18.6-3`: lo que lista el directorio `pool/` (sección 8) incluye también construcciones de otras suites (`-testing`, `-snapshot`). El índice `dists/trixie-pgdg/main/binary-{amd64,arm64}/Packages` (leído hoy; `Release` del 2026-10-15) solo trae `18.6-1.pgdg13+2`, `18.4-1.pgdg13+1` y `18.3-1.pgdg13+1` (DOC).
- **`/api/health` hoy responde siempre 200** (`apps/api/src/app.ts`, "Siempre 200: el estado va en el cuerpo"; `ok` o `degraded`). Solo no responde 200 si el proceso no contesta. La pregunta del 503 se contesta igual en 14.1 por si eso cambia.

### 14.1 `fly.toml` completo (dos procesos, una imagen)

Los comandos de `[processes]` y de `release_command` son **ejemplos**: los reales los fija T10 según lo que compile `tsconfig.build.json`. Todo lo demás sigue la sintaxis de la doc (DOC).

```toml
app = "agentsales"          # nombre único en toda Fly; NO VERIFICADO que esté libre (se ve al crear la app)
primary_region = "gru"      # São Paulo; define también dónde se crean las máquinas nuevas
kill_signal = "SIGTERM"     # por defecto es SIGINT (DOC)
kill_timeout = 45           # segundos; defecto 5, máximo 300 (DOC). El worker espera 30 s (spec §4.10)
swap_size_mb = 512          # raíz del archivo; swap en las máquinas de la app

[build]
  dockerfile = "Dockerfile"

[env]                       # solo lo no secreto; los secretos van por `fly secrets`
  NODE_ENV = "production"
  PUBLIC_URL = "https://agentsales.agentpey.com"
  API_HOST = "0.0.0.0"      # Fly Proxy exige escuchar en 0.0.0.0 o [::], no en 127.0.0.1 (DOC)
  API_PORT = "8080"
  CLIENT_IP_HEADER = "Fly-Client-IP"
  PUBLISH_MODE = "dry-run"

[processes]
  api = "node apps/api/dist/server.js"          # ejemplo
  worker = "node apps/worker/dist/worker.js"    # ejemplo

[deploy]
  strategy = "rolling"                          # es el defecto
  release_command = "node packages/db/dist/migrate.js"   # ejemplo (migraciones)
  release_command_timeout = "5m"                # defecto 5 minutos
  [deploy.release_command_vm]                   # sin esto hereda el tamaño de la máquina más grande
    cpu_kind = "shared"
    cpus = 1
    memory = "512mb"

[http_service]
  processes = ["api"]       # solo la API recibe tráfico; el worker queda sin servicio
  internal_port = 8080      # debe ser el puerto en que escucha el proceso (defecto 8080)
  force_https = true
  auto_stop_machines = "stop"   # "off" | "stop" | "suspend"; defecto "off"
  auto_start_machines = true    # defecto true
  min_machines_running = 0      # defecto 0; solo cuenta con auto_stop activo, y solo en la región primaria

  [[http_service.checks]]
    method = "GET"
    path = "/api/health"
    protocol = "http"
    grace_period = "30s"    # espera tras arrancar antes del primer chequeo
    interval = "30s"
    timeout = "10s"
    [http_service.checks.headers]
      Host = "agentsales.agentpey.com"
      X-Forwarded-Proto = "https"

[[restart]]
  policy = "on-failure"     # es el defecto: reinicia solo si el proceso sale con código distinto de 0
  processes = ["worker"]

[[vm]]
  processes = ["api"]
  cpu_kind = "shared"
  cpus = 1
  memory = "512mb"

[[vm]]
  processes = ["worker"]
  cpu_kind = "shared"
  cpus = 1
  memory = "1gb"            # "2gb" si la medición de T10 pasa de ≈ 900 MB de pico
```

Detalle de cada pieza (DOC salvo que se indique):

| Pieza | Sintaxis y reglas |
|---|---|
| `[processes]` | `nombre = "comando"`. Servicios, `[[vm]]`, chequeos y `[[restart]]` se dirigen a un grupo con `processes = ["nombre"]`. El comando reemplaza al `CMD` del Dockerfile (el `ENTRYPOINT`, si existe, se mantiene: no poner uno que arranque la app). |
| `[http_service]` | `processes`, `internal_port` (defecto 8080), `force_https`, `auto_stop_machines` (`"off"`, `"stop"`, `"suspend"`), `auto_start_machines` (booleano, defecto `true`), `min_machines_running` (defecto 0). La doc aconseja activar o desactivar juntos auto-stop y auto-start. |
| `[[http_service.checks]]` | Campos: `grace_period`, `interval`, `timeout`, `method` (defecto `get`), `path`, `protocol` (`http` defecto, o `https`), `tls_server_name`, `tls_skip_verify`, `headers` (subtabla). **Unidades: milisegundos si no se indica otra, o texto con unidad (`"10s"`).** **La doc no da mínimo ni máximo** para `timeout`, `interval` ni `grace_period` (NO VERIFICADO si hay un tope duro). Espera 2xx y **no sigue redirecciones 301/302** (una redirección cuenta como fallo). El chequeo corre contra el servicio **en la máquina, por la red privada, no contra `<app>.fly.dev`**. |
| `[[vm]]` | `memory` (`"512mb"`, `"1gb"`; un entero son MB), `cpus` (1, 2, 4, 8 o 16 según el tipo), `cpu_kind` (`shared` o `performance`), `size` (preajuste; el de menor precedencia), `processes`. Un bloque sin `processes` vale para los grupos que ningún otro bloque nombra. Memoria en múltiplos de 256 MB (compartidas). |
| `kill_signal` / `kill_timeout` | Raíz del archivo. Señales: `SIGTERM`, `SIGQUIT`, `SIGUSR1`, `SIGUSR2`, `SIGKILL`, `SIGSTOP` (el defecto es `SIGINT`). `kill_timeout` en segundos, **máximo 300**. Las apps ya manejan `SIGINT` y `SIGTERM` (`apps/api/src/server.ts`, `apps/worker/src/worker.ts`); se fija `SIGTERM` por claridad con el spec. |
| `primary_region` | Código de tres letras; define `PRIMARY_REGION` dentro de la máquina y pisa un valor de `[env]`. |
| `[deploy] release_command` | **Corre en una máquina temporal construida con la imagen nueva**, una vez por intento de despliegue, antes de reemplazar nada. **Hereda variables de entorno, secretos y red**; no tiene volúmenes y su disco no persiste. Pone `RELEASE_COMMAND=1`. Reemplaza al `CMD`; el `ENTRYPOINT` se mantiene. Tamaño por defecto: el de la máquina más grande del grupo por defecto; se fija con `[deploy.release_command_vm]`. Plazo por defecto 5 minutos (`release_command_timeout`). **Si sale con código distinto de 0, el despliegue falla y no avanza** (las máquinas actuales siguen con la versión anterior; DOC de la guía de despliegues sin corte). Si el comando se ejecuta con shell (pipes, `&&`) o se parte por palabras: NO VERIFICADO. |
| `[deploy] strategy` | `rolling` (defecto: reemplaza de una en una), `immediate` (todas a la vez, sin esperar chequeos), `canary` (una nueva primero; **no admite volúmenes**), `bluegreen` (una nueva junto a cada vieja y luego cambia el tráfico; **exige al menos un chequeo**). Con una sola máquina por región el defecto pasa a `rolling`. `max_unavailable` (solo `rolling`; defecto 0,33). Para este caso, `rolling` (el worker no tiene chequeo, así que `bluegreen` no aplica). |
| `[[restart]]` | `policy` = `always`, `never` o `on-failure` (defecto); `retries`; `processes`. |

**¿Un chequeo HTTP que responde 503 saca la máquina del balanceo?** (DOC)

- **Sí, si es un chequeo de servicio** (`[[http_service.checks]]` o `[[services.http_checks]]`): "if a Machine fails its service check, it will be marked as unhealthy by the proxy, and it won't be routed to until its checks start passing". El chequeo espera 2xx, así que un 503 es un fallo (la doc no nombra el 503, pero dice que cualquier cosa distinta de 2xx falla).
- **No afectan al enrutamiento** los `[checks]` de la raíz ni los `machine_checks`; estos últimos solo corren en despliegues `rolling` y `canary` y, si fallan, detienen el despliegue.
- Un chequeo que falla **no reinicia ni detiene** la máquina; solo la deja fuera del reparto (DOC).
- En un despliegue, Fly espera a que cada máquina quede sana (`--wait-timeout`, DOC de `fly deploy`).
- **Con una sola máquina de la API** y el chequeo en rojo, el proxy no tiene a quién enrutar: qué respuesta ve el cliente (¿503/502 de Fly?) es NO VERIFICADO; se prueba en el despliegue de prueba (14.6).
- **Consecuencia para nosotros:** cada check de `/health` tiene un tope de 25 s (`DEFAULT_CHECK_TIMEOUT_MS`) y la ruta responde 200 aunque la base falle. Con `timeout = "10s"`, una base despertando o caída que haga tardar `/health` más de 10 s dejaría **la máquina fuera del balanceo** (el cliente vería el error de Fly y no el `DB_UNAVAILABLE` de la API). Dos salidas (decisión del operador, 14.10): (a) un `timeout` mayor que 25 s, sin saber si Fly admite ese valor, o (b) un chequeo de vida sin base (por ejemplo `GET /api/health?live=1` o una ruta aparte) que solo diga que el proceso responde. Se recomienda (b) para el chequeo de Fly y dejar `/health` completo para `doctor` y el monitor externo. Es un cambio de código, que no es de esta nota.

**`auto_stop_machines` y el worker** (DOC): Fly Proxy detiene máquinas cuando "la app tiene capacidad de sobra", mide la carga por la `soft_limit` de concurrencia (defecto 20) y detiene **como máximo una máquina por región por pasada**, cada pocos minutos; nunca crea ni destruye máquinas. Las máquinas que no pasan por un servicio (el worker, sin `[http_service]`) no las gestiona el proxy: ni las detiene ni las arranca (la doc lo dice de las apps con servicios fuera de la red privada, y el worker no tiene servicio; INFERENCIA razonable). Con auto-stop activo y sin tráfico, la API se detiene sola (con una máquina en la región, si no tiene tráfico). **Cualquier sondeo externo a `/api/health` (monitor, pestaña del panel) cuenta como tráfico y la mantiene encendida** (INFERENCIA). Una máquina detenida no cobra CPU ni RAM, solo el disco raíz; con `"suspend"` la reanudación toma cientos de milisegundos contra ≈ 2 s o más desde `stop`, con salvedades (no evaluadas; se usa `"stop"`, que además es compatible con el swap).

### 14.2 `flyctl`: comandos copiables

Reemplaza `agentsales` por el nombre real de la app. Instalación y `fly auth login` los hace el operador. `fly` y `flyctl` son el mismo programa. Última versión estable: **v0.4.118** (publicada 2026-10-14, DOC de GitHub).

**Crear la app sin desplegar**

```bash
fly apps create agentsales --org personal      # --name / --org / --network / --save (DOC); no genera fly.toml
```
- Alternativa: `fly launch --no-deploy --copy-config --name agentsales --region gru --dockerfile Dockerfile` (DOC de las banderas: `--no-deploy` omite el despliegue "after fly launch creates and configures it"; `--copy-config` usa el `fly.toml` existente sin preguntar). Con un `fly.toml` escrito a mano, `fly apps create` es más directo. `fly launch` puede proponer cambios, por eso se prefiere la primera.
- `fly config save -a agentsales` baja el `fly.toml` de una app que ya existe (DOC).

**Secretos sin que queden en el historial**

```bash
# El archivo vive fuera del repo (por ejemplo ~/.agentsales-secrets/produccion.env), permiso 600, formato NOMBRE=VALOR
fly secrets import --stage -a agentsales < ~/.agentsales-secrets/produccion.env
# o desde el portapapeles, sin archivo:
pbpaste | fly secrets import --stage -a agentsales
```
- `fly secrets import` lee de **stdin** pares `NAME=VALUE` (DOC). Banderas: `--app`, `--stage` ("Set secrets but skip deployment for machine apps"), `--detach`. Nada de valores en la línea de comandos, así que no quedan en el historial ni en `ps`.
- **Usar `--stage` en el primer despliegue y mientras el worker deba seguir apagado:** sin `--stage`, `fly secrets set/import` "actualiza cada máquina" y **la reinicia** (DOC); con `--stage` los secretos quedan guardados y los toman las máquinas que se inicien o actualicen después. Para aplicarlos a la versión actual sin reconstruir: `fly secrets deploy`.
- Los secretos llegan como variables de entorno al arrancar la máquina y **también al `release_command`** (DOC: hereda secretos). No están disponibles durante el build de la imagen (para eso hay "build secrets", no usados).
- Si se pega el contenido en el chat o se lee con Claude, deja de ser secreto: el operador los carga a mano.
- Con valores de varias líneas o con comillas, cómo interpreta `import` el formato: NO VERIFICADO (la doc solo dice `NAME=VALUE`). Los nuestros son de una línea.

**Dominio propio y certificado**

```bash
fly certs add agentsales.agentpey.com -a agentsales   # muestra "las opciones de configuración DNS aplicables" (DOC)
fly certs setup agentsales.agentpey.com -a agentsales # vuelve a mostrar las instrucciones
fly certs check agentsales.agentpey.com -a agentsales # valida DNS y estado (mismo formato que `certs show`)
fly certs show agentsales.agentpey.com -a agentsales
```
- **Registros DNS (DOC):** para un subdominio sirven `CNAME` (apunta "a un nombre `.fly.dev` único de la app") o `A` + `AAAA` (hacia las IP de la app; `fly ips list`). La doc recomienda A/AAAA "para la mayoría de las conexiones directas" y dice que `CNAME` "funciona bien para subdominios (como `app.example.com`)". El apex con `CNAME` es problemático (no es nuestro caso).
- **Ojo con el destino del `CNAME`:** la doc dice que "cada app tiene un destino CNAME único que se muestra en el panel" y en `fly certs setup`. **No asumir que es `agentsales.fly.dev`**: copiar el valor exacto que imprime Fly (NO VERIFICADO su forma).
- **Emisión (Let's Encrypt):** para emitir o renovar Fly necesita verificar el dominio con al menos una de estas: un registro **AAAA** hacia la app, un **CNAME `_acme-challenge`** (DNS-01) o un **TXT `_fly-ownership`**. La doc no dice que un `CNAME` hacia `.fly.dev` solo baste (aunque un `CNAME` se resuelve hasta el AAAA de la app: INFERENCIA, y es el caso habitual). **Plan:** crear el `CNAME` que muestra `fly certs add`, correr `fly certs check` y, si queda pendiente, agregar también el `_acme-challenge` o el `_fly-ownership` que Fly indique. Para tener el certificado listo antes de mover tráfico, usar el `_acme-challenge`.
- La app necesita IP públicas: en el **primer despliegue con un servicio público** Fly asigna sola una **IPv6 dedicada** y una **IPv4 compartida** (DOC; gratis). Si no, `fly ips allocate-v6` y `fly ips allocate-v4 --shared`. La IPv4 dedicada es opcional (`fly ips allocate-v4`, US$2 al mes). Fly no asigna IP automáticas a una app sin servicio público.
- **DNS de Vercel:** el registro se agrega en el DNS de `agentpey.com` en Vercel (el DNS de Vercel no hace de proxy; no leí su doc: NO VERIFICADO). Si hubiera registros `CAA` en `agentpey.com`, deben permitir a Let's Encrypt (`letsencrypt.org`; confirmar con `fly certs show`).
- Certificados: 10 de un solo nombre gratis (sección 2.1).

**Desplegar**

```bash
fly deploy --remote-only --ha=false -a agentsales
```
- `--remote-only` construye en un constructor remoto de Fly, sin Docker local; la doc dice que **ya es el defecto**. `--local-only` usa el Docker local.
- **`--ha=false` en el primer despliegue** (DOC: `--ha` crea máquinas de repuesto, defecto `true`). La doc de despliegue dice que el primero crea **una o dos máquinas por grupo de procesos** según haya servicios o volúmenes; dos workers con la misma cola no es lo que queremos en la demo, y dos APIs duplican el costo. Que la bandera `--ha` exista y su defecto vienen de la doc de `fly deploy`; que `--ha=false` deje exactamente una máquina por grupo lo dicen los foros de Fly (NO VERIFICADO en la doc oficial): se comprueba con `fly machine list`.
- Otras banderas útiles (DOC): `--strategy`, `--config`, `--image`, `--image-label`, `--detach`, `--wait-timeout`, `--release-command-timeout`, `--no-cache`, `--build-arg`.

**Logs, estado y versiones**

```bash
fly logs -a agentsales                 # en vivo; --no-tail (-n) imprime y sale; -m <id_máquina>; -r <región>; --json
fly status -a agentsales               # máquinas y su estado
fly machine list -a agentsales         # ids (-q solo ids; -j JSON)
fly releases -a agentsales --image     # versiones con la imagen de cada una
```

**Volver a una versión anterior** (DOC, guía de rollback: no existe un comando `rollback`; se vuelve a desplegar una imagen anterior)

```bash
fly releases -a agentsales --image                          # elegir la última buena
fly deploy -a agentsales --image registry.fly.io/agentsales:deployment-<ID>   # sin reconstruir
# para dejar etiquetas fáciles: fly deploy --image-label v1.2.3, y luego --image registry.fly.io/agentsales:v1.2.3
```
- Advertencias de la guía: **no deshace migraciones** (por eso las migraciones son aditivas, spec §4.7); **no deshace cambios de `fly.toml` ni de secretos**; Fly **no garantiza** conservar las imágenes; hay que verificar con logs y estado, no solo con el mensaje de éxito. El `release_command` de la imagen anterior se ejecuta otra vez (INFERENCIA: corre "una vez por intento de despliegue"): con migraciones aditivas no hace nada.

**Encender y apagar para una demo**

```bash
fly machine list -a agentsales                                 # anotar el id del worker (y el de la API)
fly machine stop  <id_worker> -a agentsales --signal SIGTERM --timeout 45
fly machine start <id_worker> -a agentsales
# la API: se apaga sola sin tráfico y arranca con el primer pedido; para forzarlo igual:
fly machine stop  <id_api> -a agentsales --signal SIGTERM --timeout 45
```
- **`fly machine stop/start` es lo que conviene** (DOC): una máquina detenida no cobra CPU ni RAM, solo su disco raíz (US$0,15 por GB al mes; el tamaño sale de la imagen más unos ajustes de containerd). Con una imagen de ≈ 2–3 GB (INFERENCIA) son ≈ US$0,3–0,45 al mes por máquina detenida. "Iniciar y detener es mucho más rápido que crear y destruir" y las máquinas detenidas son más baratas que las encendidas (DOC).
- **`fly scale count worker=0` destruye las máquinas** del grupo (DOC: "Machines get destroyed when the target number of Machines is lower than the existing total"). Para volver a tener una, `scale count` ya no puede clonar (no queda ninguna): hay que correr `fly deploy`, que "siembra" máquinas nuevas (de a dos por proceso si no se usa `--ha=false`). Sale US$0 en disco pero se pierde el id y se repite un despliegue: **no se recomienda para una demo**; sí sirve para dejar la app sin costo si no se usará en meses.
- `fly machine stop`: banderas `--signal` (defecto `SIGINT`), `--timeout` ("segundos antes de enviar SIGKILL"), `--wait-timeout`. Si `kill_signal`/`kill_timeout` del `fly.toml` se aplican a este comando: NO VERIFICADO; por eso se pasan explícitos.
- **El worker no lo arranca nadie solo:** sin servicio, el proxy no lo enciende (INFERENCIA, ver 14.1). Hay que arrancarlo con `fly machine start`.
- **Un despliegue puede volver a encender un worker detenido: NO VERIFICADO.** La doc dice que, desde flyctl 0.1.119, un despliegue **no reinicia las máquinas detenidas de servicios con auto-stop/auto-start** (reciben la configuración y siguen detenidas); no dice nada de un grupo sin servicio. Regla segura: tras cada `fly deploy` en modo demo, correr `fly machine list` y detener el worker si quedó encendido. Se comprueba en 14.6.
- Cómo distinguir la máquina del worker en `fly machine list`: la doc no describe las columnas (NO VERIFICADO que haya una de "grupo de procesos"); se sabe por el comando o con `fly machine status <id>`.

**Token solo de despliegue**

```bash
fly tokens create deploy -a agentsales -n github-deploy -x 4380h | pbcopy   # queda en el portapapeles, no en pantalla
```
- DOC: "crea un token limitado a administrar **una sola app** y sus recursos"; `--app`, `--name` (defecto `flyctl deploy token`), `--expiry` (defecto 175.200 h = **20 años**; la doc recomienda uno más corto). `4380h` ≈ 6 meses (renovar a mano).
- Se pega en GitHub como secreto `FLY_API_TOKEN` (web: Settings → Secrets and variables → Actions, o `pbpaste | gh secret set FLY_API_TOKEN`; esto último no está verificado aquí). Nunca en el chat.
- Qué más puede hacer ese token (certificados, secretos, `machine start/stop`): NO VERIFICADO; el flujo de despliegue solo necesita `fly deploy`.

### 14.3 GitHub Actions: `superfly/flyctl-actions/setup-flyctl`

- **Última versión estable: etiqueta `1.6`** (sin `v`; existen además `v1` y `1`, que apuntan a lo mismo). Está en la punta de `master` hoy; es el commit del 2026-04-08 "Merge pull request #108 … chore(setup): update nodejs runtime". La acción corre con **`node24`** (`action.yml`). Ojo: la página de *Releases* de GitHub llega solo hasta `1.5` (2024-02-02); `1.6` es una etiqueta sin Release (lightweight, `object.type = commit`).
- **SHA del commit de `1.6` (40 caracteres):** `ed8efb33836e8b2096c7fd3ba1c8afe303ebbff1` (se obtuvo con `git/matching-refs/tags`, `tags` y `commits/<sha>` de la API pública de GitHub: las tres coinciden). Para comparar, `1.5` = `fc53c09e1bc3be6f54706524e3b82c4f462f77be`.
- Entrada `version` (DOC): `latest` por defecto; el README recomienda **fijarla** en producción. Última de flyctl: `0.4.118`.
- Uso (DOC del README): el token va en la variable `FLY_API_TOKEN` del paso que corre `flyctl`.

```yaml
      - uses: superfly/flyctl-actions/setup-flyctl@ed8efb33836e8b2096c7fd3ba1c8afe303ebbff1 # 1.6
        with:
          version: 0.4.118
      - run: flyctl deploy --remote-only --ha=false
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```
- `--ha=false` en un despliegue ya existente no cambia el número de máquinas (INFERENCIA, los foros lo describen para el primer despliegue); se puede quitar después del primero.
- El README usa `@master`; el repo fija por SHA, por eso lo de arriba.

### 14.4 Cabecera de la IP del cliente

- **`Fly-Client-IP`** es el nombre (DOC, "request headers"): "la IP del cliente desde la perspectiva de Fly Proxy"; **la pone Fly Proxy**. Si hay otro proxy delante (Cloudflare con la nube naranja, por ejemplo), trae la IP de ese proxy, no la del cliente, y habría que leer `X-Forwarded-For`. Con Vercel solo como DNS no hay proxy delante.
- `X-Forwarded-For` "debe tratarse con cuidado para evitar suplantación" (DOC); `X-Forwarded-Port` "puede venir del cliente"; `Fly-Forwarded-Port` y `Fly-Region` también son del proxy. `X-Forwarded-Proto` es `http` o `https`; la doc no dice quién lo pone.
- **NO VERIFICADO:** que Fly Proxy **sobrescriba** un `Fly-Client-IP` enviado por el cliente (la doc no lo dice; un foro lo da por no falsificable sin prueba). Prueba sin riesgo: `curl -H "Fly-Client-IP: 203.0.113.9" https://agentsales.agentpey.com/api/health` con un log temporal que muestre la cabecera recibida, o contra el sitio de depuración público de Fly que cita un foro (`debug.fly.dev`, no verificado). Hasta entonces, con una sola instancia de la API (spec §3) y límites por IP solo defensivos, el riesgo es bajo.

### 14.5 La imagen (T10)

**(a) `node` para Node 26 (DOC, API pública de Docker Hub, 2026-10-18)**

- Existen `26-bookworm-slim`, `26-trixie-slim`, `26-slim` (que es trixie) y las versiones `26.12.0-*`, `26.12-*`, `26.11.1-*`. Node **26.12.0** es la última 26.x; Node 26 sigue en estado **Current** (publicada el 2026-05-05; la página de versiones no dice cuándo pasa a LTS) (DOC, nodejs.org).
- **Recomendada: `trixie-slim`** (Debian 13): Playwright 1.63 la soporta, PGDG tiene `postgresql-client-18` para `trixie-pgdg` (c) y el ffmpeg estático necesita glibc ≥ 2.28 (d). `bookworm` también sirve pero es más vieja.
- **Etiqueta exacta y digest** (la etiqueta `26.12.0-trixie-slim`, subida el 2026-10-14T20:42:19Z; el digest es el del **índice multi-arquitectura**, válido para amd64 y arm64; leído dos veces, por la lista de etiquetas y por la etiqueta sola):

```dockerfile
FROM node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4
```
  - Por arquitectura (por si hiciera falta fijar una): amd64 `sha256:d62f13676d530f7edf97782729df69713c8ccfe6631e7f62f9ccab65968719a8`; arm64/v8 `sha256:f6e55fb0e92f7f115549278ab36f68f0659790f5d4fd7cb4446486d8ed70d842`.
  - Referencia: `26.12.0-bookworm-slim` = `sha256:298992629d69bbd5b2b03ad57094d8e4fcb3a8eeb7c4e25d29de656519568913`.
  - Fijar el digest congela los parches de seguridad de Debian: hay que subirlo a mano (o con un bot) de vez en cuando (INFERENCIA). La etiqueta con versión (`26.12.0`) y el digest tienen que moverse juntos.
- **pnpm:** desde Node 25 **Corepack ya no viene con Node** ("distribuido desde la 14.19.0 hasta antes de la 25.0.0", DOC del README de Corepack). Hay que instalar pnpm a propósito (`npm install -g pnpm@11.24.0`, la versión de `packageManager`, o `npm install -g corepack` y `corepack enable`). pnpm 11 admite Node 22, 24 y 26 (DOC). `npm install -g pnpm@…` funciona (INFERENCIA); se prueba en la CI.

**(b) Playwright 1.63 y `--with-deps chromium` (DOC)**

- Requisitos de sistema en la doc de Playwright: Node "latest 22.x, 24.x or 26.x" y Linux **"Debian 12 / 13, Ubuntu 22.04 / 24.04 / 26.04 (x86-64 or arm64)"**. La doc "actual" ya es la de 1.64; la del tag `v1.63.0` (`docs/src/intro-js.md`) dice lo mismo.
- En el código de `v1.63.0`, `nativeDeps.ts` trae listas de paquetes para `debian12-x64`, `debian13-x64`, `debian12-arm64` y `debian13-arm64` (más Ubuntu 22.04, 24.04 y 26.04). Para `debian13-x64` Chromium pide `libasound2t64`, `libatk-bridge2.0-0t64`, `libatk1.0-0t64`, `libatspi2.0-0t64`, `libcairo2`, `libcups2t64`, `libdbus-1-3`, `libdrm2`, `libgbm1`, `libglib2.0-0t64`, `libnspr4`, `libnss3`, `libpango-1.0-0`, `libx11-6`, `libxcb1`, `libxcomposite1`, `libxdamage1`, `libxext6`, `libxfixes3`, `libxkbcommon0`, `libxrandr2`, y las "tools" (fuentes, `xvfb`, `libfontconfig1`, `libfreetype6`). Es decir, **`--with-deps` también mete `xvfb` y varias fuentes**: la imagen crece (INFERENCIA, tamaño no medido).
- Alpine y otras con musl **no se soportan** (DOC).
- Instalar como root en el Dockerfile (la doc: con proxy hay que correr como root). Fijar la carpeta de navegadores: `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` (DOC: se fija al instalar y al ejecutar; `0` los deja en `node_modules`). Hay que dar permiso de lectura si el proceso corre sin root.
- **No usar `--only-shell`:** Playwright usa `chromium_headless_shell` para lo sin ventana y `--only-shell` salta el Chromium completo (DOC), pero `chromiumStatus()` (`packages/media/src/tools.ts`) pide **los dos** y `doctor` marcaría "no instalado". `playwright install --with-deps chromium` instala ambos.
- Comando (el mismo de la CI, con la ruta fija): `pnpm --filter @agentsales/media exec playwright install --with-deps chromium`. Playwright es dependencia de `packages/media` y de `packages/publishers`, ambas `1.63.0`.
- Con Chromium en contenedor Playwright recomienda `--ipc=host` y `--init` (DOC). En Fly no se pasan banderas de Docker; el tamaño de `/dev/shm` y el manejo de procesos zombi con el init de Fly: NO VERIFICADO (se mide en 14.6, junto con el pico de memoria).
- Limpiar después: `rm -rf /var/lib/apt/lists/*`.

**(c) `postgresql-client-18` desde PGDG (DOC)**

- Debian: PGDG soporta `bookworm` y `trixie` (más `forky` y `sid`) en amd64, arm64, ppc64el y loong64 (trixie en adelante).
- **Existe** `postgresql-client-18` para `trixie-pgdg` en amd64 y arm64: versión candidata **`18.6-1.pgdg13+2`**, `Depends: libpq5 (>= 18.6), postgresql-client-common (>= 182~), libc6 (>= 2.38), …` (índice `Packages`, leído hoy; `Release` del 2026-10-15). Neon va en 18.6 (sección 2.6), así que cuadra. Para `bookworm-pgdg` también hay versiones de `pgdg12` (pool).
- **Forma vigente de agregar la clave y el repositorio** (wiki de PostgreSQL y página de descarga para Debian): la clave `https://www.postgresql.org/media/keys/ACCC4CF8.asc` se guarda en **`/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc`** y el repositorio va en `/etc/apt/sources.list.d/pgdg.sources` (formato deb822) con `Signed-By:` apuntando a ese archivo. **La wiki no menciona `/etc/apt/keyrings`.** La alternativa es `apt install -y postgresql-common ca-certificates` y correr `/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh` (la doc no documenta sus banderas, y trae el paquete `postgresql-common` entero con sus dependencias: más pesado).

```dockerfile
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL --retry 3 -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && . /etc/os-release \
 && printf 'Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: %s-pgdg\nComponents: main\nSigned-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc\n' \
      "$VERSION_CODENAME" > /etc/apt/sources.list.d/pgdg.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && pg_dump --version | grep -q 'pg_dump (PostgreSQL) 18\.' \
 && rm -rf /var/lib/apt/lists/*
```
  - Es el fragmento de la wiki, adaptado: sin `deb-src`, sin la línea `Architectures` (apt usa la de la máquina) y con el nombre de la suite sacado de `/etc/os-release`. Que `VERSION_CODENAME` exista en la imagen `slim` y que apt acepte la clave `.asc` armada en `Signed-By`: INFERENCIA (apt de trixie es 3.x); la CI lo prueba al construir. Conviene dejar anotada la huella de la clave tras la primera descarga (`gpg --show-keys`), para detectar un cambio; no la verifiqué.
  - **No usar el `postgresql-client` de Debian** (trixie trae el 17): `pg_dump` se niega a volcar un servidor más nuevo (sección 8).

**(d) ffmpeg estático de la CI dentro de la imagen (DOC)**

- La URL y el sha256 de `.github/workflows/ci.yml` son los correctos: el release `autobuild-2026-08-31-13-27` de BtbN (publicado 2026-08-31T13:28:30Z) ofrece `ffmpeg-n9.0.1-11-ge47273f4d9-linux64-gpl-9.0.tar.xz` de 126.600.656 bytes con **`sha256:182c1b509720e939bb47bfb47dc29cc0c298640401128e3dce8627d10707eb5a`**, igual al de la CI.
- El README de BtbN: los builds de Linux apuntan a RHEL/CentOS 8 (**glibc 2.28, kernel 4.18**) "y todo lo más nuevo"; `linux64` = x86_64; los `gpl` incluyen libx264 y libx265 (el reel de F2 los necesita); la variante `gpl` sin `shared` es la de ejecutables estáticos. Retención: "el último build de cada mes se conserva dos años" y los últimos 14 diarios: el de fin de agosto **caduca a fines de agosto de 2028** (INFERENCIA, 2 años desde la publicación); conviene copiarlo a un bucket propio si el proyecto va a vivir más.
- Debian trixie trae glibc 2.41 y bookworm 2.36 (INFERENCIA de memoria; ambas ≥ 2.28), y la CI corre el mismo archivo en Ubuntu 24.04 (glibc 2.39). **Sirve igual dentro de la imagen** salvo que algo falte en la imagen `slim`. Lo que hay que instalar para descomprimirlo es **`xz-utils`** (la imagen `slim` no suele traerlo: INFERENCIA) y `ca-certificates` y `curl` para bajarlo.
- Para `linux/arm64` (no se usa, D1 dejó fuera Oracle): `ffmpeg-n9.0.1-11-ge47273f4d9-linuxarm64-gpl-9.0.tar.xz`, `sha256:e2dd447c8a47849c5812d87e54a47b20ae0f3603d38989440f4a5fe1af8755b1`.

```dockerfile
ARG FFMPEG_URL=https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n9.0.1-11-ge47273f4d9-linux64-gpl-9.0.tar.xz
ARG FFMPEG_SHA256=182c1b509720e939bb47bfb47dc29cc0c298640401128e3dce8627d10707eb5a
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && curl -fsSL --retry 3 -o /tmp/ffmpeg.tar.xz "$FFMPEG_URL" \
 && echo "$FFMPEG_SHA256  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
 && mkdir -p /opt/ffmpeg && tar -xJf /tmp/ffmpeg.tar.xz -C /opt/ffmpeg --strip-components=1 \
 && rm /tmp/ffmpeg.tar.xz && rm -rf /var/lib/apt/lists/*
ENV PATH="/opt/ffmpeg/bin:${PATH}"
RUN ffmpeg -hide_banner -version | head -1 && ffprobe -hide_banner -version | head -1
```
- La CI nueva debe repetir la última línea al construir la imagen (también en `docker run … ffmpeg -version`) para cerrar el NO VERIFICADO de abajo. `ci.yml` y el `Dockerfile` repiten URL y sha256: un cambio de versión se hace en los dos.

### 14.6 Cómo probar sin riesgo (esta tanda)

Todo con `PUBLISH_MODE=dry-run`, una app de Fly desechable y sin credenciales de corredores. Lo corre el operador.

1. **App de prueba:** `fly apps create agentsales-prueba`, un `fly.toml` copia con ese nombre, secretos de una rama de Neon y un bucket aparte (sección 8, punto 3). Se destruye al terminar: `fly apps destroy agentsales-prueba`.
2. **Chequeo 503/lento:** con el worker apagado, detener el cómputo de Neon o apuntar a una base inexistente y ver (a) qué responde la URL pública con la máquina fuera del balanceo y (b) si `fly deploy` se detiene. Cierra "qué ve el cliente".
3. **Despliegue con el worker detenido:** `fly machine stop <worker>`, `fly deploy`, `fly machine list`: ¿volvió a `started`? Cierra la duda de 14.2.
4. **`release_command` fallido:** una migración que sale con código 1 en la app de prueba; comprobar que las máquinas siguen con la versión anterior.
5. **Certificado:** `fly certs add` con un subdominio de prueba y mirar qué registro pide Vercel y si un `CNAME` solo basta; `fly certs check`.
6. **Cabecera de IP:** la prueba de 14.4.
7. **Imagen:** `docker build` y `docker run --memory 1g`/`2g`, preparar un reel con Chromium a la vez, `docker stats` (cierra el pico de memoria de T10); `pg_dump --version`, `ffmpeg -version`, `pnpm -s cli doctor` dentro de la imagen.
8. **Token de despliegue:** crear uno con `-x` corto (`24h`) para probar `deploy.yml` y borrarlo; `fly tokens list`/`revoke` no se revisaron (NO VERIFICADO el nombre exacto).

### 14.7 Riesgos y términos relevantes

- **Cobro por intentos de despliegue:** el `release_command` crea una máquina temporal facturada por segundo (INFERENCIA, no leído).
- **El primer `fly deploy` crea máquinas por grupo:** sin `--ha=false` pueden ser dos API y dos workers (DOC: "una o dos por grupo"); dos workers sobre la misma cola duplican consumo de CPU y llamadas a Neon.
- **Constructor remoto:** la imagen con Chromium y PGDG se construye en servidores de Fly (no revisé límites de tiempo ni de tamaño del constructor ni del registro de Fly: NO VERIFICADO).
- **Digest fijado en `FROM`:** protege de cambios sorpresa, pero hay que mantenerlo (14.5).
- **El token de despliegue vive 20 años por defecto:** fijar `-x`.

### 14.8 NO VERIFICADO (esta tanda)

- Si hay un tope duro para `timeout`, `interval` y `grace_period` de los chequeos (la doc no da ninguno), y si Fly admite un `timeout` de 30 s.
- Qué respuesta ve el cliente cuando la única máquina de la API queda fuera del balanceo por un chequeo en rojo.
- Qué `Host` envía el chequeo por defecto (la doc solo dice que va por la red privada). El `Host` que fijamos es opcional: `GET /health` no pasa por `hostGuard` (`apps/api/src/security.ts`).
- Si un despliegue vuelve a encender un worker detenido (grupo sin servicio).
- Que el proxy no arranque nunca un grupo sin servicio.
- Si `fly machine stop` usa `kill_signal` y `kill_timeout` del `fly.toml`.
- Si un `CNAME` a `.fly.dev` basta para emitir el certificado, la forma exacta del destino único del `CNAME`, y la doc de Vercel DNS (CAA, registros).
- Que Fly Proxy sobrescriba un `Fly-Client-IP` enviado por el cliente.
- Que `--ha=false` deje una máquina por grupo; precio de `shared-cpu-1x` con 2 GB; tamaño del disco efímero; `/dev/shm` y procesos zombi en Fly.
- Qué columnas muestra `fly machine list` (grupo de procesos) y el nombre de la clave de metadatos del grupo.
- Cómo interpreta `fly secrets import` valores con varias líneas o comillas, y si `release_command` pasa por un shell.
- Qué más puede hacer un token de despliegue (certificados, secretos, `machine start/stop`).
- Que `VERSION_CODENAME` exista en la imagen `slim` y que la clave `.asc` armada funcionen en `node:26.12.0-trixie-slim` (la CI de T10 lo prueba), la huella de la clave de PGDG y el tamaño final de la imagen.
- Que el ffmpeg estático corra en `trixie-slim` sin librerías extra (la CI de T10 lo prueba con `ffmpeg -version`); la fecha en que BtbN borra el release (INFERENCIA: agosto de 2028).
- Fecha de paso de Node 26 a LTS (la página de versiones no la da).

### 14.9 Fuentes (consultadas el 2026-10-18)

Fly.io:

- `fly.toml` (`[processes]`, `[http_service]`, `[[http_service.checks]]`, `[[vm]]`, `swap_size_mb`, `kill_signal`, `kill_timeout`, `primary_region`, `[deploy]`, `[[restart]]`): https://docs.fly.io/reference/configuration
- Chequeos de salud y enrutamiento: https://docs.fly.io/reference/health-checks
- Despliegues sin corte (chequeos, `release_command`, estrategias): https://docs.fly.io/blueprints/seamless-deployments/
- Autostop y autostart: https://docs.fly.io/launch/autostop-autostart
- Desplegar (qué crea el primer despliegue, `release_command`, `--image`): https://docs.fly.io/launch/deploy/
- Escalar (`fly scale count`, destruir vs detener): https://docs.fly.io/apps/scale-count/ y https://docs.fly.io/flyctl/scale-count/ y https://docs.fly.io/launch/scale-count/
- Volver a una versión: https://docs.fly.io/blueprints/rollback-guide
- Tamaños de máquina: https://docs.fly.io/machines/guides-examples/machine-sizing/
- Precios (máquinas detenidas): https://docs.fly.io/about/pricing/
- Secretos: https://docs.fly.io/apps/secrets/
- Dominio propio y certificados: https://docs.fly.io/networking/custom-domain/
- IP públicas del servicio: https://docs.fly.io/networking/services/
- Dirección de escucha: https://docs.fly.io/networking/app-services/
- Cabeceras de la petición (`Fly-Client-IP`): https://docs.fly.io/networking/request-headers
- Cambio de flyctl 0.1.119 (máquinas detenidas en despliegues): https://community.fly.io/t/fly-deploy-changes-for-process-groups-and-auto-scaled-services/16368/1 (anuncio de Fly en el foro; oficial pero no es la doc)
- Comandos: https://docs.fly.io/flyctl/apps-create/ , https://docs.fly.io/flyctl/launch/ , https://docs.fly.io/flyctl/deploy/ , https://docs.fly.io/flyctl/secrets-set/ , https://docs.fly.io/flyctl/secrets-import/ , https://docs.fly.io/flyctl/certs-add/ , https://docs.fly.io/flyctl/tokens-create-deploy/ , https://docs.fly.io/flyctl/machine-stop/ , https://docs.fly.io/flyctl/machine-start/ , https://docs.fly.io/flyctl/machine-list/ , https://docs.fly.io/flyctl/releases/ , https://docs.fly.io/flyctl/logs/
- Última versión de flyctl: https://api.github.com/repos/superfly/flyctl/releases/latest
- Foros usados solo como pista (no oficial): lectura de `--ha=false` en https://community.fly.io/t/how-deploy-to-just-one-machine/12510 ; `Fly-Client-IP` y suplantación en https://community.fly.io/t/understanding-fly-client-ips-for-ip-blocking-in-nginx-reverse-proxy/27233

GitHub Actions:

- Repositorio y README: https://github.com/superfly/flyctl-actions
- Etiquetas y commits (API pública): https://api.github.com/repos/superfly/flyctl-actions/tags , https://api.github.com/repos/superfly/flyctl-actions/git/matching-refs/tags/ , https://api.github.com/repos/superfly/flyctl-actions/commits/ed8efb33836e8b2096c7fd3ba1c8afe303ebbff1 , https://api.github.com/repos/superfly/flyctl-actions/releases
- `action.yml` de `setup-flyctl` en ese commit: https://raw.githubusercontent.com/superfly/flyctl-actions/ed8efb33836e8b2096c7fd3ba1c8afe303ebbff1/setup-flyctl/action.yml

Imagen:

- Docker Hub, etiquetas de `node` (API pública): https://hub.docker.com/v2/repositories/library/node/tags/26.12.0-trixie-slim , https://hub.docker.com/v2/repositories/library/node/tags/26.12.0-bookworm-slim , https://hub.docker.com/v2/repositories/library/node/tags?page_size=100&name=26
- Node.js, versiones: https://nodejs.org/en/about/previous-releases
- Corepack (ya no se distribuye desde Node 25): https://github.com/nodejs/corepack#readme
- pnpm, instalación y compatibilidad con Node: https://pnpm.io/installation
- Playwright, requisitos: https://playwright.dev/docs/intro y https://raw.githubusercontent.com/microsoft/playwright/v1.63.0/docs/src/intro-js.md
- Playwright, dependencias por distribución en 1.63.0: https://raw.githubusercontent.com/microsoft/playwright/v1.63.0/packages/playwright-core/src/server/registry/nativeDeps.ts
- Playwright, navegadores y `PLAYWRIGHT_BROWSERS_PATH`: https://playwright.dev/docs/browsers ; Docker: https://playwright.dev/docs/docker
- PGDG: https://www.postgresql.org/download/linux/debian/ , https://wiki.postgresql.org/wiki/Apt , https://apt.postgresql.org/pub/repos/apt/dists/ , https://apt.postgresql.org/pub/repos/apt/dists/trixie-pgdg/Release , https://apt.postgresql.org/pub/repos/apt/dists/trixie-pgdg/main/binary-amd64/Packages , https://apt.postgresql.org/pub/repos/apt/dists/trixie-pgdg/main/binary-arm64/Packages , https://apt.postgresql.org/pub/repos/apt/pool/main/p/postgresql-18/
- ffmpeg (BtbN): https://github.com/BtbN/FFmpeg-Builds y https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/tags/autobuild-2026-08-31-13-27

Del repo (solo lectura, sin `.env`): `.github/workflows/ci.yml` (ffmpeg y Playwright), `apps/api/src/app.ts`, `apps/api/src/health.ts`, `apps/api/src/security.ts`, `packages/media/src/tools.ts`.

### 14.10 Preguntas para el operador

1. **Chequeo de Fly:** ¿se agrega al API una ruta de vida sin base para el chequeo de Fly (recomendado: evita sacar la máquina del balanceo cuando Neon despierta o se cae), o se deja `/api/health` con un `timeout` largo? Es un cambio de código fuera de esta nota.
2. **Fly con `--ha=false`:** ¿una máquina por proceso en la demo (recomendado), o dos para la API?
3. **Rollback:** ¿se etiqueta cada despliegue con `--image-label` (por ejemplo, el SHA corto del commit) para volver fácil?
4. **Vencimiento del token:** ¿6 meses (`4380h`) o más corto, con aviso en el calendario?
5. **Copia del ffmpeg:** BtbN conserva el build de fin de mes solo dos años; ¿se copia a un bucket propio ahora o se deja para cuando se acerque la fecha?
