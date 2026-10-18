import { z } from "zod";

// La CSP del panel no permite `eval` (spec F8 §4.3): sin esto, zod lo prueba (`new Function`) al
// crear los esquemas y el navegador anota una violación de la CSP (F8-T10). Sin compilar, valida
// igual. Va en su propio módulo, importado primero en `main.tsx`: los esquemas se crean al importar
// el resto.
z.config({ jitless: true });
