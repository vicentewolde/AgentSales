import { AppError } from "@agentsales/core";
import { validator } from "hono/validator";
import type { z } from "zod";

type Target = "json" | "query" | "param";

/**
 * Valida una parte de la petición con un esquema de `@agentsales/api/contracts` (spec F1 §4.4).
 * Un valor inválido es `REQUEST_INVALID` (400): el mensaje nombra los campos, y el detalle de zod
 * queda en `details`, que la API no expone. No usa `@hono/zod-validator` (sería una dependencia).
 */
export function validated<S extends z.ZodType, T extends Target>(target: T, schema: S) {
  return validator(target, (value): z.output<S> => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const fields = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || target)),
      ];
      throw new AppError("REQUEST_INVALID", `Petición inválida: revisa ${fields.join(", ")}`, {
        details: {
          target,
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    }
    return parsed.data;
  });
}
