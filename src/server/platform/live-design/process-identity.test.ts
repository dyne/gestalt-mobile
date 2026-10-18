/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { realpathSync, mkdtempSync, writeFileSync, rmSync, linkSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import * as fileSystem from 'node:fs';
import {
  ConnectionFileVerification,
  liveFileDigest,
  observeLiveProcess,
  observeLiveProcessAsync,
} from './process-identity.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));

describe('actual Linux process birth observation', () => {
  it('hashes actual inode aliases once in one connection, independently reads copies and refuses reuse or mutation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'live-connection-files-'));
    try {
      const file = join(root, 'binary'),
        alias = join(root, 'alias'),
        copy = join(root, 'copy');
      writeFileSync(file, Buffer.alloc(262144, 65));
      linkSync(file, alias);
      copyFileSync(file, copy);
      const scope = new ConnectionFileVerification();
      scope.claim('owner', 1, root, 'helper');
      scope.claim('owner', 1, root, 'devserver');
      const signal = AbortSignal.timeout(5000);
      const [first, second] = await Promise.all([
        scope.digest(file, signal),
        scope.digest(alias, signal),
      ]);
      expect(first).toBe(second);
      expect(scope.statistics()).toEqual({ readOperations: 1, bytesRead: 262144 });
      expect(scope.verifiedDigest(alias)).toBe(first);
      expect(await scope.digest(copy, signal)).toBe(first);
      expect(scope.statistics()).toEqual({ readOperations: 2, bytesRead: 524288 });
      expect(() => scope.claim('owner', 1, root, 'helper')).toThrow(
        'LIVE_CONNECTION_VERIFICATION_SCOPE',
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      writeFileSync(alias, Buffer.alloc(262144, 66));
      expect(() => scope.verifiedDigest(file)).toThrow('LIVE_CONNECTION_FILE_CHANGED');
      await expect(scope.digest(file, signal)).rejects.toThrow('LIVE_CONNECTION_FILE_CHANGED');
      scope.consume();
      await expect(scope.digest(copy, signal)).rejects.toThrow(
        'LIVE_CONNECTION_VERIFICATION_CONSUMED',
      );
      const next = new ConnectionFileVerification();
      next.claim('owner', 1, root, 'helper');
      expect(await next.digest(file, signal)).not.toBe(first);
      expect(next.statistics()).toEqual({ readOperations: 1, bytesRead: 262144 });
      expect(() => next.claim('other-owner', 1, root, 'devserver')).toThrow(
        'LIVE_CONNECTION_VERIFICATION_SCOPE',
      );
      next.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('cancels a connection scope during real file IO without accepting a late digest', async () => {
    const scope = new ConnectionFileVerification();
    scope.claim('owner', 1, '/app', 'helper');
    const pending = scope.digest('/proc/self/exe', AbortSignal.timeout(5000));
    while (scope.statistics().readOperations === 0)
      await new Promise<void>((resolve) => setImmediate(resolve));
    scope.close();
    const code = await pending.then(
      () => 'UNEXPECTED_SUCCESS',
      (error: NodeJS.ErrnoException) => error.code,
    );
    expect(code).toBe('ABORT_ERR');
  });
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

it('keeps only stable kernel birth/isolation across actual unsynchronized exec and refuses exit', async () => {
  const child = spawn(
    '/usr/bin/bash',
    [
      '--noprofile',
      '--norc',
      '-c',
      'IFS= read -r -t 0.05 line || :; exec "$@"',
      'fixed-wrapper',
      process.execPath,
      '-e',
      'process.stdin.resume()',
    ],
    { stdio: 'pipe' },
  );
  await once(child, 'spawn');
  const { observeLiveKernel } = await import('./process-identity.js');
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  try {
    const before = observeLiveKernel(child.pid!);
    expect(before.parentPid).toBe(process.pid);
    expect(Object.keys(before).sort()).toEqual([
      'birth',
      'bootId',
      'namespaces',
      'parentPid',
      'pid',
      'uid',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(observeLiveKernel(child.pid!)).toEqual(before);
    expect(observeLiveProcess(child.pid!).executable).toBe(realpathSync(process.execPath));
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
  expect(() => observeLiveKernel(child.pid!)).toThrow('LIVE_PROCESS_IDENTITY_UNAVAILABLE');
  for (const pid of [0, -1, NaN, 1.5])
    expect(() => observeLiveKernel(pid)).toThrow('LIVE_PROCESS_IDENTITY_UNAVAILABLE');
});

it.each(['uid', 'birth', 'parent', 'namespace', 'boot'] as const)(
  'rejects a changing %s during the kernel snapshot itself without a third read',
  async (field) => {
    const { observeLiveKernel } = await import('./process-identity.js');
    const actualRead = fileSystem.readFileSync,
      actualLink = fileSystem.readlinkSync;
    const target =
      field === 'uid'
        ? `/proc/${process.pid}/status`
        : field === 'boot'
          ? '/proc/sys/kernel/random/boot_id'
          : `/proc/${process.pid}/stat`;
    let reads = 0;
    vi.spyOn(fileSystem, 'readFileSync').mockImplementation(((...args: unknown[]) => {
      const result = Reflect.apply(actualRead, fileSystem, args);
      if (field !== 'namespace' && args[0] === target && ++reads === 2) {
        if (field === 'boot') return 'changed';
        if (field === 'uid')
          return result.replace(/^Uid:\s+\d+/m, `Uid:\t${process.getuid!() + 1}`);
        const end = result.lastIndexOf(')') + 2,
          fields = result.slice(end).split(' ');
        fields[field === 'birth' ? 19 : 1] = '1';
        return result.slice(0, end) + fields.join(' ');
      }
      return result;
    }) as typeof fileSystem.readFileSync);
    vi.spyOn(fileSystem, 'readlinkSync').mockImplementation(((...args: unknown[]) => {
      if (field === 'namespace' && args[0] === `/proc/${process.pid}/ns/mnt` && ++reads === 2)
        return 'changed';
      return Reflect.apply(actualLink, fileSystem, args);
    }) as typeof fileSystem.readlinkSync);
    try {
      expect(() => observeLiveKernel(process.pid)).toThrow('LIVE_PROCESS_IDENTITY_UNAVAILABLE');
      expect(reads).toBe(2);
    } finally {
      vi.restoreAllMocks();
    }
  },
);
