/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/** Versioned, session-scoped report boundary for supervised Org Plans. */
export const GESTALT_ORG_PLAN_CHECKPOINT_TOOL_NAME = 'gestalt_org_plan_checkpoint';

export type OrgPlanCheckpointCommit =
  | Readonly<{ kind: 'created'; subject: string; shortHash: string }>
  | Readonly<{ kind: 'notRequired' }>;

export type OrgPlanCheckpointRecordStatus = 'recorded' | 'alreadyRecorded' | 'failed';

export type OrgPlanCheckpointFailure = Readonly<{
  reasonCode: string;
  expected?: Readonly<Record<string, string | boolean | null>>;
  observed?: Readonly<Record<string, string | boolean | null>>;
  correlationId?: string;
}>;

export type OrgPlanCheckpoint =
  | Readonly<{
      version: 1;
      kind: 'l2Completed';
      planIdentity: string;
      l1Id: string;
      l2Id: string;
      position: string;
      status: 'DONE';
      changes: string;
      files: string;
      tests: string;
    }>
  | Readonly<{
      version: 1;
      kind: 'l1Accepted';
      planIdentity: string;
      l1Id: string;
      position: string;
      verdict: 'ACCEPT';
      commit: OrgPlanCheckpointCommit;
      findings?: string;
      tests?: string;
    }>
  | Readonly<{
      version: 1;
      kind: 'terminalReviewAccepted';
      planIdentity: string;
      verdict: 'ACCEPT';
      findings?: string;
      tests?: string;
    }>;

const bounded = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const gestaltOrgPlanCheckpointDynamicTool = {
  type: 'function',
  name: GESTALT_ORG_PLAN_CHECKPOINT_TOOL_NAME,
  description:
    'Record a validated supervised Org Plan report boundary. Send only the boundary kind; Mobile derives and validates all details from authoritative control state.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    properties: {
      kind: { type: 'string', enum: ['l2Completed', 'l1Accepted', 'terminalReviewAccepted'] },
    },
  },
} as const;

export function parseOrgPlanCheckpoint(value: unknown): OrgPlanCheckpoint | null {
  if (!record(value) || value.version !== 1 || !bounded(value.planIdentity, 128)) return null;
  if (value.kind === 'l2Completed') {
    if (
      !bounded(value.l1Id, 128) ||
      !bounded(value.l2Id, 128) ||
      !isL2Position(value.position) ||
      value.status !== 'DONE' ||
      !bounded(value.changes, 600) ||
      !bounded(value.files, 600) ||
      !bounded(value.tests, 600) ||
      Object.keys(value).some(
        (key) =>
          ![
            'version',
            'kind',
            'planIdentity',
            'l1Id',
            'l2Id',
            'position',
            'status',
            'changes',
            'files',
            'tests',
          ].includes(key),
      )
    )
      return null;
    return {
      version: 1,
      kind: 'l2Completed',
      planIdentity: value.planIdentity,
      l1Id: value.l1Id,
      l2Id: value.l2Id,
      position: value.position,
      status: 'DONE',
      changes: value.changes,
      files: value.files,
      tests: value.tests,
    };
  }
  if (value.verdict !== 'ACCEPT') return null;
  if (value.findings !== undefined && !bounded(value.findings, 600)) return null;
  if (value.tests !== undefined && !bounded(value.tests, 600)) return null;
  const summaries = {
    ...(typeof value.findings === 'string' ? { findings: value.findings } : {}),
    ...(typeof value.tests === 'string' ? { tests: value.tests } : {}),
  };
  if (value.kind === 'terminalReviewAccepted') {
    if (
      Object.keys(value).some(
        (key) => !['version', 'kind', 'planIdentity', 'verdict', 'findings', 'tests'].includes(key),
      )
    )
      return null;
    return {
      version: 1,
      kind: 'terminalReviewAccepted',
      planIdentity: value.planIdentity,
      verdict: 'ACCEPT',
      ...summaries,
    };
  }
  if (
    value.kind !== 'l1Accepted' ||
    !bounded(value.l1Id, 128) ||
    !isPosition(value.position) ||
    !record(value.commit)
  )
    return null;
  const commit = parseCommit(value.commit);
  if (
    !commit ||
    Object.keys(value).some(
      (key) =>
        ![
          'version',
          'kind',
          'planIdentity',
          'l1Id',
          'position',
          'verdict',
          'commit',
          'findings',
          'tests',
        ].includes(key),
    )
  )
    return null;
  return {
    version: 1,
    kind: 'l1Accepted',
    planIdentity: value.planIdentity,
    l1Id: value.l1Id,
    position: value.position,
    verdict: 'ACCEPT',
    commit,
    ...summaries,
  };
}

/** Acknowledgement deliberately contains no plan path, findings, or model text. */
export function toOrgPlanCheckpointToolResponse(
  status: OrgPlanCheckpointRecordStatus,
  failure?: OrgPlanCheckpointFailure,
): {
  contentItems: Array<{ type: 'inputText'; text: string }>;
  success: boolean;
} {
  const result =
    status === 'recorded'
      ? {
          status,
          durable: true,
          next: 'emitBoundaryFinalAndEndTurn',
          allowFurtherTools: false,
        }
      : status === 'alreadyRecorded'
        ? {
            status,
            durable: true,
            next: 'continueFromDurableCheckpoint',
            allowBoundaryFinal: false,
          }
        : {
            status,
            reasonCode: failure?.reasonCode ?? 'checkpointPersistenceFailed',
            durable: false,
            ...(failure?.expected ? { expected: failure.expected } : {}),
            ...(failure?.observed ? { observed: failure.observed } : {}),
            ...(failure?.correlationId ? { correlationId: failure.correlationId } : {}),
            next: 'reconcileCheckpointState',
            allowBoundaryFinal: false,
          };
  return {
    success: status !== 'failed',
    contentItems: [
      {
        type: 'inputText',
        text: JSON.stringify(result),
      },
    ],
  };
}

function isPosition(value: unknown): value is string {
  return typeof value === 'string' && /^L[1-9][0-9]*$/.test(value);
}
function isL2Position(value: unknown): value is string {
  return typeof value === 'string' && /^L[1-9][0-9]*\.[1-9][0-9]*$/.test(value);
}
function parseCommit(value: Record<string, unknown>): OrgPlanCheckpointCommit | null {
  if (value.kind === 'notRequired' && Object.keys(value).length === 1)
    return { kind: 'notRequired' };
  if (
    value.kind === 'created' &&
    Object.keys(value).length === 3 &&
    bounded(value.subject, 160) &&
    typeof value.shortHash === 'string' &&
    /^[0-9a-f]{7,16}$/.test(value.shortHash)
  )
    return { kind: 'created', subject: value.subject, shortHash: value.shortHash };
  return null;
}
