/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { realpathSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { liveFileDigest, observeLiveProcess, observeLiveProcessAsync } from './process-identity.js';

describe('actual Linux process birth observation', () => {
  it('pins an owned child and refuses its exited lifetime', async () => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', 'process.stdin.resume()'],
      {
        cwd: process.cwd(),
        stdio: ['pipe', 'ignore', 'ignore'],
      },
    );
    await once(child, 'spawn');
    try {
      const identity = observeLiveProcess(child.pid!);
      expect(identity.cwd).toBe(realpathSync(process.cwd()));
      expect(identity.executable).toBe(realpathSync(process.execPath));
      expect(identity.uid).toBe(process.getuid!());
      expect(identity.birth).toMatch(/^\d+$/);
      expect(identity.executableDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(observeLiveProcess(child.pid!)).toEqual(identity);
      let controllerTicked = false;
      setImmediate(() => {
        controllerTicked = true;
      });
      expect(await observeLiveProcessAsync(child.pid!, AbortSignal.timeout(5000))).toEqual(
        identity,
      );
      expect(controllerTicked).toBe(true);
      const closed = once(child, 'close');
      child.stdin.end();
      await closed;
      expect(() => observeLiveProcess(identity.pid)).toThrow('LIVE_PROCESS_IDENTITY_UNAVAILABLE');
      await expect(
        observeLiveProcessAsync(identity.pid, AbortSignal.timeout(5000)),
      ).rejects.toThrow('LIVE_PROCESS_IDENTITY_UNAVAILABLE');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill();
        await closed;
      }
    }
  });
  it('reads fresh contents after same-size replacement and supports cancellation during hashing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'live-digest-'));
    try {
      const path = join(root, 'input');
      writeFileSync(path, Buffer.alloc(262144, 65));
      const before = await liveFileDigest(path, AbortSignal.timeout(5000));
      writeFileSync(path, Buffer.alloc(262144, 66));
      expect(await liveFileDigest(path, AbortSignal.timeout(5000))).not.toBe(before);
      const cancel = new AbortController();
      const pending = liveFileDigest(path, cancel.signal);
      cancel.abort();
      await expect(pending).rejects.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])('refuses invalid or absent PID %s', (pid) => {
    expect(() => observeLiveProcess(pid)).toThrow('LIVE_PROCESS_IDENTITY_UNAVAILABLE');
  });
});
