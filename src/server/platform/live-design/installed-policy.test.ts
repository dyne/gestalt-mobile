/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InstalledLiveAdmissionError,
  InstalledLivePolicy,
  measureInstalledLiveTree,
  LIVE_MANAGER_SHA256,
} from './installed-policy.js';
import {
  ORIGINAL_INSTALLED_SOURCE_EXTENSION,
  type InstalledSourceObservation,
} from './installed-launch-contract.js';

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function receiptFixture() {
  const f = fixture(),
    hash = 'a'.repeat(64);
  const policy = new InstalledLivePolicy({
    manager: { path: '/accepted/gestalt', sha256: LIVE_MANAGER_SHA256 },
    node: { path: '/usr/bin/node', sha256: hash },
    packages: [
      { name: 'gestalt', root: '/accepted/gestalt-package', sha256: hash },
      { name: 'context-mode', root: '/accepted/context-package', sha256: hash },
    ],
    runtime: { root: '/accepted/runtime', sha256: hash },
  });
  const captureId = randomUUID(),
    launchId = randomUUID(),
    keyFile = join(f.root, 'key');
  writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o600 });
  const manifestPath = join(f.root, 'manifest.json');
  const manifest = {
    keyFile,
    generation: { sessionId: 'owning', generation: 2 },
    commands: {
      'context-mode-call': {
        executable: '/usr/bin/node',
        sha256: hash,
        args: ['fixed-worker'],
        timeoutMs: 120000,
      },
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  const observations: InstalledSourceObservation[] = [
    {
      kind: 'installed-launch-source',
      descriptor: {
        kind: 'context-mode-bridge-v1',
        path: '/owner/bin/context-mode-mcp.mjs',
        sha256: hash,
        gestaltHome: '/gestalt',
        interpreter: { path: '/usr/bin/node', sha256: hash },
        package: { root: '/cache/context-mode/2.16.1', version: '2.16.1', treeDigest: hash },
        runtime: { root: '/gestalt/runtime/context-mode', treeDigest: hash },
      },
      observation: { launcher: { sha256: hash, identity: { ino: 1 } } },
    },
  ];
  const save = (path: string, body: unknown) =>
    writeFileSync(
      path,
      JSON.stringify({
        body,
        mac: createHmac('sha256', readFileSync(keyFile)).update(stable(body)).digest('hex'),
      }),
      { mode: 0o600 },
    );
  const birthPath = join(f.root, `birth-${captureId}.json`);
  const birth = {
    schemaVersion: 2,
    kind: 'before-runtime-birth',
    captureId,
    originalLaunchSources: observations,
  };
  const processPath = join(f.root, `process-${launchId}.json`);
  const process = {
    kind: 'process-launch',
    launchId,
    commandId: 'context-mode-call',
    postSpawnValidated: true,
    status: 'exited',
    termination: 'leader-exit',
    policy: {
      policyDigest: hash,
      manifestDigest: digest(readFileSync(manifestPath)),
      authority: { generation: manifest.generation },
      commands: manifest.commands,
    },
  };
  return {
    ...f,
    policy,
    observations,
    save,
    captureId,
    manifestPath,
    birthPath,
    birth,
    processPath,
    process,
  };
}

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'live-installation-'));
  roots.push(root);
  const file = join(root, 'entry.mjs');
  writeFileSync(file, 'export const trusted = true;\n', { mode: 0o600 });
  return { root, file };
}
describe('installed code before host execution', () => {
  it('requires capture/seal/current verify extension observations, never lineage stdout alone', () => {
    const f = receiptFixture();
    const reply = {
      extensions: [ORIGINAL_INSTALLED_SOURCE_EXTENSION],
      originalLaunchSources: f.observations,
    };
    expect(() => f.policy.assertOriginalSourceReply(reply, f.observations)).not.toThrow();
    for (const changed of [
      {},
      { originalLaunchSources: f.observations },
      { ...reply, originalLaunchSources: [] },
    ])
      expect(() => f.policy.assertOriginalSourceReply(changed, f.observations)).toThrow(
        'LIVE_INSTALLED_SOURCE_UNVERIFIED',
      );
  });
  it('authenticates renewal birth against immutable initial and fresh independent observation', async () => {
    const f = receiptFixture();
    const observe = vi.spyOn(f.policy, 'observeOriginalSources').mockResolvedValue(f.observations);
    f.save(f.birthPath, f.birth);
    await expect(
      f.policy.assertOriginalSourceBirth(f.manifestPath, f.captureId, f.observations),
    ).resolves.toBeUndefined();
    observe.mockResolvedValue([]);
    await expect(
      f.policy.assertOriginalSourceBirth(f.manifestPath, f.captureId, f.observations),
    ).rejects.toThrow('LIVE_INSTALLED_SOURCE_UNVERIFIED');
    observe.mockResolvedValue(f.observations);
    for (const body of [
      { ...f.birth, originalLaunchSources: [] },
      { ...f.birth, captureId: randomUUID() },
    ]) {
      f.save(f.birthPath, body);
      await expect(
        f.policy.assertOriginalSourceBirth(f.manifestPath, f.captureId, f.observations),
      ).rejects.toThrow('LIVE_INSTALLED_SOURCE_UNVERIFIED');
    }
    f.save(f.birthPath, f.birth);
    const record = JSON.parse(readFileSync(f.birthPath, 'utf8'));
    record.body.originalLaunchSources = [];
    writeFileSync(f.birthPath, JSON.stringify(record));
    await expect(
      f.policy.assertOriginalSourceBirth(f.manifestPath, f.captureId, f.observations),
    ).rejects.toThrow('LIVE_INSTALLED_SOURCE_UNVERIFIED');
  });
  it('requires a new signed post-spawn-validated completed launch of the current command and generation', () => {
    const f = receiptFixture(),
      hash = 'a'.repeat(64);
    const before = f.policy.contextLaunchIds(f.manifestPath);
    f.save(f.processPath, f.process);
    expect(() => f.policy.assertCompletedContextLaunch(f.manifestPath, before, hash)).not.toThrow();
    expect(() =>
      f.policy.assertCompletedContextLaunch(
        f.manifestPath,
        f.policy.contextLaunchIds(f.manifestPath),
        hash,
      ),
    ).toThrow('LIVE_CONTEXT_RECEIPT_UNVERIFIED');
    for (const body of [
      { ...f.process, postSpawnValidated: false },
      { ...f.process, status: 'running' },
      { ...f.process, termination: 'timeout' },
      { ...f.process, commandId: 'other' },
      {
        ...f.process,
        policy: {
          ...f.process.policy,
          authority: { generation: { sessionId: 'owning', generation: 1 } },
        },
      },
      {
        ...f.process,
        policy: {
          ...f.process.policy,
          authority: undefined,
          generation: { sessionId: 'owning', generation: 2 },
        },
      },
      { ...f.process, policy: { ...f.process.policy, manifestDigest: 'b'.repeat(64) } },
      { ...f.process, policy: { ...f.process.policy, commands: {} } },
    ]) {
      f.save(f.processPath, body);
      expect(() => f.policy.assertCompletedContextLaunch(f.manifestPath, before, hash)).toThrow(
        'LIVE_CONTEXT_RECEIPT_UNVERIFIED',
      );
    }
    f.save(f.processPath, f.process);
    const record = JSON.parse(readFileSync(f.processPath, 'utf8'));
    record.body.postSpawnValidated = false;
    writeFileSync(f.processPath, JSON.stringify(record));
    expect(() => f.policy.assertCompletedContextLaunch(f.manifestPath, before, hash)).toThrow(
      'LIVE_CONTEXT_RECEIPT_UNVERIFIED',
    );
  });
  it('retains only fixed protocol refusal reasons without command output or private data', () => {
    const privateValue = '/private/secret-credential';
    const failure = (reason: string) => ({
      stdout: JSON.stringify({
        schemaVersion: 2,
        available: false,
        liveReady: false,
        reason,
        diagnostic: privateValue,
      }),
      stderr: privateValue,
      message: privateValue,
    });
    const known = InstalledLiveAdmissionError.command('manager-command', failure('source-changed'));
    expect(known.message).toBe('LIVE_ADMISSION_UNAVAILABLE');
    expect(known.diagnostic).toEqual({ phase: 'manager-command', reason: 'source-changed' });
    for (const reason of [
      'invalid-renewal-lineage',
      'renewal-intent-changed',
      'renewal-not-revoked',
      'renewal-observation-required',
      'renewal-owner-alive',
      'renewal-policy-broadened',
      'renewal-policy-incompatible',
      'renewal-required',
      'renewal-source-changed',
      'renewal-storage-reused',
      'renewal-undrained',
    ]) {
      const error = InstalledLiveAdmissionError.command('manager-command', failure(reason));
      expect(error.diagnostic).toEqual({ phase: 'manager-command', reason });
      expect(JSON.stringify(error)).not.toContain(privateValue);
    }
    const unknown = InstalledLiveAdmissionError.command('agents-command', failure(privateValue));
    expect(unknown.diagnostic).toEqual({ phase: 'agents-command', reason: 'contract-refused' });
    const malformed = InstalledLiveAdmissionError.command('agents-command', {
      stdout: privateValue,
    });
    expect(malformed.diagnostic.reason).toBe('command-failed');
    for (const error of [known, unknown, malformed]) {
      expect(JSON.stringify(error)).not.toContain(privateValue);
      expect(error.cause).toBeUndefined();
    }
  });
  it('binds every installed file name, mode and byte', () => {
    const { root, file } = fixture();
    const original = measureInstalledLiveTree(root);
    mkdirSync(join(root, 'nested'), { mode: 0o700 });
    writeFileSync(join(root, 'nested/module.mjs'), 'export const value = 1;\n', { mode: 0o600 });
    expect(measureInstalledLiveTree(root)).not.toBe(original);
    rmSync(join(root, 'nested'), { recursive: true });
    expect(measureInstalledLiveTree(root)).toBe(original);
    chmodSync(file, 0o700);
    expect(measureInstalledLiveTree(root)).not.toBe(original);
    chmodSync(file, 0o600);
    writeFileSync(file, 'export const trusted = false;\n');
    expect(measureInstalledLiveTree(root)).not.toBe(original);
  });
  it('refuses symlinks and group-writable installed code', () => {
    const { root, file } = fixture();
    symlinkSync(file, join(root, 'alias'));
    expect(() => measureInstalledLiveTree(root)).toThrow('LIVE_INSTALLATION_UNVERIFIED');
    rmSync(join(root, 'alias'));
    chmodSync(file, 0o660);
    expect(() => measureInstalledLiveTree(root)).toThrow('LIVE_INSTALLATION_UNVERIFIED');
  });
  it('refuses a substituted manager before it can run any host command', () => {
    const hash = 'a'.repeat(64);
    expect(
      () =>
        new InstalledLivePolicy({
          manager: { path: '/unapproved/manager', sha256: hash },
          node: { path: '/unapproved/node', sha256: hash },
          packages: [
            { name: 'gestalt', root: '/unapproved/gestalt', sha256: hash },
            { name: 'context-mode', root: '/unapproved/context', sha256: hash },
          ],
          runtime: { root: '/unapproved/runtime', sha256: hash },
        }),
    ).toThrow('LIVE_INSTALLATION_UNVERIFIED');
  });
});

function cwdLineageFixture() {
  const f = receiptFixture();
  const firstBirth = { ...f.birth, basisDigest: 'a'.repeat(64) };
  f.save(f.birthPath, firstBirth);
  const initial = { path: f.manifestPath, id: f.captureId, birth: firstBirth };
  const next = (parent: typeof initial, generation: number) => {
    const directory = join(f.root, `generation-${generation}`);
    mkdirSync(directory, { mode: 0o700 });
    const id = randomUUID(),
      path = join(directory, 'manifest.json');
    const manifest = {
      ...JSON.parse(readFileSync(parent.path, 'utf8')),
      generation: { sessionId: 'owning', generation },
    };
    writeFileSync(path, JSON.stringify(manifest), { mode: 0o600 });
    const sealed = {
      schemaVersion: 2,
      kind: 'owning-runtime-provenance',
      captureId: parent.id,
      basisDigest: parent.birth.basisDigest,
      beforeDigest: digest(stable(parent.birth)),
      runtime: { cwd: f.root },
    };
    const sealPath = join(
      parent.path.slice(0, parent.path.lastIndexOf('/')),
      `runtime-${parent.id}.json`,
    );
    f.save(sealPath, sealed);
    const birth = {
      ...firstBirth,
      captureId: id,
      renewal: {
        mode: 'replacement',
        previousManifest: parent.path,
        previousCaptureId: parent.id,
        manifestDigest: digest(readFileSync(parent.path)),
        sealDigest: digest(stable(sealed)),
        beforeDigest: sealed.beforeDigest,
      },
    };
    const birthPath = join(directory, `birth-${id}.json`);
    f.save(birthPath, birth);
    return { path, id, birth, birthPath, sealPath, sealed };
  };
  const replacement = next(initial, 3),
    later = next(replacement, 4);
  return { ...f, initial, replacement, later };
}
describe('authenticated original owning cwd', () => {
  it('derives initial cwd and retains original sealed cwd across two replacement manifests', () => {
    const f = cwdLineageFixture();
    for (const capture of [f.initial, f.replacement, f.later])
      expect(f.policy.owningRuntimeCwd(capture.path, capture.id)).toBe(f.root);
  });
  it.each([
    'unsigned',
    'seal-digest',
    'capture',
    'generation',
    'final-cwd',
    'manifest-digest',
  ] as const)('refuses %s lineage mutation', (change) => {
    const f = cwdLineageFixture();
    if (change === 'unsigned')
      writeFileSync(
        f.later.birthPath,
        JSON.stringify({ body: f.later.birth, mac: '0'.repeat(64) }),
      );
    if (change === 'seal-digest')
      f.save(f.later.birthPath, {
        ...f.later.birth,
        renewal: { ...f.later.birth.renewal, sealDigest: '0'.repeat(64) },
      });
    if (change === 'capture')
      f.save(f.later.birthPath, { ...f.later.birth, captureId: randomUUID() });
    if (change === 'manifest-digest')
      f.save(f.later.birthPath, {
        ...f.later.birth,
        renewal: { ...f.later.birth.renewal, manifestDigest: '0'.repeat(64) },
      });
    if (change === 'generation') {
      const m = JSON.parse(readFileSync(f.later.path, 'utf8'));
      m.generation.generation = 1;
      writeFileSync(f.later.path, JSON.stringify(m));
    }
    if (change === 'final-cwd') {
      const sealed = { ...f.later.sealed, runtime: { cwd: f.root + '/generation-4' } };
      f.save(f.later.sealPath, sealed);
      f.save(f.later.birthPath, {
        ...f.later.birth,
        renewal: { ...f.later.birth.renewal, sealDigest: digest(stable(sealed)) },
      });
    }
    expect(() => f.policy.owningRuntimeCwd(f.later.path, f.later.id)).toThrow(
      'LIVE_NATIVE_HANDOFF_CWD_UNVERIFIED',
    );
  });
});
