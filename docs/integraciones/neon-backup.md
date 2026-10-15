# Neon (plan gratis) y respaldo local con pg_dump

Nota **consultada el 2026-10-15** en la documentación oficial de Neon y de PostgreSQL, para planificar el respaldo periódico de F6 (ADR-0007: "se agrega un respaldo local periódico (`pg_dump`) en F6"). Solo documentación pública: no se leyó `.env` ni se hizo ninguna conexión a la base.

Convención: **DOC** = leído en la página oficial (URL y fecha en la sección 10); **INFERENCIA** = deducido de lo leído; **NO VERIFICADO** = la doc no lo dice; se confirma con una prueba (sección 8). Las secciones 5 (Medios) y la parte de OAuth de la 3 no aplican a este tema y se omiten o se reinterpretan (la "autenticación" es la cadena de conexión).

## 1. Resumen

- **Mecanismo:** `pg_dump -Fc` desde la Mac del operador contra la conexión **directa** (sin `-pooler`) de Neon, y `pg_restore` a una base nueva. Neon lo describe como flujo soportado: "Neon supports traditional backup workflows using `pg_dump` and `pg_restore`" (DOC).
- **Versión de Postgres de nuestro proyecto:** Neon dice que **Postgres 18 es el predeterminado de los proyectos nuevos** (DOC: entrada del changelog "Postgres 18 is now the default for newly created Neon projects", sin fecha visible, y la página de la CLI: "the default Postgres version, which is Postgres 18"). Nuestro proyecto se creó el 2026-09-29, después de esa entrada (la página de junio de 2026 la ubica en el changelog de 2026-06-05; la fecha exacta del cambio no figura), así que lo más probable es **18** (INFERENCIA). Si se eligió otra versión al crearlo en la consola, no cambia: **hay que leerla** (sección 8, paso 1). Neon soporta 14 a 18 y está desplegando 19 (DOC).
- **Regla de versiones del cliente:** `pg_dump` **no puede volcar un servidor de versión mayor que la suya**: se niega a intentarlo (DOC, PostgreSQL). Neon recomienda además usar el cliente de la misma versión del proyecto, o el más reciente (DOC). Con `libpq` de Homebrew (18.x hoy) alcanza para un servidor 18 o menor.
- **Historial de restauración del plan gratis: 6 horas, con tope de 1 GB de historial** (DOC). ADR-0007 dice 6 h: **confirmado**. Es solo para deshacer errores recientes, no es un respaldo.
- **Despertar el cómputo:** la doc no habla de `pg_dump`; sí dice que el cómputo se reactiva al consultar la base (DOC). `pg_dump` abre conexiones y consulta, así que **despierta el cómputo** (INFERENCIA fuerte). El costo estimado es despreciable (sección 6).
- **Dato desactualizado en ADR-0007:** el ADR dice "0,5 GB de base de datos por proyecto"; la página de planes vigente dice **1 GB por proyecto (20 GB en total entre proyectos gratis)**. La cifra de 100 CU-horas por mes por proyecto coincide. No se editó el ADR (fuera del alcance de esta nota): decisión del operador.
- **Riesgo principal:** si se agotan las 100 CU-horas del mes, Neon suspende el cómputo hasta el siguiente período (DOC) y **el respaldo no podría correr** justo cuando la app tampoco funciona. Nunca borra datos por eso (DOC).

## 2. Requisitos de cuenta y app (plan y versión)

| Requisito | Dato | Fuente |
|---|---|---|
| Plan | Free: 100 CU-horas por proyecto al mes, 1 GB por proyecto (20 GB en la cuenta), 100 proyectos, 10 ramas por proyecto, escala hasta 2 CU | DOC (plans) |
| Escalado a cero | El cómputo se suspende tras **5 minutos** de inactividad y en Free no se puede desactivar. Reactiva "within a few hundred milliseconds" al consultar | DOC |
| Versiones soportadas | 14, 15, 16, 17, 18 (19 en camino). Cada mayor se soporta 5 años desde su lanzamiento. Últimos menores a agosto de 2026: 18.6, 17.11, 16.15, 15.19, 14.24 | DOC |
| Versión predeterminada en proyectos nuevos | **18** | DOC (changelog y CLI); la de nuestro proyecto: INFERENCIA, se lee con `show server_version` |
| Cambiar de versión mayor | No se cubrió en esta nota. Un salto mayor se haría con `pg_dump`/`pg_restore` a un proyecto nuevo (el mismo flujo de la sección 4) | NO VERIFICADO (no leído) |
| Costo | Ninguno para el plan gratis. El historial de 7 o 30 días es de pago (Launch y Scale, US$0,20 por GB-mes) | DOC |
| Cliente local | `psql`, `pg_dump` y `pg_restore` instalados en la Mac (sección 4.4) | — |

## 3. Autenticación (cadena de conexión)

- **Usar la conexión directa:** Neon dice "Avoid using `pg_dump` over a pooled connection string" por problemas conocidos de PgBouncer, y "use an unpooled connection string": el host **sin el sufijo `-pooler`**. En la consola: Connect y desmarcar "Connection pooling" (DOC). Es la misma conexión que ya usa AgentSales (ADR-0007).
- **TLS:** la cadena trae `sslmode=require` (ADR-0007). `libpq` lo respeta.
- **La contraseña viaja en la cadena.** Para no dejarla en el historial del shell ni en `ps`: pasarla por variable de entorno (`PGPASSWORD`) o `~/.pgpass`, y leer la URL desde el `.env` con un script que no la imprima (INFERENCIA de buena práctica; la doc de Neon pasa la URL con `-d`).
- El rol de la cadena de la app basta si puede leer todas las tablas (es el dueño de los objetos; INFERENCIA, se comprueba con la prueba de la sección 8).

## 4. Operaciones

### 4.1 Respaldar (DOC + INFERENCIA)

Comando oficial de Neon:

```bash
pg_dump -Fc -v -d "<cadena_directa>" -f <archivo>
```

`-Fc` = archivo en formato personalizado, comprimido, apto para `pg_restore`; `-v` = verboso; `-d` = conexión; `-f` = archivo (DOC, Neon). Para ahorrar tiempo en bases grandes, Neon sugiere `-j <n>` (en `pg_dump` solo con formato directorio; INFERENCIA, no aplica a una base de este tamaño).

Propuesta para AgentSales (INFERENCIA, a confirmar con la prueba de la sección 8):

```bash
pg_dump -Fc --no-owner --no-acl -v -d "$URL_DIRECTA" -f "$DESTINO/agentsales-YYYYMMDD-HHMM.dump"
```

- `--no-owner` (`-O`) y `--no-acl` (`-x`) las define PostgreSQL (DOC): la primera no escribe los comandos de propietario, la segunda no vuelca `GRANT/REVOKE`. Sirven para restaurar en una base local donde los roles de Neon no existen. Neon documenta `-O` **en `pg_restore`** ("Without it, the dump's `ALTER OWNER` statements cause non-fatal errors on Neon"); **`--no-acl` no figura en las páginas de Neon** (DOC por omisión).
- PostgreSQL aclara que `-O` y `-c` **se ignoran al escribir un archivo de formato no texto**: en formato personalizado hay que pasarlos a `pg_restore` (DOC). Pasarlos en ambos lados es inocuo.
- El volcado es de **toda la base**: incluye los esquemas de la app, `drizzle` y `pgboss` (INFERENCIA).
- Un volcado de formato personalizado no se puede canalizar a `pg_restore` si fuera formato directorio; con `-Fc` sí (DOC, Neon).

### 4.2 Restaurar (DOC)

Pasos de Neon para volver a un proyecto de Neon:

1. Crear un proyecto Neon nuevo.
2. Crear una base con el mismo nombre que la respaldada (el ejemplo usa `neondb`).
3. Obtener la **cadena directa** del proyecto nuevo.
4. `pg_restore -v -d "<cadena_directa>" <archivo>`.

Para restaurar **en local** (INFERENCIA, comprobarla en la sección 8):

```bash
createdb agentsales_restore_test
pg_restore --no-owner --no-acl -v -d agentsales_restore_test agentsales-YYYYMMDD-HHMM.dump
```

- Para reintentar una restauración fallida sobre una base ya cargada, Neon documenta `pg_restore -c --if-exists` (DOC); es destructivo: solo contra una base de prueba.
- Errores por extensiones que la base local no tenga: cuáles usa nuestro proyecto es NO VERIFICADO; se ve en el primer intento de restauración.
- Recuperar errores recientes (menos de 6 h) es más rápido con la restauración instantánea de Neon que con un volcado (DOC, recomendación de Neon); ver 4.3.

### 4.3 Restauración instantánea y ventana de historial (DOC)

- **Ventana de historial (página `history-window`, 2026-10-15):** Free = **6 horas** (predeterminado y máximo), "with a storage cap of 1 GB of history"; Launch = 1 día (máximo 7); Scale = 1 día (máximo 30). Pasado el tope de 1 GB, el historial más viejo no se conserva: con mucha escritura la ventana efectiva puede ser **menor** a 6 h (INFERENCIA; para esta app es improbable).
- **Contradicción en la página de planes:** la fila "Instant restore" muestra "—" en la columna Free, pero la sección dice "No charge, 6-hour limit, capped at 1 GB of change history" y la fila "History window" dice "6 hours, up to 1 GB-month". Se lee como **disponible y sin cargo, con 6 h** (DOC, lectura conjunta). Que el botón aparezca en la consola de nuestro proyecto: NO VERIFICADO.
- **Cómo funciona (DOC):** solo en la rama raíz; sobrescribe todo el Postgres y el esquema de la rama (todas las bases de la rama), corta unas conexiones por unos segundos y crea una rama de respaldo `{rama}_old_{marca de tiempo}` para deshacer. No revierte Object Storage.
- **No sustituye al `pg_dump`:** 6 horas no cubre un error que se note al día siguiente ni la pérdida del proyecto.

### 4.4 Instalar el cliente en macOS (solo referencia)

- **Homebrew:** `brew install libpq`. Instala `psql`, `pg_dump`, `pg_restore`, `pgbench`, `pg_basebackup`, `pg_config` y otros; es **keg-only** ("conflicts with PostgreSQL") y su versión estable hoy es **18.6** (DOC, formulae.brew.sh, 2026-10-15). Por ser keg-only los binarios no quedan en el `PATH`: Homebrew los deja en el directorio `bin` de su prefijo `opt/libpq` (en Apple Silicon, `/opt/homebrew/opt/libpq/bin`); hay que agregarlo al `PATH` o llamarlos con la ruta completa. La página de la fórmula no trae la nota de `PATH`; la ruta es la convención de Homebrew (INFERENCIA).
- **Alternativas:** `brew install postgresql@18` (trae también el servidor) o Postgres.app. Si el proyecto fuera de otra versión mayor, existen fórmulas versionadas (`libpq@18` figura como alias de la actual; que exista `libpq@17`: NO VERIFICADO).
- **Comprobar:** `pg_dump --version` debe mostrar una versión mayor **igual o superior** a la del servidor.
- No se instaló nada ni se corrió ningún comando en esta consulta.

## 5. Medios

No aplica. El respaldo de la base **no incluye los archivos de R2** (fotos, videos y portadas); Neon lo aclara para su propio Object Storage ("not part of the database timeline"), y R2 es otro servicio. Respaldar R2 queda fuera de esta nota (decisión de F6: las variantes se pueden regenerar desde los originales, pero los originales viven en R2: INFERENCIA, confirmar en el spec).

## 6. Límites

| Límite | Valor | Fuente |
|---|---|---|
| CU-horas | 100 por proyecto y mes. Fórmula: tamaño del cómputo × horas encendido. "Computes that are suspended do not accrue CU-hours" | DOC |
| Al agotarlas | "Your compute is suspended until the next billing period or until you upgrade"; no se borran datos | DOC |
| Ejemplo oficial | 100 CU-horas = un cómputo de 0,25 CU durante 400 horas al mes | DOC |
| Costo de un respaldo | Tiempo de volcado (segundos para una base chica) + 5 min de espera antes de suspender ≈ 6 min. A 0,25 CU: ≈ **0,025 CU-h** por respaldo; uno diario ≈ **0,75 CU-h al mes** (menos del 1 %). Si el cómputo ya estaba despierto por el worker o el panel, no suma casi nada | INFERENCIA a partir de la fórmula |
| Tamaño mínimo del cómputo en Free | La página dice "up to 2 CU"; el mínimo (0,25 CU) lo da el ejemplo oficial | DOC / INFERENCIA |
| Almacenamiento | 1 GB por proyecto; el volcado comprimido pesa menos que la base | DOC / INFERENCIA |
| Ramas | 10 por proyecto | DOC |

## 7. Errores comunes

| Situación | Causa | Reintento |
|---|---|---|
| `pg_dump: error: aborting because of server version mismatch` (texto exacto: NO VERIFICADO) | Cliente de versión mayor menor que la del servidor | No: instalar un cliente igual o superior (DOC: se niega a volcar un servidor más nuevo) |
| Fallos raros, sesión cortada o `prepared statement` / `SET` rechazado | Se usó la cadena con `-pooler` (PgBouncer) | No: usar la directa (DOC) |
| Primera conexión lenta o con timeout | El cómputo estaba suspendido; reactiva en cientos de milisegundos (DOC), más en la práctica (ADR-0007 usa 10 s con un reintento) | Sí, una vez |
| No conecta por varios minutos a fin de mes | Se agotaron las CU-horas y el cómputo está suspendido hasta el siguiente período | No hasta el próximo período o un plan pago |
| Errores `ALTER OWNER` o de roles al restaurar | Dump sin `--no-owner`/`-O` en un servidor con otros roles | Repetir con `-O`/`--no-acl` (DOC, Neon: "non-fatal errors") |
| Extensión inexistente al restaurar en local | Extensión de Neon ausente en el Postgres local | Instalar la extensión o restaurar sin ella (NO VERIFICADO cuáles usa el proyecto) |

## 8. Cómo probar sin riesgo

Todo es de lectura sobre Neon; la restauración va solo a una base local descartable. Lo corre el operador (la cadena de conexión no debe pasar por el chat).

1. **Leer la versión del servidor** (no escribe nada): `psql "$URL_DIRECTA" -tAc "show server_version"`. Con eso se cierra la INFERENCIA de la versión 18. Alternativa sin cliente: la consola de Neon, panel del proyecto.
2. **Instalar `libpq`** (sección 4.4) y confirmar `pg_dump --version` >= la del paso 1.
3. **Primer volcado** con el comando de 4.1 hacia una carpeta **fuera del repositorio**. Anotar tiempo y tamaño, y mirar en la consola de Neon cuánto cómputo registró (cierra "cuánto consume").
4. **Restaurar en local** en una base nueva (4.2) y comparar el número de filas de 3 o 4 tablas con la base de Neon. Borrar la base de prueba.
5. **Comprobar el historial de 6 h** mirando la consola (Backup & Restore o la página del proyecto), sin ejecutar ninguna restauración. Probar una restauración instantánea real sobre la rama raíz sobrescribe los datos: solo con una rama hija o un proyecto de prueba, nunca sobre `main` de producción.
6. Medir con el worker apagado (el cómputo duerme a los 5 min) y comprobar que `pg_dump` lo despierta y que vuelve a dormir.

## 9. Riesgos y términos de uso relevantes

- **El volcado contiene datos reales de corredores y clientes** y los tokens cifrados de las cuentas. Guardarlo fuera de git (agregar la carpeta a `.gitignore`), en un disco cifrado (FileVault) y con una retención corta. La clave `APP_ENCRYPTION_KEY` **no** va dentro del volcado ni junto a él (INFERENCIA de buena práctica; sin ella los tokens no se descifran).
- **Respaldo en la misma Mac = un solo punto de falla.** Si se quiere copia fuera de la Mac (R2 u otra), decidirlo en el spec de F6.
- **El worker apagado no respalda.** ADR-0007 ya avisa que los cron del período apagado se pierden: un respaldo programado necesita que la Mac esté encendida; si no, se ejecuta al arrancar (comportamiento de `startAfter`) o se hace a mano.
- **Cuota:** respaldos muy frecuentes no son un problema (sección 6); sí lo sería dejar el cómputo despierto todo el mes.
- **Cambios de versión de Neon:** al pasar a 19 el cliente debe estar al día (si no, `pg_dump` se niega). Revisar `pg_dump --version` antes de cada actualización mayor.
- Términos de uso de Neon: no se revisaron.

## 10. Fuentes (consultadas el 2026-10-15)

Neon:

- Planes (Free: 100 CU-horas, 1 GB por proyecto, escala a cero, historial 6 h): https://neon.com/docs/introduction/plans
- Ventana de historial por plan (Free: 6 h, tope de 1 GB): https://neon.com/docs/postgres/backup-restore/history-window
- Restauración instantánea (sobrescribe la rama, rama de respaldo, límites): https://neon.com/docs/introduction/branch-restore
- Respaldo con `pg_dump` (`-Fc -v -d -f`, conexión sin pooler, cliente de la misma versión, restauración a proyecto nuevo): https://neon.com/docs/manage/backup-pg-dump
- Automatizar respaldos (cadena sin `-pooler`): https://neon.com/docs/manage/backup-pg-dump-automate
- Migrar desde Postgres (`-O`, `-c --if-exists`, `-j`, "use the latest `pg_dump`"): https://neon.com/docs/import/migrate-from-postgres
- Respaldos (visión general): https://neon.com/docs/manage/backups
- Versiones soportadas (14 a 18): https://neon.com/docs/postgresql/postgres-version-support y https://neon.com/docs/reference/compatibility
- Versión predeterminada: https://neon.com/docs/changelog/2026-06-05 ("Postgres 18 is now the default for newly created Neon projects", sin fecha visible en la entrada) y https://neon.com/docs/cli/projects ("the default Postgres version, which is Postgres 18")
- Escalado a cero: https://neon.com/docs/introduction/scale-to-zero
- Medición de CU-horas y qué pasa al agotarlas: https://neon.com/docs/introduction/usage-metrics

PostgreSQL y Homebrew:

- `pg_dump` (compatibilidad de versiones, `-Fc`, `-O`, `-x`): https://www.postgresql.org/docs/current/app-pgdump.html
- Fórmula `libpq` (binarios, keg-only, 18.6): https://formulae.brew.sh/formula/libpq

Método: las páginas de Neon se leyeron con una herramienta que extrae y resume el texto, no en el navegador; las cifras (6 h, 100 CU-horas, 1 GB, 18 por defecto) coinciden entre varias páginas. La fecha exacta del cambio de versión predeterminada no figura.
