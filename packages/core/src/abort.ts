/**
 * Lo que core necesita de un `AbortSignal`, sin depender de los tipos de Node ni del DOM (core los
 * excluye). El `AbortSignal` real de Node y del navegador lo cumple tal cual, así que las apps lo
 * pasan sin convertir. Lo usan los puertos que cortan trabajo largo: `MediaStorage.getStream` y,
 * en F2, la IA y el procesamiento de medios (spec F2 §4.4).
 */
export type AbortSignalLike = {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
};
