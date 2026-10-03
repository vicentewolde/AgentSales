import { describe, expect, it } from "vitest";
import { isAppError } from "../errors.js";
import { createInMemoryLlmProvider, LLM_ERRORS } from "./llm.js";

const request = { system: "s", prompt: "p", jsonSchema: { type: "object" } };

describe("createInMemoryLlmProvider", () => {
  it("entrega las respuestas en orden, copia los datos y registra las peticiones", async () => {
    const data = { hook: "Gancho" };
    const llm = createInMemoryLlmProvider([{ data }, { error: LLM_ERRORS.unavailable() }]);

    const first = await llm.generateStructured(request);
    expect(first).toEqual({ data, model: "modelo-falso" });
    expect(first.data).not.toBe(data);
    const error = await llm.generateStructured(request).catch((caught: unknown) => caught);
    expect(isAppError(error) && [error.code, error.retriable]).toEqual(["LLM_UNAVAILABLE", true]);
    expect(llm.requests).toEqual([request, request]);
    await expect(llm.generateStructured(request)).rejects.toThrow("sin respuestas guionadas");
  });

  it("con la señal ya disparada responde LLM_ABORTED sin gastar una respuesta", async () => {
    const llm = createInMemoryLlmProvider([{ data: { a: 1 } }]);
    // Core no tiene los tipos de `AbortController`: una señal mínima ya disparada.
    const aborted = { aborted: true, addEventListener() {}, removeEventListener() {} };
    const error = await llm
      .generateStructured({ ...request, signal: aborted })
      .catch((caught: unknown) => caught);
    expect(isAppError(error) && error.code).toBe("LLM_ABORTED");
    await expect(llm.generateStructured(request)).resolves.toMatchObject({ data: { a: 1 } });
  });
});
