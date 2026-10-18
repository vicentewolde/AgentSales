// La CI (spec F8 §4.7, T10): abre el panel compilado que sirve la imagen y falla si el navegador
// registra un error de la CSP. Corre dentro de la misma imagen (trae Chromium y Playwright):
//   docker run --network host -v "$PWD/.github/scripts:/scripts:ro" <imagen> node /scripts/panel-csp.mjs
// La API de la imagen exige el Host de `PUBLIC_URL` (`agentsales.test`): Chromium resuelve ese
// nombre a la API local con `--host-resolver-rules`, así el pedido lleva el Host correcto.
import { createRequire } from "node:module";

// Playwright de `packages/media` (en la imagen, `/app`; `PLAYWRIGHT_FROM` para probarlo en otra copia).
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? "/app/packages/media/package.json");
const { chromium } = require("playwright");

const PANEL = process.env.PANEL_URL ?? "http://agentsales.test/entrar";
const TARGET = process.env.PANEL_TARGET ?? "127.0.0.1:8080";

const browser = await chromium.launch({
  args: [`--host-resolver-rules=MAP agentsales.test ${TARGET}`],
});
const violations = [];
const errors = [];
try {
  const page = await browser.newPage();
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // La base no existe en la CI: las llamadas a la API pueden fallar (503) y eso se espera.
    if (/Content.Security.Policy/i.test(text)) violations.push(text);
    else errors.push(text);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  // Las violaciones que no llegan a la consola (por ejemplo, un estilo en línea).
  await page.exposeFunction("reportCspViolation", (text) => violations.push(text));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      window.reportCspViolation(`${event.violatedDirective}: ${event.blockedURI}`);
    });
  });
  const response = await page.goto(PANEL, { waitUntil: "networkidle" });
  if (response === null || !response.ok()) {
    throw new Error(`el panel respondió ${response?.status() ?? "sin respuesta"}`);
  }
  const csp = response.headers()["content-security-policy"];
  if (csp === undefined) throw new Error("el panel no trae la cabecera Content-Security-Policy");
  // Que la app de React haya montado: el formulario de Entrar.
  await page.getByRole("button", { name: /entrar/i }).waitFor({ timeout: 15_000 });
  console.log(`panel cargado (${PANEL}); CSP: ${csp}`);
  for (const error of errors)
    console.log(`  (otro error en la consola, esperado sin base): ${error}`);
} finally {
  await browser.close();
}

if (violations.length > 0) {
  console.error("errores de la CSP en el panel:");
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log("sin errores de la CSP");
