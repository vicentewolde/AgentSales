import type { ContentView } from "@agentsales/api/contracts";
import { PLATFORM_TEXT } from "@agentsales/core";
import { uniqueKeys } from "./keys.js";

/** La revisión editorial de un texto: errores en rojo y advertencias en ámbar (tokens del tema). */
export function Checks({ content }: { content: ContentView }) {
  // Dos problemas iguales pueden repetirse: la clave los distingue.
  const keys = uniqueKeys(content.checks, (check) => `${check.code}:${check.message}`);
  return (
    <section
      aria-label={`Revisión editorial de ${PLATFORM_TEXT[content.platform]}`}
      className="mt-3 text-sm"
    >
      {content.checks.length === 0 ? (
        <p className="text-success-700">✓ Revisión editorial sin problemas</p>
      ) : (
        <ul className="space-y-1">
          {content.checks.map((check, index) => (
            <li
              key={keys[index]}
              className={
                check.severity === "error"
                  ? "rounded border border-danger-200 bg-danger-50 px-2 py-1 text-danger-800"
                  : "rounded border border-warning-200 bg-warning-50 px-2 py-1 text-warning-800"
              }
            >
              <span className="font-semibold">
                {check.severity === "error" ? "Error" : "Advertencia"}:
              </span>{" "}
              {check.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
