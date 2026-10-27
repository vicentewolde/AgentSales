# Propuesta: el «radar» de X con tu aprobación por cada acción

> **Estado:** propuesta del 2026-10-27, **para decidir**. No hay código, ni spec, ni ADR. Si la aceptas, lo siguiente es un spec de fase (`docs/specs/`) y un ADR.
> **Origen:** el operador pidió que la plataforma, sin su Mac y gastando poco, «revise posts de otros usuarios, dé likes, haga repost o citas». Esto es lo que se puede hacer y lo que no.
> **Fuentes verificadas el 2026-10-27:** [Automation rules](https://help.x.com/en/rules-and-policies/x-automation) (X Help Center, «Updated April 2026») y [pay-per-usage pricing](https://docs.x.com/x-api/getting-started/pricing) (docs.x.com). Lo que no se pudo leer va marcado **NO VERIFICADO**.

## 1. La idea en una frase

AgentSales vigila **cuentas y palabras que tú elijas**, la IA separa lo que vale la pena y te deja una **cola de propuestas** en el panel. Cada propuesta dice qué haría (repostear, citar con un texto, o abrirla en X para que tú des el like o respondas) y **nada sale sin tu clic**. Todo corre en el servidor, sin tu Mac.

## 2. Lo que X permite y lo que no (verificado)

| Acción | Regla de X | Qué hacemos |
|---|---|---|
| **Like automático** | «You may not like posts or hide replies in an automated manner.» | **No se hace por la API.** La propuesta trae el enlace al post y el like lo das tú, en X. |
| **Repost y cita automáticos** | Permitidos «for entertainment, informational, or novelty purposes»; el repost «bulk, aggressive, or spammy» es una violación. | **Sí, con tu aprobación por cada uno y un tope bajo por día.** |
| **Respuesta automática por palabras clave** | «Sending automated replies to posts based on keyword searches alone is not permitted.» | **No.** Una respuesta la escribes tú en X. |
| **Respuesta con IA** | «Requires prior written and explicit approval from X.» | **No.** Fuera de esta propuesta. |
| **Seguir o dejar de seguir** | Prohibido en forma masiva o indiscriminada. | **No.** |
| **Automatizar el sitio web** (scripts en x.com) | «May result in the permanent suspension of your account.» | **Nunca.** Solo la API. |
| Publicar sobre temas del momento (*trending*) | Prohibido. | El radar **no** busca ni reacciona a tendencias. |

**Una consecuencia importante:** el texto que escribiste en el formulario de X dice que no damos likes, reposts ni respuestas automáticas. Esa descripción es **vinculante** (`docs/integraciones/x.md`). Antes de usar el radar hay que actualizarla (§7).

## 3. Cómo funcionaría

1. **Fuentes (tú las eliges):** una lista corta de cuentas de X (por ejemplo 10 a 20: el ecosistema Stellar, proyectos de agentes, comercios) y, opcional, palabras clave. Sin lista, el radar no hace nada.
2. **Lectura:** una o dos veces al día, el worker lee los posts nuevos de esas cuentas. Es lo que más cuesta (§4).
3. **Filtro con IA:** compara cada post con el perfil editorial de AgentPey y descarta lo que no encaja o es riesgoso (política, ataques, temas de la lista «evitar»). Queda con unos pocos candidatos y la razón de cada uno.
4. **Cola «Radar» en el panel** (y en `agenda`): cada candidato muestra el post, por qué sirve y **una acción sugerida**:
   - **Repostear**;
   - **Citar**, con un borrador de texto de la IA (solo hechos del perfil, nunca inventa) que tú editas;
   - **Abrir en X** (para dar like o responder tú, a mano).
5. **Tu aprobación:** nada sale sin que toques «Aprobar y publicar» en esa propuesta. No hay «aprobar todo».
6. **Publicación:** repost o cita por la API, con el mismo cuidado de siempre (un solo envío, resultado dudoso sin reintento ciego) y registro en la bitácora.
7. **Frenos:** tope de acciones por día y por semana (propongo 3 por día), un mismo autor no más de una vez por semana, una lista de cuentas bloqueadas, y un interruptor para apagarlo todo.

## 4. Costos (precios verificados el 2026-10-27; el resto es estimación)

| Concepto | Costo unitario | Ejemplo | Al mes |
|---|---|---|---|
| **Leer posts de otros** | US$0,005 por post leído | 10 cuentas × 5 posts nuevos al día = 50 al día | **US$7,50** |
| Leer más (30 cuentas × 10 al día) | igual | 300 al día | US$45 |
| **Repost** | **NO VERIFICADO.** Probable «User Interaction: Create», US$0,015 | 3 al día | ≈ US$1,35 |
| **Cita** | Post: Create, US$0,015; **con URL, US$0,20** | 3 al día | US$1,35 o **hasta US$18** |
| IA (filtro y borradores) | sin medir | unos 50 posts al día | menos de US$1 (estimación) |
| Worker encendido un rato más | sin medir | lectura diaria | centavos |

- **Un radar liviano (10 cuentas, 3 acciones por día) ronda los US$10 al mes.** Si una cita cuenta como «con URL» (por incluir el enlace al post citado), subiría a unos US$27 en el peor caso. Hay que medirlo con una cita real, igual que se midió el primer post.
- Los posts ya leídos el mismo día UTC no se cobran dos veces (X deduplica).
- Las «lecturas propias» (US$0,001) **no** aplican: son solo para tus propios datos.
- **Un tope propio del radar**, separado del de publicar (hoy US$10 al mes por cuenta), para que una racha de lecturas no te deje sin créditos para publicar.

## 5. Riesgos

| Riesgo | Probabilidad e impacto | Cómo se reduce |
|---|---|---|
| **X suspende o limita @agentpeyai** | Baja con tu aprobación y 3 acciones al día; alto impacto (perdemos la cuenta) | Nada de likes ni respuestas automáticas; tope bajo; nunca scripts en el sitio; aprobación por acción. |
| **La política cambia** (precios, reglas) | Media | Revisar las páginas de X cada trimestre; los precios cambian «desde el período siguiente». |
| **Reputación:** citar algo polémico o a una cuenta hostil | Media | Filtro de la IA, lista de cuentas bloqueadas y tu lectura antes de aprobar; la cita siempre dice lo que tú aprobaste. |
| **Gasto que se dispara** | Media | Tope propio del radar; lectura 1 o 2 veces al día, con máximo de posts por cuenta; si se llega al tope, el radar se pausa solo. |
| **Datos de otros usuarios** | Media | **NO VERIFICADO:** hay que leer la política de datos de X y la Ley 21.719 (Chile) antes de guardar contenido ajeno. Propuesta: guardar solo el id, el autor y un extracto, 7 días, y borrar lo descartado. |
| **La IA se inventa algo en una cita** | Media | Solo hechos del perfil (como hoy), revisión automática del texto y tu edición antes de aprobar. |
| **Citar cuenta que se borra o bloquea** | Baja | Se vuelve a comprobar que el post existe justo antes de publicar. |

## 6. Dos fases, de menos a más riesgo

- **Fase A, «resumen» (recomendada primero):** solo lee y te deja la cola con enlaces; los likes, reposts, citas y respuestas los haces tú en X. **No usa ninguna escritura de la API**, así que no hay nada que X pueda observar como automatización. Costo: solo lectura, unos US$7,50 al mes en el caso liviano. Sirve para ver si las propuestas valen la pena antes de dar un paso más.
- **Fase B, repost y cita con aprobación:** agrega los botones que publican por la API, con los topes y frenos de arriba. Requiere antes: actualizar la descripción del caso de uso en X, medir el costo real de una cita y de un repost, y comprobar qué permisos pide cada uno (**NO VERIFICADO:** lo más probable es que sirvan los mismos `tweet.read`, `tweet.write` y `users.read` que ya tiene la app, sin pedir permisos nuevos).
- **Nunca, en ninguna fase:** likes automáticos, respuestas automáticas o con IA, seguir, ni automatizar el navegador.

## 7. Antes de construir

1. **Actualizar la descripción del caso de uso en X** (es vinculante): decir que se leen posts públicos de cuentas elegidas y que cada repost o cita lo aprueba una persona.
2. **Decidir el cuidado de datos de otros** (§5).
3. **Elegir la lista inicial de cuentas** (tuya) y el tope mensual del radar.
4. **Medir:** una cita real y un repost real con tu aprobación, para anotar el costo exacto en `docs/integraciones/x.md`.
5. **Escribir el spec y un ADR** (`/fase-plan`, `/adr`): un sujeto nuevo («propuesta de interacción») junto al aviso y al post, y su máquina de estados (propuesta → aprobada → publicada, descartada, falló, resultado dudoso).

## 8. Fuera de esta propuesta

- **Instagram y LinkedIn:** sus APIs no permiten dar likes ni comentar posts de otros, y en LinkedIn no automatizamos el navegador.
- **Responder mensajes o menciones** (otro caso: respuestas a quien te escribe primero sí están permitidas por X, pero con IA requieren su aprobación escrita).
- **Terceros:** que otros usuarios usen su propio radar exige leer de nuevo las reglas (el consentimiento por usuario es obligatorio) y puede pedir un plan Enterprise (`docs/integraciones/x.md` §11).

## 9. Preguntas para ti

1. ¿Qué cuentas y palabras quieres vigilar? (10 a 20 para empezar.)
2. ¿Empezamos por la Fase A (solo cola con enlaces) o directo a la B?
3. ¿Tope diario de acciones (propongo 3) y tope mensual del radar (propongo US$10)?
4. ¿Las citas las redacta la IA para que las edites, o prefieres escribirlas tú?
