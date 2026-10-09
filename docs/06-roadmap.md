# 06 · Roadmap

Cada fase entrega algo **usable y demostrable**. Una fase empieza con su spec en `docs/specs/` (con `/fase-plan`) y termina con `/fase-cerrar` cuando se cumplen todos sus criterios de aceptación.

| Fase | Nombre | Entregable | Tag |
|---|---|---|---|
| F0 | Fundaciones | Monorepo que compila, con base de datos, almacenamiento R2, API, worker, panel y CLI vacíos | v0.0.1 |
| F1 | Carga | Importar Excel con fotos y ver las propiedades en panel y CLI | v0.1.0 |
| F2 | Contenido | Textos IA, imágenes procesadas, carrusel y reel en vista previa | v0.2.0 |
| F3 | Aprobación + Instagram | Aprobar y publicar en Instagram al instante | v0.3.0 |
| F4 | Portal Inmobiliario | Publicar, pausar y cerrar en Portal Inmobiliario | v0.4.0 |
| F5 | Marketplace | Flujo semiautomático en Facebook Marketplace | v0.5.0 |
| F6 | Calendario + seguimiento | Programación, reintentos, sincronización, "vendida" despublica todo | v0.6.0 |
| F7 | Listo para terceros | Onboarding de corredores, API key de Anthropic, auth, despliegue | v1.0.0 |

## F0 · Fundaciones
Spec detallado: `docs/specs/fase-0-fundaciones.md`.

**Criterios de aceptación**
- `pnpm install && pnpm check` pasa en limpio.
- `pnpm dev` levanta API, worker y web; `GET /health` responde con estado de base de datos, storage y cola.
- Migración inicial aplicada en Neon con todas las tablas de `02-modelo-datos.md`.
- `pnpm -s cli doctor` (con `pnpm dev` corriendo) verifica Node, `.env`, `PUBLISH_MODE`, API, base de datos, storage, cola, ffmpeg, Playwright y Claude CLI.
- CI en GitHub Actions ejecuta `pnpm check`, verifica que las migraciones estén al día y construye el panel en cada PR y push a `main`; el check es obligatorio para hacer merge.

## F1 · Carga
Spec detallado: `docs/specs/fase-1-carga.md`.

**Criterios de aceptación**
- `pnpm cli import ./data/muestras/propiedades.xlsx --media ./data/muestras/medios` crea o actualiza propiedades y sube los medios.
- Reimportar el mismo archivo no duplica nada (idempotencia).
- Filas inválidas no detienen la carga; el reporte muestra fila, columna y motivo.
- Agregar un campo en `field_definitions` hace que se importe sin tocar el código.
- El panel lista propiedades con portada, estado y detalle con galería.

## F2 · Contenido
Spec detallado: `docs/specs/fase-2-contenido.md`.

- Proveedor `LLMProvider` con `claude-cli` y `fake`; `anthropic-api` como stub.
- Prompt versionado; salida validada con zod según `04-formato-publicaciones.md`. Textos híbridos: los datos los pone el código y la IA redacta las frases (ADR-0013).
- Procesamiento de medios: variantes `thumb`, `ig_4x5`, `pi_4x3`, `ig_reel`; HEIC → JPEG; sin metadatos GPS. La portada es la del operador (`foto_portada`).
- Render de plantillas (portada y ficha) con Playwright, en JPEG.
- Vista previa en el panel: carrusel IG, caption, reel, textos de Portal y Marketplace, con edición manual.
- `pnpm eval:content` corre el generador sobre las 3 propiedades de muestra y revisa las reglas editoriales (sin datos inventados).
- Mínimos y máximos en los campos numéricos (deuda de F1).

**Aceptación:** las 3 propiedades de muestra quedan con contenido listo para revisar (`contents` en `draft` o `edited`, sin publicaciones: ADR-0012) que el operador aprobaría sin cambios mayores.

## F3 · Aprobación + Instagram
Spec detallado: `docs/specs/fase-3-aprobacion-instagram.md`.

- Se aprueba el texto de cada canal; las publicaciones nacen aprobadas, una por formato (carrusel y reel), con lo aprobado fijo (ADR-0014). Máquina de estados con eventos.
- Aprobar y quitar la aprobación desde el panel y la CLI (`agentsales approve <id>`); los textos se editan en el panel (spec F3, D9).
- Conectar la cuenta con el token del panel de Meta (spec F3, D4; el OAuth de Instagram Login queda implementado y se usa en F7, con HTTPS); tokens cifrados y refresco automático.
- Publicar carrusel y reel en la cuenta del operador, primero en `dry-run` y luego en `live`.

**Aceptación:** una propiedad aprobada aparece publicada en la cuenta de Instagram del operador y el sistema guarda su URL.

## F4 · Portal Inmobiliario
Spec detallado: `docs/specs/fase-4-portal-inmobiliario.md`.

- OAuth de Mercado Libre pegando la dirección de vuelta en la CLI (sin túnel), con tokens que rotan y un candado por cuenta (ADR-0015).
- Descubrimiento y caché en la base de las categorías, atributos y ubicaciones MLC de inmuebles que se usan.
- Mapeo de campos → atributos, con validación previa de obligatorios (sin inventar datos) y, en `dry-run`, la validación de Mercado Libre sin publicar (ADR-0016).
- Publicar con `CMG_SITE` y el WhatsApp del corredor; pausar, reactivar y cerrar; sincronizar estado (a pedido y después de publicar).

**Aceptación:** en simulación, una propiedad aprobada pasa la revisión de AgentSales y la consulta a Mercado Libre sin publicar, y se pausa, reactiva y cierra desde el panel y la CLI (spec F4 §6). La prueba en vivo pasa al inicio de F5 (decisión del operador, 2026-10-09): un aviso visible con un usuario de prueba y su paquete sin cargo (D15), pausable desde el panel.

## F5 · Marketplace
- Perfil de navegador persistente por corredor (login manual una vez).
- Llenado del formulario, subida de fotos y estado `awaiting_manual_confirm`.
- Límite diario, pausas, capturas ante error y detención ante captcha o verificación.

**Al empezar, pendiente de F4:** la prueba en vivo de Portal (spec F4 §6, criterios 1 a 3, y §7, paso 6), y confirmar lo que `validate` no revisó sin cupo: `CMG_SITE` oculto, la forma de las superficies, `address_line` con `show_exact_address = false`, la descripción dentro del cuerpo y que el 402 sea por falta de cupo.

**Aceptación:** el operador publica 3 propiedades en Marketplace haciendo solo el clic final.

## F6 · Calendario + seguimiento
- Programar por publicación y por lote ("publicar estas 5 el lunes a las 10:00").
- Reintentos con backoff exponencial; `failed` con causa legible.
- Job de sincronización periódica (F4 deja `publication.sync` a pedido, después de publicar y al arrancar el worker).
- Portal Inmobiliario: editar un aviso publicado, republicar (`relist`) uno vencido o cerrado y avisar antes del vencimiento (spec F4, §3).
- Cerrar un listing (vendido/arrendado) despublica o pausa en todas las plataformas.
- Vista de seguimiento: matriz de propiedad × plataforma con estado y enlace.
- `auto_publish` por corredor.
- Respaldo local periódico de la base (`pg_dump`): el plan gratis de Neon solo conserva 6 horas de historial.
- **Deuda heredada de F3** (detalle en `docs/ESTADO.md` → Deuda técnica):
  - las publicaciones que quedan en `publishing` sin job (`PUBLISH_ABORTED`, `PUBLISH_RESULT_NOT_SAVED`) las cubre `publication.sync` o un reencolado periódico;
  - redefinir los cambios manuales del aviso (`LISTING_MANUAL_TRANSITIONS`) para que pausar, archivar o cerrar orquesten sus publicaciones (spec F3 §3);
  - la espera automática ante `IG_RATE_LIMITED` (spec F3, D10).

## F7 · Listo para terceros
- Proveedor `anthropic-api` como default para terceros.
- Autenticación (proveedor a decidir en un ADR) y separación estricta por corredor (`broker_id` en cada consulta, con RLS opcional).
- Onboarding: conectar cuentas, subir marca y plantilla de campos.
- App Review de Meta; despliegue (ej. Fly.io o Railway) con backups.
- **Deuda heredada de F1** (detalle en `docs/ESTADO.md` → Deuda técnica):
  - las subidas del panel pasan a ser directas a R2, con una URL prefirmada, y `import_runs.input` pasa de rutas locales a claves de R2 (seguimiento de ADR-0005);
  - se quita `POST /imports/local` y el staging compartido en disco entre la API y el worker;
  - el despliegue fija `NODE_ENV=production`, porque `/imports/local` depende de ese valor;
  - `GET /listings` pasa a una proyección acotada (hoy entrega notas internas y la dirección exacta).
- **Deuda heredada de F3** (detalle en `docs/ESTADO.md` → Deuda técnica):
  - probar el OAuth de Instagram de verdad, con HTTPS;
  - el actor de la bitácora sale de la sesión, no de la cabecera `X-AgentSales-Client`;
  - autorizar quién conecta cada corredor y no repetir un `state` válido (guardar el nonce usado);
  - derivar el inicio del OAuth si la API queda tras un prefijo;
  - el tope de tiempo de `tokens.refresh` con muchas cuentas.
- Términos de uso y privacidad básicos.

## Post-MVP (backlog)
- Respuestas a DMs, comentarios y preguntas de ML (siguiente gran fase).
- Google Sheets y Drive como origen directo de la carga (spec F2, D8: durante el piloto basta con Excel y zip).
- Sugerencia de portada y orden de fotos con visión de la IA (spec F2, D3).
- Carga por chat (WhatsApp o Telegram).
- Yapo, TikTok, Facebook Page.
- Categoría `product` para vendedores generales.
- Métricas de desempeño por publicación.
