# ADR-0002 · Supabase para base de datos y archivos, con Drizzle

- **Estado:** Aceptado
- **Fecha:** 2026-09-28

## Contexto
La app corre en local, pero Instagram exige que los medios estén en una **URL pública** para descargarlos. Además, habrá varios corredores y más adelante acceso de terceros.

## Decisión
- **Supabase Cloud (plan gratis)** desde el día 1: Postgres y Storage.
- Bucket `media` **privado**; para publicar se generan URLs firmadas de corta duración.
- **Drizzle ORM + drizzle-kit** para el esquema y las migraciones SQL versionadas en git. Conexión directa a Postgres (no se usa el cliente REST de Supabase para datos).
- El cliente `@supabase/supabase-js` se usa solo para Storage (y para Auth en F7).

## Consecuencias
- Todas las tablas con **RLS activado y sin políticas**: el backend usa la conexión Postgres directa (rol `postgres`, que ignora RLS) y la API REST de Supabase no puede leer nada.
- Plan gratis: 500 MB de base de datos, 1 GB de Storage y **50 MB máximo por archivo**.
- Conexión: **Session pooler** (IPv4, puerto 5432) por defecto, porque la conexión directa del plan gratis es solo IPv6.
- No hace falta Docker para desarrollar.
- Los proyectos gratis se pausan tras un periodo de inactividad: basta con reactivarlo desde el dashboard.
- Migrar a Postgres propio más adelante es directo, porque el esquema es Drizzle y SQL estándar.

## Alternativas descartadas
- **SQLite local + túnel para servir archivos:** más piezas frágiles, y habría que migrar después.
- **Supabase local con Docker:** posible más adelante para tests de integración; no es necesario para arrancar.
