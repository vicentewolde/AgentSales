import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/*/{src,test}/**/*.test.ts"],
    // Mientras ningún paquete tenga tests (F0-T01), vitest no debe fallar.
    passWithNoTests: true,
  },
});
