# ADR-0027 · Borrado de datos a pedido de Meta: qué se borra, en una transacción, y la única edición de la bitácora

- **Estado:** Aceptado
- **Fecha:** 2026-10-18
- **Modifica a:** la regla "`publication_events` es inmutable" (`docs/02-modelo-datos.md`), con una sola excepción

## Contexto
- Meta exige una vuelta de borrado de datos para el App Review (spec F8 §4.11, D18; nota de Instagram §13.4): un `POST` firmado con el `user_id` de Instagram, que debe iniciar el borrado y responder `{ url, confirmation_code }`. Los Platform Terms (3.d.i) piden borrar "de manera inmediata" los datos de la plataforma cuando Meta o el usuario lo piden.
- Los datos de Instagram de una cuenta están repartidos: la cuenta (`platform_accounts`: id, nombre, `meta`, el token), sus publicaciones (`external_id`, `external_url`, y en `progress` los ids de los contenedores) y la bitácora (cada `publish_attempt` guarda en lo enviado el nombre de la cuenta).
- Core no tiene un puerto de transacción entre agregados; cada repositorio maneja su tabla (salvo el candado por aviso, `ListingLock`).
- El código que se devuelve a Meta debe significar "ya borrado": un borrado a medias con un código emitido sería falso.
- La misma política servirá para un borrado por correo o para Mercado Libre.

## Decisión
1. **Qué se borra:** de cada cuenta de Instagram de ese `user_id` (en cualquier corredor), el token, el id externo (se reemplaza por `borrada:<id de la cuenta>`, único y nunca un id de Instagram), el nombre (queda `(datos borrados a pedido de Meta)`) y su `meta`; la cuenta queda `revoked`. De sus publicaciones, `external_id`, `external_url` y `progress`, **sin cambiar su estado** ("retirada" significa borrada en la plataforma, y no lo está), con un evento `data_deleted` cada una. Se conservan el texto, las rutas de los medios en R2 y el historial de estados: son del corredor, no de Instagram.
2. **La única edición de la bitácora:** el nombre de la cuenta en `sent.account.displayName` de los `publish_attempt` de esas publicaciones pasa a `""` (solo si existe). Ningún otro cambio a un evento ya escrito.
3. **Todo en una transacción**, en un solo método de un puerto propio (`MetaDeletionRepository.eraseInstagramUser`), que también anota el pedido (`meta_deletion_requests`): el repositorio cruza tablas de otros agregados como excepción explícita. Las reglas de esas tablas quedan copiadas ahí, así que una columna nueva con datos de Instagram en `platform_accounts` o `publications` debe sumarse a `eraseInstagramUser` y a su contrato (`packages/db/test/meta-deletion.test.ts`, que corre igual contra el doble en memoria y contra PGlite).
4. **Del `user_id` solo se guarda un HMAC con clave** (derivada de `APP_ENCRYPTION_KEY`, propósito `metaUserId`), para auditar los pedidos de una misma persona sin poder revertirlo (un SHA-256 simple de un id numérico corto sí se revierte). Si cambia la clave, los hashes viejos dejan de calzar con los nuevos: se acepta.
5. **Quitar la app** (la otra vuelta) solo desconecta: `revoked` y sin token, sin borrar datos.

## Consecuencias
- El código que recibe Meta es cierto: si algo falla, no se borra nada y Meta recibe un error (y reintenta).
- Un borrado no cambia lo que muestra el seguimiento (la publicación sigue "publicada"), pero ya no tiene enlace.
- Hay un lugar más que mantener cuando se agregan columnas con datos de Instagram (lo recuerda `docs/02-modelo-datos.md`).
- **Riesgo aceptado:** si el borrado llega mientras una publicación de Instagram está en curso (el publisher leyó el token y espera el contenedor), al terminar puede volver a escribir `progress`, `external_id` y `external_url`. Es poco probable (el corredor quitó la app) y la cuenta ya no tiene token para el siguiente intento; si pasa, se borra a mano.
- **Riesgo aceptado:** las vueltas no revisan `expires` ni `issued_at`; repetir un pedido capturado vuelve a desconectar una cuenta reconectada o anota otro pedido con 0 cuentas.
- Las copias en los respaldos (los últimos 14 volcados diarios y el historial de Neon) desaparecen cuando salen de su ventana: lo dicen las páginas legales.

## Alternativas descartadas
- **Un puerto de transacción en core** (unidad de trabajo): más infraestructura para un solo caso; se revisa si llega un segundo borrado que cruce agregados.
- **Pasos separados por repositorio, sin transacción:** un corte a mitad dejaría datos y un código emitido, o un reintento que no encuentra la cuenta (su id ya cambió).
- **Marcar las publicaciones como retiradas:** "retirada" significa borrada en la plataforma; mentiría al corredor.
- **Dejar la bitácora intacta:** conserva el nombre de usuario de Instagram después del pedido.
- **No guardar nada del `user_id`:** sin forma de reconocer pedidos repetidos ni responder una consulta de Meta sobre ellos.
- **Borrar la fila de la cuenta:** la referencian sus publicaciones (FK sin cascada).
