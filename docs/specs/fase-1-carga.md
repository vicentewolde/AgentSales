# Spec F1 · Carga de propiedades y medios

- **Estado:** Borrador (revisar y aprobar con `/fase-plan 1` al terminar F0)
- **Rama base:** `main`
- **Tag al cerrar:** `v0.1.0`
- **Referencias:** `docs/02-modelo-datos.md`, `docs/04-formato-publicaciones.md`, ADR 0006, `data/plantillas/plantilla_propiedades.xlsx`

## 1. Objetivo
El operador carga un Excel con propiedades y una carpeta de fotos y videos, y las ve ordenadas en el panel y la CLI, listas para generar contenido en F2.

## 2. Alcance
- Definiciones de campos globales para `real_estate`, sembradas desde la plantilla.
- Validador dinámico construido desde `field_definitions`.
- Lectura del Excel (hojas **Propiedades** y **Corredor**).
- Importación idempotente con reporte por fila.
- Ingesta de medios desde carpetas locales o desde un .zip, subidos a Cloudflare R2.
- API, CLI y panel para importar y ver propiedades.

## 3. Fuera de alcance
- Google Sheets y carpetas de Google Drive (F1b, opcional; se decide al cerrar F1).
- Procesamiento de medios (recortes, variantes): F2.
- Edición manual de propiedades en el panel (solo lectura en F1, salvo cambiar `status`).

## 4. Diseño

### 4.1 Componentes
- **Nuevo** `packages/importers`: `xlsx-reader`, `media-folder`, `zip`.
- **core:** casos de uso `importListings`, `ingestMedia`, `buildListingValidator(fieldDefs)`; puertos `ListingRepository` y `FieldDefinitionRepository`. `MediaStorage` ya existe desde F0-T04 (archivos completos en memoria); F1-T04 lo amplía con streams para videos de hasta `MAX_VIDEO_MB` (por ejemplo `put` con `AsyncIterable<Uint8Array>` y `contentLength`, y `getStream`), y decide si hace falta `@aws-sdk/lib-storage` (dependencia nueva: justificarla en el PR).
- **db:** implementaciones de los repositorios; seed de `field_definitions`. Migración `0001` (no se edita `0000_init`, ya aplicada): `UNIQUE NULLS NOT DISTINCT (broker_id, category, key)` en `field_definitions` (destino del upsert del seed y garantía de "el corredor sobrescribe la global"), y en `media` un único parcial `(listing_id, checksum) WHERE role = 'original'` más `UNIQUE (storage_path)`.
- **api:** endpoints de importación y listings.
- **cli:** comandos `import`, `listings` y `listing`.
- **web:** páginas Propiedades, Detalle e Importar.

### 4.2 Reglas de importación
- Se ignoran la fila con `id_propiedad = EJEMPLO` y las filas con `estado_carga = Borrador`.
- Normalización:
  - `Sí/No` → boolean.
  - Números con puntos o espacios → number (`5.800` → 5800).
  - Trim de textos.
  - Listas separadas por coma → arrays.
- Validación por fila contra las definiciones: tipos, obligatorios y opciones de enum. Los errores se acumulan; nunca se detiene la carga completa.
- Upsert por `(broker_id, external_ref)`. Si `source_hash` no cambió → `skipped`; si cambió → `updated`.
- La hoja **Corredor** crea o actualiza el broker (por `slug` derivado de `nombre_marca`, o `--broker` explícito).
- Columnas desconocidas: se reportan como advertencia y se guardan en `attributes._extra`, para no perder datos.

### 4.3 Reglas de medios
- Carpeta por propiedad: `<mediaDir>/<id_propiedad>/`. Logo en `<mediaDir>/_marca/logo.png`.
- Tipos aceptados: jpg, jpeg, png, webp, heic (convertido a jpg en F2), mp4, mov. Otros → advertencia.
- Orden: por nombre de archivo (orden natural: `2` antes de `10`).
- Portada: `foto_portada` si existe; si no, la primera. En F2 la IA puede sugerir otra.
- Deduplicación por sha256: si el mismo archivo ya existe para esa propiedad, no se vuelve a subir.
- Metadatos: ancho y alto (sharp), duración (ffprobe).
- Clave del objeto en R2: `brokers/{brokerId}/listings/{listingId}/original/{sha256}.{ext}`.
- Una propiedad sin ninguna foto queda con estado `draft` y advertencia (mínimo 1 foto para `ready`).

### 4.4 Contratos
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/imports` | multipart `file` (xlsx) + `media` (zip, opcional) + `broker` (opcional) + `dryRun` → `ImportRun` |
| POST | `/imports/local` | `{ xlsxPath, mediaDir?, broker?, dryRun? }` (solo cuando `NODE_ENV=development`) |
| GET | `/imports` · `/imports/:id` | historial y reporte |
| GET | `/listings?status=&operation=&comuna=&q=` | lista con portada (URL firmada) |
| GET | `/listings/:id` | detalle con medios y atributos |
| PATCH | `/listings/:id/status` | cambio de estado manual (`ready`, `paused`, `archived`) |
| GET | `/brokers` · `/brokers/:id` | |

CLI:
```
agentsales import <xlsx> [--media <dir|zip>] [--broker <slug>] [--dry-run]
agentsales listings [--status ready] [--json]
agentsales listing <external_ref|id> [--json]
agentsales imports [<id>]
```

### 4.5 Datos
- Seed de `field_definitions` globales (`category = real_estate`) con las 36 columnas de la plantilla (`key`, `label`, `type`, `required`, `options`, `source_column`, `is_core`).
- Sin cambios de esquema esperados; si aparecen, migración nueva y actualización de `02-modelo-datos.md`.

## 5. Tareas

### F1-T01 · Definiciones de campos y validador dinámico
- **Depende de:** F0
- **Descripción:** seed de `field_definitions` desde la plantilla, y `buildListingValidator(defs)` en core que devuelve un esquema zod y un normalizador. Mapeo `is_core` → columnas de `listings`; el resto → `attributes`.
- **Hecho cuando:**
  - [ ] Tests: fila válida, obligatorio faltante, enum inválido, número con puntos
  - [ ] Test que prueba que un campo agregado solo en la base de datos se valida sin cambiar código

### F1-T02 · Lector de Excel
- **Depende de:** T01
- **Descripción:** `packages/importers/xlsx-reader` con exceljs; lee Propiedades y Corredor, aplica las reglas de §4.2 excepto el upsert, y devuelve `{ broker, rows: [{ rowNumber, data, errors, warnings }] }`.
- **Hecho cuando:**
  - [ ] Fixtures: plantilla válida, con errores y con columnas extra; tests para cada una

### F1-T03 · Caso de uso importListings
- **Depende de:** T02
- **Descripción:** orquesta lectura → validación → upsert de broker y listings → `import_run` con reporte. Admite `dryRun`, que valida y reporta sin escribir.
- **Hecho cuando:**
  - [ ] Test de idempotencia (dos importaciones: la segunda dice `skipped`)
  - [ ] Test de actualización (cambia el precio → `updated`)

### F1-T04 · Ingesta de medios
- **Depende de:** T03
- **Descripción:** `media-folder` y `zip` (descomprime a un directorio temporal), caso de uso `ingestMedia` según §4.3, usando `packages/storage` (Cloudflare R2: subir, leer y generar URL prefirmada) como implementación de `MediaStorage`; cada archivo se sube con su `Content-Type` correcto.
- **Hecho cuando:**
  - [ ] Tests con carpeta fixture (3 fotos + 1 video + 1 archivo inválido)
  - [ ] Reimportar no vuelve a subir archivos (verificado por checksum)

### F1-T05 · API de importación y listings
- **Depende de:** T04
- **Descripción:** endpoints de §4.4 con validación zod de entrada y salida.
- **Hecho cuando:**
  - [ ] Tests de endpoints con repositorios en memoria

### F1-T06 · CLI de importación y consulta
- **Depende de:** T05
- **Descripción:** comandos de §4.4. `import` muestra un resumen (creadas, actualizadas, omitidas, con error) y la tabla de errores por fila y columna.
- **Hecho cuando:**
  - [ ] `pnpm cli import data/muestras/propiedades.xlsx --media data/muestras/medios` funciona con las 3 propiedades reales de muestra

### F1-T07 · Panel: Propiedades, Detalle e Importar
- **Depende de:** T05
- **Descripción:**
  - **Propiedades:** grilla con portada, operación, tipo, comuna, precio formateado y estado; filtros.
  - **Detalle:** galería, atributos y cambio de estado.
  - **Importar:** subir xlsx y zip, y ver el reporte.
- **Hecho cuando:**
  - [ ] Flujo completo desde el navegador con los archivos de muestra

### F1-T08 · Cierre de fase
- **Depende de:** todas
- **Descripción:** `/fase-cerrar 1`.

## 6. Criterios de aceptación de la fase
- [ ] Ver `docs/06-roadmap.md#f1--carga`
- [ ] Las 3 propiedades de muestra del operador se ven correctamente en el panel

## 7. Plan de demo
1. `pnpm cli import data/muestras/propiedades.xlsx --media data/muestras/medios`
2. Repetir el comando → todo `skipped`
3. Cambiar un precio en el Excel → reimportar → 1 `updated`
4. Agregar una fila con errores → aparece en el reporte y no bloquea las demás
5. Abrir el panel → Propiedades → detalle con galería

## 8. Riesgos y mitigaciones
| Riesgo | Mitigación |
|---|---|
| Excel editado en Google Sheets cambia tipos (fechas, números como texto) | Normalizador tolerante y tests con archivo exportado desde Sheets |
| Fotos HEIC desde iPhone | Se aceptan en F1 y se convierten en F2 (sharp con libheif, o fallback a ffmpeg) |
| Archivos grandes de video | Límite configurable (`MAX_VIDEO_MB`, default 300) con advertencia; R2 no limita el tamaño por archivo, pero el plan gratis incluye 10 GB en total |

## 9. Preguntas abiertas
- [ ] ¿Google Sheets y Drive son necesarios antes de F3, o basta con Excel y zip durante el piloto?

## 10. Registro de cambios del spec
| Fecha | Cambio |
|---|---|
| 2026-09-28 | Borrador inicial |
| 2026-09-29 | Almacenamiento en Cloudflare R2 en vez de Supabase (ADR-0007); `MAX_VIDEO_MB` vuelve a 300 |
| 2026-09-29 | Desde la revisión de F0-T04: `MediaStorage` ya existe y F1-T04 lo amplía con streams; migración `0001` con únicos de `field_definitions` y `media` |
