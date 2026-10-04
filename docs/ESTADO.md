# Estado del proyecto

> Este archivo es la memoria de trabajo entre sesiones. Claude lo lee al empezar y lo actualiza al terminar cada tarea. Mantenerlo corto: el historial detallado vive en git y en `CHANGELOG.md`.

**Actualizado:** 2026-10-04
**Fase actual:** F3 · Aprobación + Instagram (spec por redactar en `docs/specs/`)
**Última tarea terminada:** F2-T17 · Cierre de F2 (tag `v0.2.0`)
**Siguiente paso:** `/fase-plan 3` para redactar y aprobar el spec de F3 (ver "Decisiones pendientes")

## Progreso de la fase
| Tarea | Estado | PR |
|---|---|---|
| Spec F3 (`/fase-plan 3`) | ⏳ pendiente | |

Leyenda: ⏳ pendiente · 🔨 en curso · ✅ terminada · ⛔ bloqueada

## Bloqueos y pendientes del operador
- [x] Trámite de la app de Meta: cuenta profesional, app `AgentSales-IG`, tester aceptado (2026-10-02) y `META_APP_ID` y `META_APP_SECRET` en `.env` (2026-10-03). En F3 se confirma que son el par de Instagram que usa el sistema. La verificación del negocio y el App Review quedan para F7
- [ ] Antes de la demo de F3: una cuenta de Instagram de pruebas (profesional y conectada a la app) donde se pueda publicar sin problema. `PUBLISH_MODE=live` solo con tu instrucción en el chat

## Decisiones pendientes para `/fase-plan 3`
- **Cómo nacen las publicaciones (ADR-0012):** desde el contenido vigente de cada canal cuando hay una cuenta conectada. Decidir si se crean al conectar la cuenta, al aprobar o al pedir publicar, y qué pasa con una corrida de textos que llega después de aprobar.
- **Aprobación:** `contents.status = approved` (existe desde F0, sin uso en F2) y la máquina de estados de `publications` con sus eventos; quién aprueba y si una edición después de aprobar vuelve a `edited`.
- **Instagram:** OAuth (Instagram Login o Facebook Login, ver `docs/integraciones/instagram.md`, solo límites de contenido verificados), tokens cifrados con AES-256-GCM y clave derivada con HKDF-SHA256 (deuda abajo), refresco (`tokens.refresh`), y publicación de carrusel y reel con URLs firmadas de R2 que Meta pueda descargar.
- **`PUBLISH_MODE=dry-run`:** el decorador que registra lo que se habría enviado; la demo de F3 se hace en `dry-run` y solo pasa a `live` con instrucción explícita.
- **Ventana de edición (spec F2, riesgos):** un pedido de textos entre la revisión de `editContent` y su guardado no ve la edición. Si en F3 la aprobación lo hace más grave, que la etapa `texts` revise `edited` salvo `replaceEdits`.

## Deuda técnica
- **Videos HDR o de 10 bits (iPhone):** el reel los pasa a yuv420p sin mapear tonos ni etiquetar BT.709 (F2-T08), así que pueden verse lavados. Revisarlo con un video real en la demo de F2; si pasa, sumar `zscale`/`tonemap` y subir `MEDIA_PIPELINE_VERSION`.
- **F7, campos propios y la IA:** el brief (F2-T05) manda a la IA todo campo configurable con valor, salvo los `url`. Si un corredor define un campo propio con datos privados (por ejemplo, "Teléfono del propietario"), la IA lo vería. Hoy las definiciones las crea solo el operador. Antes de que los corredores las editen, agregar un indicador en `field_definitions` (por ejemplo, `ai_visible`), con su ADR.
- **Errores HTTP de filas corruptas:** `FIELD_DEFINITION_INVALID` (repositorio de definiciones, F1) cae en la regla `*_INVALID*` y respondería 400 si una ruta lo expusiera; debería ser `FIELD_DEFINITION_ROW_INVALID` (500), como `CONTENT_RUN_ROW_INVALID` desde F2-T02. Hoy ninguna ruta lo expone.
- **F7, rangos:** la base no impide un `min_value` mayor que `max_value` ni un rango en un campo que no es `number`; hoy lo detecta el validador (`FIELD_CONFIG_INVALID`). Si el panel permite editar definiciones, sumar `CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value)`.
- **F7:** `GET /listings` devuelve la entidad completa: notas internas, dirección exacta y todos los atributos. Es aceptable mientras la API sea local (`hostGuard`). Con autenticación y despliegue, usar una proyección acotada para la lista.
- Panel: el bundle principal pesa 512 kB (157 kB gzip), con las páginas aparte desde F1-T13 (`React.lazy`). El resto queda hasta F7 (D5 del spec F1).
- F7: los archivos subidos por el panel pasan de `tmp/imports` en disco local a R2, con subida directa por URL prefirmada (ADR-0005, enmienda de F1).
- El timeout de `/health` no cancela el check. Si molesta, pasar un `AbortSignal` a `HealthCheck`.
- F3: derivar la clave con HKDF-SHA256 desde `APP_ENCRYPTION_KEY` al cifrar tokens.
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
- 2026-10-04: **Cierre de F2 (`v0.2.0`).** Las 3 muestras con contenido listo para revisar (P001, P002 con reel de 1080×1920, P003 con una edición a mano) y aprobadas por el operador; `pnpm eval:content` con la CLI de Claude, 3 de 3 sin errores; repetir la preparación no reprocesa nada; aviso de "sigue en cola" con el worker apagado; variantes sin EXIF ni GPS; 1661 tests sin llamar a Claude. Auditoría docs-código del `arquitecto` aplicada (README con los requisitos de F2, seguimientos de ADR-0003, 0011, 0012 y 0013). Detalle en `CHANGELOG.md` y en el spec F2.
- 2026-10-03: **Tras la demo de F2-T16:** `INTERNAL_NOTES_LEAK` no cuenta las URLs de las notas y compara con los fines de frase en el mismo lugar (falso positivo en P003; #50).
- **Pendientes de verificar:** la orientación y el color de un HEIC real de iPhone (se probó con uno sintético en F2-T07), un video HDR de iPhone en el reel (deuda), y el largo del título y las reglas de contacto de Mercado Libre (F4: la doc dio 403).
- **Para la próxima demo:** las variantes del Excel se arman en Google Sheets y se exportan como xlsx; la planilla queda como estaba. Neon tiene las 3 propiedades de muestra tal como están en `data/muestras/propiedades.xlsx` (cierre de F1, `v0.1.0`; detalle en `CHANGELOG.md`).
