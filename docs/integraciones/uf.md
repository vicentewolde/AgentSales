# Valor oficial de la UF del día (Chile): convertir UF a CLP al publicar

Nota para planificar F5, **consultada el 2026-10-09**. Responde de dónde puede leer AgentSales el valor oficial de la UF para convertir un precio en UF a pesos al publicar en Facebook Marketplace (que solo muestra CLP; ver `fb-marketplace.md`).

Convención: **DOC** = leído en una página oficial (URL en la sección 6); **OBSERVADO** = visto el 2026-10-09 al leer una página o llamar sin clave a un recurso público; **INFERENCIA** = deducido; **NO VERIFICADO** = ninguna fuente oficial lo dice y hay que probarlo.

**Método y límites:** solo se leyó documentación y páginas públicas. No se usó ninguna clave ni cuenta. Una llamada sin clave a la CMF (para ver el error) y una lectura de `mindicador.cl` (no oficial, solo referencia) fueron las únicas consultas a servicios de datos.

## 1. Resumen y recomendación

- **La UF la calcula y la publica el Banco Central de Chile (DOC).** Cada valor diario se publica en el Diario Oficial **a más tardar el día 9 de cada mes**, para el período que va **del día 10 de ese mes al día 9 del mes siguiente, ambos inclusive**. Es decir, la UF se conoce **por adelantado, hasta un mes antes**. El Banco además declara que esos valores **no están sujetos a revisión ni corrección posterior** (DOC, metodología del Banco Central). Consecuencia (INFERENCIA fuerte): el valor de una fecha dada **nunca cambia**, así que se puede guardar en la base y reutilizar sin riesgo de que quede desactualizado.
- **Recomendada: API BDE del Banco Central (fuente primaria, oficial).** Es gratuita, el acceso es inmediato y sin aprobación (DOC), el endpoint REST devuelve JSON con forma documentada, la serie de la UF es `F073.UFF.PRE.Z.D` (DOC) y el límite es de 5 consultas por segundo por cuenta (DOC). El costo operativo: **requiere crear una cuenta y un token que vence cada año** (se renueva desde "Mi Cuenta").
- **Alternativa oficial: API de la CMF** (`api.cmfchile.cl`). También gratuita y con clave, pero la clave se pide por **formulario** y **ni el plazo de respuesta ni la cuota se publican** (DOC por omisión: NO VERIFICADO), el sitio es la API heredada de la antigua SBIF (documentación de 2019) y declara que la CMF "no asume obligaciones referidas a su mantención". La forma del JSON **no aparece en su documentación** (solo XML).
- **Respaldo y verificación cruzada: tabla anual del SII** (`sii.cl/valores_y_fechas/uf/uf2026.htm`): HTML, sin API, sin términos de uso leídos. Sirve para que el operador compare a mano o para una carga de emergencia, no para lectura automática diaria.
- **`mindicador.cl` no es oficial** (proyecto de una persona que "mapea" el sitio del Banco Central, sin términos publicados). Solo como referencia; no debe ser la fuente de un precio publicado.
- **Diseño recomendado (INFERENCIA):** al conectar la fuente, pedir un **rango** (`firstdate` = hoy, `lastdate` = hoy + 31 días) y **guardar los valores por fecha** en la base. Así el valor "de hoy" no depende de la hora ni de que la API responda justo en ese momento, y se usa el valor guardado si la API falla. Para convertir: `CLP = redondear(UF × valor_UF_del_día)` con aritmética decimal (no `float`), usando la fecha en la zona `America/Santiago`. Ejemplo: UF 5.800 × 41.130,94 = **$238.559.452**.

**Qué debe hacer el operador:** crear una cuenta en la Base de Datos Estadísticos (BDE) del Banco Central y activar la API (sección 3.1). Es gratis y toma minutos (DOC: "inmediato y gratuito").

## 2. Fuentes comparadas

| Fuente | Oficial | Requiere clave | Formato | Límites | Términos |
|---|---|---|---|---|---|
| **API BDE, Banco Central** (`si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx`) | **Sí** (el Banco calcula y publica la UF) | **Sí**: cuenta BDE + token (vigencia 1 año, renovable) | JSON (REST); también SOAP (con usuario y clave) | 5 series simultáneas por segundo por cuenta, sin tope diario; el abuso puede suspender la API (DOC) | Gratis e indefinido pero el Banco puede modificarlo o revocarlo; se puede reproducir y adaptar **citando al Banco Central**; sin soporte ni garantía (DOC) |
| **API CMF Bancos v3** (`api.cmfchile.cl`) | **Sí** (CMF; reproduce la UF del Banco Central) | **Sí**: API key por formulario de contacto | XML por defecto; JSON con `formato=json` (forma del JSON NO VERIFICADO en la doc) | Existe una cuota por clave, **monto no publicado** (código de error 90) | Gratis; se puede usar y publicar **citando la fuente con enlace a CMF Bancos**; la CMF no garantiza mantención (DOC) |
| **SII, tabla UF del año** (`sii.cl/valores_y_fechas/uf/uf2026.htm`) | Sí en cuanto a institución pública (la página no dice que el valor venga del Banco Central; coincide con el del Banco el 2026-10-09, OBSERVADO) | No | HTML con una tabla por mes y una consolidada (días x meses), coma decimal, y enlace "Exportar a Excel" | No declarados | **NO VERIFICADO**: no se leyeron términos sobre lectura automática. Sin API ni garantía de estructura estable |
| **mindicador.cl** | **No** (proyecto de código abierto de una persona; según su página "mapea" el sitio del Banco Central) | No | JSON | No declarados (dice recibir más de 1,5 millones de peticiones diarias) | No publica términos ni licencia. Solo referencia |

Cruce de valores (OBSERVADO 2026-10-09): UF del 9-oct-2026 = 41.130,94 en el SII y en `mindicador.cl`. En el SII, el 10-oct-2026 = 41.136,24 y el 9-nov-2026 = 41.295,46, es decir, el período 10-oct a 9-nov ya estaba publicado el día 9.

## 3. Detalle de la recomendada: API BDE del Banco Central

### 3.1 Cómo obtener el token (paso a paso breve, lo hace el operador)

Fuente: páginas "Acceso a la API" y "Ayuda y soporte" de la BDE (DOC).

1. Tener (o crear) una **cuenta en la BDE** con correo y clave (la página de inicio de la API enlaza el registro).
2. Iniciar sesión en la página de inicio de la API, aceptar los **términos de uso** en el recuadro "Habilitación del Servicio" y pulsar **"Activar el uso de la API"**.
3. En **"Mi Cuenta" → "Apikey Token"** copiar el token. **Vigencia: 1 año** desde que se habilita; ahí mismo se puede **renovar** (si venció) o **extender** (sin cambiar el token).
4. Guardarlo como secreto del entorno (propuesta de nombre: `BCCH_API_TOKEN`, a decidir en el spec) y **anotar el vencimiento** para renovar. No va a git ni a logs.

Costo: **gratis**. Aprobación: **ninguna**; "no se exigen solicitudes formales, certificaciones, contratos ni aprobaciones" (DOC). Nota: guías antiguas mencionan pedir credenciales por correo a `contacto_ws@bcentral.cl`; la doc actual lo reemplaza por la activación en línea (DOC, 2025).

### 3.2 Endpoint y llamada

Documentación REST (DOC, página "API Access" en inglés):

- Endpoint: `https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx`
- Método: `GET`
- Parámetros: `token` (obligatorio), `function=GetSeries` (opcional; es el valor por defecto), `timeseries` (obligatorio, **una serie por consulta**), `firstdate` y `lastdate` (opcionales, `YYYY-MM-DD`).
- Serie de la UF: `F073.UFF.PRE.Z.D` (DOC: página "Ayuda y soporte", lista UF, UTM y USD como códigos frecuentes).

Ejemplo **sin clave real** (el ejemplo de la doc usa la serie del dólar; aquí con la de la UF, INFERENCIA de que el patrón es idéntico):

```
GET https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx?token=<TOKEN>&function=GetSeries&timeseries=F073.UFF.PRE.Z.D&firstdate=2026-10-09&lastdate=2026-10-09
```

Para precargar un mes: `firstdate=2026-10-09&lastdate=2026-11-09`. Si el rango incluye fechas aún no publicadas, esas observaciones deberían venir con `value: "NaN"` y `statusCode: "ND"` (INFERENCIA a partir de lo que la doc dice de los días sin dato; **NO VERIFICADO** que la API devuelva fechas futuras ya publicadas).

### 3.3 Forma de la respuesta

Ejemplo de la doc (con la serie del dólar, abreviado; la UF debería tener la misma estructura, INFERENCIA):

```json
{
  "Codigo": 0,
  "Descripcion": "Success",
  "Series": {
    "descripEsp": "...",
    "descripIng": "...",
    "seriesId": "F073.TCO.PRE.Z.D",
    "Obs": [
      { "indexDateString": "01-10-2024", "value": "897.68", "statusCode": "OK" },
      { "indexDateString": "05-10-2024", "value": "NaN", "statusCode": "ND" }
    ]
  },
  "SeriesInfos": []
}
```

- Observaciones en `Series.Obs`.
- **Fecha:** `indexDateString` en formato **`DD-MM-AAAA`** (cuidado: no es ISO).
- **Valor:** **cadena** con **punto decimal** en el ejemplo (`"897.68"`). Para la UF se espera algo como `"41130.94"` (INFERENCIA; confirmar con la prueba real). Hay que parsear sin `float` (por ejemplo, a centavos enteros) y rechazar `NaN`/`ND`.
- `Codigo = 0` es éxito; cualquier otro valor es error o sin resultados, y `Descripcion` lo explica (DOC).

### 3.4 Errores y reintentos

| Caso | Cómo se ve | Reintentable |
|---|---|---|
| Token inválido o vencido | La página de soporte lo lista como error común: revisar que se copió bien y renovar o extender. Forma exacta (HTTP o `Codigo`): NO VERIFICADO | No: avisar al operador |
| `Codigo != 0` | Error o sin resultados; ver `Descripcion` | Según el caso; sin resultados no se reintenta |
| Observación `NaN` / `ND` | Sin dato para esa fecha | No: usar el valor guardado o detener la publicación |
| Tiempo agotado, conexión cortada o lentitud | La doc pide esperar unos minutos y reintentar | Sí, con espera creciente |
| Más de 5 series por segundo | Riesgo de suspensión temporal o permanente | Evitar: una consulta de rango por corrida basta |

Los códigos HTTP concretos de la API REST no están documentados en lo leído: NO VERIFICADO.

### 3.5 Cuándo se publica cada valor

DOC (metodología de la UF, Banco Central, documento de mayo de 2021): publicación **mensual** en el Diario Oficial **a más tardar el día 9**, para el período **10 del mes al 9 del siguiente**, a partir de la variación del IPC del mes anterior (que el INE informa a más tardar el día 8). El valor de cualquier día del período vigente ya existe desde el día 9 anterior, por lo que **pedir "el valor de hoy" no depende de la hora del día**. Único borde: el **día 10** de cada mes es el primer día del período nuevo; la API puede tardar en cargarlo (la CMF define un error 81, "el recurso del día actual todavía no ha sido cargado", lo que sugiere que ese desfase existe; en la BDE: NO VERIFICADO). Mitigación: precargar el rango antes del día 10 y, si falta, usar el último valor guardado solo si el operador lo acepta o detener con aviso.

## 4. Detalle de la alternativa: API CMF (por si se prefiere o como respaldo)

Documentación (DOC): `https://api.cmfchile.cl/documentacion/UF.html`.

- **Base:** `https://api.cmfchile.cl/api-sbifv3/recursos_api/` + `uf`. Solo HTTPS (desde el 1-jul-2018, las peticiones HTTP se redirigen).
- **Rutas:** `/uf` (día actual), `/uf/<año>`, `/uf/<año>/<mes>`, `/uf/<año>/<mes>/dias/<día>` (una fecha), `/uf/posteriores/...`, `/uf/anteriores/...`, `/uf/periodo/<año>/<mes>/<año2>/<mes2>`.
- **Parámetros:** `apikey` (obligatorio), `formato=json|xml` (sin él, **XML**), `callback` (JSONP, solo JSON).
- **Ejemplo sin clave real:** `https://api.cmfchile.cl/api-sbifv3/recursos_api/uf/2026/10/dias/09?apikey=<API_KEY>&formato=json`
- **Respuesta XML (DOC):** `<UFs><UF><Valor>20.939,49</Valor><Fecha>2010-01-01</Fecha></UF></UFs>`. **Valor con coma decimal y punto de miles** (`41.130,94`), fecha `AAAA-MM-DD`. La estructura del JSON **no está en la doc**; se espera `{"UFs":[{"Valor":"...","Fecha":"..."}]}` (INFERENCIA; NO VERIFICADO).
- **Errores (DOC, XML):** 60/503 servicio no disponible (reintentable); 70, 71 fecha mal escrita o inexistente; **72/404 fecha posterior al día actual** (no sirve para pedir valores futuros por fecha, aunque la UF ya esté publicada); 73 tipo de retorno no soportado; 80/404 sin datos; **81/404 el día actual aún no cargado**; **90/420 cuota superada**; **91/421 clave inválida**; **92/422 sin clave**. OBSERVADO el 2026-10-09: llamar `.../recursos_api/uf?formato=json` sin clave devuelve HTTP **422**, coherente con el código 92.
- **Cómo se obtiene la clave:** formulario en `https://api.cmfchile.cl/api_cmf/contactanos.jsp`: elegir "Obtener una API Key", completar **nombre, apellido, RUT, empresa u organización, correo y mensaje** (todos obligatorios) y una verificación humana; la respuesta llega al correo. **Costo: servicio gratuito (DOC). Plazo y monto de la cuota: no publicados (NO VERIFICADO)**; teléfono de la CMF: (+562) 2887-9200. Pide el RUT, lo que la hace menos cómoda para un proyecto personal.
- **Aviso de la doc:** hasta el día 9 de cada mes la información llega solo hasta ese día, porque el período nuevo aún no se carga (DOC); en esta fuente, el borde del día 10 es más probable.

## 5. Cómo probar sin riesgo

- **Tests (msw, sin llamar al Banco Central):** un handler para `GET https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx` que devuelva el JSON de la sección 3.3 con la serie `F073.UFF.PRE.Z.D` y un valor de ejemplo (el valor público del 2026-10-09: `{ "indexDateString": "09-10-2026", "value": "41130.94", "statusCode": "OK" }`). Casos: valor normal; rango con una observación `NaN`/`ND`; `Codigo != 0`; token inválido; error 5xx y tiempo agotado (reintento); respuesta con coma decimal (debe fallar con error claro, no convertir mal).
- **Conversión:** probar `UF 5.800 × 41.130,94 → $238.559.452`, un precio con decimales de UF (por ejemplo UF 2,5), y el redondeo al peso. Probar la fecha en `America/Santiago` cerca de medianoche (UTC vs Chile: `mindicador.cl` devuelve `2026-10-09T03:00:00.000Z` para el 9 de octubre, o sea medianoche de Chile en UTC-3; un `new Date()` en UTC puede dar el día equivocado).
- **Prueba real (la corre el operador, una vez, con su token):** una llamada de humo (`pnpm uf:smoke`, nombre propuesto, a definir en el spec) que pida hoy y hoy + 31 días y confirme: forma real de `value` para la UF, si **devuelve fechas futuras ya publicadas**, qué responde con token inválido y qué pasa el día 10 de un mes. Compararla con la tabla del SII.
- **Sin sandbox:** la BDE es de solo lectura y gratuita; no hay riesgo de efectos, solo respetar 5 consultas por segundo.

## 6. Riesgos y términos

- **Token que vence cada año (BDE):** si vence, la conversión falla. Mitigar con el valor guardado por fecha, aviso al operador antes de vencer y que el fallo **detenga** la publicación en pesos en vez de usar un valor viejo sin avisar.
- **Valor equivocado = precio equivocado publicado.** Un error de formato (coma/punto), de fecha (UTC vs Chile) o de redondeo cambia el precio de un aviso. Validar rango razonable (por ejemplo, que el valor esté cerca del último guardado: la UF varía menos de un 1 % al mes) y mostrar al operador el valor de UF y la conversión en la aprobación.
- **Mostrar la UF en el texto además del CLP (decisión del operador, ver preguntas):** como la UF cambia a diario, un precio en pesos fijado hoy puede quedar desfasado; poner "UF X (aprox. $Y al DD-MM)" en la descripción evita ambigüedad (INFERENCIA).
- **Atribución:** el Banco Central pide mencionar que los datos son suyos y que cualquier adaptación es responsabilidad de quien la hace (DOC); la CMF pide citar la fuente con enlace (DOC). Basta una nota en la documentación y, si se muestra al cliente, "Fuente: Banco Central de Chile".
- **Servicio sin garantía:** ambos declaran que pueden modificar o suspender el servicio sin obligación de mantenerlo (DOC). Por eso se guardan los valores por fecha y se deja el SII como contraste manual.
- **Cambio de contrato:** la BDE tiene dos modos de autenticación (SOAP con usuario y clave, REST con token); usar solo el token REST. La documentación REST se leyó en la página en inglés; no se encontró la versión en español (la ruta que probé devolvió "Página no encontrada"): confirmar con la prueba real.
- **Interpretación de `NaN`:** nunca convertir `NaN`/`ND` en cero ni en el valor anterior en silencio.

## 7. Fuentes (consultadas el 2026-10-09)

Oficiales:

- Banco Central, metodología de la Unidad de Fomento (período 10 al 9, publicación a más tardar el día 9, sin revisión, fórmula): https://si3.bcentral.cl/estadisticas/Principal1/Metodologias/EMF/UF.pdf
- Banco Central, BDE, acceso a la API (cuenta, activación, token de 1 año): https://si3.bcentral.cl/estadisticas/Principal1/Web_Services/acceso_api.html
- Banco Central, BDE, ayuda y soporte (gratuito e inmediato, 5 series por segundo, código `F073.UFF.PRE.Z.D`, atribución, errores comunes): https://si3.bcentral.cl/estadisticas/Principal1/Web_Services/ayuda_soporte.html
- Banco Central, BDE, términos y condiciones: https://si3.bcentral.cl/estadisticas/Principal1/Web_Services/terminos_condiciones.html
- Banco Central, BDE, servicio REST `GetSeries` (endpoint, parámetros, JSON): https://si3.bcentral.cl/estadisticas/Principal1/Web_Services/documentacion_en.html
- Banco Central, BDE, portada de la API: https://si3.bcentral.cl/estadisticas/Principal1/Web_Services/index_API_sec1_es.htm
- CMF, API Bancos, recurso UF (rutas, parámetros, XML, publicación): https://api.cmfchile.cl/documentacion/UF.html
- CMF, códigos de error: https://api.cmfchile.cl/api-codigos-de-error.html
- CMF, términos de uso: https://api.cmfchile.cl/terminos-de-uso.html (lectura parcial; la primera consulta falló, la segunda devolvió un resumen)
- CMF, qué es la API (gratuita, API key y cuota): https://api.cmfchile.cl/que-es-api.html
- CMF, preguntas frecuentes (actualización de la UF, uso comercial remite a términos): https://api.cmfchile.cl/preguntas-frecuentes.html
- CMF, formulario de contacto para pedir la API key: https://api.cmfchile.cl/api_cmf/contactanos.jsp
- CMF, página "Uso de la API key": https://api.cmfchile.cl/uso-de-api-key.html (se cargó sin contenido; cómo se envía la clave se tomó de la doc del recurso UF)
- SII, valores de la UF 2026: https://www.sii.cl/valores_y_fechas/uf/uf2026.htm

No oficial (solo referencia):

- mindicador.cl, página de la API: https://mindicador.cl/ ; consulta de ejemplo `https://mindicador.cl/api/uf/09-10-2026` (valor 41.130,94 para el 9-oct-2026)

## 8. Pendientes (NO VERIFICADO) y cómo probarlos

| Pendiente | Cómo probarlo |
|---|---|
| Forma exacta de `value` para la UF en la BDE (punto decimal, cantidad de decimales) | Llamada de humo con el token del operador, un día |
| Si la BDE devuelve **fechas futuras** ya publicadas (hasta el día 9 del mes siguiente) | Mismo humo con `lastdate` = hoy + 31 días |
| Código HTTP y `Codigo` con token inválido o vencido | Mismo humo con un token falso (no gasta nada) |
| Cuándo se carga el período nuevo en la BDE (el día 9 o el 10) | Revisar `lastdate` disponible los días 9 y 10 del próximo mes |
| Plazo y cuota de la API key de la CMF; forma del JSON de la CMF | Solo si se decide usarla como respaldo: pedir la clave y probar |
| Términos del SII sobre lectura automática de la tabla | Leer los términos del sitio del SII o no automatizar: usarla solo a mano |

## Decisiones del spec de F5 (2026-10-10)

- Se usa la API BDE con el token anual (`BCCH_API_TOKEN`). Los valores leídos se guardan **en memoria** por fecha en el worker (`createBancoCentralUf`), no en una tabla: cada valor se publica por adelantado y no se revisa, y un reinicio solo hace una consulta más.
- Core pide ayer y hoy (día de Santiago) en cada intento de Marketplace: sin alguno de los dos, `UF_VALUE_MISSING`; si se aleja más de 1 % del de ayer, `UF_VALUE_SUSPICIOUS`. Nunca se usa un valor viejo.
- La forma de los errores (token inválido) y si la API trae días futuros los confirma `pnpm uf:smoke` (lo corre el operador).
