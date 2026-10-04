# Notas de integración

Aquí el subagente `integraciones` deja una nota verificada por tema o plataforma, con fuentes oficiales y fecha de consulta. Se crean antes de planificar la fase que usa cada integración. Cada nota distingue **DOC** (documentación oficial), **INFERENCIA** y **NO VERIFICADO**.

| Nota | Tema | Fase | Estado | Verificada |
|---|---|---|---|---|
| [`r2-checksums.md`](r2-checksums.md) | Cloudflare R2: checksum SHA-256 en `PutObject` | F1 | Verificada, incluida prueba real | 2026-10-01 |
| [`claude-code-cli.md`](claude-code-cli.md) | `claude -p`: salida estructurada, imágenes, aislamiento, errores y términos (adaptador `claude-cli`) | F2 | Verificada, incluida la prueba de humo real (`pnpm llm:smoke`) | 2026-10-03 |
| [`anthropic-api.md`](anthropic-api.md) | Messages API y SDK de TypeScript: salida estructurada e imágenes (adaptador `anthropic-api`, stub en F2) | F2 | Solo doc | 2026-10-02 |
| [`heic-conversion.md`](heic-conversion.md) | HEIC a JPEG: sharp, ffmpeg y `sips` | F2 | Verificada con ffmpeg 9.0.1 (HEIC en mosaicos, F2-T07) | 2026-10-03 |
| [`instagram.md`](instagram.md) | Instagram API with Instagram Login: límites de contenido, OAuth y tokens, publicación (carrusel y reel), límites, errores, revisión de la app e implicaciones para F3 | F2 (límites), F3 (resto) | Solo doc oficial; **NO VERIFICADO hasta la demo de F3**: redirect `http://localhost`, URLs prefirmadas de R2, `content_publishing_limit` y `DELETE` con Instagram Login | 2026-10-04 (límites: 2026-10-02) |
| [`mercadolibre.md`](mercadolibre.md) | Portal Inmobiliario y Mercado Libre: **solo título y fotos** | F2 (límites), F4 (resto) | Parcial; la doc de ML dio 403, solo resúmenes de buscador | 2026-10-02 |

Pendientes de crear: `fb-marketplace.md` (F5) y el resto de `mercadolibre.md` (F4). Tras la demo de F3 hay que actualizar `instagram.md` con los resultados de la lista de pruebas pendientes (sección 8).
