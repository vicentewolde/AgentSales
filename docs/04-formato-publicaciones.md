# 04 · Formato de publicaciones

Estándar visual y editorial de un corredor profesional. La marca de cada corredor (logo, colores, tono, hashtags) viene de la tabla `brokers`.

## Reglas editoriales (obligatorias para la IA)

1. **Solo datos entregados.** Nada de metros, distancias, amenities ni adjetivos factuales inventados. Si un dato no existe, se omite.
2. **Dirección:** si `show_exact_address = false`, solo comuna y `sector_referencia`.
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
- Tipografía: una sans geométrica (ej. Inter o Montserrat) cargada localmente en las plantillas.
- Texto dentro de márgenes seguros de 64 px.

## Instagram — caption

```
{{emoji_tipo}} {{Tipo}} en {{Operación}} · {{Comuna}}
{{Gancho: 1 línea basada en un destacado concreto}}

📐 {{sup_util}} m² útiles · 🛏 {{dorm}} dorm · 🛁 {{baños}} baños{{ · 🚗 est si > 0}}
💰 {{precio_formateado}}{{ | GC aprox. $X si existe}}

{{2 o 3 líneas: entorno, conectividad, lo que la distingue (solo datos entregados)}}

📩 Escríbeme por DM o al WhatsApp {{whatsapp}}

{{5 a 12 hashtags: #{{comuna}} #{{tipo}}{{operación}} … + fixed_hashtags}}
```

- Máximo 2.200 caracteres. Sin markdown (Instagram no lo interpreta).

## Instagram — reel (si hay video)

- 9:16, 1080×1920, MP4 H.264 (4:2:0) con AAC y `moov` al inicio. Meta acepta de 3 s a 15 min; nuestro tope es 90 s (se corta), y un video de menos de 3 s no genera reel.
- Si el video no es vertical: fondo desenfocado con el video al centro (spec F2, D5).
- Solo el primer video del aviso genera reel.
- Primeros 2 segundos: texto sobrepuesto con `Operación · Tipo · Comuna · Precio`.
- Portada del reel: el mismo render de la portada del carrusel (se envía en F3).

## Portal Inmobiliario

- **Título:** lo arma el código, sin abreviaturas ni adjetivos y de hasta 60 caracteres (lo que recomienda Mercado Libre para inmuebles; por confirmar en F4, `docs/integraciones/mercadolibre.md`). Formato: `{{Tipo}} {{dorm}} dormitorios {{baños}} baños en {{Comuna}}`. Ejemplo: `Departamento 3 dormitorios 2 baños en Ñuñoa`. Si se pasa, se quitan primero los baños y después los dormitorios.
- **Descripción:** texto plano, formal y sin emojis. Estructura:
  1. Párrafo de presentación (2–3 líneas).
  2. **Características:** lista con guiones.
  3. **Espacios comunes:** si existen.
  4. **Ubicación y conectividad.**
  5. **Condiciones:** disponibilidad y requisitos no discriminatorios.
  6. Cierre sin teléfono ni email: las reglas de Mercado Libre sobre datos de contacto en la descripción se verifican en F4.
- **Fotos:** proporción 4:3 (1600×1200), sin texto sobrepuesto (los portales suelen penalizarlo). Mercado Libre recomienda 1200 px y acepta hasta 1920; una foto más chica deja una advertencia. La portada va primero.
- **Atributos:** se mapean a los atributos de la categoría ML; los faltantes obligatorios bloquean la publicación (validación antes de enviar).

## Facebook Marketplace

- **Título:** corto y descriptivo, como en Portal.
- **Descripción:** intermedia; admite pocos emojis. Termina con WhatsApp.
- **Fotos:** las mismas de Portal (sin texto sobrepuesto).
- **Campos del formulario:** tipo, operación, precio, dormitorios, baños, m² y dirección aproximada según `show_exact_address`.

## Salida estructurada de la IA

Los textos son **híbridos** (ADR-0013): el código pone los datos y la IA redacta las frases. La IA recibe un brief sin `internal_notes`, sin links ni contacto, y sin dirección si `show_exact_address = false`, y devuelve JSON validado con zod (`contentDraftSchema`, en `packages/core/src/content/`):

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
- **Revisión editorial** (`checkContent`): números que no están en los datos, dirección expuesta, notas internas, requisitos discriminatorios, emojis en Portal y largos son errores; amenities no entregados, superlativos, markdown y la cantidad de hashtags son advertencias. Se muestra en el panel y la usa `pnpm eval:content` (spec F2 §4.6).
