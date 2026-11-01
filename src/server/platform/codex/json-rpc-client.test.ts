/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CODEX_JSON_RPC_ERROR,
  CODEX_THREAD_NOT_FOUND,
  CODEX_THREAD_WRITER_BUSY,
  CodexJsonRpcError,
  isMissingCodexThreadRollout,
  JsonRpcClient,
} from './json-rpc-client.js';

describe('JsonRpcClient', () => {
  it('classifies only the confirmed active-writer protocol response', () => {
    expect(new CodexJsonRpcError(-32600, 'Thread thread-1 already has an active writer').kind).toBe(
      CODEX_THREAD_WRITER_BUSY,
    );
    expect(new CodexJsonRpcError(-32600, 'active writer exists').kind).not.toBe(
      CODEX_THREAD_WRITER_BUSY,
    );
  });
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

  it.each([
    [
      'synchronous throw',
      () => {
        throw new Error('HANDLER_FAILED');
      },
    ],
    ['rejected promise', () => Promise.reject(new Error('HANDLER_FAILED'))],
  ] as const)('writes exactly one associated error response for a %s', async (_kind, handler) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonRpcClient(input, output);
    const replies: unknown[] = [];
    const settlements: unknown[] = [];
    output.on('data', (line) => replies.push(JSON.parse(line.toString())));
    client.onServerResponseSettled((settlement) => settlements.push(settlement));
    client.onServerRequest(handler);
    try {
      input.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 51, method: 'item/tool/call', params: {} })}\n`,
      );
      // Drain dispatch microtasks and stream write callbacks without waiting for a reply
      // that the broken synchronous dispatch never produces.
      await new Promise((resolve) => setImmediate(resolve));
      expect({ replies, settlements }).toEqual({
        replies: [{ jsonrpc: '2.0', id: 51, error: { message: 'HANDLER_FAILED' } }],
        settlements: [{ id: 51, outcome: 'errorWritten' }],
      });
    } finally {
      input.destroy();
      output.destroy();
    }
  });

  it('writes exactly one associated successful server response', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonRpcClient(input, output);
    const replies: unknown[] = [];
    const settlements: unknown[] = [];
    const requests: unknown[] = [];
    output.on('data', (line) => replies.push(JSON.parse(line.toString())));
    client.onServerResponseSettled((settlement) => settlements.push(settlement));
    client.onServerRequest((request) => {
      requests.push(request);
      return { acknowledged: true };
    });
    try {
      input.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 52, method: 'item/tool/call', params: { name: 'tool' } })}\n`,
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(requests).toEqual([{ id: 52, method: 'item/tool/call', params: { name: 'tool' } }]);
      expect({ replies, settlements }).toEqual({
        replies: [{ jsonrpc: '2.0', id: 52, result: { acknowledged: true } }],
        settlements: [{ id: 52, outcome: 'resultWritten' }],
      });
    } finally {
      input.destroy();
      output.destroy();
    }
  });

  it('ignores malformed input and still handles the next valid server request', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonRpcClient(input, output);
    const replies: unknown[] = [];
    const settlements: unknown[] = [];
    const requests: unknown[] = [];
    output.on('data', (line) => replies.push(JSON.parse(line.toString())));
    client.onServerResponseSettled((settlement) => settlements.push(settlement));
    client.onServerRequest((request) => {
      requests.push(request);
      return { acknowledged: true };
    });
    try {
      input.write('{"jsonrpc":"2.0","id":53,"method":\n');
      await new Promise((resolve) => setImmediate(resolve));
      expect({ requests, replies, settlements }).toEqual({
        requests: [],
        replies: [],
        settlements: [],
      });
      input.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 54, method: 'item/tool/call', params: {} })}\n`,
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(requests).toEqual([{ id: 54, method: 'item/tool/call', params: {} }]);
      expect({ replies, settlements }).toEqual({
        replies: [{ jsonrpc: '2.0', id: 54, result: { acknowledged: true } }],
        settlements: [{ id: 54, outcome: 'resultWritten' }],
      });
    } finally {
      input.destroy();
      output.destroy();
    }
  });

  it('reports server-response settlement only after the response write completes', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonRpcClient(input, output);
    const settlements: unknown[] = [];
    client.onServerRequest(() => ({ acknowledged: true }));
    client.onServerResponseSettled((settlement) => settlements.push(settlement));
    const written = new Promise<void>((resolve) => output.once('data', () => resolve()));
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'item/tool/call', params: {} })}\n`,
    );
    expect(settlements).toEqual([]);
    await written;
    await new Promise((resolve) => setImmediate(resolve));
    expect(settlements).toEqual([{ id: 42, outcome: 'resultWritten' }]);
  });

  it.each([
    ['synchronous write throw', 'success'],
    ['synchronous write throw', 'handler failure'],
    ['write callback failure', 'success'],
    ['write callback failure', 'handler failure'],
  ] as const)(
    'settles a %s once after %s without retrying',
    async (writeFailure, handlerOutcome) => {
      const input = new PassThrough();
      const attempts: unknown[] = [];
      const writeError = new Error('OUTPUT_FAILED');
      const output = new Writable({
        write(chunk, _encoding, callback) {
          attempts.push(JSON.parse(chunk.toString()));
          if (writeFailure === 'synchronous write throw') throw writeError;
          callback(writeError);
        },
      });
      const streamErrors: unknown[] = [];
      // Writable emits callback errors separately; its owner observes that event.
      output.on('error', (error) => streamErrors.push(error));
      const client = new JsonRpcClient(input, output);
      const settlements: unknown[] = [];
      client.onServerResponseSettled((settlement) => settlements.push(settlement));
      client.onServerRequest(() => {
        if (handlerOutcome === 'handler failure') throw new Error('HANDLER_FAILED');
        return { acknowledged: true };
      });
      try {
        input.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: 55, method: 'item/tool/call', params: {} })}\n`,
        );
        await new Promise((resolve) => setImmediate(resolve));
        expect(attempts).toEqual([
          {
            jsonrpc: '2.0',
            id: 55,
            ...(handlerOutcome === 'handler failure'
              ? { error: { message: 'HANDLER_FAILED' } }
              : { result: { acknowledged: true } }),
          },
        ]);
        expect(settlements).toEqual([{ id: 55, outcome: 'writeFailed' }]);
        expect(streamErrors).toEqual(writeFailure === 'write callback failure' ? [writeError] : []);
      } finally {
        input.destroy();
        output.destroy();
      }
    },
  );

  it('settles an unserializable result as a write failure without a second response', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonRpcClient(input, output);
    const replies: unknown[] = [];
    const settlements: unknown[] = [];
    const result: { self?: unknown } = {};
    result.self = result;
    output.on('data', (line) => replies.push(JSON.parse(line.toString())));
    client.onServerResponseSettled((settlement) => settlements.push(settlement));
    client.onServerRequest(() => result);
    try {
      input.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 56, method: 'item/tool/call', params: {} })}\n`,
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect({ replies, settlements }).toEqual({
        replies: [],
        settlements: [{ id: 56, outcome: 'writeFailed' }],
      });
    } finally {
      input.destroy();
      output.destroy();
    }
  });

  it('rejects pending and later requests after the app-server process fails', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonRpcClient(input, output);
    const pending = client.request('initialize', {});
    const failure = new Error('spawn codex ENOENT');

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
      expect((error as CodexJsonRpcError).code).toBe(-32600);
      expect((error as CodexJsonRpcError).kind).toBe(CODEX_THREAD_NOT_FOUND);
      expect(isMissingCodexThreadRollout(error)).toBe(true);
      return true;
    });
    expect(
      isMissingCodexThreadRollout(
        new CodexJsonRpcError(-32600, 'invalid parameters for thread/resume'),
      ),
    ).toBe(false);
  });

  it('keeps generic and authentication failures as bounded ordinary RPC errors', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonRpcClient(input, output);
    const response = client.request('thread/resume', { threadId: 'thread-1' });
    output.once('data', (line) =>
      input.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: JSON.parse(line.toString()).id,
          error: { code: -32600, message: `authentication failed: ${'secret-token-'.repeat(40)}` },
        })}\n`,
      ),
    );

    await expect(response).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CodexJsonRpcError);
      expect((error as CodexJsonRpcError).kind).toBe(CODEX_JSON_RPC_ERROR);
      expect((error as Error).message).toBe('authentication failed: [REDACTED]');
      expect((error as Error).message).not.toContain('secret-token');
      expect(isMissingCodexThreadRollout(error)).toBe(false);
      return true;
    });
  });
});
