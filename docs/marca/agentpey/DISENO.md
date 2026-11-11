# AgentPey · diseño de las publicaciones («estilo Apple»)

Fecha: 2026-11-11. Lo armó Claude en la sesión de AgentSales con Vinny (operador), para las imágenes de los posts de X e Instagram de AgentPey. Vinny lo aprobó como línea («me gusta, va bien encaminado») y pidió **rotar cuatro temas de color**, uno por publicación.

**Alcance honesto.** Esto es un sistema para **imágenes de redes de 1080×1350 px**, no un sistema de diseño web completo. No hay componentes web, estados de formulario, colores de error o éxito, ni tipografía para cuerpos de texto largos. Lo que falta para web está marcado como **no definido**: no está inventado aquí.

---

## 1. Colores (hex exactos)

Base (tomada de los tokens públicos de apple.com):

| Token | Hex | Uso |
|---|---|---|
| `--black` | `#000000` | Fondo del tema oscuro «medianoche»; tarjeta héroe del bento claro |
| `--fog` | `#f5f5f7` | Fondo del tema claro |
| `--white` | `#ffffff` | Tarjetas sobre `--fog` |
| `--ink` | `#1d1d1f` | Texto principal sobre claro (titulares y tarjetas) |
| `--gray` | `#6e6e73` | Texto secundario sobre claro (subtítulos, etiquetas de tarjeta, pie) |
| `--gray-dark` | `#86868b` | Texto secundario sobre oscuro |
| `--hair` | `#d2d2d7` | Divisores finos (casi no se usan) |

Marca AgentPey (del sitio agentpey.com; único acento):

| Token | Hex | Uso |
|---|---|---|
| `--blue` | `#176bff` | Acento de la marca: disco de la medalla, tarjeta héroe del tema «azul» |
| `--blue-dark` | `#2997ff` | Acento sobre fondo oscuro (palabras resaltadas, por ejemplo «USDC on Stellar.») |
| `--mint` | `#6df2c0` | Solo como final del degradado del titular (`#2997ff → #6df2c0`), nunca como color plano grande |

Del sitio agentpey.com también existen `--ink: #070b16` y `--flare: #ff5a36`. **No se usan** en este diseño de posts. El naranja se probó en la versión anterior «neo-brutalista» y se descartó.

**Degradado del titular (una sola palabra o frase por imagen):** `linear-gradient(90deg, #2997ff 0%, #6df2c0 100%)` con `background-clip: text`. En el tema claro, `linear-gradient(90deg, #176bff, #14b8a6)`.

**Los cuatro temas que se rotan** (definidos en `fuente/gen2.py`, `X_THEMES` e `IG_THEMES`):

| Tema | Fondo | Texto | Secundario | Notas |
|---|---|---|---|---|
| A · medianoche (X) / claro (IG) | `#000` / `#f5f5f7` | `#f5f5f7` / `#1d1d1f` | `#86868b` / `#6e6e73` | En X, brillo `radial-gradient(circle, rgba(23,107,255,.30), transparent 60%)` detrás de la medalla. En IG, la tarjeta héroe es negra. |
| B · azul profundo (X) / oscuro (IG) | `radial-gradient(120% 90% at 50% 30%, #123a8c, #071a45 55%, #030b20)` / `#000` | `#f5f5f7` | `#a9b7d6` / `#86868b` | IG: tarjetas `#1c1c1e`, héroe `#176bff`. |
| C · claro (X) / azul (IG) | `#f5f5f7` | `#1d1d1f` | `#6e6e73` | IG: héroe `#176bff` con texto blanco. |
| D · titanio | `linear-gradient(180deg, #2a2a2d, #141416)` | `#f5f5f7` | `#98989d` | Aro de la medalla «titanio cálido» `linear-gradient(150deg, #f4f1ec, #a8a29a 35%, #e8e4de 55%, #6f6a64)`. |

**Modo oscuro para web:** no definido como tal. El par natural es «fondo `#000`, texto `#f5f5f7`, secundario `#86868b`, acento `#2997ff`» (tema A de X) frente a «fondo `#f5f5f7`, texto `#1d1d1f`, secundario `#6e6e73`, acento `#176bff`» (tema A de IG).

**Estados (éxito, error, advertencia), enlaces y foco: no definidos.** Apple usa azul para acción y foco (`#0071e3` en apple.com). En AgentPey el equivalente sería `#176bff`, pero eso no se probó.

## 2. Tipografía

- **Titulares:** `Inter Tight`, peso 600, de Google Fonts (`https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;600;700&family=Inter:wght@400;500;600&display=swap`). Es el sustituto libre de SF Pro Display, que no se puede usar fuera de plataformas Apple.
  - Tracking: `-0.028em` en el titular principal, `-0.03em` en «Meet AgentPey.», `-0.01em` en los títulos de tarjeta. Interlineado 1.04 y `text-wrap: balance`.
- **Texto:** `Inter`, pesos 400, 500 y 600. Respaldo: `-apple-system, system-ui, sans-serif`.
- **Tamaños usados en 1080×1350:**

  | Elemento | Tamaño y peso |
  |---|---|
  | Titular keynote | 106 px |
  | Titular bento | 118 px (102 px en español, que es más largo) |
  | Subtítulo | 38 a 40 px, 500 |
  | Título de tarjeta | 42 px |
  | Etiqueta de tarjeta | 23 px, 600, gris |
  | Marca arriba («AgentPey») | Inter Tight 600, 34 px, logo de 40 px |
  | Pie | 27 a 28 px |

  En web, escala aproximada ÷ 2,2.

Las fuentes del sitio agentpey.com (Bricolage Grotesque, Instrument Sans, DM Mono) **no** se usan en este diseño.

## 3. Logo e íconos

- `logo-agentpey-mark.svg`: la marca «AP» tal como está en el HTML de agentpey.com (trazos blancos de 60 sobre un viewBox de 512, y un corte diagonal pintado con `#070b16`). Sirve solo sobre fondo `#070b16`.
- `logo-agentpey-mark-transparente.svg`: la misma geometría con el corte hecho con `mask` y el color en `currentColor`. Sirve sobre cualquier fondo. Es la que usan los posts.
- **La muesca diagonal de la «P» es parte del logo oficial**, no un error. No hay que «arreglarla» con `stroke-linecap: square`, porque deforma la marca.
- La fuente de verdad del logo es el sitio agentpey.com (su repositorio). Aquí hay una copia.
- Uso: logo de 40 px + «AgentPey» en Inter Tight 600, centrado arriba. Dentro de la medalla, de 110 a 116 px, en blanco sobre el disco azul.
- Íconos: no hay set definido. En una variante descartada se usaron íconos de trazo de 1,8 en `#2997ff` (moneda, escudo con check, recibo).

## 4. Composición

- **Lienzo:** 1080×1350 (4:5). Márgenes laterales de 80 px. Margen superior ≥ 116 a 124 px y margen inferior ≥ 100 a 112 px: Vinny pidió más aire arriba y abajo.
- **Keynote (X, anuncios):** columna centrada con el logo arriba, un objeto protagonista al centro, un titular de 2 líneas, un subtítulo gris de 2 líneas y el usuario abajo.
  - El objeto es una medalla: aro metálico de 340 px `linear-gradient(150deg, #fdfdfe, #c3c9d0 35%, #f2f4f6 55%, #8e97a1)` y disco interior de 284 px `radial-gradient(circle at 50% 22%, #4d95ff, #176bff 45%, #0a2f86)`.
  - Sombra de apoyo `0 40px 90px rgba(0,0,0,.65)`.
  - Lo que sobra de alto se reparte con `margin-top: auto` arriba de la medalla y del pie.
- **Bento (Instagram, explicar el producto):** logo, titular de 1 línea, subtítulo, y una grilla de 2 columnas con `gap` de 20 a 22 px:
  1. Una tarjeta héroe ancha (2 columnas, fondo oscuro o azul).
  2. Dos tarjetas medianas.
  3. Una tarjeta ancha final.
  4. El pie.

  Las tarjetas tienen radio de 34 px, padding de 38 a 44 px, la etiqueta arriba y el título debajo, alineadas arriba (`justify-content: flex-start`). **Sin sombras ni bordes**: separan el fondo y el tono de la tarjeta.
- Todo centrado salvo el texto dentro de las tarjetas, que va a la izquierda.

## 5. Ejemplos ya hechos

- `ejemplos/x-instawards-en.png` y `ejemplos/x-instawards-es.png`: keynote, tema A. Post de X «We won the Stellar Instawards.» y su versión en español.
- `ejemplos/ig-meet-en.png` y `ejemplos/ig-meet-es.png`: bento, tema A. Carrusel de Instagram «Meet AgentPey.» y «Conoce AgentPey.».
- `ejemplos/opciones-x.png` y `ejemplos/opciones-instagram.png`: hojas con los cuatro temas de cada formato.

## 6. Lo que NO se hace

- No mezclar familias tipográficas ni volver a Bricolage o DM Mono en este estilo.
- Un solo acento: no agregar naranja, morado ni otros colores. El menta solo va al final del degradado.
- Degradado solo en una palabra o frase por pieza; nunca en fondos de UI ni en botones.
- Sin sombras duras (estilo neo-brutalista: ya se probó y se descartó), sin bordes gruesos y sin muchas cajas compitiendo.
- No copiar los «anillos de Actividad» del Apple Watch: se probaron y el revisor los descartó por imitación.
- Sin emojis como adorno. Sin el logo de Stellar ni de terceros.
- No inventar datos. Los textos solo usan hechos del perfil de la marca: USDC sobre Stellar, límites que hace cumplir un contrato, recibo firmado por compra, Claude y ChatGPT por MCP, testnet, Santiago de Chile, el SDK en npm, o lo que Vinny dé.
- No apretar el tracking más de `-0.03em`, porque se pegan las palabras («Wewon»).

## 7. Fuente de verdad

- **Generadores** (Python que escribe HTML y lo renderiza con Chrome headless): `fuente/gen.py` (las primeras cuatro piezas, base de tokens `BASE`, logo `mark()`), `fuente/gen2.py` (los cuatro temas y las hojas de comparación) y `fuente/final.py` (las imágenes definitivas EN y ES con el tema A).
  - Se corren con `python3 <archivo>`; escriben los PNG junto al script, así que conviene correrlos desde una copia fuera del repo.
  - Render: `/usr/bin/google-chrome --headless=new --window-size=1080,1350 --virtual-time-budget=12000 --screenshot=… file://…`
- No hay artifact de claude.ai, Canva, rama ni archivo de Figma con este diseño.
- Este archivo y su carpeta (`docs/marca/agentpey/`) son la referencia. Los originales estaban en la carpeta temporal de la sesión.
