# Opportunity Finder — fixtures manuales certificados

Todos los datos de esta carpeta son sintéticos. No contienen información empresarial real.

## Cómo usar los archivos

En cada subcarpeta:

1. Sube el primer XLSX en el lado **Necesidades / demanda**.
2. Sube el segundo XLSX en el lado **Disponibilidad / oferta**.
3. Espera el perfilado.
4. Confirma los roles indicados abajo.
5. Ejecuta la comparación.
6. Compara la pantalla o el CSV exportado con `expected-results.json`.

| Set | Archivo de necesidades | Rol | Archivo de disponibilidad | Rol |
|---|---|---|---|---|
| set-01-planned-po-stock | QA_Set01_Planned_PO.xlsx | demand | QA_Set01_Stock_On_Hand.xlsx | stock |
| set-02-customer-demand-inventory | QA_Set02_Customer_Demand.xlsx | demand | QA_Set02_Inventory.xlsx | stock |
| set-03-need-list-excess | QA_Set03_Need_List.xlsx | demand | QA_Set03_Excess_Inventory.xlsx | excess |
| set-04-rfq-supplier-offers | QA_Set04_RFQ_Demand.xlsx | demand | QA_Set04_Supplier_Offers.xlsx | supplier_offer |
| set-05-demand-received-parts | QA_Set05_Customer_Demand.xlsx | demand | QA_Set05_Received_Parts.xlsx | received_history |

## Significados

- **Coincidencia exacta de MPN**: la clave normalizada conserva símbolos relevantes como guiones y coincide en ambos archivos.
- **Venta completa / full_sale**: la cantidad asignada cubre toda la necesidad. El stock puede ser igual o mayor.
- **Cantidad exacta**: la disponibilidad utilizable restante justo antes de asignar es igual a la necesidad y la asignación cubre completamente esa necesidad.
- **no_result**: el comportamiento actual no genera una fila pública para ese caso.

## Verificación automatizada

Los cinco sets y los 29 casos se validan con:

```text
npx vitest run lib/opportunity-finder/__tests__/manual-fixtures.test.ts
```

La prueba comprueba clasificación, cantidades, los tres indicadores, advertencias, preservación de ceros y guiones, ausencia de doble asignación y ausencia de campos financieros.

## Privacidad

- No hay macros, fórmulas, celdas combinadas ni filas ocultas.
- Los MPN son cadenas sintéticas.
- No se incluyen precios, costos ni márgenes.
