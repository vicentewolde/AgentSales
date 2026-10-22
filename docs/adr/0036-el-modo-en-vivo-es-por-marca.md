# ADR-0036 · El modo en vivo es por marca: el servidor lo permite y cada marca lo enciende

- **Estado:** Aceptado
- **Fecha:** 2026-10-22
- **Reemplaza a / Modifica a:** precisa `PUBLISH_MODE` de ADR-0016 y las reglas de seguridad de `CLAUDE.md`: el interruptor deja de ser solo global; no se contradice ninguna regla (nada publica de verdad sin instrucción explícita del operador)

## Contexto
`PUBLISH_MODE` es una variable del servidor: o todo está en simulación o todo sale de verdad. El operador quiere publicar a diario desde sus marcas (AgentPey y vinny) sin que sus corredores de prueba, ni mañana los de un cliente, publiquen de verdad por accidente. Con un interruptor global la única forma es dejar todo en vivo.

## Decisión
1. **Dos llaves.** Una publicación sale de verdad solo si el servidor tiene `PUBLISH_MODE=live` **y** la marca tiene `live_enabled = true`. Con cualquiera apagada, es simulación. `PUBLISH_MODE=dry-run` sigue siendo el valor por defecto y apaga todo, como hoy.
2. **`live_enabled` es una columna de `brokers`** (booleana, por defecto `false`; migración aditiva). Solo la cambia el administrador, con confirmación (`brokers live <slug> on|off`, y un interruptor en la ficha del corredor). Una marca nueva nace apagada. Un corredor que no es propio (`operator_owned = false`) **no puede** encenderse hasta que haya un ADR de clientes.
3. **El modo efectivo se calcula en un solo lugar** de core (`effectivePublishMode(serverMode, broker)`) y se fija en la publicación como hoy (`dry_run`); lo que ya empezó en vivo sigue la regla actual (`PUBLISH_MODE_LOCKED`).
4. **El panel y la CLI** muestran el modo de **la marca elegida**, no solo el del servidor («Simulación» o «En vivo» junto al nombre de la marca).
5. **Las pruebas de entrada (S1 a S6) no cambian:** una red publica de verdad solo después de la suya, hecha por el operador.
6. Encender o apagar `live_enabled` y cambiar `PUBLISH_MODE` en el servidor son decisiones del operador, con su instrucción en el chat; Claude no los cambia solo.

## Consecuencias
- El servidor puede quedar en `live` de forma permanente sin que ningún otro corredor publique de verdad.
- Volver a una versión sin la columna (v1.5.0) ignora `live_enabled` y deja todo según `PUBLISH_MODE`: antes de volver atrás, `PUBLISH_MODE=dry-run` (lo dice `docs/10-despliegue.md`).
- Toda lectura de `PUBLISH_MODE` en core debe pasar por la función nueva (un test recorre el código y falla si encuentra otra).

## Alternativas descartadas
- **Un modo por cuenta conectada:** más fino, pero obliga a decidir en muchos lugares y es fácil dejar una en vivo sin saberlo.
- **Servidor en vivo y el resto con `auto_publish`:** mezcla dos ideas distintas (aprobación y simulación).
