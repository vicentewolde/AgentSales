import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

/** Lo que recibió el Instagram simulado, para afirmar en los tests (nunca sale a internet). */
export type RecordedRequest = {
  method: string;
  url: URL;
  authorization: string | null;
  form: URLSearchParams | null;
};

/**
 * Servidor msw de los tests de Instagram: una petición sin handler falla el test
 * (`onUnhandledFrame: "error"`), así nada llega a Meta. `requests` se vacía entre tests.
 */
export function useInstagramServer() {
  const server = setupServer();
  const requests: RecordedRequest[] = [];
  server.events.on("request:start", async ({ request }) => {
    const body = request.method === "POST" ? await request.clone().text() : null;
    requests.push({
      method: request.method,
      url: new URL(request.url),
      authorization: request.headers.get("authorization"),
      form: body === null ? null : new URLSearchParams(body),
    });
  });
  beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
  afterEach(() => {
    server.resetHandlers();
    requests.length = 0;
  });
  afterAll(() => server.close());
  return { server, requests };
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
