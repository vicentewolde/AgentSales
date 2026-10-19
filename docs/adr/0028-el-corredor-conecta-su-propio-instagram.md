# ADR-0028 · El corredor conecta su propio Instagram

- **Estado:** Aceptado
- **Fecha:** 2026-10-19
- **Modifica a:** la D2 del spec F7 («tú conectas cuentas») y el reparto de `accounts.manage` (ADR-0022), solo para el inicio de sesión de Instagram

## Contexto
- Hasta F8, conectar cuentas era solo del administrador (spec F7 D2, ADR-0022): `GET /oauth/instagram/start` era de administrador y el panel le decía al corredor «Pídele al administrador que la conecte».
- Para el App Review de Meta (`docs/11-app-review-meta.md` §1.1) el revisor entra con un usuario de corredor (`revisor-meta@agentpey.com`, corredor `demo-meta`) y debe **otorgar el permiso él mismo** en el inicio de sesión de Instagram. Sin el botón no puede probar la app y Meta rechaza todo el envío. Darle un usuario administrador lo dejaría ver todos los corredores y propiedades de verdad.
- Conectar su propio Instagram con el inicio de sesión de Instagram es, además, lo natural para el producto: el corredor es el dueño de la cuenta y quien la autoriza.

## Decisión
1. Nuevo permiso de core, **`instagram.connect`**: lo tiene el corredor, siempre con su propio corredor (`can(user, "instagram.connect", brokerId)`); el administrador lo tiene como todo. No incluye renovar ni desconectar, que siguen en `accounts.manage`.
2. `GET /oauth/instagram/start` pasa de `admin` a `session` en la tabla de permisos (`access.ts`) y la ruta revisa el permiso: un corredor que pide el `broker` de otro recibe lo mismo que con uno que no existe (`BROKER_NOT_FOUND` en la vuelta al panel, sin `state` ni cookie), como el resto de lo ajeno (ADR-0022). Sin sesión, 401 como cualquier ruta de sesión.
3. La vuelta (`GET /oauth/instagram/callback`) no cambia: es pública y amarra la cuenta al corredor del `state` firmado, vigente y de un solo uso (F8-T17), así que un corredor no puede conectar a otro cambiando la dirección.
4. El panel muestra el botón «Conectar Instagram» al corredor **solo con el inicio de sesión de Instagram** (el servidor con HTTPS). Sin él, el comando de la CLI con el token del panel de Meta sigue siendo del administrador. «Renovar» y «Desconectar» siguen siendo del administrador.
5. Mercado Libre, Marketplace y los topes no cambian.

## Consecuencias
- El revisor de Meta puede conectar su propia cuenta de Instagram con el usuario de demostración.
- Un corredor puede reconectar su Instagram cuando el token vence o se rompe, sin pedirlo al administrador. Reconectar reemplaza el token de **su** cuenta; no toca la de otro corredor.
- Un corredor podría conectar un Instagram que no es suyo (otra persona inicia sesión en su navegador): lo mismo que podía hacer el administrador; el sistema no lo puede distinguir, la responsabilidad es del corredor y del operador al invitarlo.
- La lista de alta del corredor (F7) y la guía del operador dicen que el corredor conecta su Instagram.

## Alternativas descartadas
- **Un usuario administrador para el revisor:** vería datos de todos los corredores.
- **Dejar al corredor conectar con el token del panel de Meta:** pide que entre al panel de desarrolladores de Meta con un rol en la app; es del administrador.
- **Un registro público para el revisor:** más superficie y no hace falta.
