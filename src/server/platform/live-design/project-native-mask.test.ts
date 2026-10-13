/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { observeNativeDeniedPath } from './project-native-mask.js';

describe('actual process mount-view denial observation', () => {
  it('refuses visible procfs and empty directories as filesystem denial', () => {
    const path = mkdtempSync('/tmp/live-mask-view-');
    try {
      expect(observeNativeDeniedPath(process.pid, '/proc')).toBe(false);
      expect(observeNativeDeniedPath(process.pid, path)).toBe(false);
      writeFileSync(join(path, 'canary'), 'private-fixture', { mode: 0o600 });
      expect(observeNativeDeniedPath(process.pid, join(path, 'canary'))).toBe(false);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
  it.skipIf(process.getuid?.() === 0)(
    'observes real inaccessible directories without a synthetic callback',
    () => {
      const path = mkdtempSync('/tmp/live-mask-denial-');
      try {
        chmodSync(path, 0o000);
        expect(observeNativeDeniedPath(process.pid, path)).toBe(true);
      } finally {
        chmodSync(path, 0o700);
        rmSync(path, { recursive: true, force: true });
      }
    },
  );
});
