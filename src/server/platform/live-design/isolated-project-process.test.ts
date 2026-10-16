/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IsolatedProjectProcess,
  type IsolatedProjectSpecification,
} from './isolated-project-process.js';
import { LIVE_CODEX_SHA256, LIVE_CODEX_BWRAP_SHA256 } from './native-contract.js';

let root: string;
let app: string;
let controller: string;
beforeEach(() => {
  root = mkdtempSync('/tmp/live-isolation-validation-');
  app = join(root, 'app');
  controller = join(root, 'controller');
  mkdirSync(app, { mode: 0o700 });
  mkdirSync(controller, { mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function specification(): IsolatedProjectSpecification {
  const pin = { path: '/unavailable-readonly-runtime', sha256: '0'.repeat(64) };
  return {
    role: 'devserver',
    sessionId: 'owner',
    generation: 1,
    appRoot: app,
    privateDirectory: controller,
    native: { ...pin, sha256: LIVE_CODEX_SHA256 },
    bwrap: { ...pin, sha256: LIVE_CODEX_BWRAP_SHA256 },
    node: pin,
    worker: pin,
    executable: pin,
    argv: [],
    launchInputs: [],
    port: 12182,
    environment: { PATH: '/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp' },
    protectedPaths: [],
    filesystem: {
      type: 'restricted',
      entries: [{ path: { type: 'path', path: app }, access: 'write' }],
    },
  };
}
describe('project isolation admission refuses incomplete authority before process birth', () => {
  it('accepts a covering private denial without recreating redundant child masks', () => {
    const spec = specification();
    const privateChild = join(controller, 'authentication');
    const entries: IsolatedProjectSpecification['filesystem']['entries'] = [
      ...spec.filesystem.entries,
      { path: { type: 'path', path: controller }, access: 'deny' },
      { path: { type: 'path', path: '/proc' }, access: 'deny' },
    ];
    const stage = (additional: typeof entries) => {
      try {
        new IsolatedProjectProcess({
          ...spec,
          protectedPaths: [privateChild],
          filesystem: { type: 'restricted', entries: [...entries, ...additional] },
        });
        throw new Error('Expected unavailable test pin to refuse process birth');
      } catch (error) {
        return (error as Error & { stage?: string }).stage;
      }
    };
    // Reaching pin validation proves only the preceding policy validation;
    // this deliberately never creates a key or launches an executable.
    expect(stage([])).toBe('pin-native-read');
    expect(stage([{ path: { type: 'path', path: privateChild }, access: 'read' }])).toBe(
      'private-denial-overridden',
    );
    expect(
      stage([{ path: { type: 'path', path: join(privateChild, 'keys') }, access: 'write' }]),
    ).toBe('filesystem-write-scope');
    expect(existsSync(join(controller, 'project-process-signing-key'))).toBe(false);
  });
  it('requires native private-state and proc denials before preparing any key or process', () => {
    expect(() => new IsolatedProjectProcess(specification())).toThrow(
      'LIVE_PROJECT_PROCESS_UNAVAILABLE',
    );
    expect(existsSync(join(controller, 'project-process-signing-key'))).toBe(false);
  });
  it('does not mistake a denied root for private denial beneath a reopened special tmp grant', () => {
    const spec = specification();
    expect(
      () =>
        new IsolatedProjectProcess({
          ...spec,
          filesystem: {
            type: 'restricted',
            entries: [
              ...spec.filesystem.entries,
              { path: { type: 'path', path: '/' }, access: 'deny' },
              { path: { type: 'special', value: { kind: 'slash_tmp' } }, access: 'write' },
              { path: { type: 'path', path: '/proc' }, access: 'deny' },
            ],
          },
        }),
    ).toThrow(expect.objectContaining({ stage: 'private-denial-missing' }));
    expect(existsSync(join(controller, 'project-process-signing-key'))).toBe(false);
  });
  it('refuses Node injection and provider secrets in the project environment', () => {
    for (const name of ['NODE_OPTIONS', 'OPENAI_API_KEY', 'CODEX_HOME', 'LD_PRELOAD']) {
      const spec = specification();
      expect(
        () =>
          new IsolatedProjectProcess({
            ...spec,
            environment: { ...spec.environment, [name]: 'unapproved' },
          }),
      ).toThrow('LIVE_PROJECT_PROCESS_UNAVAILABLE');
    }
  });
  it('refuses permissions granting a descendant of protected controller state', () => {
    const spec = specification();
    expect(
      () =>
        new IsolatedProjectProcess({
          ...spec,
          filesystem: {
            type: 'restricted',
            entries: [
              ...spec.filesystem.entries,
              { path: { type: 'path', path: controller }, access: 'deny' },
              { path: { type: 'path', path: join(controller, 'keys') }, access: 'read' },
              { path: { type: 'path', path: '/proc' }, access: 'deny' },
            ],
          },
        }),
    ).toThrow('LIVE_PROJECT_PROCESS_UNAVAILABLE');
  });
  it('refuses unpinned native or helper executables without creating owner state', () => {
    const spec = specification();
    expect(
      () =>
        new IsolatedProjectProcess({ ...spec, native: { ...spec.native, sha256: '0'.repeat(64) } }),
    ).toThrow('LIVE_PROJECT_PROCESS_UNAVAILABLE');
    expect(() => new IsolatedProjectProcess({ ...spec, role: 'helper' })).toThrow(
      'LIVE_PROJECT_PROCESS_UNAVAILABLE',
    );
    expect(existsSync(join(controller, 'project-process-signing-key'))).toBe(false);
  });
});
