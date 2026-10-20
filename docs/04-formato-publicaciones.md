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

## Instagram — reel (si hay video)

- 9:16, 1080×1920, MP4 H.264 (4:2:0) con AAC y `moov` al inicio. Meta acepta de 3 s a 15 min; nuestro tope es 90 s (se corta), y un video de menos de 3 s no genera reel.
- Si el video no es vertical: fondo desenfocado con el video al centro (spec F2, D5).
- Solo el primer video del aviso genera reel.
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

**El prompt** (`listing-content-v2` desde F4-T12, que suma "en Portal no escribas la dirección"; antes `listing-content-v1`; `CONTENT_PROMPT_VERSION`): estas reglas van en el prompt de sistema, y los datos del aviso como JSON dentro de un bloque `<datos_del_aviso>`, con la instrucción de tratarlos solo como datos. Dentro del bloque, `<`, `>` y `&` van escapados (`\u003c`…), así un texto de la planilla no puede cerrarlo. El prompt pide además no escribir teléfonos, emails ni links, y evitar los números (los pone el código). Si la respuesta no calza, el reintento lleva la ruta de cada problema y un texto fijo (`instagram.hook: demasiado largo (máximo 150)`), nunca lo que respondió la IA.

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
- **Revisión editorial** (`checkContent`): números que no están en los datos, dirección expuesta, contacto en el texto de Portal, notas internas, requisitos discriminatorios, emojis en Portal y largos son errores; amenities no entregados, superlativos, markdown y la cantidad de hashtags son advertencias. Se muestra en el panel y la usa `pnpm eval:content` (spec F2 §4.6).

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

**El prompt** (`social-post-v1`, `SOCIAL_PROMPT_VERSION`, guardado en `contents.prompt_version` y en el reporte): las reglas en el prompt de sistema y los datos como JSON en un bloque `<datos_del_post>`, escapado como el de los avisos (un brief no puede cerrarlo) y con la instrucción de tratarlo solo como datos. Reglas: solo afirmar lo de las fuentes; toda cifra, nombre propio, enlace y mención (@) debe estar tal cual en ellas; nunca `@everyone` ni `@here`; en X, un enlace solo si está en `enlaces_permitidos_en_x`; respetar `evitar`; el tono de `brokers.tone`; mayúscula solo al inicio de frase y en nombres propios (sin "Title Case"); texto plano, sin markdown; los hashtags en su lista, nunca dentro del texto (Instagram y TikTok de 3 a 8, LinkedIn hasta 3, X hasta 2, Discord ninguno). Los largos que pide van al 90 % del máximo de cada red.

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
| `MEDIA_REQUIREMENT` | error | Un post de video sin video (un reel exige video); Instagram sin imagen ni video; un carrusel de Instagram fuera de 2 a 10 imágenes (F9-T13; una imagen suelta usa solo la primera foto); TikTok sin video; X con más de 4 imágenes; Discord con más de 10; un post de imágenes sin imágenes. Se cuentan los originales que subió el operador |
| `LINK_COST` | advertencia | X con un enlace: cuesta US$0,20 en vez de US$0,015 |
| `MEDIA_UNUSED` | advertencia | Un post de imagen con varias fotos en Instagram: sale solo la primera; para publicarlas todas, carrusel (F9-T13) |
| `AVOID_TERM` | advertencia | Algo de `avoid` del perfil (como palabra o frase completa, sin mirar tildes ni mayúsculas) |
| `MARKDOWN` | advertencia | `**`, `__`, una línea que empieza con `# ` o un link `[texto](url)`, salvo en Discord |

**La heurística de hechos** (`FACT_NOT_IN_PROFILE`), contra todo el texto de las fuentes junto:
- **Cifras:** cada número del texto y de los hashtags (`5.800`, `1,000`, `2026`) debe aparecer en las fuentes; se comparan sin separadores (`1.000` y `1,000` son el mismo en los dos idiomas). No son cifras: un número pegado a una letra (`B2B`, `web3`), el marcador de una lista numerada al inicio de una línea (`1. …`, `2) …`; las cifras del resto de la línea sí se revisan) ni `24/7`.
- **Nombres propios:** una palabra con alguna mayúscula (`Banco`, `AgentPey`) que **no abre** una frase, una línea ni va tras `¿`, `¡` o una comilla, y que no está entre las palabras de las fuentes ni en una lista corta de palabras comunes con mayúscula (las redes donde se publica, días, meses e idiomas en inglés, `I`, y siglas como `IA`, `API`, `CEO`, `CRM`, `UF`). Las seguidas se informan juntas (`Banco Central`). No se marcan: las palabras **toda en mayúsculas de 2 a 6 caracteres** (`GRATIS`, `IA`, `B2B`: siglas o énfasis), ni las de una **línea con forma de título** en inglés ("How We Pick Our Networks": sin puntuación final, de 2 a 10 palabras y toda palabra de 4 letras o más con mayúscula inicial), cuyas mayúsculas son de estilo; en esa línea sí se revisan las cifras, los enlaces y las menciones. Las ciudades, regiones y países son nombres como los demás: valen si aparecen en el perfil (en un hecho, el público o una línea) o en el brief del operador; si la marca habla de su ciudad, conviene escribirla en el público o en un hecho.
- **Enlaces:** con `http`, `www.` o un dominio suelto de los frecuentes (`.com`, `.cl`, `.io`, `.ai`, `.dev`…), comparados sin protocolo, `www.`, mayúsculas ni la barra final; la ruta cuenta (`agentpey.com/precios` no es `agentpey.com`).
- **Menciones:** `@algo` debe estar en las fuentes (un correo no es una mención, pero su dominio es un enlace).

**Límites conocidos:** no ve un nombre propio escrito en minúsculas, uno que abre una frase, uno de 2 a 6 mayúsculas (`ACME`) ni uno dentro de una línea con forma de título, ni una cifra escrita con palabras ("tres clientes"); un número se acepta si aparece en cualquier fuente, aunque hable de otra cosa; y un hashtag inventado sin cifras (`#RemaxChile`) no se revisa como nombre. La regla del prompt es la primera barrera y el operador aprueba cada texto. Ampliar la lista de palabras comunes no cambia `SOCIAL_PROMPT_VERSION`.

## Posts de marca: el plan de ideas (F9-T20, spec F9 §4.9, ADR-0030)

La IA propone **ideas** para un período, no textos: cada idea queda como un post en estado `idea` (`source = ai`, `brief_origin = ai`, sin brief, sin textos ni publicaciones) y los textos se redactan recién al **aceptarla** (`post.draft`, la sección anterior). Una idea sin aceptar no gasta IA en textos ni tiene publicaciones: no se programa ni ocupa un horario del calendario de publicación. Mientras no se descarte, sí cuenta en los posts por semana de la cadencia cuando se pide otro plan que cubre su fecha (`plannedSlots`), para que dos planes no llenen dos veces la misma semana; descartarla, o moverla fuera del período, libera ese cupo. Código en `packages/core/src/social/plan.ts` (período, verificaciones, reporte), `plan-prompt.ts` (el prompt) y `plan-sample.ts` (el plan de ejemplo de `fake`).

**Lo pedido** (`requestPlanRun`, en `plan_runs.request`): las redes (por defecto, todas las de la marca: con cuenta o con cadencia en el perfil, `postPlatforms`), el período (por defecto desde mañana y 14 días, en días de Chile; de 1 a 31 días, empezando hoy o hasta 60 días más adelante) y cuántas ideas (de 1 a 20; por defecto, los posts por semana de la red pedida que más publica por las semanas del período, o 3 por semana si ninguna tiene cadencia).

**Lo que ve la IA** (`buildPlanBrief`, solo de **su** marca): nombre, tono, público, idiomas (el tema y el porqué van en el principal), líneas de contenido con su clave y su peso, `facts`, `avoid`, el período con **cada día y su día de la semana** (la IA no calcula calendarios), las redes pedidas con su cadencia (posts por semana, días y horas de Chile), cuántas ideas, y lo que no repite: los **temas de los últimos 60 días** (los posts de la marca creados o planificados en ese plazo, manuales o ideas, incluidas las que esperan decisión) y las **ideas descartadas** de los mismos 60 días (las de la IA que se archivaron; después, el tema vuelve a estar disponible). Como mucho 100 de cada lista, las más recientes. Además, lo **ya planificado** en el período (`plannedSlots`: ideas, borradores y listos de la marca con `planned_at` dentro del período, con sus redes entre las pedidas; uno sin redes propias cuenta en todas), que ocupa su cupo semanal. Nunca `internal_notes`, los briefs de los posts ni nada de otra marca.

**El prompt** (`social-plan-v1`, `PLAN_PROMPT_VERSION`, guardado en `plan_runs.prompt_version`): las reglas en el prompt de sistema y los datos como JSON en un bloque `<datos_del_plan>`, escapado como el de los textos y con la instrucción de tratarlo solo como datos. La versión es **propia del plan**, no `SOCIAL_PROMPT_VERSION`: los dos prompts cambian por separado. Reglas: exactamente las ideas pedidas, distintas; solo apoyarse en `hechos`; en el tema y el porqué, sin cifras ni nombres propios que no estén en los datos, sin enlaces ni menciones y nunca `@everyone`/`@here` (la fecha va solo en `fecha` y `hora`); `linea` es la clave de una línea (repartidas según su peso) o `null`; `redes` solo de las pedidas; Instagram necesita imagen, carrusel o video y TikTok, video; la fecha es un día del período y la hora, de Chile, dentro de la cadencia de cada red (días, horas y posts por semana, de lunes a domingo); no repetir ni parafrasear lo reciente ni lo descartado; respetar `evitar`; el tema, una frase corta en sentence case; el porqué, una o dos frases.

**Salida estructurada:** `{ ideas: [{ tema, linea, redes, formato, fecha, hora, porque }], warnings }`. El sobre se valida entero (hasta 40 ideas y 10 advertencias; si no calza, un reintento con los motivos y después `LLM_OUTPUT_INVALID`); **cada idea se valida por separado**, así una mal formada se descarta sin tumbar el plan.

**Las verificaciones** (`checkPlanIdeas`), en orden; una idea que no pasa se **descarta** y queda en el reporte con su código:

| Código | Cuándo |
|---|---|
| `FORMAT_INVALID` | La idea no tiene la forma pedida (falta un campo, un formato que no existe, un tema de más de 200 caracteres…) |
| `DATE_INVALID` | La fecha o la hora no existen en Chile |
| `OUT_OF_PERIOD` | La fecha está fuera del período |
| `IN_THE_PAST` | Dentro del período, pero ya pasó (el plan corrió tarde) |
| `PILLAR_UNKNOWN` | La línea no está en el perfil (`null` sí vale) |
| `MASS_MENTION` | `@everyone` o `@here` en el tema o el porqué |
| `FACT_NOT_IN_PROFILE` | Una cifra, un posible nombre propio, un enlace o una mención del tema o el porqué que no están en el perfil (la misma heurística de `checkPostContent`, `unsupportedFacts`; las fuentes son las del perfil, `profileSources`: una idea no tiene brief del operador) |
| `REPEATED_TOPIC` | El tema repite uno de los últimos 60 días (se compara sin tildes, mayúsculas ni puntuación) |
| `DISCARDED_TOPIC` | El tema repite una idea descartada |
| `DUPLICATE_IN_PLAN` | El tema repite otra idea del mismo plan |
| `OVER_COUNT` | Ya hay tantas ideas como las pedidas |
| `PLATFORM_NOT_REQUESTED`, `FORMAT_NOT_SUPPORTED`, `OUT_OF_CADENCE`, `WEEK_FULL` | Cada red de la idea: que se haya pedido, que admita el formato (`kindProblem`, la misma regla que usa `post.draft`), que el día y la hora estén en su cadencia y que la semana no tenga ya sus posts por semana (contando lo ya planificado y las ideas del plan). Una red que no sirve **se le quita** a la idea (queda en sus `notes`); si no le queda ninguna, la idea se descarta con el motivo de la primera |

**El reporte** (`planRunReportSchema`, en `plan_runs.report`): las ideas guardadas con el id de su post, el tema, la línea, sus redes, el formato, la fecha y las notas; las descartadas con su tema, código y detalle; las advertencias de la IA; y la llamada (proveedor, modelo, intentos y duración). Cero ideas válidas también es un plan terminado (`succeeded`): el reporte dice por qué. El reporte es una foto al terminar: después manda el post. Cada idea guarda **sus redes** en `posts.platforms` y, al aceptarla, `post.draft` redacta solo para esas (decisión del operador); un post manual tiene `null` (todas las de la marca). En los dos casos, `post.draft` deja fuera las redes que no sirven al tipo del post (Instagram sin imagen ni video; TikTok sin video, `kindProblem`); si no queda ninguna, `POST_NO_PLATFORMS`.

**Sin la base (T22):** `proposePlanIdeas({ llm, beforeCall?, onUsage? }, { brief, period, sources, now })` hace la llamada, la validación y las verificaciones sin escribir nada; `runPlan` la usa y guarda el resultado, y `pnpm eval:social` la usa sin guardar nada (sección siguiente).

**El plan de ejemplo** (`LLM_PROVIDER=fake`, `samplePlanResponse`): lee lo pedido del bloque de datos del prompt y entrega, sin red ni azar, las ideas pedidas de una red cada una, en los días y horas de la cadencia (las 10:00 si no tiene) sin pasar los posts por semana, repartidas en el período, con las líneas por turno y temas que no repiten lo reciente ni lo descartado. Pasan todas las verificaciones con cualquier perfil. Si el período y la cadencia no dan para todas, entrega menos con una advertencia.

**Límites conocidos:** la repetición se detecta por tema igual (normalizado), no por parecido: parafrasear lo reciente queda a cargo del prompt y del operador, que acepta o descarta cada idea. La heurística de hechos tiene los mismos límites que la de los textos (arriba).

## La evaluación del plan y los textos (`pnpm eval:social`, F9-T22)

Mide las reglas de las dos secciones anteriores con la IA de verdad, sin la base: sobre tres marcas **inventadas** (`apps/worker/src/eval/social-profiles.ts`: una sin hechos, una con hechos y dos idiomas en cuatro redes, y una con temas recientes y descartados), corre el plan (`proposePlanIdeas`) y redacta los textos de las primeras ideas aceptadas (`draftPostTexts`, por red e idioma, con los medios que pide su formato supuestos subidos). Cuenta:

| Qué | Cómo |
|---|---|
| Ideas repetidas | Las descartadas por `REPEATED_TOPIC`, `DISCARDED_TOPIC` o `DUPLICATE_IN_PLAN` |
| Ideas parecidas (advertencia) | Una aceptada que comparte el 60 % o más de sus palabras con peso (4 letras o más, sin "cómo", "para"…) con un tema del historial o con otra idea del plan: lo que la verificación no ve (arriba). El umbral queda en 60 % hasta la primera corrida real del operador; con el plan de `fake` ya marca como parecidos un mismo ángulo en dos líneas distintas |
| Fuera del perfil | Las ideas descartadas por `FACT_NOT_IN_PROFILE` y cada `FACT_NOT_IN_PROFILE` o `LINK_NOT_ALLOWED` de los textos |
| Largos | `TOO_LONG` y `HASHTAG_LIMIT` de los textos |
| Escapes | LinkedIn que cabe sin los escapes y no con ellos; un hashtag dentro del cuerpo (va aparte y en LinkedIn saldría escapado); caracteres de ancho cero (U+200B a U+200D, U+2060, U+FEFF) o la arroba ancha (U+FF20). El markdown no cuenta aquí: es la advertencia `MARKDOWN` de la revisión y se muestra una vez, con ella |
| Menciones masivas | Ideas descartadas por `MASS_MENTION` y `MASS_MENTION` de los textos |
| Términos a evitar (advertencia) | `AVOID_TERM` de los textos |

Imprime cada idea (aceptada o descartada con su motivo) y cada texto con su revisión, y el costo estimado del plan y de los textos por separado y en total (tokens y US$ con la tabla de precios de core; `fake` y la CLI de Claude cuestan 0; si solo algunas llamadas informaron tokens, dice cuántas y marca el costo como parcial). La medición del costo con la API está en `docs/integraciones/anthropic-api.md` §13.

**Código de salida:** 1 si hubo fallas de la IA, un corte, o problemas que **llegan al operador**: textos con errores de la revisión o con problemas de escape. Las ideas que el plan descarta (repetidas, fuera del perfil, menciones masivas…) son la defensa funcionando: se muestran como estadística ("descartadas por el plan", por motivo) y no cambian la salida, salvo con `--strict`, que también sale con 1 si el plan descartó alguna. Las advertencias (parecidas y términos a evitar) nunca la cambian.

**Límite conocido: "fuera del perfil" no es una garantía.** Cuenta lo que ve la heurística de hechos de core (`unsupportedFacts` y `checkPostContent`), con sus mismos límites (sección del texto por red). En particular, no ve clientes con nombre de empresa en una línea con forma de título: "Trabajamos con Banco Estado y Falabella", sin punto final y con sus palabras largas en mayúscula, se toma como título y no se revisa como nombres (con el perfil `sin-hechos` da `[]`). Un cero en ese contador no reemplaza leer las ideas y los textos: el operador sigue aprobando cada uno.
