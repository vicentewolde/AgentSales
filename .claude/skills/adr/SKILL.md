---
name: adr
description: Registra una decisión de arquitectura como ADR numerado en docs/adr y enlaza los docs afectados.
argument-hint: "\"título de la decisión\""
disable-model-invocation: true
allowed-tools: Read Grep Glob
---

# /adr $ARGUMENTS — Registrar una decisión

ADRs existentes: !`ls docs/adr`

## Pasos
1. Determina el siguiente número (4 dígitos) según los ADRs existentes.
2. Crea `docs/adr/NNNN-<titulo-en-kebab-case>.md` desde `docs/adr/_plantilla.md`, con estado **Propuesto** y fecha de hoy.
3. Completa Contexto, Decisión, Consecuencias y Alternativas usando lo conversado en la sesión y los docs. Si falta información para alguna sección, pregúntala; no la inventes.
4. Si reemplaza un ADR anterior, marca el antiguo como "Reemplazado por ADR-NNNN".
5. Muestra el ADR al operador. Cuando lo apruebe:
   - Cambia el estado a **Aceptado**.
   - Actualiza los docs afectados (`01-arquitectura.md`, `05-convenciones.md`, etc.) para que sean coherentes.
   - Agrega una nota en `docs/ESTADO.md`.
   - Haz commit: `docs(adr): NNNN <título>`.
