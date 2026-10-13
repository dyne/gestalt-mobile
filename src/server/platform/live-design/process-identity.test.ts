/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { observeLiveProcess } from './process-identity.js';

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
      const closed = once(child, 'close');
      child.stdin.end();
      await closed;
      expect(() => observeLiveProcess(identity.pid)).toThrow('LIVE_PROCESS_IDENTITY_UNAVAILABLE');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill();
        await closed;
      }
    }
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER])('refuses invalid or absent PID %s', (pid) => {
    expect(() => observeLiveProcess(pid)).toThrow('LIVE_PROCESS_IDENTITY_UNAVAILABLE');
  });
});
