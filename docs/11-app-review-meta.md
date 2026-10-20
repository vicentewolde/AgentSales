# 11 · App Review de Meta: el kit del operador

Para ti (Vinny). Reúne lo que Claude puede dejar escrito para el trámite de Meta; lo que hay que hacer en el panel de Meta (documentos, términos, subir videos, enviar) lo haces tú. La investigación de fondo está en `docs/integraciones/instagram.md` (§12 y §13) y la de usar una empresa, en `docs/integraciones/meta-verificacion-empresa.md`. Cierre de F8: el App Review quedó pendiente (spec F8, D5 cambiada el 2026-10-19).

> **Regla:** ninguna contraseña va en este archivo ni en el repo. Las credenciales del revisor se pegan solo en el formulario de Meta.

## 1. Antes de enviar: dos cosas que hoy no calzan

### 1.1 El revisor no podía conectar Instagram (resuelto en el código el 2026-10-19, ADR-0028; falta que lo despliegues)
- El usuario de demostración (`revisor-meta@agentpey.com`) es un corredor, y hoy **solo el administrador** puede conectar cuentas: `GET /oauth/instagram/start` es de administrador (`apps/api/src/access.ts`) y el panel le dice al corredor «Pídele al administrador que la conecte».
- Meta pide que el revisor, con las credenciales de prueba, **otorgue el permiso** y use la función. Sin el botón «Conectar Instagram», no puede: "your entire submission will be rejected" si no puede probar la app.
- **Darle un usuario administrador no sirve:** vería los corredores y propiedades de verdad.
- **Resuelto en `main` (ADR-0028):** cada corredor conecta **su propia** cuenta de Instagram con el botón (solo con el inicio de sesión de Instagram, o sea en el servidor); renovar y desconectar siguen siendo del administrador. Lo que sigue es el análisis original.
- **Análisis original:** dejar que cada corredor conecte **su propia** cuenta de Instagram (solo la suya). Es un cambio chico y además es lo natural para el producto: el inicio del OAuth deja de ser solo del administrador y, para un corredor, solo acepta su propio `broker`; la vuelta (`callback`) ya amarra la cuenta al corredor del `state`. Cambia D2 de F7 y el punto 4 de ADR-0022, así que va con su spec corto y un seguimiento en el ADR (una tarea de la fase que estás planificando). Mientras no esté, **no envíes la solicitud**.

### 1.2 El servidor está en simulación, y Meta necesita ver una publicación de verdad
- En `dry-run` AgentSales no publica en Instagram. El video y la prueba del revisor deben terminar con una publicación **real** en una cuenta de prueba, y la «llamada exitosa por permiso» de los 30 días previos también sale de ahí.
- Cambiar a `live` es solo tuyo (`PUBLISH_MODE` en `fly.toml`, `docs/10-despliegue.md`; D9) y vale para todo el servidor. Por eso, para la ventana de la revisión:
  1. Antes, desconecta o deja sin propiedades aprobadas las demás cuentas de Instagram conectadas, para que nada salga por error.
  2. Cambia a `live` solo para grabar y para el revisor, y vuelve a `dry-run` al terminar. El modo de cada publicación se fija al programarla.
  3. Publica solo en una **cuenta de prueba** (no en la de un cliente).
- Quién revisa publica en la cuenta que él conecta: la publicación aparece en **su** Instagram de prueba.

## 2. Orden del trámite (casillas para ir marcando)
1. [ ] **Verificación del negocio** (Business Manager; hasta 14 días hábiles). Con la empresa o con tu persona: ver `meta-verificacion-empresa.md`.
2. [ ] **Verificación de acceso / Tech Provider** (unos 5 días). Descripción lista en §4.3.
3. [ ] Desplegar el cambio del punto 1.1 (ADR-0028) y comprobar con `revisor-meta` que ve el botón «Conectar Instagram».
4. [ ] **Corredor de demostración listo:** `demo-meta` con una propiedad cargada (una planilla y un zip chicos, con 3 o 4 fotos y un video corto, sin datos de clientes reales), preparada y con los textos aprobados al gusto, **sin publicar**.
5. [ ] **Cuenta de Instagram de prueba**: profesional (Empresa o Creador), tuya, no de un cliente.
6. [ ] `revisor-meta@agentpey.com` con contraseña nueva (la de antes la pegaste en un chat), y entrar una vez desde otra red para confirmar que funciona.
7. [ ] Grabar un **video por permiso** (§6).
8. [ ] Una **llamada exitosa por permiso** en los 30 días previos al envío (§1.2): una conexión real y una publicación real en la cuenta de prueba.
9. [ ] Revisar en el panel de la app (`AgentSales-IG`): ícono, categoría, correo de contacto, URL de privacidad y términos, URLs de desautorización y de eliminación de datos (todo puesto el 2026-10-19), y el botón de login con las pautas de marca.
10. [ ] Pegar las instrucciones (§5) y las descripciones de uso (§4); aceptar los *Platform Onboarding Terms* y **enviar**.
11. [ ] Volver a `dry-run` y dejar las cuentas como estaban.

## 3. Qué hace AgentSales con cada permiso
- **`instagram_business_basic`:** al conectar, lee el identificador y el nombre de usuario de la cuenta profesional, para mostrar qué cuenta quedó conectada y para publicar en ella.
- **`instagram_business_content_publish`:** publica en esa cuenta el carrusel de fotos y el reel que el corredor preparó y aprobó dentro de AgentSales.
- No se usan comentarios, mensajes, estadísticas ni webhooks. Pide **solo** estos dos.

## 4. Textos para el formulario (en inglés: los revisores lo leen así)

### 4.1 `instagram_business_basic`
> AgentSales is a tool for independent real-estate agents. After the agent signs in to AgentSales, they press "Connect Instagram" and log in with their professional Instagram account. We use `instagram_business_basic` only to read the account's ID and username, so we can show the agent which account is connected and publish to that account on their behalf. We do not read followers, comments, messages or insights, and we do not use the data for anything else. The agent can disconnect the account at any time, and Instagram can ask us to delete the data (our deauthorize and data-deletion callbacks are live).

### 4.2 `instagram_business_content_publish`
> The agent prepares a property listing in AgentSales (photos, video and a caption written by an AI assistant), reviews and approves the text, and then presses "Publish on Instagram". We use `instagram_business_content_publish` to create and publish that carousel or reel on the agent's own account. Nothing is published without the agent's explicit approval and click. We never publish to accounts that have not connected AgentSales, and we do not post on anyone's behalf automatically unless the agent turned on the optional auto-publish setting.

### 4.3 Tech Provider / uso de datos de otros negocios
> AgentSales is a SaaS tool operated by CERTILINK SPA (Chilean tax ID 78.344.583-2), Chile. Independent real-estate agents connect their own Instagram professional account so AgentSales can publish their property listings on their behalf. We process only the account ID, username and access token (stored encrypted) and the content the agent chose to publish. Data is used only to provide this service; see https://agentsales.agentpey.com/legal/privacidad.html. Data deletion: https://agentsales.agentpey.com/legal/eliminacion-de-datos.html.

(Decidido el 2026-10-20: opera Certilink SpA; las páginas legales de AgentSales ya la nombran.)

## 5. Instrucciones para el revisor (para pegar en el formulario)

> **App:** AgentSales — https://agentsales.agentpey.com (web). Access is by invitation only; use the test account below.
>
> **Test account:** email `revisor-meta@agentpey.com` · password: *[entered in the submission form]*. This account belongs to a demo broker (“AgentSales Demo”) with one sample listing. No two-factor step is needed.
>
> **You need:** a test Instagram **professional** account (Business or Creator) that you control. AgentSales will publish a sample post to it.
>
> **Steps**
> 1. Open https://agentsales.agentpey.com and sign in with the test account.
> 2. Go to **Cuentas** (Accounts) in the top menu and press **Conectar Instagram** (Connect Instagram).
> 3. On the Instagram login screen, sign in with your test Instagram account and allow the requested permissions (`instagram_business_basic` and `instagram_business_content_publish`).
> 4. You return to AgentSales. The **Cuentas** page now shows your Instagram username as connected (this is the use of `instagram_business_basic`).
> 5. Go to **Propiedades** (Listings) and open the sample listing. Under **Contenido** press **Preparar contenido** (Prepare content) if the text is not ready, then **Aprobar Instagram** (Approve Instagram) to approve the caption.
> 6. Press **Publicar en Instagram** (Publish on Instagram) and confirm. After a few seconds the publication shows as published with a link; open your Instagram account to see the carousel (this is the use of `instagram_business_content_publish`).
> 7. To remove the connection, remove the app from Instagram (Settings → Apps and websites) or follow https://agentsales.agentpey.com/legal/eliminacion-de-datos.html: AgentSales then disconnects the account and deletes the stored Instagram data.
>
> The interface is in Spanish; button names are in bold above. Contact: vicente@agentpey.com.

*(El paso 2 exige haber desplegado el punto 1.1; sin él, el revisor no ve el botón. El paso 6 exige el servidor en `live`; ver §1.2.)*

## 6. Guion de los videos (uno por permiso)
Formato: 1080p o más, **sin audio**, subtítulos con texto en inglés, mouse y cursor grande, un solo take por video si se puede. Navegador en una ventana limpia, sesión del usuario de demostración, el dominio `agentsales.agentpey.com` visible en la barra.

### 6.1 Video de `instagram_business_basic` (≈1 min)
1. Barra de direcciones con `agentsales.agentpey.com`; entrar con el usuario de demostración. *Subtítulo: "Agent signs in to AgentSales".*
2. **Cuentas** → sin cuenta de Instagram. *"No Instagram account connected yet".*
3. Pulsar **Conectar Instagram**; se abre el inicio de sesión de Instagram.
4. Iniciar sesión con la cuenta de prueba y mostrar la pantalla de permisos (que se vea qué se pide). Pulsar **Permitir**. *"The agent grants the permission".*
5. Vuelta a **Cuentas**: aparece el nombre de usuario conectado. *"AgentSales shows which account is connected (basic)".*
6. (Opcional) Quitar la app desde Instagram (Configuración → Apps y sitios web) y mostrar en **Cuentas** que queda desconectada y sin datos.

### 6.2 Video de `instagram_business_content_publish` (≈2 min)
1. Con la cuenta ya conectada: **Propiedades** → la propiedad de demostración.
2. **Contenido** → **Preparar contenido** (puede cortarse el tiempo de espera con un subtítulo) → mostrar el carrusel y el texto.
3. **Aprobar Instagram**. *"The agent reviews and approves the caption".*
4. **Publicar en Instagram**, confirmar. *"The agent presses Publish".*
5. Mostrar el estado «publicada» con el enlace; abrir la cuenta de prueba en Instagram y mostrar la publicación. *"Post visible on the agent's account".*

## 7. Si Meta pide más o rechaza
- Lee el correo de contacto (`vicente@agentpey.com`): ahí llegan los resultados.
- Un rechazo común: el revisor no pudo llegar a la función (la causa más probable es el punto 1.1) o el video no muestra el permiso otorgado. Corrige y reenvía; cuéntale a Claude el motivo textual.
- Cambiar los ajustes de la app después de enviar puede reiniciar la revisión.
- Tras la aprobación: pasar la app a *live*, y cada año el **Data Use Checkup** (si no, Meta puede quitar el acceso).
