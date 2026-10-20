# TikTok: Content Posting API (nota de integración, F9)

Verificada el **2026-10-19**, solo lectura (sin llamadas a la API). Se leyó `developers.tiktok.com` con un extractor que resume el texto, así que los números exactos conviene confirmarlos en el portal antes de implementar.

Convención: **DOC** = página oficial leída; **SNIPPET** = visto solo en un resultado de búsqueda; **PISTA** = blog o foro de terceros (varios son vendedores de APIs de TikTok), nunca fuente final; **INFERENCIA** = deducido; **NO VERIFICADO** = falta una prueba real. Lo que no se pudo leer: la página oficial de la auditoría (`developers.tiktok.com/application/content-posting-api`, 401: pide sesión), el portal de TikTok for Business (carga con JavaScript) y las FAQ oficiales (404). Por eso los requisitos formales de la auditoría salen de terceros.

## 1. Resumen
- **Dos formas de publicar:** *Direct Post* (publica solo, con ajustes de privacidad, comentarios, dúo y stitch que elige el usuario; scope `video.publish`) y *Upload* (deja el video como borrador en la bandeja del creador, que lo termina en la app; scope `video.upload`).
- **Sin auditoría de la app, Direct Post deja todo privado** (`SELF_ONLY`) y solo 5 usuarios pueden publicar por 24 horas (DOC). Upload no menciona esa restricción en la doc; tres blogs dicen que funciona sin auditoría (PISTA): **NO VERIFICADO**, es la prueba S6.
- **La auditoría tarda semanas** (1 a 2, 2 a 4 o hasta 6 semanas con más de 12 envíos, según tres blogs: PISTA) y la doc dice que los clientes «no deben limitarse a uso de prueba o interno»: una app que solo publica en las cuentas del operador podría rechazarse (DOC + INFERENCIA).
- **Programar:** no hay parámetro de programación en la API (INFERENCIA); la hora la maneja el calendario de AgentSales.
- **Borrar:** no vi ningún endpoint para borrar un post publicado (INFERENCIA: no existe).
- **Fotos y carruseles:** solo por `PULL_FROM_URL`, que exige un dominio o prefijo de URL verificado en DNS. Las URLs prefirmadas de R2 probablemente no sirven (NO VERIFICADO).

## 2. Direct Post frente a Upload
| | Direct Post | Upload (bandeja) |
|---|---|---|
| Scope | `video.publish` | `video.upload` |
| Video | `/v2/post/publish/video/init/` | `/v2/post/publish/inbox/video/init/` |
| Fotos | `/v2/post/publish/content/init/`, `post_mode=DIRECT_POST` | el mismo, `post_mode=MEDIA_UPLOAD` (app de TikTok 31.8 o superior) |
| Qué pasa | Se publica solo | El creador recibe una notificación y termina el post en la app |
| Sin auditoría | Privado y 5 usuarios por 24 h | La doc no lo restringe; PISTA dice que funciona |
| Tope | ~15 posts por día por creador (PISTA dice 25) | 5 envíos pendientes por 24 h |
| Vigencia del borrador | — | 24 h según un blog (PISTA) |

**Para F9:** *Upload*, solo video. Encaja con la aprobación humana de AgentSales: se aprueba aquí y se termina en la app. Se pierde la publicación automática a la hora programada. Direct Post público se deja para el piloto con la auditoría.

## 3. Auditoría y guías de interfaz
- **Sin auditoría (DOC):** todo el contenido queda restringido a vista privada; solo 5 usuarios por 24 h; las cuentas deben estar en privado al postear (si no, `unaudited_client_can_only_post_to_private_accounts`). Riesgo de diseño: `creator_info` sigue listando `PUBLIC_TO_EVERYONE` sin auditoría y el post sale privado sin error (PISTA).
- **Con auditoría (DOC):** tope de creadores activos por día según tu estimación en la solicitud; ~15 posts por día por creador, compartido entre apps.
- **Requisitos (PISTA):** un video demo del flujo completo (login, consentimiento, compositor armado con `creator_info`, el post), políticas de privacidad y términos accesibles, pedir solo los scopes del demo. Una causa común de rechazo es que el firewall o la protección anti-DDoS bloquee las IP del revisor (cuidado con Cloudflare).
- **Guías obligatorias de Direct Post (DOC, `content-sharing-guidelines`):** consultar `creator_info` al armar la pantalla y mostrar la cuenta destino; validar la duración contra `max_video_post_duration_sec`; título editable; privacidad con menú manual sin valor por defecto; comentarios, dúo y stitch sin marcar por defecto; la declaración «By posting, you agree to TikTok's Music Usage Confirmation» (y la política de contenido de marca si corresponde); un interruptor de contenido comercial apagado por defecto, con «Your brand» y «Branded content» (al menos una al activarlo; el contenido de marca no puede ser privado); vista previa sin marcas de agua; no enviar nada hasta el consentimiento expreso; avisar que el procesamiento tarda; consultar el estado.
- **Etiqueta de IA:** `is_aigc` (por defecto `false`) agrega «Creator labeled as AI-generated», en video y fotos (DOC). Qué contenido debe declararse como IA queda en la política de TikTok: NO VERIFICADO.
- Un agente que promociona su propio negocio inmobiliario cae seguramente en «Your brand» (INFERENCIA; convendría confirmarlo con TikTok o un abogado).

## 4. OAuth (Login Kit)
| Tema | Dato |
|---|---|
| Autorización | `https://www.tiktok.com/v2/auth/authorize/` con `client_key`, `response_type=code`, `scope` separado por comas, `redirect_uri`, `state` (DOC) |
| Token | `POST https://open.tiktokapis.com/v2/oauth/token/` (DOC) |
| Access token | 86.400 s (24 h) (DOC) |
| Refresh token | 365 días; **puede rotar**: hay que guardar el nuevo (DOC) |
| Revocar | `POST /v2/oauth/revoke/` (DOC) |
| Scopes | `user.info.basic`; para publicar `video.publish` o `video.upload`. El usuario puede aceptar solo algunos y el callback trae `scopes` (DOC) |
| Redirect URI | máximo 10, absoluto, `https`, sin parámetros ni fragmento, menos de 512 caracteres (DOC) |
| `localhost` | la doc no lo dice; un blog usa `https://localhost:...` (PISTA). Probarlo |
| PKCE | no se menciona en la página web; solo móvil y escritorio (PISTA) |

## 5. Medios
- **Video (DOC, media-transfer-guide):** MP4 (recomendado), MOV y WebM; H.264 (recomendado), H.265, VP8 y VP9; 23 a 60 FPS; 360 a 4096 px por lado; hasta 4 GB; la duración máxima la da cada creador (`max_video_post_duration_sec`, casi siempre 3 min; el techo de la API son 10 min).
- **Fotos (DOC):** hasta 35 imágenes por post, solo `PULL_FROM_URL`, JPEG y WebP (no PNG), 20 MB por imagen y «1080p máximo», `photo_cover_index` obligatorio, título hasta 90 caracteres y descripción hasta 4000.
- **`FILE_UPLOAD` (video):** trozos de 5 a 64 MB (el último puede llegar a 128 MB), de 1 a 1000 trozos, en orden secuencial; los archivos de menos de 5 MB van en un solo trozo; cada trozo es un `PUT` con `Content-Range` y `upload_url` vale 1 h. No exige verificar dominio.
- **`PULL_FROM_URL`:** HTTPS, sin redirecciones, accesible hasta 1 h, host de dominio (no IP). El dominio se verifica con una firma en DNS; verificar `static.ejemplo.com` cubre sus subdominios pero no `ejemplo.com`. Sin verificar: `url_ownership_unverified`.
- **URLs prefirmadas de R2:** la doc no dice nada. Viven en `<cuenta>.r2.cloudflarestorage.com`, un dominio que no controlas (INFERENCIA: probablemente no sirven; **NO VERIFICADO**). Para fotos haría falta un dominio propio (por ejemplo `media.agentpey.com` sobre R2) que sirva la imagen por HTTPS sin redirección, con una clave imposible de adivinar o un Worker que valide un token.
- **En F9** se usa `FILE_UPLOAD` para video: un job de pg-boss lee de R2 y hace los `PUT` por trozos.

## 6. Límites y estados
| Límite | Valor | Fuente |
|---|---|---|
| Peticiones por token y minuto | `creator_info` 20, init de video 6, init de fotos 6, estado 30 | DOC |
| Posts por día por creador | «típicamente ~15», compartido entre apps (Phyllo dice 25) | DOC contra PISTA |
| Envíos pendientes por 24 h (Upload) | 5 | DOC |
| Caption (`title`) de video | 2200 UTF-16; hashtags y menciones se interpretan en el texto; el máximo de hashtags no se encontró | DOC / NO VERIFICADO |
| Errores de tope | `spam_risk_too_many_posts`, `spam_risk_too_many_pending_share`, `reached_active_user_cap` | DOC |

**Estados (asíncronos, DOC):** `PROCESSING_UPLOAD`, `PROCESSING_DOWNLOAD`, `SEND_TO_USER_INBOX`, `PUBLISH_COMPLETE`, `FAILED`. Webhooks: `post.publish.failed`, `.complete`, `.inbox_delivered`, `.publicly_available`, `.no_longer_publicaly_available`. `publicaly_available_post_id` (así se escribe) solo se llena si el post es público y pasó la moderación (un minuto a horas). No se reintentan `auth_removed` ni `spam_risk*`; sí `video_pull_failed`, `photo_pull_failed` e `internal`.

## 7. Cuentas, regiones y reglas
- **Tipos de cuenta (personal, Business, Creator):** ninguna página oficial que se pudo leer los distingue para la Content Posting API (NO VERIFICADO). TikTok for Business tiene una **Organic API** con publicación en cuentas propias (SNIPPET) cuyos requisitos y regiones no se pudieron leer: vía distinta, posiblemente la adecuada para cuentas de empresa. Investigarla aparte.
- **Chile:** no hay lista de países para la API (NO VERIFICADO). La prueba práctica es crear la app con una cuenta chilena.
- **Reglas (DOC, developer guidelines):** respetar los límites, no hacer spam ni denegación de servicio; la API es para creadores auténticos con contenido original. Una violación puede significar «permanent ban on all future integrations by your account and business entity»: el riesgo es de la entidad completa, no de una app.
- **Programación y agencias:** ninguna página oficial lo menciona; Hootsuite, Sprout, Later y Khoros son *Marketing Partners* con programación (SNIPPET), así que es un uso reconocido.

## 8. Métricas (Display API, DOC)
`/v2/user/info/`, `/v2/video/list/` (máximo 20 por página), `/v2/video/query/`. El objeto Video trae `view_count`, `like_count`, `comment_count`, `share_count`, `duration` e `is_aigc`. La doc no dice qué scope exige cada campo ni los límites de tasa. La Research API es solo para investigadores sin fines de lucro de EE. UU., EEA, Reino Unido y Suiza: no aplica.

## 9. Si más adelante lo usan terceros (la corredora)
La doc no cubre este caso (NO VERIFICADO). Una sola app auditada puede servir a todos los agentes si el cupo de usuarios activos se dimensiona bien en la solicitud (DOC); cada agente autoriza su cuenta con OAuth y ve el compositor con su `creator_info`. Hay proveedores multicliente que operan con su propia app auditada (SNIPPET). El programa Marketing Partner parece un trámite comercial aparte, no un requisito para publicar (INFERENCIA). Con más de 5 usuarios hace falta la app auditada. Un cambio de URL o de scopes después de aprobar puede reabrir la revisión (PISTA).

## 10. Cómo probar sin riesgo (pruebas de entrada, a mano)
1. Con sesión, leer la página oficial de la auditoría y su solicitud para ver los requisitos reales.
2. Crear la app con una cuenta de Chile, agregar Login Kit y Content Posting API; anotar qué scopes aparecen sin revisión y si el modo *Sandbox* acepta las cuentas del operador.
3. Registrar un redirect `https://localhost:...` y hacer un OAuth completo; ver si el `refresh_token` rota tras un refresh.
4. Llamar a `creator_info` con cada tipo de cuenta que haya (personal, Creator, Business).
5. Con `video.upload`: subir un reel de R2 por `FILE_UPLOAD` y ver que llega a la bandeja; anotar el aviso, si el caption se puede prellenar, cuánto dura el borrador y si queda privado.
6. Probar un Direct Post sin auditoría en una cuenta privada y confirmar que sale `SELF_ONLY`.
7. Probar una foto por `PULL_FROM_URL` con un dominio propio verificado, y la URL prefirmada de R2 para ver el error.
8. Revisar que el WAF de Cloudflare deje pasar a los revisores de TikTok.
9. Preguntar en el portal si la Organic API de TikTok for Business sirve para cuentas Business de una inmobiliaria.

## 11. Riesgos y recomendación
- **Recomendación:** TikTok en F9 solo como **borrador de video** (*Upload*); el borrador sin auditoría es lo único que no está confirmado por la doc, por eso la prueba S6 va antes de construir. Direct Post público, fotos y el compositor con las etiquetas, con el piloto, que es el caso de uso real que justifica la auditoría.
- **Riesgos:** semanas de auditoría y rechazo por «uso interno»; que el borrador no llegue sin auditoría o que una cuenta personal no pueda autorizar (el veredicto pasaría a «TikTok completo en el piloto»); la ley de datos y las etiquetas comerciales y de IA, que son responsabilidad de quien publica.
- **Preguntas abiertas para el operador:** tipo de cuenta de TikTok (personal, Creator o Business), si aceptan terminar cada post a mano en la app, quién responde por las etiquetas de contenido comercial y de IA en las cuentas de los agentes, y si la corredora usará cuentas Business o personales.

## 12. Fuentes
**Oficiales (DOC):** [get-started](https://developers.tiktok.com/doc/content-posting-api-get-started), [content-sharing-guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines), [direct-post](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post), [photo-post](https://developers.tiktok.com/doc/content-posting-api-reference-photo-post), [upload-video](https://developers.tiktok.com/doc/content-posting-api-reference-upload-video), [upload-content](https://developers.tiktok.com/doc/content-posting-api-get-started-upload-content), [media-transfer-guide](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide), [query-creator-info](https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info), [get-video-status](https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status), [OAuth](https://developers.tiktok.com/doc/oauth-user-access-token-management), [Login Kit web](https://developers.tiktok.com/doc/login-kit-web), [developer guidelines](https://developers.tiktok.com/doc/our-guidelines-developer-guidelines), [user info](https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info), [video object](https://developers.tiktok.com/doc/tiktok-api-v2-video-object), [Research API](https://developers.tiktok.com/products/research-api).
**Terceros (PISTA):** [bundle.social](https://bundle.social/blog/tiktok-api-approval), [Postiz](https://docs.postiz.com/providers/tiktok.md), [Postproxy](https://postproxy.dev/blog/how-to-post-to-tiktok-via-api/), [Phyllo](https://www.getphyllo.com/post/tiktok-api-integration-guide-2026-setup-endpoints-common-pitfalls), [Postzen](https://www.postzen.dev/blog/tiktok-api).
