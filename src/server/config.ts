import { resolve } from 'node:path';

export type RelayConfig = {
  host: string;
  port: number;
  root: string;
  dataDir?: string;
};

export function parseConfig(args: string[], cwd = process.cwd()): RelayConfig {
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const port = Number(value('--port') ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid --port');
  return {
    host: value('--host') ?? '0.0.0.0',
    port,
    root: resolve(cwd, value('--cwd') ?? '.'),
    dataDir: value('--data-dir'),
  };
}
