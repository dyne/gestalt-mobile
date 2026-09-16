/*
 * Copyright (C) 2026 Dyne.org foundation
 * Designed by Denis Roio <jaromil@dyne.org>
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { describe, expect, it } from 'vitest';
import {
  GESTALT_ORG_PLAN_CHECKPOINT_TOOL_NAME,
  gestaltOrgPlanCheckpointDynamicTool,
  parseOrgPlanCheckpoint,
  toOrgPlanCheckpointToolResponse,
} from './org-plan-checkpoint.js';

const accepted = {
  version: 1,
  kind: 'l1Accepted',
  planIdentity: 'a'.repeat(32),
  l1Id: 'add-supervision-checkpoint-semantics',
  position: 'L2',
  verdict: 'ACCEPT',
  commit: { kind: 'created', subject: 'feat(relay): checkpoint reports', shortHash: '1234abcd' },
  findings: 'No P1 findings.',
  tests: 'npm test passed.',
};
const completed = {
  version: 1,
  kind: 'l2Completed',
  planIdentity: 'a'.repeat(32),
  l1Id: 'improve-supervision-reporting',
  l2Id: 'add-l2-boundary',
  position: 'L2.1',
  status: 'DONE',
  changes: 'Added a compact reporting boundary.',
  files: 'src/reporting.ts; src/reporting.test.ts',
  tests: 'Focused tests passed.',
};

describe('Org Plan checkpoint contract', () => {
  it('exposes a closed schema-v1 dynamic tool', () => {
    expect(gestaltOrgPlanCheckpointDynamicTool).toMatchObject({
      name: GESTALT_ORG_PLAN_CHECKPOINT_TOOL_NAME,
      inputSchema: { additionalProperties: false },
    });
    expect(parseOrgPlanCheckpoint(accepted)).toEqual(accepted);
    expect(parseOrgPlanCheckpoint(completed)).toEqual(completed);
  });

  it('keeps L1 and terminal variants disjoint and bounded', () => {
    expect(parseOrgPlanCheckpoint({ ...accepted, position: 'L2.1' })).toBeNull();
    expect(parseOrgPlanCheckpoint({ ...accepted, verdict: 'REJECT' })).toBeNull();
    expect(
      parseOrgPlanCheckpoint({
        ...accepted,
        commit: { kind: 'created', subject: 'x', shortHash: 'not-a-hash' },
      }),
    ).toBeNull();
    expect(parseOrgPlanCheckpoint({ ...accepted, extra: true })).toBeNull();
    expect(
      parseOrgPlanCheckpoint({
        version: 1,
        kind: 'terminalReviewAccepted',
        planIdentity: accepted.planIdentity,
        verdict: 'ACCEPT',
      }),
    ).toMatchObject({ kind: 'terminalReviewAccepted' });
    expect(parseOrgPlanCheckpoint({ ...accepted, kind: 'terminalReviewAccepted' })).toBeNull();
    expect(parseOrgPlanCheckpoint({ ...completed, position: 'L2' })).toBeNull();
    expect(parseOrgPlanCheckpoint({ ...completed, verdict: 'ACCEPT' })).toBeNull();
    expect(parseOrgPlanCheckpoint({ ...completed, status: 'WIP' })).toBeNull();
    expect(parseOrgPlanCheckpoint({ ...completed, files: undefined })).toBeNull();
    // An unknown protocol revision must fail closed so composition can retain
    // the active root boundary rather than releasing a speculative handoff.
    expect(parseOrgPlanCheckpoint({ ...completed, version: 2 })).toBeNull();
  });

  it('directs the root to publish the accepted boundary before any more tools', () => {
    expect(toOrgPlanCheckpointToolResponse()).toEqual({
      success: true,
      contentItems: [
        {
          type: 'inputText',
          text: '{"accepted":true,"next":"emitBoundaryFinalAndEndTurn","allowFurtherTools":false}',
        },
      ],
    });
  });
});
