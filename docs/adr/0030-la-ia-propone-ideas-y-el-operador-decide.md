# ADR-0030 · La IA propone ideas y calendario; nada se publica sin que el operador lo apruebe

- **Estado:** Aceptado
- **Fecha:** 2026-10-19
- **Reemplaza a / Modifica a:** ADR-0013, punto 1, **solo para posts**: la IA escribe el texto completo de cada red (JSON validado) y no frases que el código ensambla, porque un post de marca no tiene datos estructurados que ensamblar; los textos de avisos no cambian (extiende también ADR-0003)

## Contexto
Para los avisos, la IA solo redacta con los datos que trae la planilla (ADR-0013). Para contenido de marca no hay planilla: la IA debería sugerir **qué** publicar y **cuándo**, y eso es donde más fácil inventa (cifras de la empresa, clientes, promesas, noticias). Las reglas del producto siguen valiendo: humano en el control, nunca inventar datos, seguro por defecto (`docs/00-vision.md`).

Además, X pide aprobación previa para respuestas generadas por IA y puede sancionar la automatización; LinkedIn prohíbe en sus términos "automatizar publicaciones" (`docs/integraciones/x.md` §9, `linkedin.md` §9). Una IA que publica sola es el caso de más riesgo.

## Decisión
1. El **perfil editorial** de cada marca (idiomas, público, líneas de contenido, **hechos que la IA puede afirmar**, cosas que evitar, cadencia por red) es la única fuente de datos de la IA. Sin hechos, la IA escribe sobre ideas y criterios, no afirma cifras, clientes ni resultados. Las notas internas del operador no se mandan a la IA. **Un brief que escribió la IA no es fuente de hechos**: el post guarda quién escribió su brief (`brief_origin`: `operator` | `ai`) y solo cuenta el que escribe o edita el operador.
2. Un **plan** (`plan_runs`) es una corrida de IA que, para un período, propone **ideas**: tema, línea de contenido, redes, formato, fecha y hora sugeridas y el porqué. Cada idea se guarda como un `post` en estado `idea` con `source = ai`. Una idea **no tiene textos ni publicaciones**.
3. El operador acepta, edita o descarta cada idea. Solo al **aceptarla** se redactan los textos por red (`post.draft`), igual que un post manual. Aprobar y programar es un paso aparte de aceptar.
4. `auto_publish` (ADR-0019) **no se aplica a los posts** en F9: lo que viene de la IA nunca pasa solo de idea a publicado.
5. El plan evita repetir: recibe los temas de los últimos 60 días y las ideas descartadas. No usa métricas en F9.
6. El gasto de IA de los planes y los textos de posts se anota por marca y entra al tope mensual de F7 (`llm_monthly_cap_usd`): la suma del gasto (`sumLlmCost`) cuenta las corridas de avisos, las de posts y los planes. Los prompts de redes llevan su propia versión, `SOCIAL_PROMPT_VERSION`, que se guarda en `contents.prompt_version` y `plan_runs`.
7. Los textos de posts pasan por las mismas verificaciones antes de poder aprobarse: largo y escape por red, sin menciones masivas (`@everyone`, `@here`), sin enlaces en X salvo que el operador los marque, y sin cifras ni nombres propios que no estén en el perfil o en el brief del post.

## Consecuencias
- La IA ahorra la hoja en blanco sin quitar el control: tres pasos humanos (aceptar, aprobar, programar), por defecto.
- El perfil editorial pasa a ser trabajo del operador (escribir los hechos); es la mitigación principal contra datos inventados, y se evalúa con `pnpm eval:social` (T22).
- Un plan consume cuota de IA aunque se descarte todo; el tope por marca lo acota.
- Quedan para después: métricas, proponer a partir de lo que funcionó, y cualquier automatismo de publicación de ideas.

## Alternativas descartadas
- **La IA redacta y publica según un calendario fijo:** contradice el principio de humano en el control y choca con X y LinkedIn.
- **Redactar los textos de todas las ideas al proponerlas:** gasta IA en lo que se descarta y deja textos sin revisar dando vueltas.
- **Dejar que la IA busque noticias o tendencias en internet:** introduce fuentes que no controlamos y datos inventados con apariencia de verdad.

## Seguimiento (opcional)
- **F9-T20 (2026-10-20):** el plan guarda en `plan_runs.prompt_version` una versión **propia**, `PLAN_PROMPT_VERSION` (`social-plan-v1`), y no `SOCIAL_PROMPT_VERSION`: el prompt de ideas y el de textos cambian por separado y la evaluación (T22) los mide por separado. `contents.prompt_version` sigue con `SOCIAL_PROMPT_VERSION`. Las ideas descartadas que el plan no repite son las de los últimos 180 días (las ideas de la IA archivadas); los temas recientes, los de 60 días (punto 5). Las redes de cada idea quedan en el reporte del plan: el post no las guarda y, al aceptarla, se redacta para todas las redes de la marca.
