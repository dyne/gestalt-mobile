import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export const GIT_READ_TIMEOUT_MS = 15_000;
export const GIT_FETCH_TIMEOUT_MS = 120_000;

export async function git(
  cwd: string,
  args: string[],
  timeoutMs: number = GIT_READ_TIMEOUT_MS,
): Promise<string> {
  return (await execute('git', args, { cwd, shell: false, timeout: timeoutMs })).stdout;
}
