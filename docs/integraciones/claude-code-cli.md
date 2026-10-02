# Claude Code CLI en modo no interactivo (`claude -p`)

Nota verificada el 2026-10-02. Responde cómo usar `claude -p` como subproceso del adaptador `claude-cli` (ADR-0003, F2): salida estructurada, imágenes, aislamiento, errores y términos.

Convención: **DOC** = lo dice la documentación oficial; **INFERENCIA** = deducido, sin confirmar; **NO VERIFICADO** = falta una prueba real (ver sección 8).

Limitación de esta verificación: solo se leyó documentación. No se ejecutó `claude --version` ni `claude -p --help` (el subagente no tenía terminal). La versión local declarada es **2.1.243**; varios flags de la doc son más nuevos (ver sección 3). Antes de codificar, correr `claude --version` y `claude --help` y contrastar con esta nota.

## 1. Resumen

- **Mecanismo:** subproceso `claude -p` con `--output-format json` y `--json-schema`. El resultado llega en un solo objeto JSON por stdout.
- **Madurez:** documentado y estable para texto y salida estructurada. Las imágenes por stdin (`stream-json`) solo están documentadas para el Agent SDK, no para la CLI cruda.
- **Riesgo medio:**
  - `--bare` **no sirve** con el plan Max (exige API key, ver sección 3).
  - Si `ANTHROPIC_API_KEY` está en el entorno, `-p` la usa y cobra a la API en vez de usar el plan.
  - Los límites de uso del plan se detectan solo por texto del mensaje (no hay campo dedicado documentado).

## 2. Requisitos de cuenta y app

- CLI instalada y con sesión de claude.ai (plan Pro o Max). `claude auth status` imprime JSON y sale con código 0 si hay sesión y 1 si no. El campo `authMethod` vale `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper` o `third_party`. Sirve para `agentsales doctor`. (DOC)
- Sin app ni revisión: es la CLI del propio operador. Sin costo extra; el uso descuenta del plan.
- Los límites de Pro y Max suponen "uso ordinario e individual de Claude Code y el Agent SDK" (DOC). Un lote grande de propiedades puede toparse con el límite de sesión o semanal.

## 3. Autenticación

- **Precedencia (DOC):** 1) credenciales de nube (Bedrock, Vertex, Foundry), 2) `ANTHROPIC_AUTH_TOKEN`, 3) `ANTHROPIC_API_KEY`, 4) `apiKeyHelper`, 5) `CLAUDE_CODE_OAUTH_TOKEN`, 6) perfiles Anthropic, 7) login de suscripción (`/login`). En modo `-p`, "the key is always used when present" para `ANTHROPIC_API_KEY`.
- **Consecuencia para AgentSales:** el adaptador `claude-cli` debe lanzar el subproceso con un entorno **sin** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` ni `CLAUDE_CODE_USE_*`. El `.env` de la app tendrá `ANTHROPIC_API_KEY` para el adaptador `anthropic-api`; si se hereda `process.env` completo, el costo se va a la API sin aviso. Verificar con una prueba de unidad que el `env` pasado al subproceso no contiene esas variables.
- **`--bare` y el plan Max (DOC):** "In bare mode, Claude Code never reads OAuth credentials or the system keychain" y "bare mode doesn't use your subscription login". También ignora `CLAUDE_CODE_OAUTH_TOKEN`. Exige `ANTHROPIC_API_KEY` o `apiKeyHelper`. **No usar `--bare` con el plan Max.** La doc dice que `--bare` "will become the default for `-p` in a future release": vigilar cuando eso pase, porque rompería el uso con el plan.
- **Token largo:** `claude setup-token` genera un token OAuth de un año para scripts (requiere plan de suscripción) y se pasa como `CLAUDE_CODE_OAUTH_TOKEN`. Útil si la sesión interactiva expira durante un lote. No funciona con `--bare`. (DOC)
- **Alternativas de aislamiento sin `--bare` (DOC):**
  - `--safe-mode`: desactiva CLAUDE.md, skills, plugins, hooks, MCP, comandos y agentes, memoria automática; mantiene autenticación, modelo, herramientas y permisos. La doc no indica desde qué versión existe; **verificado en local el 2026-10-02**: `claude -p --help` de la 2.1.243 lo lista, igual que `--tools`, `--disable-slash-commands`, `--setting-sources`, `--strict-mcp-config` y `--no-session-persistence`, y `claude auth` existe (para `doctor`). Falta la prueba de humo con una llamada real (spec F2, T04).
  - `--restricted`: requiere v2.1.248 o posterior, o sea **no está en 2.1.243**.
  - Si ninguno está disponible: lanzar con `cwd` en un directorio temporal vacío (no hereda el CLAUDE.md del proyecto) más los flags de la sección 4. Quedan activos el CLAUDE.md, los hooks y la memoria de usuario en `~/.claude` (INFERENCIA: por la doc de `--bare`, sin él se carga "anything configured in the working directory or `~/.claude`").
- **Sesión expirada:** el error es `Login expired · Please run /login` o `Not logged in · Please run /login`, devuelto en el campo `result` de stdout, no por stderr (DOC).

## 4. Operaciones

### 4.1 Invocación recomendada (a validar con la prueba de la sección 8)

```
claude -p --output-format json \
  --json-schema '<schema draft-07 en una línea>' \
  --system-prompt-file <prompt.txt> \
  --tools "" --disable-slash-commands --strict-mcp-config \
  --no-session-persistence --max-turns <N> --model sonnet
```

Agregar `--safe-mode` solo si `claude --help` lo lista en la versión instalada. `--system-prompt` (texto en línea) es equivalente a `--system-prompt-file`.

El prompt del usuario va por stdin (tope de 10 MB por stdin; error claro y código distinto de 0 si se excede) o como argumento. (DOC)

### 4.2 Salida estructurada con `--json-schema` (DOC)

- Con `--output-format json` y `--json-schema '<JSON Schema>'`, el objeto de salida trae el dato validado en **`structured_output`**. El texto libre queda en `result`.
- Esquema inválido: la CLI sale con `Error: --json-schema is not a valid JSON Schema` y el diagnóstico (desde v2.1.205; antes se ignoraba en silencio). Local 2.1.243 ya lo incluye.
- La palabra clave `format` se acepta como anotación y **no se valida** (`"format": "email"` no se exige).
- El validador usa **JSON Schema draft-07**; un esquema que declare una versión más nueva se rechaza. Con zod 4: `z.toJSONSchema(schema, { target: "draft-7" })`. (DOC, página del Agent SDK, que comparte motor con la CLI: INFERENCIA para la CLI.)
- Funciones de esquema soportadas: tipos básicos, `enum`, `const`, `required`, objetos anidados, `$ref`. Para "la lista completa de soportes y limitaciones" la doc remite a la página de structured outputs de la API: sin `minimum`/`maximum`, `minLength`/`maxLength`, esquemas recursivos ni `additionalProperties` distinto de `false` (DOC de la API; aplicar a la CLI es INFERENCIA). **Consecuencia:** los largos (título de 60 caracteres, caption de 2.200) no se pueden exigir en el esquema; se validan después con zod.
- **Si el modelo no cumple (DOC):** el SDK "re-prompts on mismatch" hasta un límite de reintentos. Si no logra salida válida, el resultado trae `subtype: "error_max_structured_output_retries"`, `is_error: true` y sin `structured_output`. Puede pasar también por un retroceso de modelo (fallback) que retira la salida; la lista `errors` distingue las causas. Un resultado con `subtype: "success"` pero sin `structured_output` también debe tratarse como fallo.
- **NO VERIFICADO:** si `--tools ""` deja disponible la herramienta interna con que se entrega `structured_output`, y si los reintentos de validación cuentan contra `--max-turns` (la doc dice que `max_turns` cuenta solo turnos con herramientas). Probar con un esquema trivial.

### 4.3 Sobre del resultado con `--output-format json`

La doc de la CLI lista `result`, `session_id`, `total_cost_usd`, el desglose de costo por modelo, `usage` y `structured_output`. Los campos completos salen de la referencia del Agent SDK (`ResultMessage`), que la CLI comparte (INFERENCIA que el JSON de la CLI trae todos; **NO VERIFICADO** con una salida real):

| Campo | Significado |
|---|---|
| `type` | `"result"` |
| `subtype` | `success`, `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries` |
| `is_error` | `true` si terminó en error |
| `result` | texto final, **o el mensaje de error de la API** (ej. "You've hit your session limit · resets 3:45pm") |
| `structured_output` | el dato validado (solo con `--json-schema`) |
| `total_cost_usd`, `usage`, `model_usage` | estimación del cliente, no facturación; con plan Max no se cobra |
| `num_turns`, `duration_ms`, `duration_api_ms` | métricas |
| `session_id` | id de sesión |
| `stop_reason` | `end_turn`, `max_tokens`, `refusal`… (revisar `refusal`) |
| `api_error_status` | HTTP del error que terminó la corrida (429, 529, 500…) |
| `terminal_reason` | `completed`, `max_turns`, `api_error`, `aborted_streaming`, `aborted_tools`… |
| `errors` | mensajes de error del bucle |
| `permission_denials` | llamadas a herramientas denegadas |

Los campos pueden variar con la versión de la CLI: el adaptador debe parsear con zod de forma tolerante (campos extra permitidos) y exigir solo `type`, `subtype`, `is_error`, `result` y `structured_output`.

### 4.4 Imágenes (fotos de una propiedad)

- **Opción A, documentada y recomendada: herramienta `Read` sobre un directorio temporal.**
  - `Read` devuelve PNG, JPG y otros formatos "as visual content that Claude can see"; la CLI las reduce y recomprime antes de enviarlas, y desde v2.1.196 una imagen que aún pese más de 500 KB tras el reajuste se recodifica como JPEG con menor calidad (DOC).
  - Lanzar con `cwd` = directorio temporal con las fotos ya redimensionadas, `--tools "Read"` (restringe a esa herramienta) y `--allowedTools "Read"`, y opcionalmente `--add-dir <tmp>` si el `cwd` es otro. En modo `dontAsk`, las lecturas dentro de los directorios de trabajo corren sin pedir permiso (DOC). Borrar el directorio al terminar.
  - El prompt lista los nombres de archivo. El esquema debe devolver un registro por archivo (por ejemplo `photo_order` con los ids), para detectar si el modelo omitió alguna foto: que lea todas depende del modelo (INFERENCIA).
  - Costo: expone `Read` y el sistema de archivos del directorio temporal al modelo. Riesgo bajo (solo lectura de fotos ya redimensionadas), pero hay que fijar `cwd` y no dar `--add-dir` sobre nada más.
- **Opción B, no verificada en la CLI cruda: `--input-format stream-json`.**
  - La doc del Agent SDK muestra que el mensaje de usuario acepta bloques de imagen en base64 (DOC): `{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"<base64>"}},{"type":"text","text":"..."}]},"parent_tool_use_id":null}`. Un bloque de imagen sin `source` no da error: Claude recibe una nota de texto en su lugar.
  - La doc dice que las imágenes requieren el **modo de entrada en streaming** (el modo de mensaje único no las admite).
  - Para la CLI cruda, el formato NDJSON por stdin **no está documentado** (issues abiertos anthropics/claude-code #24594 y #44911 lo reconocen). **NO VERIFICADO.** Lo usa el Agent SDK internamente. Requiere `--output-format stream-json --verbose`, y el resultado final es la última línea (`type: "result"`).
  - Ventaja: sin herramientas ni sistema de archivos. Desventaja: formato no contractual; puede cambiar sin aviso.
- **Opción C:** usar el paquete `@anthropic-ai/claude-agent-sdk`. Fuera del stack (CLAUDE.md regla 8) y la doc pide API key para productos de terceros. No recomendada para F2.
- **Tamaño de imágenes:** redimensionar antes (lado largo ≤ 1568 px da el mejor equilibrio; ver `anthropic-api.md`). Menos tokens, menos tiempo.

### 4.5 Aislamiento como subproceso (resumen de flags, DOC)

| Flag | Efecto |
|---|---|
| `--system-prompt` / `--system-prompt-file` | Reemplaza todo el prompt por defecto (pierde las guías de herramientas y seguridad de Claude Code; con `--tools ""` no importa). Con `--append-system-prompt` solo se agrega. |
| `--tools ""` | Desactiva todas las herramientas integradas. No afecta a las MCP (usar `--disallowedTools "mcp__*"`). Con `""` solo se quita `EndConversation` si no quedan MCP. |
| `--disallowedTools "*"` | Alternativa: quita todas las herramientas. |
| `--strict-mcp-config` | Solo usa MCP de `--mcp-config`; sin `--mcp-config`, ninguna (INFERENCIA). |
| `--disable-slash-commands` | Desactiva skills y comandos. |
| `--no-session-persistence` | No guarda la sesión en disco y no se puede reanudar. Solo con `-p`. |
| `--max-turns N` | Tope de turnos con herramientas; sale con error al alcanzarlo (`error_max_turns`). |
| `--max-budget-usd` | Tope de gasto estimado (solo `-p`); inútil con plan Max pero protege si se cuela una API key. |
| `--model` | Alias `sonnet`, `opus`, `haiku`, `fable`, o nombre completo (ej. `claude-sonnet-5`). |
| `--permission-mode` | `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. Sin herramientas, irrelevante; con `Read`, `dontAsk` evita prompts. Nunca `bypassPermissions`. |
| `--setting-sources` | Lista de fuentes (`user`, `project`, `local`). Valor vacío: NO VERIFICADO. |
| `--fallback-model` | Cambia de modelo si el principal está sobrecargado; puede retirar una salida estructurada ya hecha (ver 4.2). No usarlo en el adaptador. |

Cada llamada arranca un proceso nuevo: sin `--bare`, la carga de configuración añade latencia (INFERENCIA; la doc dice que `--bare` existe "to reduce startup time").

## 5. Medios

- Imágenes: se envían como archivos leídos por `Read` (opción A) o base64 por `stream-json` (opción B). `Read` reduce y recomprime las grandes (ver 4.4).
- Video: no enviar. Para análisis de video usar fotogramas extraídos con ffmpeg y tratarlos como fotos.
- stdin: tope de 10 MB. Un prompt con muchas fotos en base64 podría rozarlo; con la opción A no aplica.
- URL pública: no se exige (todo es local).

## 6. Límites

- **Cuota del plan (Max):** límites de sesión (ventana de horas), semanal y por modelo (Opus/Sonnet). Se informan solo cuando se alcanzan, en el mensaje de error. No hay endpoint ni campo para consultar el saldo (NO VERIFICADO; no aparece en la doc leída).
- **Reintentos internos (DOC):** la CLI reintenta sola errores transitorios (5xx, 429/529 temporales, conexiones caídas) hasta 10 veces con retroceso exponencial (`CLAUDE_CODE_MAX_RETRIES`, tope 15). `API_TIMEOUT_MS` por defecto 600000 (10 min).
- **Sin timeout global propio de la CLI** documentado: el adaptador debe imponer el suyo. SIGTERM termina con código 143 y deja el turno sin resultado; SIGINT termina el turno limpiamente (DOC). Recomendación: SIGINT primero y SIGTERM tras unos segundos.
- El `job` `content.prepare` de la cola debe tener un `timeout` mayor que ese plazo.

## 7. Errores comunes

Códigos de salida (DOC): 0 en éxito; distinto de 0 si la corrida falla. Flags inválidos: error en stderr antes de empezar. Fallos dentro de la corrida (por ejemplo sin autenticación): se imprimen como `result` en stdout. SIGTERM: 143. Los códigos numéricos concretos por tipo de error **no están documentados**: no depender del número, sino de `is_error`, `subtype`, `api_error_status` y del texto de `result`.

| Situación | Cómo se ve (DOC) | Reintentable |
|---|---|---|
| No autenticado | `result`: `Not logged in · Please run /login` o `Authentication required · Sign in again to continue`; `is_error: true` | No. Avisar al operador; `doctor` lo detecta con `claude auth status` |
| Sesión vencida | `Login expired · Please run /login` | No |
| Límite de sesión/semanal/de modelo | `You've hit your session limit · resets 3:45pm`, `...weekly limit · resets Mon 12:00am`, `...Opus limit`, `...Sonnet limit` | **Sí, más tarde** (esperar al reinicio indicado). Distinguir con coincidencia de texto `You've hit your` y `limit`; sin campo dedicado |
| Límite de gasto mensual / créditos | `You've hit your monthly spend limit...`, `Credit balance is too low` | No hasta que el operador actúe |
| Rate limit | `API Error: Request rejected (429)...`; `api_error_status: 429` | Sí, con retroceso (la CLI ya reintentó) |
| Sobrecarga | `API Error: Repeated 529 Overloaded errors...`; `api_error_status: 529` | Sí |
| Error de servidor | `API Error: 500 Internal server error...` | Sí |
| Corte a mitad de respuesta | `API Error: Connection lost mid-response. The response above may be incomplete.` | Sí (nueva llamada) |
| Timeout | `Request timed out` o `API Error: No response from API (waited 3m, then 10m on the retry)...` | Sí, una vez |
| Esquema que el modelo no cumple | `subtype: error_max_structured_output_retries` | No con el mismo prompt; la política de F2 (reintentar una vez con el error en el prompt) es de la app |
| Salida truncada | `stop_reason: max_tokens` | No con el mismo prompt |
| Rechazo del modelo | `stop_reason: refusal` | No |
| Se alcanzó `--max-turns` | `subtype: error_max_turns` | No |
| Esquema `--json-schema` inválido | stderr: `Error: --json-schema is not a valid JSON Schema`; sale antes de correr | No: bug nuestro |

## 8. Cómo probar sin riesgo

- **Tests automáticos:** el adaptador recibe el ejecutor de procesos por inyección y los tests usan un ejecutable falso que imprime JSON de ejemplo de cada fila de la sección 7 (regla de CLAUDE.md: ningún test llama al modelo real).
- **Prueba de humo manual, una sola vez (consume cuota del plan, unos pocos mensajes cortos; la ejecuta el operador o quien implemente, con aprobación explícita):**
  1. `claude --version` y `claude --help | grep -E "safe-mode|restricted|bare|json-schema"`: confirma qué flags existen en 2.1.243.
  2. `claude auth status`: debe decir `authMethod: claude.ai`.
  3. Llamada trivial con `--json-schema` y `--tools ""` (por ejemplo "responde {ok:true}") para fijar el sobre real, la presencia de `structured_output` y si `--tools ""` lo permite.
  4. Llamada con 2 fotos de prueba (no de clientes) por la opción A, y por la B si se quiere evaluar.
  5. Con `ANTHROPIC_API_KEY` ausente del entorno, confirmar que no hay cobro a la API (revisar la columna de costo en el panel de uso del plan).
- **Modo desarrollo:** no existe sandbox; es el plan real. `LLM_PROVIDER=fake` para el desarrollo diario.

## 9. Riesgos y términos de uso relevantes

- **Términos (DOC, vigentes al 2026-10-02, sin cambios respecto de ADR-0003):** la autenticación OAuth "is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications". Quienes construyen productos o servicios, incluido el Agent SDK, "should use API key authentication". "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users". Tampoco se pueden recolectar ni guardar credenciales o tokens de claude.ai. Anthropic puede aplicar estas restricciones sin aviso.
- **Uso propio:** correr `claude -p` localmente con la propia sesión del operador, para sus propios avisos, es el uso ordinario permitido. Cuando el sistema lo use un corredor, `LLM_PROVIDER` debe ser `anthropic-api` (ADR-0003). Los costos de la API los pagaría quien use el sistema, no se pueden absorber con el plan del operador ("Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf").
- **Uso intensivo:** un lote grande puede agotar el límite de sesión del plan y bloquear también el uso interactivo del operador durante horas.
- **Contenido de los términos:** los Consumer Terms aplican a Pro y Max; no se leyeron completos en esta consulta.
- **Datos personales:** las fotos y datos del aviso viajan a Anthropic. Evitar fotos con personas identificables o documentos si el corredor no lo ha consentido.
- **Cambios futuros:** `--bare` pasará a ser el predeterminado de `-p` y rompería el uso con el plan; `--safe-mode`, `--restricted` y los flags de aislamiento cambian entre versiones. Fijar la versión mínima de la CLI en `doctor`.

## 10. Fuentes (consultadas el 2026-10-02)

- Ejecutar Claude Code programáticamente (`-p`, `--bare`, `--output-format`, `--json-schema`, SIGTERM, stdin 10 MB): https://code.claude.com/docs/en/headless
- Referencia de la CLI (flags, `claude auth status`, `--safe-mode`, `--restricted`): https://code.claude.com/docs/en/cli-reference
- Autenticación (precedencia, `setup-token`): https://code.claude.com/docs/en/authentication
- Salida estructurada (subtypes, draft-07, `format`): https://code.claude.com/docs/en/agent-sdk/structured-outputs
- Entrada en streaming (imágenes base64): https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
- Bucle del agente (subtypes de resultado, `stop_reason`, `max_turns`): https://code.claude.com/docs/en/agent-sdk/agent-loop
- Referencia Python, `ResultMessage` (lista de campos): https://code.claude.com/docs/en/agent-sdk/python
- Costos y uso (`total_cost_usd` es estimación): https://code.claude.com/docs/en/agent-sdk/cost-tracking
- Errores y mensajes de `-p`: https://code.claude.com/docs/en/errors
- Herramientas, comportamiento de `Read` con imágenes: https://code.claude.com/docs/en/tools-reference
- Legal y cumplimiento (autenticación y uso de credenciales): https://code.claude.com/docs/en/legal-and-compliance
- Pista no oficial (formato `stream-json` de entrada sin documentar): https://github.com/anthropics/claude-code/issues/24594 y https://github.com/anthropics/claude-code/issues/44911
