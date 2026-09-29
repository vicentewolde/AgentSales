import { defineConfig } from "vitest/config";

export default defineConfig({
  // Los paquetes internos se resuelven a su código fuente (exports "@agentsales/source").
  ssr: { resolve: { conditions: ["@agentsales/source"] } },
  test: {
    include: ["{apps,packages}/*/{src,test}/**/*.test.{ts,tsx}"],
  },
});
