# ADR-0004 · Marketplace semiautomático con clic final humano

- **Estado:** Aceptado
- **Fecha:** 2026-09-28

## Contexto
Facebook Marketplace no ofrece API pública para que particulares publiquen avisos en Chile. Automatizar el navegador por completo arriesga el bloqueo de la cuenta del corredor, y es frágil ante cambios del sitio.

## Decisión
- Playwright con un **perfil persistente por corredor**, con login manual una vez; el sistema no guarda contraseñas.
- El sistema llena el formulario y sube las fotos; **el operador hace el clic de publicar**.
- Estado intermedio `awaiting_manual_confirm`.
- Salvaguardas:
  - Límite diario configurable y pausas aleatorias.
  - Selectores en un solo módulo.
  - Captura de pantalla ante error.
  - Detención inmediata ante captcha o verificación, sin intentar evadirla.

## Consecuencias
- Ahorra el 90 % del trabajo manual con riesgo acotado.
- Requiere presencia del operador, así que Marketplace no participa del calendario automático (F6) salvo como recordatorio.
- Si Meta publica una API aplicable, este ADR se reemplaza.

## Alternativas descartadas
- **Automatización total:** alto riesgo de bloqueo y posible incumplimiento de términos.
- **Solo generar el texto para copiar y pegar:** seguro, pero ahorra poco. Queda como plan B si el flujo semiautomático falla.
