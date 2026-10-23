# ADR-0038 · Las imágenes de un post sin medios: tarjetas propias, luego Pixabay, luego IA

- **Estado:** Aceptado
- **Fecha:** 2026-10-22

## Contexto
Un post de marca (F9) sin fotos no se puede publicar en Instagram, TikTok ni en un carrusel. El operador quiere publicar a diario desde AgentPey sin tener que buscar o diseñar imágenes cada vez. La nota `docs/integraciones/imagenes-y-videos-generados.md` compara bibliotecas de fotos (stock), imágenes con IA y video con IA: los modelos cambian de nombre y se apagan cada pocos meses, el texto dentro de una imagen de IA sigue siendo poco confiable, el video con IA cuesta entre US$0,40 y US$3 por reel y sus resultados caducan en horas.

## Decisión
1. **Tres fuentes, en este orden, siempre a pedido** (botón «Conseguir imagen» del post; nada se genera solo):
   1. **Tarjeta propia**: el título o los puntos del texto sobre los colores y el logo de la marca, hecha con sharp (US$0). Es la opción por defecto. Un video corto se arma de las tarjetas con ffmpeg y la música de F9.5-T19.
   2. **Pixabay** (stock): se busca con el tema del post, el usuario elige entre unas pocas, y el archivo **se descarga a R2** antes de usarlo (la licencia de Pixabay lo permite y no exige crédito).
   3. **Imagen con IA**: Google Nano Banana 2.1, sin texto dentro de la imagen; el título, si va, lo superpone sharp.
2. **Puertos en core**: `StockPhotoProvider` e `ImageGenerator`, con adaptadores reales y `fake` para las pruebas. **El modelo y el precio por imagen van en configuración**, no en el código. Sin SDK nuevo: `fetch` con zod.
3. **Tope de US$2 al mes por marca** para imágenes con IA, con el gasto anotado por llamada como el de texto (`cli usage`). Al llegar al tope, la generación se niega con un mensaje claro hasta el mes siguiente.
4. **Etiqueta de IA solo cuando la red la exige** (hoy, video realista en Meta y TikTok). Las imágenes generadas no se marcan. Las tarjetas y el stock nunca se marcan.
5. **Video con IA: no ahora.** Queda para una fase posterior con su propio tope.
6. **Propiedades:** stock e IA se permiten, sin leyenda, mientras sean pruebas del operador. En F9.5 se construye solo para posts. Antes de que un cliente use la app (F10) se decide de nuevo, con la norma chilena sobre imágenes referenciales.
7. Lo que se consigue entra como un medio más del post: pasa por la vista previa y la aprobación, como una foto subida.

## Consecuencias
- Un post de texto puede tener imagen en segundos y sin costo. Con la IA, unos centavos, con un tope que no se pasa.
- Cambiar de proveedor de IA es un adaptador nuevo y una variable, no un cambio de casos de uso.
- Las claves de Google AI Studio y Pixabay son trámites del operador (`docs/07-checklist-cuentas.md`). Sin claves, solo funcionan las tarjetas.
- Si Meta o TikTok empiezan a exigir etiqueta en imágenes, hay que cambiar la regla 4 (un ADR nuevo o un seguimiento aquí).

## Alternativas descartadas
- **Unsplash:** exige enlazar sus servidores (hotlinking) y dar crédito, y no tiene videos.
- **Pexels:** buena licencia, pero hoy no entrega claves nuevas de API y no está claro que permita re-hospedar.
- **OpenAI `gpt-image-2.5-flare` como principal:** cobra por tokens sin un precio fijo por imagen y exige verificar la organización. Queda como segundo adaptador posible.
- **Video con IA desde ya:** caro, lento, con resultados que caducan y modelos que se apagan; no hace falta para publicar a diario.

## Seguimiento
- **2026-10-22 (F9.5-T25, PR #249):**
  - Los adaptadores van en la subruta `@agentsales/publishers/images` (`createPixabayStock` y `createGeminiImages`): `packages/publishers` también aloja clientes de terceros que no publican, como `./uf`.
  - La IA recibe siempre «sin texto, letras, números, logos ni marcas de agua; sin personas reconocibles» (`IMAGE_AI_RULES`). La indicación propuesta sale del tema y la primera oración del brief, sin la IA de texto, y el usuario la edita.
  - El tope es una variable del servidor (`IMAGE_AI_MONTHLY_CAP_USD`), igual para todas las marcas. Si un cliente necesita otro (F10), se agrega `brokers.image_ai_monthly_cap_usd`, como `llm_monthly_cap_usd`.
  - El costo se **reserva** antes de llamar a Google, en una transacción con un candado por marca: solo si lo gastado en el mes más el precio no pasa el tope (dos pedidos a la vez de la misma marca se ordenan). Si Google rechaza el pedido antes de generar (un 429, la clave o un bloqueo de la indicación), la reserva se devuelve; un corte o una respuesta sin imagen quedan cobrados (se sobreestima, nunca se anota 0). Después de llamar, ningún error se reintenta solo: el pedido termina `failed` y el usuario pide otra imagen. Un intento cortado a medias con la reserva hecha no vuelve a llamar (`IMAGE_AI_INTERRUPTED`).

