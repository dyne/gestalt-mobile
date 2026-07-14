import { spawn } from 'node:child_process';

const children = [
  spawn('npm', ['run', 'dev:server'], { stdio: 'inherit' }),
  spawn('npm', ['run', 'dev:client'], { stdio: 'inherit' }),
];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
};

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
for (const child of children) child.on('exit', (code) => stop(code ?? 1));
