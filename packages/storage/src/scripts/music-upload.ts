import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadEnv, loadEnvFile } from "@agentsales/config";
import { musicUploadText, uploadMusicFolder } from "../music-upload.js";
import { createR2Storage } from "../r2-storage.js";

// `pnpm music:upload <carpeta>` (F9.5-T19): sube a R2 las pistas de música que el operador bajó,
// escuchó y aprobó (`docs/integraciones/musica-reels.md`). Habla con R2: lo corre el operador. Con
// `ENV_FILE=.env.production`, el bucket de producción. No imprime credenciales ni URLs firmadas.
const { positionals } = parseArgs({ allowPositionals: true, options: {} });
const dir = positionals[0];
if (dir === undefined) {
  process.stderr.write("Uso: pnpm music:upload <carpeta con las pistas .mp3>\n");
  process.exit(2);
}
loadEnvFile();
const env = loadEnv();
const storage = createR2Storage({
  accountId: env.R2_ACCOUNT_ID,
  accessKeyId: env.R2_ACCESS_KEY_ID,
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  bucket: env.R2_BUCKET,
  signedUrlTtlSeconds: env.SIGNED_URL_TTL_SECONDS,
});
// pnpm corre el script en `packages/storage`: la carpeta relativa es la del operador (`INIT_CWD`).
const report = await uploadMusicFolder(
  storage,
  resolve(process.env.INIT_CWD ?? process.cwd(), dir),
);
process.stdout.write(`${musicUploadText(report)}\n`);
process.exit(report.outcomes.some((outcome) => outcome.status === "rejected") ? 1 : 0);
