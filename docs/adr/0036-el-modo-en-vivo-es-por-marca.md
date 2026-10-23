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

## Seguimiento (2026-10-22, F9.5-T22)
Lo que dejó claro la implementación (PR #247):

- **(a) Son tres condiciones, no dos.** Una publicación sale de verdad solo con `PUBLISH_MODE=live`, `live_enabled = true` **y** `operator_owned = true` (`brokerLiveEnabled` y `effectivePublishMode`, `packages/core/src/publish-mode.ts`). Un corredor que deja de ser propio se apaga: la llave se baja **antes** de guardar el cambio de «propio», para que un fallo a mitad de camino nunca deje un corredor ajeno con la llave encendida; al volverse propio también queda apagada (una llave vieja no se activa sola).
- **(b) La marca apagada frena también lo que ya está en vivo.** Pausar, reactivar, cerrar, actualizar, republicar, cambiar el estado de la propiedad y retirar borrando en la red dan `PUBLISH_MODE_MISMATCH` sin llamar a la plataforma, y el mensaje da las dos salidas: encender la marca o hacerlo a mano en la red (en Portal, cerrar en Mercado Libre y correr `publications sync`). El intento del worker de una publicación fijada en vivo también se detiene. Confirmar a mano una de Marketplace sigue funcionando, porque solo anota lo que hizo el operador. Después de la demo se evaluará permitir con la marca apagada las operaciones que **reducen** la exposición (pausar, cerrar, retirar).
- **(c) Qué marca decide.** En la API, la del **sujeto** (el corredor del aviso o la marca del post; para una publicación suelta, la de su cuenta). En el worker, la de la **cuenta** de la publicación. Son la misma porque la cuenta de una publicación siempre es de la marca de su sujeto (las publicaciones se abren con las cuentas de esa marca). Las dos usan las mismas funciones de core (`listingPublishMode`, `postPublishMode`, `publicationPublishMode`, `accountPublishMode`).
- **(d) Permiso y confirmación.** Encender y apagar usan el permiso existente `broker.settings` (solo el administrador). Encender exige repetir el `slug` (`liveConfirm`, `LIVE_NOT_CONFIRMED`) también en la API, no solo en la CLI y el panel; un corredor ajeno da `LIVE_NOT_ALLOWED`. Cada cambio queda en el registro de la API (quién, la marca y el valor).
- **(e) Etiquetas y preguntas.** Lo que todavía no tiene modo fijado muestra el de **su marca** (el banner, las publicaciones de una propiedad o un post, el seguimiento, el calendario, el lote de Propiedades). Si no se sabe la marca (por ejemplo, la agenda con «Todos» y el servidor en vivo), no se dice nada. Las preguntas de «¿publicar en vivo?» de la CLI y del panel salen solo si la marca está en vivo; si no se puede saber, preguntan igual (de más, nunca de menos).
