/** Un logo listo para guardar: PNG, rotado y sin metadatos. */
export type NormalizedLogo = { bytes: Uint8Array; width: number; height: number };

/**
 * Normaliza el logo que sube un corredor (spec F7 §4.6): acepta PNG, JPEG o WebP (nunca SVG, que
 * puede llevar código) y devuelve un PNG. Errores (`AppError`): `LOGO_INVALID` (415) si no es una
 * de esas imágenes o no se puede leer. Lo implementa `@agentsales/media/logo` (sharp).
 */
export interface LogoNormalizer {
  normalize(input: Uint8Array): Promise<NormalizedLogo>;
}
