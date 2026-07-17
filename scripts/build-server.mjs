import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

rmSync('dist/server', { recursive: true, force: true });
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], {
  stdio: 'inherit',
});
