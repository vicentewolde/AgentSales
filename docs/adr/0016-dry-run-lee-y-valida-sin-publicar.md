# ADR-0016 · En `dry-run`, un publisher puede leer de la plataforma y validar sin publicar

- **Estado:** Aceptado
- **Fecha:** 2026-10-06
- **Modifica a:** `docs/01-arquitectura.md` (`withDryRun`: "nunca llama a la plataforma") y el contrato de `Publisher` (ADR-0014, ADR-0015)

## Contexto
- En F3, `dry-run` valida en local y registra lo que se habría enviado, sin llamar a Instagram (`withDryRun`).
- Mercado Libre no tiene sandbox, y publicar un inmueble gasta un cupo de un paquete pagado (`docs/integraciones/mercadolibre.md` §2 y §8). Ofrece `POST /items/validate`, que revisa el cuerpo completo (categoría, atributos, moneda, ubicación, contacto, título) y responde `204` sin crear nada.
- Los obligatorios de cada categoría y sus límites solo se conocen leyendo la API con el token.
- Sin estas lecturas, los errores de Mercado Libre aparecerían recién en la prueba en `live`, que en F4 usa la cuenta real del operador (spec F4, D6).
- El operador lo autorizó el 2026-10-06 (spec F4, D2).

## Decisión
- Un publisher puede declarar `preflight(input, ctx)`. `withDryRun` lo llama después de `checkPublishInput`, cuando la publicación es de `dry-run`.
- En `preflight` se permite **solo**: leer de la plataforma (catálogo, estado), refrescar el token de la cuenta (ADR-0015) y llamar a endpoints de validación que la plataforma documenta como sin efectos (`POST /items/validate`).
- **Nunca** en `dry-run`: crear o modificar algo en la plataforma, subir archivos, cambiar estados, ni gastar cupos.
- Un error de la plataforma en `preflight` se trata como en `live`: un rechazo deja la publicación `failed` con los motivos, y una caída es reintentable.
- Instagram no declara `preflight`: su `dry-run` sigue sin llamar a Meta.
- Los tests nunca llaman a la plataforma real (msw), como siempre.

## Consecuencias
- La simulación de Portal dice si Mercado Libre aceptaría el aviso sin gastar cupo. Es la única forma de saberlo antes de pagar.
- `dry-run` deja de significar "sin red" para Portal: necesita la cuenta conectada y que Mercado Libre responda. Sin cuenta, la simulación falla como en `live` (`ACCOUNT_NOT_CONNECTED`).
- Refrescar el token en `dry-run` escribe en la base (el par nuevo) y rota el `refresh_token` real. Es lo mismo que hace `tokens.refresh`.
- Cada publisher nuevo debe revisar qué endpoints son de verdad sin efectos antes de usarlos en `preflight`. Un test con msw verifica que `preflight` no llama a endpoints que escriben.

## Alternativas descartadas
- **`dry-run` sin conexión, como en Instagram:** los errores de Mercado Libre aparecerían recién al pagar el cupo.
- **Validar solo en un script del operador (`ml:smoke`):** sirve una vez, pero no revisa cada aviso que se aprueba.
- **Un tercer modo (`validate`) además de `dry-run` y `live`:** suma un valor a `PUBLISH_MODE` y a cada publicación para algo que cabe en `dry-run`.

## Seguimiento
- 2026-10-07 (revisión de F4-T05, `arquitecto`): el rechazo de `POST /items/validate` vuelve del cliente como resultado (`valid: false` con `issues` de código y motivo), no como error; `preflight` lo devuelve como `{ ok: false, issues }` y `withDryRun` lo convierte en `PUBLISH_INPUT_INVALID` con los motivos (la publicación queda `failed`, como en `live`). Las advertencias van a la bitácora con `notes` en `{ ok: true }` (T13). Una caída o un token rechazado se lanzan como en `live` (reintentable o la cuenta vencida).
- 2026-10-08 (F4-T10, `ml:smoke` con la cuenta real): `POST /items/validate` **exige un paquete con cupo**. Con la cuenta sin paquetes respondió 402 sin causas a todas las variantes del aviso, y solo revisó el título (un título largo dio 400 con su causa). Así que, sin paquete, la simulación no dice si Mercado Libre aceptaría el aviso, y lo que dice "Contexto" ("revisa el cuerpo completo") vale solo con cupo. El cliente trata un 402 sin causas que bloqueen como `ML_NO_QUOTA` (no reintentable; que sea el cupo es inferencia hasta T23). Hoy un `ML_NO_QUOTA` en `preflight` deja la publicación `failed`, como en `live`. Qué hacer sin paquete lo decide el operador antes de T15 (D14 del spec F4): contratar el paquete antes de la demo en simulación (no cambia este ADR), o tratar `ML_NO_QUOTA` como advertencia solo en `preflight` (lo traduce el publisher a `{ ok: true, notes }`; en `live` sigue siendo un error). La segunda va como un seguimiento aquí, con el OK del operador; no hace falta un ADR nuevo, porque no cambia lo permitido.
- 2026-10-08 (respuesta del operador, D14 del spec F4): no se paga el paquete, así que en `dry-run` un `ML_NO_QUOTA` en `preflight` **no** deja la publicación `failed`: el publisher de Portal lo devuelve como `{ ok: true, notes }` con la advertencia de que Mercado Libre no revisó el aviso, y la simulación pasa con las revisiones de AgentSales. Vale solo en `preflight`; en `live`, `ML_NO_QUOTA` sigue siendo un error no reintentable. No cambia lo permitido (sigue sin escribir ni gastar cupo). La validación completa llega con el usuario de prueba de D15.
