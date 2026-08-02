/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CodexJsonRpcError, isMissingCodexThreadRollout, JsonRpcClient } from './json-rpc-client.js';

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

  it('classifies only Codex’s missing-rollout invalid request response', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonRpcClient(input, output);
    const response = client.request('thread/resume', { threadId: 'thread-1' });
    output.once('data', (line) =>
      input.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: JSON.parse(line.toString()).id,
          error: { code: -32600, message: 'no rollout found for thread id thread-1' },
        })}\n`,
      ),
    );

    await expect(response).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CodexJsonRpcError);
      expect(isMissingCodexThreadRollout(error)).toBe(true);
      return true;
    });
    expect(
      isMissingCodexThreadRollout(
        new CodexJsonRpcError(-32600, 'invalid parameters for thread/resume'),
      ),
    ).toBe(false);
  });
});
