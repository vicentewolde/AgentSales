# ADR-0041 · Instagram a mano para las marcas, y confirmar sin enlace en X e Instagram

- **Estado:** Aceptado
- **Fecha:** 2026-11-10
- **Reemplaza a / Modifica a:** ADR-0029 (punto 9: «en Instagram y Portal el modo a mano no vale»; ahora vale en Instagram, solo para marcas)

## Contexto
El operador quiere publicar a diario desde la marca AgentPey en X e Instagram con lo más simple: AgentSales deja el calendario y los textos listos, y él copia y pega. LinkedIn, X, Discord y TikTok ya tienen modo a mano (ADR-0029, punto 9); **Instagram no**, porque su enlace no es su id y porque los avisos de un corredor se operan por el id del medio. AgentPey todavía no tiene una cuenta de Instagram propia (hoy la marca usa `@vicentewoldec`, la personal del operador, por la API) y conectar una cuenta nueva por la API exige el trámite de Meta. Además, solo LinkedIn se confirma sin enlace: en X e Instagram pegar el enlace de cada post es trabajo de más, y de ese enlace solo se usa el aviso de «publicado».

## Decisión
1. **Instagram admite el modo a mano** (`MANUAL_MODE_PLATFORMS`), **solo para una marca** (`brokers.kind = brand`): una marca solo publica posts, cuyo enlace nadie necesita para operarlos. En un corredor de propiedades (avisos) sigue siendo siempre por la API (`ACCOUNT_MODE_NOT_SUPPORTED`).
2. **Una cuenta de Instagram a mano no guarda credenciales ni llama a Meta**: `external_account_id = "manual:<usuario>"`, `credentials = null`, `meta = { mode: "manual", handle }`. La crea el administrador (`POST /accounts/instagram/manual`, `accounts connect instagram --manual --handle <usuario>`), como la de Marketplace a mano (ADR-0023). Una cuenta de Instagram por la API ya conectada de la misma marca queda desconectada en el mismo paso, **pero solo si no tiene publicaciones pendientes** (programadas, publicándose o esperando confirmación): si las tiene, se niega (`ACCOUNT_HAS_PENDING_PUBLICATIONS`), porque quedarían atadas a una cuenta desconectada (visto con X el 2026-10-24).
3. **X e Instagram se confirman sin enlace** (`CONFIRM_WITHOUT_URL_PLATFORMS`), como LinkedIn: «Ya lo publiqué» no pide el enlace y la publicación queda «Confirmada a mano, sin enlace».
4. **El panel ayuda a copiar**: X, con un enlace que abre el editor con el texto puesto (`x.com/intent/post?text=`, NO VERIFICADO) y el portapapeles como respaldo; Instagram, que no deja precargar nada, con el texto copiado y las imágenes o el video para bajar. Nada automatiza el navegador.

## Consecuencias
- Publicar a diario no necesita créditos de X, el servidor en vivo ni el trámite de Meta: el calendario y el panel «Hoy» bastan, con el operador publicando desde su teléfono.
- Una publicación a mano sin enlace no se puede abrir desde Seguimiento ni retirar por la API (se borra a mano). Las métricas de esos posts quedan fuera.
- Pasar después una cuenta de Instagram de a mano a la API es posible (`accounts connect instagram` con el token), pero la publicación ya confirmada no se toca.

## Alternativas descartadas
- **Conectar la cuenta nueva por la API de Meta ya:** depende del trámite de Meta (evaluadores, App Review) y del servidor en vivo; es lo contrario de «lo más simple».
- **Instagram a mano para cualquier corredor:** los avisos usan el id del medio para operar la publicación; mezclarlos con el modo a mano obligaría a rediseñar su ciclo de vida.
- **Pedir siempre el enlace en X e Instagram:** sin ganancia (nadie lo usa) y con un paso más cada día.
