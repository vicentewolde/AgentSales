/**
 * Puerto mínimo hacia un modelo de lenguaje. El registro no conoce a ningún proveedor:
 * un adaptador (Meta Muse Spark, Claude, un falso en pruebas) implementa esto.
 */
export interface ModelRequest {
  model: string;
  instructions: string;
  input: string;
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens: number;
  reasoningEffort?: "low" | "medium" | "high";
  estInputTokens?: number;
  label: string;
}

export interface ModelClient {
  respond(request: ModelRequest): Promise<{ text: string }>;
}
