# AgentPey · guía para quien publica (resumen, 2026-11-15)

Para el agente (o la persona) que solo publica los posts de AgentPey. Las mejoras de AgentSales se hacen en otro agente: aquí solo se usa. Todo lo de abajo es lo que ya existe en el sitio https://agentsales.agentpey.com.

## Reglas
- Nada se publica sin el OK del operador (Vinny) sobre el texto exacto y la hora. Desplegar y todo lo de Fly es del operador.
- X, Instagram y LinkedIn se publican **a mano**: AgentSales arma el texto y la imagen, el operador copia, pega y publica, y después marca «Ya lo publiqué» (con el enlace o sin él).
- Solo datos del perfil de la marca (`brand show --broker agentpey`) y del brief del post. No inventar cifras ni citas. Ojo con el hecho 13 del perfil (116 respuestas, 5 tiendas, 19): no se sabe de dónde salió la medición ni qué quiere decir «en su lugar aparecen Falabella, Sodimac y Mercado Libre»; no usarlo para nombrar tiendas hasta comprobarlo.
- Evitar nombrar tiendas concretas ni prometer que una IA recomendará o venderá más.
- Textos solo en español por ahora (los de inglés quedan sin aprobar). Decir «catálogo» en vez de «ficha». Estilo: relato con escena concreta (como el newsletter de Molly), no «post de venta».
- Hashtags: los fijos de la marca van siempre al final; el operador puede agregar otros a mano.

## Imágenes
- Estilo de la marca (colores, fuentes, logo, temas): `docs/marca/agentpey/estilo.json`, ya cargado en la marca. Manual completo: `DISENO.md`. Otros colores listos para usar: `colores-alternativos.json` (verde menta, gris claro, naranja, amarillo; en vivo desde 2026-11-16: Medianoche, Verde menta, Amarillo y Blanco).
- Formato recomendado: **1:1** (se ve completo en Instagram, X y LinkedIn); 4:5 para solo Instagram; 9:16 para historias y reels. Composiciones: `announce` (medalla y titular) y `explain` (titular y tarjetas).
- Una portada **sin subtítulo**: `pnpm -s cli post cards-text <id> --language es --clear-subtitle`. Imagen: `pnpm -s cli post media <id> --card --format 1:1 --composition announce --language es --replace`. Costo US$0.
- Carrusel para LinkedIn: `pnpm -s cli post pdf <id> --language es` (LinkedIn muestra un PDF como carrusel).
- Cambiar los temas de color de la marca: editar `estilo.json` (hasta 4 temas) y cargar con `pnpm -s cli brand style edit --broker agentpey --file docs/marca/agentpey/estilo.json`.

## Flujo de un post
1. `post create` / aceptar una idea del plan → `post draft <id>` (textos) → `post edit` / «Rehacer este texto» con una indicación.
2. Imagen (arriba), revisar la vista previa de cada red en el post (panel: Contenido).
3. `post approve <id>`, programar o publicar con el operador, y confirmar con «Ya lo publiqué».
4. Pendientes del día: `pnpm -s cli agenda` y «Hoy» en el panel (incluye «¿Salió?»).
