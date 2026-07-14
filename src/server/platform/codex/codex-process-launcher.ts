import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { JsonRpcClient } from './json-rpc-client.js';

export type CodexProcess = {
  child: ChildProcessWithoutNullStreams;
  rpc: JsonRpcClient;
  close(): void;
  onExit(listener: () => void): () => void;
};

export function launchCodexAppServer(input: { profile: string; cwd: string }): CodexProcess {
  const child = spawn('codex-profile', ['cli', input.profile, 'app-server', '--stdio'], {
    cwd: input.cwd,
    shell: false,
    stdio: 'pipe',
  });
  const rpc = new JsonRpcClient(child.stdout, child.stdin);
  return {
    child,
    rpc,
    close: () => child.kill('SIGTERM'),
    onExit: (listener) => {
      child.once('exit', listener);
      return () => child.off('exit', listener);
    },
  };
}
