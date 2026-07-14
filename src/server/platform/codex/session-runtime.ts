import {
  RelaySession,
  type RelaySessionSnapshot,
} from '../../features/sessions/model/relay-session.js';

export type AppServer = {
  rpc: { request(method: string, params: unknown): Promise<unknown> };
  close(): void;
};

export class CodexSessionRuntime {
  constructor(
    private readonly launch: (input: { profile: string; cwd: string }) => AppServer,
    private readonly processes = new Map<string, AppServer>(),
  ) {}

  async start(session: RelaySessionSnapshot, now: string): Promise<RelaySessionSnapshot> {
    const process = this.launch({ profile: session.profile, cwd: session.workspacePath });
    try {
      await process.rpc.request('initialize', {
        clientInfo: { name: 'codex-relay', version: '0.1.0' },
        capabilities: null,
      });
      const result = (await process.rpc.request('thread/start', {
        cwd: session.workspacePath,
        approvalPolicy: 'on-request',
      })) as { thread?: { id?: string } };
      if (!result.thread?.id) throw new Error('CODEX_THREAD_ID_MISSING');
      this.processes.set(session.id, process);
      return RelaySession.rehydrate(session).bindThread(result.thread.id, now).snapshot;
    } catch (error) {
      process.close();
      throw error;
    }
  }

  stop(sessionId: string): void {
    this.processes.get(sessionId)?.close();
    this.processes.delete(sessionId);
  }
}
