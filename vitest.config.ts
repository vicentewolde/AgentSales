import { defineConfig } from "vitest/config";

// Los paquetes internos se resuelven a su código fuente (ADR-0010). Cada lista reemplaza las
// condiciones por defecto de Vite, así que se repiten a mano (`vite` no es dependencia de la raíz).
export default defineConfig({
  // Tests del panel (jsdom): las condiciones de Vite para el navegador.
  resolve: {
    conditions: ["@agentsales/source", "module", "browser", "development|production"],
  },
  // Tests de Node: sin `module` a propósito, porque carga builds ESM de dependencias
  // (p. ej. @aws-sdk/*) que no corren en Node sin bundler.
  ssr: {
    resolve: { conditions: ["@agentsales/source", "node", "development|production"] },
  },
  test: {
    include: ["{apps,packages}/*/{src,test}/**/*.test.{ts,tsx}"],
  },
});
