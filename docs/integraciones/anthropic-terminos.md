# Términos de Anthropic para un producto con varios clientes (SaaS de avisos)

Nota verificada el **2026-10-18** para planificar F8 (el sistema en un dominio propio, con corredores que no son el operador). Solo se leyeron páginas públicas de Anthropic con una herramienta que extrae y resume el texto; no se usó ninguna clave ni se hizo ninguna llamada a la API. **Esto no es asesoría legal:** donde los términos son ambiguos se marca NO VERIFICADO y se propone a quién preguntar.

Convención: **DOC** = lo dice un documento oficial de Anthropic (con URL en la sección 9); **INFERENCIA** = deducido por mí, sin que el texto lo diga; **NO VERIFICADO** = falta confirmación. Las citas son cortas y pueden tener paráfrasis del resumen: antes de firmar o cobrar a terceros, abrir los textos de la sección 9.

Lo ya verificado no se repite: límites de tasa, errores, workspaces y reparto del gasto por corredor están en `anthropic-api.md` (secciones 11 y 12); los términos del uso de la CLI con el plan, en `claude-code-cli.md` (sección 9).

## 1. Resumen

| Pregunta | Respuesta corta | Marca |
|---|---|---|
| ¿Una clave de la API del operador puede atender a varios clientes de un producto propio? | **Sí.** Los Términos Comerciales dan permiso para usar los servicios "para impulsar productos y servicios que el Cliente ofrece a sus propios clientes y usuarios finales" (A.1). Lo que no se puede es **revender** el servicio ni construir un producto competidor (D.4) | DOC |
| ¿Dónde está la línea entre "impulsar un producto" y "revender"? | Vender la función (redactar avisos) no parece reventa; pasar tokens o el acceso a Claude con margen, sí. Dónde cae un cobro por aviso: Anthropic no lo define | INFERENCIA; NO VERIFICADO |
| ¿Hay que decir a los usuarios finales que es IA? | Los Términos Comerciales **no** lo exigen. Sí exigen avisar a los usuarios que las afirmaciones de hechos en las salidas pueden ser falsas y que deben verificarse (D.3). La Política de uso exige declarar la IA a los usuarios de **chatbots o agentes de cara al consumidor** y en usos de **alto riesgo** (incluye vivienda para decisiones de elegibilidad). Redactar el texto de un aviso que revisa y publica un corredor no calza en ninguno de los dos | DOC; la aplicación al caso es INFERENCIA |
| ¿Quién responde por lo que hagan los corredores con la clave del operador? | El operador: "Customer is responsible for all activity under its account" (D.5), y los Usuarios solo pueden usar el servicio cumpliendo los términos y la Política de uso (D.2). Anthropic puede suspender el acceso por infracciones (I.3) | DOC |
| ¿Existen límites de gasto mensuales en la consola? | **Sí.** Cada nivel (Start, Build, Scale) trae un tope mensual (USD 500, 1.000 y 200.000) y el operador puede fijar uno **más bajo** en `Billing > Spend limits` de la consola; cada workspace puede tener el suyo | DOC |
| ¿El plan Max permite usar `claude -p` en un servidor o para terceros? | **No para terceros:** Anthropic no permite "enrutar solicitudes a través de credenciales de planes Free, Pro o Max en nombre de sus usuarios". Para el uso propio, `claude -p` con el plan sigue permitido y descuenta de los límites del plan; en un servidor, el texto de "uso ordinario e individual" no dice nada explícito: queda como zona gris | DOC; servidor propio NO VERIFICADO |
| Novedad útil | Desde el 2026-10-07 los planes **Max y Team** incluyen créditos mensuales de API (USD 100 o 200 en Max) si se vincula una organización de la consola; sirven para llamadas con una clave de esa organización | DOC |

## 2. Documentos y versiones vigentes

| Documento | Versión leída | Notas | Marca |
|---|---|---|---|
| Términos Comerciales de Servicio (API, consola, Team y Enterprise) | Vigente desde el **2025-06-17**; la página enlaza una versión anterior | Aplican a la clave de la API. La Política de uso se llamaba antes "Acceptable Use Policy" | DOC |
| Política de uso (Usage Policy) | **Dos versiones.** La que rige hoy es la del **2025-09-15** (archivada). La página `anthropic.com/legal/aup` ya muestra la del **2026-11-12**, publicada el 2026-10-08 | La nueva es en su mayor parte una aclaración (nueva sección sobre campañas engañosas, abuso hacia el modelo, regiones). Las reglas de alto riesgo "no cambian" en lo esencial. Revisar de nuevo el 2026-11-12 | DOC |
| Términos de Consumidor (Free, Pro, Max) | Vigente desde el **2025-10-08** | Aplican al plan Max; la clave de la API no | DOC |
| Política de regiones admitidas | Página con fecha **2026-11-12** | **Chile figura** en la lista. La versión nueva extiende la restricción a entidades constituidas, con sede o mayoritariamente controladas desde regiones no admitidas | DOC |
| Páginas de Claude Code (legal, autenticación) | Leídas hoy; sin fecha propia | Fuente de lo que sigue en la sección 6 | DOC |

- Que la página de la Política de uso muestre ya la versión futura es un detalle de la web: **la versión archivada del 2025-09-15 es la que obliga hoy**. Las dos traen la regla de revelar la IA en chatbots y las de alto riesgo, así que la conclusión de este documento no cambia con la fecha (INFERENCIA).

## 3. Una clave propia para varios clientes

**DOC (Términos Comerciales, vigentes desde 2025-06-17):**

- **A.1:** "Anthropic gives Customer permission to use the Services, including to power products and services" que el Cliente pone a disposición de "its own customers and end users" (los "Usuarios"). Es el permiso que ampara a AgentSales como producto.
- **D.4:** el Cliente no puede "access the Services to build a competing product or service, including to train competing AI models or resell the Services except as expressly approved by Anthropic", ni duplicar el servicio ni ayudar a terceros a hacerlo.
- **B:** las entradas (fotos, datos del aviso) y las salidas (textos) son contenido del Cliente; Anthropic **no entrena** modelos con el Contenido del Cliente de los Servicios.
- **C:** los datos se tratan bajo el Anexo de Tratamiento de Datos (DPA) de Anthropic, incorporado por referencia. La página no trata los plazos de retención ni la retención cero.
- **L.1:** el Cliente declara y garantiza que tiene "all rights and permissions required to submit Inputs" (derechos sobre las fotos y los datos que envía).

**Lectura para AgentSales (INFERENCIA):**

- Cobrar un servicio de redacción de avisos (por mes, por aviso o por corredor) es "impulsar un producto"; **no** lo es ofrecer a los corredores una vía para usar Claude con su propia consulta libre o repartirles tokens. El diseño actual (el corredor no escribe prompts: sube datos y el sistema genera textos fijos con esquemas) cae del lado seguro.
- Por D.5 y D.2, el abuso de un corredor es problema del operador: AgentSales debe tener **términos propios** que obliguen a los corredores a respetar la Política de uso de Anthropic (sin textos engañosos, discriminatorios ni suplantación), y poder suspender a un corredor.
- Enviar el campo `metadata.user_id` (identificador opaco del corredor, ya anotado en `anthropic-api.md` 11.6) ayuda a que, si hay un abuso, Anthropic pueda aislarlo sin culpar a toda la cuenta.
- **NO VERIFICADO:** dónde pasa un cobro por aviso a ser "reventa" según Anthropic, y si hay condiciones para una cuenta de **persona natural** frente a una empresa (los términos hablan de "Customer" sin distinguir). Cómo cerrarlo: escribir a ventas o soporte de Anthropic con una descripción de una página del producto, antes de cobrar, y guardar la respuesta.

## 4. Obligaciones concretas del operador

| Obligación | Fuente | Qué implica para AgentSales | Marca |
|---|---|---|---|
| Cumplir las leyes de uso y las de protección de datos personales | D.1 | Política de privacidad (ver `instagram.md` 13.4) y revisión para la ley chilena (Ley 21.719, vigencia anunciada para 2026-12-01 según fuentes secundarias; NO VERIFICADO contra la BCN) | DOC |
| Cumplir la Política de uso, la política de regiones y los Términos Específicos del Servicio, tanto el Cliente como sus Usuarios | D.2 | Cláusula en los términos de AgentSales; filtros editoriales (`docs/04`) ya prohíben discriminar y mentir | DOC |
| Cooperar con pedidos de información de Anthropic, incluso para verificar la identidad del Cliente y el uso | D.2 | Tener a mano quién usa qué (bitácora y gasto por corredor ya existen) | DOC |
| Evaluar si las salidas sirven al caso de uso, "incluso si corresponde una revisión humana", y **avisar a los Usuarios** de que las afirmaciones de hechos pueden ser falsas, incompletas o desactualizadas y deben verificarse | D.3 | La aprobación humana (ADR y flujo de aprobación) ya es la revisión; falta el **aviso en los términos y en la pantalla de aprobación** ("revisa los datos antes de publicar") | DOC |
| Responder por toda la actividad de la cuenta | D.5 | Una sola clave: un corredor abusivo puede costar la suspensión de todos (I.3). Considerar workspaces por corredor (`anthropic-api.md` 11.6) | DOC |
| Defender a Anthropic frente a reclamos por las entradas de los Usuarios o por usos que violen la Política | K.2 | Los corredores deben garantizar contractualmente que tienen derecho a las fotos y datos (incluidas personas visibles en las fotos) | DOC |
| Avisar si la cuenta está comprometida o sufre un ataque | D.5 | Procedimiento de rotación de clave (la clave del operador vence el 2026-12-31) | DOC |
| Anthropic puede suspender el acceso por riesgos, infracciones de D.1, D.2 o D.4, prohibiciones legales o aumentos materiales de costo, y debe "usar esfuerzos razonables" para avisar por escrito | I.3 | Plan B: el puerto `LLMProvider` ya permite cambiar de adaptador | DOC |

**Declarar que es IA a los usuarios finales (Política de uso):**

- **Chatbots y agentes (DOC, ambas versiones):** "All consumer-facing chatbots or AI agents that communicate directly with external users must disclose" que son IA, al menos "at the beginning of each chat session or in the product interface". AgentSales no conversa con el público: el público lee un aviso publicado por el corredor. No aplica (INFERENCIA). Si algún día se agrega un asistente que contesta a compradores, sí.
- **Alto riesgo (DOC):** exige que una persona calificada revise y que se diga a la persona afectada que se usó IA cuando el modelo hace **recomendaciones** en áreas como finanzas, empleo y **vivienda**. La versión vigente lo define como "decisions regarding eligibility for housing, including leases and home loans"; la nueva, como "approving, denying, or ranking a rental or purchase application". Redactar un aviso de venta o arriendo no es una decisión de elegibilidad (INFERENCIA). **Hay que evitar** que el producto derive en filtrar o rankear postulantes a arriendo: ahí sí aplicaría.
- **Prohibiciones que sí tocan al producto (DOC):** crear o difundir información engañosa sobre una entidad o persona; "fake reviews, comments, or media" (versión vigente); suplantar personas o entidades; discriminar por atributos protegidos; spam. Coinciden con las reglas editoriales del proyecto (solo datos entregados, sin requisitos discriminatorios).
- **Meta/Instagram:** el parámetro opcional `is_ai_generated` de Instagram (`instagram.md` 4.2) es una decisión distinta, del operador; Anthropic no la exige.

## 5. Límites de gasto mensuales en la consola (DOC, 2026-10-18)

- **Existen dos clases:** (1) el **tope del nivel**, que fija Anthropic; (2) un **límite propio más bajo**, que fija el operador.
- **Topes por nivel:** Start USD 500, Build USD 1.000, Scale USD 200.000 por mes calendario; el nivel Custom no tiene tope (se acuerda con el equipo comercial). Las organizaciones nuevas pueden empezar en un nivel de **Evaluación** con límites menores. El nivel sube solo según historial; se pide más con "Request tier increase" en `platform.claude.com/usage/limits`.
- **Dónde se fija el límite propio:** consola > `Billing` (`platform.claude.com/settings/billing`) > sección **Spend limits** > **Adjust limit** (o **Set limit**). No puede superar el tope del nivel.
- **Por workspace:** `platform.claude.com/settings/workspaces` > elegir el workspace > **Spend limits**, para topar el gasto mensual y configurar **alertas por umbral**. No se puede poner en el workspace Default. Hasta 100 workspaces; solo un administrador de la organización los crea.
- **Qué pasa al llegar:** (a) al **tope del nivel**: HTTP **429** con `error_code = enforced_spend_limit_reached`, sin `retry-after`, hasta las 00:00 UTC del día 1 del mes siguiente; (b) a un **límite propio**: HTTP **400** `invalid_request_error` con "You have reached your specified API usage limits" (o "...workspace API usage limits"); subir o quitar el límite restaura el acceso. Ninguno se arregla reintentando (ya recogido en `anthropic-api.md` 11.5).
- **Estado de la cuenta del operador (de `anthropic-api.md` 12):** la clave **no tiene límite de gasto propio** (2026-10-17). Con un cobro creciente en F8 conviene fijar uno antes de abrir el producto: es la única defensa contra un bug o un abuso que gaste sin tope (el tope mensual por corredor de AgentSales solo cubre lo que AgentSales anota). Hacerlo es un paso del operador en la consola.
- **NO VERIFICADO:** si hay alertas por umbral también a nivel de organización (la doc las menciona para workspaces) y la fecha en que la organización pasará del nivel Evaluación o Start a Build. Se ven en la consola.

## 6. Planes de consumo (Pro y Max) y `claude -p`

**DOC (página legal de Claude Code, 2026-10-18):**

- La autenticación OAuth de los planes "is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications".
- Quienes construyen productos o servicios que usan las capacidades de Claude, incluido el Agent SDK, "should use API key authentication". "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users." Tampoco se pueden recolectar, guardar ni intermediar credenciales o tokens de sesión de claude.ai. Anthropic puede aplicar esto "without prior notice".
- "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
- Quien ofrece Claude Code dentro de su producto debe aceptar los Términos Comerciales y cumplir condiciones; entre ellas, no pagar ni "resell, or intermediate Claude usage on their end users' behalf": cada usuario final se autentica con su propia clave o plan. Esto está escrito para productos que traen Claude Code instalado; AgentSales no lo hace.
- Lo que sí permite: que el cliente administre sus propias claves, y que un usuario final inicie sesión con su suscripción en el binario sin modificar, incluso en una plataforma que lo aloja.
- **Soporte de Anthropic (actualizado el 2026-10-07):** "You can still use the Claude Agent SDK, `claude -p`, and third-party apps with your subscription limits." Los cambios anunciados para el 2026-06-15 sobre el uso del Agent SDK quedaron **pausados**; hoy ese uso sigue descontando de los límites del plan. (Los artículos de prensa de junio hablaban de un cambio vigente: ya no lo es.)
- **Términos de Consumidor (2025-10-08), sección 3:** no se puede acceder a los servicios "through automated or non-human means" salvo con una clave de API o donde Anthropic lo permita expresamente; no se puede compartir la cuenta ni la clave con otros, ni ayudar a otra persona a usar el servicio, ni revender. La página de Claude Code es el permiso expreso para el uso automatizado con `claude -p`.

**Conclusiones (INFERENCIA salvo donde se indica):**

1. **Uso actual, permitido:** el operador, con su sesión, en su Mac, para los avisos de sus corredores propios. `claude -p` es un uso documentado del plan, descuenta de sus límites y no se enruta a terceros. Se apoya en que esos corredores son "propios" (cuentas administradas por él): si un corredor externo crea avisos mediante el plan del operador, es "en nombre de sus usuarios" y está prohibido.
2. **Servidor de F8, no recomendado con el plan:** la doc no prohíbe expresamente correr `claude -p` con la sesión propia en un servidor, pero (a) el plan está pensado para uso "ordinario e individual", (b) el servidor sirve a cuentas distintas del operador y (c) guardar la sesión de claude.ai en un servidor del producto roza la regla de no "recolectar, guardar o intermediar credenciales". **NO VERIFICADO** si Anthropic acepta un servidor propio del operador solo para sus propios corredores; no vale el riesgo. **Regla para F8:** cualquier corredor que no sea el operador, y cualquier proceso del servidor público, usa `LLM_PROVIDER=anthropic-api`; el adaptador `claude-cli` queda como herramienta local del operador (coincide con ADR-0003).
3. **Créditos mensuales de API de Max (DOC, soporte, actualizado el 2026-10-07):** Max 5x da USD 100 y Max 20x USD 200 por mes (Team: USD 20 por asiento estándar, tope USD 500); hay que vincular **una** organización de la consola desde claude.ai (`Settings > Billing > Link organization`) y aceptar los **Supplemental Credit Terms**. Cubren la API de mensajes, el Agent SDK y `claude -p` **hecho con una clave de la organización vinculada**; no cubren Claude Code interactivo ni `claude -p` con la sesión del plan. Vencen al terminar el ciclo de facturación; no se cobran al plan; "Everyone with an API key in the linked organization can use the balance". Con unos USD 0,01 por aviso (`anthropic-api.md` 12) alcanzarían para miles de avisos al mes. **NO VERIFICADO:** si esos créditos pueden gastarse en llamadas hechas por la clave del operador para sus clientes (los Supplemental Credit Terms no se leyeron) y si la cuenta del operador (Max, nivel de plan) es elegible hoy. Revisar `claude.ai > Settings > Billing` y leer esos términos antes de contar con ellos.

## 7. Datos y privacidad (lo que debe decir la política de AgentSales)

- **DOC:** Anthropic no entrena con el Contenido del Cliente (B). El tratamiento se rige por el DPA (C). La FAQ de visión (ronda del 2026-10-02, `anthropic-api.md` 9) dice que las imágenes no se guardan más allá de la solicitud; los plazos de retención de Anthropic **no** están en los Términos Comerciales (NO VERIFICADO; verlos en el Trust Center o en el DPA).
- **INFERENCIA:** la política de privacidad y la de Meta (`instagram.md` 13.4) deben nombrar a Anthropic como proveedor que recibe fotos y datos del aviso para generar textos, y el contrato con cada corredor debe decir que él es quien tiene los derechos sobre esas fotos (L.1). Evitar enviar fotos con personas identificables o documentos (ya anotado en `claude-code-cli.md` 9).
- **Región:** Chile figura entre las regiones admitidas (DOC). El DPA y las transferencias internacionales (los datos van a servidores de Anthropic fuera de Chile) conviene tratarlos con un abogado cuando entre en vigor la ley chilena; NO VERIFICADO.

## 8. NO VERIFICADO y cómo cerrarlo

| # | Pendiente | Cómo cerrarlo |
|---|---|---|
| 1 | Límite entre "impulsar un producto" y "revender" con un cobro por aviso o por corredor | Escribir a ventas o soporte de Anthropic con el modelo de cobro; guardar la respuesta por escrito |
| 2 | Si una cuenta de la consola de **persona natural** puede ofrecer un producto a terceros bajo los Términos Comerciales | Misma consulta; mirar también cómo está creada la organización en la consola |
| 3 | Si `claude -p` con el plan Max en un servidor propio, solo para los corredores propios, es "uso ordinario e individual" | Misma consulta; mientras tanto, no hacerlo (sección 6, punto 2) |
| 4 | Si los créditos de API de Max se pueden gastar para clientes propios y si la cuenta es elegible | Leer los Supplemental Credit Terms y mirar `claude.ai > Settings > Billing` |
| 5 | Retención de datos de Anthropic para la API (plazos, retención cero) | DPA y Trust Center; preguntar si hace falta para la política de privacidad |
| 6 | Alertas por umbral a nivel de organización y cuándo sube el nivel | Consola > `Billing` y `Rate limits` |
| 7 | Cambios de la Política de uso del 2026-11-12 sobre este producto | Releer ese día la versión vigente; no se espera impacto (INFERENCIA) |
| 8 | Ley chilena 21.719: vigencia y efecto en el encargo de tratamiento | BCN y asesor legal |

## 9. Fuentes (consultadas el 2026-10-18)

- Términos Comerciales de Servicio (A.1, B, C, D.1 a D.5, I.3, K, L.1; vigentes desde 2025-06-17): https://www.anthropic.com/legal/commercial-terms
- Política de uso, versión que muestra la página (2026-11-12): https://www.anthropic.com/legal/aup (alias https://www.anthropic.com/aup)
- Política de uso, versión archivada (2025-09-15, la que rige hasta el 2026-11-12): https://www.anthropic.com/legal/archive/22742366-2ef0-4c7a-a833-6523f10d3944
- Aviso de la actualización de la Política de uso del 2026 (publicado el 2026-10-08): https://anthropic.com/news/2026-usage-policy-update
- Aviso de la actualización anterior (2025-09-15): https://www.anthropic.com/news/usage-policy-update
- Términos de Consumidor (Free, Pro, Max; vigentes desde 2025-10-08): https://www.anthropic.com/legal/consumer-terms
- Regiones admitidas (Chile figura): https://www.anthropic.com/supported-countries
- Claude Code, legal y cumplimiento (autenticación, productos de terceros, "ordinary use"): https://code.claude.com/docs/en/legal-and-compliance
- Claude Code, uso no interactivo (`claude -p`): https://code.claude.com/docs/en/headless
- Claude Code, costos y límites por configuración: https://code.claude.com/docs/en/costs
- Soporte: usar el Agent SDK con tu plan (límites del plan; cambios de junio pausados; créditos desde el 2026-10-07): https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Soporte: créditos mensuales de API para Max y Team (montos, vinculación, qué cubren): https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans
- Límites de tasa y de gasto (topes por nivel, dónde se fijan, errores): https://platform.claude.com/docs/en/api/rate-limits
- Workspaces (límites de gasto por workspace, alertas, 100 workspaces): https://platform.claude.com/docs/en/manage-claude/workspaces
- Pistas no oficiales (no se usan como fuente final): notas de prensa de junio de 2026 sobre un cambio de créditos del Agent SDK que luego se pausó; resúmenes de estudios jurídicos sobre la Ley 21.719 de Chile.
