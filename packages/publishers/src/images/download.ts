import type { AppError } from "@agentsales/core";

/** Los tipos que se aceptan al descargar una imagen (los de una foto subida, menos HEIC). */
export const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp"] as const;

/** Une el tope de tiempo y la señal de quien llama. */
export function combinedSignal(timeoutMs: number, signal?: unknown): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  // `AbortSignalLike` es el subconjunto que core conoce; quien llama pasa un `AbortSignal` real.
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal as AbortSignal]);
}

/**
 * Lee el cuerpo de una respuesta con un tope de bytes: corta apenas lo pasa (no lo baja entero), y
 * revisa antes el `Content-Length` si viene.
 */
export async function readCapped(
  response: Response,
  maxBytes: number,
  tooLarge: () => AppError,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
