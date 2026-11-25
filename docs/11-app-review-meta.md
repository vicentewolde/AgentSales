# 11 · App Review de Meta: el kit del operador

Para ti (Vinny). Esta guía reúne lo que Claude puede dejar escrito para pasar la app de Meta **AgentPey** a producción. Lo que se hace en el panel de Meta lo haces tú: la contraseña del revisor, encender la marca de prueba, grabar los videos y enviar. La investigación de fondo está en `docs/integraciones/instagram.md` (§12 y §13) y en `docs/integraciones/meta-verificacion-empresa.md`.

> **Regla:** ninguna contraseña va en este archivo ni en el repo. Las credenciales del revisor se pegan solo en el formulario de Meta.

## 0. Para qué sirve producción (y para qué no)
- **El Instagram de @agentpey no la necesita.** Desde el 2026-11-24 publica por la API en modo desarrollo, porque es evaluadora de la app. El primer post salió a las 15:56 y lo ve todo el mundo. Para las cuentas propias basta el acceso estándar, que no vence (`docs/integraciones/instagram-contenido-propio.md` §2.2).
- **Producción sirve para conectar el Instagram de otras personas,** como clientes o corredores, sin invitarlas antes como evaluadoras. Para eso, los dos permisos deben pasar de acceso estándar a **acceso avanzado**, y eso exige App Review.

## 1. Estado al 2026-11-24
| Requisito | Estado |
|---|---|
| App de Meta | **AgentPey** (id 1642803507209276) con su app de Instagram **AgentPey-IG** (id 1109235818134732), en el portafolio Certilink SPA y en modo desarrollo |
| Verificación del negocio | **Hecha:** Certilink SpA, verificada el 2026-10-21 (Business Suite → Centro de seguridad) |
| Configuración obligatoria | **Completa,** según la página Publicar de la app (ícono nuevo, URLs legales y vueltas de desautorización y borrado) |
| Permisos | `instagram_business_basic` e `instagram_business_content_publish`, los dos en «Listo para prueba» |
| Llamada exitosa por permiso en los 30 días previos | **Hecha el 2026-11-24:** la conexión de @agentpey (basic) y su post de las 15:56 (content_publish). Si el envío queda para después del 2026-12-24, hay que repetir una publicación |
| El revisor puede conectar su Instagram | **Sí:** cada usuario conecta su propia cuenta con el botón de Cuentas (ADR-0028, ya desplegado) |
| Marca de prueba para el revisor | **Creada:** `agentpey-demo` («AgentPey Demo»), marca propia con tope de IA de US$2, perfil mínimo y dos posts de imagen iguales, «Sample post for Meta review» (`01a0cd0a` para tu video y `dc6a402b` para el revisor), sin aprobar: tarjeta en español y texto en español e inglés |
| Usuario del revisor | **Falta, tuyo** (§2, paso 1) |
| Videos | **Falta, tuyo** (§6) |
| Envío | **Falta, tuyo** (§2, paso 6) |

## 2. Pasos que quedan (en orden)
1. **Usuario del revisor en la marca de prueba.** El usuario viejo, `revisor-meta@agentpey.com`, está en `18862631`, que es un corredor de propiedades y no publica posts. Crea uno nuevo en la marca de prueba desde tu Mac, con la sesión del servidor:
   ```bash
   pnpm -s cli users invite --email meta-review@agentpey.com --name "Meta Review" --broker agentpey-demo
   ```
   El enlace queda en tu portapapeles. Ábrelo en una ventana privada, elige una contraseña nueva y guárdala en tu gestor (nunca en el chat). Después desactiva el viejo con `pnpm -s cli users disable revisor-meta@agentpey.com`.
2. **Encender la marca de prueba en vivo durante la revisión.** El revisor tiene que ver una publicación real; el servidor ya está en `live`. Esto lo corres tú, nunca Claude: `pnpm -s cli brokers live agentpey-demo on --confirm agentpey-demo`. La marca encendida solo publica lo que se apruebe y se publique en ella, en la cuenta que conecte el revisor.
3. **Probar el recorrido una vez como revisor, antes de grabar.** Entra con `meta-review@`, conecta una cuenta de Instagram de prueba **que no sea @agentpey**, aprueba el post de ejemplo y publícalo. Al conectar una cuenta en una marca se desconecta la anterior **de esa misma marca**, y de ninguna otra. Por eso la prueba va en `agentpey-demo` y nunca en `agentpey`. La cuenta de prueba tiene que ser profesional y, mientras la app siga en desarrollo, estar invitada como evaluadora de AgentPey-IG.
4. **Grabar los dos videos** (§6).
5. **Revisar el panel de la app** (developers.facebook.com → AgentPey): nombre, ícono, categoría, correo de contacto `vicente@agentpey.com` y las URLs de privacidad, términos y eliminación de datos.
6. **Armar y enviar la solicitud.** Ruta: Casos de uso → «Administrar mensajes y contenido en Instagram» → en cada permiso, **Acciones → solicitar acceso avanzado**. Cada permiso lleva su descripción (§4), su video (§6) y las instrucciones (§5) con el usuario y la contraseña del paso 1. Acepta los términos y aprieta **Enviar**. El resultado llega a `vicente@agentpey.com` y suele tardar unos días.
7. **Cuando Meta apruebe:** en la app, **Publicar** (pasa a modo live). Apaga la marca de prueba con `pnpm -s cli brokers live agentpey-demo off --yes` y desconecta la cuenta del revisor si ya no la usas.

## 3. Qué hace AgentPey con cada permiso
- **`instagram_business_basic`:** al conectar, lee el identificador y el nombre de usuario de la cuenta profesional. Así muestra qué cuenta quedó conectada y sabe en cuál publicar.
- **`instagram_business_content_publish`:** publica en esa cuenta el post (imagen, carrusel o reel) que la marca preparó y aprobó en AgentPey, en el momento o a la hora programada.
- No se usan comentarios, mensajes, estadísticas ni webhooks. Se piden **solo** estos dos permisos.

## 4. Textos para el formulario (en inglés: los revisores lo leen así)

### 4.1 `instagram_business_basic`
> AgentPey helps small businesses plan, write and publish their own social-media posts. After signing in to AgentPey, the business presses "Conectar Instagram" (Connect Instagram) and logs in with its professional Instagram account. We use `instagram_business_basic` only to read the account's ID and username, so we can show the business which account is connected and publish to that account on its behalf. We do not read followers, comments, messages or insights, and we do not use the data for anything else. The business can disconnect the account at any time, and our deauthorize and data-deletion callbacks are live.

### 4.2 `instagram_business_content_publish`
> In AgentPey the business prepares a post (an image, a carousel or a short video, with a caption that an AI assistant drafts and the business edits), reviews it and approves it. Then it presses "Publicar en Instagram" (Publish on Instagram), or schedules the post for a date and time it chooses. We use `instagram_business_content_publish` to create and publish that post on the business's own Instagram account. Nothing is published without the business's explicit approval, and we never publish to accounts that have not connected AgentPey.

### 4.3 Uso de datos (si Meta lo pregunta)
> AgentPey is operated by CERTILINK SPA (Chilean tax ID 78.344.583-2), Chile. Businesses connect their own Instagram professional account so AgentPey can publish the posts they approve. We store only the account ID, username and access token (encrypted at rest) and the content the business chose to publish. Data is used only to provide this service. Privacy policy: https://agentsales.agentpey.com/legal/privacidad.html. Data deletion: https://agentsales.agentpey.com/legal/eliminacion-de-datos.html.

## 5. Instrucciones para el revisor (para pegar en el formulario)

> **App:** AgentPey — https://agentsales.agentpey.com (web). Access is by invitation only; use the test account below.
>
> **Test account:** email `meta-review@agentpey.com` · password: *[entered in this form]*. It belongs to a demo brand ("AgentPey Demo") with one sample post ready to approve. No two-factor step is needed.
>
> **You need:** an Instagram **professional** account (Business or Creator) that you control. AgentPey will publish one sample image post to it.
>
> **Steps**
> 1. Open https://agentsales.agentpey.com and sign in with the test account.
> 2. Open **Cuentas** (Accounts) in the menu and press **Conectar Instagram** (Connect Instagram).
> 3. On the Instagram screen, sign in with your test account and allow the requested permissions (`instagram_business_basic` and `instagram_business_content_publish`).
> 4. You return to AgentPey. **Cuentas** now shows your Instagram username as connected (this is the use of `instagram_business_basic`).
> 5. Open **Contenido** (Content) and the post "Sample post for Meta review". Review the caption and press **Aprobar** (Approve).
> 6. Press **Publicar en Instagram (en vivo)** (Publish on Instagram) and confirm. After a few seconds the post shows as published, with a link. Open your Instagram account to see it (this is the use of `instagram_business_content_publish`).
> 7. To remove the connection, remove the app from Instagram (Settings → Apps and websites) or follow https://agentsales.agentpey.com/legal/eliminacion-de-datos.html. AgentPey then disconnects the account and deletes the stored Instagram data.
>
> The interface is in Spanish; button names are in bold above. Contact: vicente@agentpey.com.

*(En tu prueba del §2 paso 3, confirma que los botones se llaman así antes de pegar el texto.)*

## 6. Guion de los videos (uno por permiso)
Formato: 1080p o más, **sin audio**, con subtítulos en inglés agregados al editar (por ejemplo en iMovie). Usa el cursor grande (Mac: Ajustes → Accesibilidad → Pantalla → Tamaño del puntero) y un solo take si se puede. Graba en una ventana de navegador limpia, con `agentsales.agentpey.com` visible en la barra. Para grabar: Cmd+Shift+5 → «Grabar una parte de la pantalla».

### 6.1 Video de `instagram_business_basic` (≈1 min)
1. Barra de direcciones con `agentsales.agentpey.com`; entrar con `meta-review@`. *Subtítulo: "The business signs in to AgentPey".*
2. **Cuentas**, todavía sin Instagram. *"No Instagram account connected yet".*
3. Apretar **Conectar Instagram**; se abre el inicio de sesión de Instagram.
4. Entrar con la cuenta de prueba y mostrar la pantalla de permisos, de modo que se lea lo que se pide. Apretar **Permitir**. *"The business grants the permissions".*
5. De vuelta en **Cuentas**, se ve el usuario conectado. *"AgentPey shows which account is connected (instagram_business_basic)".*

### 6.2 Video de `instagram_business_content_publish` (≈1-2 min)
1. Con la cuenta ya conectada: **Contenido** → «Sample post for Meta review». *"A post prepared in AgentPey".*
2. Mostrar la imagen y el texto, y apretar **Aprobar**. *"The business reviews and approves the caption".*
3. Apretar **Publicar en Instagram (en vivo)** y confirmar. *"The business presses Publish".*
4. Mostrar el estado «publicada» con su enlace, y después el post en Instagram (web o teléfono) con la cuenta de prueba. *"The post is live on the business's Instagram account (instagram_business_content_publish)".*

Para grabar de nuevo hace falta otro post sin publicar: pídele a Claude que cree uno igual en `agentpey-demo`. Hay dos posts de ejemplo: uno para tu video y otro para el revisor. Cada uno sirve para una sola publicación.

## 7. Si Meta pide más o rechaza
- Revisa `vicente@agentpey.com`: ahí llegan los resultados.
- Los rechazos más comunes son dos: el revisor no pudo llegar a la función (usuario, contraseña o marca apagada) o el video no muestra el permiso otorgado. Corrige y vuelve a enviar, y pásale a Claude el motivo tal como lo escribió Meta.
- Cambiar los ajustes de la app después de enviar puede reiniciar la revisión.
- **Las páginas legales todavía dicen «AgentSales» y hablan de corredores de propiedades,** mientras la app en Meta se llama AgentPey. El revisor puede comparar los nombres. Claude puede preparar la actualización de `privacidad`, `terminos` y `eliminacion-de-datos`, pero tú las aprobaste el 2026-10-20 y el cambio va con tu OK.
- Después de la aprobación, una vez al año toca el **Data Use Checkup**. Si no se hace, Meta puede quitar el acceso.
