/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readTransportDiagnostics } from '../../platform/persistence/sqlite-transport-diagnostics.js';
import { DatabaseSync } from 'node:sqlite';
import { parseMcpStartupStatus } from '../../../shared/contracts/mcp-startup-failure.js';

type TraceRow = Readonly<{
  sequence: number;
  occurredAt: string;
  type: string;
  payload: Record<string, unknown>;
  traceId: string | null;
}>;

export type ControlPlaneTrace = Readonly<{
  schemaVersion: 1;
  transport?: ReturnType<typeof readTransportDiagnostics>;
  sessionId: string;
  generatedAt: string;
  events: readonly TraceRow[];
  diagnoses: readonly string[];
  selection: Readonly<{
    statusEventLimit: number;
    transitionEventLimit: number;
    omittedStatusEvents: number;
    omittedTransitionEvents: number;
  }>;
}>;

const relevant =
  /^(?:org-plan\.|autopilot\.|agent\.activity\.|session\.status\.|session\.provider-retry-)/;
const statusTypes = ['autopilot.updated', 'agent.activity.updated', 'session.status.updated'];

// Export structural telemetry only. Event types alone do not imply payload safety.
const diagnosticFields = new Set([
  'leaseId',
  'runId',
  'reportId',
  'resumeAt',
  'wakeCondition',
  'wakeConditions',
  'nextEvaluationAt',
  'processId',
  'traceId',
  'handoffId',
  'controlId',
  'turnId',
  'requestId',
  'threadId',
  'sessionId',
  'generation',
  'sequence',
  'state',
  'status',
  'reason',
  'code',
  'rpcCode',
  'disposition',
  'providerFailure',
  'actor',
  'retryAttempt',
  'httpStatusCode',
  'enabled',
  'requestedEnabled',
  'desiredState',
  'stopReason',
  'failureCount',
  'noProgressCount',
  'canonicalPosition',
  'taskPath',
  'taskName',
  'continuationGeneration',
  'activeHandoffId',
  'lastControlId',
  'lastTurnId',
  'confidence',
  'observedAt',
  'root',
  'subagents',
  'processes',
  'ownedProcesses',
  'ownership',
  'aggregateSubagents',
  'aggregateProcesses',
  'kind',
  'id',
  'parentThreadId',
  'running',
  'completed',
  'pending',
  'count',
]);

export function redactDiagnosticPayload(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === 'string')
    return value.length <= 200 && /^[a-zA-Z0-9_./:@+-]*$/.test(value) ? value : '[redacted]';
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redactDiagnosticPayload(item, depth + 1));
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          diagnosticFields.has(key) &&
          (key !== 'disposition' ||
            (typeof item === 'string' &&
              ['acceptedWait', 'rejectedFinal', 'unknownWait', 'executorResumeRecovery'].includes(
                item,
              ))),
      )
      .map(([key, item]) => [key, redactDiagnosticPayload(item, depth + 1)]),
  );
}

function objectPayload(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function correlation(payload: Record<string, unknown>): string | null {
  for (const key of ['traceId', 'handoffId', 'controlId', 'leaseId', 'turnId', 'requestId'])
    if (typeof payload[key] === 'string' && payload[key]) return String(payload[key]);
  return null;
}

function handoffIdentity(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value && value !== '[redacted]' ? value : null;
}

function matchesHandoff(checkpoint: TraceRow, event: TraceRow): boolean {
  let matched = false;
  for (const key of ['traceId', 'handoffId']) {
    const selected = handoffIdentity(checkpoint.payload, key);
    const observed = handoffIdentity(event.payload, key);
    if (selected && observed) {
      if (selected !== observed) return false;
      matched = true;
    }
  }
  return matched;
}

function conflictsWithHandoff(left: TraceRow, right: TraceRow): boolean {
  return ['traceId', 'handoffId'].some((key) => {
    const a = handoffIdentity(left.payload, key);
    const b = handoffIdentity(right.payload, key);
    return a !== null && b !== null && a !== b;
  });
}

function matchesAttempt(failure: TraceRow, event: TraceRow): boolean {
  return (
    ['requestId', 'threadId'].every((key) => {
      const id = handoffIdentity(failure.payload, key);
      return id !== null && id === handoffIdentity(event.payload, key);
    }) &&
    Number.isSafeInteger(failure.payload.generation) &&
    Number(failure.payload.generation) > 0 &&
    failure.payload.generation === event.payload.generation &&
    !conflictsWithHandoff(failure, event)
  );
}

function diagnose(events: readonly TraceRow[]): string[] {
  const diagnoses: string[] = [];
  if (!events.length) return ['no control-plane events found for this session'];
  const checkpointIndex = events.findLastIndex((event) => event.type.endsWith('-checkpointed'));
  const currentHandoff = checkpointIndex < 0 ? events : events.slice(checkpointIndex);
  const checkpoint = checkpointIndex < 0 ? undefined : events[checkpointIndex];
  const hasIdentity =
    checkpoint && ['traceId', 'handoffId'].some((key) => handoffIdentity(checkpoint.payload, key));
  // Legacy rows retain their chronological diagnostics, but cannot establish
  // matching coverage. A shared turn alone is not a handoff identity.
  if (checkpoint && !hasIdentity)
    diagnoses.push(
      'checkpoint correlation unavailable; matching handoff evidence cannot be established',
    );
  const selected = currentHandoff.filter(
    (event) => !hasIdentity || matchesHandoff(checkpoint!, event),
  );
  // A control-only cancellation/outcome can close only the control actually
  // linked by a retained selected schedule/issue event. Conflicting handoff
  // identifiers must not be rescued by a shared control ID.
  const controls = new Set(
    selected
      .filter((event) =>
        ['autopilot.continuation-scheduled', 'autopilot.control-issued'].includes(event.type),
      )
      .map((event) => handoffIdentity(event.payload, 'controlId'))
      .filter((id) => id !== null),
  );
  const matching = currentHandoff.filter(
    (event) =>
      selected.includes(event) ||
      (checkpoint &&
        !conflictsWithHandoff(checkpoint, event) &&
        ['autopilot.control-cancelled', 'autopilot.turn-started', 'autopilot.turn-failed'].includes(
          event.type,
        ) &&
        controls.has(handoffIdentity(event.payload, 'controlId') ?? '')),
  );
  const types = new Set(matching.map((event) => event.type));
  const closedAfter = (boundary: TraceRow, outcomes: readonly string[]) =>
    matching.some(
      (event) =>
        event.sequence > boundary.sequence &&
        outcomes.includes(event.type) &&
        !conflictsWithHandoff(boundary, event) &&
        (!handoffIdentity(boundary.payload, 'controlId') ||
          boundary.payload.controlId === event.payload.controlId),
    );
  const scheduled = matching.findLast((event) => event.type === 'autopilot.continuation-scheduled');
  const issued = matching.findLast((event) => event.type === 'autopilot.control-issued');
  // Terminal supervision closes with a matching report, not another turn.
  const terminalCheckpoint = checkpoint?.type === 'org-plan.terminal-review-checkpointed';
  if (terminalCheckpoint && !types.has('org-plan.terminal-review-reported'))
    diagnoses.push('terminal checkpoint persisted, but no report was observed');
  if (
    !terminalCheckpoint &&
    (types.has('org-plan.step-checkpointed') || types.has('org-plan.milestone-checkpointed')) &&
    !types.has('autopilot.continuation-scheduled')
  )
    diagnoses.push('checkpoint persisted, but no continuation was scheduled');
  if (
    scheduled &&
    !closedAfter(scheduled, [
      'autopilot.control-issued',
      'autopilot.executor-resumed',
      'autopilot.control-cancelled',
    ])
  )
    diagnoses.push('continuation scheduled, but no control or executor dispatch was observed');
  if (
    issued &&
    !closedAfter(issued, [
      'autopilot.turn-started',
      'autopilot.turn-failed',
      'autopilot.control-cancelled',
    ])
  )
    diagnoses.push('control issued, but no turn acceptance or failure was observed');
  if (types.has('org-plan.checkpoint-handoff-failed'))
    diagnoses.push('checkpoint response handoff failed; inspect the matching trace ID');
  const resumeFailure = matching.findLast(
    (event) =>
      event.type === 'autopilot.operation-failed' && event.payload.kind === 'executorResume',
  );
  if (resumeFailure) {
    diagnoses.push('executor resume failure cause is unknown in retained evidence');
    const recoverySchedule = matching.find(
      (event) =>
        event.sequence > resumeFailure.sequence &&
        event.type === 'autopilot.continuation-scheduled' &&
        event.payload.disposition === 'executorResumeRecovery' &&
        matchesAttempt(resumeFailure, event),
    );
    const recovered =
      recoverySchedule &&
      matching.some(
        (event) =>
          event.sequence > recoverySchedule.sequence &&
          event.type === 'autopilot.turn-started' &&
          event.payload.disposition === 'executorResumeRecovery' &&
          matchesAttempt(resumeFailure, event) &&
          handoffIdentity(recoverySchedule.payload, 'controlId') !== null &&
          event.payload.controlId === recoverySchedule.payload.controlId,
      );
    diagnoses.push(
      recovered
        ? 'root continuation observed after executor resume failure; executor outcome remains unconfirmed'
        : 'executor resume failed; no matching root recovery continuation was observed; executor outcome remains unconfirmed',
    );
  }
  if (
    matching.some(
      (event) =>
        event.type === 'autopilot.final-rejected' &&
        event.payload.reason === 'incompletePlan' &&
        !['acceptedWait', 'rejectedFinal'].includes(String(event.payload.disposition)),
    )
  )
    diagnoses.push('incomplete final disposition is unknown in retained evidence');
  if (currentHandoff.some((event) => event.type === 'agent.activity.updated'))
    diagnoses.push(
      'backend agent projection was recorded; browser delivery still requires the client event cursor',
    );
  return diagnoses;
}

export function exportControlPlaneTrace(
  databasePath: string,
  sessionId: string,
  generatedAt = new Date().toISOString(),
): ControlPlaneTrace {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec('BEGIN');
    // Reserve the diagnostic budget for causal transitions. Polling status
    // snapshots must not evict the failed handoff from an otherwise retained
    // journal. Keep a recent status tail and disclose every omitted row.
    const statusEventLimit = 100;
    const transitionEventLimit = 4900;
    const relevantWhere =
      "(type LIKE 'org-plan.%' OR type LIKE 'autopilot.%' OR type LIKE 'agent.activity.%' OR type LIKE 'session.status.%' OR type LIKE 'session.provider-retry-%')";
    const statusWhere = `type IN (${statusTypes.map(() => '?').join(',')})`;
    const counts = database
      .prepare(
        `SELECT SUM(CASE WHEN ${statusWhere} THEN 1 ELSE 0 END) AS statuses, COUNT(*) AS total FROM session_events WHERE session_id = ? AND ${relevantWhere}`,
      )
      .get(...statusTypes, sessionId) as { statuses: number | null; total: number };
    const rows = database
      .prepare(
        `SELECT * FROM (SELECT sequence,occurred_at,type,payload_json FROM session_events WHERE session_id = ? AND ${statusWhere} ORDER BY sequence DESC LIMIT ?) UNION ALL SELECT * FROM (SELECT sequence,occurred_at,type,payload_json FROM session_events WHERE session_id = ? AND ${relevantWhere} AND NOT (${statusWhere}) ORDER BY sequence DESC LIMIT ?) ORDER BY sequence DESC`,
      )
      .all(
        sessionId,
        ...statusTypes,
        statusEventLimit,
        sessionId,
        ...statusTypes,
        transitionEventLimit,
      ) as Array<{
      sequence: number;
      occurred_at: string;
      type: string;
      payload_json: string;
    }>;
    const events = rows
      .reverse()
      .filter((row) => relevant.test(row.type))
      .map((row) => {
        const raw = objectPayload(row.payload_json);
        const payload = (
          row.type === 'agent.activity.mcp-startup'
            ? (parseMcpStartupStatus(raw) ?? {})
            : redactDiagnosticPayload(raw)
        ) as Record<string, unknown>;
        return {
          sequence: row.sequence,
          occurredAt: row.occurred_at,
          type: row.type,
          payload,
          traceId:
            row.type === 'agent.activity.mcp-startup'
              ? ((payload.failure as { failureId?: string } | null)?.failureId ??
                (typeof payload.attemptId === 'string' ? payload.attemptId : null))
              : correlation(payload),
        };
      });
    return {
      schemaVersion: 1,
      transport: readTransportDiagnostics(database, sessionId, Date.parse(generatedAt)),
      sessionId,
      generatedAt,
      events,
      diagnoses: diagnose(events),
      selection: {
        statusEventLimit,
        transitionEventLimit,
        omittedStatusEvents: Math.max(0, (counts.statuses ?? 0) - statusEventLimit),
        omittedTransitionEvents: Math.max(
          0,
          counts.total - (counts.statuses ?? 0) - transitionEventLimit,
        ),
      },
    };
  } finally {
    database.close();
  }
}

export function formatControlPlaneTrace(trace: ControlPlaneTrace): string {
  const lines = [
    `Control-plane trace for ${trace.sessionId}`,
    `Generated: ${trace.generatedAt}`,
    `Omitted by export limits: ${trace.selection.omittedStatusEvents} status snapshots, ${trace.selection.omittedTransitionEvents} transitions.`,
    `Transport: ${trace.transport?.records.length ?? 0} retained records; coverage is retained-only, not proof of absence.`,
    '',
  ];
  for (const event of trace.events) {
    const correlationLabel = event.traceId ? ` trace=${event.traceId}` : '';
    const startup =
      event.type === 'agent.activity.mcp-startup'
        ? parseMcpStartupStatus(event.payload)
        : undefined;
    const startupLabel = startup
      ? ` server=${startup.serverName} thread=${startup.threadId ?? 'unavailable'} runtime=${startup.runtimeId} attempt=${startup.attemptId} status=${startup.status}${
          startup.failure
            ? ` phase=${startup.failure.phase} code=${startup.failure.code} exit=${startup.failure.exitCode ?? 'unavailable'} signal=${startup.failure.signal ?? 'unavailable'} artifact=${startup.failure.artifactDigest ?? 'unavailable'}`
            : ''
        }`
      : '';
    const dispositionLabel =
      typeof event.payload.disposition === 'string'
        ? ` disposition=${event.payload.disposition}`
        : '';
    lines.push(
      `${String(event.sequence).padStart(6)}  ${event.occurredAt}  ${event.type}${correlationLabel}${startupLabel}${dispositionLabel}`,
    );
  }
  lines.push('', 'Diagnosis:');
  if (!trace.diagnoses.length) lines.push('  No incomplete control-plane transition detected.');
  else for (const diagnosis of trace.diagnoses) lines.push(`  - ${diagnosis}`);
  return `${lines.join('\n')}\n`;
}
