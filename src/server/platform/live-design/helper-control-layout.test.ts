/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareHelperControlLayout } from './helper-control-layout.js';
import type { ManagedProjectSandboxState } from './caddy-admin-boundary.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const app = mkdtempSync('/tmp/live-control-layout-');
  roots.push(app);
  mkdirSync(join(app, '.impeccable/live'), { recursive: true });
  const state: ManagedProjectSandboxState = {
    sandboxCwd: new URL(`file://${app}`).href,
    useLegacyLandlock: false,
    permissionProfile: {
      type: 'managed',
      network: 'restricted',
      file_system: {
        type: 'restricted',
        entries: [
          { path: { type: 'special', value: { kind: 'root' } }, access: 'read' },
          { path: { type: 'path', path: app }, access: 'write' },
        ],
      },
    },
  };
  return { app, state };
}
it('initializes real output directories and existing control-parent masks without inventing authority records', () => {
  const { app, state } = fixture();
  const result = prepareHelperControlLayout(app, state);
  expect(result.permissionProfile.file_system.entries).toContainEqual({
    path: { type: 'path', path: join(app, '.impeccable/live') },
    access: 'deny',
  });
  for (const name of ['previews', 'artifacts', 'annotations']) {
    const path = join(app, '.impeccable/live', name);
    expect(existsSync(path)).toBe(true);
    expect(result.permissionProfile.file_system.entries).toContainEqual({
      path: { type: 'path', path },
      access: 'write',
    });
  }
  for (const name of [
    'server.json',
    'inject-journal.json',
    'accept-receipts',
    'sessions',
    'pending-manual-edits.json',
  ])
    expect(existsSync(join(app, '.impeccable/live', name))).toBe(false);
  expect(existsSync(join(app, '.impeccable-live.json'))).toBe(false);
  expect(state.permissionProfile.file_system.entries).toHaveLength(2);
});
it('never grants an output carveout forbidden by the existing policy', () => {
  const { app, state } = fixture();
  state.permissionProfile.file_system.entries = [
    ...state.permissionProfile.file_system.entries,
    { path: { type: 'path', path: join(app, '.impeccable/live/artifacts') }, access: 'deny' },
  ];
  expect(() => prepareHelperControlLayout(app, state)).toThrow('LIVE_OWNING_POLICY_UNVERIFIED');
  expect(existsSync(join(app, '.impeccable/live/artifacts'))).toBe(false);
});
it.each(['symlink', 'hardlink', 'legacy-server'])(
  'refuses %s aliases or external state before constructing layout',
  (kind) => {
    const { app, state } = fixture(),
      record = join(app, '.impeccable/live/record');
    writeFileSync(record, 'real-existing-record');
    if (kind === 'symlink') symlinkSync(record, join(app, '.impeccable/live/alias'));
    if (kind === 'hardlink') linkSync(record, join(app, 'external-alias'));
    if (kind === 'legacy-server') writeFileSync(join(app, '.impeccable-live.json'), '{}');
    expect(() => prepareHelperControlLayout(app, state)).toThrow();
  },
);
