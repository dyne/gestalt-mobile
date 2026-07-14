import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { JsonRpcClient } from './json-rpc-client.js';

describe('JsonRpcClient', () => {
  it('correlates a JSONL response to its request', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonRpcClient(input, output);
    const result = client.request('thread/start', { cwd: '/work' });
    output.once('data', (line) =>
      input.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(line.toString()).id, result: { thread: { id: 't' } } })}\n`,
      ),
    );
    await expect(result).resolves.toEqual({ thread: { id: 't' } });
  });
});
