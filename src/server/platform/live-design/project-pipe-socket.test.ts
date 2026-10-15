/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { buffer } from 'node:stream/consumers';
import { finished } from 'node:stream/promises';
import { describe, expect, it, vi } from 'vitest';
import { ProjectPipeSocket } from './isolated-project-process.js';

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
describe('private project socket response integrity', () => {
  it('delivers every buffered response byte to a delayed reader after normal peer EOF', async () => {
    const send = vi.fn();
    const released = vi.fn();
    const socket = new ProjectPipeSocket(send, 1, released);
    const payload = Buffer.from(Array.from({ length: 262144 }, (_, index) => index % 251));
    for (let offset = 0; offset < payload.length; offset += 65536)
      socket.deliver(payload.subarray(offset, offset + 65536));
    socket.endFromPeer();
    socket.closeFromPeer();
    await tick();
    const received = await buffer(socket);
    await finished(socket);
    expect(received.length).toBe(payload.length);
    expect(digest(received)).toBe(digest(payload));
    expect(released).toHaveBeenCalledOnce();
    expect(send.mock.calls.some(([message]) => message.op === 'resume')).toBe(false);
  });
  it('revocation still discards buffered bytes immediately after peer EOF', async () => {
    const released = vi.fn();
    const socket = new ProjectPipeSocket(vi.fn(), 1, released);
    let received = 0;
    socket.deliver(Buffer.alloc(262144, 97));
    socket.endFromPeer();
    socket.closeFromPeer();
    const closed = once(socket, 'close');
    socket.destroy();
    await closed;
    socket.on('data', (bytes: Buffer) => (received += bytes.length));
    socket.resume();
    await tick();
    expect(received).toBe(0);
    expect(released).toHaveBeenCalledOnce();
  });
  it('an upstream close without EOF fails rather than claiming a complete response', async () => {
    const socket = new ProjectPipeSocket(vi.fn(), 1, vi.fn());
    const error = once(socket, 'error');
    socket.deliver(Buffer.from('partial response'));
    socket.closeFromPeer();
    expect((await error)[0].message).toBe('LIVE_PROJECT_PROCESS_UNAVAILABLE');
    expect(socket.destroyed).toBe(true);
  });
});
