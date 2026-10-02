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
| 2 a N-1 | Fotos en el orden del Excel o el orden sugerido por la IA; sin texto, o una etiqueta corta opcional ("Cocina americana") |
| N · Ficha | Fondo con color primario: tabla de atributos con íconos, disponibilidad y contacto (WhatsApp, @usuario) |

- Máximo 10 slides (verificar límite de la API). Si hay más fotos, la IA elige las 8 mejores más la portada y la ficha.
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

- 9:16, 1080×1920, entre 5 y 90 s, MP4 H.264.
- Si el video es horizontal: recorte centrado, o fondo desenfocado con el video al centro.
- Primeros 2 segundos: texto sobrepuesto con `Operación · Tipo · Comuna · Precio`.
- Portada del reel: el mismo render de la portada del carrusel.

## Portal Inmobiliario

- **Título:** máximo el largo que permita la categoría (verificar). Formato: `{{Tipo}} {{dorm}}D {{baños}}B en {{Comuna}}{{, destacado corto}}`. Ejemplo: `Departamento 3D 2B en Ñuñoa, vista despejada`.
- **Descripción:** texto plano, formal y sin emojis. Estructura:
  1. Párrafo de presentación (2–3 líneas).
  2. **Características:** lista con guiones.
  3. **Espacios comunes:** si existen.
  4. **Ubicación y conectividad.**
  5. **Condiciones:** disponibilidad y requisitos no discriminatorios.
  6. Cierre con contacto.
- **Fotos:** proporción 4:3, mínimo 1200 px de ancho y sin texto sobrepuesto (los portales suelen penalizarlo). La portada va primero.
- **Atributos:** se mapean a los atributos de la categoría ML; los faltantes obligatorios bloquean la publicación (validación antes de enviar).

## Facebook Marketplace

- **Título:** corto y descriptivo, como en Portal.
- **Descripción:** intermedia; admite pocos emojis. Termina con WhatsApp.
- **Fotos:** las mismas de Portal (sin texto sobrepuesto).
- **Campos del formulario:** tipo, operación, precio, dormitorios, baños, m² y dirección aproximada según `show_exact_address`.

## Salida estructurada de la IA

La IA devuelve JSON validado con zod (esquema en `packages/core`):

```json
{
  "instagram": { "hook": "...", "caption": "...", "hashtags": ["..."] },
  "portal_inmobiliario": { "title": "...", "description": "..." },
  "fb_marketplace": { "title": "...", "description": "..." },
  "photo_order": ["media_id", "..."],
  "cover_media_id": "...",
  "slide_labels": { "media_id": "Cocina americana" },
  "warnings": ["Se omitió requisito discriminatorio: ..."]
}
```

Si la validación falla, se reintenta una vez con el error incluido en el prompt; si vuelve a fallar, el contenido queda `draft` con el error visible.
