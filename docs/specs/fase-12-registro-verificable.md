# F12 · Registro verificable (Aval dentro de AgentSales)

- **Estado:** Borrador del 2026-11-06. Lote 1 (T01 a T06) en construcción en la rama `feat/f12-t01-t06-registro-verificable`. El resto son tareas especificadas, sin empezar.
- **Origen:** el prototipo **Aval**, hecho para el hackatón de Meta (repo aparte `vicentewolde/aval`, commit `b7faa50`). El plazo del hackatón (4-nov, 23:00 Chile) ya pasó; no se sabe si el envío salió, y esta fase no reenvía nada.
- **Decisión del operador (2026-11-06):** Aval deja de ser un proyecto aparte y pasa a ser **parte de AgentSales**, para que siga siendo **un solo proyecto inmobiliario**. El video de la demo de Aval es el video de demo del proyecto.

## 1. Objetivo

Que cada propiedad de AgentSales tenga además un **registro verificable**: una ficha donde cada dato dice de dónde sale (visto en las fotos, dicho por el corredor, declarado, sin confirmar u opinión), con reglas de qué se muestra y qué no, que un agente de IA (o una persona) puede consultar sin que le mientan, y que AgentSales usa también para **redactar textos que no inventan nada**.

Dicho simple: hoy AgentSales publica avisos. Con F12 puede además **demostrar que lo que publica es cierto** y responder a compradores (humanos o agentes) con datos verificados. Eso es lo que diferencia a un corredor frente a un aviso cualquiera.

## 2. Contexto de mercado (sin verificar)

Comentario de un post de Instagram (@datos_inmobiliarios, sobre modernización inmobiliaria), que el operador adjuntó el 2026-11-06. **Fuente: Instagram; la cifra de Deloitte no se ha comprobado.** Se usa como contexto, no como evidencia.

- Publicar un departamento toma minutos; comprar o arrendar toma semanas de llamadas, visitas y documentos repetidos.
- Los datos están repartidos entre compradores, dueños, corredores, bancos, aseguradoras y notarías.
- Un informe global de Deloitte diría que el **61 %** de los dueños e inversionistas encuestados aún depende de tecnologías antiguas (cifra a verificar antes de citarla en público).
- Muchas empresas crecieron con relaciones personales, carpetas y planillas, que fallan cuando la cartera crece.
- La proptech ayuda con inventario al día, seguimiento de solicitudes, documentos y citas, valoración y administración; la IA ayuda a leer documentos, ordenar consultas y detectar inconsistencias, **pero necesita datos confiables y procesos claros**.

**Lectura para el proyecto:** F12 es justo eso, «datos confiables y procesos claros» como base para que la IA sea útil (leer documentos de dominio, detectar inconsistencias, responder consultas). Es el argumento de venta, no una promesa de resultados.

## 3. Alcance

**Entra:**
- Un paquete nuevo, `@agentsales/registry`, sin infraestructura (lógica pura, probada), con lo mejor de Aval: afirmaciones con procedencia, política de qué se divulga, búsqueda determinista, lectura de lo que pide el comprador, guarda de números en traducciones, motor de negociación acotado por mandatos, revisión de títulos de dominio contra el texto del PDF, y base del pasaporte firmado.
- Después: guardarlo en la base, producirlo en el worker, publicarlo como un destino más («registro») y exponerlo a agentes por MCP y a personas en una vitrina web.
- Textos con **pie verificado**: el mismo texto de Instagram o Portal, pero solo con afirmaciones que el registro respalda.

**No entra (por ahora):** cobrar en línea, firmar contratos, representar legalmente a nadie. La negociación y el término de oferta **no son vinculantes** y exigen dos aprobaciones humanas. Nada cambia en las reglas de publicación: `PUBLISH_MODE=dry-run` por defecto y nada se enciende sin instrucción del operador.

## 4. Diseño

- **Paquete `registry`:** sin red, sin base de datos, sin archivos. Usa `node:crypto` (hashes y firmas Ed25519), por eso no vive en `core` (que no usa Node). El acceso a modelos de lenguaje pasa por un puerto (`ModelClient`); un adaptador implementa Meta Muse Spark u otro proveedor (ADR-0040).
- **Entidades:** una propiedad (`Listing`) tiene muchas afirmaciones (`Claim`) con procedencia: `visually_verified`, `broker_stated`, `broker_declared`, `unverified`, `subjective`. La política decide qué se ve, con la dirección oculta y el precio dado en rango asimétrico.
- **Relación con lo que ya existe:** las afirmaciones nacen de los campos de la planilla (`FieldDefinition`) y de las fotos; el registro es otra «publicación» con su estado, su bitácora y su aprobación (ADR-0039).
- **Aprobación primero:** nada del registro se hace público sin aprobar, igual que los textos.

## 5. Tareas

| Id | Qué | Lote |
|---|---|---|
| F12-T01 | Paquete `registry`: afirmaciones, procedencia, verificación con detecciones de video (SAM), español | 1 |
| F12-T02 | Política de divulgación, búsqueda, lectura de la petición (reglas + puerto al modelo), guarda de traducción, base de la guarda de «texto sin inventos» | 1 |
| F12-T03 | Base del pasaporte: JSON canónico y árbol de Merkle | 1 |
| F12-T04 | Negociación: motor, mandatos firmados y sus pruebas de propiedad (500 negociaciones al azar) | 1 |
| F12-T05 | Revisión de títulos: esquema, verificación de citas contra el texto del PDF y reglas | 1 |
| F12-T06 | Reglas de lo que nunca debe decir un texto (contactos, gustos) | 1 |
| F12-T07 | Esquema Drizzle y repositorios (afirmaciones, pasaporte, revisión, mandatos); migración aditiva | 2 |
| F12-T08 | Adaptadores: lectura de PDF (pdftotext), cliente de la API de modelos de Meta (Muse Spark, SAM 3.1, voz) detrás de `ModelClient`, tope de gasto por corredor | 2 |
| F12-T09 | Worker: construir el registro de una propiedad al prepararla; revisión de título al subir un PDF | 2 |
| F12-T10 | API y servidor MCP (herramientas de solo lectura primero) con identidad de agente y bitácora | 3 |
| F12-T11 | Panel: vitrina pública y búsqueda para compradores; pantalla del corredor para aprobar el registro | 3 |
| F12-T12 | «Registro» como destino de publicación y pie verificado en los textos de Instagram y Portal | 4 |
| F12-T13 | Cierre: prueba de ataques en la CI (la de Aval: 119 de 119 sin modelo), documentación, demo | 4 |

## 6. Cuando termine (criterios de aceptación)

1. Cada afirmación publicada dice su procedencia y ninguna `unverified` o `subjective` se presenta como hecho.
2. Un agente que consulta el registro no puede obtener la dirección exacta ni el precio mínimo del corredor, ni siquiera con peticiones hostiles (la prueba de ataques corre en la CI).
3. Un texto con pie verificado no contiene números ni términos que el registro no respalde.
4. Ninguna negociación se cierra fuera de los mandatos de ambos lados; el resultado nunca es vinculante sin dos aprobaciones humanas.
5. `pnpm check` en verde; nada llama APIs reales en las pruebas.

## 7. Demo y video

El video de la demo de Aval (2:46, voz de ElevenLabs y subtítulos) es el video de demo del proyecto. **El archivo no está en este repo** (pesa 15 MB y está fuera de git): vive en el Mac del operador en `~/dev/aval/out/video/aval-prototype.mp4` (con su `.srt`). Se regenera desde el repo de Aval con `node scripts/video/make-video.ts`. Si se quiere en el servidor, se sube a R2 y se enlaza desde `docs/12-demo-oficina.md`; no se commitea.

## 8. Primeros clientes (cómo hacerlo rentable)

El operador pidió empezar ya a tener clientes. La pista de ventas está en los borradores `docs/13-propuesta-hoja-de-ruta-2.md` y `docs/14-ventas-v0.md` (sin commitear en la carpeta principal; esta fase no los toca).

- **Oferta:** servicio operado por el operador para una oficina (tipo RE/MAX), demo de 20 minutos, sin precio todavía.
- **Lo que F12 agrega a la demo:** «tus avisos con prueba de que son ciertos» y la vitrina para que un agente de IA del comprador consulte sin riesgo. Es el diferenciador frente a publicar en portales.
- **Promesas honestas:** solo lo ya probado (ver `docs/14`, §1). Lo de F12 se muestra como piloto hasta que el lote 3 esté desplegado.
- **Pendiente de decisión del operador:** precio y paquete (por propiedad, por oficina o mensual). No se inventa aquí.

## 9. Riesgos

- **Datos reales de clientes:** ningún dato real de `data/muestras/` entra a git. Las pruebas usan propiedades inventadas.
- **Cifra de Deloitte y otras de mercado:** no citarlas en público sin verificar.
- **Dependencia de un proveedor de modelos:** el puerto permite cambiar de Meta a Claude sin tocar el registro.
- **Alcance:** la negociación y la revisión de títulos pueden prometer más de lo que son. Se presentan como ayuda a revisar, no como asesoría legal.

## 10. Preguntas abiertas

- ¿Precio y empaque? (operador)
- ¿Se renombra «Aval» como función («Registro verificable» en el panel) o se conserva como marca? Por ahora, solo «registro» en el código.
- ¿Dónde se aloja el video de la demo para el servidor (R2 o solo local)?

## 11. Cambios

- 2026-11-06: borrador y lote 1.
