/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { DatabaseSync } from 'node:sqlite';

type TraceRow = Readonly<{
  sequence: number;
  occurredAt: string;
  type: string;
  payload: Record<string, unknown>;
  traceId: string | null;
}>;

export type ControlPlaneTrace = Readonly<{
  schemaVersion: 1;
  sessionId: string;
  generatedAt: string;
  events: readonly TraceRow[];
  diagnoses: readonly string[];
}>;

const relevant = /^(?:org-plan\.|autopilot\.|agent\.activity\.|session\.status\.)/;

// Export structural telemetry only. Event types alone do not imply payload safety.
const diagnosticFields = new Set([
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
      .filter(([key]) => diagnosticFields.has(key))
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
  for (const key of ['traceId', 'handoffId', 'controlId', 'turnId', 'requestId'])
    if (typeof payload[key] === 'string' && payload[key]) return String(payload[key]);
  return null;
}

function diagnose(events: readonly TraceRow[]): string[] {
  const diagnoses: string[] = [];
  if (!events.length) return ['no control-plane events found for this session'];
  const checkpointIndex = events.findLastIndex((event) => event.type.endsWith('-checkpointed'));
  const currentHandoff = checkpointIndex < 0 ? events : events.slice(checkpointIndex);
  const types = new Set(currentHandoff.map((event) => event.type));
  if (
    [...types].some((type) => type.endsWith('-checkpointed')) &&
    !types.has('autopilot.continuation-scheduled')
  )
    diagnoses.push('checkpoint persisted, but no continuation was scheduled');
  if (
    types.has('autopilot.continuation-scheduled') &&
    !types.has('autopilot.control-issued') &&
    !types.has('autopilot.executor-resumed')
  )
    diagnoses.push('continuation scheduled, but no control or executor dispatch was observed');
  if (
    types.has('autopilot.control-issued') &&
    !types.has('autopilot.turn-started') &&
    !types.has('autopilot.turn-failed')
  )
    diagnoses.push('control issued, but no turn acceptance or failure was observed');
  if (types.has('org-plan.checkpoint-handoff-failed'))
    diagnoses.push('checkpoint response handoff failed; inspect the matching trace ID');
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
    const rows = database
      .prepare(
        "SELECT sequence,occurred_at,type,payload_json FROM session_events WHERE session_id = ? AND (type LIKE 'org-plan.%' OR type LIKE 'autopilot.%' OR type LIKE 'agent.activity.%' OR type LIKE 'session.status.%') ORDER BY sequence DESC LIMIT 5000",
      )
      .all(sessionId) as Array<{
      sequence: number;
      occurred_at: string;
      type: string;
      payload_json: string;
    }>;
    const events = rows
      .reverse()
      .filter((row) => relevant.test(row.type))
      .map((row) => {
        const payload = redactDiagnosticPayload(objectPayload(row.payload_json)) as Record<
          string,
          unknown
        >;
        return {
          sequence: row.sequence,
          occurredAt: row.occurred_at,
          type: row.type,
          payload,
          traceId: correlation(payload),
        };
      });
    return { schemaVersion: 1, sessionId, generatedAt, events, diagnoses: diagnose(events) };
  } finally {
    database.close();
  }
}

export function formatControlPlaneTrace(trace: ControlPlaneTrace): string {
  const lines = [
    `Control-plane trace for ${trace.sessionId}`,
    `Generated: ${trace.generatedAt}`,
    '',
  ];
  for (const event of trace.events) {
    const correlationLabel = event.traceId ? ` trace=${event.traceId}` : '';
    lines.push(
      `${String(event.sequence).padStart(6)}  ${event.occurredAt}  ${event.type}${correlationLabel}`,
    );
  }
  lines.push('', 'Diagnosis:');
  if (!trace.diagnoses.length) lines.push('  No incomplete control-plane transition detected.');
  else for (const diagnosis of trace.diagnoses) lines.push(`  - ${diagnosis}`);
  return `${lines.join('\n')}\n`;
}
