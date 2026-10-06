# Estado del proyecto

> Este archivo es la memoria de trabajo entre sesiones. Claude lo lee al empezar y lo actualiza al terminar cada tarea. Mantenerlo corto: el historial detallado vive en git y en `CHANGELOG.md`.

**Actualizado:** 2026-10-05
**Fase actual:** F3 · Aprobación + Instagram (spec aprobado: `docs/specs/fase-3-aprobacion-instagram.md`)
**Última tarea terminada:** F3-T12 · Job `publication.publish`
**Siguiente paso:** `/tarea F3-T13` · Conectar Instagram

## Progreso de la fase
| Tarea | Estado | PR |
|---|---|---|
| Spec F3 (`/fase-plan 3`) | ✅ terminada | |
| F3-T01 · Esquema de publicaciones (migración `0006`) | ✅ terminada | #54 |
| F3-T02 · Cifrado, firma y variables de Instagram | ✅ terminada | #55 |
| F3-T03 · Cuentas conectadas: puerto y repositorio | ✅ terminada | #56 |
| F3-T04 · Publicaciones: repositorio, bitácora y candado por aviso | ✅ terminada | #57 |
| F3-T05 · Aprobación en core | ✅ terminada | #58 |
| F3-T06 · Lo aprobado no cambia: edición y corridas con el candado | ✅ terminada | #59 |
| F3-T07 · Puerto `Publisher` y `dry-run` | ✅ terminada | #60 |
| F3-T08 · Instagram: cliente de la API y OAuth | ✅ terminada | #61 |
| F3-T09 · Instagram: publisher | ✅ terminada | #62 |
| F3-T10 · Publicar, descartar y retirar en core | ✅ terminada | #63 |
| F3-T11 · Intento de publicación en core | ✅ terminada | #64 |
| F3-T12 · Job `publication.publish` | ✅ terminada | |
| F3-T13 · Conectar Instagram | ⏳ pendiente | |
| F3-T14 · Refresco de tokens | ⏳ pendiente | |
| F3-T15 · API de aprobación y publicaciones | ⏳ pendiente | |
| F3-T16 · CLI | ⏳ pendiente | |
| F3-T17 · Panel: Cuentas | ⏳ pendiente | |
| F3-T18 · Panel: aprobar y publicar | ⏳ pendiente | |
| F3-T19 · `pnpm ig:smoke` | ⏳ pendiente | |
| F3-T20 · Cierre de fase | ⏳ pendiente | |

Leyenda: ⏳ pendiente · 🔨 en curso · ✅ terminada · ⛔ bloqueada

## Bloqueos y pendientes del operador
- [x] Trámite de la app de Meta: cuenta profesional, app `AgentSales-IG`, tester aceptado (2026-10-02) y el ID y la clave de la app de Instagram en `.env` (2026-10-03). La verificación del negocio y el App Review quedan para F7
- [x] Variables renombradas en `.env` a `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` e `INSTAGRAM_REDIRECT_URI` (2026-10-05)
- [x] `INSTAGRAM_APP_ID` es el "Identificador de la aplicación de Instagram" (Casos de uso > Administrar mensajes y contenido en Instagram > Personalizar > Configuración de la API con el inicio de sesión de Instagram), no el identificador general de la app (confirmado por el operador, 2026-10-05)
- [x] Dirección de retorno local: Meta rechazó `http://localhost:8787/oauth/instagram/callback` (2026-10-05). En F3 la cuenta se conecta con el token del botón "Generate token" (spec F3, D4). Permisos `instagram_business_basic` e `instagram_business_content_publish` agregados a la app (2026-10-05)
- [ ] Demo de F3: la prueba en `live` usa tu cuenta (profesional, vinculada a la página AgentSales y tester de `AgentSales-IG`); se publica una propiedad de muestra (carrusel y reel) y se borra a mano después. `PUBLISH_MODE=live` solo con tu instrucción en el chat

## Decisiones de F3
Resueltas en el spec (§4.10, D1–D12) y en ADR-0014: se aprueba el texto de cada canal y las publicaciones nacen aprobadas, una por formato (carrusel y reel), con lo aprobado fijo; sin corridas mientras haya publicaciones pendientes y con un candado por aviso (cierra la ventana de edición de F2); el modo `dry-run`/`live` lo decide cada publicación; OAuth con `http://localhost` o token del panel; sin `DELETE` (se borra a mano y se marca como retirada).

## Deuda técnica
- **Videos HDR o de 10 bits (iPhone):** el reel los pasa a yuv420p sin mapear tonos ni etiquetar BT.709 (F2-T08), así que pueden verse lavados. Revisarlo con un video real en la demo de F2; si pasa, sumar `zscale`/`tonemap` y subir `MEDIA_PIPELINE_VERSION`.
- **F7, campos propios y la IA:** el brief (F2-T05) manda a la IA todo campo configurable con valor, salvo los `url`. Si un corredor define un campo propio con datos privados (por ejemplo, "Teléfono del propietario"), la IA lo vería. Hoy las definiciones las crea solo el operador. Antes de que los corredores las editen, agregar un indicador en `field_definitions` (por ejemplo, `ai_visible`), con su ADR.
- **Errores HTTP de filas corruptas:** `FIELD_DEFINITION_INVALID` (repositorio de definiciones, F1) cae en la regla `*_INVALID*` y respondería 400 si una ruta lo expusiera; debería ser `FIELD_DEFINITION_ROW_INVALID` (500), como `CONTENT_RUN_ROW_INVALID` desde F2-T02. Hoy ninguna ruta lo expone.
- **F7, rangos:** la base no impide un `min_value` mayor que `max_value` ni un rango en un campo que no es `number`; hoy lo detecta el validador (`FIELD_CONFIG_INVALID`). Si el panel permite editar definiciones, sumar `CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value)`.
- **F7:** `GET /listings` devuelve la entidad completa: notas internas, dirección exacta y todos los atributos. Es aceptable mientras la API sea local (`hostGuard`). Con autenticación y despliegue, usar una proyección acotada para la lista.
- Panel: el bundle principal pesa 512 kB (157 kB gzip), con las páginas aparte desde F1-T13 (`React.lazy`). El resto queda hasta F7 (D5 del spec F1).
- F7: los archivos subidos por el panel pasan de `tmp/imports` en disco local a R2, con subida directa por URL prefirmada (ADR-0005, enmienda de F1).
- **F7:** `createInstagramAuth` exige `INSTAGRAM_APP_SECRET` aunque el refresco no lo use, así que el worker (T14) lo carga solo para refrescar. Aceptable en local; separar el refresco del canje si el worker se despliega aparte.
- El timeout de `/health` no cancela el check. Si molesta, pasar un `AbortSignal` a `HealthCheck`.
- F5: resolver `BROWSER_PROFILES_DIR` contra la raíz del workspace.
- El redactor oculta cualquier clave con `key` (por ejemplo `objectKey`): en logs usar nombres como `objectPath`.
- **F7:** exceljs carga el xlsx completo en memoria, y el tope de filas se revisa después. Un xlsx de 10 MB (que es un zip) podría descomprimirse en mucho más dentro de exceljs. El cuerpo de la subida ya tiene tope (T11: `MAX_IMPORT_UPLOAD_MB` y 413), y el zip de medios también (T06: 4 GB y `validateEntrySizes`). Falta limitar el tamaño descomprimido del xlsx con subidas públicas.
- **F7, subidas del panel:**
  - Hono lee el multipart completo en memoria; con los archivos escritos en streaming, el pico es de unas 2 veces el cuerpo (de ahí el default de 512 MB).
  - F7 cambia esto por la subida directa a R2 con URL prefirmada: `import_runs.input` pasa a claves de R2, y se quitan `POST /imports/local` y el staging compartido.
  - El despliegue fija `NODE_ENV=production` (`/imports/local` depende de eso). Ver `docs/06-roadmap.md` → F7.
- **exceljs 4.4.0** (T03) no tiene versiones estables desde 2023. `pnpm audit --prod` da una vulnerabilidad moderada en `uuid` 8, que no nos afecta: exceljs solo usa `v4`, y el aviso es de v3/v5/v6. Revisar en cada fase si hay una versión nueva o una alternativa mantenida.
- **F7:** `tsc -b` compila `packages/*/test` a `dist` (por ejemplo `test/pglite.ts`, que importa una `devDependency`), y también `apps/api/src/testing` (importa `@agentsales/core/testing`) y `apps/cli/test`. Excluirlos del build de producción al armar el despliegue.
- **F7:** `agentsales listing --broker` resuelve el corredor en la CLI con `/brokers`. Con autenticación y varios clientes, el alcance por corredor lo tiene que hacer el servidor (junto con la proyección acotada de `GET /listings`).
- `--broker` se normaliza con `slugify` solo en la CLI: `POST /imports/local` con `"Mi Corredor"` da `BROKER_NOT_FOUND`. Hoy no importa (el panel usa un selector); si aparece otro cliente, normalizar en core (`requestImport`).

- Menor: `apps/worker/src/worker.ts` repite la regla de estado terminal en vez de usar `isTerminalImportRun` (core). El comentario de `IMPORT_RUN_ABANDONED_AFTER_MS` (`apps/worker/src/jobs/import-run.ts`) dice "más el backoff", pero el cálculo no lo suma: la hora de margen lo cubre.

## Notas de la última sesión
- 2026-10-06: **F3-T12.** Job `publication.publish` en el worker: corre el intento de T11 con el publisher de Instagram (registrado en los dos modos; el cliente se arma recién al primer intento en vivo), la señal de apagado y el número de reintento; al arrancar reencola las publicaciones en `publishing`; el log lleva solo ids y códigos. Seguimiento en ADR-0005.
- 2026-10-05: **F3-T11.** Intento de publicación en core (`publishPublication`, el handler de `publication.publish`): el modo lo decide la publicación (`PUBLISH_MODE_MISMATCH` si se pidió en `live` y el worker está en `dry-run`), revisa la cuenta y sus credenciales, arma el input con URLs firmadas, publica con el progreso guardado y deja `published` (el aviso a `active` en `live`) o, según el error, sigue en `publishing` para reintentar o queda `failed` con su motivo; `IG_AUTH_INVALID` vence la cuenta. Un solo `publish_attempt` por intento, con lo enviado y sin secretos. Si la plataforma publicó y falla guardar el resultado, la publicación sigue en `publishing` (`PUBLISH_RESULT_NOT_SAVED`) y el reintento la reconoce sin publicar de nuevo.
- 2026-10-05: **F3-T10.** Publicar en core: el canal (`publishListing`: abre las que faltan, pasa `approved`/`failed` a `publishing` con el modo de la API, reencola las que ya estaban en curso y encola después del candado) o una (`startPublication`); descartar (`cancelPublication`) y marcar como retirada (`retirePublication`: en `live` exige la confirmación de que se borró a mano, y la última en `live` devuelve el aviso a `ready`). Algo que empezó en `live` no se reintenta en `dry-run` (`PUBLISH_MODE_LOCKED`). Job `publication.publish` en el contrato de core (la cola la crea el worker en T12).
- 2026-10-05: **F3-T09.** Publisher de Instagram (`createInstagramPublisher`): revisión previa pura (`validateInstagramInput`: imágenes, reel, proporción, caption, hashtags y menciones), cupo, carrusel o imagen suelta y reel, sondeo con reloj inyectable y tope de 12 min por intento, progreso guardado antes de sondear y antes de `media_publish`, y retoma sin duplicar (`FINISHED` publica, `PUBLISHED` busca el medio del mismo formato y caption, un contenedor trabado o `EXPIRED`/`ERROR` se rehace, un pedido sin respuesta se reconoce antes de repetirlo). Cliente perezoso: validar y simular no lo construyen. Probado con un Instagram simulado con estado y reloj falso. macOS borró la caché de Playwright con el disco al 95 %: si fallan las pruebas de render con "No se encontró Chromium", reinstalarlo (`pnpm --filter @agentsales/media exec playwright install chromium`).
- 2026-10-05: **F3-T08.** Paquete nuevo `packages/publishers` con el cliente de Instagram: OAuth (`createInstagramAuth`, puerto `InstagramAuth` de core: URL de permisos, canje del código sin el `#_`, token largo, refresco y `/me`), la Graph API (`createInstagramGraph`: contenedores, estado, `media_publish`, medio, últimos medios y cupo; token en la cabecera, versión fija, respuestas con o sin `data`, tope de 30 s y señal) y la tabla de errores `IG_*`. Probado solo con msw; ningún error lleva tokens, el secret ni el código. La revisión dejó decidido en el spec cómo T13 y T14 tratan la cuenta conectada con el token del panel (permisos y vencimiento desconocidos) y el refresco a pedido síncrono (seguimiento de ADR-0014).
- 2026-10-05: **F3-T07.** Contrato `Publisher` en core, con `buildPublishInput` (caption y medios de `media_ids` con URLs firmadas de 1 h; revisa antes que el texto siga aprobado y que estén los medios), `checkPublishInput` (plataforma, formato y `validate`; `PUBLISH_INPUT_INVALID` con los motivos), `withDryRun` (valida y devuelve `dry-run:<id>`; nunca llama al publisher real) y `publishAttemptRecord` (lo enviado, sin URLs ni tokens, para la bitácora de cada intento, también en `live`). Publisher falso `createFakePublisher` para T10 a T12.
- 2026-10-05: **F3-T06.** Editar y pedir una corrida corren dentro del candado por aviso (la ventana de edición de F2 se cerró, con un test de concurrencia); un texto con publicación activa no se edita (`CONTENT_LOCKED`) y no se prepara de nuevo con publicaciones pendientes (`PUBLICATION_PENDING`); el job se encola después de confirmar. La API compone el candado.
- 2026-10-05: **F3-T05.** Aprobar y quitar la aprobación en core, dentro del candado: el texto pasa a `approved` y nacen sus publicaciones (carrusel y reel) en la cuenta conectada, con sus medios fijos; un formato con una publicación activa se salta y se informa.
- 2026-10-05: **F3-T04.** Repositorio de publicaciones (cada transición condicional, con su evento en la misma transacción; progreso validado al escribir) y candado por aviso (`createListingLock`: bloquea la fila del aviso y entrega repositorios de la transacción). Rollback y savepoints probados en PGlite. La bitácora usa `clock_timestamp()` para no desordenarse dentro de una transacción.
- 2026-10-05: **F3-T03.** Repositorio de cuentas conectadas: cifra el token al guardar (AAD `platform:external_account_id`) y lo descifra solo en `getCredentials`; la entidad lleva `hasCredentials`. Suite de contrato compartida entre el doble en memoria y PGlite, más pruebas del cifrado en la fila cruda, con otra clave y con un cifrado copiado de otra cuenta.
- 2026-10-05: **F3-T02.** Cifrado de credenciales (AES-256-GCM) y firma del `state` del OAuth (HMAC), con claves derivadas por HKDF-SHA256 desde `APP_ENCRYPTION_KEY` (deuda de F0 pagada). Variables `INSTAGRAM_*`; una `META_*` que quede en `.env` es un error con su nombre nuevo. `doctor` avisa si falta el par de Instagram. El redactor oculta el `code` del OAuth y los secretos de formularios.
- 2026-10-05: **F3-T01.** Publicaciones sin `draft` ni `pending_approval`, con `format` (`post`, `reel`) y `progress`; único parcial por aviso, cuenta y formato. La migración `0006` se ajustó a mano (drizzle-kit borraba el índice después de recrear el tipo) y falla si la tabla tiene filas. Neon tenía `publications` vacía; la `0006` se aplica después del merge.
- 2026-10-04: **`/fase-plan 3`.** Nota `docs/integraciones/instagram.md` completada (OAuth, tokens, publicación, borrado, límites y errores; lo no verificado se prueba en la demo). Spec F3 aprobado con 20 tareas, revisado por el `arquitecto` (encolar después del candado, modo por publicación, SQL de la migración `0006` a mano). ADR-0014 aceptado; arquitectura, formato, roadmap y glosario al día.
- 2026-10-04: **Cierre de F2 (`v0.2.0`).** Las 3 muestras con contenido listo para revisar (P001, P002 con reel de 1080×1920, P003 con una edición a mano) y aprobadas por el operador; `pnpm eval:content` con la CLI de Claude, 3 de 3 sin errores; repetir la preparación no reprocesa nada; aviso de "sigue en cola" con el worker apagado; variantes sin EXIF ni GPS; 1661 tests sin llamar a Claude. Auditoría docs-código del `arquitecto` aplicada (README con los requisitos de F2, seguimientos de ADR-0003, 0011, 0012 y 0013). Detalle en `CHANGELOG.md` y en el spec F2.
- 2026-10-03: **Tras la demo de F2-T16:** `INTERNAL_NOTES_LEAK` no cuenta las URLs de las notas y compara con los fines de frase en el mismo lugar (falso positivo en P003; #50).
- **Pendientes de verificar:** la orientación y el color de un HEIC real de iPhone (se probó con uno sintético en F2-T07), un video HDR de iPhone en el reel (deuda), y el largo del título y las reglas de contacto de Mercado Libre (F4: la doc dio 403).
- **Para la próxima demo:** las variantes del Excel se arman en Google Sheets y se exportan como xlsx; la planilla queda como estaba. Neon tiene las 3 propiedades de muestra tal como están en `data/muestras/propiedades.xlsx` (cierre de F1, `v0.1.0`; detalle en `CHANGELOG.md`).
