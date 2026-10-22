# Imágenes y videos para un post sin medios: biblioteca (stock), IA y tarjetas propias

Nota de investigación, consultada el **2026-10-22**. Sirve para decidir cómo AgentSales consigue medios cuando un post se crea sin fotos ni videos: (a) buscarlos en una biblioteca de stock, (b) generar imágenes con IA, (c) generar videos con IA, y (d) la línea base sin IA (tarjetas propias). No se descargó ni se generó nada, no se hizo ninguna llamada a una API y no se usó ninguna cuenta; solo se leyeron páginas públicas.

Convención: **DOC** = documentación o página oficial del titular; **TERCERO** = blog, agregador o resumen de terceros (solo pista, nunca fuente final); **INFERENCIA** = deducido; **NO VERIFICADO** = falta prueba y se propone cómo probarlo.

Aviso de método: las páginas se leyeron con una herramienta que extrae y resume el texto, no en el navegador. Las citas cortas pueden tener paráfrasis. Los precios de IA cambian cada pocas semanas (varios modelos cambiaron o se retiraron en septiembre y octubre de 2026): antes de fijar un presupuesto, abrir la página de precios en el navegador. Nada de esta nota debe quedar fijo en el código. Esto no es asesoría legal.

## 1. Resumen

- **Stock: la mejor opción para re-hospedar es Pixabay.** Su API pide descargar a nuestro servidor las imágenes que se van a usar (prohíbe el hotlinking permanente), no exige atribución en la licencia, tiene fotos y videos, y da 100 peticiones por minuto (DOC). Pexels tiene licencia y límites buenos (fotos y videos, sin atribución obligatoria en la licencia, 200 por hora), pero **hoy no entrega claves nuevas de API** (DOC, pendiente de confirmar en el navegador). Unsplash **exige hotlinking** y atribución, y sus términos limitan la API a apps propias: no sirve para descargar y re-hospedar (DOC). Unsplash no tiene videos.
- **Imagen con IA: Google Nano Banana 2.1 (`gemini-nano-banana-2.1`) es la opción barata** (unos US$0,034 por imagen de 1K, DOC), con proporciones 4:5 y 9:16 nativas. OpenAI `gpt-image-2.5-flare` es el segundo candidato, pero su precio por imagen no está publicado (solo por tokens): NO VERIFICADO. **El texto dentro de la imagen sigue siendo poco confiable en todos** (OpenAI lo reconoce): el texto va superpuesto por nosotros con sharp o Playwright.
- **Video con IA: no vale la pena ahora.** Cuesta entre US$0,05 y US$0,40 por segundo; un reel de 8 s vale entre US$0,40 y US$3 por intento, con espera de minutos y entregas que caducan en 24 a 48 horas. Sora ya no existe como API (cerró el 24-sep-2026, DOC). Si se agrega, que sea imagen a video corto desde una imagen nuestra con Runway `gen4_turbo` (US$0,05 por segundo, DOC), con tope aparte.
- **Etiquetas de IA: se declaran por API en Instagram (`is_ai_generated`) y TikTok (`is_aigc`); en X, LinkedIn y Discord no hay campo conocido.** Meta exige etiqueta solo para video fotorrealista y audio realista, no para imágenes (DOC). Como sharp quita los metadatos (INFERENCIA), la marca C2PA del proveedor no sobrevive: hay que enviar la declaración nosotros.
- **Recomendación (sección 8):** línea base de tarjetas propias (US$0) como primera opción; Pixabay para fotos y videos de ambiente; Nano Banana 2.1 para una imagen generada cuando la marca la pida; tope de US$2 al mes por marca. Costo por post entre US$0 y unos US$0,20.

## 2. Biblioteca de imágenes y videos (stock)

Criterios: uso comercial en posts de redes de clientes, atribución, si se pueden descargar y re-hospedar en R2, límites, y si hay fotos y videos.

### 2.1 Tabla comparativa

| Dato | Pixabay | Pexels | Unsplash |
|---|---|---|---|
| Fotos y videos | Ambos (`/api/` y `/api/videos/`) | Ambos (`/v1/search`, `/v1/videos/search`) | **Solo fotos** (la doc leída no menciona video) |
| Costo de la API | Gratis | Gratis | Gratis |
| Uso comercial | Sí, con restricciones | Sí, con restricciones | Sí, con restricciones |
| Atribución en la licencia | No exigida | No exigida | No exigida (la licencia); **sí exigida por los términos de la API** |
| Atribución en la API | "Pide" mostrar de dónde vienen cuando se muestran resultados | Exige un enlace visible a Pexels y pide crédito al fotógrafo "cuando sea posible" | **Exige** crédito al fotógrafo y a Unsplash, con enlace a su perfil, cada vez que se muestra una imagen |
| Descargar y re-hospedar en nuestro almacenamiento | **Sí, es lo que pide**: no se permite el hotlinking permanente; las imágenes que se usen deben bajarse. Videos: se pueden incrustar, pero recomienda guardarlos | **No lo dice** la doc leída: NO VERIFICADO | **No: exige hotlinking** de las URL que devuelve la API ("material breach" si no). Guardar copias no se trata: NO VERIFICADO |
| Límite de peticiones | 100 por 60 s por clave. Cache obligatorio de 24 h. Prohíbe descargas masivas y sistemáticas | 200 por hora y 20.000 al mes; se puede pedir más, gratis, si se cumple con los términos | Demo: 50 por hora. Producción (con aprobación): 1.000 por hora. Las descargas desde `images.unsplash.com` no cuentan |
| Tamaño máximo con la clave básica | Imágenes hasta 1280 px (`largeImageURL`); 1920 px y original solo con acceso completo aprobado. Videos hasta 1080p o 4K | NO VERIFICADO (no se leyó la tabla de tamaños) | URLs con parámetros de tamaño (no se leyó el detalle) |
| Clave nueva hoy | Sí (NO VERIFICADO: no se leyó el flujo) | **"New API key issuance is currently paused and cannot be requested"** (DOC; sin fecha de reapertura) | Sí, con registro (NO VERIFICADO) |
| Contenido generado con IA mezclado en los resultados | Sí puede haber: las subidas con IA deben ir marcadas, pero la doc de la API no dice cómo filtrarlas | Los usuarios no pueden subir IA generativa (DOC: términos, 7B) | No aplica |
| Veredicto para AgentSales | **Recomendada** | Respaldo si se logra una clave | **Descartada** para re-hospedar |

### 2.2 Datos y fuentes por proveedor

**Pixabay (DOC)**
- Licencia: se puede usar y modificar gratis, también comercialmente; atribución no requerida, solo apreciada. Prohibido venderlo o distribuirlo "standalone" (sin esfuerzo creativo y sustancialmente igual), usarlo como marca, nombre comercial o marca de servicio, usarlo de forma engañosa, y usar contenido con marcas reconocibles en bienes o servicios. Las personas reconocibles no pueden mostrarse de forma inmoral o ilegal. Hay que revisar el consentimiento de terceros: algunos contenidos llevan derechos aparte. Fuente: [Pixabay Content License](https://pixabay.com/service/license-summary/) (2026-10-22).
- Términos: prohíben copiar contenido de forma masiva, sistemática o a gran escala sin permiso, y construir un servicio competidor (Sección 8). Fuente: [Términos de servicio](https://pixabay.com/service/terms/) (2026-10-22). Un post suelto con una foto buscada por un usuario no es copia masiva (INFERENCIA); descargar un catálogo para tenerlo propio sí lo sería.
- API: 100 peticiones por 60 s, respuesta cacheada 24 h, 429 si se excede, sin hotlinking permanente, una vía separada para videos con cuatro tamaños (large, medium, small, tiny). Fuente: [Pixabay API](https://pixabay.com/api/docs/) (2026-10-22).
- **Riesgo para fotos del corredor:** una foto de stock no es la propiedad. Usarla en el post de un aviso real puede inducir a error (INFERENCIA). Debe quedar fuera de los posts de avisos, o marcada como "imagen referencial".
- Que el volumen de un producto con varios clientes cuente como "uso humano real" de la API: NO VERIFICADO. Prueba: pedir a Pixabay (la doc dice que pueden subir el límite a integraciones bien hechas) y describir el caso.

**Pexels (DOC)**
- Licencia: todo es gratis para uso comercial y se puede modificar; no exige crédito. No permitido: mostrar a personas identificables de forma ofensiva, vender copias sin modificar, **sugerir que personas o marcas respaldan tu producto con la imagen**, redistribuir en otras plataformas de stock, y usarlo como marca. Fuente: [Pexels License](https://www.pexels.com/license/) (2026-10-22).
- API: 200 por hora y 20.000 al mes por defecto, con encabezados `X-Ratelimit-*`; "desarrolladores que cumplan los términos pueden obtener peticiones ilimitadas gratis". Exige un enlace visible a Pexels y pide crédito al fotógrafo. No se pueden copiar ni replicar sus funciones centrales (por ejemplo, apps de fondos de pantalla). Fuente: [Pexels API](https://www.pexels.com/api/documentation/) (2026-10-22).
- **Claves nuevas pausadas:** la página [pexels.com/api](https://www.pexels.com/api/) dice dos veces "New API key issuance is currently paused and cannot be requested" (2026-10-22). Confirmar en el navegador antes de apoyarse en Pexels.
- Términos generales: "bulk, large-scale or systematic copying" prohibido sin permiso, y el scraping para entrenar modelos de ML. Fuente: [Términos](https://www.pexels.com/terms-of-service/) (2026-10-22).
- Re-hospedar los archivos: el artículo de ayuda y la página de términos de la API no se pudieron leer (`help.pexels.com` dio 403; `/api/terms/` dio 404). NO VERIFICADO. Prueba: escribir a Pexels o leer la ayuda en el navegador.
- Fotos y videos: endpoints `GET /v1/search`, `/v1/curated`, `/v1/photos/:id`, `GET /v1/videos/search`, `/v1/videos/popular`, `/v1/videos/videos/:id`.

**Unsplash (DOC)**
- Licencia: uso comercial sin permiso; atribución no requerida, solo sugerida; no se pueden vender imágenes sin modificarlas ni compilarlas para crear un servicio parecido. Fuente: [Unsplash License](https://unsplash.com/license) (2026-10-22).
- Términos de la API: sirven solo para "desarrollar y operar tus propias Developer Apps", las credenciales son personales y **no se pueden vincular a productos de terceros**; se debe "usar o incrustar directamente" las URL que devuelve la API (hotlinking), reportar cada descarga y dar crédito al fotógrafo y a Unsplash con enlace a su perfil; los términos no tratan la copia o cache de las imágenes. Pueden cobrar una "tarifa de tecnología" a negocios que usan mucho la API. Fuentes: [API Terms](https://unsplash.com/api-terms) y [Guidelines](https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines) (2026-10-22).
- Para publicar en Instagram necesitamos un archivo propio en una URL pública nuestra (la foto sale de nuestro almacenamiento), y Unsplash exige hotlinking: las dos cosas chocan (INFERENCIA). Sin atribución visible dentro de una foto de Instagram tampoco se cumple el requisito. Descartada.

### 2.3 Otras fuentes

| Fuente | Qué se sabe | Veredicto |
|---|---|---|
| **Openverse** (API de Automattic, imágenes con licencia Creative Commons) | La doc enumera filtro de licencia, filtro comercial, atribución y límites para anónimos y registrados, pero la extracción no trajo los números. Casi todo es CC BY o CC BY-SA, es decir, **exige atribución** y no se puede poner en una foto de Instagram sin texto aparte (INFERENCIA) | Descartada para el MVP (NO VERIFICADO el detalle) |
| **Shutterstock API** | Cuenta gratuita de prueba: 500 descargas al mes y 100 llamadas por hora; los planes de pago no tienen precio público (resultado de búsqueda de la página oficial `code.shutterstock.com/api/pricing`, no leída entera). Las licencias de uso por cliente exigen condiciones propias | Fuera del MVP: es de pago por contrato |
| **Getty Images** | Sin información útil sobre API ni precios en lo leído | Fuera del MVP |

Fuentes: [Openverse API](https://api.openverse.org/v1/) y la búsqueda sobre Shutterstock (2026-10-22).

## 3. Imágenes con IA por API

### 3.1 Resumen de proveedores

Todos los precios son por imagen, en dólares, salvo que se diga otra cosa. Los modelos y precios cambiaron mucho entre septiembre y octubre de 2026.

| Proveedor y modelo | Precio por imagen | Tamaños y proporciones | Texto en la imagen | Estado |
|---|---|---|---|---|
| **Google `gemini-nano-banana-2.1`** (Nano Banana 2.1, octubre 2026) | 1K: ~US$0,0336; 2K: ~US$0,0504; 4K: ~US$0,113; lotes (batch) a mitad de precio. Sin plan gratis en la API | 1K, 2K y 4K; proporciones incluyen 4:5 y 9:16 (la lista dice que `gemini-3.1-flash-lite-image` las agrega; si Nano Banana 2.1 también las acepta: NO VERIFICADO) | "Texto legible y estilizado" según Google (DOC); calidad real: NO VERIFICADO | Vigente |
| **Google `gemini-3.1-flash-image`** (Nano Banana 2) | 0,5K: ~US$0,045; 1K: ~US$0,067; 2K: ~US$0,101; 4K: ~US$0,151 | Igual | Igual | Vigente |
| **Google `gemini-3.1-flash-lite-image`** | 1K: ~US$0,0336 | Solo 1K; agrega 4:5 y 9:16 | Igual | Vigente |
| **Google `gemini-3-pro-image`** (Nano Banana Pro) | 1K y 2K: ~US$0,134; 4K: ~US$0,24 | Igual | Mejor texto (TERCERO) | Vigente |
| **Google `gemini-2.5-flash-image`** | ~US$0,039 | Hasta 1024x1024 | - | **Se apaga el 2-oct-2026** (ya cerrado) |
| **Google Imagen 4** | Un resumen de terceros dice que se apagó el 17-ago-2026 en la API de Gemini; la página de precios oficial no lista Imagen | - | - | NO VERIFICADO (probable retirado) |
| **OpenAI `gpt-image-2.5-flare`** (rápido) y **`gpt-image-2.5-sunburst`** (edición precisa) | **No hay tabla por imagen**: solo tokens: salida de imagen US$30 por millón (lotes US$15), entrada de imagen US$8, entrada de texto US$5. El costo por imagen sale del campo `usage` de la respuesta | Medidas libres múltiplos de 16, relación largo/corto máxima 3:1; hasta 3840 px de arista (sobre 2560x1440 es experimental) | "Texto, consistencia de personajes y control de diseño siguen siendo imperfectos" (DOC) | Vigente. Exige **verificación de la organización** (DOC) |
| **OpenAI `gpt-image-2`** (referencia de precios) | Calidad media: US$0,053 en 1024x1024 y **US$0,041 en 1024x1536**. Baja ~US$0,005 y alta ~US$0,165 en 1024x1536 (TERCERO que cita la guía) | Igual | Igual | Vigente como referencia; el precio de 2.5 por imagen: NO VERIFICADO |
| **OpenAI `gpt-image-1`, `-mini`, `-1.5`** | - | - | - | **Se apagan: `gpt-image-1` el 23-oct-2026; `-mini`, `-1.5` y `chatgpt-image-latest` el 1-dic-2026** (DOC). No usarlos |
| **Black Forest Labs FLUX** (FLUX 3 Image, FLUX.2 pro/max/klein) | Créditos de US$0,01; la calculadora mostraba US$0,048 por defecto sin decir el modelo; la tabla por modelo no cargó. Por megapíxel (FLUX.2) o por nivel de resolución (FLUX 3) | No se leyó | No se leyó | Precio exacto: NO VERIFICADO |
| **Ideogram** (`ideogram-4-5` en el ejemplo) | Créditos de US$0,01; los precios por modelo no se cargaron en la página. Prepago de US$10 a US$300 (tope de saldo US$300). 10 solicitudes en curso por defecto | No se leyó | Es el modelo históricamente fuerte en texto (TERCERO) | Precio exacto: NO VERIFICADO |
| **Recraft** | V4.1 Flash US$0,007; V4.1 US$0,035; V4 y V3 US$0,04; vectorial US$0,08; "Pro" a 2K entre US$0,21 y US$0,25 | No se leyó | No se leyó | Vigente (DOC, precios) |
| **Stability AI** | Stable Image Core ~US$0,03; Ultra ~US$0,08; crédito = US$0,01 (TERCERO, sin página oficial leída) | No se leyó | No se leyó | Precios: TERCERO |
| **Luma `uni-1`, `uni-1-max`** (API de agentes) | No se leyó el precio. Imágenes de 30 a 60 s | No se leyó | No se leyó | NO VERIFICADO |
| **Runway** (imágenes) | `gen4_image` 5 créditos (720p) u 8 (1080p); `gen4_image_turbo` 2; `nano_banana_2.1` 4 por 1K; `gpt image 2` por calidad. Un crédito = US$0,01 | - | - | Vigente. Runway sirve de puerta a varios modelos con una sola cuenta |

Fuentes: [Precios de la API de Gemini](https://ai.google.dev/gemini-api/docs/pricing) y [generación de imágenes de Gemini](https://ai.google.dev/gemini-api/docs/image-generation) (2026-10-22); [Precios de OpenAI](https://developers.openai.com/api/docs/pricing), [guía de imágenes de OpenAI](https://developers.openai.com/api/docs/guides/image-generation), [modelo gpt-image-2.5-flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare) y [bajas programadas](https://developers.openai.com/api/docs/deprecations) (2026-10-22); [precios de BFL](https://docs.bfl.ai/quick_start/pricing) y [bfl.ai/pricing](https://bfl.ai/pricing) (2026-10-22); [Ideogram API](https://developer.ideogram.ai/ideogram-api/api-setup) y [precios](https://ideogram.ai/pricing/?pricing_tab=api) (2026-10-22); [Recraft precios](https://www.recraft.ai/docs/api-reference/pricing.md) (2026-10-22); [Runway precios](https://docs.dev.runwayml.com/guides/pricing/) (2026-10-22); [Stability, tercero](https://developer.puter.com/tutorials/stability-ai-api-pricing/) (2026-10-22, TERCERO).

### 3.2 Tamaños para redes

- Instagram: vertical 4:5 de 1080x1350, y 9:16 de 1080x1920 para reels e historias. TikTok: 9:16. X, LinkedIn y Discord aceptan 1:1, 4:5 o 16:9 (revisar los docs de cada red en `docs/integraciones/`).
- Nano Banana acepta 4:5 y 9:16 y devuelve 1K o más: la relación correcta sale directo; luego `sharp` recorta o escala a 1080x1350 o 1080x1920 (1K ya cubre el ancho de 1080).
- OpenAI exige múltiplos de 16 por lado: 1080x1350 no cumple (1080 no es múltiplo de 16); pedir **1088x1360** (relación 4:5) o 1536x1024/1024x1536 y recortar. 1080x1920 tampoco: pedir **1088x1920** (relación 1,76, dentro del máximo de 3:1) y recortar. Es INFERENCIA a partir de la regla "múltiplos de 16, relación máxima 3:1"; probar con una sola llamada.
- Cualquiera sea el proveedor, el producto debe recortar a la medida exacta con sharp y revisar el resultado.

### 3.3 Texto dentro de la imagen

- OpenAI lo dice en su doc: el texto es "imperfecto". Google promete texto "legible" pero no mide la calidad. Ideogram y Recraft tienen fama de mejor texto (TERCERO, no verificado aquí).
- **Regla de diseño sugerida (INFERENCIA):** pedir a la IA imágenes sin texto y poner el título, precio, teléfono y logo con la plantilla de la marca (sharp o Playwright). Se evitan errores de ortografía en español, nombres o cifras inventadas, y se respeta la regla del proyecto de "solo datos entregados".

### 3.4 Términos de uso comercial y retención

- **Google:** "no reclamamos propiedad" del contenido; los servicios pagos no usan los prompts ni las respuestas para mejorar los productos de Google; Google puede generar contenido igual o parecido para otros; la ley puede exigir atribuir el contenido generado a tus usuarios. Todas las imágenes llevan marca SynthID. Fuente: [Términos de la API de Gemini](https://ai.google.dev/gemini-api/terms) y la guía de imágenes (2026-10-22).
- **OpenAI:** las imágenes de ChatGPT, Codex y la API llevan metadatos C2PA y una marca SynthID (TERCERO: resumen de resultados de búsqueda sobre el artículo de ayuda; la página oficial dio 403). Exige un `safety_identifier` estable y con hash por usuario final (DOC) y la verificación de la organización. Los términos de servicio (propiedad de los resultados) no se pudieron leer: **NO VERIFICADO**.
- **Ideogram:** "no reclamamos propiedad de tus imágenes y eres libre de usarlas para cualquier propósito, incluido el comercial" (DOC: [precios](https://ideogram.ai/pricing/?pricing_tab=api)). Los enlaces de las imágenes caducan: hay que descargar y guardar.
- **BFL:** las licencias comerciales se separan en niveles (Builder, Platform, Professional, Enterprise); FLUX.2 [dev] es "no comercial". Para un SaaS multi-cliente, "Builder" cubre FLUX 3 Image Klein y FLUX.2 [klein] con 10.000 imágenes al mes y 1 dominio (DOC: [bfl.ai/pricing](https://bfl.ai/pricing)); hay que leer si esos límites alcanzan antes de usarlo. La API pura "pay as you go" no explica los términos de salida: NO VERIFICADO.
- **Runway:** los resultados caducan en 24 a 48 horas desde que se piden ("descárgalos y guárdalos en tu almacenamiento"); si se piden demasiadas generaciones moderadas, suspenden la cuenta (DOC).
- Que cada proveedor deje usar la imagen en un producto que se revende a corredores: NO VERIFICADO salvo los casos citados. Prueba: leer los términos completos de los dos proveedores elegidos antes de lanzar y guardar copia del texto con la fecha.

## 4. Video con IA por API

### 4.1 Opciones y precios

| Servicio | Precio | Duración y formato | Estado |
|---|---|---|---|
| **Google `gemini-omni-1.1-flash`** (Gemini Omni Flash) | Salida de video US$17,50 por millón de tokens; **~5.792 tokens por segundo de 720p = ~US$0,10 por segundo**. Sin plan gratis | 360p, 720p (por defecto), 1080p y 4K (escalados); **16:9 y 9:16**; extensiones de 3 a 10 s hasta 40 s en total; la duración máxima de un clip nuevo no está en la doc leída (NO VERIFICADO). Marca SynthID. Sin edición ni extensión de videos subidos en el EEE, Suiza y el Reino Unido. Tiempo: no hay cifras | Vigente |
| **Google Veo 3.1 (Preview)** | - | - | **Se apagó el 22-oct-2026 (hoy)** en la API de Gemini; la doc remite a Gemini Omni Flash o a los Veo "GA" de la Gemini Enterprise Agent Platform (precio y duración: NO VERIFICADO) |
| **Runway** (con la API propia) | Un crédito = US$0,01. `gen4_turbo` 5 créditos por segundo (**US$0,05**); `gen4.5` 12 (US$0,12); `aleph2` 28 (US$0,28; mínimo 56 créditos); `act_two` 5; `veo3.1` 20 sin audio y 40 con audio (US$0,20 y US$0,40); `veo3.1_fast` 10 sin audio y 15 con audio (US$0,10 y US$0,15). También lista Kling, WAN, Seedance, Hailuo y Gemini Omni Flash | Las duraciones y relaciones por modelo no se pudieron leer; el ejemplo usa `1280:720` y `duration: 5`. La doc dice que existe `720:1280` (vertical): NO VERIFICADO por modelo. Recetas de 4 a 15 s y de 5 a 15 s | Vigente |
| **Runway: límites por nivel** | Nivel 1: 1 a 2 tareas a la vez, 50 a 200 generaciones al día, tope de gasto US$100 al mes. Nivel 2 (con US$50 comprados): 3 a la vez, 500 a 1.000 al día | - | Vigente |
| **Luma Ray 3.2** (API de agentes) | Precio oficial no encontrado (la página de precios dio 404). Terceros: 360p ~US$0,06 por 5 s y ~US$0,18 por 10 s; 720p ~US$0,30 y ~US$0,90; 1080p ~US$1,20 por 5 s | Bloques de 5 o 10 s. Videos: se recomienda esperar 30 s antes del primer sondeo y un tope de 10 min | Precio: TERCERO / NO VERIFICADO |
| **Kling (V3, O3)** | Terceros: ~US$0,10 por segundo (V3 estándar 720p), ~US$0,16 (Pro 1080p), US$0,24 a US$0,40 con audio. La página oficial no muestra tarifas | - | Precio: TERCERO / NO VERIFICADO |
| **Black Forest Labs FLUX 3 Video** | Por segundo de salida, según clase de resolución (hd, fhd, qhd, uhd) y modo; tarifas no cargaron | - | NO VERIFICADO |
| **OpenAI Sora 2 (API de videos)** | (Antes ~US$0,10 por segundo en 720p.) | - | **Cerró el 24-sep-2026, sin reemplazo anunciado** (DOC). La app de Sora cerró el 26-abr-2026 (TERCERO) |

Fuentes: [Gemini Omni](https://ai.google.dev/gemini-api/docs/omni), [video](https://ai.google.dev/gemini-api/docs/video) y [precios](https://ai.google.dev/gemini-api/docs/pricing); [Runway precios](https://docs.dev.runwayml.com/guides/pricing/), [niveles](https://docs.dev.runwayml.com/usage/tiers/), [salidas](https://docs.dev.runwayml.com/assets/outputs/) y [moderación](https://docs.dev.runwayml.com/api-details/moderation/); [OpenAI bajas](https://developers.openai.com/api/docs/deprecations); [Luma Agents API](https://docs.agents.lumalabs.ai/); [Kling](https://kling.ai/dev/pricing); TERCERO: [Aireiter sobre Kling](https://aireiter.com/blog/kling-3-api-pricing-guide-2026), [Picassoia sobre Luma](https://blog.picassoia.com/luma-api-pricing-ray-3-2-api-docs-and-cost) (todas 2026-10-22).

### 4.2 ¿Sirven para reels verticales de 5 a 15 segundos?

- **Técnicamente sí:** Gemini Omni Flash y probablemente Runway entregan 9:16. Un reel de 8 s cuesta, por intento, unos US$0,80 con Omni Flash, US$0,40 con Runway `gen4_turbo` o US$0,96 con `gen4.5`. Uno de 15 s, unos US$1,50, US$0,75 y US$1,80. Veo 3.1 con audio por Runway: US$3,20 por 8 s.
- **Hay que descargar el resultado:** los enlaces caducan en 24 a 48 h (Runway, DOC) y hay que guardarlo en R2 y recién ahí publicar.
- **Calidad para el negocio:** un video generado de una propiedad, con interiores "creados", sería una representación falsa del inmueble: riesgo de reclamo del consumidor y de la red (INFERENCIA). Para propiedades solo sirve imagen a video a partir de una foto real (movimiento de cámara) y aun así con cuidado. Para marcas sin avisos (contenido de marca) es menos riesgoso.
- **Reintentos y moderación:** las generaciones moderadas se cobran igual y demasiadas pueden suspender la cuenta (Runway, DOC).
- **Veredicto:** no entra en el MVP. Primero se mide cuánto usa el operador la línea base de la sección 5.

## 5. Línea base sin IA y gratis: tarjetas propias

Sin investigación (no la necesita). Plantillas de texto con sharp o Playwright con la marca del cliente (logo, color, tipografía) para imágenes y carruseles, y videos de esas tarjetas con ffmpeg (por ejemplo, el mismo motor del reel desde fotos, F9.5-T18, y la música de `musica-reels.md`). Costo: US$0 por post, sin riesgo de licencia, sin etiquetas de IA y con control total del texto en español. **Es la opción por defecto.** Stock e IA son opcionales encima de esto, no al revés.

## 6. Reglas de las redes sobre contenido generado con IA

| Red | Qué exige o hace (DOC salvo que se diga otra cosa) | Cómo se declara por API |
|---|---|---|
| **Instagram y Facebook (Meta)** | Puede exigir etiqueta para **video fotorrealista o audio realista** creados o alterados digitalmente. **No se exige para imágenes**, pero una imagen puede recibir la etiqueta "AI info" si los sistemas de Meta detectan señales de IA. Contenido sin la etiqueta que debía llevarla "puede tener penalizaciones". Meta lee señales de herramientas de terceros (no nombra C2PA ni IPTC en esa página). Fuente: [Cómo identificar contenido de IA en Meta](https://www.meta.com/en-gb/help/artificial-intelligence/1783222608822690/) (2026-10-22). Un blog (TERCERO, sin confirmación de Meta) dice que desde julio de 2026 los anuncios con IA de terceros reciben "AI info" automática si traen C2PA | **`is_ai_generated=true`** al crear el contenedor, opcional, con ambos logins; en un carrusel va **solo en el contenedor padre** y en un hijo da error. Fuente: [Content Publishing con Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing) (2026-10-22). Ya anotado en `instagram.md` (sección 4.2) como decisión del operador |
| **TikTok** | Los creadores deben etiquetar contenido generado o muy editado con IA que muestre escenas o personas de aspecto realista; sin etiqueta, TikTok puede quitarlo, restringirlo o ponerle una etiqueta. Etiquetar no permite todo lo demás (contenido engañoso sobre asuntos de interés público). Fuente: [Pautas de la comunidad: integridad y autenticidad](https://www.tiktok.com/community-guidelines/en/integrity-authenticity) (2026-10-22). Lectura automática de C2PA: TERCERO, NO VERIFICADO hoy | **`is_aigc=true`** en el Direct Post: "Set to true if the video is AI generated content", pone "Creator labeled as AI-generated". Fuente: [Direct Post](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post) (2026-10-22); ya anotado en `tiktok.md` |
| **LinkedIn** | No hay una sección de IA en las Políticas de la Comunidad Profesional; la regla cercana: no compartir medios sintéticos o manipulados que muestren a una persona diciendo o haciendo algo que no hizo, sin avisar de que son falsos o alterados. Muestra un ícono C2PA en imágenes y videos con credenciales de contenido; la etiqueta no es obligatoria, y en algunos países el usuario puede declarar en la app que lo hizo con IA. Fuentes: [Políticas](https://www.linkedin.com/legal/professional-community-policies) y [Content credentials](https://www.linkedin.com/help/linkedin/answer/a6282984) (2026-10-22) | **Sin campo conocido** en la API de publicación (la doc que ya tenemos, `linkedin.md`, no menciona IA). NO VERIFICADO |
| **X** | La página oficial de reglas dio 403. Prensa (TERCERO): desde enero de 2026 hay avisos de "medios manipulados" y se prueba una etiqueta voluntaria "Made with AI"; no se encontró texto oficial | **Sin campo conocido**. NO VERIFICADO |
| **Discord** | No se investigó | Sin campo; la función de etiquetado no existe en un webhook (INFERENCIA) |

**Metadatos:** sharp quita por defecto los metadatos al re-codificar (INFERENCIA: es su comportamiento documentado de siempre; comprobar con la versión del repo), así que una marca C2PA del proveedor desaparece. Por lo tanto la señal automática que algunas redes leen no llega. Las marcas SynthID van dentro de los píxeles y pueden sobrevivir parte del procesamiento, pero no hay promesa. **Regla de diseño sugerida:** declarar siempre nosotros (`is_ai_generated`, `is_aigc`), no confiar en la detección de la red.

**Criterio sugerido (decisión del operador):** declarar IA en toda imagen o video con elementos generados que parezcan fotografías, aunque Meta no lo exija para imágenes; es más seguro y casi no tiene costo. No declarar en tarjetas de texto y fotos de stock.

## 7. Errores, riesgos y qué probar

- **Rotación de modelos:** en dos meses se apagaron `gemini-2.5-flash-image` (2-oct), Sora API (24-sep) y Veo 3.1 Preview (22-oct), y se anunciaron `gpt-image-1` (23-oct) y `gpt-image-1.5` (1-dic). **El código no debe fijar un modelo ni un precio**: nombre del modelo y precio por imagen en configuración, y un contrato `ImageProvider` con adaptadores intercambiables.
- **Descarga inmediata:** Runway caduca a 24 a 48 horas; Ideogram también. Siempre guardar en R2 antes de dar por buena la generación.
- **Moderación:** OpenAI devuelve errores estructurados si bloquea la entrada o la salida; Runway marca la tarea `FAILED` con `failureCode`, cobra igual y puede suspender la cuenta. Tratar un bloqueo como "no reintentable" por defecto (INFERENCIA).
- **Límites:** OpenAI `gpt-image-2.5-flare`, nivel Build: 20 imágenes por minuto y 250.000 tokens por minuto. Runway, nivel 1: 1 a 2 tareas a la vez. Google: no se leyó la tabla de límites del modelo (NO VERIFICADO). Pixabay: 100 por minuto, con 429.
- **Imágenes que no son de la propiedad:** no usar stock ni IA en el post de un aviso real como si fuera la propiedad; si se usan, marcarlo "imagen referencial" (INFERENCIA, riesgo de publicidad engañosa; no se investigó la norma chilena).
- **Personas, marcas y lugares:** stock con personas reconocibles puede sugerir respaldo (Pexels lo prohíbe expresamente); stock con logos no se puede usar para promocionar bienes o servicios (Pixabay). IA: pedir sin personas reconocibles ni marcas.
- **Pruebas sin riesgo (las hace el operador, con su instrucción en el chat):**
  1. Pixabay: una clave propia, una búsqueda y una descarga de `largeImageURL`; ver si 1280 px alcanza para 1080x1350 y qué pasa con el video `medium`.
  2. Nano Banana 2.1: una llamada con `aspectRatio` 4:5 y 9:16 y ver el tamaño real y la calidad de un cartel sin texto; repetir con 3 ideas y ver cuántos reintentos se necesitan. Costo de la prueba: unos centavos.
  3. OpenAI `gpt-image-2.5-flare`: una llamada con `usage` para fijar el costo real por imagen y probar 1088x1360.
  4. Instagram: crear un contenedor con `is_ai_generated=true` en una cuenta propia (como `ig:smoke`).
  5. Ninguna de estas pruebas está hecha.

## 8. Recomendación para el MVP

**Arquitectura simple y barata:**

1. **Cadena de fuentes por post sin medios**, en este orden, cada una con su costo y su tope:
   1. **Tarjeta propia** (sharp o Playwright con la marca del cliente; US$0): la opción por defecto. Para carrusel: una portada, tarjetas con los puntos del texto y una de cierre; para video: ffmpeg sobre las tarjetas, con la música de la biblioteca.
   2. **Stock con Pixabay**, a petición ("buscar foto de ambiente"): se busca por una consulta que redacta la IA del texto, el operador elige entre 6 resultados, se descarga el archivo a R2 y desde ahí se publica. US$0. Respaldo: Pexels si logra una clave y se aclara el re-hospedaje; Unsplash, no.
   3. **Imagen con IA con Nano Banana 2.1**, a petición, sin texto dentro de la imagen y con el título superpuesto por nosotros; 4:5 o 9:16 directo. Se declara siempre IA. Adaptador `ImageProvider` con un segundo proveedor (OpenAI `gpt-image-2.5-flare`) detrás de la misma interfaz, probado pero apagado.
   4. **Video con IA**: no ahora. Dejar el hueco en la interfaz (`VideoProvider`) para Runway `gen4_turbo` como imagen a video corto desde una imagen o foto propia.
2. **Nada se genera sin que el operador o el corredor lo pida** (botón "Conseguir una imagen"), y siempre pasa por la aprobación del post como cualquier medio.
3. **Registro de gasto por marca**, igual que el gasto de IA de texto (`cli usage`), con el costo por llamada leído del `usage` o del precio configurado.

**Tope sugerido por marca (decisión del operador):**

| Concepto | Tope |
|---|---|
| Imágenes con IA | **US$2 al mes por marca** (unas 40 imágenes de 1K con Nano Banana 2.1, o unas 20 contando reintentos) |
| Video con IA (cuando se active) | US$5 al mes por marca, aparte |
| Stock | US$0 (solo el límite de peticiones; cache de 24 h) |

**Costo estimado por post** (precios de la sección 3 y 4, 1K salvo que se diga otra cosa; con ~1,5 intentos por imagen deseada):

| Tipo de post | Con tarjetas | Con stock | Con IA |
|---|---|---|---|
| Texto | US$0 | - | - |
| Imagen | US$0 | US$0 | ~US$0,05 (1 imagen de Nano Banana 2.1 más un reintento medio) |
| Carrusel de 5 | US$0 | US$0 | ~US$0,25 si las 5 son IA; ~US$0,05 si solo la portada es IA y el resto son tarjetas |
| Video de 8 s | US$0 (ffmpeg) | US$0 (clip de Pixabay) | US$0,40 a US$0,80 por intento con IA (no activar ahora) |

Con 20 posts de marca al mes, usando IA en un tercio, el gasto de IA es del orden de US$0,50 a US$1 al mes por marca, dentro del tope.

## 9. Preguntas que requieren decisión del operador

1. ¿Se acepta la cadena "tarjetas propias, luego stock con Pixabay, luego IA" y que el video con IA quede para después?
2. ¿Tope de IA de US$2 al mes por marca, o sin tope en la marca propia del operador?
3. ¿Declarar siempre IA en imágenes generadas (aunque Meta no lo exija para imágenes)? Recomendado: sí.
4. ¿Prohibir stock e IA en posts de avisos reales (propiedades) o permitirlos solo con la leyenda "imagen referencial"?
5. ¿Quién abre la cuenta de Google AI Studio (o de OpenAI, que exige verificar la organización) y de Pixabay? Son trámites del operador, para `docs/07-checklist-cuentas.md`.
6. ¿Se pide permiso a Pexels y Pixabay para el uso multi-cliente? Hasta tenerlo, el volumen debe seguir siendo "un humano pide una foto".

**Decisiones del operador (2026-10-22, ADR-0038):**
1. Sí: tarjetas propias, luego Pixabay, luego imagen con IA (Nano Banana 2.1); el video con IA queda para después.
2. Tope de **US$2 al mes por marca** para imágenes con IA.
3. Se declara IA **solo cuando la red lo exija** (hoy, video realista); las imágenes generadas no se marcan.
4. Stock e IA **se permiten en propiedades, sin leyenda, mientras sean pruebas** del operador; antes de tener clientes (F10) se vuelve a decidir. En F9.5 se construye solo para posts.
5. Las cuentas de Google AI Studio y Pixabay las abre el operador (`docs/07-checklist-cuentas.md`).
6. El permiso de Pixabay para varios clientes queda para F10; hasta entonces, "un humano pide una foto".

## 10. NO VERIFICADO (lista corta)

- Re-hospedaje en Pexels y en Unsplash (los términos no lo tratan o no se pudieron leer).
- Reapertura de claves nuevas de Pexels.
- Tamaños reales de Pexels y de Pixabay con la clave básica en la práctica.
- Si `gemini-nano-banana-2.1` acepta 4:5 y 9:16 (la doc lo dice de `gemini-3.1-flash-lite-image`), y su calidad con texto.
- Precio real por imagen de `gpt-image-2.5-flare` y `-sunburst`; precios exactos de FLUX 3, Ideogram, Stability, Luma y Kling (oficiales).
- Términos de propiedad y uso comercial de OpenAI, BFL, Stability, Luma y Kling.
- Disponibilidad, precio y duración de Veo "GA" en la plataforma empresarial de Google; duración máxima de un clip de Omni Flash y de Runway por modelo.
- Cualquier regla oficial de X y de Discord sobre IA; campo de API para declararla en X, LinkedIn y Discord.
- Si Meta y TikTok leen C2PA de archivos subidos por API.
- Normativa chilena sobre publicidad con imágenes referenciales o generadas.

## 11. Fuentes (todas consultadas el 2026-10-22)

DOC:
- Pexels: https://www.pexels.com/api/documentation/ , https://www.pexels.com/license/ , https://www.pexels.com/api/ , https://www.pexels.com/terms-of-service/
- Unsplash: https://unsplash.com/documentation , https://unsplash.com/api-terms , https://unsplash.com/license , https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines
- Pixabay: https://pixabay.com/api/docs/ , https://pixabay.com/service/license-summary/ , https://pixabay.com/service/terms/
- Openverse: https://api.openverse.org/v1/
- Google: https://ai.google.dev/gemini-api/docs/pricing , https://ai.google.dev/gemini-api/docs/image-generation , https://ai.google.dev/gemini-api/docs/video , https://ai.google.dev/gemini-api/docs/omni , https://ai.google.dev/gemini-api/terms
- OpenAI: https://developers.openai.com/api/docs/pricing , https://developers.openai.com/api/docs/guides/image-generation , https://developers.openai.com/api/docs/models/gpt-image-2.5-flare , https://developers.openai.com/api/docs/deprecations
- Black Forest Labs: https://docs.bfl.ai/quick_start/pricing , https://docs.bfl.ml/quick_start/pricing.md , https://docs.bfl.ml/flux_3/flux3_image_overview.md , https://bfl.ai/pricing
- Ideogram: https://developer.ideogram.ai/ideogram-api/api-setup , https://ideogram.ai/pricing/?pricing_tab=api
- Recraft: https://www.recraft.ai/docs/api-reference/pricing.md
- Runway: https://docs.dev.runwayml.com/guides/pricing/ , https://docs.dev.runwayml.com/usage/tiers/ , https://docs.dev.runwayml.com/assets/outputs/ , https://docs.dev.runwayml.com/api-details/moderation/ , https://docs.dev.runwayml.com/guides/using-the-api/
- Luma: https://docs.agents.lumalabs.ai/
- Kling: https://kling.ai/dev/pricing (sin tarifas)
- Meta: https://www.meta.com/en-gb/help/artificial-intelligence/1783222608822690/ , https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing
- TikTok: https://www.tiktok.com/community-guidelines/en/integrity-authenticity , https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
- LinkedIn: https://www.linkedin.com/help/linkedin/answer/a6282984 , https://www.linkedin.com/legal/professional-community-policies

TERCERO (solo pista):
- Precios por imagen de gpt-image-2 en 1024x1536 baja y alta; Imagen retirado: resúmenes de búsqueda sobre sitios como intuitionlabs.ai y pricepertoken.com.
- Kling, Luma y Sora: https://aireiter.com/blog/kling-3-api-pricing-guide-2026 , https://blog.picassoia.com/luma-api-pricing-ray-3-2-api-docs-and-cost , https://www.hooked.so/compare/luma-ai-pricing
- Stability: https://developer.puter.com/tutorials/stability-ai-api-pricing/
- C2PA de OpenAI: https://help.openai.com/en/articles/8912793-c2pa-in-chatgpt-images (403 a la lectura directa; solo resumen de búsqueda)
- X y Meta en la prensa: https://techcrunch.com/2026/01/28/elon-musk-teases-a-new-image-labeling-system-for-xwe-think
- Shutterstock: https://code.shutterstock.com/api/pricing (solo extracto de búsqueda)

Páginas que no se pudieron leer (403, 404 o sin contenido): `help.pexels.com`, `pexels.com/api/terms/`, `help.x.com`, `help.openai.com`, `openai.com/policies/service-terms`, `docs.agents.lumalabs.ai/docs/pricing`, `cloud.google.com/vertex-ai/generative-ai/pricing`.
