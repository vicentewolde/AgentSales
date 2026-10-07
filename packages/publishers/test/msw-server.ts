import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

/** Lo que recibió la plataforma simulada, para afirmar en los tests (nunca sale a internet). */
export type RecordedRequest = {
  method: string;
  url: URL;
  authorization: string | null;
  /** La cabecera `Content-Type` tal cual (en `multipart`, con su separador). */
  contentType: string | null;
  /** El cuerpo como texto (`null` sin cuerpo o en `multipart`, que el test lee en su handler). */
  rawBody: string | null;
  /** El cuerpo como formulario, si no es JSON ni `multipart` (Instagram y el OAuth). */
  form: URLSearchParams | null;
  /** El cuerpo como JSON, si su tipo es `application/json`. */
  json: unknown;
};

/** Lee el cuerpo de una petición según su tipo, sin consumir la original. */
async function recordBody(request: Request) {
  const contentType = request.headers.get("content-type");
  const empty = { contentType, rawBody: null, form: null, json: undefined };
  // Un `multipart` no se lee aquí: su flujo se cierra al terminar la llamada. El test que lo
  // revisa lo lee dentro de su handler (`request.formData()`).
  if (request.method === "GET" || request.method === "HEAD") return empty;
  if (contentType?.startsWith("multipart/form-data")) return empty;
  const rawBody = await request.clone().text();
  if (contentType?.startsWith("application/json")) {
    let json: unknown;
    try {
      json = rawBody === "" ? undefined : JSON.parse(rawBody);
    } catch {
      // Un JSON inválido queda solo en `rawBody`: el test lo revisa ahí.
    }
    return { ...empty, rawBody, json };
  }
  return { ...empty, rawBody, form: new URLSearchParams(rawBody) };
}

/**
 * Servidor msw de los tests de Instagram y Mercado Libre: una petición sin handler falla el test
 * (`onUnhandledFrame: "error"`), así nada llega a Meta ni a Mercado Libre. `requests` se vacía
 * entre tests.
 */
export function usePlatformServer() {
  const server = setupServer();
  const requests: RecordedRequest[] = [];
  // Leer el cuerpo es asíncrono: una petición que terminó en error (sin red) puede registrarse
  // tarde. Se espera a todas antes de limpiar, para que no aparezca en el test siguiente.
  const pending = new Set<Promise<void>>();
  server.events.on("request:start", ({ request }) => {
    const recording = recordBody(request).then((body) => {
      requests.push({
        method: request.method,
        url: new URL(request.url),
        authorization: request.headers.get("authorization"),
        ...body,
      });
    });
    pending.add(recording);
    // Un cuerpo que no se pudo leer no rompe el run con un rechazo sin manejar.
    void recording.catch(() => undefined).finally(() => pending.delete(recording));
  });
  beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
  afterEach(async () => {
    await Promise.allSettled([...pending]);
    server.resetHandlers();
    requests.length = 0;
  });
  afterAll(() => server.close());
  /**
   * Las peticiones, después de terminar de registrar sus cuerpos (el registro es asíncrono): los
   * tests que revisan lo enviado usan esto en vez de leer `requests` directo.
   */
  const recorded = async () => {
    await Promise.allSettled([...pending]);
    return requests;
  };
  return { server, requests, recorded };
}

/** Todo lo que un error deja ver: mensaje, detalles, pila y causa. */
export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify(error);
  return JSON.stringify({
    message: error.message,
    stack: error.stack,
    details: (error as { details?: unknown }).details,
    cause: String(error.cause),
  });
}
