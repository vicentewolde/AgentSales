// El alcance de un usuario (spec F7 §4.4, ADR-0022): qué corredores puede ver. Los repositorios lo
// reciben y filtran en SQL; las rutas lo usan para responder 404 a lo ajeno.

/** `all`: el administrador. `broker`: un usuario de corredor, solo lo suyo. */
export type AccessScope =
  | { readonly kind: "all" }
  | { readonly kind: "broker"; readonly brokerId: string };

export const ALL_SCOPE: AccessScope = { kind: "all" };

export const brokerScope = (brokerId: string): AccessScope => ({ kind: "broker", brokerId });

/** Si un recurso de ese corredor está dentro del alcance (`null`: sin corredor, solo `all`). */
export function inScope(scope: AccessScope, brokerId: string | null): boolean {
  return scope.kind === "all" || scope.brokerId === brokerId;
}

/** El corredor al que se limita el alcance; `undefined` si es `all`. */
export function scopedBrokerId(scope: AccessScope): string | undefined {
  return scope.kind === "broker" ? scope.brokerId : undefined;
}
