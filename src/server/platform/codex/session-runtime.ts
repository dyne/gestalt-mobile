import {
  RelaySession,
  type RelaySessionSnapshot,
} from '../../features/sessions/model/relay-session.js';

export type AppServer = {
  rpc: {
    request(method: string, params: unknown): Promise<unknown>;
    onNotification(
      listener: (notification: { method: string; params: unknown }) => void,
    ): () => void;
    onServerRequest(
      listener: (request: { id: number; method: string; params: unknown }) => Promise<unknown>,
    ): () => void;
  };
  close(): void;
};

export class CodexSessionRuntime {
  constructor(
    private readonly launch: (input: { profile: string; cwd: string }) => AppServer,
    private readonly processes = new Map<string, AppServer>(),
    private readonly onNotification?: (
      sessionId: string,
      notification: { method: string; params: unknown },
    ) => void,
    private readonly onServerRequest?: (
      sessionId: string,
      request: { id: number; method: string; params: unknown },
    ) => boolean,
  ) {}
  private readonly pendingRequests = new Map<string, (result: unknown) => void>();

  async start(session: RelaySessionSnapshot, now: string): Promise<RelaySessionSnapshot> {
    const process = this.launch({ profile: session.profile, cwd: session.workspacePath });
    try {
      process.rpc.onNotification((notification) => this.onNotification?.(session.id, notification));
      process.rpc.onServerRequest((request) => this.holdServerRequest(session.id, request));
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

  resolveServerRequest(sessionId: string, requestId: string, result: unknown): boolean {
    const key = `${sessionId}:${requestId}`;
    const resolve = this.pendingRequests.get(key);
    if (!resolve) return false;
    this.pendingRequests.delete(key);
    resolve(result);
    return true;
  }

  async startTurn(
    session: RelaySessionSnapshot,
    text: string,
    now: string,
  ): Promise<RelaySessionSnapshot> {
    const process = this.processes.get(session.id);
    if (!process || !session.threadId) throw new Error('CODEX_SESSION_NOT_RUNNING');
    const result = (await process.rpc.request('turn/start', {
      threadId: session.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    })) as { turn?: { id?: string } };
    if (!result.turn?.id) throw new Error('CODEX_TURN_ID_MISSING');
    return RelaySession.rehydrate(session).startTurn(result.turn.id, now).snapshot;
  }

  async readHistory(session: RelaySessionSnapshot): Promise<Array<Record<string, unknown>>> {
    const process = this.processes.get(session.id);
    if (!process || !session.threadId) throw new Error('CODEX_SESSION_NOT_RUNNING');
    const result = (await process.rpc.request('thread/read', {
      threadId: session.threadId,
      includeTurns: true,
    })) as { thread?: { turns?: Array<{ items?: Array<Record<string, unknown>> }> } };
    return result.thread?.turns?.flatMap((turn) => turn.items ?? []) ?? [];
  }

  async restore(session: RelaySessionSnapshot, now: string): Promise<RelaySessionSnapshot> {
    if (!session.threadId) throw new Error('CODEX_THREAD_ID_MISSING');
    const process = this.launch({ profile: session.profile, cwd: session.workspacePath });
    try {
      process.rpc.onNotification((notification) => this.onNotification?.(session.id, notification));
      process.rpc.onServerRequest((request) => this.holdServerRequest(session.id, request));
      await process.rpc.request('initialize', {
        clientInfo: { name: 'codex-relay', version: '0.1.0' },
        capabilities: null,
      });
      await process.rpc.request('thread/resume', {
        threadId: session.threadId,
        cwd: session.workspacePath,
      });
      this.processes.set(session.id, process);
      return RelaySession.rehydrate(session).restore(now).snapshot;
    } catch (error) {
      process.close();
      throw error;
    }
  }

  private holdServerRequest(
    sessionId: string,
    request: { id: number; method: string; params: unknown },
  ): Promise<unknown> {
    if (!this.onServerRequest?.(sessionId, request)) {
      return Promise.reject(new Error('CODEX_SERVER_REQUEST_UNSUPPORTED'));
    }
    return new Promise((resolve) =>
      this.pendingRequests.set(`${sessionId}:${request.id}`, resolve),
    );
  }
}
