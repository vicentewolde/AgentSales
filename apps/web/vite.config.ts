import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig, loadEnv } from "vite";

/** Raíz del monorepo: ahí vive el `.env` que también leen la API y el worker. */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Puerto válido (1–65535) o el valor por defecto; mismo criterio que `loadEnv` de config. */
function port(value: string | undefined, fallback: number): number {
  const raw = value?.trim() ?? "";
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return parsed >= 1 && parsed <= 65535 ? parsed : fallback;
}

export default defineConfig(({ mode }) => {
  // Solo para la configuración: nada de esto llega al navegador (no hay prefijo VITE_).
  const env = loadEnv(mode, ROOT, "");
  const apiPort = port(env.API_PORT, 8787);
  const webPort = port(env.WEB_PORT, 5173);

  return {
    plugins: [react(), tailwindcss()],
    // Paquetes internos desde su código fuente (ADR-0010), más las condiciones por defecto de Vite.
    resolve: { conditions: ["@agentsales/source", ...defaultClientConditions] },
    build: {
      rollupOptions: {
        output: {
          // zod y su configuración sin `eval` (`src/zod-config.ts`, F8-T10) en un mismo trozo: se
          // ejecuta entero antes que el código que crea esquemas (core), así la CSP no anota nada.
          manualChunks: (id: string) =>
            /[\\/]node_modules[\\/](\.pnpm[\\/])?zod/.test(id) || id.endsWith("/src/zod-config.ts")
              ? "zod"
              : undefined,
        },
      },
    },
    server: {
      // En IPv4 (spec F0 §4.5 y F9.5-T02): sin `host`, Vite escucha solo en `[::1]` y
      // `http://127.0.0.1:5173` no abre. Con `127.0.0.1`, el navegador también llega por
      // `localhost` (cae en IPv4), y la API acepta los dos (`localAccess`).
      host: "127.0.0.1",
      port: webPort,
      strictPort: true,
      // La API va bajo `/api` también en el Mac (spec F8 §4.3, ADR-0024): el proxy la pasa tal
      // cual.
      proxy: {
        "/api": { target: `http://127.0.0.1:${apiPort}` },
      },
    },
  };
});
