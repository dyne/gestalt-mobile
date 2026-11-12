/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { SqliteAutopilotStore } from './sqlite-autopilot-store.js';
import { SqliteSupervisionTakeoverStore } from './sqlite-supervision-takeover-store.js';

it('releases only the closed supervisor and fences its stale claims across reacquisition', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrate(db);
    const store = new SqliteSupervisionTakeoverStore(db, new SqliteAutopilotStore(db));
    const old = store.claim('plan', 'old')!;
    const other = store.claim('other-plan', 'other')!;
    expect(store.retire(old, ['retired'])).toBe(true);
    store.releaseSession('old');
    expect(store.owner('plan')).toBeNull();
    expect(store.owner('other-plan')).toEqual(other);
    expect(store.retired('plan', 'retired')).toBe(true);
    expect(store.retire(old, ['late'])).toBe(false);
    const reopened = store.claim('plan', 'old')!;
    expect(reopened.epoch).toBeGreaterThan(old.epoch);
    expect(store.retire(old, ['late'])).toBe(false);
    expect(store.retire(reopened, ['current'])).toBe(true);
  } finally {
    db.close();
  }
});
