/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ProjectWorkerOutput } from './project-process-worker.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
describe('private worker output flow control', () => {
  it('streams a multi-megabyte TCP response through a slow controller without exhausting the output bound', async () => {
    const payload = Buffer.alloc(4 * 1024 * 1024, 97);
    const server = createServer((socket) => socket.end(payload));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture address');
    const source = createConnection({ host: '127.0.0.1', port: address.port });
    const received = createHash('sha256');
    let bytes = 0;
    let peakQueued = 0;
    const sink = new Writable({
      highWaterMark: 1024,
      write(chunk, _encoding, done) {
        const frame = JSON.parse(String(chunk));
        const decoded = Buffer.from(frame.data, 'base64');
        received.update(decoded);
        bytes += decoded.length;
        setTimeout(done, 2);
      },
    });
    const overflow = vi.fn();
    const output = new ProjectWorkerOutput(sink, new Map([[1, source]]), overflow);
    try {
      source.on('data', (chunk: Buffer) => {
        for (let offset = 0; offset < chunk.length; offset += 65536) {
          output.send({
            type: 'data',
            id: 1,
            data: chunk.subarray(offset, offset + 65536).toString('base64'),
          });
          peakQueued = Math.max(peakQueued, sink.writableLength);
        }
      });
      await once(source, 'end');
      sink.end();
      await once(sink, 'finish');
      expect(bytes).toBe(payload.length);
      expect(received.digest('hex')).toBe(createHash('sha256').update(payload).digest('hex'));
      expect(peakQueued).toBeLessThanOrEqual(1024 * 1024);
      expect(overflow).not.toHaveBeenCalled();
    } finally {
      output.close();
      source.destroy();
      sink.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('a controller-held channel stays paused when unrelated output drains', async () => {
    const first = new PassThrough();
    const held = new PassThrough();
    const sink = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, done) {
        setTimeout(done, 5);
      },
    });
    const output = new ProjectWorkerOutput(
      sink,
      new Map([
        [1, first],
        [2, held],
      ]),
      vi.fn(),
    );
    let received = '';
    held.on('data', (bytes: Buffer) => (received += bytes.toString()));
    output.pause(2);
    output.send({ type: 'probe' });
    await once(sink, 'drain');
    held.write('held response');
    await sleep(10);
    expect(received).toBe('');
    output.resume(2);
    await sleep(10);
    expect(received).toBe('held response');
    output.close();
    first.destroy();
    held.destroy();
    sink.destroy();
  });
  it('a late drain cannot resume channels after worker shutdown', async () => {
    const source = new PassThrough();
    const sink = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, done) {
        setTimeout(done, 5);
      },
    });
    const output = new ProjectWorkerOutput(sink, new Map([[1, source]]), vi.fn());
    let bytes = 0;
    source.on('data', (chunk: Buffer) => (bytes += chunk.length));
    output.send({ type: 'probe' });
    output.close();
    source.write('must stay paused');
    await once(sink, 'drain');
    await sleep(10);
    expect(bytes).toBe(0);
    source.destroy();
    sink.destroy();
  });
});
