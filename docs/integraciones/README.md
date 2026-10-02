# Notas de integración

Aquí el subagente `integraciones` deja una nota verificada por tema o plataforma, con fuentes oficiales y fecha de consulta. Se crean antes de planificar la fase que usa cada integración. Cada nota distingue **DOC** (documentación oficial), **INFERENCIA** y **NO VERIFICADO**.

| Nota | Tema | Fase | Estado | Verificada |
|---|---|---|---|---|
| [`r2-checksums.md`](r2-checksums.md) | Cloudflare R2: checksum SHA-256 en `PutObject` | F1 | Verificada, incluida prueba real | 2026-10-01 |
| [`claude-code-cli.md`](claude-code-cli.md) | `claude -p`: salida estructurada, imágenes, aislamiento, errores y términos (adaptador `claude-cli`) | F2 | Solo doc; falta prueba de humo local | 2026-10-02 |
| [`anthropic-api.md`](anthropic-api.md) | Messages API y SDK de TypeScript: salida estructurada e imágenes (adaptador `anthropic-api`, stub en F2) | F2 | Solo doc | 2026-10-02 |
| [`heic-conversion.md`](heic-conversion.md) | HEIC a JPEG: sharp, ffmpeg y `sips` | F2 | Doc; faltan pruebas locales con ffmpeg | 2026-10-02 |
| [`instagram.md`](instagram.md) | Instagram Graph API: **solo límites de contenido** (auth y operaciones pendientes) | F2 (límites), F3 (resto) | Parcial, doc oficial | 2026-10-02 |
| [`mercadolibre.md`](mercadolibre.md) | Portal Inmobiliario y Mercado Libre: **solo título y fotos** | F2 (límites), F4 (resto) | Parcial; la doc de ML dio 403, solo resúmenes de buscador | 2026-10-02 |

Pendientes de crear: `fb-marketplace.md` (F5) y el resto de `instagram.md` y `mercadolibre.md` (F3 y F4).
