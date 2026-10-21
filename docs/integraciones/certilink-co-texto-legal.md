# Texto para certilink.co (verificación del negocio en Meta)

**Estado: borrador. No se ha cambiado nada en el repositorio de `certilink.co`.** Ese repo es de tu socio (`CaBsCrypto/onchain-validation`, privado): se le avisa antes y los cambios los aplica él o tú con su acuerdo. Este documento es lo que se le mostraría.

## Por qué hace falta
Meta compara el **nombre legal, la dirección, el teléfono y el sitio web** del portafolio con los documentos de la empresa, y el sitio tiene que «parecer del negocio» (`docs/integraciones/meta-verificacion-empresa.md` §3). Hoy `certilink.co` solo dice «CertiLink» y «© 2026 CertiLink»: no tiene razón social, RUT, domicilio, teléfono ni correo, ni términos ni política de privacidad (leído el 2026-10-20). Así no pasaría la verificación.

## Datos de la empresa (los que dio el operador; deben coincidir letra por letra con el e-RUT del SII y la escritura)
- **Razón social:** CERTILINK SPA
- **RUT:** 78.344.583-2 (el dígito verificador calza)
- **Domicilio:** Santa Teresa #6, Huelquén, comuna de Paine, Chile *(confirmar comuna y región contra el SII)*
- **Teléfono:** +56 9 8509 0820
- **Correo de contacto:** hoy `vicentewolde@gmail.com`; mejor uno del dominio (ver más abajo)
- **Representante legal:** Vicente Wolde Cepeda

## Qué agregar al sitio (mínimo, sin tocar lo que ya hace)
1. **Pie de página** (hoy «© 2026 CertiLink — Powered by Stellar Network»): `© 2026 CERTILINK SPA · RUT 78.344.583-2 · Santa Teresa #6, Huelquén, Paine, Chile · +56 9 8509 0820 · <correo>`, con enlaces a «Empresa», «Términos» y «Privacidad».
2. **Página `/empresa`** (en `src/app/`, como las demás páginas públicas): quiénes somos, razón social y RUT, domicilio, teléfono y correo, representante, y los servicios de la empresa. Texto propuesto:

> **CERTILINK SPA** es una empresa chilena (RUT 78.344.583-2), con domicilio en Santa Teresa #6, Huelquén, comuna de Paine. Ofrece dos servicios de software:
> - **CertiLink:** emisión y validación de certificados y diplomas verificables sobre la red Stellar, para organismos de formación.
> - **AgentSales:** herramienta para corredores de propiedades independientes que prepara sus avisos y los publica en Instagram, Portal Inmobiliario y Facebook Marketplace, siempre con la aprobación del corredor (https://agentsales.agentpey.com).
>
> Contacto: <correo> · +56 9 8509 0820. Representante legal: Vicente Wolde Cepeda.

3. **Términos y privacidad** de CertiLink (`/terminos`, `/privacidad`): hoy no existen. Para Meta no es obligatorio que estén, pero un sitio de empresa sin ellos se ve incompleto; los de AgentSales (`/legal/*.html` en `agentsales.agentpey.com`) sirven de modelo. Requisito de la Ley 21.719 si CertiLink guarda datos de alumnos (lo decide el socio, no es de este trámite).

El punto 2 es lo importante para Meta; el 1 lo acompaña; el 3 es recomendable.

## Cómo confirmar que `certilink.co` es tuyo (sin buzón de correo)
Meta ofrece confirmar el dominio de dos formas: un **registro DNS TXT** o **un código a un correo del dominio**. Como no tienes correo en `certilink.co`:
- **Lo más simple: el registro DNS TXT.** En GoDaddy → tu dominio → DNS, se agrega un registro `TXT` con el valor que te da Meta en Business Manager (Configuración → Seguridad de la marca → Dominios). No necesita correo. *(La pantalla exacta de GoDaddy no se verificó: GoDaddy tiene su ayuda «Agregar un registro TXT».)*
- **Si prefieres un correo `@certilink.co`:** GoDaddy ofrece **reenvío de correo** (un alias que reenvía a tu Gmail, suele venir con el dominio; solo recibe) y planes de buzón de pago (Microsoft 365 o correo profesional). Para recibir el código de Meta basta el reenvío (por ejemplo `contacto@certilink.co → vicentewolde@gmail.com`). Cómo lo hayas hecho con `vicente@agentpey.com` (reenvío o buzón) es lo mismo que sirve acá. *(Precio y planes de GoDaddy: NO VERIFICADO.)*
- Además un correo `@certilink.co` se ve más serio como correo de contacto público que un Gmail.

## Antes de tocar el repo
Avisar al socio con este documento y acordar: quién aplica el cambio, en qué rama y cuándo se despliega (el repo tiene un `AGENTS.md` y varias notas operativas; se leyó solo la estructura de archivos y `src/app/page.tsx` y `layout.tsx`).
