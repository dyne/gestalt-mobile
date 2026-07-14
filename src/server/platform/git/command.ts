import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export async function git(cwd: string, args: string[]): Promise<string> {
  return (await execute('git', args, { cwd, shell: false })).stdout;
}
