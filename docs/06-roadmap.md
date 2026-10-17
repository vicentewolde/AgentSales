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
| F6 | Calendario + seguimiento | Programación, reintentos, sincronización, "vendida" cierra Portal y deja tareas a mano en Instagram y Marketplace | v0.6.0 |
| F7 | Varios corredores | Login, cada corredor ve solo lo suyo, alta de corredores, IA por API con gasto por corredor (en el Mac del operador) | v0.7.0 |
| F8 | En internet | Despliegue con HTTPS, subidas a R2, respaldos fuera del Mac, OAuth de Instagram, App Review y términos | v1.0.0 |

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

**Aceptación:** el operador publica 3 propiedades en Marketplace haciendo solo el clic final. Desde el spec (D10, respuesta del operador): en `live` el sistema llena 3 formularios y el operador los revisa sin publicarlos, salvo una propiedad real; la confirmación con enlace se prueba con tests.

**Spec:** `docs/specs/fase-5-marketplace.md` (ADR-0017). Suma la conversión de UF a pesos con el valor oficial del día (D9) y el plan B de copiar y pegar en el panel (D13).

**Cerrada el 2026-10-14 (`v0.5.0`):** en `live` se llenaron 3 formularios (P002, P004 y P005) y el operador los revisó sin publicarlos. El formulario de Chile es solo de arriendo (D15: las ventas no van a Marketplace) y la ubicación usa la dirección de la planilla (D16).

## F6 · Calendario + seguimiento
- Programar por publicación y por lote ("publicar estas 5 el lunes a las 10:00").
- Reintentos con backoff exponencial; `failed` con causa legible.
- Job de sincronización periódica (F4 deja `publication.sync` a pedido, después de publicar y al arrancar el worker).
- Portal Inmobiliario: editar un aviso publicado, republicar (`relist`) uno vencido o cerrado y avisar antes del vencimiento (spec F4, §3).
- Cerrar un listing (vendido/arrendado) cierra Portal, descarta lo pendiente y deja Instagram y Marketplace en vivo como tareas a mano (D3 y D4).
- Vista de seguimiento: matriz de propiedad × plataforma con estado y enlace.
- `auto_publish` por corredor.
- Respaldo local periódico de la base (`pg_dump`): el plan gratis de Neon solo conserva 6 horas de historial.
- **Deuda heredada de F3** (detalle en `docs/ESTADO.md` → Deuda técnica):
  - las publicaciones que quedan en `publishing` sin job (`PUBLISH_ABORTED`, `PUBLISH_RESULT_NOT_SAVED`) las cubre `publication.sync` o un reencolado periódico;
  - redefinir los cambios manuales del aviso (`LISTING_MANUAL_TRANSITIONS`) para que pausar, archivar o cerrar orquesten sus publicaciones (spec F3 §3);
  - la espera automática ante `IG_RATE_LIMITED` (spec F3, D10).

**Spec:** `docs/specs/fase-6-calendario-seguimiento.md` (ADR-0018, ADR-0019 y ADR-0020), aprobado el 2026-10-15. Respuestas del operador: lo programado con el worker apagado sale si el atraso es de 12 h o menos (D2); vendida o arrendada **cierra** Portal (D3); Instagram y Marketplace quedan como tareas a mano (D4); `auto_publish` aprueba y publica de inmediato los textos sin errores (D5). Marketplace en el calendario es solo un recordatorio. Suma el respaldo con `pg_dump` (cliente de Postgres de Homebrew) y la vista de Seguimiento con la agenda.

## F7 · Varios corredores
Spec detallado: `docs/specs/fase-7-varios-corredores.md` (2026-10-16: el operador partió la antigua "Listo para terceros" en F7 y F8).

- Usuarios (operador administrador y usuarios de corredor), autenticación propia con sesiones e invitaciones (ADR-0021).
- Separación estricta por corredor en la API y los repositorios, con 404 para lo ajeno (ADR-0022; RLS se evalúa en F8).
- Alta de corredores: marca, logo, su planilla de Excel y la lista de pasos; el corredor hace casi todo con lo suyo y el operador lo sensible.
- Proveedor `anthropic-api` para los corredores (la clave del operador), con el gasto por corredor y un tope mensual opcional; el plan del operador para sus corredores propios.
- Marketplace a mano para los corredores (ADR-0023); Instagram del corredor como evaluador de la app (App Review en F8).
- **Deuda que cierra:** el actor de la bitácora desde la sesión y quién conecta cada corredor (F3); el `state` de Mercado Libre de un solo uso (F4); `/tracking` y `/agenda` filtrados en el servidor, `listCurrentMany` y el `now` de la ruta (F6); `GET /listings` con una proyección acotada (F1); `/health` con el detalle solo para el administrador (F6).

## F8 · En internet
- Despliegue (ej. Fly.io o Railway) con HTTPS y dominio propio; `NODE_ENV=production`, el panel servido sin Vite, host, panel y orígenes por configuración; respaldos fuera del Mac.
- App Review de Meta y el OAuth de Instagram de verdad, con HTTPS; términos de uso y privacidad básicos; revisar los términos comerciales de Anthropic para atender a varios clientes con una clave.
- Endurecer el login para internet (límites por IP, doble factor opcional) y evaluar RLS como segunda barrera (ADR-0021 y ADR-0022).
- Marketplace en un servidor: el formulario automático necesita el Mac del operador (ADR-0017 y ADR-0023): decidir cómo convive con el despliegue.
- **Deuda heredada de F1** (detalle en `docs/ESTADO.md` → Deuda técnica):
  - las subidas del panel pasan a ser directas a R2, con una URL prefirmada, y `import_runs.input` pasa de rutas locales a claves de R2 (seguimiento de ADR-0005);
  - se quita `POST /imports/local` y el staging compartido en disco entre la API y el worker;
  - el despliegue fija `NODE_ENV=production`, porque `/imports/local` depende de ese valor.
- **Deuda heredada de F3** (detalle en `docs/ESTADO.md` → Deuda técnica):
  - probar el OAuth de Instagram de verdad, con HTTPS;
  - no repetir un `state` válido de Instagram (guardar el nonce usado);
  - derivar el inicio del OAuth si la API queda tras un prefijo;
  - el tope de tiempo de `tokens.refresh` con muchas cuentas.
- **Deuda heredada de F6:** ocultar o proteger en `/health` la versión de Postgres al desplegar; un `auto_publish` cortado por el apagado no se reintenta; una pausa que un sync aplicó antes que la propiedad queda sin `byListing`; la prueba en vivo de Portal (D15 de F4) confirma el `relist` y la regla de `pictures` en pausar y cerrar.
- **Deuda heredada de F7** (detalle en `docs/ESTADO.md` → Deuda técnica):
  - restringir el CORS a los orígenes propios, porque la API acepta `Authorization` sin el control de origen del panel (seguimiento de ADR-0021);
  - la cookie de sesión con prefijo `__Host-` y `Secure` al servir con HTTPS;
  - `/oauth/instagram/start` en el mismo host que el panel;
  - la API arrastra Playwright a través de `@agentsales/media` (el logo usa solo sharp): separarlo al desplegar;
  - la dirección de vuelta de Mercado Libre con el dominio real.

## Post-MVP (backlog)
- Respuestas a DMs, comentarios y preguntas de ML (siguiente gran fase).
- Google Sheets y Drive como origen directo de la carga (spec F2, D8: durante el piloto basta con Excel y zip).
- Sugerencia de portada y orden de fotos con visión de la IA (spec F2, D3).
- Carga por chat (WhatsApp o Telegram).
- Yapo, TikTok, Facebook Page.
- Categoría `product` para vendedores generales.
- Métricas de desempeño por publicación.
