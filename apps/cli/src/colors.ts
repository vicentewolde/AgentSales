import pc from "picocolors";

/** Paleta de colores; en tests se fuerza con `createColors(true)` para verificar el rojo de `live`. */
export type Colors = Omit<typeof pc, "createColors">;

export const colors: Colors = pc;
export const createColors = (enabled: boolean): Colors => pc.createColors(enabled);
