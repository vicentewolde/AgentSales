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
- OAuth Instagram Login; tokens cifrados y refresco automático.
- Publicar carrusel y reel en la cuenta del operador, primero en `dry-run` y luego en `live`.

**Aceptación:** una propiedad aprobada aparece publicada en la cuenta de Instagram del operador y el sistema guarda su URL.

## F4 · Portal Inmobiliario
- OAuth de Mercado Libre, con refresh.
- Descubrimiento y caché de categorías y atributos MLC de inmuebles.
- Mapeo de campos → atributos, con validación previa de obligatorios.
- Publicar con `CMG_SITE`; pausar, reactivar y cerrar; sincronizar estado.

**Aceptación:** una propiedad visible en Portal Inmobiliario desde la cuenta de prueba, y pausable desde el panel.

## F5 · Marketplace
- Perfil de navegador persistente por corredor (login manual una vez).
- Llenado del formulario, subida de fotos y estado `awaiting_manual_confirm`.
- Límite diario, pausas, capturas ante error y detención ante captcha o verificación.

**Aceptación:** el operador publica 3 propiedades en Marketplace haciendo solo el clic final.

## F6 · Calendario + seguimiento
- Programar por publicación y por lote ("publicar estas 5 el lunes a las 10:00").
- Reintentos con backoff exponencial; `failed` con causa legible.
- Job de sincronización periódica.
- Cerrar un listing (vendido/arrendado) despublica o pausa en todas las plataformas.
- Vista de seguimiento: matriz de propiedad × plataforma con estado y enlace.
- `auto_publish` por corredor.
- Respaldo local periódico de la base (`pg_dump`): el plan gratis de Neon solo conserva 6 horas de historial.

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
- Términos de uso y privacidad básicos.

## Post-MVP (backlog)
- Respuestas a DMs, comentarios y preguntas de ML (siguiente gran fase).
- Google Sheets y Drive como origen directo de la carga (spec F2, D8: durante el piloto basta con Excel y zip).
- Sugerencia de portada y orden de fotos con visión de la IA (spec F2, D3).
- Carga por chat (WhatsApp o Telegram).
- Yapo, TikTok, Facebook Page.
- Categoría `product` para vendedores generales.
- Métricas de desempeño por publicación.
