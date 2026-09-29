import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["{apps,packages}/*/{src,test}/**/*.test.{ts,tsx}"],
    // Temporal: se quita en F0-T02, la primera tarea con tests.
    passWithNoTests: true,
  },
});
