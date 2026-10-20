# ADR-0033 · Los leads se atribuyen al anuncio, al aviso y a la oficina; ManyChat convive

- **Estado:** Propuesto (borrador del piloto, F10; se aprueba con su spec)
- **Fecha:** 2026-10-19
- **Reemplaza a / Modifica a:** — (extiende ADR-0027 para el borrado de datos personales; `docs/00-vision.md` deja fuera los leads del MVP)

## Contexto
La corredora del piloto usa ManyChat (comentario → mensaje directo, captura de leads) y quiere empezar con Meta Ads. Un anuncio que lleva a un mensaje o a un formulario genera **leads**: datos personales de terceros. Interesa saber de qué anuncio, aviso y oficina vino cada uno (`docs/integraciones/manychat.md`).

La API de ManyChat es limitada: no crea flujos ni disparadores de comentarios, no expone el `ad_id` y solo avisa a sistemas externos con un «External Request» (plan Pro o superior). Construir una mensajería propia (comentario → mensaje directo, flujos, bandeja) exigiría la Instagram Messaging API, App Review y mantenimiento continuo, sin que la corredora lo haya pedido.

## Decisión
1. **ManyChat convive.** Atiende las conversaciones. AgentSales crea el anuncio (conoce su `ad_id`), genera por aviso una palabra clave y un `ref` único por campaña, y recibe los leads por un webhook propio.
2. **Una interfaz propia, `LeadSource`**, con ManyChat como primer adaptador (y el formulario instantáneo de Meta como otro, después), para poder reemplazarlo si se cumple alguna condición: ManyChat bloquea algo clave, hay más de una corredora, o ya se pasó la revisión de Tech Provider por los anuncios y sumar mensajería sale más barato.
3. **Tablas:** `leads` (corredor, sujeto opcional, `ad_id` y campaña opcionales, `source`, un único `(source, external_id)` para idempotencia, nombre, teléfono y correo **cifrados**, `consent` jsonb, estado, usuario asignado, `erased_at`) y `lead_events`. La atribución es `ad_id → campaña → sujeto → corredor`; el agente se suma en la fase de organizaciones.
4. **Webhooks:** rutas públicas en la tabla de permisos (ADR-0022); la firma de Meta con `X-Hub-Signature-256` y la de ManyChat con un secreto por corredor guardado con hash. La API solo guarda el id y encola `lead.fetch`; pedir los datos con el token lo hace el worker.
5. **Datos personales (Ley 21.719, vigente desde 2026-12-01 salvo postergación):** la corredora es la responsable y AgentSales la encargada; hace falta un contrato de encargo, un plazo de retención y `eraseLead`, que deja nulos los datos personales y conserva los conteos (precedente: ADR-0027). Aviso de privacidad y base de licitud por escrito; un abogado los revisa antes del primer lead real.
6. **CRM mínimo:** lista, estado, asignación, exportar CSV y un aviso por correo. Sin conversaciones. Quedan fuera los flujos de ManyChat, el comentario → mensaje directo y la Instagram Messaging API.

## Consecuencias
- Se aprovecha lo que la corredora ya paga y sabe usar, y no se pide reemplazar algo que funciona.
- Depende del plan Pro de ManyChat y de una API que no publica límites oficiales que hayamos podido leer (NO VERIFICADO), y de que el lead llegue con el `ref` o la etiqueta del anuncio.
- Que dos apps (ManyChat y AgentSales) puedan estar suscritas a los mensajes de una misma cuenta es NO VERIFICADO.
- Se guardan datos personales de terceros: cifrado, retención y borrado son parte del producto, no un extra.

## Alternativas descartadas
- **Construir el ManyChat propio desde el piloto:** revisión de Meta para mensajería, riesgo de restringir la cuenta de la corredora si falla, un editor de flujos que es todo el producto de ManyChat y un costo de cambio para el cliente.
- **Dejarlo totalmente aparte:** se pierde la atribución por aviso y oficina, que es parte del valor.
- **Un CRM completo:** fuera del alcance; se reenvía a su CRM si lo tienen.

## Seguimiento (opcional)
