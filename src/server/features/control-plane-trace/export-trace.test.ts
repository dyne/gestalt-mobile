/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportControlPlaneTrace, formatControlPlaneTrace } from './export-trace.js';

const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))),
);

describe('control-plane trace export', () => {
  it('correlates events and diagnoses a scheduled handoff that never dispatched', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-trace-'));
    directories.push(directory);
    const path = join(directory, 'relay.sqlite');
    const database = new DatabaseSync(path);
    database.exec(
      'CREATE TABLE session_events (session_id TEXT, sequence INTEGER, occurred_at TEXT, type TEXT, payload_json TEXT)',
    );
    const insert = database.prepare('INSERT INTO session_events VALUES (?,?,?,?,?)');
    insert.run(
      's1',
      1,
      '2026-01-01T00:00:00.000Z',
      'org-plan.step-checkpointed',
      JSON.stringify({ traceId: 'handoff-1', turnId: 't1' }),
    );
    insert.run(
      's1',
      2,
      '2026-01-01T00:00:01.000Z',
      'autopilot.continuation-scheduled',
      JSON.stringify({ traceId: 'handoff-1', controlId: 'c1' }),
    );
    insert.run(
      's1',
      3,
      '2026-01-01T00:00:02.000Z',
      'item.delta',
      JSON.stringify({ secret: 'excluded' }),
    );
    database.close();
    const trace = exportControlPlaneTrace(path, 's1', '2026-01-01T00:01:00.000Z');
    expect(trace.events).toHaveLength(2);
    expect(trace.events.map((event) => event.traceId)).toEqual(['handoff-1', 'handoff-1']);
    expect(trace.diagnoses).toContain(
      'continuation scheduled, but no control or executor dispatch was observed',
    );
    expect(formatControlPlaneTrace(trace)).toContain('trace=handoff-1');
  });

  it('diagnoses the latest handoff independently of older completed controls', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-trace-'));
    directories.push(directory);
    const path = join(directory, 'relay.sqlite');
    const database = new DatabaseSync(path);
    database.exec(
      'CREATE TABLE session_events (session_id TEXT, sequence INTEGER, occurred_at TEXT, type TEXT, payload_json TEXT)',
    );
    const insert = database.prepare('INSERT INTO session_events VALUES (?,?,?,?,?)');
    for (const [sequence, type] of [
      [1, 'org-plan.step-checkpointed'],
      [2, 'autopilot.continuation-scheduled'],
      [3, 'autopilot.control-issued'],
      [4, 'autopilot.turn-started'],
      [5, 'org-plan.step-checkpointed'],
    ] as const)
      insert.run('s1', sequence, `2026-01-01T00:00:0${sequence}.000Z`, type, '{}');
    database.close();
    expect(exportControlPlaneTrace(path, 's1').diagnoses).toContain(
      'checkpoint persisted, but no continuation was scheduled',
    );
  });
});
