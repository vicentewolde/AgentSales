# ADR-0042 · Cada imagen de un post puede tener su idioma

- **Estado:** Aceptado
- **Fecha:** 2026-11-11
- **Modifica a:** ADR-0038 (las tarjetas por idioma siguen igual; esto suma el idioma de lo que sube el usuario)

## Contexto
Un post de marca (F9) en dos idiomas tiene un texto por red e idioma, y cada uno se publica por separado. El operador diseña a veces una imagen en inglés y otra en español (con texto dentro de la imagen). Hasta ahora una foto subida no tenía idioma: iba con todos los textos, así que el texto «X · español» salía con la imagen en inglés. Las tarjetas de la marca ya tenían idioma (ADR-0038), pero deducido de sus pedidos, no marcado por el usuario.

En Instagram el operador publica **un solo** post bilingüe: aprueba un texto (el de `en`, con el inglés arriba y el español abajo) y quiere las dos imágenes en un carrusel, primero la del idioma del texto.

Además, al subir dos archivos en un mismo comando el orden podía quedar invertido: `sort_order` se asignaba al terminar cada subida, y las subidas de un mismo pedido nacen con la misma hora (la de la transacción), así que su orden dependía del id.

## Decisión
1. **`media.language`** (texto, nulo por defecto; `LANGUAGES` de core): el idioma de un original de un post. `null` significa «sirve para todos los idiomas», lo de siempre: los avisos y los posts de antes no cambian. En las variantes y en los avisos no se usa.
2. **Qué medios lleva un texto** (`mediaForText`, función pura en core, la misma en la publicación, la revisión, la vista previa y «Qué se publica» del panel):
   - En **X, LinkedIn, Discord y TikTok**, un texto de idioma L lleva los originales con `language = L` o `null` (y sus variantes).
   - En **Instagram**, un texto lleva **todos** los originales: primero los de su idioma y los sin idioma, después los de otros idiomas, cada grupo por `sortOrder`. Así un carrusel bilingüe sale con la imagen del idioma del texto y luego la otra.
   - Las **tarjetas** siguen su propia regla por idioma (ADR-0038) en todas las redes, también en Instagram: dos juegos de tarjetas en un carrusel serían dos portadas.
3. **Un post de imagen bilingüe es carrusel en Instagram.** Hasta ahora Instagram publicaba un post `image` con su primera foto. Si las imágenes que lleva un texto de Instagram son 2 o más y alguna está marcada en **otro** idioma, ese texto sale como carrusel (de 2 a 10, con sus reglas) y no avisa `MEDIA_UNUSED`. Es lo mínimo: no se cambia el tipo del post (en X sigue siendo una imagen por idioma) ni se agrega un tipo nuevo; sin marcas de idioma, todo sigue como antes.
4. **La revisión de cada texto cuenta los medios de ese texto** (`PostCheckContext.mediaByText`, por red e idioma): un post `image` con una imagen EN y otra ES es válido en X (una imagen por publicación), y si a un idioma no le queda ninguna, el error lo dice («las imágenes del post están marcadas en otro idioma»).
5. **Marcar el idioma** no cambia lo ya fijado: una publicación guarda sus `media_ids` al abrirse. Por eso `PATCH /posts/:id/media/:mediaId` se niega con `POST_MEDIA_IN_USE` (409) si alguna publicación del post está aprobada, programada, publicándose, fallida, esperando el clic, pausada o con resultado dudoso: se quita la aprobación, se marca y se aprueba de nuevo. Una publicada no impide marcar (ya salió). Solo en originales de un post no archivado, con `posts.manage` (lo ajeno es 404).
6. **El orden de lo subido es el del pedido.** `post_uploads.sort_order` se reserva al pedir las URLs (después de los medios del post y de las subidas pendientes, en el orden de los archivos), y `complete` y el worker (archivos grandes) crean cada medio con ese orden. `post_uploads.language` lleva hasta el medio el idioma pedido con `post upload --language`. Las subidas anteriores sin orden reservado usan el siguiente libre, como antes.

## Consecuencias
- Un post bilingüe con una imagen por idioma se publica bien en todas las redes, sin duplicar el post.
- Una migración aditiva (`media.language`, `post_uploads.sort_order` y `post_uploads.language`, todas nulas): volver a la versión anterior no rompe nada; las marcas se ignoran.
- Marcar el idioma con textos ya aprobados pide quitar la aprobación primero (un paso más, a cambio de que la vista previa y lo publicado nunca difieran).
- Las tarjetas tienen dos formas de idioma (la deducida de sus pedidos y, si alguien la marca, la columna): se aplican las dos; el panel no ofrece el selector en una tarjeta.

## Alternativas descartadas
- **Un post por idioma:** duplicaría el plan, el calendario y la aprobación, y en Instagram el operador quiere un solo post.
- **Rehacer las publicaciones pendientes al marcar el idioma:** cambiaría en silencio lo que el operador aprobó.
- **Un tipo de post nuevo («bilingüe»):** más estados y validaciones para un caso que la marca de idioma ya resuelve.
- **Ordenar al completar por la hora de la subida:** las subidas de un pedido nacen con la misma hora; hacía falta guardar la posición.
