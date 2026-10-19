# ADR-0032 · El gasto en anuncios tiene dos aprobaciones y tres topes

- **Estado:** Propuesto (borrador del piloto, F10; se aprueba con su spec)
- **Fecha:** 2026-10-19
- **Reemplaza a / Modifica a:** — (extiende ADR-0031; sigue el modelo de tope de ADR-0019 y `llm-budget`)

## Contexto
Un anuncio gasta dinero real de la corredora. Aprobar el texto de una publicación (ADR-0014) no es aprobar un gasto. En una franquicia el gasto lo aprueban distintos niveles, y el mercado casi no ofrece tope de gasto ni aprobación por nivel con auditoría: es el hueco que AgentSales puede cubrir (`docs/integraciones/meta-ads.md`, sección de mercado).

La corredora paga a Meta directo con su tarjeta o su medio manual en pesos, en su propia cuenta publicitaria. AgentSales no cobra ni recibe dinero de anuncios (`docs/00-vision.md`: sin cobro por ahora); su ingreso es una suscripción por oficina o agente.

## Decisión
1. **Dos aprobaciones distintas.** El texto: `contents.approved`, sin cambios. El gasto: una fila en `ad_approvals` (campaña, monto, fechas, usuario, rol o nivel, fecha). Subir el monto o alargar las fechas exige otra aprobación; bajarlo, no. Ningún `auto_publish` activa gasto.
2. **Estados:** `proposed → approved → creating → paused ⇄ active → completed`, además de `rejected` (Meta), `failed`, `cancelled` y `outcome_unknown`. El estado de Meta va aparte, en `remote_state`.
3. **Tres topes:**
   1. `lifetime_budget` con `end_time` obligatorio en el piloto, para que el máximo quede fijo en Meta.
   2. Un tope mensual por nodo en AgentSales que suma lo **comprometido** (aprobado y no terminado) más lo gastado, revisado al aprobar y otra vez al activar; sin la tolerancia de `assertLlmBudget`.
   3. El `spend_cap` de la cuenta publicitaria, que fija el operador a mano (admite solo 10 cambios al día: no se automatiza).
4. **Seguro por defecto:** todo anuncio nace `PAUSED`; activar pide confirmación explícita y la instrucción del operador en el chat cuando lo ejecuta Claude; un job cada hora lee los insights y **pausa solo** lo que pase su tope. Pausar es la dirección segura; activar nunca es automático. Cerrar una propiedad (ADR-0019) pausa sus anuncios.
5. **Montos** en enteros, en unidades mínimas de la moneda de la cuenta (`amount_minor`, `currency`); la conversión a USD es solo para reportes, con la tasa y su fecha guardadas. El IVA del 19% va como estimado aparte.
6. **Auditoría:** `ad_events` inmutable con quién aprobó, cuánto, qué se envió (sin token) y cada cambio de estado; `ad_spend_daily` por anuncio y día.
7. `CLAUDE.md` suma la regla: nunca activar un anuncio ni subir un presupuesto sin instrucción explícita del operador en el chat.

## Consecuencias
- La aprobación por niveles de la fase de organizaciones es sumar filas de `ad_approvals` y una política por nodo; hoy `AccessScope` es solo todo o un corredor (`access.ts`), y cambiarlo es de esa fase.
- El tope por nodo depende de los insights de Meta (15 minutos de refresco, 28 días hasta fijarse): puede pasarse un poco entre lecturas, por eso el tope 1 es el que protege.
- El piloto no necesita facturar nada de anuncios; sí necesita un contrato claro con la corredora sobre quién responde si Meta inhabilita una cuenta.

## Alternativas descartadas
- **Cobrar un porcentaje del gasto:** el dinero pasaría por AgentSales (facturación, IVA, responsabilidad por errores), tiene un incentivo contrario al cliente y se ve más caro cuando el gasto sube frente a los competidores de precio plano.
- **Solo el `spend_cap` de Meta:** protege la cuenta pero no distingue oficina, agente ni aviso, ni deja auditoría de quién aprobó.
- **Una sola aprobación para texto y gasto:** un cambio de monto pasaría sin que nadie lo vea.

## Seguimiento (opcional)
