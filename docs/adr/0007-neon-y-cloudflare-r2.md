# ADR-0007 · Neon (Postgres) y Cloudflare R2 (archivos) en vez de Supabase

- **Estado:** Aceptado
- **Fecha:** 2026-09-29
- **Reemplaza a:** ADR-0002 (se mantiene solo la decisión de usar Drizzle)

## Contexto
El ADR-0002 elegía Supabase (plan gratis) para base de datos y archivos. Ese plan permite **2 proyectos activos por cuenta**, y el operador ya tiene 2 en uso. Pasar al plan Pro cuesta unos US$25/mes, que no se justifica para un proyecto de hobby en etapa de aprendizaje. Además, el plan gratis de Supabase limita cada archivo a 50 MB y pausa los proyectos por inactividad.

Instagram exige que los medios estén en una **URL accesible desde internet**, así que se necesita almacenamiento en la nube incluso con la app corriendo en local.

## Decisión
- **Base de datos: Neon, plan gratis**, un proyecto `agentsales` en la región AWS São Paulo (`aws-sa-east-1`).
  - Se usa la **conexión directa** (host sin `-pooler`, con `sslmode=require`) para todo: la app, drizzle-kit y pg-boss. El pooler de Neon usa PgBouncer en modo transacción y no soporta bloqueos de sesión, `LISTEN/NOTIFY` ni algunas herramientas de migración.
  - Driver de Postgres estándar (`pg` o `postgres`); no se usa el driver serverless de Neon.
  - **Drizzle ORM + drizzle-kit** se mantienen sin cambios.
- **Archivos: Cloudflare R2, plan gratis**, con la API compatible con S3.
  - Cliente `@aws-sdk/client-s3` y `@aws-sdk/s3-request-presigner`; endpoint `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`, región `auto`.
  - Bucket **privado** `ia-corredor-media`; para publicar se generan **URLs prefirmadas** de lectura (TTL por defecto 1 h; máximo 7 días).
  - Nuevo paquete `packages/storage` que implementa el puerto `MediaStorage`. Cambiar de proveedor S3-compatible (Backblaze B2, Tigris, MinIO) es cambiar el adaptador y las variables de entorno.
- **Autenticación (F7):** ya no es Supabase Auth; el proveedor se decidirá en un ADR propio.
- **Seguridad:** Neon no expone ninguna API HTTP de datos por defecto (solo conexión Postgres con credenciales y TLS), por lo que ya no se exige RLS. La separación por corredor se hace con `broker_id` en cada consulta.

## Consecuencias
**A favor**
- Sin límite de 2 proyectos (Neon gratis permite 100 por organización) y sin límite de 50 MB por archivo.
- R2 no cobra salida de datos, e incluye 10 GB de almacenamiento gratis al mes.
- El adaptador S3 mantiene el almacenamiento intercambiable.

**En contra o a vigilar**
- Dos proveedores y dos cuentas en vez de una.
- **R2 pide tarjeta para activarse.** Cloudflare hace una retención temporal de US$5 para verificarla; no se cobra nada mientras se respeten los límites gratis (10 GB, 1 M de operaciones de escritura y 10 M de lectura al mes).
- Neon gratis: 0,5 GB de base de datos por proyecto y **100 CU-horas al mes** (unas 400 h a 0,25 CU).
- El cómputo de Neon **se suspende tras 5 minutos sin actividad** y no se puede desactivar: la primera conexión tarda unos segundos, así que `/health` y `doctor` usan un timeout de 10 s con un reintento.
- El **worker (pg-boss) mantiene el cómputo despierto** mientras corre; encendido 24/7 agotaría las CU-horas. Se enciende solo al desarrollar.
- Neon gratis solo conserva **6 horas** de historial para restaurar: se agrega un respaldo local periódico (`pg_dump`) en F6.
- Las URLs prefirmadas de R2 **no funcionan con dominios personalizados**. Falta verificar en F3 que Instagram acepta URLs prefirmadas. Plan B: dominio público propio para un prefijo del bucket.

## Alternativas descartadas
- **Supabase Pro (~US$25/mes):** resuelve todo, pero es un gasto fijo prematuro. Se reevalúa en F7.
- **Pausar un proyecto de Supabase o reusarlo con un esquema propio:** ambos proyectos están en uso; compartir base de datos mezcla riesgos y consume su cuota de 500 MB.
- **Backblaze B2 o Tigris en vez de R2:** son válidos gracias al adaptador S3; se eligió R2 por su plan gratis y sus cero costos de salida.
- **Cloudinary u otro servicio de medios:** API propia que ata el diseño; el adaptador S3 es más portable.
