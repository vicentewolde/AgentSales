import type { AppError } from "../errors.js";
import { scrubMessage } from "../redact.js";

// El error que se guarda en una corrida (de contenido, de textos de un post o de un plan de ideas):
// lo comparten `prepareContent`, `draftPost` y `runPlan`.

/**
 * Mensajes fijos para los errores que pueden traer claves de R2 o rutas (`STORAGE_*`, `MEDIA_*`):
 * el error de la corrida lo muestran la API, el panel y la CLI (spec F2 §4.9).
 */
const FIXED_MESSAGES: Readonly<Record<string, string>> = {
  STORAGE_NOT_FOUND:
    "Falta un archivo del aviso en el almacenamiento: vuelve a importar sus medios",
  STORAGE_UNAVAILABLE: "El almacenamiento de archivos no respondió",
  STORAGE_ERROR: "El almacenamiento de archivos rechazó la operación",
  STORAGE_CONTENT_MISMATCH: "Un archivo cambió mientras se subía",
  MEDIA_CONFLICT: "Otra preparación del mismo aviso escribió los medios al mismo tiempo",
  MEDIA_NOT_FOUND: "Falta un medio del aviso",
};

/**
 * El error que se guarda en la corrida: sin claves de R2 ni rutas absolutas (dos o más tramos; un
 * comando como `/login` queda).
 */
export function contentRunErrorOf(error: AppError): { code: string; message: string } {
  const message = FIXED_MESSAGES[error.code] ?? scrubMessage(error.message);
  return { code: error.code, message };
}
