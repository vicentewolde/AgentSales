# ADR-0035 · Borrar un corredor de verdad: todo lo suyo, en una transacción, y R2 después

- **Estado:** Aceptado
- **Fecha:** 2026-10-22
- **Reemplaza a / Modifica a:** extiende ADR-0027 (el borrado a pedido de Meta) a un borrado completo de un corredor, a pedido del operador

## Contexto
La base de producción acumula corredores de prueba (de F3 a F9) que ensucian el panel en la demo con la oficina. Archivar deja filas, archivos en R2 y credenciales guardadas. El operador decidió borrarlos de verdad (spec F9.5, lote 2). Lo mismo servirá cuando un cliente se vaya y pida borrar sus datos.

## Decisión
1. `purgeBroker` borra **todo lo del corredor** en una transacción de la base: usuarios y sesiones, cuentas y sus credenciales, propiedades, medios, textos, corridas, publicaciones y su bitácora, cargas, posts, perfil editorial, planes y valores de campos. Los demás corredores no se tocan.
2. **Antes**, junta las claves de R2 de sus medios y logos; **después** del commit, las borra. Lo que R2 no pueda borrar queda anotado en el log con su clave (sin URL firmada) para reintentarlo; nunca deja filas huérfanas en la base.
3. Se niega si hay una publicación publicándose o programada (hay que cancelarla antes) o en resultado dudoso (hay que resolverla).
4. Solo el administrador, con una confirmación que repite el slug (`DELETE /brokers/:id` con el slug en el cuerpo; `agentsales brokers delete <slug> --confirm <slug>`), y la CLI muestra antes el resumen de lo que se borra.
5. No borra nada en las redes: lo publicado sigue publicado allá (para eso está retirar).
6. El respaldo diario (o `pnpm db:backup`) es la vuelta atrás; el procedimiento lo recuerda.

## Consecuencias
- Un corredor borrado no se recupera sin restaurar un respaldo.
- Un job que corre mientras se borra el corredor puede dejar archivos sin dueño en R2, igual que una corrida de contenido: desde F9.5-T25, también un `post.image` en curso (guarda el original en R2 antes de crear su medio, y el borrado ya no lo encuentra en la base). No se reintenta ni rompe nada; ocupan espacio hasta una limpieza a mano del prefijo `posts/<id>/`.
- Las cuentas de Mercado Libre o Instagram que tenía ese corredor quedan sin conectar en AgentSales (se conectan de nuevo en otro corredor).

## Alternativas descartadas
- **Archivar el corredor:** deja credenciales y archivos que ya no sirven.
- **Borrado en cascada con `ON DELETE CASCADE` en la base:** cambiaría el esquema de muchas tablas y haría fácil un borrado por error desde cualquier lado.
