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
