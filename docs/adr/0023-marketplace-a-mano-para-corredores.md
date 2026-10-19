# ADR-0023 · Marketplace a mano para los corredores, y el formulario automático solo para los corredores propios del operador

- **Estado:** Aceptado (el punto 4 lo modifica ADR-0024 en producción)
- **Fecha:** 2026-10-16
- **Modifica a:** ADR-0017 (punto 1: la cuenta de Marketplace ya no es siempre un perfil del navegador)

## Contexto
- ADR-0017 publica Marketplace en dos tiempos: el worker abre Chromium en el Mac del operador con la sesión de Facebook del corredor guardada en un perfil, llena el formulario y el operador hace Siguiente y Publicar. Hay un límite diario y "un formulario a la vez" por cuenta (`requireManualCapacity`).
- Con corredores de terceros (spec F7), eso exigiría guardar la sesión de Facebook de cada corredor en el Mac del operador, y que el operador publique por él. El operador eligió (spec F7, D5) que el corredor publique él mismo con todo listo.
- El plan B de F5 (copiar título, descripción y precio, y abrir cada foto) ya existe en el panel.

## Decisión
1. **Cuenta a mano:** una `platform_account` de Marketplace con `external_account_id = "manual"`, sin credenciales ni perfil del navegador. `marketplaceAccountMetaSchema` es una unión discriminada por `mode`: `"profile"` (ADR-0017) o `"manual"`. La activa y la desactiva el administrador.
2. **Publicar a mano es un traspaso en core, sin publisher:** la publicación pasa a `awaiting_manual_confirm` (en simulación y en vivo, con el modo anotado) sin llamar a ningún publisher ni abrir el navegador. El corredor publica desde su teléfono o computador con el plan B y confirma con el enlace ("Lo publiqué") o "No lo publiqué", como en F5.
3. **Sin límite diario ni "un formulario a la vez"** para la cuenta a mano: no hay automatización ni perfil que proteger.
4. **El formulario automático solo para corredores propios** (`brokers.operator_owned`): la regla vive en core y cubre conectar la cuenta, `marketplace.profile` y `fb:smoke --listing` (`MARKETPLACE_AUTOMATION_NOT_ALLOWED`).
5. El calendario no cambia: Marketplace programado es un recordatorio (ADR-0018).

## Consecuencias
- La sesión de Facebook de un corredor nunca pasa por el Mac del operador, y el operador no publica en cuentas ajenas.
- Para el corredor, Marketplace es más trabajo que el formulario automático (copiar y subir las fotos él), pero no depende del Mac del operador: sirve igual cuando el sistema esté en internet (F8).
- Core distingue dos caminos de Marketplace por la cuenta, no por la plataforma.

## Alternativas descartadas
- **La sesión del corredor en el Mac del operador:** el operador manejaría cuentas de Facebook ajenas, con más riesgo ante Facebook; el operador la descartó (D5).
- **Un publisher "a mano" que no hace nada:** un publisher que no publica confunde el contrato `Publisher`; el traspaso de estado es de core.
- **Una plataforma nueva (`fb_marketplace_manual`):** duplica textos, revisión y seguimiento de un mismo canal.

## Seguimiento
- 2026-10-17 (F7-T15): implementado como se decidió. Precisiones: la cuenta a mano se reconoce por `meta.mode = "manual"` (`isManualMarketplaceAccount`), y una fila de F5 sin `mode` se lee como perfil; el progreso del traspaso lleva `byHand: true` y la vista `manual` lo expone (el panel y la CLI muestran el plan B como flujo principal en los lotes G y H); la regla del punto 4 también cubre **publicar** con una cuenta de perfil que quedó de antes (el intento falla con `MARKETPLACE_AUTOMATION_NOT_ALLOWED` sin abrir nada). Los corredores que existían antes de F7 quedaron propios (migración `0009`), así que el formulario automático del operador sigue igual.
- 2026-10-17 (revisión del lote F): al activar la cuenta a mano en un corredor con su perfil conectado, el perfil se borra del disco (`forget`, como desconectarlo); desconectar la cuenta a mano no pide confirmación ni borra perfiles; `fb:smoke` **sin** `--listing` también queda dentro de la regla (no abre el perfil de un corredor ajeno, así su sesión nunca pasa por el Mac del operador); la cuenta a mano se reconoce también por `external_account_id = "manual"`; el traspaso a mano revisa las reglas del formulario (`validateMarketplaceInput`, ahora en core) y pedir publicar con un perfil ajeno ya responde 403.
- 2026-10-17 (lote H): la regla del punto 4 es un predicado de core (`marketplaceAutomationAllowed`) que usan el panel (qué caja mostrar en Cuentas) y `assertMarketplaceAutomationAllowed`. Activar la cuenta a mano en el panel, para un corredor propio con su Facebook conectado, pide confirmar (se cierra esa sesión y se borra su perfil).
- 2026-10-18 (`/fase-plan 8`, ADR-0024): en producción todos los corredores, también los propios, publican Marketplace a mano; las cuentas de perfil que ya existen se pasan a mano con el botón de F7.
- 2026-10-19 (lote H, F8-T20, ADR-0024): en producción la regla del punto 4 se vuelve "nadie": el formulario automático no corre en el servidor, ni para un corredor propio (`assertMarketplaceAutomationAllowed(broker, automationEnabled)`, con `marketplaceAutomationEnabled` de config). Las cuentas de perfil que ya existen en la base se pasan a mano con el botón de F7 sin tocar el disco (no se encola el borrado del perfil), y desconectarlas ya no pide confirmar. En desarrollo todo sigue igual.
