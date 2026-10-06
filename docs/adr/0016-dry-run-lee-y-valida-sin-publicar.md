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
