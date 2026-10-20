# ADR-0025 · Subidas directas a R2 con URL prefirmada, y la carga sin disco compartido

- **Estado:** Aceptado
- **Fecha:** 2026-10-18
- **Modifica a:** ADR-0005 (la enmienda de F1: el staging compartido en disco entre la API y el worker)

## Contexto
- Hoy el panel sube la planilla y los medios como `multipart` a `POST /imports`, la API los escribe en `tmp/imports` y el worker los lee del mismo disco; la CLI usa `POST /imports/local` con rutas del Mac (solo en desarrollo). `import_runs.input` guarda rutas locales.
- En internet la API y el worker son máquinas distintas, sin disco común, y Hono lee el `multipart` entero en memoria (unas 2 veces el cuerpo).
- `@aws-sdk/s3-request-presigner` ya está en `packages/storage` (las URLs de lectura).

## Decisión
1. **Un solo camino:** el panel y la CLI piden la carga (`POST /api/imports/uploads`) con los nombres y tamaños; la API crea la carga en `awaiting_upload` con su corredor, su `broker` y `dryRun`, y responde una URL prefirmada de PUT por archivo (1 h, firmada con el tamaño y, si lo trae, el sha256). El cliente sube directo a R2 (`imports/<id>/…`) y llama `POST /api/imports/:id/start`, que revisa con `head` y encola `import.run`.
2. **El sha256** acompaña la planilla y los archivos de carpeta de hasta 100 MB; el zip va solo con su tamaño (el navegador no puede calcularlo sin tenerlo entero en memoria) y el worker lo valida al abrirlo.
3. **El worker** baja los archivos de R2 a su carpeta temporal y usa los lectores de hoy; revisa el tamaño descomprimido de la planilla (50 MB) antes de abrirla con exceljs; al terminar, bien o mal, borra `imports/<id>/`. Una carga que queda más de 24 h en `awaiting_upload` se cierra (`IMPORT_UPLOAD_ABANDONED`) y se borran sus objetos.
4. **Se quitan** `POST /imports` (`multipart`), `POST /imports/local` y el staging compartido. `--dry-run` de la CLI usa el mismo flujo con `dryRun`.
5. **`import_runs.input`** es una unión: la forma nueva (claves de R2) y la de antes (rutas locales), que se sigue leyendo y nunca se reintenta.
6. **El bucket** necesita una regla de CORS que acepte `PUT` desde el panel (la configura el operador; `pnpm storage:check` la revisa).

## Consecuencias
- Ningún archivo de una carga pasa por la API: sin picos de memoria ni disco común, y la API y el worker pueden estar en máquinas distintas.
- La CLI sube incluso contra la API local; ya no lee rutas del Mac por la API.
- Que R2 respete el sha256 en un PUT prefirmado es NO VERIFICADO hasta `storage:check`; si no lo respeta, el worker sigue validando lo que lee.
- Una subida a medias deja objetos en R2 hasta que se cierra la carga abandonada.

## Alternativas descartadas
- **Mantener el `multipart` por la API y escribirlo en R2 desde ella:** el archivo pasa dos veces por la red y por la memoria de la API.
- **Subida multiparte de S3 desde el navegador:** necesita más rutas y estado (partes, completar, abortar); un PUT de hasta unos 5 GB alcanza para el tope de 4 GB del zip.
- **Que la CLI comprima la carpeta en un zip:** necesitaría una dependencia nueva; subir archivo por archivo usa los lectores de carpeta que ya existen.

## Seguimiento
- **2026-10-18, lote B de F8:** `startImport` revisa los archivos con `list` (una llamada) en vez de un `head` por archivo; las URLs duran 6 h (no 1 h: un zip grande o 500 archivos en una conexión lenta empiezan los últimos `PUT` después de la hora); empezar una carga ya en cola la vuelve a encolar con la misma `singletonKey`; el zip tiene el tope por archivo (`MAX_IMPORT_UPLOAD_MB`, nunca más de 4 GB); la limpieza de cada hora (`publications.watch`) también borra lo que quedó en R2 de cargas cerradas o terminadas, como red de seguridad del punto 3. No cambia la decisión.
- **2026-10-20, F9-T17 (medios de los posts desde el panel):** los medios de un post usan el sha256 como identidad (la clave `posts/{postId}/original/{sha256}.{ext}` y el único `(post_id, checksum)`), así que en F9-T10 era obligatorio siempre; el panel no puede calcularlo para un video de cientos de MB sin cargarlo entero en memoria (punto 2). Ahora es obligatorio hasta 100 MB y opcional sobre eso: sin él, la URL se firma solo con tipo y tamaño, la clave es `posts/{postId}/original/{uploadId}.{ext}`, `complete` deja la subida en el estado nuevo `uploaded` (migración `0017`) y el worker, al empezar `post.media`, lee el archivo de R2 en streaming, calcula el sha256, crea el medio y deduplica: si ese contenido ya era un medio del post, borra el objeto nuevo (antes de cerrar la subida, así un fallo se reintenta). Sin hash, cada pedido es una subida nueva (no hay con qué reconocer el mismo archivo); la anterior la cierra la limpieza a las 24 h, que también cierra una `uploaded` que el worker no revisó en 24 h. La CLI sigue mandando siempre el sha256. No cambia la decisión.
