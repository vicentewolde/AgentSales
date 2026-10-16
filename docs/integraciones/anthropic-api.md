# API de Anthropic (Messages API y SDK `@anthropic-ai/sdk`)

Nota verificada el 2026-10-02. Sirve para dejar el adaptador `anthropic-api` como stub en F2 y diseñar bien el puerto `LLMProvider` (ADR-0003). No se hizo ninguna llamada a la API: solo se leyó documentación.

Convención: **DOC** = documentación oficial; **INFERENCIA** = deducido; **NO VERIFICADO** = falta prueba real.

## 1. Resumen

- **Mecanismo:** `client.messages.create` o `client.messages.parse` con `output_config.format` (salida estructurada, JSON Schema). Imágenes como bloques `image` (base64, URL o `file_id`).
- **Madurez:** salida estructurada está disponible de forma general (GA, sin cabecera beta). El parámetro anterior `output_format` está **deprecado** (requería la cabecera beta `structured-outputs-2025-11-13`).
- **Riesgo bajo.** Cuidado con tres cambios que afectan el diseño del puerto:
  - Los modelos Claude Opus 5.5, Sonnet 5.5, Fable 5.1 y Mythos 5.1 **rechazan el tool use forzado** (`tool_choice` `any` o `tool`: error 400).
  - Los modelos 4.6 y posteriores no admiten *prefill* del mensaje del asistente.
  - Claude Sonnet 5.5 no admite `thinking: {type: "disabled"}`; usa `between_tools`.
  - Conclusión: la salida estructurada se pide con `output_config.format`, no con tool use forzado ni con prefill.

## 2. Requisitos de cuenta y app

- Cuenta de Claude Console y API key (`ANTHROPIC_API_KEY`). Facturación por uso (tokens). La estimación de costo está en la página de precios; no se consultó aquí.
- Sin revisión ni aprobación. Obligatoria en cuanto el sistema lo use alguien más que el operador (ADR-0003, y términos en `claude-code-cli.md` sección 9).
- SDK: `@anthropic-ai/sdk`; requiere Node 20 LTS o posterior y TypeScript 5.0 o posterior (DOC). Node 26 queda cubierto ("20 LTS or later non-EOL" es la redacción de la doc; verificar con la instalación real, ADR-0008).

## 3. Autenticación

- Cabecera `x-api-key` y `anthropic-version: 2023-06-01`. El SDK lee `ANTHROPIC_API_KEY` y envía la versión solo (DOC).
- Sin OAuth ni refresco. Las claves pueden expirar o ser revocadas: error 401 `authentication_error`.
- Existe Workload Identity Federation para entornos de nube; no aplica.

## 4. Operaciones

### 4.1 Salida estructurada (DOC)

```ts
const response = await client.messages.parse({
  model: "claude-sonnet-5-5",
  max_tokens: 4096,
  system: "...",
  messages: [{ role: "user", content: [ /* imágenes antes del texto */ ] }],
  output_config: { format: zodOutputFormat(MiEsquemaZod) },   // helper "@anthropic-ai/sdk/helpers/zod"
});
response.parsed_output;
```

- Forma cruda: `output_config: { format: { type: "json_schema", schema: { ... } } }`. Con esquemas JSON propios: `jsonSchemaOutputFormat(schema)` de `@anthropic-ai/sdk/helpers/json-schema`.
- Modelos que lo soportan según la doc: claude-opus-5-5, claude-opus-5, claude-sonnet-5-5, claude-sonnet-5, claude-haiku-4-5-20251001, claude-mythos-5-1, claude-fable-5-1 y versiones anteriores de Opus y Sonnet.
- **Limitaciones del esquema (DOC):** sin esquemas recursivos; sin `minimum`, `maximum`, `multipleOf`; sin `minLength`, `maxLength`; en arreglos solo `minItems` 0 o 1; `additionalProperties` solo puede ser `false`; `enum` solo con valores primitivos; formatos de string permitidos: `date-time`, `time`, `date`, `duration`, `email`, `hostname`, `uri`, `ipv4`, `ipv6`, `uuid`. Soporta `anyOf`, `allOf`, `$ref`, `$defs`.
  - **Consecuencia:** los largos del título (60 en ML) y del caption (2.200 en IG) no pueden ir en el esquema enviado al modelo. Se validan después con zod, como ya dicta ADR-0003 (y la política de `docs/04`: reintentar una vez).
- Casos en que la salida **puede no cumplir el esquema (DOC):** `stop_reason: "refusal"` (HTTP 200, se cobra, la salida puede no calzar) y `stop_reason: "max_tokens"` (salida truncada: reintentar con más `max_tokens`). Los valores de `enum` pueden variar en mayúsculas: comparar sin distinguir.
- **NO VERIFICADO:** qué versión de zod exige `zodOutputFormat` (el repo usa zod 4; confirmar al instalar el SDK). Alternativa sin helper: `z.toJSONSchema(schema, { target: "draft-7" })` y `jsonSchemaOutputFormat`.
- **Alternativa:** tool use con `strict: true` y `tool_choice: auto` (garantiza que la entrada de la herramienta cumpla el esquema). Más complejo que `output_config.format`; no es necesario.

### 4.2 Forma del puerto `LLMProvider` (recomendación previa, superada por el spec F2 §4.5)

> El spec F2 fijó otro contrato: el puerto recibe `system`, `prompt` y un JSON Schema sin topes, devuelve `{ data: unknown, model }` y core valida con zod. Sin imágenes en F2. El stub responde `LLM_NOT_CONFIGURED`. Lo de abajo queda como antecedente.

- Tanto `claude-cli` como `anthropic-api` pueden cumplir `generateStructured<T>({ system, prompt, images, schema })` del contrato actual (`docs/01-arquitectura.md`). No hace falta cambiarlo para F2.
- Añadir al resultado, de forma opcional, metadatos de uso: `{ data: T, usage?: { inputTokens, outputTokens, costUsd? }, model: string, promptVersion }` para el registro de `content`. Decisión del operador (ver preguntas en el resumen).
- `ImageRef` debe poder resolverse a bytes (`Buffer` + `mediaType`) y no a una URL: la CLI necesita archivos locales y la API acepta base64 (la URL pública de R2 prefirmada también serviría, pero el puerto no debe depender de ella).
- El esquema se expresa en zod en `core` y cada adaptador lo convierte (la CLI y la API quieren JSON Schema draft-07 sin restricciones que el modelo no soporta).
- Errores del puerto: distinguir `retryable` (429, 5xx, 529, timeout, conexión), `rate_limited_until` (límite de plan en la CLI), `auth` (401/403, no autenticado), `invalid_output` (no cumple esquema o refusal/max_tokens) y `invalid_request` (400).

## 5. Medios (imágenes)

- **Formatos (DOC):** JPEG, PNG, GIF, WebP (`image/jpeg`, `image/png`, `image/gif`, `image/webp`). **HEIC no** (convertir antes; ver `heic-conversion.md`). Los GIF animados usan solo el primer cuadro.
- **Fuentes de la imagen (DOC):** `base64`, `url` o `file` (`file_id` de la Files API). En Bedrock y Google Cloud solo `base64`.
  - Base64: `{ "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "..." } }`.
  - URL: `{ "type": "image", "source": { "type": "url", "url": "https://..." } }` (la URL debe ser pública y alcanzable por Anthropic; una URL prefirmada de R2 sirve mientras no expire; **NO VERIFICADO** con R2).
- **Cantidad por request (DOC):** hasta 100 en modelos con ventana de 200k tokens y hasta 600 en los demás. Si un request lleva más de 20 imágenes, rige un límite de dimensión más estricto por imagen (la doc recomienda lado largo ≤ 2000 px). Para una propiedad: ≤ 20 imágenes, evita el límite estricto.
- **Peso máximo por imagen (DOC):** 10 MB en base64 con la API directa (5 MB en Bedrock y Google Cloud). Máximo 8000x8000 px.
- **Tamaño máximo del request (DOC):** 32 MB en la Messages API (413 `request_too_large` si se excede). Con base64 el tamaño crece ~33 %: 20 fotos de 1 MB ya son ~27 MB. Redimensionar antes.
- **Tamaño recomendado (DOC):** la imagen se divide en parches de 28x28 px; costo en tokens = `ceil(ancho/28) * ceil(alto/28)`. Se reduce automáticamente por encima de: lado largo 2576 px y 4784 tokens (modelos 4.7 y posteriores) o lado largo 1568 px y 1568 tokens (los demás). Mandar más grande no mejora nada. Recomendación para fotos de propiedades: **lado largo 1280 a 1568 px, JPEG calidad ~80**; unos 1.000 a 1.600 tokens por foto.
- **Orden:** poner las imágenes antes del texto; rotular cada una (`Image 1:`, `Image 2:`…) para que el modelo pueda devolver ids por foto (DOC).
- No se leen metadatos EXIF (DOC): si se necesita la orientación, corregirla antes de enviar.
- Las imágenes no se guardan en Anthropic más allá del request (DOC, FAQ de visión).

## 6. Límites

- Rate limits por organización y por nivel de uso (tiers); no se leyeron los valores. Ver https://platform.claude.com/docs/en/api/rate-limits (NO VERIFICADO en esta nota).
- Request: 32 MB en Messages API (256 MB en Batch, 500 MB en Files API) (DOC).
- Salida: `max_tokens` es obligatorio; el contenido de un aviso completo cabe en unos 2.000 a 4.000 tokens (INFERENCIA).
- Timeout del SDK: 10 min por defecto (calculado según `max_tokens` si no hay streaming); reintentos: 2 por defecto, con retroceso exponencial, para errores de conexión, 408, 409, 429 y >= 500 (DOC). Configurable con `maxRetries` y `timeout`.
- Message Batches: existe una API por lotes (256 MB) para trabajo masivo no urgente; no necesaria en F2 (DOC).

## 7. Errores comunes

| HTTP | Tipo (`error.type`) | Clase en el SDK de TypeScript | Reintentable |
|---|---|---|---|
| 400 | `invalid_request_error` | `BadRequestError` | No (también por el tope de gasto de la organización) |
| 401 | `authentication_error` | `AuthenticationError` | No |
| 402 | `billing_error` | (genérica) | No |
| 403 | `permission_error` | `PermissionDeniedError` | No |
| 404 | `not_found_error` | `NotFoundError` | No (ej. modelo inexistente) |
| 409 | `conflict_error` | `ConflictError` | Sí |
| 413 | `request_too_large` | (genérica 4xx) | No: reducir imágenes |
| 429 | `rate_limit_error` | `RateLimitError` | Sí, honrando `retry-after`; el tope de gasto mensual no trae `retry-after` y no se arregla esperando |
| 500 | `api_error` | `InternalServerError` | Sí |
| 504 | `timeout_error` | `InternalServerError` | Sí |
| 529 | `overloaded_error` | `InternalServerError` | Sí |
| N/A | (conexión) | `APIConnectionError`, `APIConnectionTimeoutError` | Sí |

Cada respuesta trae `request-id` (el SDK lo expone como `_request_id`): guardarlo en el log de errores. Un error puede ocurrir también a mitad de un stream después de un 200. (DOC)

Errores 400 propios de los modelos nuevos que el adaptador debe evitar: prefill, `thinking.type.enabled` en modelos 4.7 y posteriores, `thinking: disabled` en Opus 5.5 y Sonnet 5.5, `tool_choice` forzado en Opus 5.5, Sonnet 5.5, Fable 5.1 y Mythos 5.1 (DOC).

## 8. Cómo probar sin riesgo

- Tests: `msw` o el adaptador `fake`; ningún test llama a la API real (CLAUDE.md).
- Para el stub de F2: el adaptador `anthropic-api` lanza un error claro (en el spec F2: `LLM_NOT_CONFIGURED`) o se implementa completo con tests de contrato en msw (los cuerpos de la sección 4 son verificables sin red).
- Prueba real (cuando se implemente de verdad, no en F2): una llamada con una imagen de 200x200 y un esquema trivial con `claude-haiku-4-5-20251001`, en una clave de la Console con tope de gasto bajo. No hay sandbox.

## 9. Riesgos y términos de uso relevantes

- Costo: cada llamada con ~10 fotos es ~10 a 16 mil tokens de entrada. Fijar un tope de gasto en la Console.
- Los modelos y sus restricciones cambian rápido (ver sección 1): fijar el nombre del modelo en configuración, no en código, y registrar `model` en `content`.
- Términos comerciales: el uso de la API con la clave de quien opera el sistema se factura a esa cuenta; si un corredor usa el sistema, debe poner su propia clave (ver `claude-code-cli.md` sección 9).
- Privacidad: las imágenes no se guardan tras el request y no se usan para entrenar (DOC, FAQ de visión).

## 10. Fuentes (consultadas el 2026-10-02)

- Salida estructurada (parámetro `output_config.format`, limitaciones, modelos, `refusal`, `max_tokens`): https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Visión (formatos, base64/URL/Files, límites, tamaño, tokens): https://platform.claude.com/docs/en/build-with-claude/vision
- Errores de la API (códigos, límite de 32 MB, errores de modelos nuevos): https://platform.claude.com/docs/en/api/errors
- SDK de TypeScript (requisitos, errores, reintentos, timeouts): https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript
- Definir herramientas (`tool_choice`, restricción de tool use forzado): https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
- Repositorio del SDK (requisitos): https://github.com/anthropics/anthropic-sdk-typescript

## 11. Ampliación 2026-10-16 (planificación de F7): implementar el adaptador

Ronda hecha el 2026-10-16 leyendo documentación pública con la herramienta que extrae y resume el texto; no se hizo ninguna llamada a la API ni se usó ninguna clave. Resuelve el NO VERIFICADO de zod de la sección 4.1 y la sección 6 (límites de tasa), y actualiza los modelos. Lo ya dicho arriba no se repite.

### 11.1 SDK `@anthropic-ai/sdk`: versión, antigüedad y compatibilidad

| Dato | Valor | Fuente |
|---|---|---|
| Última versión | **0.135.0**, publicada el **2026-10-15** (hace 1 día) | DOC (releases y CHANGELOG de GitHub; la fecha de npm no se leyó) |
| Anterior | 0.134.0 (2026-10-14), 0.133.0 (2026-10-09), 0.132.1 (2026-10-08) | DOC (CHANGELOG) |
| Cadencia | Cerca de una versión por semana, a veces dos | DOC |
| `peerDependencies` | `zod: ^3.25.0 \|\| ^4.0.0`, **opcional** (también `standardwebhooks`, `json-schema-to-ts` y `@opentelemetry/api` como dependencias) | DOC (manifiesto de 0.135.0 en el registro de npm y en GitHub) |
| Helpers | `@anthropic-ai/sdk/helpers/zod` (`zodOutputFormat`) y `@anthropic-ai/sdk/helpers/json-schema` (`jsonSchemaOutputFormat`) existen por el comodín `./helpers/*` de `exports` | DOC |
| `engines` | No definido en el manifiesto | DOC |
| Node | La doc dice "Node.js 20 LTS o posterior, versiones no EOL". Node 26 queda cubierto por esa frase; ninguna prueba nombra a Node 26 | DOC + INFERENCIA |
| TypeScript | La doc dice ">= 5.0". El propio SDK se desarrolla con TypeScript 6.0.3. **TypeScript 7 (7.0.2, el del repo) no se nombra en ninguna parte** | DOC; TS 7: **NO VERIFICADO** |
| Licencia | MIT | DOC |

- **Antigüedad mínima (`minimumReleaseAge`):** pnpm 11 trae por defecto **1440 minutos (1 día)** (DOC, pnpm.io). `pnpm-workspace.yaml` del repo no lo cambia (leído hoy). Por eso **0.135.0 queda justo en el borde** (publicada ayer; la hora exacta de npm no se obtuvo): si `pnpm add` la rechaza, no se agrega excepción (regla de `docs/05-convenciones.md`). Recomendación: fijar **0.134.0** (2 días) o **0.133.0** (7 días, la más tranquila). Nada de lo que trae 0.135.0 (`usage.speed`, `between_tools` en capacidades, tope de gasto del tier como límite de solo lectura) hace falta para el adaptador.
- **0.134.0 y siguientes agregan trazado OpenTelemetry nativo:** si la app registra un proveedor global de trazas, el SDK crea spans y agrega cabeceras de contexto; sin proveedor global no hace nada (DOC, notas de la versión). Se apaga con `new Anthropic({ openTelemetry: false })` o `ANTHROPIC_OPEN_TELEMETRY=false`. AgentSales no registra ninguno hoy. 0.133.0 no lo tiene.
- **zod 4 (resuelto):** el peer es `^3.25.0 || ^4.0.0`, así que zod 4 está soportado (DOC). `zodOutputFormat(schema)` se pasa a `client.messages.parse({ output_config: { format } })` y el resultado validado va en `parsed_output` (DOC, ejemplo oficial). Cuánto cubre `zodOutputFormat` de las restricciones no soportadas por la API (`minLength`, etc.): la doc solo dice que, "a diferencia de `zodOutputFormat()`, `jsonSchemaOutputFormat()` no valida las respuestas contra restricciones que la API no soporta, como `minimum`" (INFERENCIA: el helper de zod las quita del esquema enviado y las valida en el cliente). No se ejecutó.
- **Decisión de diseño que se desprende (INFERENCIA):** el puerto `LLMProvider` del spec F2 §4.5 entrega un **JSON Schema sin topes** y core valida con zod. Entonces el adaptador no necesita zod: puede usar `output_config: { format: { type: "json_schema", schema } }` con `client.messages.create` (o `jsonSchemaOutputFormat`) y devolver `{ data: unknown, model }`. Así `packages/llm` no gana una dependencia de zod ni depende del helper.
- **Prueba que cierra el NO VERIFICADO de TS 7 y Node 26:** `pnpm add @anthropic-ai/sdk@0.134.0 --filter @agentsales/llm` seguido de `pnpm typecheck` y un test del adaptador con msw. Si TS 7 se queja de los tipos del SDK, es un hallazgo para el ADR (no se contradice el stack; se informa).

### 11.2 Modelos vigentes y precios (DOC, página de modelos y de precios, 2026-10-16)

Todos aceptan imágenes y texto, y **todos soportan salida estructurada** (`output_config.format`), sin salvedades para Haiku 5.5. Ventana de 1M tokens y hasta 128K de salida en la API síncrona. Los ID de la API son los de la tabla (cada uno es una versión fija, sin fecha).

| Modelo | ID exacto | Entrada / salida (USD por millón de tokens) | Lectura de caché | Retiro |
|---|---|---|---|---|
| Claude Fable 5.1 | `claude-fable-5-1` | 10 / 50 | 0,25 | No antes del 2027-09-01 |
| Claude Opus 5.5 | `claude-opus-5-5` | 4 / 20 | 0,20 | No antes del 2027-09-22 |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 2 / 10 | 0,10 | No antes del 2027-09-28 |
| Claude Haiku 5.5 | `claude-haiku-5-5` | **0,10 / 0,50** hasta 100.000 tokens de prompt; 0,50 / 2,50 si el prompt pasa de 100.000 | 0,01 | No antes del 2027-10-07 |
| Claude Haiku 4.5 (la nota original lo usaba para la prueba real) | `claude-haiku-4-5-20251001` | 1 / 5 | 0,10 | vigente |

- La API por lotes (Batch) cuesta el 50 %. Escritura de caché a 5 min: 1,25 veces la entrada (Sonnet 5.5: 2,50; Haiku 5.5: 0,125); a 1 h: 2 veces. Mínimo cacheable de Sonnet 5.5 y Haiku 5.5: 512 tokens.
- **Para redactar avisos (INFERENCIA, no se probó con fotos reales):** un aviso con 10 fotos son unos 12.000 tokens de entrada y 2.000 a 4.000 de salida (sección 6). Costo por aviso: Sonnet 5.5 cerca de **USD 0,05**; Opus 5.5 cerca de 0,11; Haiku 5.5 cerca de **0,003**; Fable 5.1 cerca de 0,27 (con 12.000 de entrada y 3.000 de salida; sin contar los tokens de razonamiento, que se cobran como salida: NO VERIFICADO para estos modelos en esta ronda). Recomendación: **`claude-sonnet-5-5` por defecto, `claude-haiku-5-5` como candidato** a medir con `pnpm eval:content` (unas 20 veces más barato que Sonnet 5.5; la calidad del español de Chile y el respeto de las reglas editoriales hay que medirlos, no suponerlos). El modelo va en configuración (`LLM_MODEL` o similar), no en código, y se registra en `content` (ya lo exige la sección 9).
- **Pensamiento (afecta el adaptador):** el pensamiento es adaptativo por defecto en los cuatro. Sonnet 5.5 **no acepta** `thinking: { type: "disabled" }`: para apagarlo se manda `{ type: "between_tools" }` (y con esfuerzo `xhigh` o `max` falla con 400). Haiku 5.5 acepta `disabled`. Opus 5.5 y Fable 5.1 lo tienen siempre encendido. Esfuerzo (`output_config.effort`) por defecto: `high` en Sonnet 5.5 y Fable 5.1, `medium` en Opus 5.5 y Haiku 5.5. Para un texto de aviso conviene un esfuerzo bajo; cuánto sube la calidad con él: NO VERIFICADO.
- **Primera llamada con un esquema nuevo:** tiene latencia extra mientras se compila la gramática; queda en caché 24 h desde el último uso (DOC). Cambiar solo `name` o `description` no la invalida. Cambiar `output_config.format` invalida la caché de prompt de esa conversación.
- **Rechazo de razonamiento:** si una propiedad del esquema pide razonamiento paso a paso, puede provocar un `refusal` del tipo `reasoning_extraction`; pedir una explicación breve (DOC). No poner un campo "razonamiento" en el esquema de contenido.

### 11.3 Qué registrar del uso

`usage` de la respuesta (DOC, caché de prompts y guía del SDK):

| Campo | Significado |
|---|---|
| `input_tokens` | Entrada **sin caché**, la posterior al último punto de caché |
| `output_tokens` | Tokens generados; no los afecta la caché |
| `cache_creation_input_tokens` | Escritos en caché; es la suma de `cache_creation.ephemeral_5m_input_tokens` y `cache_creation.ephemeral_1h_input_tokens` |
| `cache_read_input_tokens` | Leídos de caché |

- **Entrada total = `cache_read_input_tokens + cache_creation_input_tokens + input_tokens`.** Con caché, `input_tokens` por sí solo subestima. El registro por llamada debe guardar los cuatro campos (más el desglose de `cache_creation` si se usa caché), el `model`, `stop_reason`, `request-id` (el SDK lo da como `_request_id`) y el `anthropic-workspace-id` de la respuesta.
- `usage.speed` aparece en las notas de 0.135.0 (modo rápido); `service_tier` e `inference_geo` figuran en los informes de uso de la API de administración, pero **que vengan en el `usage` de cada respuesta: NO VERIFICADO**. No son necesarios.
- **Costo (INFERENCIA):** calcular en dólares con una tabla de precios en configuración, con fecha, por modelo: entrada normal, escritura de caché, lectura de caché y salida. Guardar también la versión de la tabla. Los precios cambian (la página dice que la vigente está en claude.com/pricing) y Haiku 5.5 tiene dos tramos según el largo del prompt.
- Cabeceras de respuesta que sirven (DOC): `request-id`, `anthropic-organization-id`, `anthropic-workspace-id`, `retry-after` (en 429) y `anthropic-ratelimit-*`. El SDK las expone con `.withResponse()` o `.asResponse()`; solo `_request_id` viene directo en el objeto.

### 11.4 Límites de tasa y de gasto (DOC, 2026-10-16)

Los niveles se llaman ahora **Start, Build, Scale y Custom** (más un nivel **Evaluation** para organizaciones nuevas, con límites por debajo de los de la tabla). La organización cambia de nivel sola según su historial y estado de cuenta; el Console muestra el nivel y se puede pedir un aumento con "Request tier increase". La página no da el monto de depósito ni el requisito exacto para subir de nivel: NO VERIFICADO.

| Nivel | Opus 5.5, Sonnet 5.5 y Haiku 5.5 (cada uno): solicitudes / min | Entrada sin caché / min | Salida / min | Tope de gasto mensual |
|---|---|---|---|---|
| Start | 1.000 | 2.000.000 | 400.000 | USD 500 |
| Build | 5.000 | 5.000.000 | 1.000.000 | USD 1.000 |
| Scale | 10.000 | 10.000.000 | 2.000.000 | USD 200.000 |

- Fable 5.x: Start 1.000 / 500.000 / 100.000; Build 2.000 / 1.500.000 / 300.000; Scale 4.000 / 4.000.000 / 800.000. Los límites son por organización y por clase de modelo (algoritmo de balde de fichas: se rellenan de a poco, no se reinician a una hora fija). Los modelos 4.x comparten un límite combinado aparte.
- Solo cuentan para la entrada por minuto `input_tokens` y `cache_creation_input_tokens`; las lecturas de caché **no** cuentan. `max_tokens` **no** cuenta para la salida por minuto. Para AgentSales (un aviso son unos 15.000 tokens y unos pocos avisos por hora) el nivel Start sobra por varios órdenes de magnitud; el límite real que importa es el **tope de gasto**.
- **Alzas bruscas de uso** pueden dar 429 por "límites de aceleración": subir el tráfico de a poco.
- Se pueden fijar límites **más bajos** por workspace (11.6); no se pueden poner en el workspace Default.

### 11.5 Errores relevantes (DOC, 2026-10-16; confirman la tabla de la sección 7 y la ajustan)

- **401 `authentication_error`:** clave mal formada, revocada **o vencida**. Las claves de la Console tienen vencimiento elegible al crearlas (3 horas, 1, 7 o 30 días, personalizado o "Never") y Anthropic avisa por correo al creador (7 días antes si duran 14 días o más). Al vencer devuelven 401. **Para el diseño:** crear la clave sin vencimiento o con una fecha anotada en el calendario del operador; el adaptador debe mapear 401 a "necesita atención del operador" y no reintentar.
- **429 `rate_limit_error`:** tiene tres causas que se distinguen. (1) Límite de tasa: trae `retry-after` en segundos (esperar eso; reintentar antes falla). No todo 429 lo trae. (2) **Tope de gasto mensual del nivel:** sin `retry-after`; el cuerpo trae `error.details.error_code = "enforced_spend_limit_reached"` y dice cuándo vuelve el acceso (00:00 UTC del día 1 del mes siguiente). No se arregla esperando ni reintentando. (3) Límite de aceleración. El SDK reintenta 429 dos veces por defecto honrando `retry-after`.
- **400 `invalid_request_error` por tope de gasto propio:** si el operador fija un límite de gasto en la organización o en un workspace, al alcanzarlo la API responde **400** con el mensaje "You have reached your specified API usage limits" (o "...workspace API usage limits"), no 429 (excepción: el workspace de Claude Code). Hay que tratarlo como no reintentable y avisar al operador. Un 400 no se arregla reintentando.
- **529 `overloaded_error`:** la API está sobrecargada para todos; reintentar con espera. **500 `api_error`** y **504 `timeout_error`:** reintentar con retroceso exponencial. 402 `billing_error`, 403, 404 y 413: no reintentar. La clase del SDK para 529 y 504 es `InternalServerError`; hay también `UnprocessableEntityError` (422).
- **`stop_reason`:** `refusal` llega con HTTP 200, se cobra y la salida puede no cumplir el esquema; `max_tokens` deja la salida cortada e inválida: reintentar con más `max_tokens` (DOC, salida estructurada). Ambos son `invalid_output` en el puerto. La lista completa de valores de `stop_reason` no se pudo leer en la referencia de la API: NO VERIFICADO (los dos que importan están confirmados).
- Un error puede llegar a mitad de un stream después de un 200. Sin streaming (lo previsto) no aplica. El SDK sube un error si prevé que una llamada sin streaming pasa de 10 minutos; con `max_tokens` de 4.096 no ocurre.
- Cuerpo de error: `{ "type": "error", "error": { "type", "message" }, "request_id" }`. Guardar `request_id` en el log.

### 11.6 Separar el gasto por corredor con una sola clave (DOC)

- **Workspaces:** hasta **100 por organización** (los archivados no cuentan). Cada workspace puede tener su **límite de gasto mensual** (con alertas en umbrales) y sus **límites de tasa** (solo más bajos que los de la organización); no se pueden poner límites en el workspace Default. Los **caches de prompt están aislados por workspace**.
- **Una sola clave para varios workspaces (DOC, autenticación):** una clave **personal o de cuenta de servicio** puede crearse con acceso a varios workspaces; en ese caso **cada solicitud debe llevar la cabecera `anthropic-workspace-id: wrkspc_...`** (sin ella, 400; con uno inexistente o sin acceso, 404). En el SDK: `client.messages.create(params, { headers: { "anthropic-workspace-id": id } })`, o `defaultHeaders` por cliente. Las claves de workspace (heredadas, ahora "legacy") son de un solo workspace. Es decir: **sí hay forma oficial** de usar una clave del operador y cargar el gasto de cada corredor a su propio workspace. Quién crea workspaces: solo un administrador de la organización.
- **Requisito:** la API de administración y los informes por workspace **no están disponibles para cuentas individuales**: hay que configurar una **organización** en la Console (Settings > Organization). Si la cuenta del operador es individual hoy: NO VERIFICADO (se ve en la Console); también NO VERIFICADO que las claves multi-workspace y las cuentas de servicio estén habilitadas en su plan.
- **Informes:** la API de uso (`/v1/organizations/usage_report/messages`) y la de costos (`/v1/organizations/cost_report`) aceptan `group_by[]=workspace_id` (la de uso también `api_key_id`, `model`, `service_tier`, `context_window`, `inference_geo`, `speed`), con granularidad de 1 min, 1 h o 1 día (costos: solo 1 día). Los datos aparecen en unos 5 minutos y se recomienda no consultar más de una vez por minuto. Se usan con una clave de administración (`sk-ant-admin01-...`) o equivalente, **no** con la de las llamadas normales. El workspace Default aparece con `workspace_id: null`. Los costos del nivel de prioridad no salen en la API de costos.
- **`metadata.user_id`:** campo opcional de la solicitud (hasta 512 caracteres): "un identificador externo del usuario asociado a la solicitud", que debe ser un UUID, un hash u otro identificador opaco, sin nombre, correo ni teléfono; Anthropic puede usarlo para detectar abuso. **No es una dimensión de facturación**: la API de uso no agrupa por él. Sirve para mandar el ID opaco del corredor y ayudar a Anthropic a aislar abusos sin culpar a toda la cuenta; no para repartir el gasto.
- **Recomendación (INFERENCIA):** el registro propio manda. Cada llamada guarda en la base los campos de 11.3 más `broker_id`, y el costo se calcula con la tabla de precios; es inmediato, no depende del plan ni de una clave de administración, y da el gasto "por corredor" y "por aviso". Los workspaces por corredor son el cinturón de seguridad opcional: tope de gasto propio por corredor y reconciliación contra el informe de costos de Anthropic. Se pueden sumar después sin cambiar el puerto (basta una cabecera por corredor).
- **Términos de uso (NO VERIFICADO en esta ronda):** no se leyeron los Términos Comerciales ni la política de uso para el caso "el operador revende o presta el sistema a corredores usando su clave". La sección 9 y `claude-code-cli.md` sección 9 dicen que, si un corredor usa el sistema, debe poner su propia clave; el operador decidió usar una sola clave propia. Antes de cobrar a terceros o de pasar a F8, revisar los términos (o escribir a soporte) para confirmar que se permite que un producto propio use una sola organización de Anthropic para atender a varios clientes finales.

### 11.7 Fuentes de esta ronda (consultadas el 2026-10-16)

- Modelos (ID, ventana, salida, retiro): https://platform.claude.com/docs/en/about-claude/models/overview
- Precios: https://platform.claude.com/docs/en/about-claude/pricing
- Límites de tasa, de gasto, cabeceras y workspaces: https://platform.claude.com/docs/en/api/rate-limits
- Errores de la API (401, 429, 529, razonamiento y pensamiento por modelo): https://platform.claude.com/docs/en/api/errors
- Salida estructurada (helper de zod, modelos, `refusal`, `max_tokens`, caché de gramática): https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- SDK de TypeScript (requisitos, reintentos, errores, `_request_id`, `.withResponse()`): https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript
- Caché de prompts (campos de `usage`, mínimos cacheables): https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Workspaces: https://platform.claude.com/docs/en/manage-claude/workspaces
- Autenticación (tipos de clave, cabecera `anthropic-workspace-id`, vencimiento de claves): https://platform.claude.com/docs/en/manage-claude/authentication
- API de uso y de costos: https://platform.claude.com/docs/en/manage-claude/usage-cost-api
- Campo `metadata.user_id` de la API de mensajes: https://platform.claude.com/docs/en/api/messages
- Registro de npm (manifiesto de 0.135.0, peer de zod): https://registry.npmjs.org/@anthropic-ai/sdk/latest
- Versiones y fechas: https://github.com/anthropics/anthropic-sdk-typescript/releases y https://raw.githubusercontent.com/anthropics/anthropic-sdk-typescript/main/CHANGELOG.md
- `minimumReleaseAge` de pnpm 11 (1440 minutos por defecto): https://pnpm.io/settings/dependency-resolution
