# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versiones por fase (ver `docs/06-roadmap.md`).

## [Sin publicar]
### Añadido
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

### Arreglado
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
