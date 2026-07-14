import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CodexProfileCatalog } from './platform/catalog/codex-profile-catalog.js';
import { composeRelayApp } from './composition.js';
import { parseConfig } from './config.js';

const config = parseConfig(process.argv.slice(2));
const staticDir = resolve(process.cwd(), 'dist/client');
const runFile = promisify(execFile);
const installedCodexVersion = await runFile('codex', ['--version'])
  .then(({ stdout }) => stdout.trim() || null)
  .catch(() => null);
const app = await composeRelayApp({
  root: config.root,
  dataDir: config.dataDir,
  staticDir: existsSync(resolve(staticDir, 'index.html')) ? staticDir : undefined,
  profiles: new CodexProfileCatalog(),
  installedCodexVersion,
  startAppServers: true,
});

try {
  await app.listen({ host: config.host, port: config.port });
  console.info(`Codex Relay listening on http://${config.host}:${config.port}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Relay startup failed');
  process.exitCode = 1;
}
