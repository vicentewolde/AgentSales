# ADR-0022 · Separación por corredor: el alcance del usuario en la API y los repositorios, con 404 para lo ajeno

- **Estado:** Aceptado
- **Fecha:** 2026-10-16

## Contexto
- El modelo es multi-corredor desde F0 (`broker_id` en las tablas raíz), pero la API no separa: casi todas las rutas trabajan por id sin revisar el corredor, y varias listas (`listings.list`, `importRuns.list`, `platformAccounts.list`, `/tracking` y `/agenda`, que filtran en memoria) devuelven todo.
- F7 suma usuarios de corredor que solo deben ver lo suyo (spec F7, D2). El roadmap dejaba RLS como opción.

## Decisión
1. **`AccessScope`** en core: `{ kind: "all" }` para el administrador y `{ kind: "broker", brokerId }` para un corredor. La API lo pone en el contexto de cada pedido a partir de la sesión (ADR-0021).
2. **Listas:** los repositorios reciben el alcance y filtran en SQL por `broker_id` (subiendo por la propiedad cuando la tabla no lo tiene). `?broker=` es un filtro del administrador; un corredor que pide otro corredor recibe 404.
3. **Por id:** cada ruta carga el recurso, sube hasta su corredor y, si está fuera del alcance, responde **404 con el mismo cuerpo que un id inexistente** (no 403: no confirma que exista). Una escritura con varios ids se rechaza entera si alguno es ajeno.
4. **Cargas:** la de un corredor nace con su `broker_id` y el job nunca crea un corredor para ella (`BROKER_MISMATCH` si la hoja trae otro). Una carga con `broker_id` nulo (del administrador, antes de leer la hoja) solo la ve el administrador.
5. **Tabla de permisos por ruta** (`public`, `session`, `admin`) con un test que recorre las rutas de la app y falla si alguna no está clasificada. La vuelta del OAuth de Instagram es `public` (la protegen el `state` y su cookie) y su inicio es `admin`.
6. **Lo que el corredor puede hacer y no** se decide en core (`can`): lo suyo que no puede tocar responde 403.
7. **Sin RLS en F7:** se evalúa en F8 como segunda barrera.

## Consecuencias
- Una regla en un solo lugar por ruta y por lista, probada con una matriz (cada ruta con un id ajeno) y con el inventario de rutas.
- Cada ruta nueva tiene que declarar su permiso: el test lo exige.
- Un error en un repositorio o una ruta puede filtrar datos entre corredores sin una segunda barrera en la base; por eso las pruebas y la revisión del `arquitecto` en cada lote, y RLS en F8.
- Los jobs del worker siguen actuando sobre todo (son del sistema).

## Alternativas descartadas
- **RLS de Postgres desde F7:** exige fijar el usuario por conexión (`SET` por transacción con pg y Drizzle), complica PGlite y los jobs, y no reemplaza las reglas de permisos de la API; queda como segunda barrera.
- **Una base o un esquema por corredor:** multiplica migraciones y conexiones (Neon gratis) para pocos corredores.
- **Filtrar en memoria después de leer todo** (como `/tracking` hoy): no escala y es fácil de olvidar.
- **403 para lo ajeno:** confirma que el id existe.

## Seguimiento
- 2026-10-17 (lote B, PR #131): `POST /auth/logout` es público (idempotente). `/oauth/instagram/start` es `admin` y necesita la cookie `Strict`: si el panel y la API quedan en hosts distintos (`127.0.0.1` y `localhost`, o la API en `https`), la cookie no viaja y responde 401 en vez de volver al panel. Hoy el OAuth está apagado sin HTTPS; F8 lo resuelve al desplegar (mismo host o un enlace firmado de un solo uso).
- 2026-10-17 (lote C, PR #132):
  - **Punto 4, cómo quedó:** la carga de un corredor nace con `input.broker` = su `slug`, y como el `slug` explícito manda sobre el de la hoja (F1), su hoja Corredor solo actualiza la marca **del suyo** (aunque traiga otra marca); `BROKER_MISMATCH` queda como defensa si el job resolviera otro corredor, y nunca se crea uno. Comparar por el nombre de la marca habría rechazado un cambio de nombre legítimo. Qué manda entre la hoja y lo que el corredor edite en Mi marca se decide en el lote E.
  - **Punto 3, dónde vive:** `ownedBy` (`apps/api/src/scope.ts`) carga el recurso y sube hasta su corredor en un solo lugar, montado por prefijo en `createApp`; falla cerrado (un `:id` que no es uuid es 404 para un corredor). La matriz de `apps/api/src/scope.test.ts` recorre cada ruta `session` con id.
  - `listByStatus` y `listDue` no reciben alcance: solo los usa el sistema (el worker, el refresco y desconectar cuentas, que es del administrador).
- 2026-10-17 (lote E, F7-T13 y T14): **la hoja Corredor y Mi marca** escriben los mismos campos y manda la última que se guarda. La planilla que el corredor baja (`GET /brokers/:id/template.xlsx`) viene con su marca vigente, así que cargarla otra vez no deshace lo que editó; una planilla vieja sí (la guía del operador lo advierte desde T18). `/brokers/:id/*` también pasa por `ownedBy` (el corredor es su propio dueño). Riesgo aceptado: editar la marca reescribe la marca entera leída al empezar, así que una carga de la hoja (o otro `PATCH`) que se cruce en el mismo instante puede revertir un campo que el pedido no tocaba; con un operador y pocos corredores es improbable, y repetir la edición lo arregla.
- 2026-10-17 (lote H): el panel decide qué mostrar con `can` de core (`useCan`), no con el rol a mano: si cambia un permiso, el panel lo sigue solo.
