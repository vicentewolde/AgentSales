import { spawn } from "node:child_process";

// El portapapeles de macOS (`pbcopy`), para lo que nunca se imprime: la clave de un usuario de
// prueba de Mercado Libre (F4-T25) y los enlaces de invitación (F7, ADR-0021).

/** Copia por la entrada estándar de `pbcopy` (nunca como argumento: no queda en `ps`). */
export function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    // `pbcopy` puede terminar antes de leer: el `EPIPE` llega aquí, no como excepción suelta.
    child.stdin.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`pbcopy terminó con ${code}`)),
    );
    child.stdin.end(text);
  });
}

/** Si se puede usar el portapapeles: copiar un texto vacío lo prueba (vacía el portapapeles). */
export function clipboardReady(): Promise<boolean> {
  return copyToClipboard("").then(
    () => true,
    () => false,
  );
}
