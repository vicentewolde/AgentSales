import type { Currency } from "./enums.js";

/** Miles con punto: `5800` → `5.800`. */
const groupThousands = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/**
 * Precio con formato chileno (docs/04-formato-publicaciones.md): `UF 5.800`, `UF 3.250,50` y
 * `$650.000`. La UF lleva dos decimales solo si los tiene; el peso se redondea al entero. Sin
 * `Intl`, para que la CLI, el panel y las plantillas den lo mismo en cualquier entorno.
 */
export function formatPrice(amount: number, currency: Currency): string {
  const sign = amount < 0 ? "-" : "";
  const absolute = Math.abs(amount);
  if (currency === "CLP") {
    return `${sign}$${groupThousands(Math.round(absolute).toString())}`;
  }
  const [integer = "0", decimals = "00"] = absolute.toFixed(2).split(".");
  const formatted = groupThousands(integer) + (decimals === "00" ? "" : `,${decimals}`);
  return `UF ${sign}${formatted}`;
}
