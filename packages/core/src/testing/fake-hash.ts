// Hash de los dobles de prueba: determinista y sin `node:crypto`, que core no usa.

/** Hash de prueba (FNV-1a, 32 bits): determinista y sin `node:crypto`, que core no usa. */
export function fakeHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").repeat(8);
}
