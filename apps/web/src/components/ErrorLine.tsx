import { type CodedError, errorTextOf } from "./error-messages.js";

/**
 * Un error guardado (el `last_error` de una publicación, el de una corrida o un intento) en una
 * línea (F9.5-T20): la frase simple del mapa o el mensaje, y el código chico al final para
 * reportarlo. Quien la usa pone el contenedor y el color.
 */
export function ErrorLine({ error }: { error: CodedError }) {
  const { title, detail, code } = errorTextOf(error);
  return (
    <>
      {title}
      {detail !== null && detail !== "" && ` ${detail}`}
      {code !== null && <span className="ml-1 text-xs opacity-80">(código: {code})</span>}
    </>
  );
}
