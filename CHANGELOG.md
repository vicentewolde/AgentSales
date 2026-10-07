# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versiones por fase (ver `docs/06-roadmap.md`).

## [Sin publicar]

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
