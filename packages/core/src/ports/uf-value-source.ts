import type { AbortSignalLike } from "../abort.js";

/** El valor de la UF de un día, como lo publica la fuente: texto decimal con punto (`41130.94`). */
export type UfValue = { date: string; value: string };

/**
 * La fuente oficial del valor de la UF (spec F5 §4.6, nota `docs/integraciones/uf.md`): la API BDE
 * del Banco Central. Devuelve los días con valor publicado entre `from` y `to` (`AAAA-MM-DD`,
 * incluidos); un día sin dato no viene. Errores (`AppError`): `UF_VALUE_UNAVAILABLE` (red, 5xx o
 * tope: reintentable), `UF_SOURCE_AUTH_INVALID` (el token rechazado: no reintentable). Nunca lleva
 * el token en un error.
 */
export interface UfValueSource {
  valuesBetween(
    from: string,
    to: string,
    options?: { signal?: AbortSignalLike },
  ): Promise<UfValue[]>;
}
