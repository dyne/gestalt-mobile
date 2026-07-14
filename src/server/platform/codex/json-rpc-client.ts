import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export class JsonRpcClient {
  private sequence = 0;
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(reason: unknown): void }
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
  private receive(line: string): void {
    try {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (message.id === undefined) return;
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
