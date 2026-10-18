// Primero: zod sin `eval`, antes de que se cree cualquier esquema (F8-T10).
import "./zod-config.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Falta el elemento #root en index.html");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
