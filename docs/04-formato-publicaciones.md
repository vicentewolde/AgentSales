# 04 · Formato de publicaciones

Estándar visual y editorial de un corredor profesional. La marca de cada corredor (logo, colores, tono, hashtags) viene de la tabla `brokers`.

## Reglas editoriales (obligatorias para la IA)

1. **Solo datos entregados.** Nada de metros, distancias, amenities ni adjetivos factuales inventados. Si un dato no existe, se omite.
2. **Dirección:** si `show_exact_address = false`, solo comuna y `sector_referencia`. En Portal Inmobiliario, **nunca** en el texto (tampoco con `show_exact_address = true`): va en la ubicación del aviso (desde F4-T12).
3. **Precio con formato chileno:** `UF 5.800` · `$650.000`. En arriendo: `$650.000/mes`. Gastos comunes aparte: `GC aprox. $120.000`. La UF lleva dos decimales solo si los tiene (`UF 3.250,50`), y el peso se redondea al entero. En números que no son precio, un entero de 4 cifras va sin punto (`2018`, `1500`) y desde 5 cifras con punto (`120.000`); los decimales van con coma (`72,5`). Lo implementan `formatPrice`, `formatListingPrice` y `formatNumber` (core).
4. **Sin lenguaje discriminatorio** en requisitos (nacionalidad, hijos, estado civil, etc.). Si `requisitos_arriendo` lo trae, la IA lo omite y lo reporta como advertencia al operador.
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

- **Título:** el mismo de Portal (`listingTitle`).
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
- **Campos del formulario:** tipo, operación, precio, dormitorios, baños, m² y dirección aproximada según `show_exact_address`.

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
| `ADDRESS_EXPOSED` | error | Con `show_exact_address = false`, y **siempre en Portal** (desde F4-T12): cualquier palabra distintiva de la calle (5 letras o más, sin "calle", "avenida", "depto", artículos ni adjetivos frecuentes como "central"), de cualquier tramo de la dirección, en el texto o en los hashtags (`#vicunamackenna`), o el número de la unidad; en Portal, también el número de la dirección. No cuenta si esa palabra o número también está en los otros datos (por ejemplo, una calle que es el sector de referencia o la comuna, o un número que es la cantidad de dormitorios) |
| `CONTACT_IN_TEXT` | error | Solo en Portal (desde F4-T12): un teléfono (9 dígitos chilenos, con `+56` opcional, separados como mucho por espacio, guion o paréntesis: un precio con puntos, un año o un RUT no cuentan), un correo o una dirección web (`http`, `www.` o un dominio común como `.cl` o `.com`) en el título o la descripción. El mensaje no cita el dato. El WhatsApp del corredor en Instagram y Marketplace no cuenta: ahí va en el texto |
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
