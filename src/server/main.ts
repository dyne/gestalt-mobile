import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildApp } from './app.js';
import { parseConfig } from './config.js';

const config = parseConfig(process.argv.slice(2));
const staticDir = resolve(process.cwd(), 'dist/client');
const app = await buildApp({
  health: {
    async read() {
      return {
        status: 'degraded',
        version: '0.1.0',
        codex: { installedVersion: null, protocolVersion: null, compatible: false },
      };
    },
  },
  logger: console,
  staticDir: existsSync(resolve(staticDir, 'index.html')) ? staticDir : undefined,
});

try {
  await app.listen({ host: config.host, port: config.port });
  console.info(`Codex Relay listening on http://${config.host}:${config.port}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Relay startup failed');
  process.exitCode = 1;
}
