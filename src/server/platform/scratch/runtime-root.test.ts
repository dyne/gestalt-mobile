/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FilesystemSessionScratch,
  mobileScratchOwnerId,
  scratchMarkerName,
} from './filesystem-session-scratch.js';
import { FilesystemScratchCleanup } from './filesystem-scratch-cleanup.js';
import {
  allocateRuntime,
  requireSocketPath,
  runtimeContainer,
  runtimeMarkerName,
} from './runtime-root.js';

const cryptoControl = vi.hoisted(() => ({
  bytes: undefined as undefined | ((size: number) => Buffer),
}));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: (size: number) => cryptoControl.bytes?.(size) ?? actual.randomBytes(size),
  };
});

const execute = promisify(execFile);
const roots: string[] = [];
const restore: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  cryptoControl.bytes = undefined;
  for (const action of restore.splice(0).reverse()) await action();
  for (const workspacePath of roots.splice(0).reverse()) {
    await new FilesystemScratchCleanup().cleanWorkspace(workspacePath, () => []);
    await rm(workspacePath, { recursive: true, force: true });
  }
});
async function fixture(deep = false) {
  const base = join(process.cwd(), 'tmp', 'runtime-tests');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(base, 'workspace-'));
  const workspacePath = deep
    ? join(root, ...Array.from({ length: 12 }, () => '深い-é-workspace'))
    : root;
  await mkdir(workspacePath, { recursive: true });
  roots.push(workspacePath);
  return { workspacePath, id: 'socket-fixture' };
}
const rootOf = (context: Awaited<ReturnType<FilesystemSessionScratch['allocate']>>) =>
  context.environment.TMPDIR!;

describe.skipIf(process.platform === 'win32')('bounded physical runtime scratch', () => {
  it.each([false, true])(
    'binds, listens, connects and exchanges data for the Bitcoin pattern under a deep=%s workspace',
    async (deep) => {
      const session = await fixture(deep);
      const context = await new FilesystemSessionScratch().allocate(session);
      const temporary = rootOf(context);
      expect(Buffer.byteLength(temporary)).toBeLessThanOrEqual(48);
      expect(await realpath(temporary)).toBe(temporary);
      expect(JSON.parse(context.environment.GESTALT_SESSION_TMP_CONTEXT!).schemaVersion).toBe(2);
      const script = `import os,socket,tempfile,json
root=tempfile.gettempdir()
assert root==os.environ['TMPDIR']==os.environ['TMP']==os.environ['TEMP']
assert os.path.realpath(root)==root
legacy=json.loads(os.environ['GESTALT_SESSION_TMP_CONTEXT'])['directory']+'/bitcoin_sock0_qR2DkZ'
try:
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as old: old.bind(legacy)
except OSError as error: assert 'too long' in str(error).lower()
else: raise AssertionError('original long owner must exceed sun_path')
path=root+'/bitcoin_sock0_qR2DkZ'
with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as server:
 server.settimeout(5);server.bind(path);server.listen(1)
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
  client.settimeout(5);client.connect(path);client.sendall(b'bitcoin');peer,_=server.accept()
  with peer:
   assert peer.recv(7)==b'bitcoin';peer.sendall(b'pong');assert client.recv(4)==b'pong'
os.unlink(path)
print('socket-ok')`;
      const result = await execute('python3', ['-c', script], {
        env: { ...process.env, ...context.environment },
        timeout: 7000,
      });
      expect(result.stdout.trim()).toBe('socket-ok');
    },
  );

  it('routes native Node, shell and Python descendants consistently without canonical-path expansion', async () => {
    const context = await new FilesystemSessionScratch().allocate(await fixture(true));
    const endpoint = requireSocketPath(join(rootOf(context), 'bitcoin_sock0_Node01'));
    const server = createServer((peer) =>
      peer.on('data', (data) => {
        expect(data.toString()).toBe('ping');
        peer.end('pong');
      }),
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, resolve);
    });
    try {
      const script = `import os,socket,sys
assert os.path.realpath(os.environ['TMPDIR'])==os.environ['TMP']==os.environ['TEMP']
with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as peer:
 peer.connect(sys.argv[1]);peer.sendall(b'ping');assert peer.recv(4)==b'pong'
print('descendants-ok')`;
      const result = await execute(
        'sh',
        ['-c', 'exec python3 -c "$1" "$2"', 'sh', script, endpoint],
        { env: { ...process.env, ...context.environment } },
      );
      expect(result.stdout.trim()).toBe('descendants-ok');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('exchanges data at the native UTF-8 pathname boundary and reserves the terminating NUL', async () => {
    expect(requireSocketPath('é'.repeat(53) + 'a', 108)).toHaveLength(54);
    expect(() => requireSocketPath('é'.repeat(54), 108)).toThrow('UNIX_SOCKET_PATH_TOO_LONG');
    expect(() => requireSocketPath('x'.repeat(104), 104)).toThrow('UNIX_SOCKET_PATH_TOO_LONG');
    expect(() => requireSocketPath('a\0b')).toThrow('UNIX_SOCKET_PATH_TOO_LONG');
    const capacity = { linux: 108, darwin: 104 }[process.platform as 'linux' | 'darwin'];
    expect(capacity).toBeDefined();
    const context = await new FilesystemSessionScratch().allocate(await fixture());
    const script = `import os,socket
prefix=os.environ['TMPDIR']+'/'
remaining=${capacity - 1}-len(prefix.encode())
path=prefix+'é'*(remaining//2)+'a'*(remaining%2)
assert len(path.encode())==${capacity - 1}
with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as server:
 server.settimeout(5);server.bind(path);server.listen(1)
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
  client.settimeout(5);client.connect(path);client.sendall(b'edge');peer,_=server.accept()
  with peer:
   assert peer.recv(4)==b'edge';peer.sendall(b'ok');assert client.recv(2)==b'ok'
os.unlink(path)
try:
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as peer: peer.bind(path+'b')
except OSError: print('boundary-ok')
else: raise AssertionError('${capacity} bytes must fail')`;
    expect(
      (
        await execute('python3', ['-c', script], {
          env: { ...process.env, ...context.environment },
        })
      ).stdout.trim(),
    ).toBe('boundary-ok');
  });

  it('keeps a stable root and payload across restart/reopen and isolates simultaneous sessions and services', async () => {
    const session = await fixture();
    const scratch = new FilesystemSessionScratch();
    const first = await scratch.allocate(session);
    await writeFile(join(rootOf(first), 'retained'), 'keep');
    expect(await new FilesystemSessionScratch().allocate(session)).toEqual(first);
    const [other, service] = await Promise.all([
      scratch.allocate({ ...session, id: 'other-session' }),
      scratch.allocateService(session.workspacePath, 'service-fixture'),
    ]);
    restore.push(() => service.release());
    expect(new Set([rootOf(first), rootOf(other), rootOf(service)]).size).toBe(3);
    expect(await readFile(join(rootOf(first), 'retained'), 'utf8')).toBe('keep');
  });

  it('retains active borrowers and roster owners, then cleans both roots after authoritative release', async () => {
    const session = await fixture();
    const scratch = new FilesystemSessionScratch();
    const lease = await scratch.borrow(session);
    restore.push(() => lease.release());
    const temporary = rootOf(lease);
    await writeFile(join(temporary, 'payload'), 'owned');
    const cleaner = new FilesystemScratchCleanup();
    expect((await cleaner.cleanWorkspace(session.workspacePath, () => [])).reasons.lease).toBe(1);
    await lease.release();
    expect(
      (await cleaner.cleanWorkspace(session.workspacePath, () => [session])).reasons.protected,
    ).toBe(1);
    expect(await readFile(join(temporary, 'payload'), 'utf8')).toBe('owned');
    expect((await cleaner.cleanWorkspace(session.workspacePath, () => [])).removed).toBe(1);
    await expect(readFile(join(temporary, 'payload'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(lease.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects runtime aliases, replacement identities, foreign bindings and partial metadata without adoption', async () => {
    const session = await fixture();
    const scratch = new FilesystemSessionScratch();
    const context = await scratch.allocate(session);
    const temporary = rootOf(context),
      moved = temporary + '-held';
    await rename(temporary, moved);
    await symlink(moved, temporary);
    await expect(scratch.allocate(session)).rejects.toThrow();
    await rm(temporary);
    await rename(moved, temporary);
    const markerPath = join(temporary, runtimeMarkerName),
      marker = await readFile(markerPath, 'utf8');
    restore.push(() => writeFile(markerPath, marker));
    await writeFile(markerPath, marker.replace('socket-fixture', 'foreign-session'));
    // ownerId is a hash, so alter a bounded ownership field explicitly.
    await writeFile(
      markerPath,
      JSON.stringify({ ...JSON.parse(marker), workspacePath: '/foreign' }),
    );
    await expect(scratch.allocate(session)).rejects.toThrow();
    await rm(markerPath);
    await expect(scratch.allocate(session)).rejects.toThrow();
    expect(
      (await new FilesystemScratchCleanup().cleanWorkspace(session.workspacePath, () => []))
        .removed,
    ).toBe(0);
  });

  it('reuses retained v1 owners without moving their payload or upgrading active metadata', async () => {
    const session = await fixture();
    const ownerId = mobileScratchOwnerId(session.id);
    const directory = join(session.workspacePath, 'tmp', 'sessions', ownerId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const marker = {
      schemaVersion: 1,
      ownerKind: 'mobile-session',
      ownerId,
      workspacePath: session.workspacePath,
      sessionId: session.id,
      createdAt: new Date().toISOString(),
      authority: { kind: 'mobile-roster', sessionId: session.id },
      providerThreads: [],
    };
    await writeFile(join(directory, scratchMarkerName), JSON.stringify(marker), { mode: 0o600 });
    const context = await new FilesystemSessionScratch().allocate(session);
    expect(rootOf(context)).toBe(directory);
    expect(JSON.parse(context.environment.GESTALT_SESSION_TMP_CONTEXT!).schemaVersion).toBe(1);
    expect(JSON.parse(await readFile(join(directory, scratchMarkerName), 'utf8'))).toEqual(marker);
  });

  it('does not adopt collisions or partially published runtime allocations', async () => {
    const session = await fixture();
    const container = await runtimeContainer();
    await mkdir(container, { mode: 0o700, recursive: true });
    const directory = join(container, '7f'.repeat(10));
    await mkdir(directory, { mode: 0o700 });
    restore.push(() => rm(directory, { recursive: true, force: true }));
    const witness = join(directory, runtimeMarkerName);
    await writeFile(witness, 'foreign-or-partial', { mode: 0o600 });
    cryptoControl.bytes = (size) => Buffer.alloc(size, 0x7f);
    await expect(
      allocateRuntime({ workspacePath: session.workspacePath, ownerId: 'test-owner' }),
    ).rejects.toThrow('SESSION_SCRATCH_RUNTIME_COLLISION');
    expect(await readFile(witness, 'utf8')).toBe('foreign-or-partial');
  });

  it('retains a missing-workspace runtime rather than reporting a false successful Forget', async () => {
    const session = await fixture(),
      context = await new FilesystemSessionScratch().allocate(session);
    const held = session.workspacePath + '-held';
    await rename(session.workspacePath, held);
    try {
      await expect(
        new FilesystemScratchCleanup().cleanSession(
          session,
          () => true,
          () => [],
        ),
      ).rejects.toThrow('SESSION_CLEANUP_FAILED');
      expect(await realpath(rootOf(context))).toBe(rootOf(context));
    } finally {
      await rename(held, session.workspacePath);
    }
  });

  it('accepts absent runtime storage only for release-authorized cleanup, never for reopen', async () => {
    const session = await fixture(),
      scratch = new FilesystemSessionScratch(),
      context = await scratch.allocate(session);
    await rm(rootOf(context), { recursive: true });
    await expect(scratch.allocate(session)).rejects.toThrow();
    expect(
      (await new FilesystemScratchCleanup().cleanWorkspace(session.workspacePath, () => []))
        .removed,
    ).toBe(1);
  });

  it('retries runtime metadata retirement on the same empty inode and retains an unmarked nonempty root', async () => {
    const session = await fixture(),
      scratch = new FilesystemSessionScratch(),
      context = await scratch.allocate(session);
    const path = join(context.directory, scratchMarkerName),
      marker = JSON.parse(await readFile(path, 'utf8'));
    const runtimePath = join(rootOf(context), runtimeMarkerName),
      runtimeMarker = await readFile(runtimePath, 'utf8');
    marker.runtime.retiring = true;
    await writeFile(path, JSON.stringify(marker));
    await rm(runtimePath);
    await expect(scratch.allocate(session)).rejects.toThrow();
    const foreign = join(rootOf(context), 'unknown');
    await writeFile(foreign, 'keep');
    const cleaner = new FilesystemScratchCleanup();
    expect((await cleaner.cleanWorkspace(session.workspacePath, () => [])).removed).toBe(0);
    expect(await readFile(foreign, 'utf8')).toBe('keep');
    await rm(foreign);
    // Cleanup may have moved durable metadata into its registered removal frame.
    const container = join(session.workspacePath, 'tmp', 'sessions');
    expect((await readdir(container)).some((name) => name.startsWith('.cleanup-'))).toBe(true);
    expect((await cleaner.cleanWorkspace(session.workspacePath, () => [])).removed).toBe(1);
    await expect(readdir(rootOf(context))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(runtimeMarker).schemaVersion).toBe(2);
  });

  it('retains the immutable v1 consumer rejection of v2 before any launch or metadata rewrite', async () => {
    const context = await new FilesystemSessionScratch().allocate(await fixture());
    const marker = await readFile(join(context.directory, scratchMarkerName), 'utf8');
    const legacy = await readFile(
      join(process.cwd(), 'test/fixtures/scratch/launcher-containment-runtime.cjs.txt'),
      'utf8',
    );
    const consumer = new Function('require', legacy + '\nreturn scratchEnvironment;')(
      createRequire(import.meta.url),
    ) as (env: Record<string, string>) => unknown;
    expect(() => consumer({ ...context.environment })).toThrow('SESSION_SCRATCH_INVALID_CONTEXT');
    expect(await readFile(join(context.directory, scratchMarkerName), 'utf8')).toBe(marker);
  });
});
