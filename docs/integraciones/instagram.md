# Instagram (Instagram API with Instagram Login): límites de contenido

Nota verificada el 2026-10-02. **Alcance parcial:** solo límites de contenido (imágenes, carrusel, reels, límite de publicación) que necesitan las plantillas de F2. Autenticación, operaciones y revisión de la app quedan para F3 y siguen marcadas "(verificar)" en `docs/03-plataformas.md`.

Convención: **DOC** = documentación oficial de Meta; **INFERENCIA** = deducido; **NO VERIFICADO** = falta prueba real.

## 1. Resumen

- **Mecanismo:** API de Instagram con Instagram Login (publicación de contenido: contenedores y `media_publish`). Madurez alta; riesgo bajo.
- **Contenido (DOC):** carrusel de hasta **10** ítems (imágenes, videos o mezcla); imágenes **JPEG** de hasta **8 MB** con proporción entre **4:5 y 1,91:1**; reels MOV o MP4 de **3 s a 15 min**, hasta 300 MB, HEVC o H.264.
- **Correcciones a `docs/03-plataformas.md`:** el rango de reels "5 a 90 s" no es un límite de la API (es una decisión de producto, ver sección 5); el límite de publicaciones es **100** por 24 h (el rango "50 a 100" quedó desactualizado o impreciso).

## 2. Requisitos de cuenta y app

No verificado en esta nota (F3): cuenta profesional, permisos `instagram_business_basic` e `instagram_business_content_publish`, App Review. La doc de publicación confirma que con Instagram Login se usa un token de acceso de usuario de Instagram y el permiso `instagram_business_content_publish` (DOC).

## 3. Autenticación

Fuera del alcance de esta nota (F3). La doc de publicación confirma token de usuario de Instagram para Instagram Login (DOC).

## 4. Operaciones

Fuera del alcance (F3), salvo lo necesario para los límites:

- Crear contenedor por medio y publicar con `media_publish`; los carruseles aceptan hasta 10 contenedores hijos, de tipo imagen o video (reels excluidos como hijos) (DOC, referencia de IG User Media).
- La referencia citada es la de la Graph API (`instagram-graph-api/reference/ig-user/media`). La guía de Instagram Login repite los mismos límites de carrusel, formato JPEG, rate limit y URL pública (DOC). Se asume que las especificaciones de medios son las mismas para ambos flujos de login (INFERENCIA razonable: es el mismo recurso `ig-user/media`; confirmar en F3 con la cuenta de prueba).

## 5. Medios

### Imágenes (DOC, referencia IG User Media)

| Requisito | Valor |
|---|---|
| Formato | **JPEG** (los JPEG extendidos MPO y JPS no se soportan; la guía dice que JPEG es el único formato) |
| Peso máximo | **8 MB** |
| Proporción | entre **4:5 y 1,91:1** (de 0,8 a 1,91) |
| Ancho mínimo | 320 px (se escala hacia arriba si hace falta) |
| Ancho máximo | **1440 px** (se escala hacia abajo si hace falta) |
| Espacio de color | **sRGB** (otros se convierten a sRGB) |
| URL | pública en el momento del intento; Instagram descarga ("cURL") la imagen |

- Carrusel: todas las imágenes se recortan según la **primera** del carrusel; por defecto 1:1 si no se indica otra (DOC). Nuestro estándar de 1080x1350 (4:5) respeta el rango, el ancho de 1080 está entre 320 y 1440, y 1350 de alto con ratio 0,8 cae justo en el límite inferior de 4:5. Evitar ratios aun más verticales por redondeos (por ejemplo 1080x1351).
- Tamaño de un JPEG de 1080x1350 con calidad ~85: 200 a 500 KB (INFERENCIA), muy por debajo de 8 MB.

### Carrusel (DOC)

- Máximo **10** ítems (imágenes, videos o mezcla). `docs/04-formato-publicaciones.md` ya fija "máximo 10 slides" con "verificar": queda **verificado**. Con portada y ficha, hasta 8 fotos de contenido, como ya dice el doc.
- Los videos dentro de un carrusel: la referencia consultada no da especificaciones distintas a las del reel (NO VERIFICADO si aplican las mismas).

### Reels (DOC, referencia IG User Media)

| Requisito | Valor |
|---|---|
| Contenedor | **MOV o MP4**, sin *edit lists*, con el `moov` al inicio (`-movflags +faststart`) |
| Video | **HEVC o H.264**, barrido progresivo, GOP cerrado, submuestreo 4:2:0 |
| Audio | **AAC**, hasta 48 kHz, 1 o 2 canales; bitrate de audio 128 kbps |
| Frame rate | **23 a 60 FPS** |
| Resolución | máximo **1920 px** en horizontal; proporción entre 0,01:1 y 10:1, **recomendada 9:16** |
| Bitrate de video | VBR, máximo **25 Mbps** |
| Duración | mínimo **3 s**, máximo **15 min** |
| Peso | máximo **300 MB** |
| Portada (cover) | JPEG, hasta 8 MB, sRGB; recomendada 9:16 (si no, se recorta el 9:16 central) |

- **Corrección:** "entre 5 y 90 s" de `docs/03-plataformas.md` y `docs/04-formato-publicaciones.md` no corresponde al límite de la API (3 s a 15 min). Si se quiere mantener 5 a 90 s, es una política de producto de AgentSales (reels cortos), no un requisito de Meta. Decisión del operador.
- Nuestro estándar 9:16 de 1080x1920 cumple (1920 es el máximo en horizontal; con 1080 de ancho y 1920 de alto: el límite se refiere a "horizontal pixels", así que 1080 queda bajo 1920).
- Asegurar `faststart`, sin edit lists y GOP cerrado al codificar con ffmpeg (por ejemplo `-c:v libx264 -pix_fmt yuv420p -movflags +faststart` más GOP cerrado, y `-c:a aac -ar 48000 -b:a 128k`). **Verificado en local (F2-T08, 2026-10-03, ffmpeg 9.0.1)**, con ffprobe en los tests de `packages/media`. Los parámetros están en `REEL_SPEC`:
  - libx264 `veryfast`, CRF 23, `-maxrate 20M -bufsize 40M`, yuv420p, 30 fps.
  - GOP fijo de 2 s y cerrado: `-g 60 -keyint_min 60 -sc_threshold 0 -flags +cgop`. x264 escribe `open_gop=0`, y hay un cuadro clave cada 2 s.
  - AAC estéreo a 48 kHz y 128 kb/s.
  - `-movflags +faststart` (`moov` antes de `mdat`) y `-use_editlist 0` (sin `elst`).

  Hay un desfase de ~67 ms entre el inicio del video y el del audio (dos B-frames de x264), sin edit list que lo corrija; es inocuo, y `-bf 0` lo quita si molestara. **Falta verificar que Meta acepte el reel** (F3).
- Si el video de origen ya cumple, evitar recodificar; en otro caso, `media.process` genera `ig_reel` (`docs/02-modelo-datos.md`).

## 6. Límites

- **Publicación vía API (DOC):** "Instagram accounts are limited to 100 API-published posts within a 24-hour moving period". Ventana móvil de 24 h, no día calendario. Se consulta con el endpoint `content_publishing_limit` (INFERENCIA desde `docs/03-plataformas.md`; el endpoint no se verificó en esta nota).
- Cuánto cuenta un carrusel (1 post) y si los reels cuentan igual: NO VERIFICADO en estas páginas. Mantener el supuesto de `docs/03-plataformas.md` hasta F3.
- Caption: 2.200 caracteres y hasta 30 hashtags son límites de Instagram; no se verificaron en esta consulta (NO VERIFICADO; `docs/04-formato-publicaciones.md` ya usa 2.200 y 5 a 12 hashtags).
- Rate limits de la API (llamadas por hora): fuera de alcance (F3).

## 7. Errores comunes

Fuera de alcance de esta nota (F3). Los errores esperables por contenido son: imagen no JPEG o con proporción fuera de rango, video con códec o perfil no soportado, URL no pública o con `Content-Type` incorrecto. El estado de un contenedor de video pasa a `ERROR` con un mensaje (NO VERIFICADO aquí).

## 8. Cómo probar sin riesgo

- En F2 no se publica nada: la verificación es local. Un test de las plantillas debe comprobar: salida JPEG sRGB, 1080x1350, peso < 8 MB, no más de 10 slides; reel: ffprobe confirma códec, fps (23 a 60), duración (3 s a 15 min o el tope de producto), `moov` al inicio.
- En F3: cuenta de prueba con rol en la app, `dry-run` primero, luego `live` con la cuenta de prueba.

## 9. Riesgos y términos de uso relevantes

- Meta puede cambiar los límites sin aviso: las constantes (10 slides, 4:5, 8 MB, 300 MB) deben vivir en un solo archivo de configuración de la plataforma, no repartidas por las plantillas.
- Un carrusel con una primera imagen fuera del rango 4:5 a 1,91:1 recorta todas: la plantilla debe renderizar siempre en 4:5.

## 10. Fuentes (consultadas el 2026-10-02)

- IG User Media (especificaciones de imagen, reel, portada, carrusel): https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
- Content Publishing (límite de 10 en carrusel, JPEG, recorte por la primera imagen, 100 publicaciones/24 h, URL pública, permisos): https://developers.facebook.com/docs/instagram-platform/content-publishing
- Content Publishing con Instagram Login (mismos límites): https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing
- Pista no oficial (resúmenes de terceros que coinciden con las cifras de Meta): https://adaptlypost.com/blog/instagram-reels-api-max-length-file-size
