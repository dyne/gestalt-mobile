import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { JsonRpcClient } from './json-rpc-client.js';
import { profileAppServerCommand } from '../catalog/profile-command.js';

export type CodexProcess = {
  child: ChildProcessWithoutNullStreams;
  rpc: JsonRpcClient;
  close(): void;
  onExit(listener: () => void): () => void;
};

export function launchCodexAppServer(input: { profile: string; cwd: string }): CodexProcess {
  const launch = profileAppServerCommand(input.profile);
  const child = spawn(launch.command, launch.args, {
    cwd: input.cwd,
    shell: false,
    stdio: 'pipe',
  });
  const rpc = new JsonRpcClient(child.stdout, child.stdin);
  child.once('error', (error) => rpc.fail(error));
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
