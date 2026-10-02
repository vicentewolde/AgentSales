# ADR-0013 · Textos híbridos: los datos los pone el código y la IA redacta; prompts en core

- **Estado:** Aceptado
- **Fecha:** 2026-10-02
- **Modifica a:** ADR-0003 (dónde viven los prompts) y `docs/04-formato-publicaciones.md` (salida de la IA)

## Contexto
- La primera regla editorial es "solo datos entregados": nada de metros, distancias ni amenities inventados (`04-formato-publicaciones.md`). El precio tiene formato chileno estricto (`UF 5.800`, `$650.000/mes`), y la dirección no puede aparecer si `show_exact_address = false`.
- `04-formato-publicaciones.md` pedía a la IA el caption completo, el título y la descripción de cada canal. Así, cada precio, superficie y número de contacto depende de que el modelo lo copie bien.
- `01-arquitectura.md` dejaba los prompts en `packages/llm/prompts/`, separados del esquema de salida (en core) y de las reglas que los revisan.
- Mercado Libre pide títulos de inmuebles de hasta 60 caracteres, sin abreviaturas ni adjetivos (`docs/integraciones/mercadolibre.md`, por confirmar en F4).

## Decisión
1. **Ensamblado híbrido.** El código arma todo lo que es dato: la línea de tipo y comuna, la línea de superficies y dormitorios, el precio y los gastos comunes, las listas de características y espacios comunes, la disponibilidad, el contacto, los títulos y los hashtags base. La IA redacta solo frases: el gancho y el cuerpo del caption, la presentación, el entorno y las condiciones de Portal, la introducción de Marketplace, y hashtags adicionales.
2. **Lo que ve la IA es un brief armado en core** (`buildContentBrief`): sin `internal_notes`, sin columnas desconocidas, sin links ni contacto, y sin dirección ni número de unidad si `show_exact_address = false`. Sin fotos.
3. **Una revisión editorial en core** (`checkContent`) corre sobre el texto final, también después de una edición manual: números que no están en los datos, dirección expuesta, notas internas, requisitos discriminatorios, emojis en Portal, largos, amenities no entregados, superlativos, markdown y cantidad de hashtags.
4. **Prompt, esquema de salida, ensamblado y revisión viven juntos en `packages/core/src/content/`** con una sola versión (`CONTENT_PROMPT_VERSION`, que se guarda en `contents.prompt_version`). `packages/llm` es solo transporte: recibe `system`, `prompt` y el JSON Schema sin topes que genera core, y devuelve `{ data: unknown, model }`; core valida con el esquema zod estricto y reintenta una vez si no calza.
5. La salida de la IA y el ensamblado de cada canal se documentan en `04-formato-publicaciones.md` (en el PR del spec F2; F2-T05 lo contrasta con lo implementado).

## Consecuencias
- El precio, las superficies, el contacto y la dirección no dependen del modelo: se cumplen por construcción y se prueban con tests puros.
- La IA tiene menos que escribir: respuestas más cortas, menos cuota del plan y menos espacio para inventar. La revisión editorial cubre lo que sí redacta.
- Los textos se parecen más entre propiedades (las partes fijas son plantillas). Si el operador lo nota, se ajustan las plantillas o el prompt con una versión nueva.
- Cambiar de proveedor (`claude-cli` → `anthropic-api` en F7) no toca el prompt.
- `core` crece con el módulo de contenido, que es puro y no agrega dependencias.

## Alternativas descartadas
- **La IA escribe el texto completo** (como decía `04`): cada dato pasa por el modelo y solo una revisión posterior detecta un error; un precio mal copiado es el peor error posible en un aviso.
- **Plantillas sin IA:** cumplen las reglas, pero sin gancho ni redacción adaptada al tono del corredor, que es lo que la fase promete.
- **Prompts en `packages/llm/prompts/`:** el prompt, el esquema y las reglas que lo revisan cambiarían por separado, y la versión registrada no describiría todo lo que produjo el texto.
