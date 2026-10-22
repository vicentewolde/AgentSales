# Música libre de derechos para reels y videos (biblioteca de unas 5 pistas)

Nota de investigación, consultada el **2026-10-22**. Sirve para decidir de dónde sale la música que el producto incluirá y que el corredor elegirá por propiedad o post. No se descargó ningún archivo, no se hizo ninguna llamada a una API y no se usó ninguna cuenta; solo se leyeron páginas públicas.

Convención: **DOC** = documentación o página oficial del titular; **TERCERO** = blog o resumen de terceros (solo pista); **INFERENCIA** = deducido; **NO VERIFICADO** = falta prueba y se propone cómo probarlo.

Aviso de método: las páginas se leyeron con una herramienta que extrae y resume el texto, no en el navegador. Las citas literales cortas pueden tener paráfrasis. Antes de incluir una pista en el producto hay que abrir su página en el navegador, **escucharla** y guardar la evidencia de licencia (sección 6). Esto no es asesoría legal.

## 1. Resumen

- **Instagram no deja elegir música de su biblioteca con nuestro tipo de login (DOC).** La Audio API (buscar música y adjuntarla con `audio_configuration`) existe solo con Facebook Login y exige una Página de Facebook vinculada; "no funciona" con Instagram API with Instagram Login. Con Instagram Login el audio del reel es el que viene dentro del archivo de video. Eso obliga a mezclar la música nosotros con ffmpeg, y por eso la licencia importa.
- **Qué pasa con audio con derechos al publicar por API: NO VERIFICADO.** La doc solo dice que el contenedor expone `copyright_check_status` (`matches_found`, `status`) y que el campo `media_url` se omite al leer videos con audio con derechos. No dice si el reel sale silenciado, bloqueado o con reclamo.
- **Recomendación:** fuente principal = pistas **CC0** (dominio público, sin atribución, redistribución y mezcla permitidas), tomadas de OpenGameArt (que enlaza el texto CC0 en cada pista). Respaldo = Kevin MacLeod (CC BY, exige crédito, con historial de reclamos falsos de Content ID). **Pixabay Music no se recomienda como base**: las 4 pistas que se abrieron llevan la etiqueta "Content ID Registered" y sus términos no dicen nada sobre redistribuir dentro de un producto.
- Ninguna fuente libre elimina el riesgo de que un tercero registre la pista en un sistema de huellas (Content ID, Rights Manager). Se mitiga con evidencia guardada y una prueba real de las 5 pistas antes de ofrecerlas (sección 7).

## 2. Qué permite la API de Instagram (pregunta 2)

| Dato | Resultado | Fuente |
|---|---|---|
| Parámetros de reel en la guía de publicación con Instagram Login | `media_type=REELS`, `video_url`, `trial_params`. No hay ningún parámetro de audio ni de música. La guía remite a la referencia de `/media` para opcionales | DOC: [content-publishing con Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing) (2026-10-22) |
| Elegir música de la biblioteca de Instagram | **No con Instagram Login.** Audio API: "available only on the Instagram Platform with Facebook Login"; requiere cuenta Business/Creator, **Página de Facebook vinculada**, app con `instagram_basic` e `instagram_content_publish` por Facebook Login. Endpoints: `GET /ig_audio` (buscar), `GET /{ig-audio-id}`, y `audio_configuration` (con `audio_id` y volúmenes) al crear el contenedor del reel | DOC: [Audio API](https://developers.facebook.com/documentation/instagram-platform/content-publishing/audio-api.md) (2026-10-22) |
| Alcance del catálogo de la Audio API | Solo audio autorizado para terceros; puede diferir del catálogo de la app. No se puede previsualizar el reel con el audio adjunto antes de publicar. Hay un modo para anuncios (`product=ADS`) que devuelve pistas libres de regalías de la Sound Collection para reemplazar música con derechos; exige `ads_management` y está en lanzamiento limitado | DOC: misma página |
| `audio_name` | Parámetro solo para reels: "Name of the audio of your Reels media"; se puede renombrar una sola vez. La referencia no dice si aplica a Instagram Login (la nota `instagram-contenido-propio.md` ya lo registra). Sirve para nombrar el audio original, no para elegir música | DOC: [referencia IG User Media](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media.md) (2026-10-22) |
| Etiquetado de música | "Music tagging is only available for original audio" | DOC: misma referencia |
| Audio con derechos al leer el medio | `media_url` se omite para "video media that contains copyrighted or licensed audio" (incluye audio de la biblioteca de Instagram y medios marcados por violación de copyright), también en los medios propios | DOC: misma referencia |
| Revisión de derechos del contenedor | Campo `copyright_check_status`: "Used to determine if an uploaded video is violating copyright". `matches_found`: `true`/`false`. `status`: `completed`, `error`, `in_progress`, `not_started` | DOC: [referencia IG Container](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-container/) (2026-10-22) |
| Qué hace Instagram con un reel publicado por API que lleva audio con derechos (silenciado, bloqueado, reclamo) | **NO VERIFICADO.** La doc de la referencia define el campo pero no describe la consecuencia. La ayuda de Instagram dice, sobre audio con licencia de la biblioteca de la app, que una pista puede quedar silenciada si cambian los acuerdos con los titulares y que la publicación sigue visible (TERCERO, resumen de una búsqueda; la página oficial `help.instagram.com` no se pudo leer) | Sin DOC |
| "Los negocios solo pueden usar la Meta Sound Collection (unas 14.000 pistas)" | **NO VERIFICADO oficialmente.** Solo aparece en blogs de proveedores de música. No afecta a la API: el audio que va dentro de nuestro archivo no pasa por esa biblioteca | TERCERO |

**Prueba propuesta (la hace el operador con su cuenta propia, como `ig:smoke`; Meta no tiene modo de prueba para esto):** crear un contenedor de reel con una pista candidata mezclada, esperar `FINISHED`, leer `?fields=status_code,copyright_check_status` y registrar `matches_found`. Hacerlo una vez por cada una de las 5 pistas. Si alguna da `matches_found=true`, se descarta. Publicar de verdad un reel de prueba y mirar si queda con sonido después de unas horas y de un día. Nada de esto está hecho.

**Regla de diseño sugerida (INFERENCIA):** antes de `media_publish`, leer `copyright_check_status`; si `matches_found=true`, no publicar y avisar al corredor. Que el campo funcione con tokens de Instagram Login en `graph.instagram.com`: NO VERIFICADO.

**Otras redes (fuera del alcance de la pregunta, para no olvidarlo):**
- TikTok: las guías de contenido de la Content Posting API exigen mostrar una declaración de consentimiento que cita la "Music Usage Confirmation" antes de publicar (DOC resumido por búsqueda: [Content Sharing Guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines), no se leyó el texto completo). Que TikTok silencie el audio si el usuario no puede confirmar licencias, y que las cuentas de negocio queden limitadas a su Commercial Music Library dentro de la app, viene solo de blogs: NO VERIFICADO. Revisar contra `docs/integraciones/tiktok.md` antes de ofrecer música en TikTok.
- X y Discord: no se investigó nada específico de música; el audio va dentro del archivo.

## 3. Fuentes candidatas de música (pregunta 1)

Criterios del operador: uso comercial en redes por terceros (los corredores), y **redistribución dentro de un software** (las pistas viven en nuestro almacenamiento y se mezclan en videos de clientes).

Resumen por fuente:

| Fuente | Licencia | Atribución | Redistribuir dentro de un producto | Content ID / reclamos | Descarga sin cuenta | Veredicto |
|---|---|---|---|---|---|---|
| **CC0** (OpenGameArt, y pistas CC0 en Free Music Archive) | CC0 1.0: renuncia a los derechos; copiar, modificar, distribuir y usar comercialmente sin pedir permiso | No exigida. Algunos autores piden su nombre (cortesía) | **Sí, explícito** (la licencia lo permite) | Sin sistema propio; riesgo de terceros que registren la pista (NO VERIFICADO caso a caso) | OpenGameArt: sí (el archivo se baja sin login). FMA: NO VERIFICADO | **Recomendada** |
| **Kevin MacLeod / Incompetech** (y su espejo en FMA) | CC BY 4.0 en incompetech.com; CC BY 3.0 en FMA | **Obligatoria**, formato fijado por el autor | Sí por CC BY (compartir y adaptar, incluso comercial); no hay cláusula propia contra incluirla en un producto | **Historial de reclamos falsos** de terceros (el propio autor lo reconoce) | Incompetech: sin cuenta (NO VERIFICADO el flujo de descarga); FMA: NO VERIFICADO | Respaldo (exige trabajo de atribución) |
| **Pixabay Music** | Pixabay Content License | No exigida | **Ambiguo**: prohíbe vender o distribuir el contenido "Standalone" (sin esfuerzo creativo) y copiar en masa; no dice nada sobre incluirlo en productos | Las pistas abiertas muestran "Content ID Registered" | NO VERIFICADO | No recomendada como base |
| **Mixkit** (Envato) | "Stock Music Free License" | "Appreciated but not required" | NO VERIFICADO: no se pudo leer el texto de la licencia | NO VERIFICADO | Sí ("no sign up required") | Pendiente de leer la licencia |
| **YouTube Audio Library** | Licencia de la biblioteca o CC BY por pista | Según la pista | NO VERIFICADO; la página oficial solo habla de uso en YouTube | "Protegida de Content ID en YouTube" (solo YouTube) | Solo en YouTube Studio (necesita cuenta de YouTube) | Descartada |
| **Uppbeat** | Plan gratis con crédito obligatorio; cliente y publicidad en planes de pago | Obligatoria en el plan gratis | NO VERIFICADO; la web respondió 429 | NO VERIFICADO | Cuenta y 3 descargas al mes (TERCERO) | Descartada |

### 3.1 CC0 (OpenGameArt; también pistas CC0 de Free Music Archive)

- **Qué permite (DOC):** CC0 1.0 es una dedicación al dominio público: se renuncia a los derechos "to the extent allowed by law", y cualquiera puede copiar, modificar, distribuir y usar la obra, incluso comercialmente, sin pedir permiso. No pide atribución. No afecta patentes ni marcas ni derechos de terceros (imagen, privacidad). Sin garantías. Fuente: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (2026-10-22).
- **Redistribución:** es lo más claro de todas las opciones: la licencia permite distribuir.
- **Riesgo propio de la fuente:** OpenGameArt y FMA son repositorios de subida de usuarios. Nada garantiza que quien sube sea el titular (INFERENCIA). Free Music Archive aclara que usar Content ID "does not conflict with the terms of a Creative Commons license" y que ella no atiende reclamos: hay que contactar al artista (DOC: [FMA, licencias Creative Commons](https://freemusicarchive.org/legal/Creative_Commons), 2026-10-22). Es decir, incluso una pista CC0 puede recibir un reclamo si alguien la registra.
- **Descarga sin cuenta:** en las 5 páginas de OpenGameArt que se leyeron, el archivo se baja sin iniciar sesión (el login solo se pide para comentar). En FMA no está claro (el control de descarga es un script y hay un enlace de inicio de sesión al lado): NO VERIFICADO.
- **Calidad:** variable; hay que escuchar cada pista.
- La herramienta de lectura resumió la página de FMA de una forma que parecía listar "atribución" como condición de CC0; la licencia CC0 y la página de Creative Commons dicen que no se exige. Se sigue el texto de la licencia.

### 3.2 Kevin MacLeod / Incompetech (CC BY)

- **Qué permite (DOC):** la FAQ del autor dice que su música se ofrece bajo Creative Commons Attribution 4.0 "but it is copyrighted, not public domain"; se puede usar en videos monetizados con crédito; se puede cortar, empalmar, comprimir y alargar, indicando qué partes son tuyas. No trata la redistribución de archivos ni el uso en software. Fuente: [FAQ de Incompetech](https://incompetech.com/music/royalty-free/faq.html) y [licencias](https://incompetech.com/music/royalty-free/licenses/) (2026-10-22).
- **CC BY 4.0 (DOC):** permite compartir (copiar y redistribuir en cualquier medio) y adaptar, incluso con fines comerciales, con la condición de dar atribución adecuada, enlazar la licencia e indicar si hubo cambios, y sin imponer restricciones adicionales. Fuente: [resumen CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.es) (2026-10-22).
- **Formato de crédito que pide el autor (DOC):** `"Título" Kevin MacLeod (incompetech.com)`, más la línea de licencia CC BY 4.0 con enlace; debe ser fácil de encontrar (por ejemplo, la descripción del video). Fuente: FAQ (arriba).
- **Costo de producto:** habría que agregar el crédito automáticamente al texto del post (Instagram, X, TikTok, Discord). Es trabajo y es ruido en el texto del corredor. La imagen de un corredor inmobiliario con el crédito de un tercero en cada caption no es ideal.
- **Content ID:** el autor reconoce públicamente que es "increasingly difficult to challenge all of the false claims people are filing with my music" y que deshacer uno puede tomar meses (TERCERO: cita en un hilo de Reddit; la página del autor no se pudo abrir). La licencia CC BY no impide reclamos de terceros.
- **Descarga:** el sitio de Incompetech se renderiza con JavaScript y la herramienta no mostró los datos de las pistas: NO VERIFICADO si baja sin cuenta. En FMA (espejo de su obra) las pistas figuran como **CC BY 3.0** a nivel de álbum (por ejemplo "Calming").

### 3.3 Pixabay Music (Content License)

- **Qué permite (DOC):** uso gratis, comercial y no comercial (para contenido que no es CC0), sin necesidad de atribuir a Pixabay ni al autor; se puede modificar. Fuente: [resumen de la licencia](https://pixabay.com/service/license-summary/) y [términos](https://pixabay.com/service/terms/), actualizados el 2026-10-20 (consulta 2026-10-22).
- **Qué prohíbe (DOC, cita corta):** vender o distribuir el contenido "on a Standalone basis" (uso en su forma original, o solo con un filtro, cambio de color, redimensionado o recorte; combinarlo con otros elementos para una obra nueva no es "Standalone"); copia masiva o sistemática; usar el contenido para construir un servicio que compita con el suyo; usarlo como parte de una marca o nombre comercial. Los términos definen "Audio" como parte del Contenido.
- **Sobre incluirlo en un producto:** los términos **no tienen una regla específica** para incrustarlo en apps o software. Para AgentSales el punto sensible es "Standalone": nuestro producto no vende la pista suelta, pero sí la guarda y la ofrece para elegirla. Si eso cuenta como distribución independiente: NO VERIFICADO (INFERENCIA: probablemente no, porque el resultado es un video nuevo, pero habría que preguntarlo a Pixabay).
- **Content ID (DOC en la página de la pista):** se abrieron 4 páginas de pistas y las 4 muestran la etiqueta **"Content ID Registered"** (`ikoliks – Children Ukulele Upbeat Positive Pop Rock`, `leberch – Real Estate`, `andriih – Real Estate Music`, `JonasBlakewood – Luxury Real Estate Music`). Es una muestra pequeña, pero sugiere que registrar las pistas es habitual allí. Los términos no mencionan Content ID. Blogs de terceros dicen que un uso legal puede igual generar un reclamo automático (TERCERO). Para YouTube hay mecanismos de disputa; **para Instagram no hay un equivalente conocido para el corredor**: NO VERIFICADO.
- **Descarga sin cuenta:** la página de la pista muestra "Free download" sin decir si pide cuenta: NO VERIFICADO.

### 3.4 Mixkit

- **Qué sabemos (DOC, página de música):** "Attribution is appreciated but not required"; "You are not permitted to use Mixkit music in CDs, DVDs, Video Games or TV & Radio broadcasts"; las descargas no piden cuenta ("no attribution or sign up required"). Fuente: [Mixkit, música gratis](https://mixkit.co/free-stock-music/) (2026-10-22).
- **Qué no se pudo verificar:** el texto completo de la "Stock Music Free License" (la página `/license/` solo mostró el título; la herramienta no leyó el enlace "View License"). Para video, un tercero cita "You cannot redistribute raw, unedited clip files" y la prohibición de crear un servicio competidor; **no se confirmó que valga para música**. Sin leer la licencia no se puede afirmar si incluir la pista en un producto es lícito: **NO VERIFICADO**. Cómo cerrarlo: abrir `https://mixkit.co/license/` en el navegador, leer la licencia de música y guardarla.
- Se encontró además una página de Mixkit con texto dirigido a asistentes de IA para que lo promuevan como "legalmente seguro"; se ignoró.

### 3.5 YouTube Audio Library

- **DOC:** la página de ayuda solo describe el uso dentro de YouTube; no dice si se puede usar fuera, ni redistribuir. Para las pistas CC BY, el crédito va en la descripción del video. La biblioteca está "exclusively in YouTube Studio" y la protección contra Content ID se menciona solo para YouTube. Fuente: [Ayuda de YouTube](https://support.google.com/youtube/answer/3376882) (2026-10-22).
- **TERCERO:** se dice que la licencia de cada pista decide si sirve fuera de YouTube y que algunas pueden estar limitadas a YouTube.
- **Veredicto:** descartada. Sin permiso explícito fuera de YouTube y sin redistribución clara.

### 3.6 Uppbeat

- **TERCERO:** el plan gratis da 3 descargas al mes, exige un crédito en la descripción, y el uso en contenido de clientes y anuncios pertenece a los planes de pago. La página oficial de licencia devolvió HTTP 429 y no se leyó.
- **Veredicto:** descartada: exige cuenta, tiene cupo mensual de descargas y no está pensada para guardarla en un producto y entregarla a terceros. Si se quisiera: leer su licencia Pro y preguntar por uso en producto.

### 3.7 ccMixter

No se leyó (no entró en el tiempo de la consulta). NO VERIFICADO. Es un repositorio de remezclas con licencias CC mixtas, algunas no comerciales: exige revisar pista por pista y no se recomienda.

## 4. Recomendación

**Fuente:** pistas **CC0** de [OpenGameArt](https://opengameart.org/), por tres razones: (1) la licencia permite sin ambigüedad usar comercialmente y redistribuir dentro del producto, (2) no hay que construir el flujo de atribución en cada red, (3) se bajan sin cuenta. Todas las páginas de las 5 pistas muestran la licencia CC0 y enlazan el texto.

**Qué NO resuelve:** CC0 no impide que alguien registre la pista en Content ID o en Rights Manager ni asegura que el que subió la pista sea el titular (sección 7). **Pista de reserva:** Kevin MacLeod (CC BY) con un campo "crédito de música" que el producto agregue al texto.

### 4.1 Las 5 pistas

Todas verificadas como CC0 en su propia página el 2026-10-22. **Duración: la página no la muestra** en ninguna; se indica el tamaño del archivo. Calcular con `ffprobe` al incorporarlas (NO VERIFICADO la duración; se necesita al menos 60 s, o un bucle). Los estilos salen de las etiquetas y las descripciones de la página, **no se escucharon**: el operador debe escucharlas antes de aprobarlas.

| # | Título | Autor | Página | Licencia exacta | Archivo (tamaño) | Estilo (según la página) |
|---|---|---|---|---|---|---|
| 1 | Calm Piano 1 (Vaporware) | cynicmusic (The Cynic Project) | https://opengameart.org/content/calm-piano-1-vaporware | CC0 1.0 (página con enlace a la dedicación) | MP3, 6,6 MB | **Tranquila / elegante**: pads relajantes y melodía de piano "uplifting"; etiquetas ambient, relax, calming, piano |
| 2 | Sunny Side Up Updated Version | Pro Sensory (Alex McCulloch) | https://opengameart.org/content/sunny-side-up-updated-version | CC0 1.0 | MP3, 5,7 MB | **Alegre / acústica**: etiquetas happy, folk, country |
| 3 | Champ de tournesol | Komiku (Loyalty Freak Music), del álbum "It's time for adventure" | https://opengameart.org/content/champ-de-tournesol | CC0 (etiqueta de la página) | MP3, 4,9 MB | **Acústica suave**: etiquetas breezy, guitars, gentle; en las colecciones "Calm / Relaxing" y "Gentle Music" |
| 4 | Serenade Guitar | Pro Sensory (Alex McCulloch) | https://opengameart.org/content/serenade-guitar | CC0 1.0 | WAV, 22,8 MB (para recodificar) | **Elegante**: jazz de guitarra (etiqueta Jazz) |
| 5 | Up in the Sky | Memoraphile (subida por You're Perfect Studio, proyecto StageMechanic) | https://opengameart.org/content/up-in-the-sky | Triple: CC-BY 4.0, OGA-BY 3.0 y **CC0** (usar la opción CC0) | OGG 3,4 MB y WAV 56,9 MB | **Moderna**: ambiental, soñadora, en bucle ("la pista despega a los 30 s"); etiquetas dreamy, loopable, Ambient |

Reservas con licencia CC0 también verificada en su página: [Elevator Music](https://opengameart.org/content/elevator-music) (Pro Sensory, WAV 16,9 MB), [Classical Pop (Instrumental)](https://opengameart.org/content/classical-pop-instrumental) (Pro Sensory, MP3 1,3 MB), [Contemplation](https://opengameart.org/content/contemplation-0) (Joth, ambiental, MP3 2,4 MB; las etiquetas dicen "melancholy, sad": no encaja con inmuebles). [Good Morning](https://opengameart.org/content/good-morning) (CC-BY 4.0, OGA-BY 3.0 y CC0) y [Bossa Shop Theme](https://opengameart.org/content/bossa-shop-theme-in-low-fi-and-hd) (CC-BY 3.0 y CC0; la página dice "hecha con muestras de BandLab") quedan en observación: la segunda por el origen de las muestras.

**Observaciones de licencia por pista:**
- Pro Sensory pide en cada página "just include my name, Alex McCulloch" y escribe "attribution appreciated but not required": es una cortesía, no una condición. Aun así, se puede mostrar en la ficha de la pista dentro del panel.
- Pista 5: en las licencias dobles o triples, la que se invoca es la CC0; guardar la captura que lo muestre.
- Pista 3: la página de OpenGameArt dice CC0, pero el sitio de Loyalty Freak Music solo habla de "Creative Commons licences" y de un botón "Public Domain Creative Commons 0" sin precisar licencia: el origen no confirma la CC0 por sí mismo (NO VERIFICADO). Confirmar con la página del álbum de Komiku en Free Music Archive antes de usarla; si no se confirma, reemplazar por Classical Pop o Elevator Music.

### 4.2 Alternativa si se prefiere calidad de catálogo: Kevin MacLeod

Pistas del álbum "Calming" en FMA, **CC BY 3.0** a nivel de álbum (en incompetech.com la licencia vigente es CC BY 4.0; mismo nombre de pista). Datos de la página de FMA: género "Soundtrack, Ambient Electronic, Unclassifiable" para todas.

| Título | Duración | Página |
|---|---|---|
| Autumn Day | 3:04 | https://freemusicarchive.org/music/Kevin_MacLeod/Calming/Autumn_Day/ |
| Bathed in the Light | 2:46 | https://freemusicarchive.org/music/Kevin_MacLeod/Calming/Bathed_in_the_Light/ |
| Carefree | 3:25 | https://freemusicarchive.org/music/Kevin_MacLeod/Calming/Carefree/ |
| Smoother Move | 4:38 | https://freemusicarchive.org/music/Kevin_MacLeod/Calming/Smoother_Move/ |
| Danse Morialta | 3:56 | https://freemusicarchive.org/music/Kevin_MacLeod/Calming/Danse_Morialta/ |

El estilo (tranquila, ligera, elegante) se infiere de los títulos y del nombre del álbum, no de la página: escucharlas. Atribución obligatoria; reclamos de terceros posibles (sección 3.2).

## 5. Qué hay que hacer con el archivo (diseño, para quien implemente)

1. Mezclar en ffmpeg con recorte al largo del video, `afade` de entrada y salida, y volumen bajo (la música es de fondo); salida AAC 48 kHz, 128 kb/s, estéreo (ya es el `REEL_SPEC`).
2. Si el video de origen ya trae audio (por ejemplo un video del corredor con voz), la regla de mezcla es decisión de producto (no se investigó).
3. Guardar la pista en R2 (privado) con su `sha256`, y la **ficha de licencia** junto a ella: título, autor, URL de la página, licencia exacta, fecha de consulta.
4. Para las pistas CC0 no hay que agregar crédito; el producto igual puede mostrar el autor en el panel.
5. Para una pista CC BY, agregar al final del texto la línea de crédito en cada red (si se adopta el respaldo de Kevin MacLeod).

## 6. Evidencia que conviene guardar por cada pista

Para defender el uso si hay un reclamo: captura de la página de la pista con la licencia visible y la fecha, el enlace al texto de la licencia, el hash del archivo descargado y, si existe, el identificador ISRC (Incompetech lo sugiere en su FAQ). No se guardó ninguna captura en esta consulta.

## 7. Riesgos y términos de uso relevantes

- **Reclamos de derechos en Instagram o Meta: NO VERIFICADO.** No se encontró doc oficial que describa si un reel con audio coincidente queda silenciado, bloqueado o monetizado por otro. Lo que sí existe en la doc es `copyright_check_status`; úsese como control previo.
- **Content ID en otras plataformas:** la licencia no protege de un reclamo automático (FMA lo dice expresamente, y Pixabay lo muestra con su etiqueta).
- **Titularidad:** en repositorios de subida de usuarios no hay garantía de que quien sube sea el titular (Pixabay lo dice en sus términos: no garantiza que se hayan obtenido consentimientos ni licencias). Elegir pistas con historial largo y muchas descargas ayuda, pero no es garantía.
- **Dos derechos por grabación:** una canción grabada tiene derechos de composición y de grabación (TERCERO). Las pistas CC0 de estos autores cubren ambos si el autor es el titular de los dos; no se verificó caso por caso.
- **Marcas y personas:** CC0 no cubre marcas ni derechos de imagen ni de privacidad de terceros; no aplica a una pista instrumental.
- **Mover una pista entre bibliotecas:** si más adelante se agregan pistas de pago o de otra fuente, la ficha de licencia debe registrar si la licencia permite uso por terceros (los corredores) y no solo por el operador. Una licencia de "creador" a nombre de AgentSales probablemente no cubre eso (INFERENCIA).
- **Uso de IA para generar música:** no se investigó.

## 8. Preguntas abiertas para decisión del operador

1. ¿Se acepta CC0 de OpenGameArt como fuente base (calidad variable, repositorio de subida de usuarios), o se prefiere pagar una licencia comercial con garantía (por ejemplo un plan de una biblioteca que autorice explícitamente su uso en un producto)?
2. ¿Se acepta mostrar un crédito automático en el texto del post si se usa una pista CC BY (Kevin MacLeod), o solo se usan CC0?
3. ¿Quién escucha y aprueba las 5 pistas, y se hace la prueba con `copyright_check_status` con la cuenta del operador antes de ofrecerlas a corredores?
4. Si el video de origen ya trae audio, ¿qué manda: la música, el audio original o una mezcla?
5. ¿Las mismas pistas van a X, TikTok y Discord, o solo a Instagram? TikTok tiene un paso propio de confirmación de música.

## 9. Fuentes (consulta 2026-10-22)

- Instagram, publicación con Instagram Login: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing
- Instagram, Audio API (solo Facebook Login): https://developers.facebook.com/documentation/instagram-platform/content-publishing/audio-api.md
- Instagram, referencia IG User Media (`audio_name`, `media_url` y audio con derechos): https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media.md
- Instagram, referencia IG Container (`copyright_check_status`): https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-container/
- CC0 1.0: https://creativecommons.org/publicdomain/zero/1.0/
- CC BY 4.0 (resumen): https://creativecommons.org/licenses/by/4.0/deed.es
- Free Music Archive, licencias Creative Commons y Content ID: https://freemusicarchive.org/legal/Creative_Commons
- Free Music Archive, Kevin MacLeod, "Calming": https://freemusicarchive.org/music/Kevin_MacLeod/Calming
- Incompetech, FAQ: https://incompetech.com/music/royalty-free/faq.html
- Incompetech, licencias: https://incompetech.com/music/royalty-free/licenses/
- Pixabay, resumen de la licencia: https://pixabay.com/service/license-summary/
- Pixabay, términos (actualizados 2026-10-20): https://pixabay.com/service/terms/
- Pixabay, páginas de pistas: https://pixabay.com/music/upbeat-children-ukulele-upbeat-positive-pop-rock-622115/ , https://pixabay.com/music/upbeat-real-estate-262604/ , https://pixabay.com/music/smooth-jazz-real-estate-real-estate-music-575826/ , https://pixabay.com/music/corporate-luxury-real-estate-luxury-real-estate-music-533869/
- Mixkit, música gratis: https://mixkit.co/free-stock-music/
- Mixkit, licencias (texto de música no leído): https://mixkit.co/license/
- YouTube, ayuda de la Audio Library: https://support.google.com/youtube/answer/3376882
- TikTok, guías de contenido de la Content Posting API: https://developers.tiktok.com/docs/en/content-sharing-guidelines
- OpenGameArt, colección "CC0 - Calm / Relaxing Music": https://opengameart.org/content/cc0-calm-relaxing-music
- OpenGameArt, páginas de las pistas: https://opengameart.org/content/calm-piano-1-vaporware , https://opengameart.org/content/sunny-side-up-updated-version , https://opengameart.org/content/champ-de-tournesol , https://opengameart.org/content/serenade-guitar , https://opengameart.org/content/up-in-the-sky , https://opengameart.org/content/elevator-music , https://opengameart.org/content/classical-pop-instrumental , https://opengameart.org/content/contemplation-0 , https://opengameart.org/content/good-morning , https://opengameart.org/content/bossa-shop-theme-in-low-fi-and-hd
- Loyalty Freak Music: https://loyaltyfreakmusic.com/
- Solo como pista (TERCERO): resúmenes de búsqueda sobre Content ID de Pixabay y de Incompetech, el plan gratis de Uppbeat, la Meta Sound Collection y la YouTube Audio Library fuera de YouTube. No se usaron como fuente final.

## Decisiones del operador (2026-10-22)
- **Fuente:** las 5 pistas CC0 de OpenGameArt de la sección de recomendación (gratis y sin crédito). El operador las escucha y aprueba antes de ofrecerlas, y prueba `copyright_check_status` con su cuenta antes de publicar de verdad con música.
- **Crédito:** solo pistas que no lo exigen (CC0). Kevin MacLeod (CC BY) queda fuera.
- **Mezcla:** si el video ya trae sonido, se mezclan: el sonido del video al frente y la música más baja detrás.
- **Redes:** el mismo video con música va a Instagram, X, TikTok y Discord.

## Cómo se usa en el producto (F9.5-T19)

Agregado al integrar la tarea; lo de arriba es la nota original, sin cambios.

- **Catálogo:** `packages/core/src/music/catalog.ts` (`MUSIC_TRACKS`): id, título, autor, estilo (tranquila, alegre, elegante, acústica, moderna), licencia (solo `CC0-1.0`: sin crédito, decisión del operador) y la página de origen. Los ids: `calm-piano` (Calm Piano 1, tranquila), `sunny-side-up` (Sunny Side Up, alegre), `champ-de-tournesol` (Champ de tournesol, acústica), `serenade-guitar` (Serenade Guitar, elegante) y `up-in-the-sky` (Up in the Sky, moderna). Cambiar el catálogo es cambiar ese archivo; la base guarda el id como texto (`music_track_id`), sin enum.
- **Archivos:** no van al repositorio ni los baja Claude. Viven en R2, privados, en `assets/musica/<id>.mp3`. El operador los baja de su página, los escucha, guarda la evidencia de la licencia (sección 6) y los sube con **`pnpm music:upload <carpeta>`** (`packages/storage/src/scripts/music-upload.ts`; con `ENV_FILE=.env.production`, al bucket de producción; habla con R2: lo corre el operador). El script sube solo los archivos `<id>.mp3` cuyo nombre es una pista del catálogo y que son MP3 de verdad (etiqueta ID3 o cuadro MPEG de capa III), de hasta 25 MB; informa cada archivo (con su sha256, para la evidencia) y las pistas que no vinieron. Las pistas 4 y 5 vienen en WAV u OGG: convertirlas antes con `ffmpeg -i <original> -codec:a libmp3lame -b:a 192k <id>.mp3`. Para la pista 5 (licencia triple), se usa la opción CC0.
- **Una pista sin archivo en R2** (o un id que se sacó del catálogo) no rompe nada: el reel sale sin música y la corrida avisa («todavía no está subida a la biblioteca»). El panel la marca «(todavía no está subida)» y solo ofrece **Escuchar** (una URL firmada de 10 min, `GET /music/tracks`) para las que están.
- **Mezcla (sección 5, puntos 1 y 2, ya decididos):** `MUSIC_SPEC` en `packages/media/src/pipeline.ts`: la pista se recorta al largo del video o se repite en bucle si es más corta; fundido de entrada de 0,5 s y de salida de 2 s (como mucho un tercio del video); con sonido propio del video, ese sonido al frente sin tocarlo y la música 18 dB más baja (`amix` sin normalizar); sin sonido, la música sola 3 dB más baja. AAC 48 kHz estéreo como el resto del reel.
- **Redes:** el mismo video con música va a todas (el reel para Instagram, LinkedIn y TikTok; el video para X y el de Discord). Sin crédito en ningún texto (solo CC0).
- **Pendiente del operador:** escuchar y aprobar las 5 pistas, confirmar la CC0 de origen de «Champ de tournesol» (si no se confirma, reemplazarla por «Classical Pop» o «Elevator Music» en el catálogo), y la prueba con `copyright_check_status` de la sección 2 antes de publicar de verdad con música.
