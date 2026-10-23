# 04 · Formato de publicaciones

Estándar visual y editorial de un corredor profesional. La marca de cada corredor (logo, colores, tono, hashtags) viene de la tabla `brokers`.

## Reglas editoriales (obligatorias para la IA)

1. **Solo datos entregados.** Nada de metros, distancias, amenities ni adjetivos factuales inventados. Si un dato no existe, se omite.
2. **Dirección:** si `show_exact_address = false`, solo comuna y `sector_referencia`. En Portal Inmobiliario, **nunca** en el texto (tampoco con `show_exact_address = true`): va en la ubicación del aviso (desde F4-T12).
3. **Precio con formato chileno:** `UF 5.800` · `$650.000`. En arriendo: `$650.000/mes`. Gastos comunes aparte: `GC aprox. $120.000`. La UF lleva dos decimales solo si los tiene (`UF 3.250,50`), y el peso se redondea al entero. En números que no son precio, un entero de 4 cifras va sin punto (`2018`, `1500`) y desde 5 cifras con punto (`120.000`); los decimales van con coma (`72,5`). Lo implementan `formatPrice`, `formatListingPrice` y `formatNumber` (core).
4. **Sin lenguaje discriminatorio** en requisitos (nacionalidad, hijos —también "solo adultos" o "abstenerse familias con niños", desde F5-T07: la presencia de niños es discriminación en vivienda para Meta—, estado civil, etc.). Si `requisitos_arriendo` lo trae, la IA lo omite y lo reporta como advertencia al operador.
5. **Sin superlativos vacíos** ("increíble", "único", "espectacular"). El gancho sale de un dato concreto de `destacados`.
6. **Tono:** el del corredor (`brokers.tone`); por defecto, cercano y profesional.
7. **Español de Chile**, sin garabatos ni modismos excesivos.
8. `internal_notes` nunca aparece.
9. **Que suene a una persona, no a una IA** (desde F9.5-T05, en avisos y posts): frases cortas y concretas, el dato antes que el adjetivo, sin clichés de vendedor ni muletillas de texto generado ("descubre", "sumérgete", "en el corazón de", "sin duda", "te espera", "no es solo X, es Y"; en inglés "discover", "nestled", "unlock", "seamless"…), sin tres adjetivos seguidos, sin guion largo (—) como pausa, pocos signos de exclamación (ninguno en los avisos; uno como mucho en un post) y emojis medidos, nunca seguidos. La revisión lo marca como advertencia (`AI_TELL`, [Muletillas de IA](#muletillas-de-ia-ai_tell)): el operador decide.

## Instagram — carrusel 4:5 (1080×1350)

| Slide | Contenido |
|---|---|
| 1 · Portada | Mejor foto a sangre, degradado inferior, etiqueta `VENTA` o `ARRIENDO`, precio grande, `Tipo · Comuna`, 3 íconos (m² · dorm · baños), logo en una esquina |
| 2 a N-1 | Fotos en el orden del Excel (sin la de portada), sin texto. Las etiquetas cortas ("Cocina americana") quedan para después de F2 |
| N · Ficha | Fondo con color primario: tabla de atributos con íconos, disponibilidad y contacto (WhatsApp, @usuario) |

- Máximo 10 slides, el límite de la API (`docs/integraciones/instagram.md`). Si hay más fotos, van las 8 primeras en el orden del Excel, más la portada y la ficha. La portada la elige el operador (`foto_portada`, o la primera foto); la IA no la elige ni la sugiere (spec F2, D3).
- Todo en JPEG sRGB (Instagram no acepta PNG): la portada y la ficha se renderizan con Playwright directo a JPEG.
- Tipografía: Inter (licencia OFL, `@fontsource/inter`), incrustada en las plantillas; nada se pide a la red.
- Texto dentro de márgenes seguros de 64 px.
- Muestras con datos inventados (F2-T09): [portada](assets/plantillas/portada.jpg), [ficha](assets/plantillas/ficha.jpg) y [texto del reel](assets/plantillas/texto-reel.png). Se regeneran cada vez que sube `TEMPLATES_VERSION`, con `pnpm --filter @agentsales/media run render:samples -- --out docs/assets/plantillas`.

## Instagram — caption

```
{{emoji_tipo}} {{Tipo}} en {{operación}} · {{Comuna}}
{{Gancho: 1 línea basada en un destacado concreto}}

📐 {{sup_util}} m² útiles · 🛏 {{dorm}} dorm · 🛁 {{baños}} baños{{ · 🚗 est si > 0}}
💰 {{precio_formateado}}{{ | GC aprox. $X si existe}}

{{2 o 3 líneas: entorno, conectividad, lo que la distingue (solo datos entregados)}}

📩 Escríbeme por DM o al WhatsApp {{whatsapp}}

{{5 a 12 hashtags: #{{comuna}} #{{tipo}}{{operación}} … + fixed_hashtags}}
```

- Máximo 2.200 caracteres, contando los hashtags. Si se pasa, se recorta el texto de la IA (en una palabra, con `…`) y, si no alcanza, se quita ese párrafo. Sin markdown (Instagram no lo interpreta).
- Lo arma `assembleContents` (core, F2-T05). Ejemplo con datos inventados:
  ```
  🏢 Departamento en venta · Ñuñoa
  Terraza con vista despejada para tus mañanas

  📐 72,5 m² útiles · 🛏 3 dorm · 🛁 2 baños · 🚗 1 est
  💰 UF 5.800 | GC aprox. $120.000

  Cocina remodelada y espacios bien distribuidos.

  📩 Escríbeme por DM o al WhatsApp +56 9 1111 2222
  ```
- **Emoji del tipo:** 🏢 departamento, 🏡 casa, 💼 oficina, 🏪 local comercial, 🌳 terreno o parcela, 📦 bodega, 🚗 estacionamiento y 🏠 para el resto.
- **Línea de datos:** solo los que existen; dormitorios, baños y estacionamientos solo si son más de 0, con singular (`1 baño`). Sin ninguno, la línea no va. El precio va siempre, y `| GC aprox.` solo si hay gastos comunes.
- **Contacto:** sin WhatsApp del corredor, `📩 Escríbeme por DM`.
- **Hashtags:** en `contents.hashtags`, aparte del cuerpo; el caption que se publica es el cuerpo, una línea en blanco y los hashtags separados por espacios (`instagramCaption`). Van primero `#{comuna}` y `#{tipo}{operación}`, después los fijos del corredor y al final los de la IA, normalizados (minúsculas, sin tildes, espacios ni signos: `Ñuñoa` → `#nunoa`) y sin repetir. Un hashtag de más de 50 caracteres se descarta. Si quedan menos de 5, se completan con `#{tipo}`, `#{operación}`, `#propiedades`, `#bienesraices`, `#inmobiliaria` y `#chile`; si son más de 12, salen primero los de la IA.

## Instagram — reel (con video, o con 3 fotos o más)

- 9:16, 1080×1920, MP4 H.264 (4:2:0) con AAC y `moov` al inicio. Meta acepta de 3 s a 15 min; nuestro tope es 90 s (se corta), y un video de menos de 3 s no genera reel.
- Si el video no es vertical: fondo desenfocado con el video al centro (spec F2, D5).
- Solo el primer video del aviso genera reel.
- **Sin video, con las fotos (F9.5-T18):** si la propiedad no tiene ningún video y tiene 3 fotos procesadas o más, el reel se arma con ellas: la portada primero y luego el orden del aviso, hasta 10. Cada foto dura 3 s y pasa a la siguiente con un fundido de 0,7 s (el reel dura 3 s por foto: de 9 s con 3 fotos a 30 s con 10). Cada foto va entera al centro sobre su propia imagen desenfocada (como un video horizontal), con una pista de audio silenciosa (Instagram espera audio) y el mismo texto encima los primeros 2 s. Con video, el reel sale siempre del video, aunque no sirva (por ejemplo, de menos de 3 s): las fotos no lo reemplazan. Con menos de 3 fotos y sin video, no hay reel. El panel lo dice: «Reel armado con tus fotos». Como cualquier reel, al aprobar el texto de Instagram se abre también la publicación del reel, además de la del carrusel (`publicationPlan`): un aviso sin video y con 3 fotos o más publica las dos. Parámetros en `PHOTO_REEL_SPEC` (`packages/media/src/pipeline.ts`).
- **Música (F9.5-T19):** cada propiedad y cada post con video elige una pista de la biblioteca o «Sin música» (por defecto). Solo pistas **CC0** (sin crédito: ningún texto lleva atribución; `docs/integraciones/musica-reels.md`). La pista se recorta al largo del video (o se repite si es más corta), entra con un fundido de 0,5 s y sale con uno de 2 s (como mucho un tercio del video). **Si el video trae sonido**, ese sonido va al frente tal cual y la música detrás, 18 dB más baja; **sin sonido** (un video mudo o el reel con fotos), la música va sola (3 dB bajo la pista). El **mismo video con música** va a todas las redes: el reel (Instagram, LinkedIn y TikTok), el video para X y el de Discord. Elegir otra pista cambia la clave del reel y lo rehace: en una propiedad, en la siguiente preparación («Rehacer imágenes» o `prepare --no-texts`); en un post, solo (encola `post.media`). Sin música, la clave es la de siempre (no se rehace nada). Solo los posts de video eligen música (en otro tipo, la API la rechaza). Si ffmpeg no puede leer la pista, el video sale sin música y se avisa. Una pista que el operador todavía no subió a R2 no rompe nada: el reel sale sin música y la corrida lo avisa («todavía no está subida a la biblioteca»). Parámetros en `MUSIC_SPEC` (`packages/media/src/pipeline.ts`).
- Primeros 2 segundos: texto sobrepuesto con `Operación · Tipo · Comuna · Precio`.
- Portada del reel: el cuadro del segundo 1, con el texto sobrepuesto (`thumb_offset=1000`). La portada del carrusel es 4:5 y Meta recortaría su centro 9:16 (spec F3, D12).

## Portal Inmobiliario

- **Título:** lo arma el código con operación, tipo, dormitorios y comuna, sin abreviaturas ni adjetivos y de hasta 60 caracteres (lo que recomendaría Mercado Libre para inmuebles; por confirmar en F4, `docs/integraciones/mercadolibre.md`). Formato: `{{Tipo}} en {{venta|arriendo}} {{dorm}} dormitorios {{baños}} baños en {{Comuna}}`, con singular y plural, y sin dormitorios ni baños si son 0. Ejemplo: `Departamento en venta 3 dormitorios 2 baños en Ñuñoa`. Si se pasa, se quitan primero los baños y después los dormitorios; si aún no cabe, se recorta en palabras enteras y sin terminar en `de`, `la`, `en`… (`listingTitle`, core).
- **Descripción:** texto plano, formal y sin emojis. Estructura:
  1. Párrafo de presentación (2–3 líneas).
  2. **Características:** lista con guiones.
  3. **Espacios comunes:** si existen.
  4. **Ubicación y conectividad.**
  5. **Condiciones:** disponibilidad y requisitos no discriminatorios.
  6. Cierre sin teléfono ni email ("Si te interesa, coordina una visita a través de Portal Inmobiliario."). Mercado Libre modera la descripción con teléfono, correo, dirección o sitio web (nota de Mercado Libre §9): el contacto va en el aviso (`seller_contact`), y la revisión lo marca (`CONTACT_IN_TEXT` y `ADDRESS_EXPOSED`, F4-T12).

  Como lo arma `assembleContents` (F2-T05): la presentación de la IA; `Características:` con un guion por campo con valor, en el orden de las definiciones (`- Superficie útil: 72,5 m²`, `- Gastos comunes: $120.000`, `- Amoblado: No`); `Espacios comunes:` con los `amenities`; `Ubicación y conectividad:` con el texto de la IA; `Condiciones:` con `Disponibilidad: …` y el texto de la IA (los requisitos ya filtrados), y el cierre `Si te interesa, coordina una visita a través de Portal Inmobiliario.` Una sección sin datos no va. Al final se quitan los emojis de todo el texto, también los que vengan de la planilla o de la IA (`stripEmoji`; `©`, `®` y `™` se quedan, porque van en marcas).
- **Fotos:** proporción 4:3 (1600×1200), sin texto sobrepuesto (los portales suelen penalizarlo). Mercado Libre recomendaría 1200 px y aceptaría hasta 1920 (por confirmar en F4); una foto más chica deja una advertencia. La portada va primero.
- **Atributos:** se mapean a los atributos de la categoría ML; los faltantes obligatorios bloquean la publicación (validación antes de enviar).

## Facebook Marketplace

- **Título:** el mismo de Portal (`listingTitle`). **El formulario real de Marketplace no tiene campo de título** (`fb:smoke --menus`, 2026-10-13): el título aprobado no se escribe en Facebook; el plan B del panel lo sigue copiando y `checkContent` lo sigue revisando (hasta 60 caracteres).
- **Descripción:** intermedia; admite pocos emojis. Termina con WhatsApp. Como la arma `assembleContents` (F2-T05):
  ```
  {{Introducción de la IA}}

  🏠 {{Tipo}} en {{operación}} · {{Comuna}} · {{sector_referencia}} · {{dirección si show_exact_address}}
  3 dormitorios · 2 baños · 72,5 m² útiles · 1 estacionamiento
  💰 {{precio}} · GC aprox. $X
  Disponibilidad: {{disponibilidad}}

  📲 Escríbeme al WhatsApp {{whatsapp}}
  ```
  Solo con los datos que existen. Sin WhatsApp: `📲 Escríbeme por Marketplace para coordinar una visita.`
- **Fotos:** las mismas de Portal (sin texto sobrepuesto).
- **Campos del formulario** ("Nueva vivienda", solo de arriendo; no hay operación ni título): tipo de propiedad (Casa o Apartamento o piso), precio al mes en pesos, dormitorios, baños, descripción, la ubicación (la dirección de la planilla con su comuna y región, y se elige la primera sugerencia del mapa; sin dirección, solo la comuna; spec F5, D16: `show_exact_address` no la oculta en el formulario; que Facebook muestre solo una ubicación aproximada es NO VERIFICADO y se revisa en el primer aviso real) y, si el aviso la tiene, la superficie. **Una venta no va a Marketplace.**
- **Superficie en pies cuadrados:** el formulario la pide en pies, no en m². Se convierte desde `sup_util_m2` con una regla fija: × 10,7639, redondeado al entero (como la UF a pesos, D9: un cambio de unidad, no un dato nuevo). Sin `sup_util_m2` (o en 0), el campo se deja vacío. El texto del aviso sigue en m². El operador la ve en pies cuadrados en el formulario.

## Salida estructurada de la IA

Los textos son **híbridos** (ADR-0013): el código pone los datos y la IA redacta las frases. La IA recibe un brief sin `internal_notes`, sin links ni contacto, y sin dirección si `show_exact_address = false`, y devuelve JSON validado con zod (`contentDraftSchema`, en `packages/core/src/content/`).

**El brief** (`buildContentBrief`): operación, tipo, región, comuna, `sector_referencia`, precio y gastos comunes con formato, las características (los campos definidos y con valor del corredor, sin los `url` y sin `publicar_en`; los `_clp` con `$` y los `_m2` con `m²`), `destacados`, `disponibilidad`, `amenities`, `requisitos_arriendo` (solo en arriendo) y la marca, el tono y los hashtags fijos del corredor. Nunca `internal_notes`, `_extra`, campos sin definición, links ni el contacto del corredor; la dirección y el número de unidad, solo con `show_exact_address = true`. Un campo configurable (de `attributes`) que el corredor desactivó no llega; las columnas fijas (`destacados`, comuna…) llegan siempre. **Ojo:** un campo propio que un corredor defina (por ejemplo, "Teléfono del propietario") sí llega a la IA si tiene valor; hasta F7 las definiciones las crea solo el operador (deuda en `docs/ESTADO.md`).

**El prompt** (`listing-content-v3` desde F9.5-T05, que reescribe el estilo: un corredor con oficio que le cuenta la propiedad a un cliente, frases cortas, el dato antes que el adjetivo, sin clichés ni muletillas de IA, sin signos de exclamación ni guion largo, sin pregunta retórica al inicio ni llamado a escribir al final, y hashtags que alguien buscaría, sin genéricos; antes `listing-content-v2` desde F4-T12, que sumó "en Portal no escribas la dirección", y `listing-content-v1`; `CONTENT_PROMPT_VERSION`): estas reglas van en el prompt de sistema, y los datos del aviso como JSON dentro de un bloque `<datos_del_aviso>`, con la instrucción de tratarlos solo como datos. Dentro del bloque, `<`, `>` y `&` van escapados (`\u003c`…), así un texto de la planilla no puede cerrarlo. El prompt pide además no escribir teléfonos, emails ni links, y evitar los números (los pone el código). Si la respuesta no calza, el reintento lleva la ruta de cada problema y un texto fijo (`instagram.hook: demasiado largo (máximo 150)`), nunca lo que respondió la IA.

Lo que devuelve la IA (con topes de largo en el esquema estricto: gancho 150, cuerpo 1.000, presentación 700, ubicación 600, condiciones 500, introducción 400, hasta 10 hashtags de 40 y 10 advertencias; el JSON Schema que recibe el proveedor no los lleva, porque la CLI no los aplica):

```json
{
  "instagram": { "hook": "...", "body": "...", "hashtags": ["..."] },
  "portal_inmobiliario": { "presentation": "...", "location": "...", "conditions": "..." },
  "fb_marketplace": { "intro": "..." },
  "warnings": ["Se omitió un requisito discriminatorio: ..."]
}
```

- `location` y `conditions` pueden ser `null` (sin datos, se omite la sección).
- **Lo arma el código:** la línea de tipo y comuna, la de superficies, dormitorios y baños, el precio y los gastos comunes, las listas de características y espacios comunes, la disponibilidad, el contacto, los títulos y los hashtags base (`#{comuna}`, `#{tipo}{operación}` y los fijos del corredor). Así esos datos no dependen del modelo.
- Si la salida no calza con el esquema, se reintenta una vez con el error incluido en el prompt. Si vuelve a fallar, la corrida de contenido queda `failed` con el error visible y el contenido anterior sigue vigente (ADR-0012).
- **Revisión editorial** (`checkContent`): números que no están en los datos, dirección expuesta, contacto en el texto de Portal, notas internas, requisitos discriminatorios, emojis en Portal y largos son errores; amenities no entregados, superlativos, muletillas de IA, markdown y la cantidad de hashtags son advertencias. Se muestra en el panel y la usa `pnpm eval:content` (spec F2 §4.6).

### Cómo revisa (`checkContent`, F2-T06)

Revisa el título y el cuerpo, sin mayúsculas ni tildes, y no se guarda: se calcula al leer, contra los datos actuales del aviso (un contenido viejo puede mostrar un número que ya no está si el aviso se reimportó con otro precio). También corre después de una edición a mano. Recibe el brief (los datos permitidos), el contacto y lo privado del aviso (`buildContentCheckContext`). Lo privado no sale del servidor, y los mensajes nunca citan la dirección, la unidad ni las notas.

| Código | Severidad | Cómo lo detecta |
|---|---|---|
| `NUMBER_NOT_IN_DATA` | error | Cada número del texto (`5.800`, `5800` y `72,5` se leen como el mismo valor) debe estar en algún dato del brief (precio, superficies, características, destacados, sector, disponibilidad…) o en el WhatsApp. También los números con palabras junto a una distancia o un tiempo ("a cinco minutos", "cuatro cuadras"). Un número repetido se informa una vez |
| `ADDRESS_EXPOSED` | error | Con `show_exact_address = false`, y **siempre en Portal** (desde F4-T12): cualquier palabra distintiva de la calle (5 letras o más, sin "calle", "avenida", "depto", artículos ni adjetivos frecuentes como "central"), de cualquier tramo de la dirección, en el texto o en los hashtags (`#vicunamackenna`), o el número de la unidad; en Portal con la dirección visible, también el número de la calle (sin ella, ese número ya es `NUMBER_NOT_IN_DATA`). No cuenta si esa palabra o número también está en los otros datos (por ejemplo, una calle que es el sector de referencia o la comuna, o un número que es la cantidad de dormitorios) |
| `CONTACT_IN_TEXT` | error | Solo en Portal (desde F4-T12): un teléfono (9 dígitos chilenos, con `+56`, `56` o `0` opcional, separados como mucho por espacio, guion o paréntesis: un precio con puntos o después de `$` o `UF`, un año, un RUT con puntos o después de "RUT" no cuentan; un teléfono con puntos o de 8 dígitos no se reconoce), un correo o una dirección web (`http`, `www.` o un dominio común en minúsculas como `.cl` o `.com`, sin una letra pegada antes: `Ñuñoa.Es` con el espacio olvidado no cuenta) en el título o la descripción. El mensaje no cita el dato. El WhatsApp del corredor en Instagram y Marketplace no cuenta: ahí va en el texto |
| `INTERNAL_NOTES_LEAK` | error | 6 palabras seguidas de `internal_notes` (todas, si son menos; con 1 o 2 palabras, solo si suman 8 letras o más). No cuenta un trozo que también está en los datos o en la frase que arma el código ("Departamento en venta"), uno que en el texto cruza de una frase a otra sin que las notas tengan ese mismo corte (dos datos públicos seguidos), ni las direcciones web de las notas (un slug no es prosa; el texto pegado a la URL sí se revisa). Una copia de las notas con su misma puntuación sí cuenta. Un punto corta la frase salvo entre dos dígitos (`5.800`) |
| `DISCRIMINATORY` | error | Frases que restringen o prefieren por nacionalidad, hijos, estado civil, religión, edad o sexo: "solo chilenos", "sin niños", "no se permiten niños", "no apto para niños", "preferentemente mujeres", "abstenerse extranjeros", "se requiere ser casados", "mayores de 25 años"… Una edad que no habla de personas ("antigüedad entre 5 y 10 años", "juegos para menores de 10 años") y "ideal para familias con niños" no lo son |
| `EMOJI_NOT_ALLOWED` | error | Un emoji en el título o la descripción de Portal (`©`, `®` y `™` no cuentan) |
| `TOO_LONG` | error | Caption de Instagram de más de 2.200 caracteres con los hashtags, o título de Portal o Marketplace de más de 60 |
| `AMENITY_NOT_IN_DATA` | advertencia | Un amenity o servicio cercano de la lista (piscina, quincho, terraza, metro, colegio, playa…) que no aparece en los datos. "Metros cuadrados" no es el metro, y si calza un término largo ("jardín infantil") no se repite el corto |
| `SUPERLATIVE` | advertencia | "Increíble", "único", "espectacular", "imperdible", "el mejor"… (una advertencia con todos) |
| `AI_TELL` | advertencia | Muletillas de texto escrito por IA en el título o el cuerpo (no en los hashtags), en español o inglés: una advertencia con todas ([Muletillas de IA](#muletillas-de-ia-ai_tell)) |
| `MARKDOWN` | advertencia | En Instagram: `**`, `__`, una línea que empieza con `# `, o un link `[texto](url)` |
| `HASHTAG_COUNT` | advertencia | En Instagram: menos de 5 o más de 12 hashtags |

**Límites conocidos:**
- Los números se comparan contra todos los datos juntos: "5 baños" pasa si el 5 aparece en otro dato.
- Un número con formato inglés ("72.5", "5,800") se lee distinto.
- Las notas internas no se buscan en los hashtags.

Las listas de términos viven en `packages/core/src/content/check-terms.ts`. Ampliarlas no cambia `CONTENT_PROMPT_VERSION`, porque no cambian los textos generados.

## Posts de marca: el texto por red (F9-T11, spec F9 §4.4, ADR-0030)

Un post de marca no tiene datos estructurados que ensamblar: **la IA escribe el texto completo de cada red** (ADR-0030 modifica ADR-0013 solo para posts), un texto por red **e idioma**, y el código lo valida y lo revisa. Todo vive en `packages/core/src/social/`.

**Las fuentes de hechos** (ADR-0030, punto 1). La IA solo afirma lo que está en:
- el **perfil editorial** de la marca: `facts` (lo principal: una frase por hecho), el público, la línea de contenido del post y los hashtags del perfil y de la marca, además del nombre de la marca;
- el **brief del post, solo si lo escribió o editó el operador** (`brief_origin = operator`). El brief de una idea de la IA (`brief_origin = ai`) **no viaja** a la IA ni cuenta como fuente;
- el **tema**, solo en un post manual (`source = manual`): el tema de una idea lo escribió la IA, así que viaja como tema pero no como fuente.

`avoid` no es fuente (es lo que no se usa), y nunca viajan notas internas ni nada de otra marca: el perfil y el corredor son siempre los del propio post. Sin `facts`, la IA escribe sobre ideas y criterios, sin cifras, clientes ni resultados.

**Las redes y los idiomas.** Las redes de un post son las de `POST_PLATFORMS` donde la marca tiene una cuenta no desconectada (una vencida o con error cuenta: se reconecta) **o** una cadencia en su perfil (`postPlatforms`); sin ninguna, la corrida falla con `POST_NO_PLATFORMS`. Con dos idiomas en el perfil (P4), se redacta un texto por red **en cada idioma**, el principal primero; cada uno se aprueba y se publica por separado, como publicaciones distintas de la misma cuenta, espaciadas por la cadencia. El texto en inglés no es una traducción literal.

**El prompt** (`social-post-v2` desde F9.5-T05; antes `social-post-v1`; `SOCIAL_PROMPT_VERSION`, guardado en `contents.prompt_version` y en el reporte): las reglas en el prompt de sistema y los datos como JSON en un bloque `<datos_del_post>`, escapado como el de los avisos (un brief no puede cerrarlo) y con la instrucción de tratarlo solo como datos. Reglas: solo afirmar lo de las fuentes; toda cifra, nombre propio, enlace y mención (@) debe estar tal cual en ellas; nunca `@everyone` ni `@here`; en X, un enlace solo si está en `enlaces_permitidos_en_x`; respetar `evitar`; el tono de `brokers.tone`; mayúscula solo al inicio de frase y en nombres propios (sin "Title Case"); texto plano, sin markdown; los hashtags en su lista, nunca dentro del texto, pocos y específicos, sin genéricos (Instagram y TikTok de 3 a 5, LinkedIn hasta 3, X 1 como mucho, Discord ninguno; hasta `social-post-v1` eran de 3 a 8 y 2 en X). Los largos que pide van al 90 % del máximo de cada red. **Cómo escribir** (desde v2): como alguien del equipo que conoce el tema, no como una agencia; frases cortas y concretas en voz activa; un ejemplo, un criterio o una pregunta real antes que una frase motivacional; sin clichés de marketing ni muletillas de IA (la lista del prompt nombra las más comunes en español e inglés); sin tres adjetivos seguidos; un signo de exclamación como mucho y sin guion largo como pausa; emojis: ninguno o uno que aporte, nunca seguidos (en LinkedIn y Discord, mejor ninguno); sin cierre con pregunta genérica; y el registro de cada red (X directo, LinkedIn más reflexivo en párrafos cortos, Instagram y TikTok cercanos con la idea en la primera línea, Discord como un mensaje a la comunidad).

**Lo que devuelve la IA** (`socialDraftSchema`, estricto; el JSON Schema del proveedor no lleva topes):

```json
{
  "texts": [{ "platform": "x", "language": "es", "body": "...", "hashtags": ["#..."] }],
  "warnings": ["..."]
}
```

Tiene que traer **un texto por cada red e idioma pedidos** (`validateSocialDraft`): uno que falta es un motivo de reintento (`texts: falta el texto de x en en`, sin citar a la IA); los que no se pidieron o se repiten se descartan. Los hashtags se normalizan (`#` y solo letras, con tildes y mayúsculas, números y `_`; sin repetir). Como en los avisos, se reintenta una vez y después la corrida queda `failed` con `LLM_OUTPUT_INVALID`.

### Reglas por red

El texto de cada red se mide **con los hashtags**, en un párrafo aparte separados por espacios (`joinedPostText`, como el caption de Instagram); `postTextLength` lo cuenta como lo cuenta cada red, y la usan la revisión y el contador del editor. El texto que se envía a cada red (`socialCaption`, F9-T06) debe armarse igual.

| Red | Largo | Cómo se cuenta y qué más |
|---|---|---|
| Instagram | 2.200 | En UTF-16, como hoy. Hasta 30 hashtags (contando los que vayan dentro del texto). Necesita imagen o video |
| X | 280 **ponderados** | `xWeightedLength`, sin la librería `twitter-text`: cada URL pesa 23 (también un dominio suelto como `agentpey.com`), cada emoji 2 (con sus modificadores y uniones), las letras latinas con tilde 1 y los CJK 2; el texto se normaliza a NFC. Hasta 4 imágenes o 1 video. Un enlace solo si el operador lo puso en el brief y marcó el post (ver abajo) |
| LinkedIn | 3.000 | Contando los **escapes**: el campo `commentary` exige escapar con `\` los 15 caracteres reservados <code>&#124; { } @ [ ] ( ) &lt; &gt; # \ * _ ~</code> (`escapeLinkedInText`, probada con todos; los hashtags quedan como texto). Si el límite de LinkedIn cuenta la cadena escapada o la visible no está verificado (`linkedin.md` §5.3): se mide la escapada, la más larga. El publisher (T15) envía el texto escapado |
| Discord | 2.000 | `@everyone` y `@here` impiden aprobar; además, el publisher (T14) envía siempre `allowed_mentions: { parse: [] }` y neutraliza las menciones masivas en el texto (`discord.md` §4). Hasta 10 archivos. Muestra markdown |
| TikTok | 2.200 | El texto que acompaña al video (solo video en F9) |

**Lo que se envía** (`socialCaption`, `content/assemble.ts`): en Instagram, LinkedIn, X y TikTok, el cuerpo y, tras una línea en blanco, los hashtags (`instagramCaption`); en Discord, solo el cuerpo (el prompt no le pide hashtags). Sobre eso, cada publisher aplica lo de su red: LinkedIn escapa el `commentary` (`escapeLinkedInText`), Discord neutraliza `@everyone`/`@here` y X revisa otra vez el largo ponderado. **TikTok no envía el texto:** en el modo *Upload* el video llega como borrador a la bandeja y el operador pega el texto de AgentSales en la app antes de publicar (el texto igual se revisa y se aprueba aquí).

**Enlaces en X (D6).** Un post de X con enlace cuesta US$0,20 en vez de US$0,015 (`x.md` §2). Un enlace en X necesita **dos** cosas del operador: que esté en el **brief del post** (F9-T11; uno que está en los `facts` pero no en el brief es `LINK_NOT_ALLOWED`: sirve en las demás redes, no en X) y la **marca explícita en el post** (`posts.x_link_allowed`, F9-T16: `PATCH /api/posts/:id` con `xLinkAllowed: true`, que usan `post edit <id> --x-link` en la CLI y la casilla «Permitir un enlace en X» del detalle del post en el panel). Sin la marca, la IA no recibe enlaces para X (`enlaces_permitidos_en_x` va vacío) y un enlace en el texto de X es `LINK_NOT_ALLOWED`, aunque esté en el brief; con ella, se permite con la advertencia `LINK_COST`. Al publicar, el costo estimado queda en `publications.cost_usd` y, si la marca se quitó después de aprobar, el intento falla con `X_LINK_NOT_ALLOWED` sin llamar a X.

### Cómo revisa (`checkPostContent`)

Como `checkContent`, es una función pura que corre sobre el texto final, también después de una edición a mano, y no se guarda (se calcula al leer y al aprobar; el reporte de la corrida guarda solo los códigos por red e idioma, `postChecks`). Al aprobar, editar o quitar la aprobación, el post y el perfil de su marca se leen **antes** del candado del post (`beforeContentLock` con `postReview`), porque el candado no trae ese repositorio.

| Código | Severidad | Cómo lo detecta |
|---|---|---|
| `TOO_LONG` | error | El largo de la red con los hashtags (tabla de arriba) |
| `HASHTAG_LIMIT` | error | Más de 30 hashtags en Instagram |
| `MASS_MENTION` | error | `@everyone` o `@here` (sin mirar mayúsculas), en cualquier red y en cualquier parte del texto o de los hashtags, también pegada a otra palabra (`a@everyone`, `.@here`), con caracteres de ancho cero en medio (U+200B a U+200D, U+2060, U+FEFF) o con la arroba ancha `＠` |
| `FACT_NOT_IN_PROFILE` | error | Un hecho que no está en las fuentes (heurística, abajo): una **cifra**, un posible **nombre propio**, un **enlace** o una **mención** |
| `LINK_NOT_ALLOWED` | error | En X, un enlace de las fuentes que el operador no puso en el brief del post, o cualquier enlace si el post no tiene la marca `xLinkAllowed` (F9-T16) |
| `MEDIA_NOT_SUPPORTED` | error | Un formato que la red no publica o más archivos de los que admite: Instagram con un post de solo texto; TikTok con un post que no es de video; un carrusel de Instagram con más de 10 imágenes; X con más de 4; Discord con más de 10. El operador cambia el tipo del post o quita archivos |
| `MEDIA_REQUIREMENT` | advertencia | Faltan los medios del post (F9.5-T21): «Falta la imagen» (post de imagen sin imágenes), «Faltan las imágenes del carrusel» (sin imágenes, o un carrusel de Instagram con menos de 2) o «Falta el video» (post de video sin video), cada una con el motivo en simple. **No impide redactar ni aprobar el texto**: las imágenes se suben o se consiguen después, pero publicar y programar esperan a que existan (ver abajo). Se cuentan los originales que subió el operador |
| `LINK_COST` | advertencia | X con un enlace: cuesta US$0,20 en vez de US$0,015 |
| `MEDIA_UNUSED` | advertencia | Un post de imagen con varias fotos en Instagram: sale solo la primera; para publicarlas todas, carrusel (F9-T13) |
| `AVOID_TERM` | advertencia | Algo de `avoid` del perfil (como palabra o frase completa, sin mirar tildes ni mayúsculas) |
| `AI_TELL` | advertencia | Muletillas de texto escrito por IA en el cuerpo (no en los hashtags), en cualquier red e idioma: una advertencia con todas ([Muletillas de IA](#muletillas-de-ia-ai_tell)) |
| `MARKDOWN` | advertencia | `**`, `__`, una línea que empieza con `# ` o un link `[texto](url)`, salvo en Discord |

**Un post sin imágenes todavía (F9.5-T21).** El texto se redacta (`post.draft` solo quita una red por incompatibilidad de **formato**, `kindProblem`, nunca por falta de archivos) y se aprueba aunque falten los medios: `MEDIA_REQUIREMENT` es una advertencia. Aprobar un texto de un post sin medios procesados no abre publicaciones todavía (`approveContent` tolera el `CONTENT_NOT_READY` de `planPostPublications` y lo dice con `mediaPending: true` en la respuesta, también cuando los medios están subidos pero aún se procesan; `post approve` lo usa para decir «los medios faltan o se están procesando» en vez de «sin cuenta conectada»); las abren publicar o programar cuando los medios existen. **Publicar y programar se bloquean** hasta entonces con `CONTENT_NOT_READY` y el motivo en simple («Falta la imagen del post: súbela o consíguela…»), no reintentable: `publishPost`, `schedulePost` y `schedulePublication` lo dan al pedirlo, y el reloj (`startDuePublications`) nunca intenta publicar un post sin medios: si una publicación ya programada pierde sus medios, queda `failed` con `CONTENT_NOT_READY` y no se reintenta sola (`requirePostMedia`, en `requireStartableOne`). En el panel, la pestaña de la red muestra la «!» roja **solo** con errores reales y un indicador amarillo «pendiente» cuando solo faltan los medios; el motivo de cada error y de lo que falta se ve al pasar el cursor por la pestaña y debajo de las pestañas («Instagram · español: …»), y Publicar y Programar quedan desactivados con el aviso «Falta la imagen: … Subir imágenes» (que lleva a la sección de medios).

**La heurística de hechos** (`FACT_NOT_IN_PROFILE`), contra todo el texto de las fuentes junto:
- **Cifras:** cada número del texto y de los hashtags (`5.800`, `1,000`, `2026`) debe aparecer en las fuentes; se comparan sin separadores (`1.000` y `1,000` son el mismo en los dos idiomas). No son cifras: un número pegado a una letra (`B2B`, `web3`), el marcador de una lista numerada al inicio de una línea (`1. …`, `2) …`; las cifras del resto de la línea sí se revisan) ni `24/7`.
- **Nombres propios:** una palabra con alguna mayúscula (`Banco`, `AgentPey`) que **no abre** una frase, una línea ni va tras `¿`, `¡` o una comilla, y que no está entre las palabras de las fuentes ni en una lista corta de palabras comunes con mayúscula (las redes donde se publica; los días y los meses con su nombre completo, en inglés y en español; los idiomas en inglés, `I`, y siglas como `IA`, `API`, `CEO`, `CRM`, `UF`). Las **abreviaturas** de días y meses (`Oct`, `Mon`, `Ene`, `Mié`, con o sin punto) se ignoran solo **junto a una fecha**: pegadas a una cifra (`Oct 9`, `9 oct.`, `Oct 9-12`, `26 de ene.`), a un día o mes completo, o a otra abreviatura que lo está (`Mon, Oct 9`); sueltas se revisan como cualquier nombre, porque muchas lo son (`Mon Laferte`, `Viña del Mar`). Las seguidas se informan juntas (`Banco Central`). No se marcan: las palabras **toda en mayúsculas de 2 a 6 caracteres** (`GRATIS`, `IA`, `B2B`: siglas o énfasis), ni las de una **línea con forma de título** en inglés ("How We Pick Our Networks": sin puntuación final, de 2 a 10 palabras y toda palabra de 4 letras o más con mayúscula inicial), cuyas mayúsculas son de estilo; en esa línea sí se revisan las cifras, los enlaces y las menciones. Las ciudades, regiones y países son nombres como los demás: valen si aparecen en el perfil (en un hecho, el público o una línea) o en el brief del operador; si la marca habla de su ciudad, conviene escribirla en el público o en un hecho.
- **Enlaces:** con `http`, `www.` o un dominio suelto de los frecuentes (`.com`, `.cl`, `.io`, `.ai`, `.dev`…), comparados sin protocolo, `www.`, mayúsculas ni la barra final; la ruta cuenta (`agentpey.com/precios` no es `agentpey.com`).
- **Menciones:** `@algo` debe estar en las fuentes (un correo no es una mención, pero su dominio es un enlace).

**Límites conocidos:** no ve un nombre propio escrito en minúsculas, uno que abre una frase, uno de 2 a 6 mayúsculas (`ACME`) ni uno dentro de una línea con forma de título, ni una cifra escrita con palabras ("tres clientes"); un número se acepta si aparece en cualquier fuente, aunque hable de otra cosa; y un hashtag inventado sin cifras (`#RemaxChile`) no se revisa como nombre. Un nombre real que coincide con una abreviatura de fecha pasa si va pegado a una cifra (`Mar 3`, `Sun 24`), y una abreviatura de fecha suelta (`los Lun`, `on Mon and Fri`) se marca aunque sea una fecha: el operador la corrige o la aprueba editando. La regla del prompt es la primera barrera y el operador aprueba cada texto. Ampliar la lista de palabras comunes no cambia `SOCIAL_PROMPT_VERSION`.

## Posts de marca: las tarjetas (F9.5-T25, ADR-0038)

Cuando un post no tiene fotos, «Conseguir imagen» arma **tarjetas de la marca** con sharp (US$0, sin IA). **Todo su texto sale del post o de la marca, nunca se inventa** (`postCardDeck`, `packages/core/src/post-cards.ts`; el dibujo, `createCardRenderer` en `packages/media/src/cards.ts`).

- **Qué tarjetas:** un post de **imagen**, una sola con el tema. Un **carrusel** o un **video**: una portada (el tema), una tarjeta por **punto del texto** y un **cierre** (el nombre de la marca y su `@cuenta` de Instagram o, si no tiene, su sitio sin `https://`). Hasta 8 puntos: con portada y cierre, 10 tarjetas (el tope de un carrusel). Un video pide al menos 3 tarjetas (`REEL_PHOTOS.min`): sin texto redactado es `POST_IMAGE_NEEDS_TEXT`.
- **De dónde salen los puntos:** del texto vigente de la primera red que tenga, en este orden: Instagram, LinkedIn, TikTok, Discord y X. Si el texto tiene al menos dos **viñetas** (`-`, `•`, `✓`, `1.`…), esas; si no, sus **párrafos**; si es un solo párrafo, sus **oraciones**. Se quitan los emojis (Inter no los tiene) y los hashtags, no se repite el tema ni un punto igual, y un punto de más de 180 caracteres (o una portada de más de 120) se corta en una palabra con «…».
- **Cómo se ven:** 1080×1350 (4:5) o 1080×1920 (9:16), JPEG sin metadatos. Fondo del **color principal** de la marca, una franja abajo con el **secundario**, el **logo** arriba a la izquierda dentro de un chip blanco (o el nombre de la marca si no tiene logo o no se lee), y en un punto, «2/6» arriba a la derecha. El texto en blanco o casi negro, el que contraste más con el fondo (WCAG), en Inter: 800 la portada y 600 los puntos, alineado a la izquierda y centrado en lo alto; se achica hasta caber. El cierre centra el logo, el nombre y el contacto. En macOS, Pango usa la fuente del sistema (CoreText no lee el archivo de Inter); en Linux (la CI y el servidor), Inter.
- **El video de las tarjetas:** las tarjetas 9:16 se unen con el motor del reel desde fotos (F9.5-T18), sin texto encima; la música del post (F9.5-T19) la pone después `post.media` en el reel y en los videos de X y Discord, como en un video subido.
- **No se marcan como IA** (ADR-0038 §4). Una foto de la biblioteca o una imagen con IA tampoco: la IA recibe siempre «sin texto, letras, números, logos ni marcas de agua; sin personas reconocibles» (`IMAGE_AI_RULES`), y la indicación propuesta sale del tema y la primera oración del brief (`postImageSuggestions`).

## Muletillas de IA (`AI_TELL`)

Desde F9.5-T05 (spec F9.5, D6), la revisión de los avisos (`checkContent`) y de los posts (`checkPostContent`) marca como **advertencia**, nunca como error, lo que delata un texto generado: el operador decide si lo cambia. La lista y el detector viven en `packages/core/src/content/ai-tells.ts` (`findAiTells`, puro; `listingAiTells` para el título y el cuerpo de un aviso). Una sola advertencia por texto, con todo lo encontrado: `Suena escrito por IA: «sin duda», «te espera», 3 signos de exclamación. Cámbialo por algo concreto o dilo más simple`. El panel y la CLI muestran ese mensaje.

Qué marca:
- **Frases hechas**, en español ("descubre", "sumérgete", "no es solo X, es Y", "no se trata solo de", "en el corazón de", "sin duda", "te espera", "un oasis", "ideal para quienes buscan", "no te lo pierdas", "al siguiente nivel", "en el mundo actual", "vive la experiencia", "déjate sorprender", "a la perfección", "la combinación perfecta", "de tus sueños", "cabe destacar", "¿sabías que…?", "el secreto mejor guardado", "revoluciona", "potencia tu", "en resumen", "un sinfín de", "el hogar que mereces", "sin precedentes") y en inglés ("discover", "Experience…" al inicio de una frase, "nestled", "look no further", "unlock", "elevate", "seamless", "game-changer", "in today's fast-paced world", "it's not just X, it's Y", "dive into", "delve", "tapestry", "a testament to", "boasts", "whether you're", "embark on", "in the heart of", "a haven" (no "haven't" ni "Haven Street"), "dream home", "don't miss", "unparalleled", "next level", "leverage", "harness the power", "ever-evolving", "without a doubt", "picture this"). Se compara sin mayúsculas ni tildes (con `’` como `'`) y como **palabra o frase completa**: "descubrimos" no es "descubre", "elevated" no es "elevate" y "sin dudarlo" no es "sin duda". Las dos listas se buscan en cualquier idioma.
- **Más de 2 signos de exclamación** (`!`; los `¡` no cuentan).
- **El guion largo como pausa**: un `—` entre palabras (con o sin espacios). Un guion largo al inicio de una línea (una lista) no cuenta, y el guion corto (`–`) nunca: con espacios también separa rangos ("Lunes – Viernes", "9 – 18 h").
- **Tres adjetivos seguidos** de una lista corta de los que la IA junta ("amplio, luminoso y acogedor", "simple, fast, and reliable"), con sus formas de género y número en español y con o sin la coma de Oxford. Sustantivos ("cocina, living y comedor") o dos adjetivos no cuentan.
- **Dos o más emojis seguidos** (con o sin espacios entre ellos, en la misma línea); `©`, `®` y `™` no son emojis. Los emojis sueltos del caption que arma el código no cuentan.

**Límites conocidos:** es una lista, no entiende el sentido: un uso legítimo de una frase de la lista se marca igual (por eso es advertencia), y una muletilla que no está en la lista pasa. La frase puede venir de la planilla (por ejemplo, de `destacados`) y no de la IA. Las tríadas solo se ven con los adjetivos de la lista. Un guion corto usado como pausa ("lo que importa – la luz") no se marca, para no confundirlo con un rango. "A tan solo" no está en la lista: en los avisos chilenos es normal ("a tan solo 5 minutos del metro"). Ampliar la lista no cambia las versiones de los prompts, porque la revisión se calcula al leer.

**En las evaluaciones:** `pnpm eval:content` imprime al final `Muletillas de IA: N en M textos` y `pnpm eval:social` suma `muletillas de IA N` a su conteo (`aiTells` en `SocialEvalCounts`, solo los textos, no las ideas del plan). Son advertencias: no cambian el código de salida, tampoco con `--strict`.

## Posts de marca: el plan de ideas (F9-T20, spec F9 §4.9, ADR-0030; F9.5-T06, ADR-0034)

La IA propone **ideas** para un período, no textos: cada idea queda como un post en estado `idea` (`source = ai`, `brief_origin = ai`, sin brief, sin textos ni publicaciones) y los textos se redactan recién al **aceptarla** (`post.draft`, la sección anterior). Una idea sin aceptar no gasta IA en textos ni tiene publicaciones: no se programa ni ocupa un horario del calendario de publicación. Mientras no se descarte, sí cuenta en los posts por semana de la cadencia, y ocupa su día y su hora, cuando se pide otro plan que cubre su fecha (`plannedSlots`), para que dos planes no llenen dos veces la misma semana ni la misma ranura; descartarla, o moverla fuera del período, libera ese cupo. **Desde F9.5 (ADR-0034) la IA propone qué y en qué orden, y el código agenda:** la fecha, la hora y las redes de cada idea las pone el código según la cadencia (abajo, "La ranura"). Código en `packages/core/src/social/plan.ts` (período, verificaciones, reporte), `plan-slots.ts` (las ranuras), `plan-prompt.ts` (el prompt) y `plan-sample.ts` (el plan de ejemplo de `fake`).

**Lo pedido** (`requestPlanRun`, en `plan_runs.request`): las redes (por defecto, todas las de la marca: con cuenta o con cadencia en el perfil, `postPlatforms`), el período (por defecto desde mañana y 14 días, en días de Chile; de 1 a 31 días, empezando hoy o hasta 60 días más adelante) y cuántas ideas (de 1 a 20; por defecto, los posts por semana de la red pedida que más publica por las semanas del período, o 1 por semana si ninguna tiene cadencia, la de la ranura por defecto; hasta F9, 3).

**Lo que ve la IA** (`buildPlanBrief` y `planBriefData`, solo de **su** marca): nombre, tono, público, idiomas (el tema y el porqué van en el principal), líneas de contenido con su clave y su peso, `facts`, `avoid`, el período (desde y hasta), las redes pedidas con sus **posts por semana** (desde F9.5, sin días ni horas: la fecha no la elige la IA), cuántas ideas, y lo que no repite: los **temas de los últimos 60 días** (los posts de la marca creados o planificados en ese plazo, manuales o ideas, incluidas las que esperan decisión) y las **ideas descartadas** de los mismos 60 días (las de la IA que se archivaron; después, el tema vuelve a estar disponible). Como mucho 100 de cada lista, las más recientes. Nunca `internal_notes`, los briefs de los posts ni nada de otra marca. El brief guarda además, **para el código y no para la IA**, cada día del período con su día de la semana, la cadencia completa de las redes pedidas (días y horas de Chile) y lo **ya planificado** en las semanas del período (`plannedSlots`: ideas, borradores y listos de la marca con `planned_at` en esas semanas, con su día, su hora y sus redes entre las pedidas; uno sin redes propias cuenta en todas), que ocupa su cupo semanal, su cupo del día y su ranura.

**El prompt** (`social-plan-v2` desde F9.5; antes `social-plan-v1`; `PLAN_PROMPT_VERSION`, guardado en `plan_runs.prompt_version`): las reglas en el prompt de sistema y los datos como JSON en un bloque `<datos_del_plan>`, escapado como el de los textos y con la instrucción de tratarlo solo como datos. La versión es **propia del plan**, no `SOCIAL_PROMPT_VERSION`: los dos prompts cambian por separado. Reglas: exactamente las ideas pedidas, **en orden de preferencia** (primero la que más conviene publicar), cada una con un **ángulo distinto** (no la misma idea con otras palabras ni el mismo tema en otra línea) y, entre todas, **formatos variados**; solo apoyarse en `hechos`; en el tema y el porqué, sin cifras, fechas ni nombres propios que no estén en los datos, sin enlaces ni menciones y nunca `@everyone`/`@here`; `linea` es la clave de una línea (repartidas según su peso) o `null`; `redes` son las **preferidas** para la idea, solo de las pedidas, todas las que sirvan y de la que más conviene a la que menos; Instagram necesita imagen, carrusel o video y TikTok, video; **sin fecha ni hora** (el sistema agenda según la cadencia; los posts por semana sirven para repartir las redes); no repetir ni parafrasear lo reciente ni lo descartado; respetar `evitar`; el tema, una frase corta en sentence case; el porqué, una o dos frases (por qué esta idea, esta línea y este formato).

**Salida estructurada:** `{ ideas: [{ tema, linea, redes, formato, porque }], warnings }`. El sobre se valida entero (hasta 40 ideas y 10 advertencias; si no calza, un reintento con los motivos y después `LLM_OUTPUT_INVALID`); **cada idea se valida por separado**, así una mal formada se descarta sin tumbar el plan. Una `fecha` o una `hora` que la IA mande igual (como en `social-plan-v1`) se aceptan y **se ignoran**.

**Las verificaciones** (`checkPlanIdeas`), idea por idea en el orden de la IA; una idea que no pasa se **descarta** y queda en el reporte con su código. La lista de códigos (`PLAN_DISCARD_CODES`) **solo crece**: los reportes guardados se leen con `z.enum`, así que los códigos nuevos van al final y los que ya no salen se quedan.

| Código | Cuándo |
|---|---|
| `FORMAT_INVALID` | La idea no tiene la forma pedida (falta un campo, un formato que no existe, un tema de más de 200 caracteres…) |
| `DATE_INVALID`, `OUT_OF_PERIOD`, `IN_THE_PAST` | **Ya no salen desde F9.5** (la fecha la pone el código, siempre dentro del período y desde ahora). Quedan por los reportes de antes: la fecha o la hora no existían en Chile, estaban fuera del período o ya habían pasado |
| `PILLAR_UNKNOWN` | La línea no está en el perfil (`null` sí vale) |
| `MASS_MENTION` | `@everyone` o `@here` en el tema o el porqué |
| `FACT_NOT_IN_PROFILE` | Una cifra, un posible nombre propio, un enlace o una mención del tema o el porqué que no están en el perfil (la misma heurística de `checkPostContent`, `unsupportedFacts`; las fuentes son las del perfil, `profileSources`: una idea no tiene brief del operador) |
| `REPEATED_TOPIC` | El tema repite uno de los últimos 60 días (se compara sin tildes, mayúsculas ni puntuación) |
| `DISCARDED_TOPIC` | El tema repite una idea descartada |
| `DUPLICATE_IN_PLAN` | El tema repite otra idea del mismo plan |
| `IDEA_TOO_SIMILAR` | Desde F9.5: el tema comparte el 60 % o más de sus palabras con peso (4 letras o más, sin "cómo", "para"…; `topicSimilarity`, palabras en común sobre todas las de los dos) con otra idea **anterior que quedó** en el mismo plan. Se compara con las que quedaron, no con las descartadas |
| `OVER_COUNT` | Ya hay tantas ideas como las pedidas |
| `PLATFORM_NOT_REQUESTED`, `FORMAT_NOT_SUPPORTED`, `OUT_OF_CADENCE` | Las **redes candidatas** de la idea: las preferidas que se pidieron, que admiten el formato (`kindProblem`, la misma regla que usa `post.draft`: Instagram no publica solo texto; TikTok, solo video) y cuya cadencia no es de 0 posts por semana (`OUT_OF_CADENCE`, que desde F9.5 solo sale por eso). Una red que no sirve **se le quita** a la idea (queda en sus `notes`); si no le queda ninguna, la idea se descarta con el motivo de la primera |
| `WEEK_FULL` | **Ya no sale desde F9.5**: el tope semanal lo respeta la ranura. Queda por los reportes de antes |
| `NO_SLOT` | Desde F9.5: ninguna red candidata tiene una ranura libre en el período (abajo) |

**La ranura** (`planSlotBook`, `plan-slots.ts`; spec F9.5 D7, ADR-0034), para cada idea que pasó lo anterior, en el orden de la IA:

1. **Las ranuras de cada red** son los días de su cadencia dentro del período, a cada una de sus horas (hora de Chile), desde ahora; una hora que no existe en Chile (el día que se adelanta el reloj) no es ranura. Una red **sin cadencia** usa la ranura por defecto (`PLAN_DEFAULT_SLOT`): los días hábiles (lunes a viernes) a las 10:00 con un post por semana; una red con **días u horas vacíos** toma de la ranura por defecto lo que le falta (los días hábiles o las 10:00) y conserva sus posts por semana. Una ranura está **libre** para una red si esa semana (de lunes a domingo) no llegó a sus posts por semana, si ese día no llegó a su máximo por día (el **espacio mínimo**: los posts por día justos para llegar a los de la semana en sus días, `ceil(posts por semana / días)`; uno, si le alcanzan los días) y si nada ocupa ya ese día y hora en esa red. Cuentan lo ya planificado en las semanas del período (`plannedSlots`, también en las semanas parciales del borde) y las ideas anteriores del mismo plan.
2. **La ranura de la idea** es la más temprana libre en alguna de sus redes candidatas, buscando primero en las semanas del período con menos ideas (lo planificado cuenta; a igual carga, la más temprana). Así un plan de dos semanas alterna entre ellas en vez de llenar la primera.
3. **Las redes de la idea** son las candidatas que tienen esa misma ranura libre; las demás se le quitan y quedan en sus `notes` ("LinkedIn no tiene libre la ranura del lunes 02-11 a las 10:00"). Una red que publica a otra hora no se suma a la idea: para eso el operador cambia las redes o la fecha al editarla.
4. **Sin ranura libre** en ninguna candidata, la idea se descarta con `NO_SLOT`.

**El reporte** (`planRunReportSchema`, en `plan_runs.report`): las ideas guardadas con el id de su post, el tema, la línea, sus redes, el formato, la fecha y las notas; las descartadas con su tema, código y detalle; las advertencias de la IA; y la llamada (proveedor, modelo, intentos y duración). Cero ideas válidas también es un plan terminado (`succeeded`): el reporte dice por qué. El reporte es una foto al terminar: después manda el post. Cada idea guarda **sus redes** en `posts.platforms` y, al aceptarla, `post.draft` redacta solo para esas (decisión del operador); un post manual tiene `null` (todas las de la marca). En los dos casos, `post.draft` deja fuera las redes que no sirven al tipo del post (Instagram sin imagen ni video; TikTok sin video, `kindProblem`); si no queda ninguna, `POST_NO_PLATFORMS`.

**Sin la base (T22):** `proposePlanIdeas({ llm, beforeCall?, onUsage? }, { brief, period, sources, now })` hace la llamada, la validación y las verificaciones sin escribir nada; `runPlan` la usa y guarda el resultado, y `pnpm eval:social` la usa sin guardar nada (sección siguiente).

**El plan de ejemplo** (`LLM_PROVIDER=fake`, `samplePlanResponse`): lee lo pedido del bloque de datos del prompt y entrega, sin red ni azar, las ideas pedidas **sin fecha ni hora**: cada una empieza por una red pedida (por turno), con un formato que esa red admite (por turno) y, como redes preferidas, esa y las demás pedidas que admiten el formato; con las líneas por turno y un ángulo distinto cada una (20 ángulos: dentro de un plan no se repiten ni se parecen), sin repetir lo reciente ni lo descartado. El código las agenda como las de la IA; si la cadencia no da para todas, las de sobra quedan como `NO_SLOT`.

**Límites conocidos:** con lo reciente y lo descartado, la repetición se detecta por tema igual (normalizado), no por parecido: parafrasear lo reciente queda a cargo del prompt y del operador, que acepta o descarta cada idea. El parecido entre ideas del mismo plan (`IDEA_TOO_SIMILAR`) cuenta palabras, no sentido: dos temas iguales dichos con otras palabras pasan, y dos distintos con muchas palabras en común (y pocas en total) pueden descartarse. La heurística de hechos tiene los mismos límites que la de los textos (arriba).

## La evaluación del plan y los textos (`pnpm eval:social`, F9-T22)

Mide las reglas de las dos secciones anteriores con la IA de verdad, sin la base: sobre tres marcas **inventadas** (`apps/worker/src/eval/social-profiles.ts`: una sin hechos, una con hechos y dos idiomas en cuatro redes, y una con temas recientes y descartados), corre el plan (`proposePlanIdeas`) y redacta los textos de las primeras ideas aceptadas (`draftPostTexts`, por red e idioma, con los medios que pide su formato supuestos subidos). Cuenta:

| Qué | Cómo |
|---|---|
| Ideas repetidas | Las descartadas por `REPEATED_TOPIC`, `DISCARDED_TOPIC`, `DUPLICATE_IN_PLAN` o, desde F9.5, `IDEA_TOO_SIMILAR` |
| Sin ranura | Desde F9.5, las descartadas por `NO_SLOT` (la cadencia no dio para tantas). Los descartes por fecha (`DATE_INVALID`, `OUT_OF_PERIOD`, `IN_THE_PAST`, `WEEK_FULL`) ya no ocurren |
| Ideas parecidas (advertencia) | Una aceptada que comparte el 60 % o más de sus palabras con peso con un tema del historial (`topicSimilarity`, de core, con el mismo umbral del plan, `PLAN_SIMILAR_TOPIC_THRESHOLD`): lo que la verificación no ve, porque con el historial solo compara temas iguales. Entre ideas del mismo plan, el plan ya las descarta (`IDEA_TOO_SIMILAR`) |
| Fuera del perfil | Las ideas descartadas por `FACT_NOT_IN_PROFILE` y cada `FACT_NOT_IN_PROFILE` o `LINK_NOT_ALLOWED` de los textos |
| Largos | `TOO_LONG` y `HASHTAG_LIMIT` de los textos |
| Escapes | LinkedIn que cabe sin los escapes y no con ellos; un hashtag dentro del cuerpo (va aparte y en LinkedIn saldría escapado); caracteres de ancho cero (U+200B a U+200D, U+2060, U+FEFF) o la arroba ancha (U+FF20). El markdown no cuenta aquí: es la advertencia `MARKDOWN` de la revisión y se muestra una vez, con ella |
| Menciones masivas | Ideas descartadas por `MASS_MENTION` y `MASS_MENTION` de los textos |
| Términos a evitar (advertencia) | `AVOID_TERM` de los textos |

Imprime cada idea (aceptada o descartada con su motivo) y cada texto con su revisión, y el costo estimado del plan y de los textos por separado y en total (tokens y US$ con la tabla de precios de core; `fake` y la CLI de Claude cuestan 0; si solo algunas llamadas informaron tokens, dice cuántas y marca el costo como parcial). La medición del costo con la API está en `docs/integraciones/anthropic-api.md` §13.

**Código de salida:** 1 si hubo fallas de la IA, un corte, o problemas que **llegan al operador**: textos con errores de la revisión o con problemas de escape. Las ideas que el plan descarta (repetidas, fuera del perfil, menciones masivas…) son la defensa funcionando: se muestran como estadística ("descartadas por el plan", por motivo) y no cambian la salida, salvo con `--strict`, que también sale con 1 si el plan descartó alguna. Las advertencias (parecidas y términos a evitar) nunca la cambian.

**Límite conocido: "fuera del perfil" no es una garantía.** Cuenta lo que ve la heurística de hechos de core (`unsupportedFacts` y `checkPostContent`), con sus mismos límites (sección del texto por red). En particular, no ve clientes con nombre de empresa en una línea con forma de título: "Trabajamos con Banco Estado y Falabella", sin punto final y con sus palabras largas en mayúscula, se toma como título y no se revisa como nombres (con el perfil `sin-hechos` da `[]`). Un cero en ese contador no reemplaza leer las ideas y los textos: el operador sigue aprobando cada uno.
