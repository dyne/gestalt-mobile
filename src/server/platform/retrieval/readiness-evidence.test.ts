/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { expect, it } from 'vitest';
import { ReadinessEvidence } from './readiness-evidence.js';

it('keeps connection, symbols and references independent and accepts only supported observations', () => {
  const evidence = new ReadinessEvidence();
  const generation = evidence.bind('runtime:config:source');
  expect(evidence.semantic(generation, 'get_symbols_overview', true)).toBe(false);
  evidence.connection('ready');
  expect(evidence.snapshot()).toMatchObject({
    connection: { state: 'ready' },
    symbols: { state: 'unknown' },
    references: { state: 'unknown' },
  });
  expect(evidence.semantic(generation, 'tools/list', true)).toBe(false);
  expect(evidence.semantic(generation, 'get_symbols_overview', true)).toBe(true);
  expect(evidence.semantic(generation, 'find_referencing_symbols', false)).toBe(true);
  expect(evidence.snapshot()).toMatchObject({
    symbols: { state: 'ready', generation },
    references: { state: 'unavailable', generation, reason: 'operation-failed' },
  });
  expect(evidence.needsProbe('references')).toBe(false);
  evidence.connection('unavailable');
  expect(evidence.snapshot().symbols.state).toBe('stale');
});

it.each(['source', 'config', 'tool', 'runtime'])(
  'invalidates negative evidence after %s generation changes and rejects late results',
  (change) => {
    const evidence = new ReadinessEvidence();
    const previous = evidence.bind('before');
    evidence.connection('ready');
    evidence.semantic(previous, 'find_referencing_symbols', false);
    evidence.bind(change);
    expect(evidence.snapshot().references.state).toBe('stale');
    expect(evidence.needsProbe('references')).toBe(true);
    expect(evidence.semantic(previous, 'find_referencing_symbols', true)).toBe(false);
    evidence.connection('ready');
    expect(evidence.semantic(evidence.generation, 'find_referencing_symbols', true)).toBe(true);
    expect(evidence.snapshot().references.state).toBe('ready');
  },
);

it('does not invent coverage, mutate snapshots or include private input in public evidence', () => {
  const evidence = new ReadinessEvidence();
  evidence.bind('/private/root/compile_commands.json');
  evidence.connection('ready');
  expect(evidence.snapshot().coverage.state).toBe('unknown');
  evidence.coverage('unavailable', { records: 0, files: 0 });
  expect(evidence.snapshot().coverage).toMatchObject({
    state: 'unavailable',
    reason: 'empty-index',
    records: 0,
  });
  const snapshot = evidence.snapshot();
  snapshot.connection.state = 'unavailable';
  expect(evidence.snapshot().connection.state).toBe('ready');
  expect(JSON.stringify(evidence.snapshot())).not.toContain('/private');
});
