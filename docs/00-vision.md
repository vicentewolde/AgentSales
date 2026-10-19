# 00 · Visión y alcance

## Problema

Corredores de propiedades independientes y vendedores pequeños pierden horas publicando lo mismo en varios canales: redactar textos distintos para cada plataforma, recortar fotos, armar carruseles, subir uno por uno, y después recordar dónde está publicada cada cosa para pausarla o darla de baja cuando se vende.

## Solución

**AgentSales**: un sistema que recibe una lista de avisos (propiedades hoy, productos en general mañana) con sus fotos y videos, y:

1. Redacta el contenido adaptado a cada plataforma, con el tono y la marca del corredor.
2. Procesa imágenes y videos: recortes por formato, portada, carrusel con diseño profesional y reels.
3. Publica en los canales elegidos, en el momento o según un calendario.
4. Hace seguimiento de cada publicación: dónde está, en qué estado, y la despublica cuando corresponde.

## Usuarios

| Usuario | Necesidad principal |
|---|---|
| **Operador** (Vinny) | Operar el sistema para uno o más corredores; aprobar publicaciones |
| **Corredor independiente** | Publicar su cartera en IG, Portal Inmobiliario y Marketplace con su marca; desde F7 entra con su propio usuario y ve solo lo suyo |
| **Vendedor independiente** (futuro) | Lo mismo, con productos en vez de propiedades |

## Alcance del MVP (piloto inmobiliario)

- Carga de propiedades desde Excel (o su exportación desde Google Sheets) con fotos y videos. La lectura directa de Google Sheets y Drive queda para después del MVP.
- Campos configurables: se pueden agregar o quitar sin cambiar el código.
- Generación de textos con Claude, y procesamiento de imágenes y videos.
- Aprobación manual antes de publicar.
- Publicación en **Instagram**, **Portal Inmobiliario** (vía Mercado Libre) y **Facebook Marketplace** (semiautomático).
- Publicar en el momento o programado.
- Seguimiento por propiedad y por plataforma.
- Multi-corredor desde el modelo de datos: cada corredor publica desde sus propias cuentas. Desde F7, usuarios con contraseña (el operador administra, cada corredor ve solo lo suyo), la IA de los corredores por la API de Anthropic con tope de gasto, y Marketplace a mano para los corredores que no son del operador (ADR-0021 a ADR-0023).
- Corre en local; interfaz web simple y CLI.

## Fuera de alcance del MVP

- Responder mensajes o comentarios dentro de AgentSales (la captura de leads de anuncios entra en F10: ver «Después del MVP»).
- Propiedades **en venta** en Marketplace: el único formulario de Facebook en Chile es de arriendo (confirmado el 2026-10-13); las ventas se publican en Instagram y Portal.
- Yapo (post-MVP). TikTok, anuncios pagados y leads: ver «Después del MVP».
- Carga de avisos por chat (post-MVP).
- Cobro, planes o facturación a clientes.
- Despliegue en la nube con acceso de terceros desde internet (F8 · En internet).

## Después del MVP (`v1.0.0`)
Acordado con el operador el 2026-10-19; los specs están en `docs/specs/` y las fases en `docs/06-roadmap.md`:
- **F9 · Contenido de marca:** el mismo calendario, aprobación y seguimiento para el contenido de marca del operador (su marca personal y AgentPey) en Instagram, X, LinkedIn, Discord y TikTok (video como borrador), con una IA que propone ideas y fechas y el humano aprobando todo. Primer paso para ofrecerlo a una corredora grande.
- **F10 · Piloto con una oficina** de una corredora grande (tipo RE/MAX): anuncios de Meta sobre publicaciones de Instagram (la corredora paga a Meta directo; AgentSales no cobra ni recibe dinero de anuncios), leads con atribución, ManyChat conviviendo y TikTok público.
- **F11 · Organizaciones:** franquicia con organización → oficina → agente, roles, aprobación por niveles y contenido corporativo con la marca de cada agente.
- Siguen fuera: responder mensajes y comentarios dentro de AgentSales, Yapo, la carga por chat y el cobro a clientes.

## Principios del producto

1. **Humano en el control.** Nada se publica sin aprobación hasta que el operador active la publicación automática por corredor.
2. **Nunca inventar datos.** La IA solo redacta con los datos entregados; si falta algo, lo omite o lo marca.
3. **Seguro por defecto.** El modo `PUBLISH_MODE=dry-run` es el default; publicar de verdad es una decisión explícita.
4. **Cada canal con su formato.** Instagram no es Portal Inmobiliario: textos e imágenes se adaptan por plataforma.
5. **Trazabilidad.** Cada cambio de estado de una publicación queda registrado.

## Métricas de éxito del piloto

- Tiempo de carga a publicación de una propiedad en 3 canales: **< 10 minutos** de trabajo humano.
- **0** datos inventados en textos aprobados (revisión manual de 20 avisos).
- **≥ 90 %** de publicaciones exitosas al primer intento en canales con API.
- 1 corredor conocido usando el sistema con su propia cartera.
