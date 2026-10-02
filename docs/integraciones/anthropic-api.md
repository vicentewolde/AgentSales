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

### 4.2 Forma del puerto `LLMProvider` (recomendación)

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
- Para el stub de F2: el adaptador `anthropic-api` lanza un error claro (`LLM_PROVIDER_NOT_IMPLEMENTED`) o se implementa completo con tests de contrato en msw (los cuerpos de la sección 4 son verificables sin red).
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
