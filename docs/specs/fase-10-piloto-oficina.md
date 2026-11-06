# F10 · Piloto con una oficina

- **Estado:** Borrador del 2026-11-06. Lote 1 (T01 a T03: leads con atribución en core y base) fusionado (#261). Lote 2 (T04 y T05: webhook de ManyChat, API y CLI de leads; migración 0024) en `feat/f10-t04-t05-manychat-api-leads`. Lo demás está especificado y sin empezar.
- **Base de diseño:** ADR-0031 (anuncios son un agregado propio), ADR-0032 (dos aprobaciones y tres topes de gasto), ADR-0033 (leads con atribución, ManyChat convive), todos *propuestos*; se aprueban con este spec. `docs/00-vision.md` y `docs/13-propuesta-hoja-de-ruta-2.md` (borrador) dan el contexto.
- **Orden pedido por el operador (2026-11-06):** primero el lote 2 de F12, después F10.

## 1. Objetivo
Que una oficina (3 a 10 agentes) de una corredora grande use AgentSales de punta a punta: publicar, **recibir leads con atribución** (de qué aviso, anuncio y oficina vino cada uno) y, después, **impulsar** publicaciones con anuncios de Meta, siempre con aprobación humana y topes de gasto.

## 2. Alcance
**Entra:** leads (entrada idempotente, consentimiento, cifrado, estados, asignación, borrado, exportar CSV), webhook de ManyChat, panel y CLI de leads, anuncios de Meta (impulsar un post y campañas por aviso, pausados al crear), reporte de gasto, TikTok público y con fotos.
**No entra:** conversaciones (flujos, comentario → mensaje directo, bandeja), formularios instantáneos de Meta (después), cobro de anuncios (la corredora paga a Meta directo).

## 3. Reglas que no se negocian
- **Datos personales:** sin consentimiento no se guarda el lead; nombre, teléfono y correo van cifrados (con el id del lead como dato asociado) y `eraseLead` los deja nulos conservando atribución y conteos (precedente: ADR-0027). El CSV neutraliza fórmulas de planilla. Un abogado revisa el aviso de privacidad y el contrato de encargo antes del primer lead real (Ley 21.719, vigente desde 2026-12-01 salvo postergación: **a confirmar**).
- **Dinero:** un anuncio nace pausado; dos aprobaciones (texto y gasto) y tres topes (diario, por campaña y por mes) antes de activarse. Nada gasta sin instrucción del operador en el chat. En `dry-run` los anuncios se arman y se validan, no se crean.
- **Atribución sin cruzar corredores:** un lead solo se asocia a una propiedad del mismo corredor.

## 4. Tareas

| Id | Qué | Lote |
|---|---|---|
| F10-T01 | Dominio de leads en core: `receiveLead` (idempotente, con consentimiento y contacto obligatorios, propiedad del mismo corredor), `changeLeadStatus` (transiciones), `eraseLead`, `leadsToCsv` | 1 ✅ |
| F10-T02 | Tablas `leads` y `lead_events` (migración 0023) y su repositorio con datos personales cifrados; se borran con el corredor | 1 ✅ |
| F10-T03 | Pruebas: repositorio sobre PGlite, purga del corredor y esquema | 1 ✅ |
| F10-T04 | Adaptador de ManyChat: payload del «External Request» validado con zod (`manychatPayloadSchema`, `manychatToLead`), secreto por corredor guardado con hash (`lead_webhook_keys`, migración 0024), `POST /webhooks/manychat/:brokerId` pública en la tabla de permisos (ADR-0022) | 2 ✅ |
| F10-T05 | API (`/brokers/:id/leads`, `leads.csv`, `webhook-secret`; `/leads/:id`, estado, asignar, borrar; permiso `leads.manage`) y CLI (`leads list|show|status|assign|erase|export|webhook-secret`). **Lo pendiente de leads en `cli agenda` pasa al lote 3 con el panel (T06):** los ítems de la agenda son publicaciones y cada clase tiene su texto en la CLI y en el panel | 2 ✅ |
| F10-T06 | Panel: página Leads (lista con filtro de estado, pasar de estado, borrar datos con pregunta, exportar CSV y generar el secreto del webhook, que se muestra una vez) | 3 ✅ |
| F10-T06b | Pendiente, con decisión del operador: aviso por correo al llegar un lead (el proyecto no tiene servicio de correo: hay que elegir uno, un ADR y una dependencia) y leads nuevos en `cli agenda` y en «Hoy» | 3 |
| F10-T07 | Anuncios de Meta: agregado `Ad`, estados, dos aprobaciones, tres topes, creación pausada (ADR-0031/0032); segunda app de Meta (Facebook Login for Business) | 4 |
| F10-T08 | Reporte de gasto y de leads por anuncio, aviso y oficina | 4 |
| F10-T09 | TikTok público y con fotos (auditoría de la app) | 5 |
| F10-T10 | Cierre: criterios, ensayo con la oficina, changelog y tag | 5 |

## 5. Criterios de aceptación
1. El mismo lead enviado dos veces queda una vez; sin consentimiento o sin contacto, no se guarda.
2. En la base no hay nombre, teléfono ni correo legibles; tras `eraseLead` no queda ninguno y sí la atribución.
3. Un lead no se atribuye a una propiedad de otro corredor.
4. Un anuncio no se activa sin las dos aprobaciones ni por encima de los topes.
5. `pnpm check` en verde; nada llama a Meta ni a ManyChat en las pruebas.

## 6. Dependencias y bloqueos del operador
- Plan **Pro** de ManyChat para el «External Request» (ADR-0033; NO VERIFICADO el límite de la API).
- App Review de Meta para anuncios y para la segunda app (`docs/11-app-review-meta.md`).
- Contrato de encargo y aviso de privacidad revisados por un abogado.
- Una oficina piloto dispuesta (ver `docs/15-precios-y-paquetes.md`: el piloto es gratis a cambio de un caso de éxito).

## 7. Cambios
- 2026-11-06: lote 3 (T06). Página `/leads` en el panel y en el menú. La lista del panel aún no filtra por propiedad (la API sí: `?listing=`). El aviso por correo y la agenda quedan en T06b.
- 2026-11-06: lote 2 (T04 y T05). Decisiones: el cuerpo del «External Request» lo definimos nosotros (`subscriber_id`, datos de contacto, `listing_id`, `ad_id`, `campaña`, `consent`); su forma real en ManyChat **no está verificada** y se prueba con el plan Pro en el ensayo de la oficina. Sin `consent: true` no se guarda. El secreto va en la cabecera `x-agentsales-secret`; un corredor que no existe, uno sin secreto y un secreto malo responden igual (401). No se agregó el puerto `LeadSource` como interfaz: con un solo origen sería una capa vacía; el formulario instantáneo de Meta lo introduce cuando exista.
- 2026-11-06: borrador y lote 1 (T01 a T03).
