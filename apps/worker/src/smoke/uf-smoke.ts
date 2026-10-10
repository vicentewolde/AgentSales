import {
  dateIn,
  isAppError,
  MARKETPLACE_TIME_ZONE,
  type UfValueSource,
  ufToClp,
} from "@agentsales/core";
import { describeUnexpected } from "./ig-smoke.js";

/** Un token que el Banco Central no puede aceptar: para ver cómo responde (nota uf.md §3.4). */
export const UF_SMOKE_INVALID_TOKEN = "agentsales-token-invalido-de-prueba";

export type UfSmokeDeps = {
  /** El token de `.env` (`BCCH_API_TOKEN`); `undefined` si falta. Nunca se imprime. */
  token: string | undefined;
  /** Arma la fuente con un token (la real, o un doble en los tests). */
  sourceFor(token: string): UfValueSource;
  now(): Date;
  print(line: string): void;
  printError(line: string): void;
};

/** `AAAA-MM-DD` más `days` días, en el calendario. */
const plusDays = (date: string, days: number) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/**
 * `pnpm uf:smoke` (spec F5 §4.6, F5-T07): lo corre el operador una vez con su token, para confirmar
 * lo NO VERIFICADO de la nota `uf.md`: la forma del valor de la UF, si la API devuelve fechas
 * futuras ya publicadas y qué responde con un token inválido. Pide hoy y los próximos 31 días con
 * su token, y una consulta con un token inventado. No escribe nada ni publica. Nunca imprime el
 * token. Devuelve el código de salida: 0 si leyó el valor de hoy.
 */
export async function runUfSmoke(deps: UfSmokeDeps): Promise<number> {
  if (deps.token === undefined) {
    deps.printError("✗ Falta BCCH_API_TOKEN en .env (docs/07-checklist-cuentas.md, Antes de F5)");
    return 1;
  }
  const today = dateIn(MARKETPLACE_TIME_ZONE, deps.now());
  const until = plusDays(today, 31);
  let ok = false;
  try {
    const values = await deps.sourceFor(deps.token).valuesBetween(today, until);
    const todays = values.find((value) => value.date === today);
    if (todays === undefined) {
      deps.printError(`✗ El Banco Central no trajo el valor de hoy (${today})`);
    } else {
      ok = true;
      deps.print(`✓ UF de hoy (${today}): ${todays.value}`);
      deps.print(`  Ejemplo: 5.800 UF = $${ufToClp(5800, todays.value).toLocaleString("es-CL")}`);
    }
    const future = values.filter((value) => value.date > today);
    deps.print(
      future.length > 0
        ? `✓ Trae ${future.length} días futuros ya publicados (hasta ${future.at(-1)?.date})`
        : "· No trae días futuros (se pide el día cuando hace falta)",
    );
  } catch (error) {
    deps.printError(
      `✗ ${isAppError(error) ? `${error.code}: ${error.message}` : describeUnexpected(error)}`,
    );
  }
  try {
    await deps.sourceFor(UF_SMOKE_INVALID_TOKEN).valuesBetween(today, today);
    deps.print("· Con un token inventado respondió sin error (lo dice la nota: se revisa a mano)");
  } catch (error) {
    deps.print(`· Con un token inventado: ${isAppError(error) ? error.code : "error inesperado"}`);
  }
  return ok ? 0 : 1;
}
