# 09 · Alta de Neon y Cloudflare R2 (paso a paso, sin terminal)

Guía para el operador. Decisión y motivos: `docs/adr/0007-neon-y-cloudflare-r2.md`. Los nombres de menús pueden variar levemente según las actualizaciones de cada servicio.

Al terminar tendrás 5 valores para el `.env`: `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` y `R2_BUCKET`.

## A. Neon (base de datos)

1. Entra a **neon.com** → **Sign up** → **Continue with GitHub**.
2. **Create project**:
   - Name: `agentsales`
   - Postgres version: la que viene por defecto
   - Region: **AWS South America (São Paulo)** (`aws-sa-east-1`)
   - Clic en **Create**.
3. En el panel del proyecto, clic en **Connect**. En el cuadro que se abre:
   - Branch: el principal (`main` o `production`).
   - Database: `neondb` · Role: `neondb_owner`.
   - **Apaga el interruptor "Connection pooling"**. Si el host de la cadena contiene `-pooler`, es la conexión equivocada.
   - Clic en **Show password** y copia la cadena completa.
4. Debe verse así:
   ```
   postgresql://neondb_owner:CLAVE@ep-xxxxxxxx.sa-east-1.aws.neon.tech/neondb?sslmode=require
   ```
   Si la cadena trae `&channel_binding=require` al final, bórralo. Deja solo `?sslmode=require`.
5. Ese texto va en `DATABASE_URL` del `.env`.

## B. Cloudflare R2 (archivos)

1. Entra a **dash.cloudflare.com** → **Sign up** (correo y contraseña) → confirma el correo.
2. En el menú izquierdo abre **R2 Object Storage** (bajo "Storage & databases"). Clic en **Purchase R2 Plan** o **Add payment method** y elige el plan gratis.
   - **Pide una tarjeta.** Cloudflare hace una retención temporal de US$5 para verificarla; no es un cobro.
   - No se cobra nada mientras no superes 10 GB almacenados, 1 millón de operaciones de escritura y 10 millones de lecturas al mes.
3. **Create bucket**:
   - Name: `agentsales-media`
   - Location: **Automatic**
   - Default storage class: **Standard**
   - Déjalo **privado**: no actives "Public access", "r2.dev" ni dominios personalizados.
4. Vuelve a la pantalla principal de R2 y copia el **Account ID** (aparece en "Account details" y también dentro de la URL del endpoint S3).
5. En la misma pantalla, clic en **Manage** junto a "API Tokens" → **Create Account API token** (si no aparece, **User API token**):
   - Permissions: **Object Read & Write**
   - Specify bucket: solo `agentsales-media`
   - TTL: sin vencimiento
   - Clic en **Create**.
6. Copia **Access Key ID** y **Secret Access Key**. **El secreto se muestra una sola vez**: guárdalo de inmediato en tu gestor de contraseñas. El "Token value" que aparece también no se usa.
7. En el `.env`:
   ```env
   R2_ACCOUNT_ID=<Account ID>
   R2_ACCESS_KEY_ID=<Access Key ID>
   R2_SECRET_ACCESS_KEY=<Secret Access Key>
   R2_BUCKET=agentsales-media
   ```

## C. Qué NO hacer
- No crees tablas a mano en Neon: todo sale de las migraciones de Drizzle (F0-T04).
- No hagas público el bucket ni pegues las claves en el chat, en git o en capturas.
- No uses la cadena con `-pooler`.

## D. Límites del plan gratis
| Servicio | Límite |
|---|---|
| Neon | 0,5 GB de base de datos por proyecto · 100 CU-horas al mes · el cómputo se suspende tras 5 min sin actividad · solo 6 h de historial para restaurar |
| R2 | 10 GB de almacenamiento · 1 M de escrituras y 10 M de lecturas al mes · sin costo de salida de datos |

Consecuencias prácticas:
- La primera conexión tras un rato de inactividad tarda unos segundos; es normal.
- Apaga el worker (`pnpm dev` completo) cuando no estés desarrollando: mientras corre, mantiene el cómputo de Neon despierto y consume CU-horas.

## E. Verificación
- `pnpm storage:check` (tarea F0-T04): sube, lee, prueba una URL prefirmada, comprueba que la misma URL sin firma se rechaza y borra un objeto de prueba en R2.
- A mano, en el panel de Cloudflare → R2 → `agentsales-media` → Settings: "Public Development URL" (r2.dev) **deshabilitado** y sin dominios personalizados. `storage:check` no puede detectar un bucket público, porque el endpoint S3 siempre exige firma.
- `pnpm cli doctor` (tarea F0-T07): revisa `.env`, base de datos y almacenamiento.
