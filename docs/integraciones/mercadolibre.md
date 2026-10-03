# Portal Inmobiliario y Mercado Libre (MLC): título y fotos

Nota **parcialmente verificada** el 2026-10-02. **Alcance parcial:** solo largo del título de inmuebles en MLC y tamaño de las fotos, para las plantillas y el prompt de F2. OAuth, categorías, atributos, listing types y estado quedan para F4.

Convención: **DOC** = documentación oficial; **INFERENCIA** = deducido; **NO VERIFICADO** = falta prueba real.

## Estado de la verificación (importante)

El sitio `developers.mercadolibre.*` respondió **403** a todas las lecturas directas de páginas (`es_ar/publicacion-de-inmuebles`, `publica-inmueble`, `trabajar-con-imagenes`, `categorias-inmuebles`, `list-properties`, `global-selling/devsite/pictures`). Los datos de abajo vienen de **resúmenes del buscador** sobre esas páginas oficiales, no de leer la página completa. Son una pista fuerte, **no una verificación**. Hay que confirmarlos en la cuenta de prueba (sección 8) o abriendo las páginas en el navegador.

## 1. Resumen

- **Mecanismo:** API de Mercado Libre, sitio MLC, con el atributo `CMG_SITE` para que el aviso salga también en Portal Inmobiliario (F4).
- **Título (resumen del buscador de la doc oficial):** máximo **60 caracteres** para publicar un inmueble en MLC (antes 200). La doc recomienda: sin adjetivos ni abreviaturas, con operación + tipo de propiedad + dormitorios + barrio. Ejemplo en la versión en inglés de la doc: "Apartment Sale 4 rooms Recoleta".
- **Fotos (resumen del buscador, guía general de imágenes de ML):** mínimo 500x500 px, recomendado 1200x1200 px, máximo 1920x1920 px, hasta 10 MB, formatos JPG, JPEG y PNG.
- **Riesgo medio**, por la falta de lectura directa y porque la guía de imágenes consultada es genérica (no específica de inmuebles).

## 2. Requisitos de cuenta y app

Fuera de alcance (F4).

## 3. Autenticación

Fuera de alcance (F4).

## 4. Operaciones

Fuera de alcance (F4). Para F2 solo importa:
- **Título:** campo `title` del ítem. Según el resumen, el largo máximo para inmuebles en MLC es **60** caracteres (NO VERIFICADO directamente). En el resumen aparece la frase "a partir del 15 de junio" sin año; no se sabe cuándo entró en vigor (probablemente ya está vigente). El valor se puede leer también de la propia API: `GET /categories/{category_id}` incluye `settings.max_title_length` por categoría (INFERENCIA desde el nombre del parámetro que menciona el resumen; **NO VERIFICADO**). Es la forma correcta de no codificar el 60 a mano.

## 5. Medios

| Requisito | Valor (resumen del buscador; NO VERIFICADO directamente) |
|---|---|
| Formatos | JPG, JPEG, PNG |
| Peso máximo | 10 MB |
| Mínimo | 500x500 px (versión "M") |
| Recomendado | 1200x1200 px; si es más grande, ML la reduce a ese tamaño |
| Máximo aceptado | 1920x1920 px (versión "F") |
| Otras | RGB mejor que CMYK; el producto debe ocupar ~95 % del espacio; con ancho > 800 px se activa el zoom |

- **Implicaciones para `docs/04-formato-publicaciones.md`:** la variante `pi_4x3` con "mínimo 1200 px de ancho" cumple los mínimos (500 px) y el recomendado de ancho. Un 4:3 no es cuadrado: si ML exige o prefiere fotos cuadradas, no se documenta para inmuebles (NO VERIFICADO). Una foto 1600x1200 cabe en el máximo (1920) y en el peso.
- **Fotos obligatorias:** la doc previa (`docs/03-plataformas.md`) dice que con `requires_picture: true` se exige al menos 1 imagen; no se reverificó.
- **URL pública:** la API acepta `pictures: [{ source: "<url>" }]` con una URL accesible, o subida directa por `multipart` a `/pictures` (INFERENCIA por la guía de imágenes; NO VERIFICADO para MLC; F4 lo confirma).
- Moderación de imágenes: ML modera las fotos (existe documentación "Moderaciones de imágenes" y "Diagnóstico de imágenes"); no se leyó. Mantener el criterio de `docs/04`: sin texto sobrepuesto, sin logos de terceros.

## 6. Límites

Fuera de alcance (F4). Rate limits de la API de ML: no consultados.

## 7. Errores comunes

Fuera de alcance. Un título sobre el máximo debería rechazarse con error de validación (INFERENCIA). La app debe validar el largo **antes** de enviar (`docs/04`: validación previa al envío).

## 8. Cómo probar sin riesgo

- Abrir en el navegador (la doc responde 403 a lectores automáticos): "Publica Inmuebles" y "Trabajar con imágenes" en developers.mercadolibre.cl, y confirmar el 60, el año del cambio y el mínimo de fotos.
- Con la cuenta de prueba de ML (F4): `GET https://api.mercadolibre.com/categories/<id de la categoría de inmueble>` y leer `settings.max_title_length` (si existe), y publicar un ítem de prueba con un título de 61 caracteres para ver el rechazo, con `listing_type` gratuito si lo hay, y cerrarlo después.
- En F2 no se publica: el prompt y la validación con zod usan una constante `MAX_TITLE_LENGTH_MLC = 60` en un archivo de configuración de plataforma, marcada "por verificar".

## 9. Riesgos y términos de uso relevantes

- **Cambio de política:** el límite pasó de 200 a 60 caracteres según el resumen; ML puede volver a cambiarlo. Leerlo de la categoría en F4.
- **Estilo:** la doc recomienda **evitar abreviaturas**. El formato propuesto en `docs/04` (`Departamento 3D 2B en Ñuñoa, vista despejada`) usa "3D 2B", que es una abreviatura y contradice la recomendación. Sugerencia: `Departamento 3 dormitorios en Ñuñoa` (34 caracteres) y agregar baños o destacado solo si cabe en 60. Decisión del operador (ver preguntas).
- Moderación de ML sobre el contenido de fotos y textos; no se evaluó.

## 10. Fuentes (consultadas el 2026-10-02; lectura directa bloqueada con 403, solo resúmenes del buscador)

- Publica Inmuebles (límite de título de 60 caracteres en MLC, recomendaciones de título, `CMG_SITE`): https://developers.mercadolibre.com.ar/productos-recibe-notificaciones/publica-inmueble
- List properties (versión en inglés, misma información): https://developers.mercadolibre.com.ar/en_us/list-properties
- Imágenes (tamaño mínimo, recomendado, máximo y peso): https://developers.mercadolibre.com.co/es_ar/trabajar-con-imagenes y https://developers.mercadolibre.com.ar/en_us/working-with-pictures
- Categorías de inmuebles por país: https://developers.mercadolibre.com.mx/es_mx/categorias-inmuebles
- Categorías y atributos (MLC): https://developers.mercadolibre.cl/en_us/public-and-private-resources/categories-attributes
