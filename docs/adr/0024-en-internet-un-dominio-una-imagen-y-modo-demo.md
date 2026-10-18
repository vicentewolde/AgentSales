# ADR-0024 · En internet: un dominio, una imagen, la API bajo `/api` y el servidor en modo demo

- **Estado:** Aceptado
- **Fecha:** 2026-10-18
- **Modifica a:** ADR-0005 (el worker deja de encenderse solo al desarrollar), ADR-0017 (punto 8: el formulario automático de Marketplace no corre en producción); suma un seguimiento a ADR-0007. Cambia además la D11 del spec F6 (el respaldo sí va a R2) y la §4.7 del spec F7 (el plan del operador no atiende a sus corredores en producción)

## Contexto
- Hasta F7 todo corre en el Mac del operador: la API escucha en `127.0.0.1`, `hostGuard` solo acepta `localhost`, el panel lo sirve Vite (que quita el prefijo `/api` antes de llamar a la API) y la CLI llama sin prefijo.
- F8 (spec `docs/specs/fase-8-en-internet.md`) lleva el sistema a internet. El operador quiere **por ahora algo gratis para mostrar la herramienta** y después un plan pagado (D1).
- Con el worker siempre encendido, pg-boss mantiene despierto el cómputo de Neon: unas 182 CU-h al mes contra 100 del plan gratis (`docs/integraciones/hosting.md`). Ningún proveedor gratis sirve para el worker salvo Oracle Always Free, que hay que administrar y puede reclamarse si queda ociosa (§13 de la nota).
- `agentpey.com` es del operador y lo usa otro proyecto (D2).
- Los términos del plan Max permiten `claude -p` solo para uso propio, no en un servidor que atiende a terceros (`docs/integraciones/anthropic-terminos.md` §6).
- El formulario automático de Marketplace necesita una ventana visible y la sesión de Facebook en un perfil local (ADR-0017); el operador eligió Marketplace a mano para todos en producción (D4).

## Decisión
1. **Un dominio y un origen:** AgentSales vive en `https://agentsales.agentpey.com`, un subdominio del dominio del operador. La API monta sus rutas bajo `/api` **en los dos modos** (`new Hono().route("/api", …)` en `server.ts`, sin cambiar `AppType`); Vite deja de quitar el prefijo, la CLI llama a `<dirección>/api` y la tabla de permisos compara sin él. En producción la API sirve también el panel compilado. Sin CORS.
2. **La configuración sale de `PUBLIC_URL`:** hosts, orígenes, `panelUrl` y las URIs de retorno de los OAuth. `NODE_ENV=production` exige `https://`, `API_HOST` explícito, un `LLM_PROVIDER` distinto de `claude-cli`, el respaldo a R2 y nada de perfiles del navegador.
3. **Una imagen** (Node 26 sobre Debian, ffmpeg estático fijado por sha256, Chromium de Playwright y `pg_dump` 18 de PGDG) con dos procesos, `api` y `worker`, en Fly.io (São Paulo, la región de Neon).
4. **Modo demo:** las máquinas se encienden los días en que se muestra la herramienta y se apagan después (la API además se apaga sola sin tráfico); Neon sigue en el plan gratis porque su cómputo se duerme con el worker apagado. Un latido del worker (`worker_heartbeats`) dice si está encendido. Pasar a siempre encendido con Neon Launch es dejar las máquinas encendidas y cambiar el plan: sin cambiar código.
5. **Producción y desarrollo separados:** producción usa la base de Neon y el bucket de hoy, con la misma `APP_ENCRYPTION_KEY`; el Mac usa una rama de Neon, un bucket de desarrollo y otra `APP_ENCRYPTION_KEY`, con las credenciales borradas en la rama (`db:dev-scrub`). Los scripts que hablan con la base eligen su archivo de entorno con `ENV_FILE`.
6. **Desplegar es del operador:** un flujo de GitHub Actions a pedido (`workflow_dispatch`), solo desde `main` con `CI / check` en verde, que aplica las migraciones antes de arrancar la versión nueva. Claude nunca despliega. `PUBLISH_MODE=dry-run` en el servidor hasta que el operador diga otra cosa en el chat.
7. **El respaldo en la nube:** el job `db.backup` vuelca a una carpeta temporal y sube el volcado a un bucket de R2 aparte (`agentsales-backups`, con un token que solo tiene el worker); el estado va al bucket principal. `pnpm db:backup` sigue siendo local.
8. **La IA y Marketplace en producción:** todos los corredores usan la API de Anthropic; `claude-cli` queda para el desarrollo. Marketplace es a mano para todos (ADR-0023): en producción el worker no registra el formulario automático y `marketplaceAutomationAllowed` lo niega.

## Consecuencias
- El sistema se puede mostrar desde cualquier lugar por unos US$ 2 al mes (4 días de demo), sin un servidor que administrar, y en la misma plataforma del plan pagado.
- Fuera de los días de demo nadie puede usarlo; lo programado mientras estaba apagado sale al encender si el atraso es de 12 h o menos (F6), y el respaldo diario solo existe los días encendidos.
- Si el worker queda encendido por olvido, el cupo gratis de Neon se agota en unos 17 días y la base (también la de desarrollo) queda suspendida hasta el mes siguiente, sin perder datos.
- La CLI y el panel cambian de prefijo en el mismo lote; las sesiones de F7 de la CLI siguen siendo locales.
- El Mac del operador deja de ser parte de producción; el formulario automático de Marketplace queda solo para desarrollo.

## Alternativas descartadas
- **Fly.io siempre encendido con Neon Launch (unos US$ 37 a 48 al mes):** es lo recomendado cuando se pague; el operador pidió algo gratis por ahora.
- **Oracle Always Free con Postgres en la máquina:** US$ 0, pero hay que administrarla, Oracle puede reclamarla si queda 7 días ociosa, es Arm64 y migrar después cuesta más; además saca la base de Neon (cambio de ADR-0007).
- **Railway, Render, Koyeb o Cloud Run gratis:** no tienen un worker gratis siempre encendido o no tienen región en Sudamérica.
- **`agentpey.com/agentsales` (una ruta del dominio):** el otro proyecto tendría que reenviar el tráfico, y las cookies `__Host-` y las vueltas de los OAuth necesitan la raíz del nombre.
- **El panel en otro origen (Cloudflare Pages) con CORS:** abriría CORS, que ADR-0021 dejó como restricción, y la cookie `Strict` no viajaría al inicio del OAuth.
- **Un worker en el Mac para Marketplace automático:** más código y el Mac encendido al publicar; el operador eligió a mano para todos.
- **Desplegar en cada merge a `main`:** con los merges autorizados, Claude terminaría desplegando; desplegar habla con una plataforma real.
