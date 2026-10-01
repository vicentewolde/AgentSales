# Cloudflare R2: checksum SHA-256 en `PutObject` de un solo envío

Nota verificada el 2026-10-01. Pregunta que responde: si `putStream` (`packages/storage/src/r2-storage.ts`) debe mandar el sha256 que la ingesta ya conoce como `ChecksumSHA256`, para que R2 rechace el objeto si el contenido no calza (spec F1, D3 y T07).

Convención: **DOC** = lo dice la documentación oficial; **CÓDIGO** = leído en el código del SDK instalado (`@aws-sdk/client-s3` 3.1141.0, `@aws-sdk/checksums` 3.1001.1); **INFERENCIA** = deducido, no confirmado; **NO VERIFICADO** = falta una prueba contra R2 real.

## 1. Resumen

- **Mecanismo:** header `x-amz-checksum-sha256` (base64 del digest crudo) en un `PutObject` normal. En el SDK se pasa como `ChecksumSHA256`.
- **Madurez:** R2 declara soporte de sha256 en `PutObject` (release notes, 2023-06-16) y tiene un código de error `BadDigest` (400) para "checksum no calza". Pero la página de compatibilidad S3 de R2 **no lista** `x-amz-checksum-sha256` en la fila de `PutObject`, y no hay doc oficial que describa el rechazo con sha256 en concreto. Hay que probarlo contra R2 real.
- **Riesgo:** bajo si se verifica antes (positivo y negativo, sección 8). Riesgo residual: un mismatch se detecta recién tras subir todo el archivo (hasta 300 MB) (INFERENCIA).
- **Conclusión corta:** el SDK conserva `Content-Length` y no usa `aws-chunked` si el header ya viene puesto (CÓDIGO). Recomendación en la sección 10.

## 2. Requisitos de cuenta y app

Sin requisitos nuevos: mismo bucket, token S3 y cliente que hoy. Sin costo adicional documentado.

## 3. Autenticación

No cambia (SigV4 con `region: "auto"`). Fuera del alcance de esta nota.

## 4. Operaciones (preguntas 1 a 4)

### 4.1 ¿R2 soporta `x-amz-checksum-sha256` en `PutObject`?

- **DOC, sí en general:** release notes de R2, 2023-06-16: "S3 putObject now supports sha256 and sha1 checksums. These were already supported by the R2 worker bindings." Y 2025-07-03: CRC-64/NVME soportado en objetos simples y multiparte.
- **DOC, matiz importante:** la página "S3 API compatibility" no incluye `x-amz-checksum-sha256` entre los headers de `PutObject` (ni como soportado ni como no soportado). Lista como soportado `Content-MD5`; la tabla "Checksum Types" muestra SHA-256 solo como `COMPOSITE` (multiparte) y CRC-64/NVME como `FULL_OBJECT`. La página dice "Feature implementation is currently in progress." Es decir, la doc de compatibilidad está desfasada o ambigua respecto de las release notes.
- **DOC, lo que R2 sí dice no soportar:** `x-amz-checksum-algorithm` (en `CopyObject`, `PutBucketCors`, `PutBucketLifecycleConfiguration`). Para `PutObject` y `UploadPart` la página no lista filas de `x-amz-checksum-*` ni de `x-amz-sdk-checksum-algorithm`.
- **Nota sobre una fuente descartada:** un primer resumen automático de la página la leyó como "x-amz-checksum-sha256 no soportado". El texto crudo de la página (fuente en GitHub) no tiene esa fila; no se usa esa lectura.

### 4.2 ¿Lo valida y rechaza si no calza? ¿Qué código?

- **DOC:** tabla de códigos de error de R2: `BadDigest` (código R2 10037), HTTP **400**, "Provided checksum does not match the uploaded content." Y `InvalidDigest` (10014), HTTP 400, "Checksum header format is malformed." (por ejemplo un base64 inválido o de largo incorrecto).
- **DOC (AWS, referencia del comportamiento esperado):** "If the checksum value calculated by S3 matches your provided value, the request is accepted. If the values don't match, the request is rejected", y para el SDK "Amazon S3 fails the request with a `BadDigest` error".
- **NO VERIFICADO:** que R2 aplique `BadDigest` específicamente al header `x-amz-checksum-sha256` de un `PutObject` y que no deje el objeto guardado. La descripción de `BadDigest` es genérica. Hay reportes en foros de usuarios con errores `BadDigest`/"SHA-256 checksum you specified did not match" en R2 (hilos de community.cloudflare.com, devueltos por el buscador; el sitio respondió 403 al leerlos, así que no se leyeron completos). No se usan como fuente.

### 4.3 ¿El SDK manda el header tal cual, sin `aws-chunked` y con `Content-Length`? (CÓDIGO)

Con `requestChecksumCalculation: "WHEN_REQUIRED"` y `ChecksumSHA256` pasado explícitamente:

1. `PutObjectRequest` mapea `ChecksumSHA256` al header `x-amz-checksum-sha256` (`client-s3/dist-es/schemas/schemas_0.js`). `ChecksumAlgorithm` es otro miembro, que mapea a `x-amz-sdk-checksum-algorithm`.
2. `PutObject` registra el plugin `getFlexibleChecksumsPlugin` con `requestChecksumRequired: false` (`client-s3/dist-es/commandBuilder.js`, `_mw11`).
3. El middleware (`@aws-sdk/checksums/.../flexibleChecksumsMiddleware.js`, paso `build`, o sea después de serializar) arranca con:
   ```js
   if (hasHeaderWithPrefix("x-amz-checksum-", args.request.headers)) {
       return next(args);
   }
   ```
   Si ya hay un header `x-amz-checksum-*`, **retorna sin tocar la petición**: no fija `x-amz-sdk-checksum-algorithm`, no usa `aws-chunked`, no agrega `x-amz-trailer`, no borra `content-length`.
4. El camino `aws-chunked` (con `content-encoding: aws-chunked`, `transfer-encoding: chunked`, `x-amz-decoded-content-length`, `x-amz-content-sha256: STREAMING-UNSIGNED-PAYLOAD-TRAILER`, `x-amz-trailer` y borrado de `content-length`) solo se alcanza si **no** hay header `x-amz-checksum-*` y hay un algoritmo elegido (por `ChecksumAlgorithm` o por `WHEN_SUPPORTED`) con body stream.

Conclusión (CÓDIGO): pasar solo `ChecksumSHA256` conserva el PUT normal con `Content-Length`. **No pasar `ChecksumAlgorithm`.** Si se pasan ambos, igual gana el header (cortocircuito), pero no aporta nada.

Matices:
- Esto vale para la versión instalada. El orden de los middlewares y el nombre del paquete cambiaron entre versiones (en 3.1141.0 la lógica vive en `@aws-sdk/checksums`). Un test con msw que fije el comportamiento protege contra cambios futuros (sección 8).
- Cómo firma el SDK el `x-amz-content-sha256` de un stream sobre HTTPS no se revisó aquí; el cliente de streams actual ya funciona contra R2 (ESTADO: `storage:check` sube 1 MB en streaming, OK).

### 4.4 `Content-MD5` como alternativa

- **DOC:** R2 lista `Content-MD5` como soportado (✅) en `PutObject`, `CreateMultipartUpload` y `UploadPart`. Release notes 2022-09-19: R2 incluye MD5 por defecto en objetos no multiparte (es el ETag).
- **Validación:** el código `BadDigest` aplicaría a un MD5 que no calza, pero la doc de R2 no dice explícitamente "se rechaza el PUT si `Content-MD5` no calza". NO VERIFICADO.
- **No sirve para este caso:** la ingesta tiene el sha256 y no el MD5; calcular el MD5 exige otra pasada completa sobre un video de hasta 300 MB. Y el SDK v3 ya no lo calcula por sí solo. Se descarta.

## 5. Medios

No aplica a esta nota (el límite de un `PutObject` único en R2 es 5 GiB según la tabla de errores: `EntityTooLarge`; `MAX_VIDEO_MB = 300` queda lejos).

## 6. Límites

- Tamaño máximo de un `PutObject`: 5 GiB (DOC, códigos de error de R2).
- Cuotas o rate limits específicos de checksum: ninguno documentado.

## 7. Errores comunes

| Situación | Respuesta de R2 | Reintentable en `putStream` |
|---|---|---|
| Checksum no calza con el contenido | `BadDigest`, HTTP 400 (DOC) | No automáticamente. Hoy `toAppError` lo convertiría en `STORAGE_ERROR` no reintentable (status 400). Ver pregunta 2 abajo |
| Header mal formado (por ejemplo hex en vez de base64) | `InvalidDigest`, HTTP 400 (DOC) | No: es un bug de quien llama |
| R2 no implementa el header | `NotImplemented`, "Header '...' not implemented" (hilos de foro y repos de terceros; no hay texto oficial) | No |
| Falta `Content-Length` | `MissingContentLength`, HTTP 411 (DOC) | No: es lo que evitamos con `WHEN_REQUIRED` |

Historial relevante (DOC en la guía de ejemplos de R2 para `aws-sdk-js-v3`, vista en un despliegue de vista previa; la página de producción no mostró el aviso al consultarla): "Client version 3.729.0 introduced a modification to the default checksum behavior from the client that is currently incompatible with R2 APIs." Solución: bajar a 3.726.1 o usar `requestChecksumCalculation: "WHEN_REQUIRED"` y `responseChecksumValidation: "WHEN_REQUIRED"`. Hilos de foro reportan `NotImplemented: Header 'x-amz-checksum-crc32' with value '...' not implemented` con el valor por defecto.

## 8. Cómo probar sin riesgo

Todo con objetos bajo `_healthcheck/` en el bucket de pruebas, borrados al final (como ya hace `packages/storage/src/scripts/check.ts`). Ninguna llamada a plataformas de publicación.

**Pruebas automáticas con msw (CI, sin R2):** con `ChecksumSHA256` pasado, la petición lleva `x-amz-checksum-sha256` con el valor dado y `Content-Length`; **no** lleva `content-encoding: aws-chunked`, `transfer-encoding: chunked`, `x-amz-trailer` ni `x-amz-sdk-checksum-algorithm`. Esto fija el comportamiento CÓDIGO de 4.3 ante una actualización del SDK.

**Ampliación de `pnpm storage:check` contra R2 real (hecha por el operador o por quien implemente T07, con las credenciales del `.env`):**
1. **Positivo:** `putStream` de los mismos 1 MB con el sha256 correcto (base64 del digest crudo). Debe tener éxito, y `get` debe devolver el mismo sha256.
2. **Negativo (la prueba que realmente decide):** `putStream` con un `ChecksumSHA256` válido en formato pero de **otro** contenido (por ejemplo el sha256 de `"x"`). Esperado: error HTTP 400 con nombre `BadDigest` en la causa del `AppError`, y `head(path)` devuelve `null` (R2 no guardó el objeto). Si R2 acepta el objeto, el checksum no se está validando y **no** hay que presentarlo como verificación.
3. **Formato inválido (opcional):** pasar el digest en hex en vez de base64 debería dar `InvalidDigest` (400). Sirve para confirmar el mensaje de error.
4. **Opcional, NO VERIFICADO:** `HeadObject` con `ChecksumMode: "ENABLED"` tras el positivo para ver si R2 devuelve `ChecksumSHA256` guardado. Si lo hace, la ingesta podría auditar objetos después sin descargarlos.

El script debe imprimir solo códigos y nombres de error, nunca credenciales ni URLs prefirmadas (regla ya vigente en `check.ts`).

## 9. Riesgos y términos de uso relevantes

- **Detección tardía:** R2 valida tras recibir el cuerpo completo; un video de 300 MB corrupto se sube entero y se rechaza al final (INFERENCIA).
- **Dependencia de una función poco documentada:** si Cloudflare cambia el soporte de `x-amz-checksum-sha256`, `putStream` fallaría con 400 o `NotImplemented` en todas las subidas. El `storage:check` y el test msw lo detectan temprano.
- **Archivo que cambia durante la subida:** hoy `putStream` detecta cambio de largo pero no un contenido distinto del mismo largo (`docs/01-arquitectura.md`). `ChecksumSHA256` cierra ese hueco, siempre que el sha256 se haya calculado sobre los mismos bytes que se suben.
- **Trailers y `aws-chunked`:** la doc de R2 no dice nada sobre `STREAMING-UNSIGNED-PAYLOAD-TRAILER`. NO VERIFICADO; el cliente actual evita ese formato y esta recomendación también.

## 10. Recomendación para `putStream`

**Sí: mandar `ChecksumSHA256`, condicionado a que pase la prueba negativa (8.2) contra R2 real.**

- Agregar un campo opcional a `PutStreamOptions` (por ejemplo `sha256Hex?: string`). En el adaptador convertirlo a base64 del digest crudo: `Buffer.from(hex, "hex").toString("base64")`, validando 64 caracteres hex. Pasarlo como `ChecksumSHA256` en el `PutObjectCommand`, junto con `ContentLength`.
- No pasar `ChecksumAlgorithm`. Mantener `requestChecksumCalculation: "WHEN_REQUIRED"` en el cliente de streams y `maxAttempts: 1`.
- Mapear `BadDigest` (400) a un error con detalle claro ("el contenido subido no calza con el sha256"). **Decisión del plan de F1-T07:** `STORAGE_CONTENT_MISMATCH`, no reintentable, el mismo código que un largo distinto; la ingesta lo trata como advertencia del archivo (respuesta a la pregunta 2). Si la prueba negativa falla (R2 acepta el objeto con checksum erróneo), **no** enviar el header y dejar la verificación a una lectura posterior, o aceptar la limitación documentada.
- Cambia el contrato de `PutStreamOptions` (puerto de `core`): requiere actualizar `docs/01-arquitectura.md` y la línea de D3 del spec F1, y probablemente una línea en ADR-0007, en el mismo PR de T07.

Preguntas para el operador o el plan de T07:
1. ¿El sha256 de la ingesta se calcula sobre los mismos bytes que se suben (lectura previa del archivo completo) o en una pasada distinta? Si el archivo puede cambiar entre ambas, el rechazo por `BadDigest` es justamente lo deseado.
2. ¿`BadDigest` debe ser reintentable (el job reabre el archivo y reintenta una vez) o terminal? Propuesta: terminal con mensaje claro, porque un archivo que cambió o se corrompió en disco no se arregla reintentando.
3. ¿Se acepta ampliar `storage:check` con la prueba negativa (sube y borra objetos de prueba, como ya hace)?

## 11. Fuentes (consultadas el 2026-10-01)

- Cloudflare R2, S3 API compatibility: https://developers.cloudflare.com/r2/api/s3/api/ (fila de `PutObject`, `UploadPart`, tabla "Checksum Types"; texto crudo leído en https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/docs/r2/api/s3/api.mdx)
- Cloudflare R2, códigos de error (`BadDigest` 10037, `InvalidDigest` 10014, `EntityTooLarge`, `MissingContentLength` 411): https://developers.cloudflare.com/r2/api/error-codes/
- Cloudflare R2, release notes (2022-09-19, 2023-06-16, 2025-07-03): https://developers.cloudflare.com/r2/platform/release-notes/ (entradas leídas en https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/release-notes/r2.yaml)
- Cloudflare R2, ejemplo `aws-sdk-js-v3` (aviso sobre 3.729.0, visto en el despliegue de vista previa): https://11242e9a.preview.developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/ ; versión de producción sin el aviso al consultarla: https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/
- AWS S3, comportamiento de checksums en la subida (`BadDigest`, header para un solo envío, `Content-MD5`): https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html
- AWS S3, `PutObject` (referencia de la API; se descargó completa pero no se leyó línea por línea): https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html
- Código del SDK instalado en el repo (CÓDIGO, no URL): `node_modules/.pnpm/@aws-sdk+checksums@3.1001.1/node_modules/@aws-sdk/checksums/dist-es/submodules/flexible-checksums/flexibleChecksumsMiddleware.js` y `getChecksumAlgorithmForRequest.js`; `packages/storage/node_modules/@aws-sdk/client-s3/dist-es/commandBuilder.js` (`_mw11`) y `dist-es/schemas/schemas_0.js` (`PutObjectRequest$`).
- Pistas no oficiales (solo contexto, no fuente final): hilos de community.cloudflare.com (3.729.0 rompe `PutObject`; "Bad digest when PutObject in R2 with x-amz-content-sha256"), que devolvieron 403 al leerlos.
