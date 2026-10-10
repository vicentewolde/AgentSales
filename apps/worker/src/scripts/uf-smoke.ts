import { loadEnv, loadEnvFile } from "@agentsales/config";
import { createBancoCentralUf } from "@agentsales/publishers/uf";
import { describeUnexpected } from "../smoke/ig-smoke.js";
import { runUfSmoke } from "../smoke/uf-smoke.js";

// `pnpm uf:smoke` (spec F5 §4.6, F5-T07): pide el valor de la UF de hoy y los próximos 31 días a la
// API BDE del Banco Central con tu `BCCH_API_TOKEN`, y una consulta con un token inventado, para
// confirmar lo que la nota `docs/integraciones/uf.md` marcó NO VERIFICADO. No toca la base ni
// publica. Habla con el Banco Central: lo corre el operador. Nunca imprime el token.

try {
  loadEnvFile();
  const env = loadEnv();
  process.exitCode = await runUfSmoke({
    token: env.BCCH_API_TOKEN,
    sourceFor: (token) => createBancoCentralUf({ token }),
    now: () => new Date(),
    print: (line) => console.log(line),
    printError: (line) => console.error(line),
  });
} catch (error) {
  console.error(`✗ ${describeUnexpected(error)}`);
  process.exitCode = 1;
}
