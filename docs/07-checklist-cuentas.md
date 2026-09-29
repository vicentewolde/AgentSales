# 07 · Checklist de cuentas y trámites (tareas del operador)

Cosas que **solo tú puedes hacer** (cuentas, aprobaciones, datos reales). Claude Code no las hace. Marca cada una al completarla. Las primeras son necesarias para F0; las demás pueden avanzar en paralelo mientras se desarrolla.

## Antes de F0

- [ ] Node.js 22 LTS instalado (`node -v`)
- [ ] pnpm instalado (`corepack enable && corepack prepare pnpm@latest --activate`)
- [ ] Git configurado con tu nombre y correo
- [ ] ffmpeg instalado (`ffmpeg -version`)
- [ ] Claude Code instalado y con sesión iniciada con tu plan Max (`claude` → `/status`)
- [ ] Repositorio privado en GitHub: `AgentSales`
- [ ] Proyecto en Neon (plan gratis, región AWS São Paulo) — pasos en `docs/09-alta-neon-r2.md`
  - [ ] Copiar a `.env`: `DATABASE_URL` (conexión **directa**, sin `-pooler`, terminada en `?sslmode=require`)
- [ ] Cuenta de Cloudflare con R2 activado (pide tarjeta: retención temporal de US$5, sin cobro dentro del plan gratis)
  - [ ] Bucket privado `agentsales-media`
  - [ ] Token S3 con permiso "Object Read & Write" limitado a ese bucket
  - [ ] Copiar a `.env`: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
- [ ] Generar `APP_ENCRYPTION_KEY`: 44 caracteres aleatorios alfanuméricos con tu gestor de contraseñas (o `openssl rand -base64 32`)

## Antes de F1

- [ ] Llenar `data/plantillas/plantilla_propiedades.xlsx` con 3 propiedades distintas y guardarla como `data/muestras/propiedades.xlsx`
- [ ] Fotos y videos en `data/muestras/medios/P001/`, `P002/` y `P003/` (al menos una con video)
- [ ] Llenar la hoja **Corredor** con tu marca de prueba, y poner el logo PNG en `data/muestras/medios/_marca/logo.png`

## En paralelo, antes de F3 (Instagram) — empieza pronto, es lo más lento

- [ ] Confirmar que tu Instagram es cuenta **profesional** (Empresa o Creador)
- [ ] Crear cuenta de desarrollador en developers.facebook.com
- [ ] Crear una app de tipo **Empresa** y agregar el producto **Instagram** (API con inicio de sesión de Instagram)
- [ ] Agregar tu cuenta de Instagram como **tester** de la app y aceptar la invitación desde Instagram
- [ ] Anotar `META_APP_ID` y `META_APP_SECRET` en `.env`
- [ ] (Para terceros, en F7) Verificación del negocio y App Review de `instagram_business_content_publish`

## En paralelo, antes de F4 (Portal Inmobiliario)

- [ ] Crear tu cuenta en Portal Inmobiliario / Mercado Libre Chile y revisar qué plan o créditos exige publicar un inmueble
- [ ] Crear una app en el portal de developers de Mercado Libre Chile
- [ ] Anotar `ML_APP_ID` y `ML_CLIENT_SECRET` en `.env`
- [ ] Instalar `cloudflared` por si el redirect OAuth exige HTTPS público

## Antes de F5 (Marketplace)

- [ ] Perfil de Facebook personal con Marketplace habilitado (sin restricciones previas)
- [ ] Definir el límite diario de publicaciones con el que te sientas cómodo (sugerido: 3)

## Antes de F7 (terceros)

- [ ] API key de Anthropic en console.anthropic.com, con límite de gasto mensual
- [ ] Textos simples de términos de uso y privacidad
- [ ] Primer corredor piloto confirmado
