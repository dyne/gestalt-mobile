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
    'Record a validated supervised Org Plan report boundary. This is not review authority and must only be called by the active root after the Org Plan helper has recorded the matching state.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'kind', 'planIdentity'],
    properties: {
      version: { const: 1 },
      kind: { type: 'string', enum: ['l2Completed', 'l1Accepted', 'terminalReviewAccepted'] },
      planIdentity: { type: 'string', minLength: 1, maxLength: 128 },
      l1Id: { type: 'string', minLength: 1, maxLength: 128 },
      l2Id: { type: 'string', minLength: 1, maxLength: 128 },
      position: { type: 'string', pattern: '^L[1-9][0-9]*(\\.[1-9][0-9]*)?$', maxLength: 32 },
      status: { const: 'DONE' },
      verdict: { const: 'ACCEPT' },
      commit: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'subject', 'shortHash'],
            properties: {
              kind: { const: 'created' },
              subject: { type: 'string', minLength: 1, maxLength: 160 },
              shortHash: { type: 'string', pattern: '^[0-9a-f]{7,16}$' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind'],
            properties: { kind: { const: 'notRequired' } },
          },
        ],
      },
      findings: { type: 'string', minLength: 1, maxLength: 600 },
      changes: { type: 'string', minLength: 1, maxLength: 600 },
      files: { type: 'string', minLength: 1, maxLength: 600 },
      tests: { type: 'string', minLength: 1, maxLength: 600 },
    },
    oneOf: [
      {
        properties: { kind: { const: 'l2Completed' } },
        required: ['l1Id', 'l2Id', 'position', 'status', 'changes', 'files', 'tests'],
        not: {
          anyOf: [{ required: ['verdict'] }, { required: ['commit'] }, { required: ['findings'] }],
        },
      },
      {
        properties: { kind: { const: 'l1Accepted' } },
        required: ['l1Id', 'position', 'verdict', 'commit'],
        not: {
          anyOf: [
            { required: ['l2Id'] },
            { required: ['status'] },
            { required: ['changes'] },
            { required: ['files'] },
          ],
        },
      },
      {
        properties: { kind: { const: 'terminalReviewAccepted' } },
        required: ['verdict'],
        not: {
          anyOf: [
            { required: ['l1Id'] },
            { required: ['l2Id'] },
            { required: ['position'] },
            { required: ['status'] },
            { required: ['commit'] },
            { required: ['changes'] },
            { required: ['files'] },
          ],
        },
      },
    ],
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
export function toOrgPlanCheckpointToolResponse(): {
  contentItems: Array<{ type: 'inputText'; text: string }>;
  success: true;
} {
  return { success: true, contentItems: [{ type: 'inputText', text: '{"accepted":true}' }] };
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
