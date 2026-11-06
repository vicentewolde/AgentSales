# 15 · Precios y paquetes (hipótesis)

- **Estado:** inventado por Claude el 2026-11-06, a pedido del operador («inventa tus precios y paquetes»). **Son hipótesis para probar en las primeras conversaciones, no precios validados.** Se ajustan con lo que digan las 3 primeras oficinas. No se cobra nada hasta que el operador lo decida.
- **Quién vende:** el operador, con el servicio operado por él (spec F12 §8; borrador `docs/14-ventas-v0.md`).

## 1. Cómo se pensó

1. **Se vende resultado, no software:** «tus propiedades publicadas bien, en todos los canales, con prueba de que son ciertas, sin que tu equipo pierda horas».
2. **Referencia:** una oficina paga hoy por portales (Portal Inmobiliario, etc.) y por tiempo de agentes o de un asistente. El precio debe sentirse menor a medio sueldo de un asistente (en Chile, ~CLP 600.000 a 800.000 al mes; cifra aproximada, sin verificar).
3. **Costo propio:** la IA cuesta centavos de dólar por propiedad (ver `cli usage`); la infraestructura es fija y baja. Hay mucho margen; el límite real es el tiempo del operador. Por eso el precio sube con el servicio operado, no con el consumo.
4. **Menos tramos es mejor:** tres paquetes, un complemento y un piloto.

## 2. Los paquetes (CLP por mes, IVA aparte)

| Paquete | Para quién | Incluye | Precio |
|---|---|---|---|
| **Piloto** | La primera oficina | 30 días, hasta 15 propiedades, todo lo de «Oficina» a cambio de comentarios, un caso de éxito y permiso para mencionarlo | **$0** (sin tarjeta, sin permanencia) |
| **Corredor** | Un corredor independiente | Hasta 10 propiedades activas; preparación de fotos, carrusel, reel y textos; Instagram y Portal; aprobación y calendario; tú operas el panel | **$69.000** |
| **Oficina** | Una oficina de 3 a 10 agentes | Hasta 40 propiedades activas; todo lo anterior más Marketplace asistido, varias marcas y usuarios, contenido de marca (plan de ideas), reporte semanal; operado por nosotros con una revisión semanal de 30 minutos | **$189.000** |
| **Oficina Plus** | Oficinas con más cartera o que quieren ads | Hasta 100 propiedades activas, todo lo anterior más leads con atribución y anuncios de Meta (cuando esté F10), soporte por WhatsApp | **$349.000** |

**Complemento · Registro verificable** (F12): **+$2.500 por propiedad al mes**, o incluido en «Oficina Plus». Cada propiedad con ficha verificable, vitrina para compradores y agentes de IA, y pie verificado en los textos.

**Extras (se cobran aparte, a costo + margen):** carga inicial de cartera existente ($15.000 por propiedad si hay que digitalizar fichas), imágenes con IA (a costo más 30 %), y anuncios de Meta (los paga la oficina directo a Meta; AgentSales no toca ese dinero).

**Descuento por anual:** 2 meses gratis si paga 12 por adelantado.

## 3. Lo que se promete y lo que no

- Se promete lo que `docs/14-ventas-v0.md` §1 marca ✅. Portal en vivo, leads y anuncios se ofrecen como «en construcción, incluido en el piloto» hasta que estén probados.
- **No se promete** más ventas, más leads ni plazos de venta. Se promete ahorro de tiempo y consistencia.
- Sin permanencia: se puede cancelar con 30 días de aviso.

## 4. Cuentas rápidas (para validar)

| Escenario | Ingreso mensual |
|---|---|
| 1 oficina «Oficina» + 20 propiedades con registro | 189.000 + 50.000 = **$239.000** |
| 3 oficinas «Oficina» | **$567.000** |
| 5 «Corredor» + 2 «Oficina» | 345.000 + 378.000 = **$723.000** |

Con ~3 oficinas el servicio cubre infraestructura y IA con holgura; con ~10 hay que automatizar la operación (F11) antes de seguir vendiendo.

## 5. Qué hay que validar primero

1. ¿Una oficina paga $189.000 por esto, o espera menos? Preguntar «¿cuánto pagas hoy por tu asistente y por los portales?» antes de decir el precio.
2. ¿El registro verificable es un motivo de compra o un lujo? Si nadie lo pide en las primeras 5 demos, se vende como extra y no como eje.
3. ¿Prefieren pagar por propiedad o por oficina? Anotar la respuesta textual.
4. Ajustar este documento después de cada demo.
