import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

const apiPort = Number(process.env.API_PORT ?? 8787);
const webPort = Number(process.env.WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Paquetes internos desde su código fuente (ADR-0010), más las condiciones por defecto de Vite.
  resolve: { conditions: ["@agentsales/source", ...defaultClientConditions] },
  server: {
    port: webPort,
    strictPort: true,
    // La API expone sus rutas sin prefijo y solo escucha en IPv4 (spec F0 §4.5).
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
