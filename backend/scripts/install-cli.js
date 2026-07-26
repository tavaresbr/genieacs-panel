#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryDir = path.resolve(scriptDir, '..', '..');
const expectedInstallDir = path.resolve(process.env.SKYGP_DIR || '/opt/skygenpanel');
const explicitTarget = process.env.SKYGP_CLI_PATH;
const targetPath = path.resolve(explicitTarget || '/usr/local/bin/skygenpanel');
const sourcePath = path.join(repositoryDir, 'deploy', 'skygenpanel');
const allowNonRoot = process.env.SKYGP_INSTALL_CLI === '1' && Boolean(explicitTarget);

function log(message) {
  console.log(`[skygp] ${message}`);
}

function skip(message) {
  log(`CLI bootstrap skipped: ${message}`);
  process.exit(0);
}

if (repositoryDir !== expectedInstallDir) {
  skip(`repository is not the production checkout (${expectedInstallDir})`);
}
if (typeof process.getuid === 'function' && process.getuid() !== 0 && !allowNonRoot) {
  skip('root privileges are required');
}
if (!fs.existsSync(sourcePath)) {
  throw new Error(`CLI source is missing: ${sourcePath}`);
}

fs.mkdirSync(path.dirname(targetPath), { recursive: true });
if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isSymbolicLink()) {
  throw new Error(`Refusing symbolic-link CLI target: ${targetPath}`);
}

const tempPath = `${targetPath}.new.${process.pid}`;
try {
  fs.copyFileSync(sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(tempPath, 0o755);
  fs.renameSync(tempPath, targetPath);
  log(`CLI updated at ${targetPath}`);
} finally {
  if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
}
