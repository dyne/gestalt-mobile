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
  async function exportEvents(events: readonly (readonly [string, Record<string, unknown>])[]) {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-handoff-trace-'));
    directories.push(directory);
    const path = join(directory, 'relay.sqlite');
    const database = new DatabaseSync(path);
    try {
      database.exec(
        'CREATE TABLE session_events (session_id TEXT, sequence INTEGER, occurred_at TEXT, type TEXT, payload_json TEXT)',
      );
      const insert = database.prepare('INSERT INTO session_events VALUES (?,?,?,?,?)');
      events.forEach(([type, payload], index) =>
        insert.run('s1', index + 1, '2026-11-03T11:28:24.585Z', type, JSON.stringify(payload)),
      );
    } finally {
      database.close();
    }
    return exportControlPlaneTrace(path, 's1');
  }

  it.each([false, true])(
    'does not require continuation after a terminal checkpoint (reported: %s)',
    async (reported) => {
      const events: Array<[string, Record<string, unknown>]> = [
        ['org-plan.terminal-review-checkpointed', { traceId: 'terminal', turnId: 't1' }],
      ];
      if (reported)
        events.push(['org-plan.terminal-review-reported', { traceId: 'terminal', turnId: 't1' }]);
      const trace = await exportEvents(events);
      expect(trace.events).toHaveLength(reported ? 2 : 1);
      expect(trace.diagnoses).toEqual(
        reported ? [] : ['terminal checkpoint persisted, but no report was observed'],
      );
    },
  );

  it.each([
    ['another trace', { traceId: 'other', turnId: 't1' }],
    ['another handoff despite a shared turn', { handoffId: 'other', turnId: 't1' }],
    ['a matching trace with a conflicting handoff', { traceId: 'selected', handoffId: 'other' }],
    ['a matching handoff with a conflicting trace', { traceId: 'other', handoffId: 'selected' }],
    ['missing identifiers', {}],
  ])('does not satisfy a terminal report with %s', async (_name, report) => {
    const trace = await exportEvents([
      [
        'org-plan.terminal-review-checkpointed',
        { traceId: 'selected', handoffId: 'selected', turnId: 't1' },
      ],
      ['org-plan.terminal-review-reported', report],
      ['autopilot.continuation-scheduled', { traceId: 'other' }],
      ['autopilot.control-issued', { traceId: 'other' }],
      ['agent.activity.updated', {}],
    ]);
    expect(trace.diagnoses).toContain('terminal checkpoint persisted, but no report was observed');
    expect(trace.diagnoses).not.toContain(
      'checkpoint persisted, but no continuation was scheduled',
    );
    expect(trace.diagnoses).toContain(
      'backend agent projection was recorded; browser delivery still requires the client event cursor',
    );
  });

  it('matches a terminal report by handoff identity when no trace identifier exists', async () => {
    expect(
      (
        await exportEvents([
          ['org-plan.terminal-review-checkpointed', { handoffId: 'selected' }],
          ['org-plan.terminal-review-reported', { handoffId: 'selected' }],
        ])
      ).diagnoses,
    ).toEqual([]);
  });

  it('keeps an interleaved unrelated report from satisfying the selected terminal checkpoint', async () => {
    expect(
      (
        await exportEvents([
          ['org-plan.terminal-review-checkpointed', { traceId: 'old' }],
          ['org-plan.terminal-review-checkpointed', { traceId: 'selected' }],
          ['org-plan.terminal-review-reported', { traceId: 'old' }],
        ])
      ).diagnoses,
    ).toContain('terminal checkpoint persisted, but no report was observed');
  });

  it('accepts a matching terminal report despite unrelated interleaved control failures', async () => {
    expect(
      (
        await exportEvents([
          ['org-plan.terminal-review-checkpointed', { traceId: 'selected' }],
          ['autopilot.control-issued', { traceId: 'other' }],
          ['org-plan.terminal-review-reported', { traceId: 'selected' }],
        ])
      ).diagnoses,
    ).toEqual([]);
  });

  it('does not infer a matching terminal report from legacy events without identifiers', async () => {
    const trace = await exportEvents([
      ['org-plan.terminal-review-checkpointed', {}],
      ['org-plan.terminal-review-reported', {}],
    ]);
    expect(trace.diagnoses).not.toContain(
      'checkpoint persisted, but no continuation was scheduled',
    );
    expect(trace.diagnoses.join(' ')).toMatch(/correlation.*unavailable/);
  });

  it('keeps ordinary checkpoint continuation pending despite an unrelated schedule', async () => {
    expect(
      (
        await exportEvents([
          ['org-plan.step-checkpointed', { traceId: 'selected' }],
          ['autopilot.continuation-scheduled', { traceId: 'other' }],
          ['autopilot.control-issued', { traceId: 'other' }],
          ['autopilot.turn-started', { traceId: 'other' }],
        ])
      ).diagnoses,
    ).toContain('checkpoint persisted, but no continuation was scheduled');
  });

  it.each([
    [
      'autopilot.control-issued',
      'continuation scheduled, but no control or executor dispatch was observed',
    ],
    [
      'autopilot.executor-resumed',
      'continuation scheduled, but no control or executor dispatch was observed',
    ],
    ['autopilot.turn-started', 'control issued, but no turn acceptance or failure was observed'],
    ['autopilot.turn-failed', 'control issued, but no turn acceptance or failure was observed'],
  ])('does not use unrelated %s evidence for the selected handoff', async (type, diagnosis) => {
    const events: Array<[string, Record<string, unknown>]> = [
      ['org-plan.step-checkpointed', { traceId: 'selected' }],
      ['autopilot.continuation-scheduled', { traceId: 'selected' }],
    ];
    if (type.startsWith('autopilot.turn-'))
      events.push(['autopilot.control-issued', { traceId: 'selected' }]);
    events.push([type, { traceId: 'other' }]);
    expect((await exportEvents(events)).diagnoses).toContain(diagnosis);
  });

  it('does not invent a checkpoint from a truncated report-only tail', async () => {
    const trace = await exportEvents([
      ['org-plan.terminal-review-reported', { traceId: 'selected' }],
      ['agent.activity.updated', {}],
    ]);
    expect(trace.diagnoses).toEqual([
      'backend agent projection was recorded; browser delivery still requires the client event cursor',
    ]);
    expect(formatControlPlaneTrace(trace)).toContain(
      'coverage is retained-only, not proof of absence',
    );
  });

  it('discloses absent control-plane evidence', async () => {
    expect((await exportEvents([])).diagnoses).toEqual([
      'no control-plane events found for this session',
    ]);
  });

  it.each([false, true])(
    'settles only a matching control cancellation (matching: %s)',
    async (matching) => {
      const trace = await exportEvents([
        ['org-plan.step-checkpointed', { traceId: 'selected' }],
        ['autopilot.continuation-scheduled', { traceId: 'selected', controlId: 'control' }],
        ['autopilot.control-issued', { traceId: 'selected', controlId: 'control' }],
        [
          'autopilot.control-cancelled',
          { controlId: matching ? 'control' : 'other', reason: 'manualDisabled' },
        ],
      ]);
      if (matching)
        expect(trace.diagnoses).not.toContain(
          'control issued, but no turn acceptance or failure was observed',
        );
      else
        expect(trace.diagnoses).toContain(
          'control issued, but no turn acceptance or failure was observed',
        );
    },
  );

  it('keeps legacy recovery and final dispositions unknown when historical fields are absent', async () => {
    const trace = await exportEvents([
      ['autopilot.operation-failed', { kind: 'executorResume' }],
      ['autopilot.final-rejected', { reason: 'incompletePlan' }],
    ]);
    expect(trace.events[0]!.payload).toEqual({ kind: 'executorResume' });
    expect(trace.events[1]!.payload).toEqual({ reason: 'incompletePlan' });
    expect(trace.diagnoses).toContain(
      'executor resume failure cause is unknown in retained evidence',
    );
    expect(trace.diagnoses).toContain(
      'incomplete final disposition is unknown in retained evidence',
    );
  });

  it.each(['older control', 'conflicting trace'])(
    'does not hide an issued boundary with cancellation of %s',
    async (scenario) => {
      const trace = await exportEvents([
        ['org-plan.step-checkpointed', { traceId: 'selected' }],
        ['autopilot.continuation-scheduled', { traceId: 'selected', controlId: 'old-control' }],
        ['autopilot.control-issued', { traceId: 'selected', controlId: 'new-control' }],
        [
          'autopilot.control-cancelled',
          {
            traceId: scenario === 'conflicting trace' ? 'other' : 'selected',
            controlId: scenario === 'conflicting trace' ? 'new-control' : 'old-control',
          },
        ],
      ]);
      expect(trace.diagnoses).toContain(
        'control issued, but no turn acceptance or failure was observed',
      );
    },
  );

  it.each([
    [
      'matching',
      { requestId: 'command', threadId: 'executor', generation: 1, traceId: 'selected' },
      true,
    ],
    [
      'unrelated request',
      { requestId: 'other', threadId: 'executor', generation: 1, traceId: 'selected' },
      false,
    ],
    [
      'unrelated generation',
      { requestId: 'command', threadId: 'executor', generation: 2, traceId: 'selected' },
      false,
    ],
    [
      'unrelated trace',
      { requestId: 'command', threadId: 'executor', generation: 1, traceId: 'other' },
      false,
    ],
    [
      'unrelated control',
      {
        requestId: 'command',
        threadId: 'executor',
        generation: 1,
        traceId: 'selected',
        controlId: 'other-control',
      },
      false,
    ],
    ['absent correlation', {}, false],
  ])(
    'attributes root recovery only to the failed attempt: %s',
    async (_name, recovery, matched) => {
      const trace = await exportEvents([
        [
          'autopilot.operation-failed',
          {
            kind: 'executorResume',
            reason: 'CODEX_JSON_RPC_ERROR',
            rpcCode: -32600,
            requestId: 'command',
            threadId: 'executor',
            generation: 1,
            traceId: 'selected',
          },
        ],
        [
          'autopilot.continuation-scheduled',
          {
            requestId: 'command',
            threadId: 'executor',
            generation: 1,
            traceId: 'selected',
            controlId: 'root-control',
            disposition: 'executorResumeRecovery',
          },
        ],
        [
          'autopilot.turn-started',
          { controlId: 'root-control', ...recovery, disposition: 'executorResumeRecovery' },
        ],
      ]);
      expect(trace.diagnoses).toContain(
        matched
          ? 'root continuation observed after executor resume failure; executor outcome remains unconfirmed'
          : 'executor resume failed; no matching root recovery continuation was observed; executor outcome remains unconfirmed',
      );
      expect(trace.diagnoses).toContain(
        'executor resume failure cause is unknown in retained evidence',
      );
    },
  );

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
        disposition: 'private-provider-prose',
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

  it('does not require another continuation after a reported terminal review', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gestalt-terminal-trace-'));
    directories.push(directory);
    const path = join(directory, 'relay.sqlite');
    const database = new DatabaseSync(path);
    database.exec(
      'CREATE TABLE session_events (session_id TEXT, sequence INTEGER, occurred_at TEXT, type TEXT, payload_json TEXT)',
    );
    const insert = database.prepare('INSERT INTO session_events VALUES (?,?,?,?,?)');
    // Completion status can be absent from the retained status tail. The
    // terminal boundary itself establishes that no next step is expected.
    for (const [index, type] of [
      'org-plan.terminal-review-checkpointed',
      'org-plan.terminal-review-reported',
    ].entries())
      insert.run('s1', index + 1, `2026-01-01T00:00:0${index}.000Z`, type, '{}');
    database.close();
    const trace = exportControlPlaneTrace(path, 's1');
    expect(trace.events).toHaveLength(2);
    expect(trace.diagnoses).not.toContain(
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
