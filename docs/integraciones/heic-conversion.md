# HEIC a JPEG en Node (sharp, ffmpeg, sips)

Nota verificada el 2026-10-02. Responde cómo convertir fotos HEIC de iPhone a JPEG en la etapa `media` del job `content.prepare` (F2). Corrige un supuesto de `docs/specs/fase-1-carga.md` (riesgos: "sharp con libheif, o fallback a ffmpeg").

Convención: **DOC** = documentación oficial; **INFERENCIA** = deducido; **NO VERIFICADO** = falta prueba real.

Limitación: el subagente no tenía terminal; las comprobaciones locales se hicieron después, el 2026-10-02, con ffmpeg 9.0.1 (sección 8).

## 1. Resumen

- **sharp (binarios precompilados) NO decodifica HEIC con HEVC.** Solo AVIF (AV1). Confirmado en la doc oficial.
- **ffmpeg decodifica HEIC con grilla de tiles de iPhone desde la versión 8.1** (marzo de 2026): la CLI ensambla los tiles sola. Antes de 8.1, la CLI toma un solo tile (512x512).
- **Recomendación:** ffmpeg >= 8.1 para HEIC a JPEG, y sharp para todo lo demás (redimensionar, rotar, ICC). `sips` solo como alternativa manual en macOS.
- **Riesgo:** medio. Quedan por probar la orientación, el perfil de color (Display P3) y los HEIC con mapa de ganancia HDR, con una foto real de iPhone (sección 8).

## 2. Requisitos de cuenta y app

No aplica (herramientas locales). Sin costo. HEVC tiene patentes; ffmpeg y los reproductores de los sistemas operativos lo decodifican de forma habitual para uso personal. No se evaluó el aspecto de patentes para distribución comercial (NO VERIFICADO; relevante solo si AgentSales se ofrece a terceros con binarios propios).

## 3. Autenticación

No aplica.

## 4. Operaciones

### 4.1 sharp (DOC)

- La instalación oficial indica que los binarios precompilados soportan, de entrada, "JPEG, PNG, Ultra HDR, WebP, AVIF, TIFF, GIF and SVG". **HEIC y HEIF no están en la lista.** La página principal y la del constructor tampoco incluyen HEIF/HEIC entre las entradas.
- La doc de salida lo aclara: "Support for patent-encumbered HEIC images using `hevc` compression requires the use of a globally-installed libvips compiled with support for libheif, libde265 and x265". Los binarios precompilados solo traen AV1 (AVIF).
- Versión vigente al consultar: sharp 0.35.5 (27-sep-2026), según el changelog en el sitio.
- Alternativa descartada: libvips global con libheif, libde265 y x265. La doc declara no soportado el libvips global en Windows y en macOS bajo Rosetta, y exige compilar y mantener una dependencia nativa aparte.
- Conclusión: el supuesto del spec F1 ("sharp con libheif") es incorrecto con los binarios por defecto. Hay que usar otro decodificador para HEIC.

### 4.2 ffmpeg

- **DOC (Changelog oficial de FFmpeg):** la versión 8.1 incluye "ffmpeg CLI tiled HEIF support". El soporte de demuxer para imágenes fijas HEIF/AVIF con tiles es anterior (el Changelog lo lista bajo una versión anterior, la 5.0 según la lectura; la atribución exacta de versión del demuxer no se confirmó).
- **Evidencia secundaria (issue de un proyecto de terceros, no doc oficial):** un HEIC de iPhone es un elemento derivado `grid` sobre decenas de tiles HEVC de 512x512 (por ejemplo 48 tiles para 4032x3024). Antes de 8.1, `ffmpeg -i foto.heic` más `-map 0:v:0` entrega solo un tile de 512x512; con 8.1 o posterior, la CLI inserta `xstack` y entrega la imagen completa 3024x4032. Ver https://github.com/block/buzz/issues/7666.
- **Consecuencia:** la versión mínima es **8.1**. La local declarada (9.0.1) la cumple. No usar `-map 0:v:0`: dejar la selección de streams por defecto.
- **Comando propuesto (NO VERIFICADO con un HEIC real):** `ffmpeg -i entrada.heic -frames:v 1 -q:v 2 salida.jpg`. Luego pasar `salida.jpg` por sharp (redimensionar y normalizar color).
- **Decodificador HEVC:** FFmpeg incluye un decodificador HEVC nativo; no necesita libx265 para decodificar (INFERENCIA, conocimiento general; confirmar con `ffmpeg -decoders | grep -i hevc`). Confirmar en la copia de Homebrew con `ffmpeg -demuxers | grep -i -E "heif|mov"`.
- Cambios entre versiones: el Changelog solo da una línea; si el tiled HEIF se rompe en una versión futura, el test de humo de `doctor` (sección 8) lo detecta.

### 4.3 `sips` (macOS)

- `sips -s format jpeg entrada.heic --out salida.jpg`; calidad con `-s formatOptions 80` (fuentes secundarias de blogs; sin doc oficial de Apple consultada: NO VERIFICADO en detalle). Viene con macOS, sin instalar nada. Aplica la rotación y suele convertir el perfil de color (INFERENCIA).
- **Solo macOS.** El worker que corra en Linux (nube, F7) no la tiene. Sirve solo para desarrollo o pruebas manuales.

## 5. Medios

- Entrada: HEIC de iPhone (HEVC, grilla de tiles, a menudo Display P3). Salida: JPEG sRGB, que Instagram exige (`instagram.md`) y que la API de Anthropic acepta (HEIC no; `anthropic-api.md`).
- Pasos recomendados en la etapa `media` para un HEIC: 1) ffmpeg a JPEG sin pérdida notable (`-q:v 2`) en un archivo temporal; 2) sharp: `rotate()` según EXIF si hace falta, `toColorspace("srgb")` o conversión equivalente, redimensionar a las variantes; 3) guardar variantes y borrar el temporal.
- Preguntas abiertas de calidad (NO VERIFICADO): orientación (los HEIC de iPhone guardan la rotación como propiedad `irot`; confirmar que ffmpeg 8.1 la aplica), perfil de color (si ffmpeg no etiqueta o convierte Display P3, los colores salen apagados), y mapas de ganancia HDR (se ignoran).
- No hay URL pública involucrada.

## 6. Límites

- Tiempo: 1 foto HEIC de 12 MP tarda del orden de décimas de segundo a 1 s (INFERENCIA); cabe en el job `content.prepare` (30 min por intento).
- Sin cuotas.

## 7. Errores comunes

| Situación | Cómo se ve | Tratamiento |
|---|---|---|
| ffmpeg < 8.1 | Sale un JPEG de 512x512 (un solo tile) sin error | Detectarlo: validar que el ancho/alto de salida sea >= 1000 px en el lado largo; si no, error `MEDIA_HEIC_TILE_ONLY`. `doctor` avisa por versión |
| HEIC con códec distinto o corrupto | ffmpeg termina con código distinto de 0 | La etapa `media` marca el medio como fallido con advertencia y sigue con los demás; no reintentar |
| ffmpeg ausente | Error al lanzar el proceso | `doctor` ya lo marca como error |
| sharp recibe un HEIC | Error "unsupported image format" (INFERENCIA) | No enviar HEIC a sharp: convertir antes |

## 8. Cómo probar sin riesgo

**Verificado en local (2026-10-02, macOS, ffmpeg 9.0.1 de Homebrew)** con un HEIC del sistema (`/System/Library/CoreServices/DefaultDesktop.heic`, sin personas ni datos de clientes):
- `ffmpeg -demuxers` no lista un demuxer `heif` propio (lo lee el de `mov`), y `ffmpeg -decoders` trae `hevc`.
- `ffprobe -show_entries stream_group=type` lista un grupo `Tile Grid` de mosaicos HEVC de 512×512.
- `ffmpeg -i DefaultDesktop.heic -frames:v 1 salida.jpg` sale **completo, en 3840×2160** (no un mosaico suelto).
- Quedan por probar la orientación (`irot`) y el perfil Display P3 con una foto de iPhone propia: lo cubre el test de T07 del spec F2.

Comprobaciones restantes (usar una foto de prueba propia, no de clientes):
1. `ffmpeg -version` (debe ser >= 8.1) y `ffmpeg -decoders | grep -i hevc`; `ffmpeg -demuxers | grep -i -E "heif|mov"`.
2. `ffprobe -show_stream_groups foto.heic`: debe listar un grupo `tile_grid`.
3. `ffmpeg -i foto.heic -frames:v 1 -q:v 2 salida.jpg` y comprobar dimensiones (iPhone típico: 3024x4032 o 4032x3024), orientación visual y colores frente a la vista previa de macOS.
4. `node -e "require('sharp')(...)"` con el HEIC: debe fallar (confirma que no hay HEVC en sharp).
5. Fijar este caso como test de integración opcional (omitido si falta ffmpeg >= 8.1) y como chequeo en `agentsales doctor` con un HEIC diminuto de muestra versionado (sin personas).

### Verificado en F2-T07 (2026-10-03, macOS, ffmpeg 9.0.1)
- **HEIC sintético de prueba:** un JPEG de 1600×1200 hecho con sharp (con EXIF Orientation = 6), convertido con `sips -s format heic`. `sips` lo codifica en un grupo `Tile Grid` de 12 mosaicos HEVC y guarda el giro como `irot` (en ffprobe, `display_matrix` con `rotation=-90`). Pesa 5,6 KB y está en `packages/media/test/fixtures/`.
- **Orientación:** `ffmpeg -i foto.heic -frames:v 1 …` **aplica el `irot`**: sale derecho (1200×1600), con el bloque que estaba arriba a la izquierda ahora arriba a la derecha. La pregunta abierta de la sección 5 queda resuelta para el giro.
- **sharp 0.35.5 (binarios precompilados) no decodifica HEIC**, aunque trae libheif (solo AVIF), como decía la sección 4.
- **El adaptador** (`packages/media`) escribe el HEIC en el temporal del intento, lo pasa por ffmpeg (`-q:v 2`, salida `mjpeg` por la salida estándar, sin archivo intermedio) y sigue con sharp. Revisa una vez que ffmpeg sea 8.1 o más nuevo (`MEDIA_TOOL_NOT_INSTALLED` si no), en vez de validar las dimensiones de salida: `doctor` también exige 8.1.
- **Sin verificar:** el perfil de color (Display P3 de un iPhone real) y los mapas de ganancia HDR. Se revisan con la primera foto real en la demo de F2.
- **CI:** build estático de BtbN/FFmpeg-Builds `n9.0.1-11-ge47273f4d9` (linux64, GPL, cierre de agosto de 2026; los builds de cierre de mes se conservan), fijado por URL y sha256 en `.github/workflows/ci.yml`. El de Ubuntu 24.04 (6.1) no sirve, y el de johnvansickle.com sigue en 7.0.2.

## 9. Riesgos y términos de uso relevantes

- **Versión mínima de ffmpeg:** 8.1. En Linux, los paquetes de las distribuciones suelen ir atrasados; usar un build estático o contenedor con versión fijada para el worker en la nube.
- **Patentes de HEVC:** relevante si se distribuye ffmpeg dentro de un producto. No aplica al uso local actual.
- **Dependencia:** si ffmpeg cambia el comportamiento de la grilla, las fotos HEIC saldrán recortadas; por eso la validación de dimensiones.
- **Alternativas no recomendadas (fuera del stack, regla 8):** paquetes JS con libheif en wasm (`heic-convert`), `libheif` por línea de comandos.

## 10. Fuentes (consultadas el 2026-10-02)

- sharp, instalación (formatos de los binarios precompilados): https://sharp.pixelplumbing.com/install
- sharp, entrada del constructor: https://sharp.pixelplumbing.com/api-constructor/
- sharp, salida HEIF (`hevc` exige libvips global con libheif, libde265 y x265): https://sharp.pixelplumbing.com/api-output#heif
- sharp, página principal (formatos de entrada y versión 0.35.5): https://sharp.pixelplumbing.com/
- FFmpeg Changelog (8.1: "ffmpeg CLI tiled HEIF support"; 9.0 como última): https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/Changelog
- FFmpeg, página de inicio (releases 8.0 y 8.1): https://ffmpeg.org/index.html
- Pista no oficial (comportamiento de ffmpeg < 8.1 con tiles de iPhone): https://github.com/block/buzz/issues/7666
- Pista no oficial (uso de `sips`): https://obelisk.club/blog/macos-sips-command-line-guide
