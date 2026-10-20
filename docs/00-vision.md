# 00 · Visión y alcance

## Problema

Corredores de propiedades independientes y vendedores pequeños pierden horas publicando lo mismo en varios canales: redactar textos distintos para cada plataforma, recortar fotos, armar carruseles, subir uno por uno, y después recordar dónde está publicada cada cosa para pausarla o darla de baja cuando se vende.

## Solución

**AgentSales**: un sistema que recibe una lista de avisos (propiedades hoy, productos en general mañana) con sus fotos y videos, y:

1. Redacta el contenido adaptado a cada plataforma, con el tono y la marca del corredor.
2. Procesa imágenes y videos: recortes por formato, portada, carrusel con diseño profesional y reels.
3. Publica en los canales elegidos, en el momento o según un calendario.
4. Hace seguimiento de cada publicación: dónde está, en qué estado, y la despublica cuando corresponde.

Desde F9 hace lo mismo con el **contenido de marca** (posts que no son avisos) en Instagram, X, LinkedIn, Discord y TikTok: la IA propone ideas con fecha y redacta un texto por red e idioma, y el operador acepta, aprueba y programa (ADR-0029 y ADR-0030).

## Usuarios

| Usuario | Necesidad principal |
|---|---|
| **Operador** (Vinny) | Operar el sistema para uno o más corredores; aprobar publicaciones |
| **Corredor independiente** | Publicar su cartera en IG, Portal Inmobiliario y Marketplace con su marca; desde F7 entra con su propio usuario y ve solo lo suyo |
| **Marca** (F9) | Publicar su contenido (posts) en sus redes con un calendario: hoy, las dos marcas del operador (Vinny y AgentPey); es un `Broker` con `kind = brand` |
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
- Interfaz web simple y CLI. Hasta F7 corría en el Mac del operador; desde F8 (`v1.0.0`) también en internet, en Fly.io con HTTPS (`agentsales.agentpey.com`, en modo demo y en simulación).

## Fuera de alcance del MVP

- Responder mensajes o comentarios dentro de AgentSales (la captura de leads de anuncios entra en F10: ver «Después del MVP»).
- Propiedades **en venta** en Marketplace: el único formulario de Facebook en Chile es de arriendo (confirmado el 2026-10-13); las ventas se publican en Instagram y Portal.
- Yapo (post-MVP). TikTok, anuncios pagados y leads: ver «Después del MVP».
- Carga de avisos por chat (post-MVP).
- Cobro, planes o facturación a clientes.
- El despliegue en internet quedó fuera del piloto inicial y llegó con F8 · En internet (`v1.0.0`, ADR-0024).

## Después del MVP (`v1.0.0`)
Acordado con el operador el 2026-10-19; los specs están en `docs/specs/` y las fases en `docs/06-roadmap.md`:
- **F9 · Contenido de marca:** el mismo calendario, aprobación y seguimiento para el contenido de marca del operador (su marca personal y AgentPey) en Instagram, X, LinkedIn, Discord y TikTok (video como borrador), con una IA que propone ideas y fechas y el humano aprobando todo. Primer paso para ofrecerlo a una corredora grande. Construida en tres entregas: `v1.1.0` (posts, perfil editorial, textos por red e idioma, Instagram y Discord), `v1.2.0` (LinkedIn a mano, X, TikTok como borrador, el panel Contenido y el calendario) y `v1.3.0` (el plan de ideas, `pnpm eval:social` y el cierre, con la prueba en vivo de cada red). Cada red se construyó contra simulaciones y publica de verdad solo después de su prueba de entrada con las cuentas del operador (S1 a S6, spec F9 §4.8).
  - **Fuera de F9:** anuncios pagados, leads, ManyChat, el reporte de gasto y TikTok público y con fotos (F10); métricas y aprender de lo que funcionó; leer o responder comentarios; organizaciones (F11); marcas de terceros con sus propias cuentas y cobro; Stories, hilos de X y la página de empresa de LinkedIn; imágenes generadas por IA; y la IA buscando noticias en internet o publicando sin aprobar.
- **F10 · Piloto con una oficina** de una corredora grande (tipo RE/MAX): anuncios de Meta sobre publicaciones de Instagram, de dos formas: **impulsar un post** ya publicado con un clic y **campañas por aviso** (en los dos casos, los anuncios nacen pausados, con dos aprobaciones, del texto y del gasto, y tres topes; la corredora paga a Meta directo y AgentSales no cobra ni recibe dinero de anuncios; ADR-0031 y ADR-0032, propuestos); leads con atribución a aviso y oficina; ManyChat conviviendo con una interfaz propia (ADR-0033, propuesto); un reporte de gasto; y TikTok público y con fotos.
- **F11 · Organizaciones:** franquicia con organización → oficina → agente, roles, aprobación por niveles y contenido corporativo con la marca de cada agente.
- Siguen fuera: responder mensajes y comentarios dentro de AgentSales, Yapo, la carga por chat y el cobro a clientes.

## Principios del producto

1. **Humano en el control.** Nada se publica sin aprobación hasta que el operador active la publicación automática por corredor. Los posts de marca nunca se publican solos: aceptar una idea, aprobar su texto y programarla son pasos del operador (ADR-0030).
2. **Nunca inventar datos.** La IA solo redacta con los datos entregados; si falta algo, lo omite o lo marca. En un post, solo afirma lo que está en el perfil editorial de la marca o en el brief que escribió el operador.
3. **Seguro por defecto.** El modo `PUBLISH_MODE=dry-run` es el default; publicar de verdad es una decisión explícita.
4. **Cada canal con su formato.** Instagram no es Portal Inmobiliario: textos e imágenes se adaptan por plataforma.
5. **Trazabilidad.** Cada cambio de estado de una publicación queda registrado.

## Métricas de éxito del piloto

- Tiempo de carga a publicación de una propiedad en 3 canales: **< 10 minutos** de trabajo humano.
- **0** datos inventados en textos aprobados (revisión manual de 20 avisos).
- **≥ 90 %** de publicaciones exitosas al primer intento en canales con API.
- 1 corredor conocido usando el sistema con su propia cartera.
