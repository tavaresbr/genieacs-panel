import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A versão do servidor, lida do `package.json` uma vez. Fora do `/api/health`
 * desde a página de status (0127): só quem tem sessão a lê (`/api/version` e
 * `/api/platform/deployment`).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')
).version;
