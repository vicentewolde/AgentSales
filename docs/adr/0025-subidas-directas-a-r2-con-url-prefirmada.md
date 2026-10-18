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
