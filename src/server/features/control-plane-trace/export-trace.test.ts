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
import {
  exportControlPlaneTrace,
  formatControlPlaneTrace,
  redactDiagnosticPayload,
} from './export-trace.js';
import { toAgentActivityDto } from '../agent-activity/activity-dto.js';
import { createAgentActivitySnapshot, projectAgentActivity } from '../agent-activity/model.js';
import { migrate } from '../../platform/persistence/migrate.js';
import { SqliteEventJournal } from '../../platform/persistence/sqlite-event-journal.js';
import { McpStartupTracker } from '../../platform/codex/mcp-startup-failure.js';
import { mcpStartupActivity } from '../../../shared/contracts/mcp-startup-failure.js';

const directories: string[] = [];
afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true }))),
);

describe('control-plane trace export', () => {
  it('retains a run-scoped wait identity while excluding execution output', () => {
    expect(
      redactDiagnosticPayload({
        runId: '00000000-0000-4000-8000-000000000001',
        output: 'private execution output',
        prompt: 'private input',
      }),
    ).toEqual({
      runId: '00000000-0000-4000-8000-000000000001',
    });
  });
  it('sanitizes startup metadata on persistence and export and rejects mismatched runtime correlation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-startup-trace-'));
    directories.push(directory);
    const path = join(directory, 'relay.sqlite');
    const database = new DatabaseSync(path);
    migrate(database);
    const at = new Date().toISOString();
    database
      .prepare(
        'INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run('s1', 'w', '/workspace', 'default', 'ready', 'active', at, at);
    const journal = new SqliteEventJournal(database);
    const status = new McpStartupTracker().observe({
      method: 'mcpServer/startupStatus/updated',
      params: { name: 'context-mode', status: 'failed', threadId: 'child' },
    })!;
    const poisoned = {
      ...status,
      error: 'secret',
      environment: { TOKEN: 'secret' },
      failure: { ...status.failure, stderr: 'secret', prompt: 'secret' },
    };
    const event = journal.append('s1', 'agent.activity.mcp-startup', poisoned, at);
    journal.append(
      's1',
      'activity.updated',
      { ...mcpStartupActivity(status), label: 'secret', detail: 'secret', mcpStartup: poisoned },
      at,
    );
    expect(JSON.stringify(journal.replay('s1', 0))).not.toContain('secret');
    expect(() =>
      journal.append(
        's1',
        'agent.activity.mcp-startup',
        { ...status, runtimeId: 'other-runtime' },
        at,
      ),
    ).toThrow('INVALID_MCP_STARTUP_STATUS');
    // Export revalidates even historical rows written outside the current adapter.
    database
      .prepare('UPDATE session_events SET payload_json = ? WHERE session_id = ? AND sequence = ?')
      .run(JSON.stringify(poisoned), 's1', event.sequence);
    expect(JSON.stringify(exportControlPlaneTrace(path, 's1'))).not.toContain('secret');
    expect(exportControlPlaneTrace(path, 's1').events[0]).toMatchObject({
      traceId: status.failure!.failureId,
      payload: status,
    });
    expect(formatControlPlaneTrace(exportControlPlaneTrace(path, 's1'))).toContain(
      'server=context-mode thread=child',
    );
    expect(formatControlPlaneTrace(exportControlPlaneTrace(path, 's1'))).toContain(
      'phase=startup code=startup-failed exit=unavailable signal=unavailable artifact=unavailable',
    );
    database
      .prepare('UPDATE session_events SET payload_json = ? WHERE session_id = ? AND sequence = ?')
      .run(JSON.stringify({ ...poisoned, attemptId: 'mismatched' }), 's1', event.sequence);
    expect(exportControlPlaneTrace(path, 's1').events[0]).toMatchObject({
      traceId: null,
      payload: {},
    });
    database.close();
  });
  it('exports durable wait correlations and observation timestamps without command output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-wait-trace-'));
    directories.push(directory);
    const path = join(directory, 'relay.sqlite');
    const db = new DatabaseSync(path);
    db.exec(
      'CREATE TABLE session_events (session_id TEXT, sequence INTEGER, occurred_at TEXT, type TEXT, payload_json TEXT)',
    );
    const payload = {
      leaseId: 'lease-1',
      reportId: 'report-1',
      processId: 'process-1',
      resumeAt: '2026-10-18T10:17:08.857Z',
      observedAt: '2026-10-18T10:17:08.859Z',
      wakeCondition: 'processResultAvailable',
      wakeConditions: ['processExited'],
      nextEvaluationAt: '2026-10-18T10:17:12.859Z',
      command: 'private command',
      stdout: 'private output',
      environment: { TOKEN: 'private token' },
    };
    db.prepare('INSERT INTO session_events VALUES (?,?,?,?,?)').run(
      's',
      1,
      payload.observedAt,
      'autopilot.wait-expired',
      JSON.stringify(payload),
    );
    db.close();
    const trace = exportControlPlaneTrace(path, 's', payload.observedAt);
    expect(trace.events[0]).toMatchObject({
      traceId: 'lease-1',
      payload: {
        leaseId: 'lease-1',
        reportId: 'report-1',
        resumeAt: payload.resumeAt,
        observedAt: payload.observedAt,
        nextEvaluationAt: payload.nextEvaluationAt,
      },
    });
    expect(JSON.stringify(trace)).not.toContain('private');
  });

  it('retains provider error identifiers and HTTP status without provider prose', () => {
    expect(
      redactDiagnosticPayload({
        providerFailure: {
          code: 'httpConnectionFailed',
          httpStatusCode: 503,
          message: 'private request detail',
          additionalDetails: 'private diagnostics',
        },
      }),
    ).toEqual({ providerFailure: { code: 'httpConnectionFailed', httpStatusCode: 503 } });
  });
  it('keeps the failed boundary when interleaved status polling exceeds the export budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-trace-flood-'));
    directories.push(directory);
    const path = join(directory, 'relay.sqlite');
    const database = new DatabaseSync(path);
    database.exec(
      'CREATE TABLE session_events (session_id TEXT, sequence INTEGER, occurred_at TEXT, type TEXT, payload_json TEXT)',
    );
    const insert = database.prepare('INSERT INTO session_events VALUES (?,?,?,?,?)');
    const at = '2026-01-01T00:00:00.000Z';
    insert.run(
      's1',
      1,
      at,
      'autopilot.operation-failed',
      JSON.stringify({ kind: 'executorResume', rpcCode: -32600, prompt: 'private-content' }),
    );
    database.exec('BEGIN');
    for (let index = 0; index < 6000; index++) {
      const type = ['autopilot.updated', 'agent.activity.updated', 'session.status.updated'][
        index % 3
      ]!;
      insert.run('s1', index + 2, at, type, JSON.stringify({ state: 'idle', observedAt: at }));
    }
    insert.run(
      's1',
      0,
      at,
      'autopilot.provider-failed',
      JSON.stringify({
        providerFailure: { code: 'serverOverloaded', message: 'private-content' },
        turnId: 'root-turn',
        actor: 'root',
        requestedEnabled: false,
        retryAttempt: null,
      }),
    );
    insert.run('other-session', 1, at, 'autopilot.turn-failed', '{}');
    database.exec('COMMIT');
    database.close();
    const trace = exportControlPlaneTrace(path, 's1', at);
    expect(trace.events).toHaveLength(102);
    expect(trace.events[0]).toMatchObject({
      type: 'autopilot.provider-failed',
      payload: {
        providerFailure: { code: 'serverOverloaded' },
        turnId: 'root-turn',
        actor: 'root',
        requestedEnabled: false,
      },
    });
    expect(trace.events[1]).toMatchObject({
      sequence: 1,
      type: 'autopilot.operation-failed',
      payload: { kind: 'executorResume', rpcCode: -32600 },
    });
    expect(trace.events.at(-1)?.sequence).toBe(6001);
    expect(trace.selection).toMatchObject({
      omittedStatusEvents: 5900,
      omittedTransitionEvents: 0,
    });
    expect(formatControlPlaneTrace(trace)).toContain('5900 status snapshots');
    expect(JSON.stringify(trace)).not.toMatch(/private-content|other-session/);
  });
  it('retains structural RPC failure codes while excluding exception prose', () => {
    expect(
      redactDiagnosticPayload({
        kind: 'executorResume',
        rpcCode: -32603,
        message: 'private exception',
        prompt: 'private prompt',
        environment: { KEY: 'secret' },
      }),
    ).toEqual({ kind: 'executorResume', rpcCode: -32603 });
  });
  it('preserves owned process evidence from the activity projection through the journal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-trace-'));
    directories.push(directory);
    const path = join(directory, 'relay.sqlite');
    const database = new DatabaseSync(path);
    migrate(database);
    const at = '2026-01-01T00:00:00.000Z';
    database
      .prepare(
        'INSERT INTO relay_sessions (id,workspace_id,workspace_path,profile,state,desired_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run('s1', 'w', '/workspace', 'default', 'ready', 'active', at, at);
    const snapshot = projectAgentActivity(createAgentActivitySnapshot('s1', at), {
      sessionId: 's1',
      occurredAt: at,
      kind: 'collaboration',
      childId: 'child',
      childStatus: 'completed',
      childTaskPath: '/root/l1',
      childOwnedProcesses: [
        {
          processId: 'private-process',
          itemId: 'private-item',
          ownerThreadId: 'child',
          ownerTaskPath: '/root/l1',
          ownership: 'supervisor',
          state: 'detached-active',
          observedAt: at,
          elapsedMs: 1,
          cpuPercent: 99,
          rssBytes: 99,
        },
      ],
    });
    const payload = {
      ...toAgentActivityDto(snapshot),
      prompt: 'private-prompt',
      ownedProcesses: [
        {
          state: 'running',
          ownership: 'executor',
          command: 'private-command',
          output: 'private-output',
          environment: { TOKEN: 'private-token' },
        },
      ],
    };
    new SqliteEventJournal(database).append('s1', 'agent.activity.updated', payload, at);
    database.close();
    const trace = exportControlPlaneTrace(path, 's1', at);
    expect(trace.events[0]?.payload).toMatchObject({
      subagents: [
        { ownedProcesses: [{ state: 'detached-active', ownership: 'supervisor', observedAt: at }] },
      ],
      ownedProcesses: [{ state: 'running', ownership: 'executor' }],
    });
    expect(JSON.stringify(trace)).not.toMatch(
      /private-|cpuPercent|rssBytes|environment|command|output/,
    );
  });

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
      JSON.stringify({
        traceId: 'handoff-1',
        controlId: 'c1',
        prompt: 'private prompt',
        token: 'secret',
        environment: { KEY: 'credential' },
        root: { state: 'working', text: 'private response', label: 'private label' },
      }),
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
    expect(trace.events[1]!.payload).toEqual({
      traceId: 'handoff-1',
      controlId: 'c1',
      root: { state: 'working' },
    });
    expect(JSON.stringify(trace)).not.toMatch(/private|credential|secret/);
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

it('exports persisted transport observations separately from conversation/control events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gestalt-transport-trace-'));
  directories.push(directory);
  const path = join(directory, 'relay.sqlite');
  const database = new DatabaseSync(path);
  migrate(database);
  database
    .prepare(
      "INSERT INTO relay_sessions(id, workspace_id, workspace_path, profile, state, desired_state, created_at, updated_at) VALUES ('s', 'w', '/w', 'default', 'idle', 'running', 'now', 'now')",
    )
    .run();
  database
    .prepare(
      'INSERT INTO chat_transport_diagnostics(session_id, occurred_at, metadata_json) VALUES (?, ?, ?)',
    )
    .run(
      's',
      Date.parse('2026-10-17T08:00:00Z'),
      JSON.stringify({
        kind: 'history',
        status: 200,
        attempts: 3,
        coalesced: 7,
        prompt: 'secret-output',
      }),
    );
  database.close();
  const trace = exportControlPlaneTrace(path, 's', '2026-10-17T08:01:00Z');
  expect(trace.transport).toMatchObject({
    available: true,
    coverage: 'retained-only',
    records: [{ kind: 'history', status: 200, attempts: 3, coalesced: 7 }],
  });
  expect(trace.events).toEqual([]);
  expect(JSON.stringify(trace)).not.toContain('secret-output');
});
