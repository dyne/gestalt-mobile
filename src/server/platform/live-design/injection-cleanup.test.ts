/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureLiveInjection, verifyLiveInjectionRemoved } from './injection-cleanup.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const app = mkdtempSync(join(tmpdir(), 'live-injection-cleanup-'));
  roots.push(app);
  mkdirSync(join(app, '.impeccable/live'), { recursive: true });
  const source = join(app, 'source.html'),
    created = join(app, 'client.js');
  writeFileSync(source, 'user edits\n<!-- LIVE-INJECT -->');
  writeFileSync(created, '/* LIVE-CLIENT */');
  const journal = join(app, '.impeccable/live/inject-journal.json');
  const artifacts = [
    { kind: 'patched', path: 'source.html', markers: ['<!-- LIVE-INJECT -->'], patch: 'live-tag' },
    { kind: 'created', path: 'client.js', marker: 'LIVE-CLIENT' },
  ];
  writeFileSync(journal, JSON.stringify({ version: 1, appRoot: app, artifacts }));
  return { app, source, created, journal, artifacts };
}
it('verifies actual source postconditions after a helper clears its journal', () => {
  const f = fixture(),
    captured = captureLiveInjection(f.app);
  rmSync(f.journal);
  expect(() => verifyLiveInjectionRemoved(f.app, captured)).toThrow(
    'LIVE_INJECTION_CLEANUP_UNVERIFIED',
  );
  rmSync(f.created);
  expect(() => verifyLiveInjectionRemoved(f.app, captured)).toThrow(
    'LIVE_INJECTION_CLEANUP_UNVERIFIED',
  );
  writeFileSync(f.source, 'user edits\n');
  expect(() => verifyLiveInjectionRemoved(f.app, captured)).not.toThrow();
  rmSync(f.source);
  expect(() => verifyLiveInjectionRemoved(f.app, captured)).toThrow(
    'LIVE_INJECTION_CLEANUP_UNVERIFIED',
  );
});
it('refuses outside paths, substituted artifacts and incomplete journals', () => {
  const f = fixture();
  writeFileSync(
    f.journal,
    JSON.stringify({
      version: 1,
      appRoot: f.app,
      artifacts: [{ ...f.artifacts[0], path: '../outside' }],
    }),
  );
  expect(() => captureLiveInjection(f.app)).toThrow('LIVE_INJECTION_CLEANUP_UNVERIFIED');
  writeFileSync(f.journal, JSON.stringify({ version: 1, appRoot: f.app, artifacts: f.artifacts }));
  const captured = captureLiveInjection(f.app);
  rmSync(f.journal);
  rmSync(f.source);
  rmSync(f.created);
  symlinkSync('/etc/passwd', f.source);
  expect(() => verifyLiveInjectionRemoved(f.app, captured)).toThrow(
    'LIVE_INJECTION_CLEANUP_UNVERIFIED',
  );
});
