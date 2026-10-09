# ADR-0006 · Modelo genérico de aviso con campos configurables

- **Estado:** Aceptado
- **Fecha:** 2026-09-28

## Contexto
El piloto es inmobiliario, pero el producto apunta también a vendedores generales. Además, el operador necesita agregar o quitar campos sin reprogramar.

## Decisión
- Entidad **`Listing`** genérica con `category` (`real_estate` hoy, `product` después).
- Columnas fijas solo para lo que el sistema usa para consultar u operar: precio, moneda, operación, tipo, ubicación y estado.
- Resto de datos en `attributes jsonb`, validados en tiempo de ejecución contra **`field_definitions`** (globales por categoría y sobrescribibles por corredor).
- El importador mapea columnas del Excel mediante `field_definitions.source_column`.

## Consecuencias
- Agregar un campo = insertar una fila en `field_definitions`, sin migración.
- Consultas por atributos dinámicos son menos eficientes (se agregan índices GIN si hace falta).
- Cada publisher mapea `attributes` a los campos que su plataforma espera; los obligatorios faltantes se detectan en `validate()`.

## Alternativas descartadas
- **Una columna por campo:** exige una migración por cada campo nuevo.
- **Tablas separadas por categoría:** duplica lógica cuando lleguen los productos.

## Seguimiento
- 2026-10-02 (cierre de F1): además de precio, moneda, operación, tipo, ubicación y estado, `listings` tiene como columnas fijas `show_exact_address`, `highlights` e `internal_notes`, porque el sistema opera sobre ellas por reglas editoriales y de privacidad (`docs/04-formato-publicaciones.md`). Las columnas de control de la carga (`estado_carga`, `carpeta_medios`, `foto_portada`) son definiciones `is_core` sin columna: guían la importación y no se guardan.
- 2026-10-03 (F2-T01): `field_definitions` suma `min_value` y `max_value`, el rango de un campo `number` (ADR-0012 §5, spec F2 D7). Agregar un campo sigue sin requerir migración: el rango es un dato más de la fila.
- 2026-10-08 (F4-T11): en Portal Inmobiliario, los obligatorios de la plataforma no los revisa `validate()` del publisher (que sigue pura, ADR-0015 punto 7), sino una tabla en core (`portal/fields.ts`) con las **llaves** de los campos configurables, que usan `portalReadiness` (sin catálogo) y `buildPortalItem` (con la hoja real de Mercado Libre). Renombrar la columna del Excel no la afecta (el importador usa `source_column`); cambiar la llave de un campo hace que un obligatorio salga como faltante (falla del lado seguro) y que un opcional deje de enviarse. Un test de `packages/db` ata la tabla a las definiciones de campos, para notarlo al cambiar una llave.
