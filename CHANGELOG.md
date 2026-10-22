# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versiones por fase (ver `docs/06-roadmap.md`).

## [Sin publicar]

## [1.4.0] - 2026-10-22 · F9.5 Lista para mostrar
**El panel queda presentable para la demo con la oficina del piloto.** Tiene un diseño propio y una portada que resume el día, habla como un corredor, muestra cómo se verá cada publicación antes de aprobarla y deja resolver «salió / no salió» también en Instagram y Portal. Los textos e ideas de la IA son más humanos y variados. Además se cerró la deuda interna de F9.

Probado contra simulaciones (CI en verde en cada PR, #217 a #230). **Nada se publicó de verdad.**

### Añadido
- **Sistema visual del panel** (T01): colores, letras, botones, insignias, tarjetas y tablas iguales en todas las pantallas, sin dependencias nuevas.
- **La portada «Hoy»** (T03): lo que te toca, lo próximo de 7 días y lo publicado en los últimos 7 días (lo simulado dice «simulación»). La salud del sistema pasa a **Estado** (`/estado`, solo el administrador).
- **Vista previa por red** (T07): Instagram (imagen, carrusel y reel), X, LinkedIn, Discord, TikTok, Portal y Marketplace, con el texto y las fotos tal como saldrán, y con tu borrador mientras editas. Avisa lo que la red rechazaría (un carrusel con una foto, TikTok sin video) y los medios que todavía se procesan.
- **«Salió / no salió» en Instagram y Portal** (T04a y T04b): un resultado dudoso queda «no se sabe si salió» (`outcome_unknown`), sin reintento solo, y se resuelve en la sección Contenido de la propiedad. En Portal en vivo, «salió» pide el enlace o el número `MLC…` y lee su estado en Mercado Libre; «no salió» pide confirmar que no quedaron avisos abiertos.
- **Retirar borrando en X** (T09): `publications retire <id> --delete` borra el post en X (solo en vivo). TikTok no tiene cómo borrar por API: el mensaje te dice que lo borres en la app.
- **Video para Discord que quepa** (T10): si el video no cabe en 20 MiB, se prepara una versión más liviana (hasta unos 4,6 minutos).
- **CLI y servidor de versiones distintas** (T11): la API dice su versión (`X-AgentSales-Version`) y la CLI avisa si difiere; un valor nuevo que la CLI no conoce se muestra tal como llega en vez de fallar.

### Cambiado
- **Textos que no suenan a IA** (T05): los prompts de avisos (`listing-content-v3`) y posts (`social-post-v2`) piden frases concretas, sin clichés ni muletillas; la revisión marca las muletillas como advertencia (`AI_TELL`) y `eval:content` y `eval:social` las cuentan.
- **El plan de ideas** (T06, ADR-0034): la IA propone ideas distintas y en orden de preferencia; el día, la hora y las redes los pone el código según la cadencia de cada red. Las parecidas se descartan (`IDEA_TOO_SIMILAR`) y las que no caben, con `NO_SLOT`. Sin cadencia, 1 idea por semana.
- **Lenguaje claro** (T02): estados y mensajes sin jerga; «simulación» solo cuando corresponde (D4); un post de una foto es «imagen», no «carrusel»; Publicar y Programar desaparecen cuando no queda nada por publicar.
- **De quién es una cuenta** (T12): una sola regla (`accountOwnedBy`); el detalle de un post muestra las redes de su marca aunque tengas otro corredor elegido.
- La versión del producto es la del `package.json` raíz (`1.4.0`).

### Corregido
- **X** (T08): el tope de gasto del mes ya no se puede pasar con dos publicaciones a la vez, y el video se sube por partes sin cargarlo entero en memoria.
- El panel del Mac responde también en `127.0.0.1` (lo que pide la vuelta de X).

### Límites conocidos
- Agregar Discord a un post después de subir su video no prepara la versión liviana: sube el video de nuevo.
- Un aviso de Portal republicado y resuelto «salió» se lee, pero se pausa, reactiva o cierra a mano en Mercado Libre (le faltan las fotos y el contacto guardados).
- La primera respuesta real de X al borrar (y si cobra) está sin verificar.

### Pendiente fuera del código
- **Desplegar `v1.4.0`** (tú) y la guía de la demo del 30: `docs/12-demo-oficina.md`.
- Medir con la IA real `eval:content` y `eval:social` (criterio 5 de la fase).

## [1.3.0] - 2026-10-20 · F9 Contenido de marca, entrega 3 (cierre de la fase)
**La IA propone qué publicar y cuándo; tú decides.** Pides un plan para las próximas semanas y la IA propone ideas con fecha, línea de contenido, redes y el porqué, a partir del perfil editorial de tu marca. Una idea no gasta IA en textos ni se publica sola: la aceptas (y recién ahí se redactan sus textos), la apruebas y la programas. Con esto F9 queda completa.

Probado contra simulaciones y en un ensayo de la demo en tu Mac (simulación, con la IA real y la marca AgentPey). **Nada se publicó de verdad:** la prueba en vivo de cada red (T24) queda para cuando hagas sus pruebas S1 a S6, y siempre con tu instrucción en el chat.

### Añadido
- **El plan de ideas:** `plan --broker <marca> [--days 14] [--count N] [--platform …]` y la página **Plan** del panel. Las ideas salen por semana, en los días y horas de la cadencia del perfil, sin repetir temas de los últimos 60 días ni ideas descartadas, y sin cifras ni nombres que no estén en tus hechos. `plan show <id>` y `plan list`.
- **Decidir cada idea:** `post accept <id> [--wait]` (pasa a borrador y la IA redacta sus textos **solo para las redes sugeridas**), `post discard <id>` (no vuelve en 60 días) y `post edit <id> --brief … --date … --platforms …` antes de aceptarla. En el panel: Aceptar, Editar, Descartar y «Redactar lo aceptado».
- **Las redes de un post mandan:** se redacta, aprueba, publica y programa solo en las redes del post; pedir a mano una red quitada se rechaza con su consejo, y quitar una red con publicaciones pendientes te pide cancelarlas primero.
- **`pnpm eval:social`:** evalúa el plan y los textos con tres marcas inventadas, sin escribir en la base (`--provider fake` no gasta). Cuenta ideas repetidas, datos fuera del perfil, largos, escapes y menciones masivas, e imprime el costo estimado (~US$ 0,12 con Sonnet por un plan de 10 ideas y sus textos en dos idiomas).
- **El enlace en X desde la CLI y el panel:** `post edit <id> --x-link | --no-x-link` y la casilla «Permitir un enlace en X» del post, con el aviso de su costo.
- **La lista de alta de una marca:** pide el perfil editorial (al menos una línea y un hecho) y una red para los posts, en vez de WhatsApp, Mercado Libre y Marketplace.

### Cambiado
- El panel ya no ofrece publicar ni programar en una red sin cuenta conectada: el botón queda desactivado con el motivo y un enlace a Cuentas. `post approve` te dice que conectes la cuenta primero.
- La revisión editorial ya no toma un mes o un día de la semana por un nombre propio cuando va con una fecha («Oct 9», «Mon, Oct 9»).
- En la lista de alta, el Instagram de un corredor lo conecta el propio corredor con el botón del servidor (ADR-0028); en tu Mac sigue siendo del administrador.

### Corregido
- `plan list --broker` y `listing ready|pause|resume|reopen|archive|close --broker` ya reciben la marca o el corredor.
- Aceptar una idea ya no sugiere `post draft` para esperar los textos (eso los redactaba dos veces): usa `post accept --wait` o `post show`.

### Documentación
- Todos los docs de la fase revisados contra el código (arquitectura, modelo de datos, plataformas, formato, checklist de cuentas, guía del operador, despliegue, visión y roadmap) y el seguimiento de los ADR que F9 modifica.
- **Volver atrás en el servidor:** el procedimiento deshace las migraciones `0015` a `0018` juntas, con una guarda y una prueba que hace el ida y vuelta (`docs/10-despliegue.md`, paso 9).

### Base de datos
- Migración `0018`: las redes de un post (`posts.platforms`) y un solo plan activo por marca. Solo agrega.

### Límites conocidos
- En **Instagram y en Portal (Mercado Libre)**, un resultado dudoso (la red no confirmó si publicó) queda como fallido y no como `outcome_unknown`: no se reintenta solo (no publica dos veces), pero tampoco se resuelve con «salió / no salió». Antes de reintentar, mira la red. En Discord, LinkedIn, X y TikTok sí se resuelve en un paso.

### Pendiente fuera del código
- **Variables nuevas en tu `.env` y en `.env.example`** (desde la entrega 2): `LINKEDIN_*`, `X_*` y `TIKTOK_*`, sin ellas no se conectan esas redes (`docs/07-checklist-cuentas.md`).
- **T24 en vivo:** por cada red, su prueba de entrada (S1 Instagram, S2 y S3 LinkedIn, S4 X, S5 Discord, S6 TikTok), después conectar la cuenta y publicar un post con tu instrucción en el chat (`docs/ESTADO.md`).
- **El perfil editorial real de tus marcas** en el servidor (`brand edit`): la IA solo afirma lo que escribas en sus hechos.
- **El costo real del plan:** `pnpm eval:social --provider anthropic-api --profile dos-idiomas --ideas 10 --out`, y anotarlo en `docs/integraciones/anthropic-api.md` §13.
- **Desplegar** F9 lo haces tú (`docs/10-despliegue.md`): aplica las migraciones `0014` a `0018` y después `pnpm db:seed --operator-brands` en el servidor.

## [1.2.0] - 2026-10-20 · F9 Contenido de marca, entrega 2
Tu contenido llega a **LinkedIn, X y TikTok**, y ya se maneja desde el **panel**: la pantalla Contenido para crear, redactar, aprobar y publicar posts, y un calendario con lo programado y lo publicado de posts y avisos. La IA que propone ideas llega en la entrega 3 (spec `docs/specs/fase-9-contenido-de-marca.md`).

Todo está probado contra simulaciones. **Nada se publicó de verdad:** antes de publicar en cada red van tus pruebas S1 (Instagram), S2 y S3 (LinkedIn), S4 (X), S5 (Discord) y S6 (TikTok), y siempre tu instrucción en el chat. El servidor sigue en `dry-run`.

### Añadido
- **LinkedIn (perfil personal):** se conecta con su OAuth (`accounts connect linkedin --broker <slug>` o el botón de Cuentas). La cuenta nace **a mano**: a la hora, AgentSales deja el texto listo y tú lo publicas y confirmas con el enlace. Con `accounts mode <id> api` (administrador) publica texto, hasta 20 imágenes o un video por la API. Un post de LinkedIn publicado por la API se puede retirar borrándolo: `publications retire <id> --delete` (pregunta antes; nunca en simulación).
- **X:** se conecta con OAuth y PKCE (`accounts connect x --broker <slug>` o el botón). Publica texto, imágenes o un video, anota el costo de cada post y respeta un **tope de gasto mensual** por cuenta (`accounts spend-limit <id> <dólares>`, US$10 por defecto). Un post con enlace pide tu marca explícita (cuesta US$0,20). El token se renueva solo.
- **TikTok:** se conecta con Login Kit (`accounts connect tiktok --broker <slug>` o el botón). El video sube como **borrador a tu bandeja** de TikTok; tú lo publicas en la app y confirmas con el enlace. El token se renueva solo.
- **Panel · Contenido:** lista de posts por marca y estado; editor con una pestaña por red e idioma, conteo de caracteres, vista previa y verificaciones; subir medios con avance; aprobar, programar y publicar; el perfil editorial de la marca; resolver un resultado dudoso y confirmar una publicación a mano.
- **Panel · Calendario:** vista semanal y mensual en hora de Chile, con posts y avisos juntos; mover una fecha usa el mismo programar de siempre (en vivo, con confirmación). Lo que falló o espera tu confirmación se resuelve en Seguimiento.
- **Panel · Cuentas:** botones para conectar LinkedIn, X y TikTok, el modo de cada cuenta (a mano o por la API) y el tope de X; Discord muestra el comando para conectarlo por la CLI (la URL del webhook nunca se pega en el panel).
- **Qué hacer ante cada error:** cada error de cada red tiene su consejo, en el panel y en la CLI (`publications`, `publish`, `post show`, `agenda`), con una prueba que falla si aparece un código sin consejo.
- **Guía del operador:** sección nueva para conectar las redes de los posts, las variables de `.env` de cada una, el modo a mano, resolver y confirmar, y los errores comunes (`docs/08-guia-operador.md`).

### Cambiado
- **Medios grandes:** sobre 100 MB el panel ya no calcula el sha256 en el navegador; lo calcula el worker al terminar la subida, y deduplica igual (ADR-0025).
- **`accounts`** lista las redes sin cuenta con el comando para conectar cada una.

### Base de datos
- Migraciones `0016` (la marca de enlace permitido en X por post) y `0017` (el estado `uploaded` de una subida grande). Solo agregan.

### Pendiente fuera del código
- **Variables nuevas en tu `.env` y en `.env.example`** (desde la entrega 2): `LINKEDIN_*`, `X_*` y `TIKTOK_*`, sin ellas no se conectan esas redes (`docs/07-checklist-cuentas.md`).
- **Variables nuevas en tu `.env`** (vacías hasta que crees cada app): `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI`, `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI`, `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI` (súmalas también a `.env.example`; detalle en `docs/08-guia-operador.md`).
- **S1 a S6:** obligatorias antes de cualquier publicación real en cada red (`docs/ESTADO.md`).
- **Desplegar** esta versión lo haces tú (`docs/10-despliegue.md`): primero el servidor y después usar la CLI nueva contra él.

## [1.1.0] - 2026-10-20 · F9 Contenido de marca, entrega 1
AgentSales ya no es solo para avisos: el contenido de tu marca personal y de AgentPey se crea, se redacta con IA por red e idioma, se aprueba, se programa y se publica con el mismo calendario, reintentos y seguimiento que los avisos. Esta primera entrega publica en **Instagram** y **Discord** y se maneja por la CLI; el panel, LinkedIn, X y TikTok llegan en la entrega 2, y la IA que propone ideas en la 3 (spec `docs/specs/fase-9-contenido-de-marca.md`, ADR-0029 y ADR-0030).

Todo está probado contra simulaciones. **Nada se publicó de verdad:** publicar en Instagram exige antes la prueba S1 y en Discord la S5, y siempre tu instrucción en el chat. El servidor sigue en `dry-run`.

### Añadido
- **Marcas:** `brokers create --kind brand` crea una marca (solo contenido, sin propiedades en el panel). `pnpm db:seed --operator-brands` crea las tuyas, `vinny` y `agentpey`, solo en tu instancia.
- **Perfil editorial de cada marca:** idiomas, público, líneas de contenido, **hechos que la IA puede afirmar**, cosas que evitar, cadencia por red y hashtags (`brand show|edit`, y en la API).
- **Posts:** `post create|list|show|upload|draft|edit|approve|publish|schedule|archive`. Los medios suben directo a R2 (con su sha256) y el worker arma las variantes (4:5, reel 9:16 y una variante de video para X).
- **Texto con IA por red e idioma:** la IA escribe un texto por red y por idioma con tu perfil y el brief que escribes tú. Antes de aprobar se revisa el largo de cada red, que no haya `@everyone`/`@here`, y que no aparezcan cifras, nombres ni enlaces que no estén en tu perfil o en tu brief. El gasto cuenta para el tope mensual de la marca.
- **Instagram para posts:** imagen, carrusel de 2 a 10 o reel, con la cuota diaria compartida con los avisos de la misma cuenta.
- **Discord:** se conecta con la URL del webhook de un canal (`pbpaste | pnpm -s cli accounts connect discord --broker <slug> --webhook-stdin`), que queda cifrada y nunca se imprime. Publica texto y hasta 10 archivos, siempre sin notificar a todo el canal.
- **Resultado dudoso:** si una red pudo haber publicado y no se sabe (un corte justo al enviar), la publicación queda en "resultado dudoso" y no se reintenta sola; la resuelves con `publications resolve <id> --published|--not-published`. Así nunca sale dos veces.
- **Publicar a mano por cuenta:** una cuenta en modo a mano (pensado para LinkedIn) nunca llama a la red; a la hora deja todo listo y tú confirmas con el enlace.
- **`publications retry <id>`:** reintenta o publica ya una publicación, de un aviso o de un post.
- **Agenda y seguimiento con posts:** avisos y posts juntos, más tres clases nuevas: resultado dudoso, tareas a mano fuera de Marketplace y cuentas por reconectar.
- **Una segunda instancia del mismo código, cuando llegue el primer cliente:** el despliegue acepta `-f instance=<instancia>` sin cambiar la de hoy (guía en `docs/10-despliegue.md`).

### Cambiado
- **Más rápido:** desde esta fase se trabaja con hasta tres ramas en paralelo, cada una con su agente, y la CI de GitHub como juez (`CLAUDE.md`, regla 2).
- **Credenciales por red:** cada red guarda lo suyo (Discord, la URL del webhook), y el redactor oculta en los logs las URLs de webhooks y los tokens `Bearer`.
- **El gasto de IA de la marca** suma los textos de avisos, los de posts y los planes.

### Base de datos
- Migraciones `0014` (plataformas nuevas, estado `outcome_unknown` y el tipo de corredor) y `0015` (posts, planes, subidas, perfil editorial y el sujeto aviso o post en textos, corridas, publicaciones y medios). Solo agregan: no cambian ninguna fila. Volver a una versión anterior después de crear posts exige revertirlas a mano (`docs/10-despliegue.md`).

### Pendiente fuera del código
- **Variables nuevas en tu `.env` y en `.env.example`** (desde la entrega 2): `LINKEDIN_*`, `X_*` y `TIKTOK_*`, sin ellas no se conectan esas redes (`docs/07-checklist-cuentas.md`).
- **S1 (Instagram) y S5 (Discord):** obligatorias antes de cualquier publicación real (`docs/ESTADO.md`).
- **Desplegar** esta versión en el servidor lo haces tú (`docs/10-despliegue.md`), y después `pnpm db:seed --operator-brands` con `ENV_FILE=.env.production` si quieres tus marcas ahí. Para que el calendario publique con el Mac apagado, el worker del servidor tiene que estar encendido.
- **Meta:** el App Review sigue sin enviar.


## [1.0.0] - 2026-10-19 · F8 En internet
Es el MVP completo. AgentSales ya está en internet, en `https://agentsales.agentpey.com`, en simulación (`dry-run`). El operador y los corredores entran al panel desde cualquier lugar, la CLI del Mac habla con el servidor, las cargas suben directo a R2, y el calendario y los respaldos corren en el servidor con el Mac dormido. Por ahora es un **servidor de demostración** en Fly.io (el worker se enciende solo los días en que se muestra la herramienta); dejarlo siempre encendido es cambiar el plan, no el código. La conexión de Instagram con el botón funciona con el inicio de sesión de Instagram de verdad; el App Review de Meta **no está enviado** y queda como trámite tuyo (cerraste la fase así el 2026-10-19).

Demo (2026-10-19, en el servidor, en simulación; todo con el Mac dormido o sin usarlo): la carga de una planilla y un zip desde el panel (directo a R2), Marketplace a mano, Portal en simulación e Instagram programado para las 11:55, que el worker del servidor publicó en simulación a las 11:55 exactas con el Mac dormido. También se probaron entrar con doble factor, conectar Instagram y Mercado Libre con el botón, las vueltas de Meta (quitar la app y borrar los datos) con Meta de verdad, la restauración de un respaldo en una base nueva, una preparación con textos por la API de Anthropic, un `import --dry-run` por la CLI contra el servidor y el cómputo de Neon suspendido con el worker apagado.

### Añadido
- **El servidor en internet:** una sola imagen (API, panel y worker) en Fly.io, región São Paulo, con HTTPS y certificado automáticos. La API sirve el panel desde el mismo dominio, con la API bajo `/api` también en tu Mac. Desplegar es cosa tuya, a pedido, desde `main` con la CI en verde (`gh workflow run deploy.yml --ref main`), y aplica las migraciones antes de arrancar. La guía está en `docs/10-despliegue.md` (secretos, dominio, encender y apagar el worker para una demo, logs, volver atrás y restaurar un respaldo).
- **Producción y desarrollo separados:** tu Mac usa una rama de Neon y un bucket de R2 propios, con otra clave de cifrado, así `pnpm dev` nunca toca lo real ni le quita trabajos al servidor. `pnpm db:dev-scrub` borra las credenciales copiadas a la rama. Los scripts que hablan con la base eligen su archivo con `ENV_FILE` (por ejemplo `ENV_FILE=.env.production pnpm auth:admin`).
- **Subidas directas a R2:** el panel y la CLI suben la planilla y los medios (zip o carpeta) directo al bucket con direcciones firmadas, con avance y reintento por archivo; ningún archivo pasa por la API. Tope de 50 MB para la planilla descomprimida. Se quitaron `POST /imports/local` y el disco compartido entre la API y el worker.
- **La CLI contra el servidor:** `login --api https://agentsales.agentpey.com` guarda la dirección con la sesión; `whoami` dice a qué servidor estás conectado, y `status` y `doctor` revisan el servidor (incluido el ambiente, el worker encendido o apagado, el respaldo y si el administrador tiene doble factor).
- **Respaldos fuera del Mac:** el worker del servidor vuelca la base cada día a un bucket de R2 aparte (`agentsales-backups`, con su propio token que solo tiene el worker), comprueba que el volcado se lee y deja los últimos 14. `/health`, `doctor` y la agenda muestran el último. `pnpm db:backup` sigue guardando en tu Mac, también contra producción (`ENV_FILE=.env.production`).
- **Entrar con más seguridad:** límites por IP al entrar, aceptar invitaciones y en toda la API (respuesta 429 con cuánto esperar); **doble factor opcional** con una app de códigos (clave y enlace `otpauth://` en **Mi cuenta**, 10 códigos de recuperación que se ven una vez; la CLI pide el código al entrar); cookie `__Host-` con `Secure` y cabeceras de seguridad. Restablecer el acceso de un usuario, o `pnpm auth:admin`, le quita el doble factor.
- **Instagram de verdad:** en **Cuentas**, el administrador conecta el Instagram de un corredor con el botón (inicio de sesión de Instagram en el dominio), y cada vuelta sirve una sola vez. Meta puede quitar la app (`/api/meta/deauthorize`) o pedir que se borren los datos (`/api/meta/data-deletion`, con una página de seguimiento por código): se verifica la firma, la cuenta queda desconectada y sin credenciales, y se borran sus datos de Instagram (sin cambiar el estado de las publicaciones; ADR-0027).
- **Mercado Libre con el botón:** "Conectar Mercado Libre" en **Cuentas**, con la vuelta automática en el dominio. El pegado de la dirección queda para desarrollo.
- **Páginas públicas, sin entrar:** términos de uso, política de privacidad e instrucciones para borrar los datos (`/legal/…`), enlazadas desde Entrar e Invitación; las aprobaste tú el 2026-10-19. Conviene que un abogado las revise por la Ley 21.719.
- **Para el revisor de Meta:** el corredor `demo-meta` y el usuario `revisor-meta@agentpey.com`.
- **El panel y `doctor`** muestran si el worker está encendido o apagado ("encendido desde…").

### Cambiado
- **Marketplace es a mano para todos en producción,** también para tus corredores (ADR-0023): el formulario automático solo corre en tu Mac, en desarrollo. Las cuentas de perfil que ya existían se muestran en el servidor como "activa Marketplace a mano".
- **La IA en producción es siempre la API de Anthropic** (los términos del plan Max no permiten usarlo en un servidor que atiende a terceros); la CLI de Claude queda para desarrollo. El servidor se niega a arrancar con otra cosa.
- **La API ya no tiene CORS:** el panel es del mismo origen y la CLI no es un navegador.
- **El servidor se niega a arrancar mal configurado** en producción: sin `PUBLIC_URL` con `https://`, con otra IA que la API, con respaldo que no sea a R2 o con perfiles de navegador.
- **`/health` sin sesión** sigue mostrando solo el estado, el modo y el ambiente; el chequeo de Fly usa `/api/health/live`, que no toca la base.
- **El build de producción no incluye tests** (`pnpm build`); el panel se compila con zod sin `eval` para cumplir la política de seguridad del navegador.

### Corregido
- **Una publicación automática cortada por un reinicio** del worker se retoma al arrancar, sin duplicar.
- **Pausar la propiedad** después de una pausa que aplicó Mercado Libre queda registrada como pausa de la propiedad, y reanudar la reactiva.
- **`tokens.refresh`** deja de empezar cuentas nuevas pasados 4 minutos y sigue en la siguiente corrida.
- **El `state` de Instagram** sirve una sola vez, y el inicio de los OAuth funciona aunque la API quede tras un prefijo.
- Si Meta rechaza el canje de Instagram, el log dice el motivo (en la primera puesta en marcha era la clave secreta equivocada).

### Pendiente fuera del código
- **Variables nuevas en tu `.env` y en `.env.example`** (desde la entrega 2): `LINKEDIN_*`, `X_*` y `TIKTOK_*`, sin ellas no se conectan esas redes (`docs/07-checklist-cuentas.md`).
- **Meta:** verificación del negocio, verificación como proveedor técnico y el envío del App Review de `instagram_business_basic` e `instagram_business_content_publish` (los textos, el ícono, la categoría y el correo ya están puestos). Mientras tanto, los corredores del piloto que publican en Instagram son evaluadores de la app.
- **Pruebas en vivo** de Portal (F4 y F6) y todo lo que publique de verdad: solo con tu instrucción en el chat. El servidor sigue en `dry-run`.

## [0.7.0] - 2026-10-17 · F7 Varios corredores
Ahora das de alta a un corredor de verdad (su marca, su logo, su planilla y su usuario), y él entra con su correo y su contraseña, ve solo lo suyo y hace casi todo por su cuenta: cargar, preparar, aprobar, publicar, programar y cerrar. Sus textos se redactan por la API de Anthropic con tu clave, con el gasto anotado por corredor y un tope mensual opcional; tus corredores siguen con tu plan de Claude. Todo sigue corriendo en tu Mac: llevarlo a internet es F8.

Demo (2026-10-18, en simulación): diste de alta a `corredor-demo` con su logo y su usuario; él entró en otra ventana, cargó dos propiedades con su planilla, las preparó por la API, vio su gasto, publicó Marketplace a mano, no vio nada de otro corredor y el tope frenó sus textos. Instagram quedó fuera de la demo (lo cubren las pruebas).

### Añadido
- **Entrar con usuario:** `pnpm auth:admin --email` crea tu administrador o te da un enlace nuevo si olvidaste la contraseña o te bloqueaste (al portapapeles, sin imprimirlo). En el panel, las páginas Entrar e Invitación, tu nombre y "Cerrar sesión"; en la CLI, `login`, `whoami` y `logout`. La sesión dura 30 días (7 sin uso), y 10 contraseñas equivocadas seguidas bloquean 15 minutos.
- **Usuarios** (solo tú): invitar con un enlace que se ve una vez y vence en 72 h, restablecer, desactivar y reactivar, en el detalle del corredor o con `users list|invite|reset|disable|enable` (el enlace va al portapapeles).
- **Cada corredor ve solo lo suyo:** propiedades, textos, publicaciones, cargas, cuentas, Seguimiento y agenda; lo ajeno responde "no existe". Tú ves todo y miras uno a la vez con "Ver corredor". El corredor carga, prepara, aprueba, publica, programa, cierra y edita su marca; conectar cuentas, la publicación automática, los topes y los usuarios son tuyos.
- **Alta de corredores:** la página **Corredores** (crear, marca, si es tuyo, tope de IA, logo, planilla, usuarios, gasto y la lista de pasos del alta) y **Mi marca** para el corredor; en la CLI, `brokers create|edit|show|logo|template`. El logo, en PNG, JPEG o WebP de hasta 5 MB; la planilla de Excel viene con la hoja Corredor llena.
- **La IA por la API para los corredores que no son tuyos,** con tu clave de Anthropic (Sonnet 5.5 por defecto). El gasto estimado del mes, en **Corredores**, **Mi marca** y `agentsales usage [--month]`. Con el tope mensual opcional, al llegar se frenan los textos y las imágenes se hacen igual. Para probar, `pnpm llm:smoke --provider anthropic-api` y `pnpm eval:content --provider anthropic-api --model <id>`.
- **Marketplace a mano:** "Activar Marketplace a mano" en **Cuentas** (o `accounts connect marketplace --broker <slug> --manual`). El sistema deja listos el texto, las fotos y el precio en pesos; el corredor publica él mismo y confirma con el enlace o "No lo publiqué". Sin límite diario y con varios avisos esperando a la vez.
- **La bitácora dice quién:** "Vinny (panel)" o "Vinny (CLI)".
- **`doctor` y `/health`** avisan si falta `ANTHROPIC_API_KEY` habiendo corredores que no son tuyos.

### Cambiado
- Todo pide sesión: la CLI pide `agentsales login` una vez.
- `/health` sin sesión muestra solo el estado y el modo; el detalle es para el administrador.
- La lista de propiedades ya no trae notas internas, dirección, unidad ni atributos (el detalle sí).
- El formulario automático de Marketplace queda solo para tus corredores propios; los corredores que ya existían quedaron como propios.
- El corredor edita su propia marca (`PATCH /brokers/:id`). Entre la hoja Corredor de la planilla y Mi marca, manda la última que se guarde.
- La carga de un corredor queda a su nombre desde la cola, y su planilla nunca crea otro corredor.
- Comparación de modelos (D15): en 5 propiedades de prueba, Sonnet 5.5 costó US$0,051 y Haiku 5.5 US$0,0026, pero en la prueba corta Haiku agregó un dato que no venía ("buena ubicación"). Sigue Sonnet.

### Corregido
- La dirección de vuelta de Mercado Libre sirve una sola vez (antes valía 10 minutos).
- Se retiró la cabecera `X-AgentSales-Client`, que cualquier proceso local podía mandar para hacerse pasar por la CLI.
- Seguimiento y agenda filtran por corredor en la base y piden los textos en una sola consulta (deuda de F6).
- El worker borra cada hora las sesiones vencidas y los enlaces de Mercado Libre vencidos.

## [0.6.0] - 2026-10-16 · F6 Calendario + seguimiento
Ahora dejas programadas las publicaciones de una o varias propiedades y salen solas a la hora mientras el worker está encendido; lo que falla por un límite pasajero de Instagram espera solo, y lo demás te dice en palabras simples qué hacer. Cuando una propiedad se vende o se arrienda, un solo botón cierra su aviso de Portal, descarta lo pendiente y te deja la lista de lo que tienes que borrar a mano. La página **Seguimiento** (y `agentsales agenda`) muestra lo que te toca hacer hoy, y la base se puede respaldar en tu equipo. La demo en simulación (16 de octubre) programó cinco propiedades en dos lotes (uno con 2 minutos entre propiedades), las vio salir solas de a una, desprogramó y reprogramó un reel, apagó todo mientras pasaba la hora y al encenderlo salieron las atrasadas; mostró "te toca" de Marketplace sin abrir Facebook, pausó, reanudó, marcó como arrendada y reabrió P002, y con la publicación automática P003 se aprobó y publicó sola en Instagram. Portal en simulación no se pudo mostrar (al corredor de pruebas le falta el WhatsApp) y quedó cubierto por las pruebas; el respaldo real espera que instales `libpq`.

### Añadido
- **Programar:** en cada publicación (Programar, Reprogramar, Desprogramar, Publicar ahora), en el canal ("Programar Instagram") y varias propiedades a la vez desde **Propiedades** (casillas, canales, hora y minutos entre una y otra, con el resultado de cada una), o `agentsales schedule <propiedades…> --at "2026-10-19 10:00" [--platform] [--spacing]` y `unschedule <id>`. La hora es de Chile (una hora que no existe por el cambio de horario se rechaza); en vivo pide confirmar.
- **El disparo:** cada minuto el worker empieza las programadas que vencieron, de a una, con el modo con que se programaron. Si estaba apagado, al encender salen las de 12 h o menos de atraso; las más viejas quedan "atrasadas" esperando tu decisión. Marketplace programado es un recordatorio: a la hora aparece "te toca" y nunca abre Facebook solo.
- **Espera ante los límites de Instagram:** la publicación queda programada para cuando se libere (hasta 3 veces); los demás fallos quedan "falló" con el motivo y **qué hacer**, en el panel, la CLI y la agenda.
- **Vigilancia de cada hora:** lee el estado de los avisos de Portal en vivo y vuelve a encolar lo que quedó publicando sin avanzar más de 70 min (salvo Marketplace).
- **La propiedad manda:** Pausar, Reanudar, Vendida, Arrendada, Retirada, Reabrir y Archivar en el detalle (o `agentsales listing pause|resume|reopen|archive` y `listing close --reason vendida|arrendada|retirada`). Cerrar cierra Portal, descarta lo pendiente y deja Instagram y Marketplace en vivo como **tareas a mano**; pausar y reanudar pausan y reactivan Portal.
- **Portal:** "Actualizar aviso" manda al aviso publicado el precio o los atributos nuevos de la planilla, o el texto nuevo aprobado (`publications update <id>`); "Republicar" vuelve a publicar uno vencido o cerrado conservando sus visitas (`publications relist <id>`); el panel y la agenda avisan 7 días antes del vencimiento.
- **Seguimiento:** página nueva en el menú con la agenda (atrasadas, te toca, atascadas, fallas con qué hacer, tareas a mano, lo que espera tu revisión, Portal por vencer, próximas y el respaldo) y cada propiedad por plataforma; se actualiza sola cada minuto mientras la miras. En la terminal, `agentsales agenda` (cada cosa con su comando) y `agentsales tracking`.
- **Publicación automática por corredor:** la casilla en **Cuentas** (o `agentsales brokers auto-publish <slug> on|off`): al preparar los textos se aprueba lo que no tiene errores y se publica solo en Instagram y Portal, y Marketplace queda como recordatorio. Con la API en vivo, el banner, `status` y `doctor` lo dicen en rojo.
- **Respaldo local:** `pnpm db:backup` y el worker (cada día a las 13:00 y al encender si el último tiene más de 20 h) guardan una copia de la base en `~/.agentsales/backups` (fuera del proyecto), comprobada con `pg_restore --list`; se guardan las últimas 14. `doctor` revisa `pg_dump`, y la guía explica cómo restaurar. Necesita el cliente de Postgres (`brew install libpq`).
- **La bitácora** de cada publicación muestra la hora programada y su motivo, la anterior y la nueva al reprogramar, lo que hizo la propiedad y lo que se mandó a Portal.

### Cambiado
- `PATCH /listings/:id/status` (los botones de F1) pasó a `POST /listings/:id/status` con la acción; el detalle de la propiedad tiene los botones nuevos.
- `publish` dice "en cola o esperando su turno": el worker publica de a una.
- El menú cambia "Publicaciones (F3)" por **Seguimiento**.

### Corregido
- Una publicación que quedaba en "publicando" sin job (el worker se cortó) ya no espera a que lo reinicies: la recoge la vigilancia de cada hora (deuda de F3).

## [0.5.0] - 2026-10-14 · F5 Facebook Marketplace
Ahora una propiedad en arriendo se publica en Facebook Marketplace **en dos tiempos**: el sistema abre tu perfil de Facebook en una ventana de Chromium, llena el formulario de "Nueva vivienda" con los datos del aviso y sus fotos, y te deja la ventana abierta; **tú haces Siguiente y Publicar**. El sistema reconoce el aviso recién publicado o recibe el enlace que pegas, y si no lo publicaste lo marcas así. Se probó en vivo, con tu instrucción, en tu cuenta: P002 (casa, La Reina), P004 (departamento, Providencia) y P005 (casa, Ñuñoa) se llenaron en Facebook de verdad, los revisaste y no se publicaron (D10); un cuarto intento el mismo día se negó por el límite. Antes, en simulación, se recorrió todo el flujo desde el panel y la CLI sin abrir Facebook.

### Añadido
- **Conectar tu Facebook:** `pnpm -s cli accounts connect marketplace --broker <slug>` o "Iniciar sesión en Facebook" en **Cuentas**. Se abre Chromium e inicias sesión a mano (también la verificación); la contraseña nunca la ve el sistema. La sesión vive en un perfil de navegador fuera del proyecto (`~/.agentsales/browser-profiles`) y desconectar lo borra.
- **Publicar en Marketplace:** "Publicar" en la pestaña Marketplace del panel o `agentsales publish <propiedad> --platform marketplace`. En vivo llena el tipo de propiedad, dormitorios, baños, precio al mes en pesos, la dirección (eligiendo la sugerencia del mapa), la descripción aprobada y la superficie (en pies cuadrados, como la pide el formulario), y sube las fotos. Nunca hace clic en Siguiente ni en Publicar.
- **Después de tu clic:** la ventana reconoce el aviso publicado y lo guarda con su enlace; si no, pegas el enlace ("Lo publiqué", o `pbpaste | pnpm -s cli publications confirm <id> --url-stdin`) o marcas "No lo publiqué" para reintentar o descartar. Mientras espera tu palabra, no se puede descartar, quitar la aprobación ni desconectar.
- **Lo que falta para Marketplace**, antes de enviar: fotos, tipo con opción en el formulario, precio, dormitorios, baños y comuna, en el panel, al aprobar y al publicar.
- **La UF en pesos:** un precio en UF se convierte con el valor oficial del día del Banco Central (API BDE, `BCCH_API_TOKEN`); el texto aprobado sigue en UF. `pnpm uf:smoke` lo comprueba.
- **Salvaguardas:** 3 intentos en vivo por cuenta y día, un formulario a la vez, una pausa fija entre campos, y ante un inicio de sesión, una verificación, un captcha, Marketplace no disponible o una pantalla rara, el sistema se detiene, cierra la ventana y lo dice.
- **Plan B** en el panel: copiar el título, la descripción y el precio, y abrir cada foto, para publicar a mano si el formulario cambia.
- **`pnpm fb:smoke`** (lo corres tú): `--broker <slug>` guarda el árbol del formulario sin llenar nada; `--menus` guarda además los menús que abres a mano; `--listing <propiedad>` llena el formulario real sin publicar (pregunta s/N, respeta el límite, no cambia nada en AgentSales); `--diagnostico` anota los errores técnicos de la página para investigar un fallo.
- **Documentación:** ADR-0017 (sesión en un perfil y publicación en dos tiempos), la nota de Marketplace con lo observado en el formulario real y la nota de la UF.

### Cambiado
- **Una propiedad en venta no va a Marketplace:** en Chile el formulario de viviendas es solo de arriendo (D15). Tampoco van oficinas, locales, terrenos, parcelas, bodegas ni estacionamientos: el formulario no tiene esos tipos.
- **La dirección en Marketplace** es la de la planilla, aunque `mostrar_direccion_exacta` sea No (tu decisión, D16). Esa columna sigue mandando en los textos, Instagram y Portal. Que Facebook muestre solo una ubicación aproximada está **sin verificar**: revísalo en el primer aviso real que publiques.

### Corregido
- **El diálogo «¡Uy! Se ha producido un error»** al terminar de llenar: Facebook sube las fotos unos segundos después de adjuntarlas y el sistema ya las había borrado del disco, así que no llegaban. Ahora van en memoria y se suben bien.
- La dirección elige bien la sugerencia del mapa aunque la lista se cierre al hacer clic (usa el teclado) y aunque la comuna venga con el código postal.

## [0.4.0] - 2026-10-09 · F4 Portal Inmobiliario
Ahora una propiedad aprobada se publica en Portal Inmobiliario (Mercado Libre): se conecta la cuenta de cada corredor, el sistema dice antes de enviar lo que le falta al aviso y, ya publicado, se pausa, reactiva, cierra y actualiza desde el panel o la CLI. F4 se cerró **con la simulación** (tu decisión, D15): la demo publicó P001 desde el panel y P002 desde la CLI en `dry-run`, que solo lee de Mercado Libre y le pregunta a `validate` sin crear nada (tu cuenta no tiene paquete, así que Mercado Libre respondió "sin cupo" y la simulación siguió con las revisiones de AgentSales, D14); pausar, reactivar y cerrar en simulación; y el acceso de VICENTEWOLDE se renovó con `--force` sin perder la cuenta. La prueba en vivo con un usuario de prueba de Mercado Libre queda para el inicio de F5, cuando soporte lo active.

### Añadido
- **Conectar Mercado Libre** sin túnel: `pnpm -s cli accounts connect mercadolibre --broker <slug>` abre el enlace; autorizas, copias la dirección que queda con error de conexión y la pegas con `pbpaste | … --url-stdin`. En **Cuentas** del panel, cada corredor muestra Instagram y Mercado Libre por separado, con los dos comandos para copiar.
- **Tokens que rotan:** el acceso de Mercado Libre se renueva solo cada 7 días mientras el worker corre (y a pedido con `accounts refresh <id> [--force]`), de a uno por cuenta con un candado; se guarda cifrado y nunca aparece en logs, errores ni respuestas. Con 4 meses sin renovarse, Mercado Libre lo da de baja.
- **Lo que falta para Portal**, antes de enviar: en la pestaña Portal del panel, al aprobar (`approve --platform portal`) y al publicar (`PORTAL_NOT_READY`), con un motivo por línea y su columna del Excel. Nunca se inventan datos: el WhatsApp es el de la hoja Corredor.
- **Publicar en Portal:** "Publicar en Portal Inmobiliario" o `agentsales publish <propiedad> --platform portal`. En vivo pide confirmación y avisa que usa un cupo. El aviso guarda su enlace, su estado en Mercado Libre ("procesando fotos", "activo", "pausado por Mercado Libre" con el motivo, "vencido") y su vencimiento.
- **Pausar, reactivar, cerrar y Actualizar:** botones en el panel y `agentsales publications pause|resume|close|sync <id>`. Cerrar en vivo pide confirmación (es irreversible: volver a publicar crea otro aviso y usa otro cupo). Si la API tarda más de la cuenta, no se repite solo: avisa que el cambio pudo aplicarse y cómo revisarlo.
- **Sincronización:** el worker lee el estado del aviso 2 min después de publicar, al arrancar y cuando pides Actualizar, y refleja una pausa, un cierre o un vencimiento hechos en Mercado Libre.
- **Reintentos que no crean dos avisos:** si algo se corta, el siguiente intento retoma lo que ya estaba en Mercado Libre (lo busca por su marca) en vez de crear otro.
- **`pnpm ml:smoke`** recorre el catálogo de Inmuebles y las ubicaciones de Chile y prueba `validate` sin publicar; con **`--listing P001`** arma el aviso real de una propiedad y solo pregunta si Mercado Libre lo aceptaría.
- **`pnpm ml:test-user --broker <slug>`** crea un usuario de prueba de Mercado Libre con tu cuenta real y deja su clave solo en tu portapapeles. El paso a paso (activación con soporte, paquete sin cargo, conectarlo) está en `docs/07-checklist-cuentas.md`.
- **Bitácora:** marca las lecturas de Mercado Libre y muestra las notas de cada intento (por ejemplo, "sin cupo").
- **Base de datos:** migración `0007` (catálogo de Mercado Libre con 7 días de vida, el estado en la plataforma y la versión del aviso fijada al aprobar), aplicada en Neon.
- **Documentación:** ADR-0015 (tokens que rotan, catálogo y operaciones) y ADR-0016 (la simulación de Portal valida contra Mercado Libre sin publicar), y la nota de Mercado Libre con lo verificado.

### Cambiado
- Lo aprobado para Portal incluye los datos del aviso: si una carga del Excel cambia la propiedad después de aprobar, publicar lo dice al instante en vez de enviar datos distintos.
- En Portal el formato se llama "aviso" (no "carrusel"), en el panel y la CLI.
- La forma de trabajar: las tareas relacionadas van en un solo PR (lotes), con un `pnpm check` y la CI de GitHub como simulación.

### Corregido
- Al cerrar o retirar la última publicación, el aviso de que la propiedad volvió a "Lista" ya no se pierde en el panel.

## [0.3.0] - 2026-10-07 · F3 Aprobación + Instagram
Ahora se aprueba el texto de cada canal y la propiedad se publica en Instagram: el carrusel y, si tiene video, el reel. Todo se prueba primero en simulación (`dry-run`), que registra lo que se habría enviado sin llamar a Instagram. Se probó en vivo, con tu instrucción, en tu cuenta @vicentewoldec: P002 salió como carrusel de 5 imágenes (en cerca de 1 minuto) y como reel (en cerca de 2), con sus enlaces guardados, y después se borraron a mano y se marcaron como retiradas. El 2026-10-07 el worker renovó el token al arrancar y el vencimiento pasó de estimado a real (6 de diciembre).

### Añadido
- **Conectar Instagram:** `pbpaste | pnpm -s cli accounts connect instagram --broker <slug> --token-stdin`, con el token del botón "Generate token" del panel de Meta (Meta no acepta `http://localhost` para el OAuth). El token se guarda cifrado y nunca aparece en logs, errores ni respuestas. El OAuth completo queda listo para F7, con HTTPS.
- **Página Cuentas** en el panel: la cuenta de cada corredor con su estado, vencimiento (avisa con 10 días), última renovación y permisos; desconectar, y el comando para conectar o reconectar. En la CLI, `agentsales accounts`.
- **Refresco del token:** el worker lo renueva al arrancar y todos los días a las 12:00 (hora de Chile), cuando han pasado 24 h desde el último refresco y le quedan 30 días o menos (con el token del panel, a las 24 h de conectarlo). Un token vencido deja la cuenta como vencida. A pedido: `agentsales accounts refresh <id> [--force]`.
- **Aprobar:** en la sección Contenido del panel ("Aprobar Instagram") o con `agentsales approve <propiedad> [--platform]`; `--undo` o "Quitar aprobación" la quitan. Al aprobar nacen las publicaciones (carrusel y reel) con el texto y las fotos fijos: mientras no salgan, no se puede preparar de nuevo ni editar ese texto.
- **Publicar:** el botón "Publicar en Instagram" del panel o `agentsales publish <propiedad>`. En vivo pide confirmación; espera el carrusel y el reel y muestra sus enlaces. En simulación queda marcada como tal y la propiedad no cambia; en vivo pasa a "Publicada".
- **Publicaciones:** estado, modo, intentos, enlace o error, y la bitácora de cada una (quién hizo qué y qué se envió: cantidad de fotos, largo del caption y la cuenta), en el panel y con `agentsales publications <propiedad> [--events]`. Descartar las que no salieron, reintentar las que fallaron y marcar como retiradas las que borraste a mano en Instagram (en vivo pide confirmar que la borraste); al retirar la última publicada, la propiedad vuelve a "Lista".
- **Reintentos que no publican dos veces:** si algo se corta a mitad de camino, el reintento retoma lo que ya estaba en Instagram en vez de crear otra publicación.
- **`pnpm ig:smoke`:** comprueba, sin publicar nada, que Instagram descarga una foto desde el enlace temporal de R2. Funcionó a la primera.
- **Base de datos:** migración `0006` (publicaciones por formato, con su progreso), aplicada en Neon.
- **Documentación:** ADR-0014 (se aprueba el texto; publicaciones por formato) y la nota de Instagram con lo verificado en la prueba real.

### Cambiado
- El modo (`dry-run` o `live`) lo decide cada publicación al pedirla, no el worker: algo pedido en simulación nunca sale de verdad.
- Las variables de Instagram se llaman `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` e `INSTAGRAM_REDIRECT_URI` (antes `META_*`). `doctor` avisa si faltan.
- Las credenciales se cifran con una clave derivada de `APP_ENCRYPTION_KEY`.

### Corregido
- Pedir textos y editar ya no se pueden cruzar: el candado por propiedad cerró la ventana que quedaba de F2.

## [0.2.0] - 2026-10-04 · F2 Contenido
Ahora cada propiedad lista puede prepararse para publicar: el sistema procesa sus fotos y videos para cada canal, arma la portada y la ficha del carrusel, el reel de Instagram, y la IA (tu CLI de Claude) redacta los textos de Instagram, Portal Inmobiliario y Marketplace, que se revisan solos contra los datos de la propiedad. Todo se ve y se edita en el panel. Se probó con las 3 propiedades de muestra: las tres quedaron con contenido listo para revisar, sin errores en la revisión. No se publica nada: las publicaciones llegan en F3.

### Añadido
- **Preparar contenido:** `pnpm -s cli prepare P001` o el botón "Preparar contenido" del panel. Muestra el avance por etapa (fotos y videos, portada y ficha, reel, textos) y termina con un resumen y la revisión de cada canal. "Rehacer imágenes" (`--no-texts`) no toca los textos. Repetirlo no vuelve a procesar ni a subir lo que no cambió, y si cambia el precio se rehacen solo la portada, la ficha y el reel. Si el worker no está corriendo, avisa a los 20 s.
- **Fotos para cada canal:** se rotan según el celular, pierden los metadatos (también la ubicación GPS) y salen en 4:5 para Instagram, 4:3 para Portal y Marketplace, y una miniatura. Las fotos HEIC del iPhone funcionan, y en el panel ya se ven. Una foto chica o un archivo dañado queda como advertencia, sin detener la preparación.
- **Portada y ficha:** la portada lleva la foto de portada, el precio, el tipo, la comuna y los datos clave con íconos, con los colores y el logo del corredor; la ficha resume los atributos y el contacto. Nunca muestran la dirección exacta.
- **Reel de Instagram:** con el primer video de la propiedad, en vertical (1080×1920) con fondo desenfocado si el video no lo es, el texto de la propiedad los primeros 2 s y un tope de 90 s. Un video de menos de 3 s no da reel.
- **Textos con IA:** la IA solo redacta frases; el precio, las superficies, el título de Portal y el contacto los pone el sistema, así no se inventan datos. La IA nunca ve la dirección oculta, las notas internas ni el contacto. Con `LLM_PROVIDER=fake` se prueba todo sin gastar cuota.
- **Revisión editorial:** cada texto se revisa contra los datos: números o servicios que no están, la dirección o la unidad cuando no se pueden mostrar, notas internas copiadas, requisitos discriminatorios, emojis en Portal, largos (2.200 caracteres del caption con hashtags; 60 del título) y superlativos o markdown. Los errores se ven en rojo y las advertencias en ámbar.
- **Vista previa y edición en el panel:** la sección Contenido del detalle muestra el carrusel deslizable, el caption con "ver más" y el reel de Instagram, y el título, la descripción y las fotos de Portal y Marketplace. "Editar" cambia el texto de cada canal con un contador de caracteres; al guardar queda "editado a mano" y la revisión se actualiza. Regenerar textos sobre una edición pide confirmación ("se reemplazará tu edición"), y mientras se regeneran no se puede editar.
- **CLI:** `agentsales prepare` y `agentsales content` (los textos por canal con su revisión, `--platform portal`, `--json`).
- **Evaluar los textos de la IA:** `pnpm eval:content` prueba la redacción sobre las propiedades listas sin guardar nada, muestra la revisión por canal, deja los textos en `tmp/eval/` y termina con error si hay alguno. Ctrl+C corta también la llamada en curso.
- **Mínimos y máximos:** los campos numéricos del Excel tienen rangos (por ejemplo, dormitorios de 0 a 50); un valor fuera de rango es un error de esa fila.
- **`doctor`:** revisa ffmpeg y ffprobe 8.1 o más nuevos, el Chromium de Playwright y la sesión de la CLI de Claude (sin gastar cuota).
- **Base de datos:** migraciones `0003` (rangos), `0004` (corridas y textos) y `0005` (variantes de medios), aplicadas en Neon.
- **Documentación:** ADR-0012 (sin publicaciones hasta F3) y ADR-0013 (textos híbridos y prompts en core).

### Cambiado
- La lista y el detalle de propiedades usan miniaturas: las portadas HEIC se ven en el navegador.
- El worker se apaga en orden: corta los trabajos en curso (también la CLI de Claude, que corre aparte y no recibe el Ctrl+C), espera a que paren y después cierra el navegador que dibuja las portadas.
- La CLI y el panel esperan cargas y preparaciones con las mismas reglas (cada 2 s, aviso a los 20 s, tope de 2 h y de 3 fallas seguidas).
- El README pide ffmpeg 8.1 con ffprobe, el Chromium de Playwright y la CLI de Claude, y explica cómo instalarlos.

### Corregido
- La revisión ya no marca como copia de las notas internas un trozo que solo coincide con la dirección web del aviso en las notas, ni dos frases públicas que juntas forman las mismas palabras (pasó con P003 en la evaluación).
- Una preparación cortada al apagar el worker en su último intento ya no deja la propiedad bloqueada: pedirla de nuevo la retoma.

## [0.1.0] - 2026-10-02 · F1 Carga
Ahora se cargan propiedades desde un Excel con sus fotos y videos, por la CLI o el panel, y quedan guardadas en Neon y R2, listas para F2. Se probó de punta a punta con 3 propiedades reales de muestra: crear, repetir sin duplicar, cambiar un precio, una fila con errores, verlas en el panel e importar desde el navegador. No se publica nada.

### Añadido
- **Importar desde el panel:** la sección Importar sube el Excel y un zip de fotos (con el corredor elegido de una lista, o el de la hoja Corredor) y deja simular sin guardar. La página de la carga muestra el avance, avisa si a los 20 s sigue en cola ("¿está corriendo el worker?") y al terminar muestra cuántas propiedades se crearon, actualizaron o fallaron, la tabla de errores por fila y columna, las fotos subidas y las advertencias, con enlace a cada propiedad. Debajo del formulario está el historial de cargas. Al terminar, Propiedades muestra lo nuevo de inmediato.
- **Panel de propiedades:** la sección Propiedades muestra cada propiedad con su foto de portada, operación, tipo, comuna, precio en formato chileno (`UF 5.800`, `$650.000/mes`) y estado, con filtros por estado, operación y comuna que quedan en la dirección de la página. El detalle muestra la galería de fotos y videos, los datos (la dirección avisa si no se publica), los atributos con su nombre legible y botones para marcarla lista, pausarla o archivarla. Si la API no responde, el panel lo dice y ofrece reintentar. La CLI (`listing`) también muestra los atributos con su nombre.
- **CLI de importación y consulta:** `pnpm -s cli import propiedades.xlsx --media medios` carga el Excel con sus fotos (carpeta o .zip), espera al worker y muestra el resumen con una tabla de errores por fila y columna. Avisa si la carga sigue en cola a los 20 s (¿está corriendo el worker?), y `--dry-run` simula sin guardar. `imports` muestra el historial o el reporte de una carga, `listings` lista las propiedades con el precio en formato chileno (`UF 5.800`, `$650.000`) y `listing P-001` muestra el detalle; si el código está en dos corredores, pide `--broker`. Los errores se ven como `CÓDIGO: mensaje` con una sugerencia, sin trazas técnicas.
- **API de importación:** el panel puede subir el Excel y un zip de medios, y la CLI importar archivos de tu disco (solo en desarrollo). La carga queda en cola para el worker y responde de inmediato. Se puede ver la lista de cargas y el reporte de cada una, sin exponer las rutas de tus archivos. Una subida demasiado grande, un Excel de más de 10 MB o una cola caída se informan con un error claro.
- **API de propiedades:** la API lista las propiedades con filtros (estado, operación, comuna) y su foto de portada, muestra el detalle con todas sus fotos y videos, deja cambiar el estado a mano (lista, pausada, archivada; "lista" necesita al menos una foto) y lista los corredores. Una petición mal formada responde un error claro.
- **Importación en el worker:** una carga pedida queda "en cola" y el worker la corre completa (Excel, propiedades, fotos y logo) hasta dejarla "terminada" o "fallida" con su motivo. Si R2 o Neon fallan, se reintenta dos veces sin duplicar nada; una carga terminada nunca se vuelve a procesar. Un zip comprimido desde la carpeta "medios" en macOS también funciona. Los archivos temporales se limpian solos.
- **Cola de trabajos compartida:** la API y los scripts ya pueden encolar trabajos para el worker (`packages/queue`). Si la cola no está disponible (por ejemplo, el worker nunca arrancó), se informa `QUEUE_UNAVAILABLE` con un mensaje claro, y la API puede arrancar igual. `pnpm worker:ping` usa este mismo camino.
- **Campos configurables:** las 36 columnas de la plantilla Excel quedan como definiciones de campo globales de `real_estate` (`pnpm db:seed`, idempotente).
- **Migración `0001`:** estado de las cargas (`import_runs.status`) y únicos que evitan campos o medios duplicados (`pnpm db:migrate`).
- **Ingesta de medios (base de datos y R2):** los medios se registran en Neon sin duplicarse aunque dos intentos de la carga se crucen, cada propiedad tiene una sola portada y el logo solo puede ser un archivo del propio corredor. Al subir, R2 comprueba que el archivo llegó idéntico al que se leyó (sha256) y lo rechaza si cambió; `pnpm storage:check` lo prueba.
- **Ingesta de medios (lógica):** las fotos y videos de cada propiedad se suben a R2 y se registran, sin repetir los que ya estaban (aunque se reimporte el mismo Excel). Se ordenan por nombre, la portada sale de `foto_portada` o es la primera foto, y una propiedad con `estado_carga = Listo` y al menos una foto pasa a `ready`; sin fotos, queda en borrador con aviso. También se sube el logo del corredor (`_marca/`). Un archivo o una carpeta con problemas queda como advertencia en el reporte, sin detener la carga.
- **Lectura de medios:** las fotos (jpg, png, webp, heic) y los videos (mp4, mov) de cada carpeta se leen en orden natural (`foto2` antes de `foto10`), y se comprueba que el contenido corresponda a la extensión. Los archivos rechazados quedan anotados con su motivo. Un .zip se descomprime de forma segura: rechaza rutas que salen de la carpeta y zips de más de 2000 archivos o 4 GB.
- **Subida de videos grandes:** los archivos se suben a R2 en streaming, sin cargarlos completos en memoria. `pnpm storage:check` lo prueba.
- **Importación de propiedades (base de datos):** corredores, avisos y cargas se guardan en Neon. La importación completa se probó contra Postgres: reimportar no duplica y cambiar un precio lo actualiza. Migración `0002` (`pnpm db:migrate`).
- **Importación de propiedades (lógica):** cada fila queda como creada, actualizada, sin cambios, con error o ignorada (EJEMPLO y Borrador), con un reporte por fila y columna. Reimportar el mismo Excel no duplica nada ni cambia el estado puesto a mano. La hoja Corredor crea o actualiza el corredor; también se puede usar uno existente.
- **Lectura del Excel:** se leen las hojas Propiedades y Corredor de la plantilla, incluidas las celdas con fórmulas, links o formato, y también archivos pasados por Google Sheets. Los errores del archivo (no es un Excel, falta la hoja, pesa más de 10 MB) se informan con un mensaje claro.
- **Plantilla:** `carpeta_medios` pasa a ser opcional; si se deja vacía, se usa `id_propiedad`.
- **Validación de filas:** cada fila del Excel se valida contra las definiciones de campo. Los errores indican columna y motivo, sin detener las demás filas; números como `5.800`, `Sí/No`, listas y opciones se aceptan con o sin mayúsculas y tildes. `publicar_en` solo acepta Instagram, Portal Inmobiliario y Marketplace.
- **Errores de base de datos:** si Neon no responde, se informa `DB_UNAVAILABLE` (reintentable) en vez de un error genérico.
- **Documentación:** ADR-0011 (dónde viven los contratos HTTP que comparten la API, la CLI y el panel) y enmienda de ADR-0005 (la importación corre como trabajo del worker, `import.run`).

### Corregido
- La fecha de última modificación de una propiedad la pone la base de datos, así el orden "más recientes primero" no se cruza cuando dos cambios ocurren en el mismo milisegundo.

## [0.0.1] - 2026-09-30 · F0 Fundaciones
### Añadido
- **Monorepo:** pnpm con Node 26, TypeScript 7, Biome y Vitest. `pnpm check` revisa lint, tipos y tests.
- **Base de datos:** Neon con el esquema completo (9 tablas) y un corredor `demo` (`pnpm db:migrate`, `pnpm db:seed`).
- **Almacenamiento:** archivos en Cloudflare R2 (bucket privado, URLs prefirmadas) y `pnpm storage:check`.
- **API local:** `GET /health` informa base de datos, almacenamiento, cola y `PUBLISH_MODE`. Solo acepta peticiones locales.
- **Worker:** cola de trabajos (pg-boss), job de prueba (`pnpm worker:ping`) y apagado ordenado.
- **CLI `agentsales`:** `doctor` revisa el entorno y sugiere arreglos; `status` muestra la salud y el modo de publicación.
- **Panel web** (http://localhost:5173): banner permanente de `PUBLISH_MODE` y página "Estado del sistema", que se actualiza sola.
- **`pnpm dev`:** levanta API, worker y panel juntos.
- **CI en GitHub Actions:** lint, tipos, tests, migraciones al día y build del panel. `main` exige el check en verde.
- **Documentación:**
  - visión, arquitectura, modelo de datos, plataformas, formato, convenciones, roadmap y checklist de cuentas;
  - guía de alta de Neon y R2;
  - ADRs 0001–0010;
  - specs F0 y F1 (borrador);
  - plantilla Excel y configuración de Claude Code.

### Cambiado
- Proyecto renombrado a **AgentSales**: paquetes `@agentsales/*`, CLI `agentsales` y bucket `agentsales-media`.
- Supabase reemplazado por Neon + Cloudflare R2 (ADR-0007).
- Runtime Node 26 (ADR-0008) y TypeScript 7 (ADR-0009).
- El repositorio pasa a ser público, con protección de la rama `main`.

### Corregido
- Sin conexión a internet, el worker ya no inunda la terminal: registra el primer error, un resumen cada 30 s y un aviso cuando la conexión vuelve.

### Seguridad
- `PUBLISH_MODE=dry-run` por defecto.
- Los logs ocultan tokens, claves y credenciales de URLs.
- La conexión a la base usa TLS verificado (`verify-full`).
- `.env` se valida al arrancar, sin mostrar valores.
- La API solo acepta Host locales y aplica CSRF.
