# 03 · Plataformas

Resumen de cómo se integra cada canal. Antes de implementar un publisher, el subagente `integraciones` verifica esta información contra la documentación oficial vigente y deja las notas en `docs/integraciones/<plataforma>.md`. **Todo lo marcado (verificar) debe confirmarse antes de codificar.**

| Plataforma | Mecanismo | Fase | Riesgo |
|---|---|---|---|
| Instagram | API oficial (Instagram API with Instagram Login) | F3 | Bajo |
| Portal Inmobiliario | API de Mercado Libre (sitio MLC) | F4 | Medio |
| Facebook Marketplace | Navegador automatizado + clic final humano | F5 | Alto |
| Yapo | Por definir (sin API pública conocida) | Post-MVP | Alto |
| TikTok | Content Posting API | Post-MVP | Medio |

## Instagram

- **API:** Instagram API with Instagram Login. **No requiere Página de Facebook**; sí requiere cuenta profesional (Empresa o Creador).
- **Permisos:** `instagram_business_basic`, `instagram_business_content_publish`.
- **Setup:** app en developers.facebook.com con el producto Instagram; agregar la cuenta de prueba como tester de la app. En modo desarrollo funciona con cuentas que tienen rol en la app; para cuentas de terceros hace falta App Review (2–4 semanas) y probablemente verificación del negocio (verificar).
- **Flujo de publicación:**
  1. Crear un contenedor por medio (`POST /{ig-user-id}/media`).
  2. Para carrusel, crear el contenedor padre con `media_type=CAROUSEL` y los hijos.
  3. Para video o reel, consultar el estado hasta `FINISHED`.
  4. Publicar (`POST /{ig-user-id}/media_publish`).
- **Medios:** deben estar en una **URL pública** (usamos URLs firmadas de Supabase). Imágenes en JPEG. El carrusel se recorta a la proporción de la primera imagen, así que todas van en 4:5 (1080×1350). Hasta 10 ítems por carrusel vía API (verificar). Reels en 9:16, entre 5 y 90 s, MP4 H.264.
- **Límites:** entre 50 y 100 posts por cuenta cada 24 h según la fuente; se consulta el endpoint `content_publishing_limit` antes de publicar. Un carrusel cuenta como 1 post.
- **Tokens:** los tokens de larga duración duran unos 60 días y deben refrescarse con un job periódico.
- **Despublicar:** la API no permite borrar posts (verificar). "Cerrar" en Instagram = marcar como no disponible en el sistema y avisar al operador para archivarlo a mano.

## Portal Inmobiliario (vía Mercado Libre)

- Portal Inmobiliario está integrado a Mercado Libre. Se publica en el sitio **MLC** con la API de ML.
- **Clave:** en Chile hay que incluir el atributo `CMG_SITE` en el body del ítem para que el aviso aparezca en Portal Inmobiliario además de Mercado Libre.
- **Setup:** app en el portal de developers de Mercado Libre Chile, OAuth 2.0 (authorization code), redirect URI **HTTPS** (en local puede requerir un túnel como cloudflared o ngrok; verificar si acepta `https://localhost`).
- **Tokens:** el access token es de corta duración (horas) y se renueva con el refresh token.
- **Categorías y atributos:** se descubren por API (árbol de categorías de inmuebles MLC y atributos requeridos por categoría). No se escriben a mano en el código: se consultan y se cachean.
- **Moneda:** UF probablemente como `currency_id` `CLF` (verificar).
- **Tipos de publicación:** los inmuebles usan listing types pagados o con cupos según el plan del corredor (verificar costo en la cuenta de prueba). Con `requires_picture: true` se exige al menos 1 imagen.
- **Seguimiento:** el API permite consultar estado, pausar (`paused`) y cerrar (`closed`) ítems.
- **Consultas de interesados:** llegan como preguntas o contactos (fase de respuestas, fuera del MVP).

## Facebook Marketplace

- **Sin API pública** para publicar avisos de particulares en Chile.
- **Mecanismo:** Playwright con un **perfil de navegador persistente por corredor**. El corredor inicia sesión a mano una vez; el sistema nunca ve su contraseña.
- **Flujo:** el worker abre el formulario de "Propiedad en venta o alquiler", llena campos, sube fotos y deja todo listo. El estado pasa a `awaiting_manual_confirm` y el operador hace el **clic final**. Luego pega la URL o el sistema la detecta.
- **Riesgos:** cambia el HTML sin aviso (los selectores se rompen), y Meta puede restringir cuentas por automatización. Mitigaciones:
  - Clic final humano.
  - Ritmo lento, con pausas aleatorias.
  - Máximo N avisos por día (configurable).
  - Selectores centralizados en un solo archivo.
  - Capturas de pantalla ante errores.
- **Nunca** resolver captchas ni evadir verificaciones: si aparece una, se detiene y avisa al operador.

## Yapo (post-MVP)

Sin API pública conocida. Evaluar el mismo enfoque que Marketplace y revisar sus términos de uso antes.

## TikTok (post-MVP)

Content Posting API. Las apps no auditadas solo pueden publicar en modo privado (verificar); requiere auditoría para publicar en público.

## Checklist para agregar una plataforma nueva

1. Nota de integración en `docs/integraciones/<plataforma>.md`: auth, límites, formatos y riesgos.
2. ADR si el mecanismo es nuevo (ej. primera integración por navegador).
3. Agregar el valor al enum `platform` con una migración.
4. Implementar `Publisher` en `packages/publishers/<plataforma>/` con tests de contrato (HTTP simulado con msw).
5. Plantilla de contenido y variantes de medios para la plataforma.
6. Probar en `dry-run`, luego en `live` con cuenta de prueba.
