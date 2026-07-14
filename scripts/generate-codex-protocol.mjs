import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const output = new URL('../src/server/platform/codex/generated/', import.meta.url);
mkdirSync(output, { recursive: true });
execFileSync('codex', ['app-server', 'generate-ts', '--experimental', '--out', output.pathname], {
  stdio: 'inherit',
});
writeFileSync(
  new URL('../src/server/platform/codex/protocol-version.json', import.meta.url),
  `${JSON.stringify({ version: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim() }, null, 2)}\n`,
);
