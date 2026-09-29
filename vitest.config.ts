import { defineConfig } from "vitest/config";

export default defineConfig({
  // Los paquetes internos se resuelven a su código fuente (ADR-0010). Esta lista reemplaza
  // las condiciones por defecto de Vite (`module`, `node`, `development|production`) y omite
  // `module` a propósito: con ella se cargan builds ESM de dependencias (p. ej. @aws-sdk/*)
  // que no corren en Node sin bundler.
  ssr: {
    resolve: { conditions: ["@agentsales/source", "node", "development|production"] },
  },
  test: {
    include: ["{apps,packages}/*/{src,test}/**/*.test.{ts,tsx}"],
  },
});
