import type { Currency, Operation } from "./enums.js";

/** Miles con punto: `5800` → `5.800`. */
const groupThousands = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/** Número con formato chileno: `120000` → `120.000`, `72.5` → `72,5` (hasta dos decimales). */
export function formatNumber(value: number): string {
  const sign = value < 0 ? "-" : "";
  const [integer = "0", decimals = ""] = String(Math.round(Math.abs(value) * 100) / 100).split(".");
  return `${sign}${groupThousands(integer)}${decimals ? `,${decimals}` : ""}`;
}

/**
 * Precio con formato chileno (docs/04-formato-publicaciones.md): `UF 5.800`, `UF 3.250,50` y
 * `$650.000`. La UF lleva dos decimales solo si los tiene; el peso se redondea al entero. Sin
 * `Intl`, para que la CLI, el panel y las plantillas den lo mismo en cualquier entorno.
 */
export function formatPrice(amount: number, currency: Currency): string {
  // El validador exige precio > 0; un negativo igual muestra su signo, delante de todo.
  const sign = amount < 0 ? "-" : "";
  const absolute = Math.abs(amount);
  if (currency === "CLP") {
    return `${sign}$${groupThousands(Math.round(absolute).toString())}`;
  }
  const [integer = "0", decimals = "00"] = absolute.toFixed(2).split(".");
  return `${sign}UF ${groupThousands(integer)}${decimals === "00" ? "" : `,${decimals}`}`;
}

/** Precio de un aviso: en arriendo lleva `/mes` (`$650.000/mes`, docs/04-formato-publicaciones.md). */
export function formatListingPrice(listing: {
  priceAmount: number;
  priceCurrency: Currency;
  operation: Operation | null;
}): string {
  const price = formatPrice(listing.priceAmount, listing.priceCurrency);
  return listing.operation === "rent" ? `${price}/mes` : price;
}
