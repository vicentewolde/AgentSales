import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Page } from "playwright";

/**
 * Diagnóstico opcional del formulario de Marketplace (`pnpm fb:smoke --listing … --diagnostico`,
 * spec F5 §4.8). **No se usa en el flujo normal de publicar**: solo cuando el operador lo pide para
 * investigar un fallo, como el diálogo «¡Uy! Se ha producido un error» que Facebook mostró al
 * terminar de llenar.
 *
 * Anota, mientras la pestaña viva, **solo lo que sirve para ubicar el fallo y sin datos del
 * operador ni del aviso**: los errores sin atrapar de la página (primera línea, sin direcciones ni
 * números largos) y las respuestas de error (400 o más) y los pedidos fallidos a Facebook, con el
 * método, la ruta **sin consulta** y el código. Nada del cuerpo de los pedidos ni de las respuestas.
 */

/** Tope de líneas: un fallo en bucle no llena el disco. */
const MAX_LINES = 200;
/** Largo máximo de la línea de un error de la página. */
const MAX_ERROR_CHARS = 300;

/** Orígenes de Facebook de los que se anotan respuestas de error. */
const FACEBOOK_HOST = /(^|\.)(facebook\.com|fbcdn\.net|facebook\.net)$/i;

/** Quita direcciones y números largos (ids de cuentas o de objetos) de un texto. */
export function sanitizeDiagnosticText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/\d{6,}/g, "<id>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_ERROR_CHARS);
}

/** Método y ruta de un pedido, sin consulta ni fragmento, y con los ids largos tapados. */
export function describeRequest(method: string, url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!FACEBOOK_HOST.test(parsed.hostname)) return null;
    return `${method} ${parsed.pathname.replace(/\d{6,}/g, "<id>")}`;
  } catch {
    return null;
  }
}

/**
 * Empieza a anotar en `file` (carpeta `0700` si hace falta) lo descrito arriba, con el tiempo en
 * milisegundos desde ahora. Devuelve cuántas líneas se anotaron hasta el momento. Las escrituras
 * van en orden y nunca hacen fallar la página.
 */
export function watchPageProblems(page: Page, file: string, now: () => number = Date.now) {
  const startedAt = now();
  let lines = 0;
  let writing: Promise<unknown> = mkdir(dirname(file), { recursive: true, mode: 0o700 }).catch(
    () => undefined,
  );
  const note = (text: string) => {
    if (lines >= MAX_LINES) return;
    lines += 1;
    const line = `+${String(now() - startedAt).padStart(6, " ")} ms  ${text}\n`;
    writing = writing.then(() => appendFile(file, line, { mode: 0o600 })).catch(() => undefined);
  };
  page.on("pageerror", (error) => {
    note(`ERROR DE LA PÁGINA  ${sanitizeDiagnosticText(String(error.message ?? error))}`);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const request = response.request();
    const what = describeRequest(request.method(), request.url());
    if (what !== null) note(`RESPUESTA ${response.status()}  ${what}`);
  });
  page.on("requestfailed", (request) => {
    const what = describeRequest(request.method(), request.url());
    if (what !== null) {
      note(
        `PEDIDO FALLIDO  ${what}  (${sanitizeDiagnosticText(request.failure()?.errorText ?? "")})`,
      );
    }
  });
  page.on("crash", () => note("LA PESTAÑA SE CAYÓ"));
  return {
    /** Cuántas líneas se anotaron. */
    lines: () => lines,
    /** Espera a que se hayan escrito las anotadas hasta ahora. */
    flush: () => writing.then(() => undefined),
  };
}
