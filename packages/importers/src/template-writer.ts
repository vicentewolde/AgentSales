import { readFile } from "node:fs/promises";
import { type Broker, brokerTemplateValues } from "@agentsales/core";
import ExcelJS from "exceljs";

/** La plantilla oficial, relativa a la raíz del proyecto (en git, sin datos reales). */
export const BROKER_TEMPLATE_PATH = "data/plantillas/plantilla_propiedades.xlsx";

const BROKER_SHEET = "Corredor";
const FIELD_HEADER = "Campo";
const VALUE_HEADER = "Tu valor";

/**
 * La planilla de un corredor (spec F7 §4.6): la plantilla oficial tal cual (instrucciones,
 * encabezados, listas de opciones y la fila de ejemplo) con la columna «Tu valor» de la hoja
 * Corredor llena con su marca (`brokerTemplateValues`). El logo queda vacío: ya está guardado, y
 * una carga sin logo no lo cambia. Al leerla de vuelta sin propiedades no da errores.
 */
export async function writeBrokerTemplate(
  template: string | Uint8Array,
  broker: Broker,
): Promise<Uint8Array> {
  const bytes = typeof template === "string" ? await readFile(template) : template;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet(BROKER_SHEET);
  if (sheet === undefined) {
    throw new Error(`La plantilla no tiene la hoja ${BROKER_SHEET}`);
  }
  const header = sheet.getRow(1);
  let fieldColumn = 0;
  let valueColumn = 0;
  header.eachCell((cell, column) => {
    if (cell.value === FIELD_HEADER) fieldColumn = column;
    if (cell.value === VALUE_HEADER) valueColumn = column;
  });
  if (fieldColumn === 0 || valueColumn === 0) {
    throw new Error(
      `La hoja ${BROKER_SHEET} no tiene las columnas «${FIELD_HEADER}» y «${VALUE_HEADER}»`,
    );
  }
  const values = brokerTemplateValues(broker);
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const field = row.getCell(fieldColumn).value;
    if (typeof field !== "string") return;
    const value = values[field];
    if (value !== undefined) row.getCell(valueColumn).value = value;
  });
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
