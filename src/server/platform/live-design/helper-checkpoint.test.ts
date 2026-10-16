/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { helperCheckpointDigest } from './helper-checkpoint.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
it('binds canonical journal bytes and actual source independently of a derived snapshot', () => {
  const app = mkdtempSync(join(tmpdir(), 'live-helper-checkpoint-'));
  roots.push(app);
  const directory = join(app, '.impeccable/live/sessions');
  mkdirSync(directory, { recursive: true });
  const source = join(app, 'index.html'),
    journal = join(directory, 'session.jsonl');
  writeFileSync(source, 'original');
  const event = { sourceFile: 'index.html', phase: 'completed' };
  writeFileSync(journal, JSON.stringify(event) + '\n');
  const before = helperCheckpointDigest(app);
  expect(helperCheckpointDigest(app)).toBe(before);
  writeFileSync(source, 'unobserved accept');
  expect(helperCheckpointDigest(app)).not.toBe(before);
  writeFileSync(source, 'original');
  writeFileSync(journal, JSON.stringify({ ...event, phase: 'accept_requested' }) + '\n');
  expect(helperCheckpointDigest(app)).not.toBe(before);
  writeFileSync(journal, JSON.stringify({ sourceFile: '/outside-app' }) + '\n');
  expect(() => helperCheckpointDigest(app)).toThrow('LIVE_HELPER_CHECKPOINT_UNVERIFIED');
  writeFileSync(journal, JSON.stringify(event) + '\n');
  rmSync(source);
  symlinkSync('/etc/passwd', source);
  expect(() => helperCheckpointDigest(app)).toThrow('LIVE_HELPER_CHECKPOINT_UNVERIFIED');
});
