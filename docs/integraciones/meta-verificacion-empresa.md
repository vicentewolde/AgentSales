# Meta: verificar el negocio con Certilink SpA

Nota hecha el **2026-10-19** para decidir cómo hacer la verificación del negocio (Business Verification) y la verificación de acceso como proveedor técnico (Access Verification / Tech Provider) que Meta exige antes del App Review de `instagram_business_basic` e `instagram_business_content_publish`. Complementa `docs/integraciones/instagram.md` (§12 y §13, del 2026-10-16 y 2026-10-18); lo que ya está ahí no se repite. El kit del trámite está en `docs/11-app-review-meta.md`.

Convención: **DOC** = documentación oficial de Meta; **NO OFICIAL** = blogs, guías de proveedores, foros (solo pista); **INFERENCIA** = deducido por mí; **NO VERIFICADO** = falta una prueba real. No se hizo ninguna llamada a la API de Meta ni se inició sesión en nada: solo se leyó documentación pública.

**Aviso de método (importante).** Las páginas de desarrolladores de Meta (`developers.facebook.com`) se leyeron bien. Las del Centro de ayuda para empresas (`facebook.com/business/help/...`) casi no rinden texto con esta herramienta: solo se pudieron leer dos en su versión móvil (`m.facebook.com/help/2058515294227817`, cómo verificar el negocio, y `m.facebook.com/help/159334372093366`, subir documentos oficiales). Otras cuatro vinieron vacías (¿por qué se rechazó?, información sobre la verificación, crear un portafolio, agregar personas). Cuando uso algo de esas cuatro, viene de un **resumen de buscador** y lo marco "DOC (resumen de buscador)". Antes de subir un solo archivo, abre esas páginas tú en el navegador y confirma. Las citas son cortas y pueden tener paráfrasis.

---

## 1. Resumen (la respuesta corta)

- **Sí, una SpA chilena con inicio de actividades encaja** como «entidad comercial legal». Es el caso normal para este trámite. INFERENCIA fuerte (Meta pide «una entidad comercial legal» y habla de «estatutos de la sociedad»; no nombra a Chile ni a las SpA).
- **Meta no publica una lista de documentos por país.** La página oficial de documentos da una lista general de cinco tipos. Para Chile, lo que se ve en internet (una guía chilena de octubre 2026, NO OFICIAL) es: **e-RUT del SII + escritura o extracto de constitución**. Lo que Meta te ofrece de verdad se ve solo dentro de Business Manager al pulsar «Iniciar verificación».
- **Lo que más rechaza es que los datos no coincidan** letra por letra: nombre legal, dirección, teléfono y sitio web. Y el sitio web: debe cargar, ir por HTTPS y parecer del negocio. Aquí está tu punto débil: el sitio es `agentsales.agentpey.com`, de un dominio personal tuyo, no de Certilink.
- **Tú, como representante legal, necesitas «control total» del portafolio de Certilink.** Tu cuenta personal de Facebook sirve para entrar; conviene un segundo administrador.
- **La app `AgentSales-IG` se conserva** y se vincula al portafolio de Certilink (en el panel de la app, Configuración > Básico). No hay que crear otra.
- **La verificación de acceso (Tech Provider)** es para negocios, no personas, y Certilink SpA prestando el servicio a corredores calza con la definición. Es un paso aparte, de unos 5 días, y viene después de la verificación del negocio.
- **Las páginas legales conviene cambiarlas** para que el responsable sea Certilink SpA, si Certilink es quien opera AgentSales (sección 7).

---

## 2. Requisitos de cuenta y de empresa

### 2.1 ¿Califica una SpA con inicio de actividades?

| Punto | Qué dice | Marca |
|---|---|---|
| Quién puede verificar | «Los propietarios de portfolios comerciales con control total pueden verificar su negocio» | DOC (consultada 2026-10-19: https://m.facebook.com/help/2058515294227817) |
| Contra qué se compara | «Verifica que los detalles que ingreses coincidan exactamente con la información de tu entidad comercial legal» | DOC (misma página) |
| Qué datos se piden | «el nombre legal, la dirección, el número de teléfono y el sitio web» | DOC (misma página) |
| Cuándo pide documentos | Solo si Meta no encuentra un registro que coincida: eliges «Mi negocio no aparece» o «Ninguno coincide» y entonces pide «una licencia comercial o los estatutos de la sociedad» | DOC (misma página) |
| Si pagas con facturación mensual | «no es necesario que presentes la documentación» (la línea de crédito debe ser tuya, no compartida) | DOC (misma página). No aplica a AgentSales: no pagas anuncios |
| «Puede que no sea elegible» | En el Centro de seguridad se ve «Iniciar verificación» o «No elegible para la verificación»; el negocio debe estar registrado ante las autoridades locales | NO OFICIAL (copia de un texto de Meta en https://support.chatarchitect.com/books/meta-business-portfolio-setup/page/about-business-verification-in-meta-business-suite) |
| Una SpA en particular | Ninguna página de Meta nombra «SpA», «Chile», «sociedad por acciones» ni «inicio de actividades» | NO VERIFICADO |

**Conclusión:** una sociedad inscrita (Registro de Empresas y Sociedades) y con RUT activo en el SII es una entidad legal sin dudas. Lo que no está probado es cómo lo muestra el formulario de Meta para Chile.

### 2.2 Documentos que acepta Meta

**Lista general (DOC, consultada 2026-10-19: https://m.facebook.com/help/159334372093366, «Subir documentos oficiales para verificar tu negocio»).** Los documentos deben permitir validar «el nombre legal del negocio y su dirección postal o número de teléfono oficiales». Tipos:

1. Certificado de constitución o estatutos de la sociedad.
2. Registro o licencia del negocio.
3. Documento fiscal oficial del negocio (puede ser un certificado fiscal). **No se aceptan los documentos fiscales preparados por el propio negocio.**
4. Extracto bancario del negocio.
5. Factura de servicios públicos: **solo** para validar la dirección y el teléfono, debe llevar el nombre legal del negocio y **no sirve para validar el nombre legal**.

Reglas: documentos vigentes y emitidos por las autoridades que corresponden; ocultar datos personales que no hacen falta; el **español está entre los idiomas aceptados**, así que no hace falta traducir. La página no dice formatos ni tamaños de archivo. (Una guía NO OFICIAL habla de .jpg, .png y .pdf, a color y sin recortes.)

**Lista por país: NO existe en esa página.** No hay una tabla oficial por país que yo haya podido abrir. Una guía de un proveedor (Wati, NO OFICIAL: https://support.wati.io/es/articles/11463208-verificacion-de-negocios-de-meta-documentos-requeridos-por-pais) sí tiene una lista por país, pero trae Brasil, India, Reino Unido, EE. UU. y otros, **sin Chile**.

**Lo que dicen las guías sobre Chile (NO OFICIAL, no lo tomes como cierto):** una guía chilena de WhatsApp Business, marcada «Actualizado octubre 2026» (https://guiawabusiness.cliengo.com/verificar-empresa-meta-business-manager, leída 2026-10-19), pone para Chile: **«e-RUT del SII»** y **«Escritura o extracto de constitución»**. Para dirección o teléfono, la regla general: una factura de servicios o un extracto bancario a nombre legal de la empresa. La propia guía dice que no está afiliada a Meta.

**Cómo calzan tus documentos chilenos (INFERENCIA, de las dos listas):**

| Documento de Certilink | Tipo de Meta al que calza | Comentario |
|---|---|---|
| Certificado de estatuto actualizado (Registro de Empresas y Sociedades, `tuempresaenundia.cl`) | 1. Constitución o estatutos | Es el documento más cercano a «los estatutos de la sociedad». Tiene valor de instrumento público (art. 22, Ley 20.659, según un certificado oficial leído en un buscador) |
| Escritura o extracto de constitución | 1. Constitución o estatutos | La guía chilena lo nombra. Tiene la razón social exacta y el domicilio |
| Certificado de vigencia de la sociedad | 2. Registro del negocio | Prueba que la sociedad existe y no está disuelta. No lo nombra ninguna fuente de Meta: **NO VERIFICADO** que el formulario lo acepte |
| e-RUT / certificado de inscripción en el RUT y declaración de inicio de actividades (SII) | 3. Documento fiscal oficial | Lo emite el SII, no el negocio. Es lo que la guía chilena nombra. Tu «certificado de inicio de actividades» probablemente es este PDF: el nombre exacto que muestre Meta es **NO VERIFICADO** |
| Carpeta tributaria electrónica | 3. Documento fiscal oficial (dudoso) | **Evítala si puedes.** Incluye declaraciones que presenta la propia empresa, y Meta dice que no acepta documentos fiscales preparados por el negocio. INFERENCIA |
| Comprobante de domicilio o de teléfono | 4. Extracto bancario o 5. factura de servicios | Debe estar **a nombre de Certilink SpA**. Una cuenta de luz o internet a tu nombre personal no sirve para esto (la factura debe llevar el nombre legal del negocio). Si Certilink no tiene cuenta bancaria o cuentas de servicios, es un obstáculo real |
| RUT de la persona (cédula) | No es un tipo de la lista | Solo si Meta pide identidad (sección 4.3) |

### 2.3 Costos

Ninguno documentado para la verificación del negocio ni para la de acceso (INFERENCIA; la documentación no habla de precio). Obtener los certificados del Registro de Empresas y Sociedades y del SII puede tener un costo menor o ser gratis según el certificado: **NO VERIFICADO**, mira el precio al pedirlos.

---

## 3. Qué debe coincidir y qué pasa con tu sitio web

### 3.1 Lo que debe coincidir

- **Nombre legal, dirección, teléfono y sitio web** deben coincidir **exactamente** con la entidad legal (DOC, página de cómo verificar). Hay que copiar la razón social tal cual aparece en la escritura o el e-RUT, con su sufijo (por ejemplo «SpA» o «SPA»; mira cuál usa el documento, mayúsculas incluidas).
- **El nombre legal del portafolio** hay que ponerlo en la configuración del negocio igual al documento. Si el documento y el portafolio no coinciden, Meta dice que puedes actualizar el nombre legal en «Configuración del negocio» (DOC, resumen de buscador de la página «¿Por qué se rechazó mi solicitud?», `es-la.facebook.com/business/help/2342133782492969`; la página no se pudo abrir entera).
- **Si editas los datos del negocio después, hay que verificar de nuevo** (DOC, página de cómo verificar). Por eso: los datos finales primero, la solicitud después, y no tocarlos mientras Meta revisa.
- **Dirección y teléfono:** basta con acreditar uno de los dos, pero lo que escribas debe ser igual a lo que dice el documento. Una variación como «Lvl 4» contra «Level 4» es causa típica de rechazo (NO OFICIAL: https://chakrahq.com/article/meta-business-verification-rejected-reasons).

### 3.2 El sitio web

- **DOC (página de cómo verificar):** «asegúrate de que el sitio web de tu negocio se cargue correctamente y cumpla con el protocolo HTTPS». `agentsales.agentpey.com` cumple con HTTPS (certificado de Let's Encrypt) y carga.
- **DOC (resumen de buscador de la página de rechazos):** aunque seas dueño del dominio, el sitio puede no aprobarse «si no puede verse o no parece pertenecer al negocio»; y el **dominio del correo y la dirección web deben coincidir**.
- **El problema real:** hoy la raíz de `agentsales.agentpey.com` es una pantalla de ingreso por invitación; el nombre «Certilink» no aparece en ninguna parte (las páginas legales dicen «Vicente Wolde Cepeda»). Un revisor que abra el sitio no verá que pertenece a Certilink SpA. Eso es el riesgo, no una regla escrita: **ninguna página de Meta dice que el sitio deba estar en un dominio de la empresa ni que un subdominio de un dominio personal sea rechazado** (NO VERIFICADO).
- **Qué hacen las guías (NO OFICIAL):** piden que el pie o la página de contacto muestre la razón social, la dirección y el teléfono, y que si el nombre comercial difiere del legal, el sitio relacione ambos (ver https://docs.360dialog.com/docs/waba-management/whatsapp-business-verification/meta-business-verification y https://api.support.vonage.com/hc/en-us/articles/4404796719764-How-to-Resolve-Issues-with-Meta-Business-Verification). Un caso de proveedor (consultora que vende aprobaciones, poco fiable) cuenta que la política de privacidad en un dominio y la app en otro puede frenar la revisión por sí sola (https://singhamandeep.com/?p=1109).
- **Opciones, de más simple a más sólida (INFERENCIA):**
  1. Dejar `agentsales.agentpey.com` y hacer que **se vea que es de Certilink**: una página pública (sin ingreso) con razón social, RUT, domicilio y contacto, y las páginas legales con el mismo texto. El correo `vicente@agentpey.com` ya coincide con el dominio del sitio.
  2. Usar como «sitio web» del portafolio un sitio de Certilink en un dominio de la empresa (si existe), con esos mismos datos, y mantener AgentSales en su subdominio. Riesgo: sitio de la empresa y dominio de la app distintos.
  3. Mover AgentSales a un dominio de Certilink. Es lo más limpio, pero obliga a cambiar muchas cosas ya registradas (sección 7.3).

### 3.3 Verificar el dominio en Business Manager

- **DOC (página de verificación de dominios, `m.facebook.com/help/286768115176155`):** es **gratis**, se hace con una metaetiqueta, un archivo HTML o un registro DNS TXT, y sirve para controlar quién edita vistas previas de enlaces y anuncios. La página **no dice** quién puede hacerlo, si el dominio debe ser del negocio, si sirven subdominios, ni que sea obligatoria para verificar el negocio.
- **DOC (página de cómo verificar):** la verificación de dominio es **una de las formas de confirmar** el negocio (junto a correo, teléfono, SMS o WhatsApp). Si eliges el correo, puede que debas probar que eres dueño del dominio del sitio.
- **Conclusión:** **no es obligatoria** como paso aparte; es una alternativa al código por correo. Con `vicente@agentpey.com` y el sitio en `agentpey.com`, el correo debería bastar (INFERENCIA). Si Meta pide probar el dominio, tú controlas el DNS en Vercel y un registro TXT no toca tu otro proyecto.
- **Ojo (INFERENCIA, no documentado):** reclamar en el portafolio de Certilink el dominio raíz `agentpey.com` podría chocar si tu otro proyecto usa ese dominio en otro portafolio de Meta (un dominio se reclama en un solo portafolio). Si llega a pedirse, probar primero con el subdominio. **NO VERIFICADO.**

### 3.4 ¿Las páginas de privacidad y términos deben nombrar a la empresa?

- **DOC (Platform Terms, `developers.facebook.com/terms/`, leídos 2026-10-19):** la sección 4 pide una política en una URL pública, que diga qué datos se tratan, cómo y para qué, y cómo pedir su eliminación, sin contradecir los términos. **No exige nombrar a la entidad responsable.** La guía de envío de App Review tampoco pide que la URL nombre a la empresa ni que coincida con la app.
- **Pero** el glosario define al desarrollador como «la persona o entidad legal que crea u opera una App», y la sección 1.d dice que, si aceptas «en representación de una entidad legal», declaras tener «la facultad para vincular» (DOC). Si Certilink queda como dueña de la app y del portafolio, lo coherente es que sea también la responsable ante los usuarios. INFERENCIA.
- Dos documentos que digan responsables distintos (el portafolio dice Certilink, la política dice una persona) es una incoherencia que un revisor puede notar. No hay regla escrita: es prudencia.

---

## 4. Tu rol, tu cuenta personal y la identidad

### 4.1 Rol en el portafolio

- **DOC:** solo quien tiene **control total** del portafolio puede iniciar la verificación (página de cómo verificar). Las guías de Meta para desarrolladores lo repiten: solo alguien con rol de **Admin** en el negocio puede completarla; un administrador de la app solo puede conectar la app al negocio (https://developers.facebook.com/docs/development/release/business-verification).
- Como socio y representante legal, **tú creas el portafolio de Certilink y quedas con control total**. No necesitas permiso de nadie.

### 4.2 ¿Tu cuenta personal de Facebook puede administrar un portafolio de una SpA?

- **DOC (resumen de buscador de la ayuda «Agregar personas»):** quien tiene control total agrega personas; la invitación va al correo de su cuenta de Facebook, o se usan cuentas administradas de Meta (managed Meta accounts).
- **INFERENCIA:** sí, es lo habitual para empresas chicas: tu cuenta personal es la administradora y representa a la sociedad. **No encontré una página de Meta que lo prohíba ni que lo exija.** Lo que sí importa:
  - La app pide que, al aceptar los términos «en representación de una entidad legal», tengas facultades (tú las tienes: eres el representante legal).
  - Si tu cuenta personal se restringe o se bloquea, **pierdes el portafolio y la verificación**. Conviene un **segundo administrador** (otra persona de confianza o una segunda cuenta tuya) y la **verificación en dos pasos** activada. Un proveedor lo dice también (NO OFICIAL).
  - **NO VERIFICADO:** si Meta, al crear el portafolio con tu cuenta, exige que la cuenta tenga cierta antigüedad o actividad. Una guía (NO OFICIAL, https://help.blip.ai/hc/en-us/articles/25991624092439) habla de perfiles nuevos que deben usarse al menos 7 días antes; no aplica a tu cuenta antigua.

### 4.3 ¿Se exige verificación de identidad de la persona (Individual Verification)?

- **DOC:** la página de verificación del negocio solo menciona «Individual Verification» como paso previo de quien ya la hizo y no la explica (consultada 2026-10-19).
- **DOC (historial):** Meta la creó en 2018 para desarrolladores sin empresa; la **pausó el 24 de marzo de 2020** y la **reanudó el 6 de abril de 2021** (https://developers.facebook.com/blog/post/2020/03/24/pausing-individual-verification/). El 1 de febrero de 2023 Meta anunció que, **una vez completada la verificación del negocio, la verificación individual deja de dar acceso** (https://developers.facebook.com/blog/post/2023/02/01/developer-platform-requiring-business-verification-for-advanced-access/). La página no dice qué pueden hacer los desarrolladores sin empresa.
- **Conclusión:** no necesitas hacerla para verificar a Certilink. **Que hoy exista y sirva para el acceso avanzado: NO VERIFICADO**, y no la necesitas.
- **Posible pedido de identidad (DOC, resumen de buscador de la página de rechazos):** Meta puede pedir una foto del documento de identidad en el proceso, con consejos (las cuatro esquinas, horizontal, sin retoques). Si pasa, es tu cédula, como administrador. Se puede apelar con más información y, si no entregas lo pedido **en una semana, hay que empezar de nuevo**. Tenlo a mano.

---

## 5. Cómo se relaciona `AgentSales-IG` con el portafolio

### 5.1 Lo que dice la doc

- **DOC (crear una app de Instagram, leída 2026-10-19):** debes conectar la app a un negocio **verificado** antes de publicarla, y se puede hacer en cualquier momento en **App settings > Basic**. Tu app debe ser de tipo Business (ya lo es).
- **DOC (verificación del negocio):** cualquier **administrador de la app** puede conectarla a un negocio (Configuración > Básico > Verificación). Si el negocio no existe, se puede crear en ese paso. Conectar uno ya verificado completa el trámite de la app.
- **DOC (transferir una app, https://developers.facebook.com/documentation/development/create-an-app/transfer-an-app.md):** para pasar la app a **otro negocio** hace falta ser administrador de la app **y** administrador del negocio original. Para una app de tipo «App Type»: App settings > Basic > Verificación > **Remove**, luego **Start Verification** y elegir el negocio de destino (verificado o no). Para una app con «Use Case» (la página de Instagram habla de «use case», así que probablemente es tu caso; míralo en tu panel, NO VERIFICADO): Review > Verification > Remove, completar el retiro en Business Settings > Apps, y volver a **Start Verification**. Hay también «+ business portfolio» en App settings > Basic, pero esa ruta es para pasar la app a una **cuenta administrada**, y la doc dice que **«Once approved, this action cannot be undone»**: no es lo que buscas, no la uses sin leerla entera.
- **DOC (Tech Providers):** una empresa deja de estar verificada como proveedor técnico si se desconecta la app del negocio que la creó o reclamó. Se recupera sola al revertirlo.
- **DOC (roles):** con la app conectada a un portafolio, **los roles se manejan desde Business Manager** («you must use the Business Manager to manage roles for your app»). Con el portafolio verificado, la app puede tener hasta 500 entre analistas y testers.
- Un proveedor (NO OFICIAL) dice que una app solo puede estar conectada a **un** portafolio a la vez, y que cambiar los administradores de la app **no** cambia el portafolio dueño.

### 5.2 Qué falta saber de tu app (NO VERIFICADO)

- **Si `AgentSales-IG` hoy está conectada a algún portafolio** (por ejemplo uno personal que Meta creó al hacerte desarrollador). Se ve en el panel de la app: Configuración > Básico > Verificación. Si ya hay uno, hay que **quitarlo y empezar la verificación eligiendo el de Certilink**; si no hay ninguno, basta con **Start Verification** y elegir Certilink.
- **Qué pasa con los roles, los testers de Instagram y los tokens al moverla:** la doc no lo dice. INFERENCIA: los roles se mantienen pero pasan a administrarse en Business Manager; los tokens ya generados (los de 60 días) deberían seguir, porque son de la app y no del portafolio. Se prueba después de conectar con **`pnpm ig:smoke`** (crea un contenedor sin publicar). Si el token no sirve, se vuelve a generar.
- **Si Meta pide aceptar de nuevo los términos «en representación de Certilink»:** no lo dice. Lo verás en pantalla.
- **Crear una app nueva dentro del portafolio de Certilink** también es posible, pero **no la recomiendo**: perderías el ID y el secreto de Instagram, las tres direcciones de OAuth y de callbacks, el ícono, las URL de privacidad y de eliminación y el rol de tester, todo ya configurado.

### 5.3 Orden

Conectar la app al portafolio **antes** de enviar el App Review: la doc dice que cambiar los ajustes básicos después de enviar «may require re-review». Y verifica antes la sección 6 de `docs/11-app-review-meta.md`.

---

## 6. Verificación de acceso (Tech Provider)

**DOC (https://developers.facebook.com/docs/development/release/access-verification, leída 2026-10-19):**

- Es el proceso con que Meta decide «if a business operates as a Tech Provider». Aplica cuando una app creada o reclamada por una empresa **la usan otras empresas** y pide ciertos permisos; esa empresa «must be verified as a Tech Provider before other businesses can use the app». La página de acceso lista `instagram_business_basic` e `instagram_business_content_publish` entre los permisos (lectura de mi nota del 2026-10-18, §13.1). **Ojo:** la página de «Tech Providers» que leí hoy lista 24 permisos y la de acceso 34; confirma en tu panel que ambos permisos aparecen.
- **Requisitos:** la verificación del negocio **completa**, la cuenta del negocio **sin restricciones**, y que un administrador del negocio **categorice y describa «how the business uses other businesses' data to provide a service for those businesses»**. La página no da más guía sobre categorías, nivel de detalle ni redacción.
- **Quién:** la verificación aplica a **negocios**; no describe a personas como solicitantes (por eso la SpA sirve y una persona suelta no está clara). Los usuarios con rol en la app no pasan por el chequeo.
- **Dónde:** App Dashboard > Basics > Verifications > Access verification, o el enlace del correo.
- **Plazo:** decisión en «aproximadamente 5 días» (en la entrada de blog de 2022: «normalmente tardará cinco días hábiles»). Es independiente del App Review.
- **Si falla:** el administrador recibe un correo y la app un aviso; las llamadas de usuarios sin rol devuelven el error `100`. La página no lista causas de rechazo. Se puede volver a pasar el proceso si cambia el caso de uso; no hay plazo de espera ni tope de intentos documentados.
- **Platform Terms (DOC, 5.b):** un Tech Provider usa la plataforma y los datos «en representación de tu Cliente», los mantiene separados de los de otros clientes, y debe cortar el acceso de un cliente si Meta lo pide. El modelo `Broker` de AgentSales ya separa los datos por corredor.

**¿Encaja una SpA que presta el servicio a corredores independientes? Sí, INFERENCIA fuerte.** La definición de Meta es una empresa con «necesidad legítima de acceder a datos de empresas» que pertenecen a otras, para darles un servicio (https://developers.facebook.com/docs/development/release/tech-providers). Dos cosas por probar: (1) la doc no dice cómo trata Meta a clientes que son **personas con una cuenta profesional de Instagram sin portafolio comercial**, como un corredor independiente (NO VERIFICADO); (2) la página de Tech Providers no responde si una empresa que atiende a negocios independientes califica: lo dice por definición, no por ejemplo.

**Cómo describirlo (para el formulario).** Ya hay un borrador en `docs/11-app-review-meta.md` §4.3, con el nombre entre corchetes. Ideas para que Meta lo entienda: quién opera (Certilink SpA), a quién sirve (corredores independientes de propiedades), qué dato toca (ID y nombre de usuario de la cuenta de Instagram, el token cifrado, el contenido que el propio corredor aprueba publicar), para qué (publicar en su cuenta, a su pedido, nada más), cómo se separa por corredor y cómo se borra. No inventes volumen ni clientes que no existen.

---

## 7. Plazos, rechazos y qué hacer

### 7.1 Plazos

| Etapa | Plazo | Marca |
|---|---|---|
| Verificación del negocio | «hasta 14 días laborables» (una guía chilena dice «entre 10 minutos y 14 días hábiles») | DOC (página de cómo verificar) |
| Verificación de acceso | «aproximadamente 5 días» | DOC |
| App Review | «una decisión en una semana» | DOC (guía de envío) |
| Reportes reales | Verificación «en revisión» 10 días o más, bloqueando el App Review (foro de la comunidad de Meta); una verificación de acceso rechazada «esperando 16 días» (hilo de hace unos 2 años) | NO OFICIAL (https://developers.secure.facebook.com/community/threads/467668889451508) |

Suma documentada: unas **5 semanas** sin rechazos (la misma cuenta de mi nota del 2026-10-18). Es una **cifra mía**, no de Meta. Cada rechazo suma días.

### 7.2 Causas de rechazo y qué hacer

- **DOC (resumen de buscador de la página de rechazos de Meta):** documento no admitido; documento sin firma o sello oficial, hecho por el propio negocio; documento vencido; **nombre o dirección distintos** del portafolio; documento ilegible o sin el nombre del negocio (por ejemplo, una factura que solo muestra un teléfono); idioma no admitido; sitio web que no carga o «no parece pertenecer al negocio»; dominio del correo distinto del sitio.
- **NO OFICIAL (https://chakrahq.com/article/meta-business-verification-rejected-reasons y https://api.support.vonage.com/hc/en-us/articles/4404796719764):** el nombre con el sufijo omitido («Ltd», «SpA») es la causa más común; la web sin el nombre legal; teléfonos que no coinciden; escaneos borrosos; una pregunta de Meta sin responder que cierra el caso como rechazado.
- **Si piden más documentos:** responder en la misma solicitud, en **menos de una semana** (si no, hay que empezar de nuevo; DOC, resumen de buscador). Se puede apelar con más información. No reenviar de inmediato lo mismo: corregir la causa, esperar y reenviar (NO OFICIAL). No cambiar nombre, dirección o dominio durante la revisión.
- **Chile y Latinoamérica:** **no encontré reportes específicos de Chile** en fuentes confiables. Todo lo anterior es general. NO VERIFICADO.
- **Personas naturales y empresas no registradas:** no encontré una página de Meta que trate a un empresario individual o a quien no tiene empresa (la doc de desarrolladores solo menciona la Individual Verification, sección 4.3). Una guía de proveedor (NO OFICIAL, poco fiable) habla de una opción «negocio no registrado / representado por una persona» y un caso de Shopify cuenta que un comerciante individual del Reino Unido no pudo seguir porque el formulario pedía un número de registro de empresa. **Con Certilink SpA no hace falta nada de eso.**
- **Después de aprobar la verificación,** pueden aparecer las «preguntas de manejo de datos» (se evalúan casi al instante; DOC, guía de envío).

---

## 8. Implicancias para el proyecto

### 8.1 ¿Conviene que el cliente final y los términos digan «Certilink SpA»?

**Sí, si Certilink es quien de verdad opera AgentSales** (quien cobrará, firma con los corredores, responde por los datos). INFERENCIA, por tres razones: (1) Meta verifica a la empresa y el App Review/Tech Provider habla de «el negocio»; (2) los Platform Terms 5.b exigen tratar los datos «en representación» de cada cliente, lo que se apoya en un contrato con un contratante claro; (3) la Ley 21.719 de datos personales (que, según fuentes secundarias, entra en vigencia el 2026-12-01 salvo que se apruebe el proyecto de postergarla un año; NO VERIFICADO contra la BCN, estado a septiembre 2026) distingue al responsable del tratamiento, y conviene que un abogado lo revise.

**Páginas que dirían algo distinto hoy (no las edité):**

| Archivo | Línea | Hoy dice | Cambio sugerido |
|---|---|---|---|
| `apps/web/public/legal/privacidad.html` | 16 (sección «Quién es responsable») | «La opera Vicente Wolde Cepeda, en Chile.» | Certilink SpA, RUT, domicilio; el correo de contacto puede seguir |
| `apps/web/public/legal/terminos.html` | 16 | «La opera Vicente Wolde Cepeda, en Chile.» | Igual; y revisar a quién se le acepta (la parte contratante) |
| `apps/web/public/legal/eliminacion-de-datos.html` | — | No nombra a nadie | Sin cambio obligatorio |
| `docs/11-app-review-meta.md` | §4.3 | El nombre entre corchetes | Decidir y quitar los corchetes |
| `docs/07-checklist-cuentas.md` | línea 131 | «tus datos: Vicente Wolde Cepeda» | Actualizar al decidir |

**El correo de contacto** (`vicente@agentpey.com`) va en el panel de la app para que lleguen los resultados del App Review. Sirve. Un correo del dominio de Certilink calzaría más, pero no hay regla.

### 8.2 Qué decidir antes de empezar el trámite

1. **¿Quién opera AgentSales: Certilink SpA o tú como persona?** Define el nombre en las páginas legales, el contratante de los corredores y la descripción de Tech Provider. Lo ideal es una sola respuesta en todos lados.
2. **El sitio web que irá en el portafolio** (sección 3.2): una página pública en `agentsales.agentpey.com` con la razón social, o un sitio de Certilink.
3. **El dominio.** Mudar AgentSales a un dominio de Certilink obliga a cambiar y volver a registrar: las tres direcciones de Meta (redirect OAuth, desautorización, eliminación de datos), las URL de privacidad y términos en el panel de la app, el CORS de los dos buckets de R2, el certificado y los registros en Fly, `PUBLIC_URL` y las instrucciones al revisor, y la redirect URI de Mercado Libre. Es trabajo y riesgo de re-revisión: **si hay que mudarse, mejor ahora que durante el App Review.** Recomendación: no mudar salvo que Meta rechace por el sitio.
4. **El nombre comercial.** El portafolio y la razón social son «Certilink SpA»; la app y el producto son «AgentSales». Que el sitio muestre ambos relacionados («AgentSales es un producto de Certilink SpA»). INFERENCIA, a partir de las guías de proveedores.
5. **Datos exactos:** razón social (con sufijo y mayúsculas), RUT, domicilio y un teléfono que contesten, tal cual los documentos.
6. **Un segundo administrador** del portafolio.
7. **¿Hay ya algún portafolio** (personal o de Certilink) y a cuál está conectada `AgentSales-IG`?

---

## 9. Cómo probar sin riesgo

- **Costo cero para ver qué pide Meta:** crear el portafolio de Certilink con los datos exactos y pulsar «Iniciar verificación» en Centro de seguridad, solo para ver qué métodos de confirmación y qué documentos ofrece para Chile. Se puede detener antes de subir nada. Es lo que `docs/ESTADO.md` ya te pedía.
- Revisar en el panel de la app si aparece «Tech Provider» y cuáles son los pasos antes de pedir nada.
- Tras conectar la app al portafolio: `pnpm ig:smoke` con la cuenta del operador (no publica).
- No hay modo sandbox para la verificación: es un trámite real con documentos reales.

---

## 10. Riesgos y términos relevantes

- **Datos falsos o negocio ajeno:** Meta avisa que dar información falsa o intentar verificar un negocio que no estás autorizado a representar puede impedir la verificación o afectar la cuenta (DOC). Tú sí representas a Certilink; ten a mano la escritura que lo acredite.
- **Los datos de verificación pueden volverse públicos** (NO OFICIAL, varios proveedores): piensa en el domicilio que escribirás.
- **Perder la verificación:** si el portafolio queda sin verificar, la app se desconecta del negocio o la cuenta se restringe, se pierde el estado de Tech Provider (DOC) y las llamadas con acceso avanzado fallan.
- **Data Use Checkup anual y auditoría:** ya descritos en la nota de Instagram, §13.1.
- **Cambiar la función de la app** obliga a volver a enviarla a revisión (Platform Terms 3.a.vii, ya anotado).
- **Una sola cuenta personal como único administrador** es un punto único de falla (sección 4.2).
- **Ley 21.719:** que un abogado revise las páginas legales con el responsable ya definido.

---

## 11. Qué haría yo, en orden

1. **Contestar las siete preguntas de la sección 8.2**, sobre todo la 1 (quién opera AgentSales), la 2 (el sitio web) y la 7 (si ya existe un portafolio).
2. **Reunir los documentos de Certilink SpA:** e-RUT del SII; certificado de estatuto actualizado y de vigencia (`tuempresaenundia.cl`); escritura o extracto de constitución; un estado de cuenta bancario de la empresa o una cuenta de servicios **a nombre de Certilink SpA** (para dirección o teléfono). Copiar de ahí la razón social, el RUT, el domicilio y el teléfono. No uses la carpeta tributaria si puedes evitarla.
3. **Abrir en tu navegador** las páginas de ayuda de Meta que no pude leer (por qué se rechaza, información sobre la verificación, crear un portafolio, agregar personas) y confirmar mi resumen.
4. **Crear (o usar) el portafolio de Certilink SpA** en Meta Business Suite con tu cuenta personal, con la razón social, la dirección, el teléfono y el sitio web **exactos**. Activar la verificación en dos pasos. Agregar a un segundo administrador.
5. **Pedirle a Claude, en otra tarea con su propio plan, los cambios previos:** páginas legales con Certilink SpA como responsable y una página pública con razón social, RUT, domicilio y contacto en el sitio que pondrás en el portafolio (y avisar si se decide mudar de dominio). Que quede en producción **antes** de iniciar la verificación. (Eso lo despliegas tú.)
6. **Pulsar «Iniciar verificación»** y mirar qué documentos y qué métodos de confirmación ofrece para Chile. Si no encuentra un registro, elegir «Mi negocio no aparece». Confirmar por un correo en el mismo dominio del sitio (o, si lo pide, por un registro DNS TXT en el DNS que ya manejas). Subir los documentos. **No tocar los datos del negocio mientras revisan.**
7. **Responder a Meta en menos de una semana** si pide algo más. Si rechaza, leer el motivo en el Centro de seguridad, corregir esa causa y reenviar.
8. **Conectar `AgentSales-IG` al portafolio de Certilink** (Configuración > Básico > Verificación; si ya estaba en otro, primero «Remove»). Probar `pnpm ig:smoke` y mirar que el tester y los permisos siguen.
9. **Pedir la verificación de acceso** (App Dashboard > Basics > Verifications > Access verification) con la descripción de `docs/11-app-review-meta.md` §4.3 ya con «Certilink SpA». Unos 5 días.
10. **Sólo entonces,** terminar el kit del App Review (`docs/11-app-review-meta.md`) y hacer **las llamadas exitosas dentro de los 30 días antes de enviar**; no las hagas antes de tiempo.
11. Anotar aquí y en `docs/ESTADO.md` lo que Meta pidió de verdad en Chile y cuánto tardó, para cerrar los NO VERIFICADO.

---

## 12. Lo que sigue NO VERIFICADO

1. Qué tipos de documento ofrece el formulario de Meta para **Chile**, y si acepta el certificado de vigencia, la carpeta tributaria o el e-RUT.
2. Que una **SpA con inicio de actividades** pase sin pedidos extra (no se probó nada).
3. Si un **sitio en un subdominio de un dominio personal** (`agentsales.agentpey.com`) es aceptado como sitio de Certilink, y si hace falta un dominio de la empresa.
4. Si la **verificación de dominio** es obligatoria, si sirve un subdominio, y si reclamar `agentpey.com` choca con tu otro proyecto.
5. Si una **cuenta personal de Facebook** puede ser la única administradora sin problemas, y si Meta exige antigüedad o actividad de la cuenta.
6. Si Meta pide **identidad de la persona** (cédula) en tu caso, y si la Individual Verification sigue existiendo.
7. Si `AgentSales-IG` ya está conectada a un portafolio y **qué pasa con roles, testers y tokens** al moverla.
8. Si Meta pide **aceptar de nuevo los términos en nombre de Certilink** al conectar la app.
9. Cómo trata la **verificación de acceso** a clientes que son personas con cuenta profesional, sin portafolio comercial.
10. Que `instagram_business_basic` e `instagram_business_content_publish` estén en la lista de la verificación de acceso en tu panel (las páginas de Meta difieren: 24 y 34 permisos), y el nombre exacto del segundo permiso en la solicitud (ya anotado en la nota de Instagram, §13.1).
11. Plazos reales de la verificación de acceso y de la revisión **en Chile**.
12. Costo de los certificados chilenos (Registro de Empresas y Sociedades y SII).
13. El estado actual de la **postergación de la Ley 21.719** (revisar en el Senado y la BCN).

---

## 13. Fuentes (consultadas el 2026-10-19)

**DOC (Meta):**
- Verificación del negocio, para desarrolladores (quién la necesita, pasos, roles, Individual Verification): https://developers.facebook.com/docs/development/release/business-verification
- Centro de ayuda, cómo verificar el negocio (versión móvil, español; datos exactos, HTTPS, documentos, métodos de confirmación, 14 días laborables): https://m.facebook.com/help/2058515294227817
- Centro de ayuda, subir documentos oficiales (tipos aceptados, idiomas, vigencia; sin lista por país): https://m.facebook.com/help/159334372093366
- Centro de ayuda, verificación de dominios (gratis, tres métodos): https://m.facebook.com/help/286768115176155
- Centro de ayuda, por qué se rechazó la solicitud (solo resumen de buscador; la página no se pudo abrir): https://es-la.facebook.com/business/help/2342133782492969
- Verificación de acceso (requisitos, 5 días, errores, resubmisión): https://developers.facebook.com/docs/development/release/access-verification
- Entrada de blog de la verificación de acceso (2 de junio de 2022): https://developers.facebook.com/blog/post/2022/06/02/access-verification-process-for-tech-provider-apps/
- Tech Providers (definición, pérdida del estado): https://developers.facebook.com/docs/development/release/tech-providers
- Transferir una app (quitar y volver a conectar, ruta «+ business portfolio»): https://developers.facebook.com/documentation/development/create-an-app/transfer-an-app.md
- Roles de la app (se manejan en Business Manager al conectar la app): https://developers.facebook.com/docs/development/build-and-test/app-roles/
- Crear una app de Instagram (conectar un negocio verificado, límite de 15 apps): https://developers.facebook.com/documentation/instagram-platform/create-an-instagram-app
- Caso de uso de Instagram (pasos de Tech Provider): https://developers.facebook.com/documentation/development/create-an-app/instagram-use-case.md
- Guía de envío de App Review (privacidad, plazo de una semana, rechazos): https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review/submission-guide
- Proceso de App Review: https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/app-review
- Platform Terms (1.d, 4.a a 4.d, 5.b, glosario): https://developers.facebook.com/terms/
- Blog, pausa de la verificación individual (24 de marzo de 2020; reanudada el 6 de abril de 2021): https://developers.facebook.com/blog/post/2020/03/24/pausing-individual-verification/
- Blog, verificación del negocio para el acceso avanzado (1 de febrero de 2023): https://developers.facebook.com/blog/post/2023/02/01/developer-platform-requiring-business-verification-for-advanced-access/

**NO OFICIAL (solo pista):**
- Guía chilena de WhatsApp Business (Chile: e-RUT y escritura o extracto; actualizada octubre 2026): https://guiawabusiness.cliengo.com/verificar-empresa-meta-business-manager
- Documentos por país de un proveedor (sin Chile): https://support.wati.io/es/articles/11463208-verificacion-de-negocios-de-meta-documentos-requeridos-por-pais
- Motivos de rechazo (nombre, sitio web, dominio, documentos): https://chakrahq.com/article/meta-business-verification-rejected-reasons
- Resolver problemas de verificación (sitio web con el nombre legal): https://api.support.vonage.com/hc/en-us/articles/4404796719764-How-to-Resolve-Issues-with-Meta-Business-Verification
- Copia de un texto de Meta (elegibilidad, «No elegible»): https://support.chatarchitect.com/books/meta-business-portfolio-setup/page/about-business-verification-in-meta-business-suite
- Caso de verificación de acceso rechazada, 16 días (foro de la comunidad de Meta): https://developers.secure.facebook.com/community/threads/467668889451508
- Perfil de Facebook para un portafolio de empresa: https://help.blip.ai/hc/en-us/articles/25991624092439
- Proveedor que vende aprobaciones (consistencia de dominio; poco fiable): https://singhamandeep.com/?p=1109
- Certificados chilenos (estatuto actualizado, vigencia, Ley 20.659; resultado de buscador) y trámite de inicio de actividades del SII (e-RUT, formulario 4415): https://www.sii.cl/destacados/erut/ y https://ayuda.tgr.cl/hc/es-419/article_attachments/16280110571543
- Ley 21.719 y su postergación (boletín 18.623-07): https://www.garrigues.com/es_ES/noticia/chile-ejecutivo-presenta-proyecto-postergar-entrada-vigor-nueva-ley-proteccion-datos y https://www.carey.cl/gobierno-ingresa-proyecto-de-ley-que-posterga-en-un-ano-entrada-en-vigor-de-la-ley-sobre-proteccion-de-datos-personales
