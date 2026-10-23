# 12 · La demo con la oficina (viernes 2026-10-30)

Guía paso a paso para la demo de F9.5 (`docs/specs/fase-9.5-lista-para-mostrar.md` §7). La haces tú, desde el servidor (`https://agentsales.agentpey.com`), con publicaciones reales en tus cuentas. Los comandos que hablan con Fly.io son tuyos (CLAUDE.md, D8 de F8); Claude solo prepara y anota.

**Lo que muestras:** una propiedad que llega a Instagram, los posts de AgentPey con el plan de ideas, y el calendario con su seguimiento.

## Jueves 29 · Dejarlo listo

1. **Desplegar `v1.4.0`** (sin migraciones nuevas):
   ```bash
   gh workflow run deploy.yml --ref main
   ```
   Después, revisa que el worker quedó apagado (`docs/10-despliegue.md`, paso 4 y paso 8).
2. **Tu CLI contra el servidor** (hoy apunta a tu Mac):
   ```bash
   pnpm -s cli login --api https://agentsales.agentpey.com --email <tu correo>
   ```
   ```bash
   pnpm -s cli status
   ```
   Debe decir la versión `1.4.0` y `PUBLISH_MODE: dry-run`.
3. **Tu corredor para las propiedades** (vinny y AgentPey son marcas: solo publican posts). Elige el slug y los datos; por ejemplo:
   ```bash
   pnpm -s cli brokers create --slug vicente --name "Vicente Wolde" --brand "Vicente Wolde Propiedades" --color "#233b78"
   ```
   En el panel, **Corredores → tu corredor**: WhatsApp (Portal lo exige) y logo. La lista de alta te dice qué falta.
4. **Conectar `@vicentewoldec` a ese corredor:** en el panel, **Cuentas**, elige tu corredor y **Conectar Instagram** (inicias sesión en Instagram). La misma cuenta queda también en AgentPey; son dos conexiones distintas y no se pisan.
5. **La propiedad de ejemplo:** baja la planilla de tu corredor y llena una fila con datos de ejemplo creíbles (sin dirección exacta, `mostrar_direccion_exacta = no`):
   ```bash
   pnpm -s cli brokers template vicente --out ~/Desktop/plantilla-vicente.xlsx
   ```
   Pon las fotos (y un video corto si quieres mostrar el reel) en una carpeta con el nombre del id de la propiedad.
6. **Ensayo corto (recomendado, 20 minutos)**, con el worker encendido (paso 8 de `docs/10-despliegue.md`) y todo en simulación:
   - cargar la propiedad:
     ```bash
     pnpm -s cli import ~/Desktop/plantilla-vicente.xlsx --media <carpeta>
     ```
   - en el panel, en la propiedad: **Preparar** (fotos, portada, reel y textos con la IA), mirar la **vista previa de Instagram** y **Aprobar**;
   - en **Plan**, pedir un plan de 14 días para AgentPey, aceptar una idea, mirar sus textos y su vista previa, aprobar y **programar a 5 minutos**;
   - ver que a su hora sale sola (simulación) y aparece en **Hoy → Publicado hace poco** con la marca «simulación». Ese es el criterio 3 de F9 que nunca se probó: idealmente, con el Mac cerrado;
   - probar el cambio a vivo y de vuelta (abajo, «En vivo»), sin publicar nada, para confirmar que `fly machine update` funciona como esperamos;
   - apagar el worker al terminar.

## Viernes 30 · La demo

**Antes de que llegue la oficina**
1. Enciende el worker (paso 8 de `docs/10-despliegue.md`) y abre el panel en `https://agentsales.agentpey.com`: **Hoy** debe cargar.
   Si el horario del worker está activado (se apaga solo tras 10 minutos sin trabajo), lee antes el párrafo «Para una demo» del paso 8 de `docs/10-despliegue.md` («El worker con horario»): en las pausas de la demo se apagaría.
2. Deja preparada (no aprobada) la propiedad de ejemplo y uno o dos posts de AgentPey ya aceptados, por si la IA tarda en vivo.

**En vivo** (dilo en el chat: «pasa a live para la demo»; los comandos los corres tú, `docs/10-despliegue.md`, «En vivo solo durante una demo»):
```bash
fly machine update <id_api> -a agentsales --env PUBLISH_MODE=live --yes
```
```bash
fly machine update <id_worker> -a agentsales --env PUBLISH_MODE=live --yes
```
Comprueba que el panel muestra la franja roja «En vivo».

**El recorrido**
1. **Hoy:** qué te toca, qué viene y qué salió.
2. **La propiedad:** su sección Contenido con la vista previa de Instagram (carrusel y reel), Portal y Marketplace; aprobar y **Publicar en Instagram (en vivo)**. Si Instagram no confirma, aparece «no se sabe si salió» con los botones «Sí, salió» y «No salió».
3. **AgentPey:** **Plan** → pedir un plan → las ideas por semana, con su día, hora y redes → aceptar → los textos por red con su vista previa → aprobar → publicar en Instagram o Discord, o programar a pocos minutos.
4. **Calendario y Seguimiento:** lo programado junto a la propiedad; llega la hora y sale solo; el enlace en **Hoy**.

**Al terminar**
1. Revisa en **Hoy** (o `pnpm -s cli agenda`) que no quede nada programado en vivo; si queda, desprográmalo (`pnpm -s cli unschedule <id>`).
2. Vuelve a simulación con los mismos dos comandos y `PUBLISH_MODE=dry-run`, y comprueba con `pnpm -s cli status`.
3. Apaga el worker (paso 8).
4. **Borra la propiedad de ejemplo de Instagram** (en la app: `···` → Eliminar) y márcala retirada en AgentSales (`pnpm -s cli publications retire <id>`), o ciérrala (`pnpm -s cli listing close <id> --reason retirada`).

## Si algo falla en la demo

| Pasa | Qué hacer |
|---|---|
| La IA tarda o falla al preparar | Usa lo que dejaste preparado antes |
| Instagram no confirma | Queda «no se sabe si salió»: mira tu Instagram y usa «Sí, salió» (con el enlace) o «No salió» |
| `PUBLISH_MODE_MISMATCH` | La API y el worker no están en el mismo modo (repite el `fly machine update` en la que falta), o la marca está apagada o ya no es propia (F9.5-T22): el mensaje lo dice; enciéndela con `pnpm -s cli brokers live <slug> on --confirm <slug>`, o haz el cambio a mano en la red (en Portal, ciérralo en Mercado Libre y corre `pnpm -s cli publications sync <id>`) |
| Lo programado no sale | El worker está apagado: enciéndelo (paso 8); lo atrasado sale al encender |
| X da error de token | No conectaste la misma cuenta de X en el Mac: en el panel del servidor, **Cuentas**, conecta X de nuevo |
