# ADR-0043 · Conocimiento y estilo de la marca

- **Estado:** Aceptado
- **Fecha:** 2026-11-15
- **Modifica a:** ADR-0030 (punto 1: las novedades de los proyectos también son fuente de hechos) y ADR-0038 (punto 1.1: las tarjetas propias pueden dibujarse con el estilo de la marca)

## Contexto
El perfil editorial (ADR-0030) le dice a la IA a quién habla la marca, sus temas, sus hechos y lo que evita, pero no **cómo** cuenta las cosas ni **qué pasó** en sus proyectos esta semana: los textos salen correctos y genéricos, y el operador corrige el tono a mano. Además, las imágenes de AgentPey se diseñaron a mano en el chat (`docs/marca/agentpey/DISENO.md`, «estilo Apple» con cuatro temas que se rotan), y las tarjetas propias (ADR-0038) no las pueden reproducir: solo conocen dos colores y un logo.

El spec F9.7 (parte B) pide que la IA conozca la marca (postura, tono, ejemplos y novedades) y que las láminas salgan con el manual de diseño de la marca, sin diseñarlas en el chat.

## Decisión
1. **Ejemplos = forma; novedades = hechos (D1).** El conocimiento de la marca tiene cuatro partes: la postura («qué queremos transmitir»), el tono y la forma de contar, hasta 10 ejemplos de textos que gustan (con una nota) y las novedades de los proyectos (fecha, proyecto y texto). Las **novedades** son fuente de hechos como los hechos del perfil: entran en `profileSources`, así que la revisión `FACT_NOT_IN_PROFILE` y la de las ideas del plan las cuentan. Los **ejemplos**, la postura y el tono **nunca** son fuente de hechos: el prompt lo dice explícito y la revisión no los mira. Así una cifra copiada de un ejemplo se marca como siempre.
2. **Nada entra al conocimiento sin el operador (D2).** «Actualizar desde un texto largo» es una corrida de IA (`brand_knowledge_runs`, job `brand.propose`) que solo **propone** novedades y hechos (`brand_knowledge_proposals`, `pending`); el operador acepta (con edición), o descarta cada una. Una propuesta aceptada como novedad queda con `source = proposal`; como hecho, se suma a los hechos del perfil. La corrida entra al tope de IA del mes de la marca (`sumLlmCost` la suma), como los planes.
3. **El conocimiento viaja con el perfil.** `editorialProfilesWithKnowledge` (core) envuelve el repositorio del perfil: su `get` agrega `knowledge` (lo que ve la IA, ya con el tope de B3: postura y tono completos, hasta 3 ejemplos con los favoritos primero, y las novedades de los últimos 90 días, hasta 20). Así redactar, rehacer, revisar, aprobar y el plan lo ven igual sin cambiar sus casos de uso. Las apps arman el repositorio envuelto.
4. **El estilo es datos, no un archivo libre (D3).** `brand_card_styles.style` es un esquema acotado en core (`cardStyleSchema`): colores `#RRGGBB`, fuentes de una lista incluida en el sistema (`CARD_FONTS`), márgenes, el logo (SVG o PNG transparente, guardado como medio) y de 1 a 4 temas (fondo plano o degradado, texto, secundario, acento, degradado del titular, tarjeta y tarjeta héroe). El dibujante solo sabe usar ese esquema; un manual nuevo se traduce a él (para AgentPey, `docs/marca/agentpey/estilo.json`, traducido de `DISENO.md`).
5. **Dibujar sin navegador (D4).** Las láminas con estilo se dibujan con sharp + SVG, como las tarjetas de ADR-0038, en dos composiciones («Anuncio»: logo, objeto central, titular y subtítulo; «Explicar»: titular y tarjetas en grilla) y en 4:5, 1:1 y 9:16. Sin estilo cargado, las tarjetas siguen como hoy. El tema de un post se fija la primera vez (`posts.card_theme`, rotando entre los de la marca), así rehacer da lo mismo.
6. **Textos de las láminas.** Al redactar un post de imagen o carrusel, la IA escribe también el texto de cada lámina (titular de hasta 8 palabras y subtítulo de hasta 20; en el carrusel, una por punto), por idioma (`post_card_texts`), con la misma revisión de hechos y de «evitar» que los textos. Se editan en el post; una lámina editada a mano no se pisa al redactar de nuevo salvo «reemplazar ediciones».
7. **El PDF de LinkedIn sin dependencias.** «Descargar PDF para LinkedIn» une las láminas JPEG de un carrusel en un PDF escrito a mano (cada página es una imagen con `DCTDecode`): no hace falta `pdf-lib`.

## Consecuencias
- La IA escribe con la voz de la marca y las novedades de la semana sin que el operador copie notas al brief; el costo por texto sube por el contexto, con un tope fijo (D5 del spec: medir con `pnpm eval:social`).
- El operador mantiene el conocimiento: si una novedad es falsa, la archiva y deja de ser fuente.
- Un estilo nuevo (otra marca) es un JSON validado, no código; lo que el esquema no tiene (íconos, fotos de fondo, animaciones) no se puede pedir hasta ampliarlo con otro ADR o un seguimiento aquí.
- Dependencia nueva: `@fontsource/inter-tight` (OFL), igual que `@fontsource/inter`.

## Alternativas descartadas
- **Leer un repositorio o un sitio para traer novedades solo:** fuentes que no controlamos y datos con apariencia de verdad (ADR-0030); queda para después de usar B2 un tiempo.
- **Que los ejemplos también sean fuente de hechos:** la IA copiaría cifras y nombres de un texto viejo como si fueran de hoy.
- **Guardar el manual como Markdown o PDF e interpretarlo al dibujar:** no se puede validar ni probar; un esquema acotado sí.
- **Dibujar con el navegador (Playwright) para usar CSS:** más lento y pesado en el worker; sharp + SVG ya dibuja las tarjetas.
- **`pdf-lib` para el PDF:** innecesario para páginas que son solo una imagen JPEG.
