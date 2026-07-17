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

  it('publishes server notifications without affecting request correlation', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonRpcClient(input, output);
    const received: unknown[] = [];
    client.onNotification((notification) => received.push(notification));
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { delta: 'hi' } })}\n`,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toEqual([{ method: 'item/agentMessage/delta', params: { delta: 'hi' } }]);
  });

  it('routes a server request and writes its JSON-RPC response', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonRpcClient(input, output);
    client.onServerRequest(async (request) => ({
      approved: request.method === 'item/commandExecution/requestApproval',
    }));
    const written = new Promise<string>((resolve) =>
      output.once('data', (line) => resolve(line.toString())),
    );
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'item/commandExecution/requestApproval', params: {} })}\n`,
    );
    await expect(written).resolves.toContain('"id":41');
  });

  it('rejects pending and later requests after the app-server process fails', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonRpcClient(input, output);
    const pending = client.request('initialize', {});
    const failure = new Error('spawn codex-profile ENOENT');

    client.fail(failure);

    await expect(pending).rejects.toBe(failure);
    await expect(client.request('thread/start', {})).rejects.toBe(failure);
  });
});
