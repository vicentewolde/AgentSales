import { defineConfig } from "vitest/config";

export default defineConfig({
  // Los paquetes internos se resuelven a su código fuente (ADR-0010). Esta lista reemplaza
  // las condiciones por defecto de Vite, que se repiten a mano (`defaultServerConditions`).
  ssr: {
    resolve: { conditions: ["@agentsales/source", "module", "node", "development|production"] },
  },
  test: {
    include: ["{apps,packages}/*/{src,test}/**/*.test.{ts,tsx}"],
  },
});
