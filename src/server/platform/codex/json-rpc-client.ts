import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export class JsonRpcClient {
  private sequence = 0;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(reason: unknown): void }
  >();
  private readonly notifications = new Set<
    (notification: { method: string; params: unknown }) => void
  >();
  constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    createInterface({ input, crlfDelay: Infinity }).on('line', (line) => this.receive(line));
  }
  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.sequence;
    this.output.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  onNotification(
    listener: (notification: { method: string; params: unknown }) => void,
  ): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }
  private receive(line: string): void {
    try {
      const message = JSON.parse(line) as {
        id?: number;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: unknown;
      };
      if (message.id === undefined) {
        if (message.method)
          this.notifications.forEach((listener) =>
            listener({ method: message.method!, params: message.params }),
          );
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(message.error);
      else pending.resolve(message.result);
    } catch {
      /* malformed protocol messages are ignored at this boundary */
    }
  }
}
