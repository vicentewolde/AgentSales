# Estado del proyecto

> Este archivo es la memoria de trabajo entre sesiones. Claude lo lee al empezar y lo actualiza al terminar cada tarea. Mantenerlo corto: el historial detallado vive en git y en `CHANGELOG.md`.

**Actualizado:** 2026-10-02
**Fase actual:** F2 · Contenido (spec por redactar: `docs/specs/fase-2-contenido.md`)
**Última tarea terminada:** F1-T15 · Cierre de F1 (tag `v0.1.0`)
**Siguiente paso:** `/fase-plan 2` para redactar y aprobar el spec de F2 (ver "Decisiones pendientes")

## Progreso de la fase
| Tarea | Estado | PR |
|---|---|---|
| Spec F2 (`/fase-plan 2`) | ⏳ pendiente | |

Leyenda: ⏳ pendiente · 🔨 en curso · ✅ terminada · ⛔ bloqueada

## Bloqueos y pendientes del operador
- [ ] Iniciar el trámite de la app de Meta (lento, en paralelo; se usa en F3)

## Decisiones pendientes para `/fase-plan 2`
- **Proveedor de IA:** `LLMProvider` con `claude-cli` y `fake` (ADR-0006); `anthropic-api` como stub, que exige `ANTHROPIC_API_KEY` si se elige.
- **Medios:** variantes `ig_4x5`, `pi_4x3` e `ig_reel` con sharp y ffmpeg, dónde se guardan en R2 y cómo se registran. Las fotos HEIC de iPhone se aceptan desde F1 y se convierten en F2 (sharp con libheif, o ffmpeg como alternativa).
- **Plantillas:** render de portada y ficha con Playwright a PNG (ADR-0010).
- **Evaluación:** `pnpm eval:content` sobre las 3 propiedades de muestra (`agentsales-pruebas`), sin llamar a Anthropic en los tests.
- **Validación de números:** si se suman `min` y `max` a `FieldDefinition` en F2 (ver deuda).
- **Pregunta abierta de F1 (§9):** ¿Google Sheets y Drive hacen falta antes de F3, o basta con Excel y zip durante el piloto?

## Deuda técnica
- **Validación de números:** las definiciones de campo no tienen mínimo ni máximo, así que `dormitorios = -2` o `banos = -1` pasan (visto en la demo 4 de F1). Proponer `min` y `max` en `FieldDefinition` en el spec de la fase que lo tome; el precio ya exige ser mayor que 0.
- **F7:** `GET /listings` devuelve la entidad completa: notas internas, dirección exacta y todos los atributos. Es aceptable mientras la API sea local (`hostGuard`). Con autenticación y despliegue, usar una proyección acotada para la lista.
- Panel: el bundle principal pesa 512 kB (157 kB gzip), con las páginas aparte desde F1-T13 (`React.lazy`). El resto queda hasta F7 (D5 del spec F1).
- F7: los archivos subidos por el panel pasan de `tmp/imports` en disco local a R2, con subida directa por URL prefirmada (ADR-0005, enmienda de F1).
- El timeout de `/health` no cancela el check. Si molesta, pasar un `AbortSignal` a `HealthCheck`.
- F2: exigir `ANTHROPIC_API_KEY` cuando `LLM_PROVIDER=anthropic-api`.
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

- **F2, capas:** el filtro de `fields` del detalle (definiciones efectivas, sin `isCore` y con valor) vive en `apps/api/src/routes/listings.ts`. Cuando las plantillas de F2 lo necesiten, moverlo a core junto a `describeAttributes`.
- Menor: `apps/worker/src/worker.ts` repite la regla de estado terminal en vez de usar `isTerminalImportRun` (core). El comentario de `IMPORT_RUN_ABANDONED_AFTER_MS` (`apps/worker/src/jobs/import-run.ts`) dice "más el backoff", pero el cálculo no lo suma: la hora de margen lo cubre.

## Notas de la última sesión
- 2026-10-02: **Cierre de F1 (`v0.1.0`).**
  - **Demos reales** (plan de demo, spec §7), contra Neon y R2 y sin publicar nada:
    1. `pnpm -s cli import data/muestras/propiedades.xlsx --media data/muestras/medios`: 3 creadas, 12 archivos subidos y el corredor `agentsales-pruebas` creado. P001 con portada `02_living.jpg` (la 2/4 de la galería).
    2. El mismo comando: 3 sin cambios y 12 archivos que ya estaban, sin subir nada.
    3. Copia con el precio de P003 cambiado (exportada desde Google Sheets): 1 actualizada y 2 sin cambios. La exportación de Sheets se lee igual que el Excel original.
    4. Copia con una fila P004 con errores: el reporte muestra la fila 6 con `operacion` («Permuta» no es una opción válida), `comuna` (falta el valor) y `precio` («mucho» no es un número). Las otras 3 quedan sin cambios y la CLI sale con código 1.
    5. Panel → Propiedades → Detalle: las 3 con portada, precio en formato chileno (`UF 6.200`, `$1.400.000/mes`, `UF 5.600`), estado Lista y atributos con etiqueta. La dirección está oculta en P001 y P002 y visible en P003, y el video de P002 (6 s) se reproduce.
    6. Panel → Importar con el xlsx y el zip de medios (comprimido en Finder): "en cola" y luego el reporte, con 3 sin cambios y 12 archivos que ya estaban.
  - **Para la próxima demo:** las variantes del Excel se arman en Google Sheets y se exportan como xlsx; la planilla queda como estaba. Al final, Neon quedó con las 3 propiedades de muestra tal como están en `data/muestras/propiedades.xlsx`.
  - **Criterios:** los de `docs/06-roadmap.md` y spec §6 quedaron verificados (evidencia en el spec). `pnpm check`: 74 archivos y 1103 tests.
  - **Versión:** las apps pasan a `0.1.0` (la API la informa en `/health`).
  - El historial de las tareas F1-T01 a F1-T14 está en el spec (sección "Hecho en" de cada tarea y registro de cambios), en `CHANGELOG.md` y en los PRs #13 a #28.
