# Spec F9.7 · Editar sin sorpresas y una IA que conoce la marca

- **Estado:** Aprobado por el operador el 2026-11-15 (partes A y B; en curso)
- **Rama base:** `main`
- **Tag al cerrar:** `v1.7.0`
- **Referencias:** `docs/specs/fase-9-contenido-de-marca.md` (§4.10 editar post, redes del post), `docs/specs/fase-9.5-lista-para-mostrar.md` (T25 tarjetas, ADR-0038), `docs/04-formato-publicaciones.md`, `docs/marca/agentpey/DISENO.md`, ADR-0030 (fuentes de hechos), ADR-0038 (imágenes de un post sin medios)

## 1. Objetivo
El operador edita un post y ve el cambio reflejado en el mismo post (una red agregada trae su texto), rehace un solo texto, trabaja solo en los idiomas que usa y entiende Seguimiento de un vistazo (parte A). Además, la IA conoce la marca: su postura, su tono, sus ejemplos y las novedades de sus proyectos, y las imágenes salen con el manual de diseño de la marca sin diseñarlas a mano en el chat (parte B).

## 2. Alcance

### Parte A · Editar sin sorpresas (aprobada; dos ramas en curso)
- A1. Agregar una red a un post ya redactado: la IA redacta solo esa red, sin tocar los otros textos.
- A2. Quitar una red: aviso previo con las publicaciones que lo impiden y cancelarlas ahí mismo; los textos de la red quitada se pliegan bajo «Redes quitadas» (no se borran).
- A3. Cambiar la fecha con publicaciones programadas: el panel ofrece moverlas (nunca solas).
- A4. Cambiar el tipo: aviso arriba con lo que falta y las redes que no sirven.
- A5. Cambiar tema o brief después de redactar: aviso con «Pedir textos nuevos».
- A6. «Rehacer este texto» (red + idioma) con una indicación opcional de forma o tono.
- A7. Idiomas de la marca y del post: un idioma quitado no se redacta ni da alertas; columna `posts.languages` (null = los de la marca).
- A8. Falsa alarma `FACT_NOT_IN_PROFILE` en inglés con gentilicios y plurales comunes («AIs», «Chilean»).
- A9. Seguimiento: encabezados «Post» / «Redes», tarjetas en el celular, «Cancelada» en vez de «Sin programar».
- A10. Calendario: los borradores se ven distintos de lo programado, con leyenda.
- A11. Hashtags que siempre van: en Mi marca, la lista de hashtags fijos (se agregan al final en Instagram, X y LinkedIn) y «¿La IA puede agregar otros?» (por defecto No con hashtags fijos).

### Parte B · La IA conoce la marca
- B1. **Conocimiento de la marca** en «Mi marca», además del perfil actual (público, temas, hechos, evitar, cadencia):
  - **Qué queremos transmitir** (postura): hasta 2.000 caracteres.
  - **Tono y forma de contar**: hasta 2.000 caracteres (para AgentPey: relato con escena concreta, al estilo del newsletter de Molly «The New Rules Of Discovery»; nada de «post de venta»).
  - **Ejemplos que me gustan**: hasta 10 textos (cada uno hasta 3.000 caracteres) con una nota de por qué. Son guía de **forma**, nunca fuente de hechos.
  - **Novedades de los proyectos**: entradas con fecha, proyecto (p. ej. «AgentPey en Stellar», «Comercios · Start-Up Chile») y texto (hasta 1.000 caracteres). Son **fuente de hechos** como los hechos del perfil (las escribe o aprueba el operador).
- B2. **Actualizar desde un texto largo**: el operador pega un texto (un informe, notas de una reunión, el README de un proyecto; hasta 20.000 caracteres) y la IA **propone** novedades y hechos; el operador aprueba, edita o descarta cada uno. Nada entra al conocimiento sin su aprobación.
- B3. La IA usa el conocimiento al **proponer ideas** (plan) y al **redactar** (todos los textos, incluso «Rehacer este texto»), con un límite de tamaño: postura y tono completos, hasta 3 ejemplos (los marcados como favoritos primero) y las novedades de los últimos 90 días (hasta 20).
- B4. **Estilo de imágenes de la marca** («manual de diseño» en datos): colores, fuentes (de una lista incluida en el sistema), logo (SVG o PNG transparente), márgenes y **hasta 4 temas de color que se rotan**, uno por post. Se edita en «Mi marca» con vista previa, o se carga con `brand style --file estilo.json`. Para AgentPey, Claude traduce `docs/marca/agentpey/DISENO.md` a ese archivo y el operador lo aprueba.
- B5. **Textos de las láminas**: al redactar un post de imagen o carrusel, la IA escribe también el texto de cada lámina (titular de hasta 8 palabras, subtítulo de hasta 20, y en el carrusel una lámina por punto), con la misma revisión de hechos y evitar que los textos. Se editan en el post.
- B6. **Láminas con el estilo de la marca**: «Conseguir imagen → Tarjetas de la marca» dibuja las láminas con el estilo de B4 y el texto de B5, en 2 composiciones («Anuncio»: logo, objeto central, titular y subtítulo; «Explicar»: titular y tarjetas en grilla) y en 4:5, 1:1 y 9:16. Sin estilo cargado, sigue el dibujo de hoy. Costo US$0 (no usa IA de imágenes).
- B8. **Ortografía de los textos editados a mano**: al guardar un texto editado, la revisión marca palabras mal escritas (aviso, no error), con la sugerencia; sin IA (diccionario es/en incluido) o, si no alcanza, con una llamada corta y barata que respeta el tope de la marca.
- B9. **Vista previa real de cada red**: el post muestra cómo se ve en X (con 2 a 4 imágenes, la cuadrícula recortada como la recorta X), en Instagram (4:5 y la cuadrícula del perfil) y en LinkedIn (imagen o PDF); si en X se cortan textos de las láminas, sugiere publicarlo como hilo.
- B10. **Recordatorio de «Ya lo publiqué»**: una publicación a mano aprobada o programada cuya hora pasó hace más de 12 horas aparece en «Hoy» y en la agenda como «¿Salió?», con «Ya lo publiqué» (pegar enlace o sin enlace) y «No salió».
- B7. **Carrusel para LinkedIn en PDF**: «Descargar PDF para LinkedIn» une las láminas de un carrusel en un PDF (LinkedIn muestra un PDF como carrusel; varias imágenes quedan en cuadrícula recortada).

## 3. Fuera de alcance
- Leer solo un repositorio de GitHub o un sitio para traer novedades (B2 es pegar texto; la lectura automática queda para después de usar B2 un tiempo).
- Generar imágenes con IA según el manual (las láminas se dibujan; la IA de imágenes de ADR-0038 sigue igual).
- Interpretar un manual en PDF o Markdown cualquiera: el estilo se guarda como datos (B4); Claude o el operador lo traducen.
- Video con el estilo de la marca (los reels siguen como hoy).

## 4. Diseño

### 4.1 Componentes afectados
- `packages/core`: perfil editorial (conocimiento), casos de uso de conocimiento y propuestas, prompts del plan y de los textos (`docs/04-formato-publicaciones.md`), `postCardDeck` con los textos de las láminas, el tema de cada post.
- `packages/llm`: prompt nuevo «proponer novedades desde un texto», y la salida estructurada de los textos con las láminas.
- `packages/media`: el dibujante de láminas con estilo (sharp + SVG, sin navegador); la fuente Inter Tight; el PDF de LinkedIn.
- `packages/db`: tablas nuevas (4.3).
- `apps/api`, `apps/cli`, `apps/web`: «Mi marca» (Conocimiento y Estilo de imágenes), propuestas, láminas en el post y el PDF.

### 4.2 Contratos
- `GET/PUT /brokers/:slug/knowledge` (postura, tono, ejemplos); `POST/PATCH/DELETE /brokers/:slug/knowledge/updates` (novedades; borrar es archivar).
- `POST /brokers/:slug/knowledge/proposals` `{ text }` → corrida de IA; `GET` lista las propuestas; `POST /…/proposals/:id/accept|discard` (aceptar con edición).
- `GET/PUT /brokers/:slug/card-style` (valida con zod; colores `#RRGGBB`, fuentes de la lista, hasta 4 temas); `POST /brokers/:slug/card-style/preview` → una lámina de muestra.
- `GET /posts/:id/linkedin-pdf` → el PDF de las láminas del idioma pedido.
- CLI: `brand knowledge show|edit [--stance --tone --file]`, `brand update add|list|archive`, `brand propose --file <texto>` y `brand proposals accept|discard <id>`, `brand style show|edit --file estilo.json|footer|preview`, `post cards-text <id>` (ver y editar los textos de las láminas), `post pdf <id> [--language es]`.

### 4.3 Datos (migraciones aditivas)
- `brand_knowledge` (broker_id PK, stance, tone, updated_at).
- `brand_knowledge_examples` (id, broker_id, text, note, favorite, created_at).
- `brand_knowledge_updates` (id, broker_id, project, date, text, source: `operator|proposal`, archived_at, created_at).
- `brand_knowledge_proposals` (id, broker_id, run_id, kind: `update|fact`, text, project, status: `pending|accepted|discarded`, created_at).
- `brand_card_styles` (broker_id PK, style jsonb validado en core, version, updated_at).
- `posts.card_theme` (int null: el tema de la rotación que le tocó; se fija la primera vez para que rehacer dé lo mismo) y `post_card_texts` (post_id, language, position, role, headline, subtitle, approved).

### 4.4 Decisiones
- **D1. Ejemplos = forma, novedades = hechos.** La revisión de hechos (`FACT_NOT_IN_PROFILE`) cuenta como fuente el perfil, el brief del operador y las novedades; nunca los ejemplos. El prompt lo dice explícito (ADR-0030 sigue valiendo).
- **D2. Nada entra al conocimiento sin el operador** (B2 propone, el operador aprueba).
- **D3. El estilo es datos, no un archivo libre.** Un esquema acotado (colores, fuentes de una lista, temas, márgenes, logo) que el dibujante sabe usar; un manual nuevo se traduce a ese esquema.
- **D4. Dibujar sin navegador.** Se mantiene sharp + SVG (ADR-0038 §1.1). Dependencia nueva justificada: `@fontsource/inter-tight` (OFL), igual que Inter hoy. El PDF con una dependencia pequeña de PDF (`pdf-lib`, MIT) o con sharp si alcanza; se decide en la tarea y se justifica en el PR.
- **D5. Tope de tamaño del prompt** (B3) para que el costo por texto no suba más de un 30 % (se mide con `pnpm eval:social`).
- ADR nuevo: **ADR-0042 · Conocimiento y estilo de la marca** (D1 a D4).

## 5. Tareas

### F9.7-T01 · Conocimiento de la marca (B1, B3)
- **Depende de:** —
- **Hecho cuando:** tablas, repositorio, API, CLI y la sección «Conocimiento» de Mi marca; el plan y los textos lo usan con el tope; la revisión de hechos cuenta las novedades y no los ejemplos; tests y `pnpm eval:social` con un perfil de prueba con conocimiento.

### F9.7-T02 · Propuestas desde un texto (B2)
- **Depende de:** T01
- **Hecho cuando:** pegar un texto crea una corrida; las propuestas se aceptan (con edición) o descartan; respeta el tope de gasto de IA de la marca; tests con un LLM falso.

### F9.7-T03 · Estilo de imágenes de la marca (B4)
- **Depende de:** —
- **Hecho cuando:** esquema en core, tabla, API, CLI y editor con vista previa en Mi marca; `docs/marca/agentpey/estilo.json` traducido de DISENO.md (y DISENO.md en git); tests del esquema.

### F9.7-T04 · Textos de las láminas (B5)
- **Depende de:** —
- **Hecho cuando:** la redacción de un post de imagen o carrusel trae los textos de las láminas por idioma, con revisión; se ven y editan en el post; tests.

### F9.7-T06 · Ortografía, vista previa por red y recordatorio (B8 a B10)
- **Depende de:** —
- **Hecho cuando:** los tres puntos con tests; la vista previa de X reproduce el recorte de la cuadrícula; el recordatorio no aparece para lo ya confirmado ni para redes por API.

### F9.7-T05 · Láminas con estilo y PDF para LinkedIn (B6, B7)
- **Depende de:** T03, T04
- **Hecho cuando:** las dos composiciones en 4:5, 1:1 y 9:16 con los 4 temas, rotación fija por post, vista previa en el post, «Descargar PDF para LinkedIn»; pruebas de imagen (tamaño, contraste mínimo 4,5:1 del texto, que el texto cabe) y una revisión de diseño con capturas reales antes de fusionar.

## 6. Criterios de aceptación de la fase
- [ ] Agregar LinkedIn a un post de Instagram y X hace aparecer su texto en el mismo post, sin tocar los otros (A1).
- [ ] Con la marca solo en español, ningún texto ni alerta en inglés aparece en posts nuevos (A7).
- [ ] Un plan nuevo de AgentPey propone ideas que usan al menos una novedad reciente y su tono (B1, B3), sin hechos fuera de perfil, brief y novedades.
- [ ] Un carrusel de AgentPey sale con láminas en el estilo de DISENO.md, sin que Claude las diseñe en el chat, y se baja como PDF para LinkedIn (B4 a B7).

## 7. Plan de demo
1. En un post de Instagram y X, marcar LinkedIn y guardar: aparece «Redactando LinkedIn…» y luego su texto.
2. «Rehacer este texto» en X con «más corto».
3. En Mi marca, dejar solo español; abrir un post nuevo: sin inglés.
4. En Mi marca → Conocimiento, pegar las notas de la semana de AgentPey, aceptar 2 propuestas y pedir un plan.
5. Aceptar una idea de carrusel, «Tarjetas de la marca» y «Descargar PDF para LinkedIn».

## 8. Riesgos y mitigaciones
- **La IA copia hechos de los ejemplos:** D1 más la revisión de hechos; los ejemplos no cuentan como fuente.
- **Prompt más caro:** tope (D5) y medición con `eval:social`.
- **Láminas feas o ilegibles con otro estilo:** contraste comprobado en tests y revisión de diseño con capturas antes de fusionar.
- **Dos ramas con migraciones a la vez:** se renumera al fusionar; las migraciones son aditivas.

## 9. Notas de la implementación (parte B, rama `feat/f97-lote-2-marca`)
- El ADR es **ADR-0043** (el 0042 ya era «el idioma de cada imagen»).
- Las rutas usan el id del corredor, como el resto de `/brokers/:id` (no el slug): `/brokers/:id/knowledge`, `/knowledge/updates`, `/knowledge/proposals`, `/knowledge/runs/:runId`, `/brokers/:id/card-style` (y `/preview`), `/posts/:id/card-texts` y `/posts/:id/linkedin-pdf`.
- Se sumó `brand_knowledge_runs` (la corrida de B2: texto, estado y gasto, que entra al tope de IA); la migración es la **0028** (todo aditivo).
- El conocimiento viaja con el perfil (`editorialProfilesWithKnowledge`): así llega a redactar, rehacer, agregar una red, revisar, aprobar y al plan sin tocar esos casos de uso.
- Las láminas se piden solo en la redacción completa (no al rehacer un texto ni al agregar una red).
- El PDF de LinkedIn se escribe a mano (sin `pdf-lib`): solo imágenes JPEG, una por página.
- La ortografía (B8) es una lista acotada por idioma, sin dependencia ni IA (sin costo y sin falsos positivos con nombres de marca).
- El logo del estilo va dentro del JSON (SVG sin scripts ni referencias externas, o PNG en base64), no como medio en R2.
- «¿Salió?» (B10): para una aprobada o programada, «Ya lo publiqué» la registra con su enlace (`post record`) y «No salió» la cancela.

### Ajuste de láminas y vista previa (rama `fix/laminas-espaciado-y-redes`, `CARD_RENDER_VERSION` 4)
- **Titular con interlineado parejo:** el titular se dibuja en una sola pasada de texto (una capa con la parte normal y otra idéntica con solo la parte destacada, pintada con el degradado), así todas las líneas quedan a la misma distancia; además se angosta el ancho mientras no cambie el número de líneas, para que no quede una palabra sola abajo.
- **Sin subtítulo:** ya era válido en core, API y panel (cadena vacía); ahora el dibujante centra el bloque (medalla + titular [+ subtítulo]) entre el logo y el pie con el mismo aire arriba y abajo. CLI: `post cards-text <id> --language es --clear-subtitle`.
- **1:1:** el texto queda dentro del centro de 3:4 (márgenes laterales de 135 px) porque la cuadrícula del perfil de Instagram recorta a 3:4. El panel sugiere 1:1 si el post va a X o LinkedIn.
- **Vista previa (B9):** una sola imagen en X, LinkedIn y Discord se muestra entera (antes se recortaba a 4:3, un recorte que esas redes no hacen); la cuadrícula de varias imágenes sí recorta.
- **Qué hacen las redes (lo confirmado y lo no):** no hay documentación oficial de X con las proporciones del feed; las guías de terceros coinciden en que 4:5 y 1:1 se ven completas, pero sus límites exactos difieren. LinkedIn (página oficial de anuncios) prefiere 4:5 en móvil; para publicaciones orgánicas solo hay guías de terceros. Instagram pasó el perfil a una cuadrícula 3:4 (comunicado por su jefe, cubierto por la prensa; no hay página oficial verificada): 1:1 se recorta a los lados y 4:5 apenas. Conviene una prueba real con un post antes de afirmarlo.

### Pie y puntos clave en las láminas del servidor (rama `feat/laminas-pie-y-puntos-servidor`, `CARD_RENDER_VERSION` 5)
- **Pie:** el estilo suma `footer` opcional (`website`, `instagram`, `x`; sin migración: va en el JSON del estilo, y uno sin `footer` sigue valiendo). El pie de las láminas con estilo es solo «sitio · {instagram} usuario · {x} usuario» (`cardFooterParts` y `cardFooterText` en core); cada parte sale del estilo, si no del sitio o el Instagram de la marca y, al final, del usuario de su cuenta de Instagram (también la «a mano») o de X que no esté revocada. Lo que no está en ninguna parte no va; sin nada, la lámina va sin pie. También en un carrusel va solo eso, sin el número de la lámina (lo decidió el operador el 2026-11-21); el cierre lo muestra bajo el nombre de la marca, con sus íconos. Se edita en Mi marca («Pie de las láminas») y con `brand style footer`; `GET/PUT /brokers/:id/card-style` devuelve el pie que sale (`footer`), y la lámina de muestra lo usa. Las tarjetas sin estilo siguen con su contacto de siempre.
- **Post de imagen con puntos:** un post de imagen guarda la portada y hasta 3 puntos (`CARD_TEXT_LIMITS.imagePoints`: caben en la grilla de 1:1). Con puntos, el worker dibuja su única imagen en «Explicar» (en «Anuncio» no caben), con las cifras grandes (`figureOf`); sin puntos, la composición pedida. La IA sigue escribiendo solo la portada de un post de imagen (`slidesFor`): los puntos los pone el operador.
